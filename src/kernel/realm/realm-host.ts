// Realm host (DESIGN.md §6) — the main-thread side of the worker bridge.
//
// Spawns one Worker per execution, answers its journaled effect requests through
// the shared StepEngine, and resolves when the body returns. The journal and all
// fault hooks live here on the host, so crash semantics match the in-process
// path (the StepEngine is identical, validated under real kill -9 in Phase 3).

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentFailure, executeAgent, runAgentWithStall } from "../../agents/execute.ts";
import {
  type AgentProfileSnapshotEntry,
  type AgentProfiles,
  agentProfileConfigHash,
  agentProfilesFromSnapshot,
  assertValidAgentProfileName,
  compareAgentProfileNames,
  effectiveProfileCatalogHash,
  normalizeAgentProfileConfig,
} from "../../agents/profiles.ts";
import { normalizeProviderConfigValue } from "../../agents/provider-config.ts";
import type { SecretStore } from "../../agents/secrets.ts";
import type {
  AgentProvider,
  AgentProviderRegistry,
  ProviderConfigValue,
  TraceEvent,
} from "../../agents/types.ts";
import { redactCapabilityTokens } from "../../auth/redaction.ts";
import { type Json, canonicalJson, hashJson } from "../../hash.ts";
import type { JournalStore } from "../../journal/store.ts";
import type {
  AgentWorkspaceOwnerKind,
  AgentWorkspaceRow,
  RunRow,
  RunStatus,
} from "../../journal/types.ts";
import type { WorkflowProvenance } from "../../rpc/contract.ts";
import { optionalRunTarget, requireRunTarget } from "../../target.ts";
import {
  WORKFLOW_SDK_ABI_VERSION,
  defaultDefinitionCacheRoot,
  isWorkflowDefinitionHash,
  materializeWorkflowDefinition,
  resolveKeelPackageRoot,
  snapshotWorkflowSource,
} from "../../workflow-definitions/snapshot.ts";
import {
  DEFAULT_WORKSPACE_ID,
  workflowWorkspaceId,
  workspaceIdentity,
} from "../../workspace/identity.ts";
import {
  DEFAULT_WORKSPACE_RETENTION,
  cleanupTerminalRunWorkspaces,
  validateWorkspaceRetention,
} from "../../workspace/retention.ts";
import {
  assertUsableTargetDirectory,
  classifyCloneSource,
  copyBaselinePath,
  createRetainedClone,
  createRetainedCopy,
  createRetainedWorktree,
  diffCopyWorkspace,
  diffGitFinalTree,
  diffWorkspace,
  resolveGitRootTarget,
  resolveUsableDirectory,
  retainedWorkspacePath,
} from "../../workspace/worktree.ts";
import { type DurableAgentEvent, finalAgentMessageEvents } from "../agent-events.ts";
import type { CtxHost, FaultPoint } from "../ctx.ts";
import { extractModuleHelpers } from "../module-helpers.ts";
import { RUN_FINISHED_INLINE_OUTPUT_BYTES } from "../output.ts";
import { StepEngine, prepareStepResult, readJournalResult } from "../step-engine.ts";
import {
  CONTROL_WORDS,
  type HostReply,
  SAB_BYTES,
  VALUE_OFFSET,
  type WorkerRequest,
} from "./protocol.ts";

export interface RunHandle<O> {
  runId: string;
  status: RunStatus;
  output?: O;
}

export interface InterruptRunResult {
  runId: string;
  status: "interrupted";
}

interface ActiveExecution {
  interrupt(): void;
}

export interface RealmKernelOptions {
  clock?: () => number;
  rng?: () => number;
  idgen?: () => string;
  fault?: (point: FaultPoint, key: string) => void;
  /** Called once per real step-fn execution (used by crash tests to count). */
  onStepExecute?: (key: string) => void;
  /** Run the determinism lint on the workflow source before spawning (default true). */
  lint?: boolean;
  /** Agent provider registry for ctx.agent (the daemon owns providers, L4). */
  agents?: AgentProviderRegistry;
  /** Side-channel secret store (§11.2); enables env injection + terminal cleanup. */
  secrets?: SecretStore;
  /** Keel-owned store for retained isolated session workspaces. */
  workspaceStore?: string;
  /** Named agent profiles resolved before version computation (§10.2). */
  agentProfiles?: Record<string, unknown>;
  /** Daemon-owned workflow definition materialization cache. */
  definitionCacheRoot?: string;
  /** Push a live, non-durable event frame to current watchers. */
  liveEvent?: CtxHost["liveEvent"];
}

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "finished",
  "failed",
  "cancelled",
  "continued",
]);

const WORKER_URL = pathToFileURL(
  join(resolveKeelPackageRoot(), "src", "kernel", "realm", "worker-entry.ts"),
);

class AgentSessionContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionContinuityError";
  }
}

class RunInterruptedError extends Error {
  constructor(runId: string) {
    super(`run ${runId} interrupted`);
    this.name = "RunInterruptedError";
  }
}

class ProfileSnapshotIntegrityError extends Error {
  constructor(runId: string) {
    super(`run ${runId} is missing agent profile snapshot set`);
    this.name = "ProfileSnapshotIntegrityError";
  }
}

interface WorkspaceSpecMessage {
  key: string;
  mode?: string | null;
  path?: string | null;
  repo?: string | null;
  ref?: string | null;
  retention?: string | null;
}

interface WorkspaceHolder {
  kind: AgentWorkspaceOwnerKind;
  key: string;
  attempt: number;
}

interface InvocationWorkspace {
  cwd: string;
  workspaceId: string;
  workspacePath: string;
  sourcePath: string | null;
  sourceRef?: string;
  baseCommit?: string;
  copyBaselinePath?: string;
  mode: AgentWorkspaceRow["mode"];
  owned: boolean;
}

function normalizeRealmAgentProfiles(
  profiles: Record<string, unknown>,
  registry?: AgentProviderRegistry,
): AgentProfiles {
  const normalized: AgentProfiles = {};
  for (const [name, profile] of Object.entries(profiles)) {
    assertValidAgentProfileName(name);
    normalized[name] = normalizeAgentProfileConfig(profile, {
      path: `agent profile "${name}"`,
      providerRegistry: registry,
    });
  }
  return Object.freeze(normalized);
}

export interface ClientCapturedWorkflow {
  source: string;
  name?: string | null;
  provenance?: WorkflowProvenance;
}

function workflowRefFromProvenance(provenance: WorkflowProvenance | undefined): string {
  if (provenance?.kind === "clientPath") return `client-file:${provenance.path}`;
  return "stdin";
}

function assertWorkflowDefinitionHash(hash: string): void {
  if (!isWorkflowDefinitionHash(hash)) {
    throw new Error(`workflow definition ${hash} is not a valid definition hash`);
  }
}

function canonicalProfileJson(profile: AgentProfileSnapshotEntry["config"]): string {
  return canonicalJson(profile);
}

function runFinishedPayload(output: unknown): unknown {
  const text = JSON.stringify(output);
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= RUN_FINISHED_INLINE_OUTPUT_BYTES) return { output };
  return { outputOmitted: true, outputByteLength: byteLength };
}

function jsonFileChanges(
  changes:
    | Array<{
        path: string;
        status: string;
        oldMode?: string | null;
        newMode?: string | null;
        oldSymlinkTarget?: string | null;
        newSymlinkTarget?: string | null;
        binary?: boolean;
        textDiffIncluded?: boolean;
      }>
    | undefined,
): Json {
  return (changes ?? []).map((change) => ({
    path: change.path,
    status: change.status,
    oldMode: change.oldMode ?? null,
    newMode: change.newMode ?? null,
    oldSymlinkTarget: change.oldSymlinkTarget ?? null,
    newSymlinkTarget: change.newSymlinkTarget ?? null,
    binary: change.binary ?? false,
    textDiffIncluded: change.textDiffIncluded ?? false,
  }));
}

/** Runs workflows defined as ES modules (default export) in a Worker realm. */
export class RealmKernel {
  private readonly store: JournalStore;
  private readonly host: CtxHost;
  private readonly idgen: () => string;
  private readonly onStepExecute?: (key: string) => void;
  private readonly lintEnabled: boolean;
  private readonly registry?: AgentProviderRegistry;
  private readonly definitionCacheRoot: string;
  private readonly activeSessionRuns = new Set<string>();
  private readonly activeWorkers = new Set<Worker>();
  private readonly activeExecutions = new Map<string, Set<ActiveExecution>>();

  constructor(store: JournalStore, opts: RealmKernelOptions = {}) {
    this.store = store;
    this.host = {
      clock: opts.clock ?? (() => Date.now()),
      rng: opts.rng ?? Math.random,
      ...(opts.fault ? { fault: opts.fault } : {}),
      ...(opts.liveEvent ? { liveEvent: opts.liveEvent } : {}),
    };
    this.idgen = opts.idgen ?? (() => `run_${randomUUID()}`);
    if (opts.onStepExecute) this.onStepExecute = opts.onStepExecute;
    this.lintEnabled = opts.lint ?? true;
    this.definitionCacheRoot = opts.definitionCacheRoot ?? defaultDefinitionCacheRoot();
    if (opts.agents) this.registry = opts.agents;
    if (opts.secrets) this.secrets = opts.secrets;
    if (opts.workspaceStore) this.workspaceStore = opts.workspaceStore;
    if (opts.agentProfiles)
      this.agentProfiles = normalizeRealmAgentProfiles(opts.agentProfiles, opts.agents);
  }

  shutdown(): void {
    for (const active of this.activeExecutions.values()) {
      for (const execution of active) execution.interrupt();
    }
    for (const worker of this.activeWorkers) worker.terminate();
    this.activeWorkers.clear();
    this.activeExecutions.clear();
    this.activeSessionRuns.clear();
  }

  setLiveEventSink(liveEvent: CtxHost["liveEvent"]): void {
    this.host.liveEvent = liveEvent;
  }

  private readonly secrets?: SecretStore;
  private readonly workspaceStore?: string;
  private readonly agentProfiles?: AgentProfiles;

  getProgrammaticAgentProfiles(): AgentProfiles {
    return this.agentProfiles ?? {};
  }

  private captureEffectiveProfileSnapshot(atMs: number): {
    catalogHash: string;
    capturedAtMs: number;
    rows: Array<{
      name: string;
      source: "catalog" | "programmatic";
      configJson: string;
      configHash: string;
      catalogGeneration: number | null;
    }>;
  } {
    const entries: AgentProfileSnapshotEntry[] = [];
    for (const [name, config] of Object.entries(this.agentProfiles ?? {})) {
      entries.push({
        name,
        source: "programmatic",
        config,
        configHash: agentProfileConfigHash(config),
        catalogGeneration: null,
      });
    }
    for (const row of this.store.listAgentProfileCatalogRows()) {
      if (entries.some((entry) => entry.name === row.name)) {
        throw new Error(
          `duplicate agent profile "${row.name}" exists in programmatic and catalog sources`,
        );
      }
      entries.push({
        name: row.name,
        source: "catalog",
        config: JSON.parse(row.configJson) as AgentProfileSnapshotEntry["config"],
        configHash: row.configHash,
        catalogGeneration: row.generation,
      });
    }
    entries.sort((a, b) => compareAgentProfileNames(a.name, b.name));
    return {
      catalogHash: effectiveProfileCatalogHash(entries),
      capturedAtMs: atMs,
      rows: entries.map((entry) => ({
        name: entry.name,
        source: entry.source,
        configJson: canonicalProfileJson(entry.config),
        configHash: entry.configHash,
        catalogGeneration: entry.catalogGeneration,
      })),
    };
  }

  private profilesForRun(runId: string): AgentProfiles {
    const set = this.store.getRunProfileSnapshotSet(runId);
    if (!set) throw new ProfileSnapshotIntegrityError(runId);
    return agentProfilesFromSnapshot(
      this.store.listRunProfileSnapshots(runId).map((row) => ({
        name: row.name,
        source: row.source,
        config: JSON.parse(row.configJson) as AgentProfileSnapshotEntry["config"],
        configHash: row.configHash,
        catalogGeneration: row.catalogGeneration,
      })),
    );
  }

  /** Start a run and return its id immediately, with a promise for completion.
   * The RPC layer/daemon uses this so launchRun returns before the run finishes. */
  launch<O>(
    workflow: ClientCapturedWorkflow,
    input: unknown,
    meta: { name?: string | null; target?: string | null } = {},
  ): { runId: string; done: Promise<RunHandle<O>> } {
    const at = this.host.clock();
    const target = optionalRunTarget(meta.target, "RealmKernel.launch");
    const name = meta.name !== undefined ? meta.name : (workflow.name ?? null);
    const { snapshot, entryPath } = snapshotWorkflowSource(this.store, workflow.source, {
      name,
      nowMs: at,
      lint: this.lintEnabled,
      cacheRoot: this.definitionCacheRoot,
    });
    const runId = this.idgen();
    const profileSnapshot = this.captureEffectiveProfileSnapshot(at);
    this.store.transaction(() => {
      this.store.insertRun({
        runId,
        workflowName: name,
        definitionVersion: snapshot.hash,
        workflowRef: workflowRefFromProvenance(workflow.provenance),
        runTarget: target ?? null,
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: JSON.stringify(input ?? null),
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: at,
      });
      this.store.replaceRunProfileSnapshot(runId, profileSnapshot, profileSnapshot.rows);
      this.store.appendEvent(
        runId,
        "run.started",
        { name, definitionHash: snapshot.hash, target: target ?? null },
        this.host.clock(),
      );
    });
    return { runId, done: this.execute<O>(runId, entryPath, input) };
  }

  async run<O>(
    workflow: ClientCapturedWorkflow,
    input: unknown,
    meta: { name?: string | null; target?: string | null } = {},
  ): Promise<RunHandle<O>> {
    return this.launch<O>(workflow, input, meta).done;
  }

  launchDefinition<O>(
    definitionHash: string,
    input: unknown,
    meta: { name?: string | null; workflowRef?: string | null; target?: string | null } = {},
  ): { runId: string; done: Promise<RunHandle<O>> } {
    assertWorkflowDefinitionHash(definitionHash);
    const entryPath = materializeWorkflowDefinition(
      this.store,
      definitionHash,
      this.definitionCacheRoot,
    );
    const at = this.host.clock();
    const target = optionalRunTarget(meta.target, "RealmKernel.launchDefinition");
    const runId = this.idgen();
    const profileSnapshot = this.captureEffectiveProfileSnapshot(at);
    this.store.transaction(() => {
      this.store.insertRun({
        runId,
        workflowName: meta.name ?? null,
        definitionVersion: definitionHash,
        workflowRef: meta.workflowRef ?? definitionHash,
        runTarget: target,
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: JSON.stringify(input ?? null),
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: at,
      });
      this.store.replaceRunProfileSnapshot(runId, profileSnapshot, profileSnapshot.rows);
      this.store.appendEvent(
        runId,
        "run.started",
        { name: meta.name ?? null, definitionHash, target },
        this.host.clock(),
      );
    });
    return { runId, done: this.execute<O>(runId, entryPath, input) };
  }

  interruptRun(runId: string, reason?: string): InterruptRunResult {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (TERMINAL.has(run.status)) {
      throw new Error(`cannot interrupt terminal run ${runId} (is ${run.status})`);
    }
    if (run.status === "interrupted") {
      this.store.updateRun(runId, { heartbeatAtMs: null, runtimeOwnerId: null });
      return { runId, status: "interrupted" };
    }

    const safeReason = redactInterruptionReason(reason);
    this.store.transaction(() => {
      this.store.updateRun(runId, {
        status: "interrupted",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
      });
      this.store.appendEvent(
        runId,
        "run.interrupted",
        {
          previousStatus: run.status,
          ...(safeReason ? { reason: safeReason } : {}),
        },
        this.host.clock(),
      );
    });

    const active = [...(this.activeExecutions.get(runId) ?? [])];
    for (const execution of active) execution.interrupt();
    return { runId, status: "interrupted" };
  }

  async resume<O>(runId: string): Promise<RunHandle<O>> {
    return this.startResume<O>(runId).done;
  }

  startResume<O>(runId: string): { runId: string; done: Promise<RunHandle<O>> } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (TERMINAL.has(run.status)) {
      return {
        runId,
        done: Promise.resolve({
          runId,
          status: run.status,
          output: run.outputRef ? (JSON.parse(run.outputRef) as O) : undefined,
        }),
      };
    }
    const executionPath = this.executionPathForRun(run);
    const input = run.inputRef ? JSON.parse(run.inputRef) : undefined;
    if (run.status === "interrupted") {
      this.store.updateRun(runId, { status: "running", errorJson: null, finishedAtMs: null });
    }
    this.store.appendEvent(runId, "run.resumed", {}, this.host.clock());
    return { runId, done: this.execute<O>(runId, executionPath, input) };
  }

  /**
   * Re-execute a run against (possibly edited) code — the §7.5 `--adopt-latest`
   * path (Phase 6). Unlike resume, this ignores terminal status: steps whose
   * (inputHash, version) still match replay; steps whose version changed (edited
   * logic/prompt) or whose inputs changed (because an upstream re-executed to a
   * different value) re-execute as a new attempt. Early cutoff is automatic — an
   * edited step that yields a byte-identical output leaves downstream inputHashes
   * unchanged, so they replay.
   */
  async rerun<O>(
    runId: string,
    opts: {
      source?: string;
      input?: unknown;
      name?: string | null;
      provenance?: WorkflowProvenance;
    } = {},
  ): Promise<RunHandle<O>> {
    return this.startRerun<O>(runId, opts).done;
  }

  startRerun<O>(
    runId: string,
    opts: {
      source?: string;
      input?: unknown;
      name?: string | null;
      provenance?: WorkflowProvenance;
    } = {},
  ): { runId: string; done: Promise<RunHandle<O>> } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status === "interrupted") {
      throw new Error(`cannot rerun interrupted run ${runId}; resume it first`);
    }
    if (this.store.hasAgentSessions(runId)) {
      throw new Error(
        `run ${runId} uses durable agent sessions and cannot be rerun; start a fresh run instead`,
      );
    }
    const sourceOverride = opts.source !== undefined;
    const name = opts.name !== undefined ? opts.name : run.workflowName;
    const { definitionHash, workflowRef, entryPath } = sourceOverride
      ? this.snapshotSourceForExistingRun(opts.source as string, name, opts.provenance)
      : {
          definitionHash: run.definitionVersion,
          workflowRef: run.workflowRef,
          entryPath: this.executionPathForRun(run),
        };
    const overriding = opts.input !== undefined;
    const effectiveInput = overriding
      ? opts.input
      : run.inputRef
        ? JSON.parse(run.inputRef)
        : undefined;
    // Reset the run to running and clear the previous terminal result; persist an
    // override input so a later input-less rerun does not silently use the old one.
    const profileSnapshot = this.captureEffectiveProfileSnapshot(this.host.clock());
    this.store.transaction(() => {
      this.store.updateRun(runId, {
        status: "running",
        finishedAtMs: null,
        outputRef: null,
        errorJson: null,
        ...(overriding ? { inputRef: JSON.stringify(opts.input ?? null) } : {}),
        ...(opts.name !== undefined ? { workflowName: name } : {}),
      });
      this.store.updateRunDefinition(runId, definitionHash, workflowRef);
      this.store.replaceRunProfileSnapshot(runId, profileSnapshot, profileSnapshot.rows);
      this.store.appendEvent(runId, "run.rerun", { definitionHash }, this.host.clock());
    });
    return { runId, done: this.execute<O>(runId, entryPath, effectiveInput) };
  }

  /** Retry a FAILED run from its failed step (§18) — the failed rows are dropped
   * so they re-execute; completed upstream replays. For transient agent failures. */
  async retry<O>(runId: string): Promise<RunHandle<O>> {
    return this.startRetry<O>(runId).done;
  }

  startRetry<O>(runId: string): { runId: string; done: Promise<RunHandle<O>> } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status !== "failed") throw new Error(`retry needs a failed run (is ${run.status})`);
    const executionPath = this.executionPathForRun(run);
    this.store.deleteFailedRows(runId);
    const at = this.host.clock();
    this.store.transaction(() => {
      this.store.updateRun(runId, { status: "running", errorJson: null, finishedAtMs: null });
      this.store.reopenPendingReviewWorkspaces(runId, at);
      this.store.appendEvent(runId, "run.retry", {}, at);
    });
    const input = run.inputRef ? JSON.parse(run.inputRef) : undefined;
    return { runId, done: this.execute<O>(runId, executionPath, input) };
  }

  /** Rewind a run to a chosen step (§18): discard everything journaled after it,
   * then re-execute. The kept prefix replays; the rest re-runs (may diverge). */
  async rewind<O>(runId: string, toStableKey: string): Promise<RunHandle<O>> {
    return this.startRewind<O>(runId, toStableKey).done;
  }

  startRewind<O>(
    runId: string,
    toStableKey: string,
  ): { runId: string; done: Promise<RunHandle<O>> } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status === "interrupted") {
      throw new Error(`cannot rewind interrupted run ${runId}; resume it first`);
    }
    if (this.store.hasAgentSessions(runId)) {
      throw new Error(
        `run ${runId} uses durable agent sessions and cannot be rewound; start a fresh run instead`,
      );
    }
    if (!this.store.getLatestAttempt(runId, toStableKey)) {
      throw new Error(`cannot rewind to unknown step "${toStableKey}"`);
    }
    const executionPath = this.executionPathForRun(run);
    // Trim journal + decrement refcounts + clear unresolved waits as one snapshot.
    this.store.deleteRunStateAfter(runId, toStableKey);
    this.store.updateRun(runId, {
      status: "running",
      outputRef: null,
      errorJson: null,
      finishedAtMs: null,
    });
    this.store.appendEvent(runId, "run.rewind", { to: toStableKey }, this.host.clock());
    const input = run.inputRef ? JSON.parse(run.inputRef) : undefined;
    return { runId, done: this.execute<O>(runId, executionPath, input) };
  }

  /** Fork a TERMINAL run into a new independent run sharing the journal prefix
   * and its resolved durable-wait history (§18); the new run can be rerun to
   * diverge without touching the source. */
  fork(runId: string, opts: { atStableKey?: string; newRunId?: string } = {}): string {
    const src = this.store.getRun(runId);
    if (!src) throw new Error(`fork source run ${runId} not found`);
    if (this.store.hasAgentSessions(runId)) {
      throw new Error(
        `run ${runId} uses durable agent sessions and cannot be forked; start a fresh run instead`,
      );
    }
    // Fence: only fork a terminal run, so the prefix snapshot is consistent (no
    // concurrent owner mutating it mid-copy) and all waits are resolved.
    if (!TERMINAL.has(src.status)) {
      throw new Error(
        `cannot fork a non-terminal run (is ${src.status}); fork a finished/failed/continued run, or rewind first`,
      );
    }
    const newId = opts.newRunId ?? this.idgen();
    this.store.forkRun(runId, newId, opts.atStableKey ?? null, this.host.clock());
    this.store.appendEvent(newId, "run.forked", { from: runId }, this.host.clock());
    return newId;
  }

  private executionPathForRun(run: RunRow): string {
    if (isWorkflowDefinitionHash(run.definitionVersion)) {
      return materializeWorkflowDefinition(
        this.store,
        run.definitionVersion,
        this.definitionCacheRoot,
      );
    }
    throw new Error(
      `run ${run.runId} cannot be resumed because it has no immutable workflow definition snapshot (${run.definitionVersion})`,
    );
  }

  private snapshotSourceForExistingRun(
    source: string,
    name: string | null,
    provenance: WorkflowProvenance | undefined,
  ): { definitionHash: string; workflowRef: string; entryPath: string } {
    const { snapshot, entryPath } = snapshotWorkflowSource(this.store, source, {
      name,
      nowMs: this.host.clock(),
      lint: this.lintEnabled,
      cacheRoot: this.definitionCacheRoot,
    });
    return {
      definitionHash: snapshot.hash,
      workflowRef: workflowRefFromProvenance(provenance),
      entryPath,
    };
  }

  private resolveWorkspaceSpec(
    runId: string,
    spec: WorkspaceSpecMessage,
    atMs: number,
  ): { id: string; identityHash: string } {
    if (typeof spec.key !== "string" || spec.key.trim().length === 0) {
      throw new Error("WorkspaceSpec.key is required and must be a non-empty string");
    }
    if (spec.key === DEFAULT_WORKSPACE_ID) {
      throw new Error(
        `workspace key ${DEFAULT_WORKSPACE_ID} is reserved for the run default workspace`,
      );
    }
    const mode = spec.mode ?? "direct";
    if (mode !== "direct" && mode !== "worktree" && mode !== "copy" && mode !== "clone") {
      throw new Error(
        `workspace mode must be direct, worktree, copy, or clone, got ${String(mode)}`,
      );
    }
    const runTarget = requireRunTarget(
      this.store.getRun(runId)?.runTarget,
      "ctx.workspace run target",
    );
    const workspaceId = workflowWorkspaceId(spec.key);
    if (mode === "direct") {
      if (spec.repo != null) throw new Error("direct workspaces do not accept repo");
      if (spec.retention != null) {
        throw new Error(
          "direct workspaces do not accept retention because Keel does not own the directory",
        );
      }
      if (spec.ref != null) throw new Error("direct workspaces do not accept ref");
      const suppliedPath = spec.path ?? null;
      const path = resolveUsableDirectory(suppliedPath ?? runTarget);
      const identity = workspaceIdentity({
        key: spec.key,
        mode: "direct",
        ownerKind: "workflow",
        path,
        sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
      });
      this.store.transaction(() => {
        const existing = this.store.getAgentWorkspace(runId, workspaceId);
        if (!existing) {
          this.store.insertAgentWorkspace({
            runId,
            workspaceId,
            mode: "direct",
            ownerKind: "workflow",
            key: spec.key,
            lastAttempt: null,
            retentionPolicy: null,
            workspacePath: path,
            sourceKind: "direct-path",
            sourcePath: path,
            sourceUri: null,
            sourceBare: null,
            sourceMergeEligible: false,
            suppliedPath,
            sourceRef: null,
            resolvedRef: null,
            checkoutBranch: null,
            baseCommit: null,
            copyBaselinePath: null,
            creationErrorJson: null,
            workspaceIdentityJson: identity.json,
            workspaceIdentityHash: identity.hash,
            owned: false,
            status: "idle",
            failureSeen: false,
            lastTurnKey: null,
            lastTurnAttempt: null,
            activeHolderKind: null,
            activeHolderKey: null,
            activeHolderAttempt: null,
            activeStartedAtMs: null,
            lastDiffEventSeq: null,
            lastErrorEventSeq: null,
            cleanupErrorJson: null,
            createdAtMs: atMs,
            updatedAtMs: atMs,
            mergedAtMs: null,
            discardedAtMs: null,
            removedAtMs: null,
          });
          return;
        }
        if (existing.workspaceIdentityHash !== identity.hash) {
          throw new Error(
            `workspace "${spec.key}" identity changed; use a new workspace key or a fresh run`,
          );
        }
      });
      return { id: workspaceId, identityHash: identity.hash };
    }

    if (!this.workspaceStore) {
      throw new Error(
        `workspace "${spec.key}" requests mode ${mode} but the kernel has no workspaceStore configured`,
      );
    }
    if (mode === "copy") {
      if (spec.repo != null) throw new Error("copy workspaces do not accept repo");
      if (spec.ref != null) throw new Error("copy workspaces do not accept ref");
      const suppliedPath = spec.path ?? null;
      const sourcePath = resolveUsableDirectory(suppliedPath ?? runTarget);
      const retentionPolicy =
        spec.retention == null
          ? DEFAULT_WORKSPACE_RETENTION
          : validateWorkspaceRetention(spec.retention);
      const defaultPath = retainedWorkspacePath(this.workspaceStore, runId, workspaceId);
      const baselinePath = copyBaselinePath(this.workspaceStore, runId, workspaceId);
      const identity = workspaceIdentity({
        key: spec.key,
        mode: "copy",
        sourcePath,
        retentionPolicy,
        sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
      });
      let needsCreate = false;
      this.store.transaction(() => {
        const existing = this.store.getAgentWorkspace(runId, workspaceId);
        if (!existing) {
          this.store.insertAgentWorkspace({
            runId,
            workspaceId,
            mode: "copy",
            ownerKind: "workflow",
            key: spec.key,
            lastAttempt: null,
            retentionPolicy,
            workspacePath: defaultPath,
            sourceKind: "local-copy",
            sourcePath,
            sourceUri: null,
            sourceBare: null,
            sourceMergeEligible: true,
            suppliedPath,
            sourceRef: null,
            resolvedRef: null,
            checkoutBranch: null,
            baseCommit: null,
            copyBaselinePath: baselinePath,
            creationErrorJson: null,
            workspaceIdentityJson: identity.json,
            workspaceIdentityHash: identity.hash,
            owned: true,
            status: "creating",
            failureSeen: false,
            lastTurnKey: null,
            lastTurnAttempt: null,
            activeHolderKind: null,
            activeHolderKey: null,
            activeHolderAttempt: null,
            activeStartedAtMs: null,
            lastDiffEventSeq: null,
            lastErrorEventSeq: null,
            cleanupErrorJson: null,
            createdAtMs: atMs,
            updatedAtMs: atMs,
            mergedAtMs: null,
            discardedAtMs: null,
            removedAtMs: null,
          });
          needsCreate = true;
          return;
        }
        if (existing.workspaceIdentityHash !== identity.hash) {
          throw new Error(
            `workspace "${spec.key}" identity changed; use a new workspace key or a fresh run`,
          );
        }
        if (
          existing.status === "creating" &&
          (!existsSync(existing.workspacePath) || !existsSync(existing.copyBaselinePath ?? ""))
        ) {
          needsCreate = true;
        }
      });
      if (needsCreate) {
        try {
          createRetainedCopy(sourcePath, defaultPath, baselinePath);
          this.store.updateAgentWorkspace(runId, workspaceId, {
            status: "idle",
            updatedAtMs: atMs,
          });
        } catch (err) {
          this.store.updateAgentWorkspace(runId, workspaceId, {
            status: "abandoned",
            failureSeen: true,
            creationErrorJson: JSON.stringify(serializeError(err)),
            updatedAtMs: this.host.clock(),
          });
          throw err;
        }
      }
      return { id: workspaceId, identityHash: identity.hash };
    }
    if (mode === "clone") {
      if (spec.path != null) throw new Error("clone workspaces do not accept path; use repo");
      if (spec.repo == null || spec.repo.trim().length === 0) {
        throw new Error("clone workspaces require repo");
      }
      const source = classifyCloneSource(spec.repo);
      const sourceRef = spec.ref && spec.ref.length > 0 ? spec.ref : null;
      const retentionPolicy =
        spec.retention == null
          ? DEFAULT_WORKSPACE_RETENTION
          : validateWorkspaceRetention(spec.retention);
      const defaultPath = retainedWorkspacePath(this.workspaceStore, runId, workspaceId);
      const identity = workspaceIdentity({
        key: spec.key,
        mode: "clone",
        repo: source.repo,
        sourceKind: source.sourceKind,
        sourcePath: source.sourcePath,
        sourceRef,
        retentionPolicy,
        sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
      });
      let needsCreate = false;
      this.store.transaction(() => {
        const existing = this.store.getAgentWorkspace(runId, workspaceId);
        if (!existing) {
          this.store.insertAgentWorkspace({
            runId,
            workspaceId,
            mode: "clone",
            ownerKind: "workflow",
            key: spec.key,
            lastAttempt: null,
            retentionPolicy,
            workspacePath: defaultPath,
            sourceKind: source.sourceKind,
            sourcePath: source.sourcePath,
            sourceUri: source.repo,
            sourceBare: source.sourceBare,
            sourceMergeEligible: source.sourceMergeEligible,
            suppliedPath: null,
            sourceRef,
            resolvedRef: null,
            checkoutBranch: null,
            baseCommit: null,
            copyBaselinePath: null,
            creationErrorJson: null,
            workspaceIdentityJson: identity.json,
            workspaceIdentityHash: identity.hash,
            owned: true,
            status: "creating",
            failureSeen: false,
            lastTurnKey: null,
            lastTurnAttempt: null,
            activeHolderKind: null,
            activeHolderKey: null,
            activeHolderAttempt: null,
            activeStartedAtMs: null,
            lastDiffEventSeq: null,
            lastErrorEventSeq: null,
            cleanupErrorJson: null,
            createdAtMs: atMs,
            updatedAtMs: atMs,
            mergedAtMs: null,
            discardedAtMs: null,
            removedAtMs: null,
          });
          needsCreate = true;
          return;
        }
        if (existing.workspaceIdentityHash !== identity.hash) {
          throw new Error(
            `workspace "${spec.key}" identity changed; use a new workspace key or a fresh run`,
          );
        }
        if (existing.status === "creating" && !existsSync(existing.workspacePath))
          needsCreate = true;
      });
      if (needsCreate) {
        try {
          const result = createRetainedClone(source, defaultPath, sourceRef);
          this.store.updateAgentWorkspace(runId, workspaceId, {
            status: "idle",
            baseCommit: result.baseCommit,
            checkoutBranch: result.checkoutBranch,
            resolvedRef: result.resolvedRef,
            sourceBare: result.sourceBare,
            sourceMergeEligible: result.sourceMergeEligible,
            updatedAtMs: atMs,
          });
        } catch (err) {
          this.store.updateAgentWorkspace(runId, workspaceId, {
            status: "abandoned",
            failureSeen: true,
            creationErrorJson: JSON.stringify(serializeError(err)),
            updatedAtMs: this.host.clock(),
          });
          throw err;
        }
      }
      return { id: workspaceId, identityHash: identity.hash };
    }

    if (spec.repo != null) throw new Error("worktree workspaces do not accept repo");
    const suppliedPath = spec.path ?? null;
    const sourceRef = spec.ref && spec.ref.length > 0 ? spec.ref : "HEAD";
    const retentionPolicy =
      spec.retention == null
        ? DEFAULT_WORKSPACE_RETENTION
        : validateWorkspaceRetention(spec.retention);
    const gitTarget = resolveGitRootTarget(suppliedPath ?? runTarget, sourceRef);
    const defaultPath = retainedWorkspacePath(this.workspaceStore, runId, workspaceId);
    const identity = workspaceIdentity({
      key: spec.key,
      mode: "worktree",
      sourcePath: gitTarget.target,
      sourceRef,
      retentionPolicy,
      sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
    });
    let needsCreate = false;
    this.store.transaction(() => {
      const existing = this.store.getAgentWorkspace(runId, workspaceId);
      if (!existing) {
        this.store.insertAgentWorkspace({
          runId,
          workspaceId,
          mode: "worktree",
          ownerKind: "workflow",
          key: spec.key,
          lastAttempt: null,
          retentionPolicy,
          workspacePath: defaultPath,
          sourceKind: "worktree-git",
          sourcePath: gitTarget.target,
          sourceUri: null,
          sourceBare: null,
          sourceMergeEligible: true,
          suppliedPath,
          sourceRef,
          resolvedRef: sourceRef,
          checkoutBranch: null,
          baseCommit: gitTarget.baseCommit,
          copyBaselinePath: null,
          creationErrorJson: null,
          workspaceIdentityJson: identity.json,
          workspaceIdentityHash: identity.hash,
          owned: true,
          status: "creating",
          failureSeen: false,
          lastTurnKey: null,
          lastTurnAttempt: null,
          activeHolderKind: null,
          activeHolderKey: null,
          activeHolderAttempt: null,
          activeStartedAtMs: null,
          lastDiffEventSeq: null,
          lastErrorEventSeq: null,
          cleanupErrorJson: null,
          createdAtMs: atMs,
          updatedAtMs: atMs,
          mergedAtMs: null,
          discardedAtMs: null,
          removedAtMs: null,
        });
        needsCreate = true;
        return;
      }
      if (existing.workspaceIdentityHash !== identity.hash) {
        throw new Error(
          `workspace "${spec.key}" identity changed; use a new workspace key or a fresh run`,
        );
      }
      if (existing.status === "creating" && !existsSync(existing.workspacePath)) {
        needsCreate = true;
      }
      if (existing.status === "removed") {
        if (this.store.hasAgentSessionUsingWorkspace(runId, workspaceId)) {
          throw new Error(
            `workspace "${spec.key}" was removed and is referenced by an existing agent session; start a fresh run or use retention retain-on-failure/retain`,
          );
        }
        this.store.updateAgentWorkspace(runId, workspaceId, {
          status: "creating",
          workspacePath: defaultPath,
          sourcePath: gitTarget.target,
          sourceKind: "worktree-git",
          sourceUri: null,
          sourceBare: null,
          sourceMergeEligible: true,
          suppliedPath,
          sourceRef,
          resolvedRef: sourceRef,
          checkoutBranch: null,
          baseCommit: gitTarget.baseCommit,
          copyBaselinePath: null,
          creationErrorJson: null,
          workspaceIdentityJson: identity.json,
          workspaceIdentityHash: identity.hash,
          retentionPolicy,
          failureSeen: false,
          lastDiffEventSeq: null,
          lastErrorEventSeq: null,
          cleanupErrorJson: null,
          mergedAtMs: null,
          discardedAtMs: null,
          removedAtMs: null,
          updatedAtMs: atMs,
        });
        needsCreate = true;
      }
    });
    if (needsCreate) {
      try {
        createRetainedWorktree(gitTarget.repoRoot, defaultPath, gitTarget.baseCommit);
        this.store.updateAgentWorkspace(runId, workspaceId, {
          status: "idle",
          updatedAtMs: atMs,
        });
      } catch (err) {
        this.store.updateAgentWorkspace(runId, workspaceId, {
          status: "abandoned",
          failureSeen: true,
          updatedAtMs: this.host.clock(),
        });
        throw err;
      }
    }
    return { id: workspaceId, identityHash: identity.hash };
  }

  private ensureDefaultWorkspace(runId: string, atMs: number): AgentWorkspaceRow {
    const runTarget = requireRunTarget(
      this.store.getRun(runId)?.runTarget,
      "run default workspace target",
    );
    const path = resolveUsableDirectory(runTarget);
    const identity = workspaceIdentity({
      key: DEFAULT_WORKSPACE_ID,
      mode: "direct",
      ownerKind: "workflow",
      path,
      sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
    });
    let row = this.store.getAgentWorkspace(runId, DEFAULT_WORKSPACE_ID);
    if (!row) {
      this.store.insertAgentWorkspace({
        runId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        mode: "direct",
        ownerKind: "workflow",
        key: DEFAULT_WORKSPACE_ID,
        lastAttempt: null,
        retentionPolicy: null,
        workspacePath: path,
        sourceKind: "direct-path",
        sourcePath: path,
        sourceUri: null,
        sourceBare: null,
        sourceMergeEligible: false,
        suppliedPath: runTarget,
        sourceRef: null,
        resolvedRef: null,
        checkoutBranch: null,
        baseCommit: null,
        copyBaselinePath: null,
        creationErrorJson: null,
        workspaceIdentityJson: identity.json,
        workspaceIdentityHash: identity.hash,
        owned: false,
        status: "idle",
        failureSeen: false,
        lastTurnKey: null,
        lastTurnAttempt: null,
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        lastDiffEventSeq: null,
        lastErrorEventSeq: null,
        cleanupErrorJson: null,
        createdAtMs: atMs,
        updatedAtMs: atMs,
        mergedAtMs: null,
        discardedAtMs: null,
        removedAtMs: null,
      });
      row = this.store.getAgentWorkspace(runId, DEFAULT_WORKSPACE_ID);
    }
    if (!row) throw new Error("failed to create run default workspace");
    if (row.workspaceIdentityHash !== identity.hash) {
      throw new Error("run default workspace identity changed; refusing to continue");
    }
    return row;
  }

  private beginInvocationWorkspace(
    runId: string,
    workspaceId: string,
    holder: WorkspaceHolder,
    atMs: number,
  ): InvocationWorkspace {
    const row =
      workspaceId === DEFAULT_WORKSPACE_ID
        ? this.ensureDefaultWorkspace(runId, atMs)
        : this.store.getAgentWorkspace(runId, workspaceId);
    if (!row) throw new Error(`workspace handle "${workspaceId}" was not created in this run`);
    if (row.mode === "direct") {
      assertUsableTargetDirectory(row.workspacePath);
      return {
        cwd: row.workspacePath,
        workspaceId: row.workspaceId,
        workspacePath: row.workspacePath,
        sourcePath: row.sourcePath,
        mode: row.mode,
        owned: false,
      };
    }
    if (!row.owned) throw new Error(`workspace ${row.workspaceId} is not owned by Keel`);
    if (!existsSync(row.workspacePath)) {
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        status: "abandoned",
        failureSeen: true,
        updatedAtMs: this.host.clock(),
      });
      throw new Error(`workspace "${row.workspaceId}" is missing at ${row.workspacePath}`);
    }
    if (row.mode === "copy" && !existsSync(row.copyBaselinePath ?? "")) {
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        status: "abandoned",
        failureSeen: true,
        updatedAtMs: this.host.clock(),
      });
      throw new Error(`copy workspace "${row.workspaceId}" is missing baseline snapshot`);
    }
    if (row.mode === "clone" && !row.baseCommit) {
      throw new Error(`clone workspace "${row.workspaceId}" is missing base commit`);
    }
    this.store.transaction(() => {
      const current = this.store.getAgentWorkspace(runId, row.workspaceId);
      if (!current) throw new Error(`workspace ${runId}/${row.workspaceId} not found`);
      const sameHolder =
        current.activeHolderKind === holder.kind &&
        current.activeHolderKey === holder.key &&
        current.activeHolderAttempt === holder.attempt;
      if (current.activeHolderKind && !sameHolder) {
        throw new Error(
          `workspace "${row.workspaceId}" is already active for ${current.activeHolderKind} "${current.activeHolderKey}" attempt ${current.activeHolderAttempt}`,
        );
      }
      if (
        current.status !== "idle" &&
        current.status !== "diff_error" &&
        current.status !== "active" &&
        current.status !== "creating"
      ) {
        throw new Error(`workspace "${row.workspaceId}" is ${current.status} and cannot start`);
      }
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        status: "active",
        lastAttempt: holder.kind === "agent" ? holder.attempt : current.lastAttempt,
        lastTurnKey: current.lastTurnKey,
        lastTurnAttempt: current.lastTurnAttempt,
        activeHolderKind: holder.kind,
        activeHolderKey: holder.key,
        activeHolderAttempt: holder.attempt,
        activeStartedAtMs: atMs,
        updatedAtMs: atMs,
      });
    });
    return {
      cwd: row.workspacePath,
      workspaceId: row.workspaceId,
      workspacePath: row.workspacePath,
      sourcePath: row.sourcePath,
      ...(row.sourceRef ? { sourceRef: row.sourceRef } : {}),
      ...(row.baseCommit ? { baseCommit: row.baseCommit } : {}),
      ...(row.copyBaselinePath ? { copyBaselinePath: row.copyBaselinePath } : {}),
      mode: row.mode,
      owned: true,
    };
  }

  private releaseWorkspaceHolder(
    runId: string,
    workspaceId: string | undefined,
    holder: WorkspaceHolder,
    patch: Partial<
      Pick<
        AgentWorkspaceRow,
        | "status"
        | "failureSeen"
        | "lastTurnKey"
        | "lastTurnAttempt"
        | "lastDiffEventSeq"
        | "lastErrorEventSeq"
        | "updatedAtMs"
      >
    >,
  ): void {
    if (!workspaceId) return;
    const row = this.store.getAgentWorkspace(runId, workspaceId);
    if (!row?.owned) {
      if (patch.failureSeen) {
        this.store.updateAgentWorkspace(runId, workspaceId, {
          failureSeen: true,
          updatedAtMs: patch.updatedAtMs ?? this.host.clock(),
        });
      }
      return;
    }
    if (
      row.status === "removed" ||
      row.status === "pending_review" ||
      row.status === "merged" ||
      row.status === "discarded" ||
      row.status === "abandoned" ||
      row.status === "cleanup_error"
    ) {
      return;
    }
    if (
      row.activeHolderKind &&
      (row.activeHolderKind !== holder.kind ||
        row.activeHolderKey !== holder.key ||
        row.activeHolderAttempt !== holder.attempt)
    ) {
      throw new Error(
        `workspace "${workspaceId}" active holder changed while provider was running`,
      );
    }
    this.store.updateAgentWorkspace(runId, workspaceId, {
      ...patch,
      activeHolderKind: null,
      activeHolderKey: null,
      activeHolderAttempt: null,
      activeStartedAtMs: null,
    });
  }

  private recoverActiveWorkspaceHolders(runId: string, atMs: number): void {
    for (const row of this.store.listAgentWorkspaces(runId, { includeRemoved: true })) {
      if (!row.activeHolderKind) continue;
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        status: row.owned && !existsSync(row.workspacePath) ? "abandoned" : "idle",
        ...(row.owned && !existsSync(row.workspacePath) ? { failureSeen: true } : {}),
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        updatedAtMs: atMs,
      });
    }
  }

  private beginAgentSessionTurn(
    runId: string,
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    provider: AgentProvider,
  ):
    | { kind: "replay"; value: unknown }
    | {
        kind: "execute";
        attempt: number;
        inputHash: string;
        startedAtMs: number;
        cwd: string;
        workspaceId?: string;
        workspacePath?: string;
        workspaceTarget?: string | null;
        workspaceBaseCommit?: string;
        workspaceCopyBaselinePath?: string;
        workspaceMode?: AgentWorkspaceRow["mode"];
        workspaceOwned?: boolean;
        resumeToken?: string;
      } {
    if (!provider.supportsSessions) {
      throw new Error(`agent provider "${m.provider}" does not support durable sessions`);
    }
    const inputHash = hashJson(m.inputs as Json);
    const startedAtMs = this.host.clock();
    const preflight = this.store.transaction(() => {
      let session = this.store.getAgentSession(runId, m.agentKey);
      if (!session) {
        this.store.insertAgentSession({
          runId,
          agentKey: m.agentKey,
          identityHash: m.identityHash,
          identityJson: m.identityJson,
          currentSessionToken: null,
          latestCompletedTurnKey: null,
          latestCompletedAttempt: null,
          activeTurnKey: null,
          activeTurnAttempt: null,
          createdAtMs: startedAtMs,
          updatedAtMs: startedAtMs,
        });
        session = this.store.getAgentSession(runId, m.agentKey);
      }
      if (!session) throw new Error(`failed to create agent session "${m.agentKey}"`);
      if (session.identityHash !== m.identityHash) {
        throw new Error(
          `agent session "${m.agentKey}" identity changed; use a new participant key or a fresh run`,
        );
      }

      const existing = this.store.getLatestAttempt(runId, m.stableKey);
      if (existing && (existing.inputHash !== inputHash || existing.version !== m.version)) {
        throw new Error(
          `agent session "${m.agentKey}" turn "${m.turnKey}" identity changed; use a new turn key or a fresh run`,
        );
      }
      if (existing?.status === "completed") {
        return { kind: "replay" as const, value: readJournalResult(this.store, existing) };
      }

      const resuming = existing?.status === "pending";
      const attempt = resuming ? existing.attempt : existing ? existing.attempt + 1 : 1;
      if (
        session.activeTurnKey &&
        (session.activeTurnKey !== m.turnKey || session.activeTurnAttempt !== attempt)
      ) {
        throw new Error(
          `agent session "${m.agentKey}" already has active turn "${session.activeTurnKey}"`,
        );
      }

      const turn = this.store.getLatestAgentSessionTurn(runId, m.agentKey, m.turnKey);
      const startedSessionToken = resuming
        ? (turn?.observedSessionToken ??
          turn?.startedSessionToken ??
          existing?.sessionToken ??
          null)
        : session.currentSessionToken
          ? session.currentSessionToken
          : session.latestCompletedTurnKey === null
            ? null
            : undefined;
      if (startedSessionToken === undefined) {
        throw new Error(
          `agent session "${m.agentKey}" has no current session token for new turn "${m.turnKey}"`,
        );
      }
      return {
        kind: "execute" as const,
        attempt,
        inputHash,
        startedAtMs,
        startedSessionToken,
        ...(startedSessionToken ? { resumeToken: startedSessionToken } : {}),
      };
    });
    if (preflight.kind === "replay") return preflight;

    const holder: WorkspaceHolder = {
      kind: "agent_session",
      key: m.agentKey,
      attempt: preflight.attempt,
    };
    const workspace = this.beginInvocationWorkspace(runId, m.workspaceId, holder, startedAtMs);

    this.store.transaction(() => {
      this.store.putJournalRow({
        runId,
        stableKey: m.stableKey,
        attempt: preflight.attempt,
        effectType: "effectful",
        status: "pending",
        version: m.version,
        inputHash,
        inputDeps: m.deps,
        sessionToken: preflight.startedSessionToken,
        startedAtMs,
      });
      this.store.putAgentSessionTurn({
        runId,
        agentKey: m.agentKey,
        turnKey: m.turnKey,
        attempt: preflight.attempt,
        stableKey: m.stableKey,
        status: "pending",
        startedSessionToken: preflight.startedSessionToken,
        observedSessionToken: null,
        completedSessionToken: null,
        startedAtMs,
        finishedAtMs: null,
      });
      this.store.updateAgentSessionActive(
        runId,
        m.agentKey,
        m.turnKey,
        preflight.attempt,
        startedAtMs,
      );
      if (workspace.owned) {
        this.store.updateAgentWorkspace(runId, workspace.workspaceId, {
          lastTurnKey: m.turnKey,
          lastTurnAttempt: preflight.attempt,
          updatedAtMs: startedAtMs,
        });
      }
    });
    this.host.fault?.("after-pending", m.stableKey);
    return {
      kind: "execute" as const,
      attempt: preflight.attempt,
      inputHash,
      startedAtMs,
      cwd: workspace.cwd,
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.workspacePath,
      workspaceTarget: workspace.sourcePath,
      workspaceOwned: workspace.owned,
      workspaceMode: workspace.mode,
      ...(workspace.baseCommit ? { workspaceBaseCommit: workspace.baseCommit } : {}),
      ...(workspace.copyBaselinePath
        ? { workspaceCopyBaselinePath: workspace.copyBaselinePath }
        : {}),
      ...(preflight.resumeToken ? { resumeToken: preflight.resumeToken } : {}),
    };
  }

  private beginAgentWorkspace(
    runId: string,
    m: Extract<WorkerRequest, { type: "agent" }>,
    attempt: number,
    startedAtMs: number,
  ): InvocationWorkspace {
    return this.beginInvocationWorkspace(
      runId,
      m.workspaceId,
      { kind: "agent", key: m.key, attempt },
      startedAtMs,
    );
  }

  private captureAgentWorkspaceEvents(
    m: Extract<WorkerRequest, { type: "agent" }>,
    workspace: InvocationWorkspace,
  ): { events: DurableAgentEvent[]; status: "idle" | "diff_error" } {
    if (!workspace.owned) return { events: [], status: "idle" };
    try {
      const bundle =
        workspace.mode === "copy"
          ? diffCopyWorkspace(workspace.workspacePath, workspace.copyBaselinePath ?? "")
          : workspace.mode === "clone"
            ? diffGitFinalTree(workspace.workspacePath, workspace.baseCommit ?? "HEAD")
            : diffWorkspace(workspace.workspacePath);
      return {
        status: "idle",
        events: [
          {
            type: "agent.diff",
            payload: {
              key: m.key,
              workspaceId: workspace.workspaceId ?? null,
              workspacePath: workspace.workspacePath,
              sourcePath: workspace.sourcePath,
              baseCommit: workspace.baseCommit ?? null,
              mode: workspace.mode,
              diffKind: bundle.diffKind ?? "git-patch",
              modified: bundle.modified,
              added: bundle.added,
              deleted: bundle.deleted,
              omittedPathCounts: { ...bundle.omittedPathCounts },
              pathLimit: bundle.pathLimit,
              contentDiff: bundle.contentDiff,
              fileChanges: jsonFileChanges(bundle.fileChanges),
            },
          },
        ],
      };
    } catch (err) {
      return {
        status: "diff_error",
        events: [
          {
            type: "workspace.diff_error",
            payload: {
              key: m.key,
              workspaceId: workspace.workspaceId ?? null,
              workspacePath: workspace.workspacePath,
              error: serializeError(err),
            },
          },
        ],
      };
    }
  }

  private updateAgentWorkspaceAfterEvents(
    runId: string,
    workspaceId: string | undefined,
    holder: WorkspaceHolder,
    status: "idle" | "diff_error",
    failureSeen: boolean,
    events: DurableAgentEvent[],
    atMs: number,
  ): void {
    if (!workspaceId) return;
    this.store.transaction(() => {
      let lastDiffEventSeq: number | null = null;
      let lastErrorEventSeq: number | null = null;
      for (const event of events) {
        const seq = this.store.appendEvent(runId, event.type, event.payload, atMs);
        if (event.type === "agent.diff") lastDiffEventSeq = seq;
        if (event.type === "workspace.diff_error") lastErrorEventSeq = seq;
      }
      this.releaseWorkspaceHolder(runId, workspaceId, holder, {
        status,
        ...(failureSeen || status === "diff_error" ? { failureSeen: true } : {}),
        ...(lastDiffEventSeq !== null ? { lastDiffEventSeq } : {}),
        ...(lastErrorEventSeq !== null ? { lastErrorEventSeq } : {}),
        updatedAtMs: atMs,
      });
    });
  }

  private recordAgentSessionToken(
    engine: StepEngine,
    runId: string,
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    attempt: number,
    token: string,
    expectedToken: string | undefined,
  ): void {
    if (this.isRunInterrupted(runId)) return;
    if (expectedToken && token !== expectedToken) {
      throw new AgentSessionContinuityError(
        `agent session "${m.agentKey}" turn "${m.turnKey}" resumed with token "${expectedToken}" but provider reported "${token}"`,
      );
    }
    this.store.transaction(() => {
      engine.recordSessionToken(m.stableKey, attempt, token);
      this.store.recordAgentSessionTurnToken(runId, m.agentKey, m.turnKey, attempt, token);
    });
  }

  private emitAgentTrace(engine: StepEngine, key: string, attempt: number, ev: TraceEvent): void {
    if (ev.type === "session") return;
    engine.emitAgentTrace(key, attempt, ev);
  }

  private captureSessionWorkspaceEvents(
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    begun: {
      attempt: number;
      workspaceId?: string;
      workspacePath?: string;
      workspaceTarget?: string | null;
      workspaceBaseCommit?: string;
      workspaceCopyBaselinePath?: string;
      workspaceMode?: AgentWorkspaceRow["mode"];
      workspaceOwned?: boolean;
    },
  ): { events: DurableAgentEvent[]; status: "idle" | "diff_error" } {
    if (!begun.workspaceOwned || !begun.workspacePath) return { events: [], status: "idle" };
    try {
      const bundle =
        begun.workspaceMode === "copy"
          ? diffCopyWorkspace(begun.workspacePath, begun.workspaceCopyBaselinePath ?? "")
          : begun.workspaceMode === "clone"
            ? diffGitFinalTree(begun.workspacePath, begun.workspaceBaseCommit ?? "HEAD")
            : diffWorkspace(begun.workspacePath);
      return {
        status: "idle",
        events: [
          {
            type: "agent.diff",
            payload: {
              key: m.stableKey,
              agentKey: m.agentKey,
              turnKey: m.turnKey,
              workspaceId: begun.workspaceId ?? null,
              workspacePath: begun.workspacePath,
              sourcePath: begun.workspaceTarget ?? null,
              baseCommit: begun.workspaceBaseCommit ?? null,
              mode: begun.workspaceMode ?? "worktree",
              diffKind: bundle.diffKind ?? "git-patch",
              modified: bundle.modified,
              added: bundle.added,
              deleted: bundle.deleted,
              omittedPathCounts: { ...bundle.omittedPathCounts },
              pathLimit: bundle.pathLimit,
              contentDiff: bundle.contentDiff,
              fileChanges: jsonFileChanges(bundle.fileChanges),
            },
          },
        ],
      };
    } catch (err) {
      return {
        status: "diff_error",
        events: [
          {
            type: "workspace.diff_error",
            payload: {
              key: m.stableKey,
              agentKey: m.agentKey,
              turnKey: m.turnKey,
              workspaceId: begun.workspaceId ?? null,
              workspacePath: begun.workspacePath,
              error: serializeError(err),
            },
          },
        ],
      };
    }
  }

  private completeAgentSessionTurn(
    runId: string,
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    begun: {
      attempt: number;
      inputHash: string;
      startedAtMs: number;
      workspaceId?: string;
      workspacePath?: string;
      resumeToken?: string;
    },
    value: unknown,
    providerSessionToken: string | undefined,
    events: DurableAgentEvent[] = [],
    workspaceStatus: "idle" | "diff_error" = "idle",
    failureSeen = false,
  ): void {
    if (this.isRunInterrupted(runId)) return;
    const journalRow = this.store.getJournalRow(runId, m.stableKey, begun.attempt);
    const turn = this.store.getLatestAgentSessionTurn(runId, m.agentKey, m.turnKey);
    const tokenAfter =
      turn?.observedSessionToken ?? providerSessionToken ?? journalRow?.sessionToken ?? null;
    if (begun.resumeToken && providerSessionToken && providerSessionToken !== begun.resumeToken) {
      throw new AgentSessionContinuityError(
        `agent session "${m.agentKey}" turn "${m.turnKey}" resumed with token "${begun.resumeToken}" but provider returned "${providerSessionToken}"`,
      );
    }
    if (!tokenAfter) {
      throw new AgentSessionContinuityError(
        `agent session "${m.agentKey}" turn "${m.turnKey}" completed without a session token`,
      );
    }
    this.host.fault?.("before-commit", m.stableKey);
    const stored = prepareStepResult(value);
    const finishedAtMs = this.host.clock();
    this.store.transaction(() => {
      if (stored.artifact) {
        this.store.putArtifact(stored.artifact.hash, stored.artifact.bytes, finishedAtMs);
      }
      let lastDiffEventSeq: number | null = null;
      let lastErrorEventSeq: number | null = null;
      for (const event of events) {
        const seq = this.store.appendEvent(runId, event.type, event.payload, finishedAtMs);
        if (event.type === "agent.diff") lastDiffEventSeq = seq;
        if (event.type === "workspace.diff_error") lastErrorEventSeq = seq;
      }
      this.store.putJournalRow({
        runId,
        stableKey: m.stableKey,
        attempt: begun.attempt,
        effectType: "effectful",
        status: "completed",
        version: m.version,
        inputHash: begun.inputHash,
        inputDeps: m.deps,
        resultInline: stored.inline,
        resultArtifact: stored.artifact?.hash ?? null,
        sessionToken: tokenAfter,
        startedAtMs: begun.startedAtMs,
        finishedAtMs,
      });
      this.store.completeAgentSessionTurn(
        runId,
        m.agentKey,
        m.turnKey,
        begun.attempt,
        tokenAfter,
        finishedAtMs,
      );
      this.store.completeAgentSession(
        runId,
        m.agentKey,
        m.turnKey,
        begun.attempt,
        tokenAfter,
        finishedAtMs,
      );
      this.releaseWorkspaceHolder(
        runId,
        begun.workspaceId,
        { kind: "agent_session", key: m.agentKey, attempt: begun.attempt },
        {
          status: workspaceStatus,
          ...(failureSeen || workspaceStatus === "diff_error" ? { failureSeen: true } : {}),
          lastTurnKey: m.turnKey,
          lastTurnAttempt: begun.attempt,
          ...(lastDiffEventSeq !== null ? { lastDiffEventSeq } : {}),
          ...(lastErrorEventSeq !== null ? { lastErrorEventSeq } : {}),
          updatedAtMs: finishedAtMs,
        },
      );
    });
    this.store.appendEvent(
      runId,
      "step.completed",
      { stableKey: m.stableKey, effectType: "effectful" },
      this.host.clock(),
    );
  }

  private failAgentSessionTurn(
    runId: string,
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    begun: {
      attempt: number;
      inputHash: string;
      startedAtMs: number;
      workspaceId?: string;
      workspacePath?: string;
    },
    err: unknown,
    events: DurableAgentEvent[] = [],
  ): void {
    if (this.isRunInterrupted(runId)) return;
    const atMs = this.host.clock();
    this.store.transaction(() => {
      let lastDiffEventSeq: number | null = null;
      let lastErrorEventSeq: number | null = null;
      for (const event of events) {
        const seq = this.store.appendEvent(runId, event.type, event.payload, atMs);
        if (event.type === "agent.diff") lastDiffEventSeq = seq;
        if (event.type === "workspace.diff_error") lastErrorEventSeq = seq;
      }
      const existing = this.store.getJournalRow(runId, m.stableKey, begun.attempt);
      this.store.putJournalRow({
        runId,
        stableKey: m.stableKey,
        attempt: begun.attempt,
        effectType: "effectful",
        status: "failed",
        version: m.version,
        inputHash: begun.inputHash,
        inputDeps: m.deps,
        sessionToken: existing?.sessionToken ?? null,
        errorJson: JSON.stringify(serializeError(err)),
        startedAtMs: begun.startedAtMs,
        finishedAtMs: atMs,
      });
      this.store.failAgentSessionTurn(runId, m.agentKey, m.turnKey, begun.attempt, atMs);
      this.releaseWorkspaceHolder(
        runId,
        begun.workspaceId,
        { kind: "agent_session", key: m.agentKey, attempt: begun.attempt },
        {
          status: lastErrorEventSeq !== null ? "diff_error" : "idle",
          failureSeen: true,
          lastTurnKey: m.turnKey,
          lastTurnAttempt: begun.attempt,
          ...(lastDiffEventSeq !== null ? { lastDiffEventSeq } : {}),
          ...(lastErrorEventSeq !== null ? { lastErrorEventSeq } : {}),
          updatedAtMs: atMs,
        },
      );
    });
  }

  private registerActiveExecution(runId: string, active: ActiveExecution): () => void {
    const set = this.activeExecutions.get(runId) ?? new Set<ActiveExecution>();
    set.add(active);
    this.activeExecutions.set(runId, set);
    return () => {
      const current = this.activeExecutions.get(runId);
      if (!current) return;
      current.delete(active);
      if (current.size === 0) this.activeExecutions.delete(runId);
    };
  }

  private isRunInterrupted(runId: string): boolean {
    return this.store.getRun(runId)?.status === "interrupted";
  }

  private execute<O>(runId: string, workflowUrl: string, input: unknown): Promise<RunHandle<O>> {
    let sessionRunGuarded = false;
    if (this.store.hasAgentSessions(runId)) {
      if (this.activeSessionRuns.has(runId)) {
        return Promise.reject(
          new Error(
            `run ${runId} uses durable agent sessions and is already executing in this kernel`,
          ),
        );
      }
      this.activeSessionRuns.add(runId);
      sessionRunGuarded = true;
    }
    const runTarget = this.store.getRun(runId)?.runTarget ?? null;
    this.recoverActiveWorkspaceHolders(runId, this.host.clock());
    const source = readSourceSafe(workflowUrl);
    const sourcePath = workflowUrl.startsWith("file:")
      ? new URL(workflowUrl).pathname
      : workflowUrl;
    const moduleHelpers = source ? extractModuleHelpers(source, sourcePath) : {};
    return new Promise<RunHandle<O>>((resolve, reject) => {
      const engine = new StepEngine(this.store, runId, this.host);
      const sab = new SharedArrayBuffer(SAB_BYTES);
      const control = new Int32Array(sab, 0, CONTROL_WORDS);
      const valueView = new Float64Array(sab, VALUE_OFFSET, 1);
      const worker = new Worker(WORKER_URL, { type: "module" });
      const runAbortController = new AbortController();
      this.activeWorkers.add(worker);

      let settled = false;
      let unregisterActive = () => {};
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (sessionRunGuarded) this.activeSessionRuns.delete(runId);
        this.activeWorkers.delete(worker);
        unregisterActive();
        worker.terminate();
        fn();
      };
      const finishInterrupted = (): void => {
        finish(() => resolve({ runId, status: "interrupted" }));
      };
      const active: ActiveExecution = {
        interrupt: () => {
          runAbortController.abort(new RunInterruptedError(runId));
          finishInterrupted();
        },
      };
      unregisterActive = this.registerActiveExecution(runId, active);
      const reply = (id: number, payload: unknown): void => {
        // After the run settles the worker is terminated; a late reply from an
        // in-flight agent (e.g. another fan-out verifier finishing after a crash)
        // would throw on postMessage. Drop it — the journal already holds its row.
        if (settled) return;
        try {
          worker.postMessage({ type: "rpc-reply", id, payload } satisfies HostReply);
        } catch {
          // worker gone
        }
      };
      const replyError = (id: number, err: unknown): void => {
        if (settled) return;
        try {
          worker.postMessage({
            type: "rpc-error",
            id,
            error: serializeError(err),
          } satisfies HostReply);
        } catch {
          // worker gone
        }
      };
      // Settle a run as resumable (a host-side crash fault); the pending row
      // written before the fault drives re-execution on the next run.
      const abort = (err: unknown): void => {
        if (this.isRunInterrupted(runId)) {
          finishInterrupted();
          return;
        }
        this.store.appendEvent(
          runId,
          "run.aborted",
          { name: "HostFault", message: String(err) },
          this.host.clock(),
        );
        finish(() => reject(err));
      };

      worker.onmessage = (e: MessageEvent<WorkerRequest>) => {
        if (settled) return;
        const m = e.data;
        try {
          if (m.type !== "ready" && this.isRunInterrupted(runId)) {
            finishInterrupted();
            return;
          }
          switch (m.type) {
            case "ready":
              worker.postMessage({
                type: "init",
                workflowUrl,
                input,
                sab,
                moduleHelpers,
                agentProfiles: this.profilesForRun(runId),
                runId,
                runTarget,
              } satisfies HostReply);
              break;
            case "step-begin": {
              const begun = engine.beginStep(m.key, m.inputs as Json, m.version, m.deps);
              if (begun.kind === "replay") {
                reply(m.id, {
                  action: "replay",
                  value: begun.value,
                  contentHash: hashJson(begun.value),
                });
              } else {
                reply(m.id, {
                  action: "execute",
                  attempt: begun.attempt,
                  inputHash: begun.inputHash,
                  startedAtMs: begun.startedAtMs,
                });
              }
              break;
            }
            case "step-commit": {
              this.onStepExecute?.(m.key);
              engine.completeStep(
                m.key,
                m.attempt,
                m.version,
                m.inputHash,
                m.startedAtMs,
                m.value,
                m.deps,
              );
              reply(m.id, { contentHash: hashJson(m.value) });
              break;
            }
            case "step-fail": {
              this.onStepExecute?.(m.key);
              engine.failStep(
                m.key,
                m.attempt,
                m.version,
                m.inputHash,
                m.startedAtMs,
                rebuildError(m.error),
              );
              reply(m.id, {});
              break;
            }
            case "workspace": {
              try {
                const handle = this.resolveWorkspaceSpec(runId, m.spec, this.host.clock());
                reply(m.id, handle);
              } catch (err) {
                replyError(m.id, err);
              }
              break;
            }
            case "agent": {
              let providerConfig: Readonly<ProviderConfigValue> | undefined;
              try {
                providerConfig = m.providerConfig
                  ? normalizeProviderConfigValue(`realm agent "${m.key}"`, m.providerConfig)
                  : undefined;
              } catch (err) {
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              const begun = engine.beginStep(
                m.key,
                m.inputs as Json,
                m.version,
                m.deps,
                "effectful",
              );
              if (begun.kind === "replay") {
                reply(m.id, { ok: true, output: begun.value, contentHash: hashJson(begun.value) });
                break;
              }
              this.onStepExecute?.(m.key);
              const registry = this.registry;
              if (!registry) {
                const err = new Error("ctx.agent requires an agent provider registry");
                engine.failStep(
                  m.key,
                  begun.attempt,
                  m.version,
                  begun.inputHash,
                  begun.startedAtMs,
                  err,
                  "effectful",
                );
                reply(m.id, { ok: false, error: { name: "Error", message: err.message } });
                break;
              }
              // §11: an explicitly isolated agent edits in a git worktree;
              // secrets are injected as invocation env from the side channel.
              const caps = m.capabilities ?? undefined;
              const workspaceHolder: WorkspaceHolder = {
                kind: "agent",
                key: m.key,
                attempt: begun.attempt,
              };
              let workspace: ReturnType<typeof this.beginAgentWorkspace>;
              try {
                workspace = this.beginAgentWorkspace(runId, m, begun.attempt, begun.startedAtMs);
              } catch (err) {
                engine.failStep(
                  m.key,
                  begun.attempt,
                  m.version,
                  begun.inputHash,
                  begun.startedAtMs,
                  err,
                  "effectful",
                );
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              const secretRefs = this.secrets?.resolve(runId, m.secrets) ?? [];
              const secretEnv: Record<string, string> = {};
              for (const r of secretRefs) secretEnv[r.name] = r.value;

              void (async () => {
                try {
                  const execution = await runAgentWithStall(
                    (signal) =>
                      executeAgent(
                        registry.get(m.provider),
                        {
                          key: m.key,
                          provider: m.provider,
                          prompt: m.prompt,
                          ...(providerConfig !== undefined ? { providerConfig } : {}),
                          ...(m.model ? { model: m.model } : {}),
                          toolPolicy: m.toolPolicy,
                          allowTools: m.allowTools,
                          denyTools: m.denyTools,
                          ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                          ...(caps ? { capabilities: caps } : {}),
                          cwd: workspace.cwd,
                          ...(secretRefs.length > 0 ? { env: secretEnv } : {}),
                          ...(begun.resumeToken ? { resumeToken: begun.resumeToken } : {}),
                          abortSignal: signal,
                        },
                        {
                          onSessionToken: (tok) => {
                            if (!settled && !this.isRunInterrupted(runId)) {
                              engine.recordSessionToken(m.key, begun.attempt, tok);
                            }
                          },
                          // Tool calls/results are durably appended here before
                          // returning to the adapter; text/reasoning frames are live-only.
                          onEvent: (ev) => {
                            if (!settled && !this.isRunInterrupted(runId)) {
                              this.emitAgentTrace(engine, m.key, begun.attempt, ev);
                            }
                          },
                        },
                        {
                          ...(m.jsonSchema != null ? { jsonSchema: m.jsonSchema } : {}),
                          maxRetries: m.maxRetries,
                          ...(m.lenient ? { coerce: true } : {}),
                        },
                      ),
                    {
                      ...(m.timeoutMs != null ? { timeoutMs: m.timeoutMs } : {}),
                      ...(m.stallRetries != null ? { stallRetries: m.stallRetries } : {}),
                      signal: runAbortController.signal,
                      onStall: (a) => engine.emit("agent.stalled", { key: m.key, attempt: a }),
                    },
                  );
                  if (settled || this.isRunInterrupted(runId)) {
                    this.releaseWorkspaceHolder(runId, workspace.workspaceId, workspaceHolder, {
                      status: "idle",
                      updatedAtMs: this.host.clock(),
                    });
                    return;
                  }
                  const output = execution.output;
                  const workspaceCapture = this.captureAgentWorkspaceEvents(m, workspace);
                  const text = execution.text;
                  try {
                    engine.completeStep(
                      m.key,
                      begun.attempt,
                      m.version,
                      begun.inputHash,
                      begun.startedAtMs,
                      output,
                      m.deps,
                      "effectful",
                      finalAgentMessageEvents(m.key, begun.attempt, text),
                    );
                    this.updateAgentWorkspaceAfterEvents(
                      runId,
                      workspace.workspaceId,
                      workspaceHolder,
                      workspaceCapture.status,
                      false,
                      workspaceCapture.events,
                      this.host.clock(),
                    );
                  } catch (faultErr) {
                    abort(faultErr); // crash fault inside completeStep: leave pending
                    return;
                  }
                  reply(m.id, {
                    ok: true,
                    output,
                    contentHash: hashJson(output),
                  });
                } catch (agentErr) {
                  if (settled || this.isRunInterrupted(runId)) {
                    this.releaseWorkspaceHolder(runId, workspace.workspaceId, workspaceHolder, {
                      status: "idle",
                      failureSeen: true,
                      updatedAtMs: this.host.clock(),
                    });
                    return;
                  }
                  // onFailure:'null' (D7) tolerates a terminal failure: journal a
                  // COMPLETED null (with failure metadata as an event) so resume
                  // replays null instead of re-calling the agent.
                  if (m.onFailure === "null") {
                    const errJson = serializeError(agentErr) as unknown as Json;
                    engine.emit("agent.tolerated_failure", { key: m.key, error: errJson });
                    const workspaceCapture = this.captureAgentWorkspaceEvents(m, workspace);
                    try {
                      engine.completeStep(
                        m.key,
                        begun.attempt,
                        m.version,
                        begun.inputHash,
                        begun.startedAtMs,
                        null,
                        m.deps,
                        "effectful",
                      );
                      this.updateAgentWorkspaceAfterEvents(
                        runId,
                        workspace.workspaceId,
                        workspaceHolder,
                        workspaceCapture.status,
                        true,
                        workspaceCapture.events,
                        this.host.clock(),
                      );
                    } catch (faultErr) {
                      abort(faultErr);
                      return;
                    }
                    reply(m.id, { ok: true, output: null, contentHash: hashJson(null) });
                    return;
                  }
                  const workspaceCapture = this.captureAgentWorkspaceEvents(m, workspace);
                  this.updateAgentWorkspaceAfterEvents(
                    runId,
                    workspace.workspaceId,
                    workspaceHolder,
                    workspaceCapture.status,
                    true,
                    workspaceCapture.events,
                    this.host.clock(),
                  );
                  engine.failStep(
                    m.key,
                    begun.attempt,
                    m.version,
                    begun.inputHash,
                    begun.startedAtMs,
                    agentErr,
                    "effectful",
                  );
                  reply(m.id, {
                    ok: false,
                    error: serializeError(agentErr),
                    failure: agentErr instanceof AgentFailure,
                  });
                }
              })();
              break;
            }
            case "agent-turn": {
              const registry = this.registry;
              if (!registry) {
                reply(m.id, {
                  ok: false,
                  error: {
                    name: "Error",
                    message: "ctx.agentSession requires an agent provider registry",
                  },
                });
                break;
              }
              const provider = registry.get(m.provider);
              if (!sessionRunGuarded && this.activeSessionRuns.has(runId)) {
                reply(m.id, {
                  ok: false,
                  error: {
                    name: "Error",
                    message: `run ${runId} uses durable agent sessions and is already executing in this kernel`,
                  },
                });
                break;
              }
              let providerConfig: Readonly<ProviderConfigValue> | undefined;
              let begun: ReturnType<typeof this.beginAgentSessionTurn>;
              try {
                providerConfig = m.providerConfig
                  ? normalizeProviderConfigValue(
                      `realm agent session "${m.agentKey}"`,
                      m.providerConfig,
                    )
                  : undefined;
                begun = this.beginAgentSessionTurn(runId, m, provider);
              } catch (err) {
                const pending = this.store.getLatestAttempt(runId, m.stableKey);
                if (pending?.status === "pending") {
                  abort(err);
                  break;
                }
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              if (begun.kind === "replay") {
                reply(m.id, { ok: true, output: begun.value, contentHash: hashJson(begun.value) });
                break;
              }
              if (!sessionRunGuarded) {
                this.activeSessionRuns.add(runId);
                sessionRunGuarded = true;
              }
              this.onStepExecute?.(m.stableKey);
              const caps = m.capabilities ?? undefined;
              const secretRefs = this.secrets?.resolve(runId, m.secrets) ?? [];
              const secretEnv: Record<string, string> = {};
              for (const r of secretRefs) secretEnv[r.name] = r.value;

              void (async () => {
                try {
                  const execution = await runAgentWithStall(
                    (signal) =>
                      executeAgent(
                        provider,
                        {
                          key: m.stableKey,
                          provider: m.provider,
                          prompt: m.prompt,
                          ...(providerConfig !== undefined ? { providerConfig } : {}),
                          ...(m.model ? { model: m.model } : {}),
                          toolPolicy: m.toolPolicy,
                          allowTools: m.allowTools,
                          denyTools: m.denyTools,
                          ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                          ...(caps ? { capabilities: caps } : {}),
                          cwd: begun.cwd,
                          ...(secretRefs.length > 0 ? { env: secretEnv } : {}),
                          ...(begun.resumeToken ? { resumeToken: begun.resumeToken } : {}),
                          abortSignal: signal,
                        },
                        {
                          onSessionToken: (tok) => {
                            if (!settled && !this.isRunInterrupted(runId)) {
                              this.recordAgentSessionToken(
                                engine,
                                runId,
                                m,
                                begun.attempt,
                                tok,
                                begun.resumeToken,
                              );
                            }
                          },
                          onEvent: (ev) => {
                            if (!settled && !this.isRunInterrupted(runId)) {
                              this.emitAgentTrace(engine, m.stableKey, begun.attempt, ev);
                            }
                          },
                        },
                        {
                          ...(m.jsonSchema != null ? { jsonSchema: m.jsonSchema } : {}),
                          maxRetries: m.maxRetries,
                          ...(m.lenient ? { coerce: true } : {}),
                        },
                      ),
                    {
                      ...(m.timeoutMs != null ? { timeoutMs: m.timeoutMs } : {}),
                      ...(m.stallRetries != null ? { stallRetries: m.stallRetries } : {}),
                      signal: runAbortController.signal,
                      onStall: (a) =>
                        engine.emit("agent.stalled", { key: m.stableKey, attempt: a }),
                    },
                  );
                  if (settled || this.isRunInterrupted(runId)) {
                    this.releaseWorkspaceHolder(
                      runId,
                      begun.workspaceId,
                      { kind: "agent_session", key: m.agentKey, attempt: begun.attempt },
                      { status: "idle", updatedAtMs: this.host.clock() },
                    );
                    return;
                  }
                  const output = execution.output;
                  const text = execution.text;
                  const workspaceCapture = this.captureSessionWorkspaceEvents(m, begun);
                  try {
                    this.completeAgentSessionTurn(
                      runId,
                      m,
                      begun,
                      output,
                      execution.sessionToken,
                      [
                        ...workspaceCapture.events,
                        ...finalAgentMessageEvents(m.stableKey, begun.attempt, text),
                      ],
                      workspaceCapture.status,
                    );
                  } catch (err) {
                    if (!(err instanceof AgentSessionContinuityError)) {
                      abort(err);
                      return;
                    }
                    this.failAgentSessionTurn(runId, m, begun, err);
                    reply(m.id, { ok: false, error: serializeError(err) });
                    return;
                  }
                  reply(m.id, { ok: true, output, contentHash: hashJson(output) });
                } catch (agentErr) {
                  if (settled || this.isRunInterrupted(runId)) {
                    this.releaseWorkspaceHolder(
                      runId,
                      begun.workspaceId,
                      { kind: "agent_session", key: m.agentKey, attempt: begun.attempt },
                      { status: "idle", failureSeen: true, updatedAtMs: this.host.clock() },
                    );
                    return;
                  }
                  if (m.onFailure === "null" && agentErr instanceof AgentFailure) {
                    const errJson = serializeError(agentErr) as unknown as Json;
                    engine.emit("agent.tolerated_failure", { key: m.stableKey, error: errJson });
                    const workspaceCapture = this.captureSessionWorkspaceEvents(m, begun);
                    try {
                      this.completeAgentSessionTurn(
                        runId,
                        m,
                        begun,
                        null,
                        undefined,
                        workspaceCapture.events,
                        workspaceCapture.status,
                        true,
                      );
                    } catch (err) {
                      if (!(err instanceof AgentSessionContinuityError)) {
                        abort(err);
                        return;
                      }
                      this.failAgentSessionTurn(runId, m, begun, err);
                      reply(m.id, { ok: false, error: serializeError(err) });
                      return;
                    }
                    reply(m.id, { ok: true, output: null, contentHash: hashJson(null) });
                    return;
                  }
                  this.failAgentSessionTurn(
                    runId,
                    m,
                    begun,
                    agentErr,
                    this.captureSessionWorkspaceEvents(m, begun).events,
                  );
                  reply(m.id, {
                    ok: false,
                    error: serializeError(agentErr),
                    failure: agentErr instanceof AgentFailure,
                  });
                }
              })();
              break;
            }
            case "ambient": {
              const v = m.kind === "now" ? engine.now() : engine.random();
              valueView[0] = v;
              Atomics.store(control, 0, 1);
              Atomics.notify(control, 0);
              break;
            }
            case "park-check": {
              // §16: durable timer. Record (idempotent) the fire time and report
              // whether it has elapsed. Resolved against the REAL clock so a
              // resumed run wakes once due; the fireAt itself is journaled.
              if (m.kind === "timer") {
                const fireAt = this.host.clock() + (m.durationMs ?? 0);
                const t = this.store.upsertTimer(runId, m.key, fireAt);
                const ready = this.host.clock() >= t.fireAtMs;
                if (ready) this.store.markTimerFired(runId, m.key);
                reply(m.id, { ready, until: t.fireAtMs });
              } else if (m.kind === "human") {
                // §17: record a pending approval (incl. the prompt + requested caps
                // the worker sent) so a UI can render it; ready once decided.
                const ask = (m.payload ?? {}) as { prompt?: string; requestedCaps?: unknown };
                this.store.requestApproval(
                  runId,
                  m.key,
                  { prompt: ask.prompt ?? "", requestedCaps: ask.requestedCaps },
                  this.host.clock(),
                );
                const appr = this.store.getApproval(runId, m.key);
                if (appr && appr.status !== "pending") {
                  reply(m.id, {
                    ready: true,
                    value: { status: appr.status, note: appr.note, grantedCaps: appr.grantedCaps },
                  });
                } else {
                  reply(m.id, { ready: false });
                }
              } else {
                // §17 signal: replay the already-consumed payload, else consume the
                // oldest pending signal of this name; park if none has arrived.
                const name = (m.payload as { name: string }).name;
                const replayed = this.store.signalConsumedBy(runId, m.key);
                const got = replayed ?? this.store.consumeSignal(runId, name, m.key);
                if (got) reply(m.id, { ready: true, value: got.payload });
                else reply(m.id, { ready: false });
              }
              break;
            }
            case "parked": {
              const status: RunStatus =
                m.kind === "timer"
                  ? "waiting-timer"
                  : m.kind === "human"
                    ? "waiting-human"
                    : "waiting-signal";
              this.store.updateRun(runId, { status });
              this.store.appendEvent(
                runId,
                "run.parked",
                { kind: m.kind, key: m.key, until: m.until },
                this.host.clock(),
              );
              finish(() => resolve({ runId, status }));
              break;
            }
            case "log":
              engine.emit("log", { message: m.message, data: (m.data ?? null) as Json });
              break;
            case "phase":
              engine.emit("phase", { title: m.title });
              break;
            case "result": {
              const at = this.host.clock();
              this.store.transaction(() => {
                this.store.updateRun(runId, {
                  status: "finished",
                  outputRef: JSON.stringify(m.output ?? null),
                  finishedAtMs: at,
                });
                this.store.appendEvent(
                  runId,
                  "run.finished",
                  runFinishedPayload(m.output ?? null),
                  at,
                );
              });
              cleanupTerminalRunWorkspaces(this.store, runId, "finished", at);
              this.secrets?.wipe(runId); // §11.2: secrets live per-run; wipe on terminal
              finish(() => resolve({ runId, status: "finished", output: m.output as O }));
              break;
            }
            case "continue": {
              // §19: end this run (status 'continued') and chain a fresh run of
              // the same workflow with the new input — bounded journal growth.
              const run = this.store.getRun(runId);
              if (!run) throw new Error(`run ${runId} not found during continueAsNew`);
              const name = run.workflowName;
              const definitionVersion = run.definitionVersion;
              const workflowRef = run.workflowRef;
              const runTarget = run.runTarget;
              const nextId = this.idgen();
              const at = this.host.clock();
              // ATOMIC handoff: create the successor AND mark this run 'continued'
              // in one transaction. A crash between cannot leave a resumable
              // original next to an orphan successor (which would re-launch a
              // duplicate on resume — the original is now terminal 'continued').
              this.store.transaction(() => {
                this.store.insertRun({
                  runId: nextId,
                  workflowName: name,
                  definitionVersion,
                  workflowRef,
                  runTarget,
                  status: "running",
                  parentRunId: runId, // lineage
                  tenantId: null,
                  inputRef: JSON.stringify(m.input ?? null),
                  outputRef: null,
                  errorJson: null,
                  heartbeatAtMs: null,
                  runtimeOwnerId: null,
                  createdAtMs: at,
                });
                this.store.copyRunProfileSnapshot(runId, nextId);
                this.store.appendEvent(nextId, "run.started", { name, continuedFrom: runId }, at);
                this.store.updateRun(runId, {
                  status: "continued",
                  outputRef: JSON.stringify({ continuedTo: nextId }),
                  finishedAtMs: at,
                });
                this.store.appendEvent(runId, "run.continued", { continuedTo: nextId }, at);
              });
              cleanupTerminalRunWorkspaces(this.store, runId, "continued", at);
              this.secrets?.wipe(runId);
              // start the successor's execution OUTSIDE the transaction
              void this.execute(nextId, workflowUrl, m.input);
              finish(() =>
                resolve({ runId, status: "continued", output: { continuedTo: nextId } as O }),
              );
              break;
            }
            case "error": {
              if (m.aborted) {
                // resumable: leave run 'running'
                this.store.appendEvent(runId, "run.aborted", m.error, this.host.clock());
              } else {
                const at = this.host.clock();
                this.store.transaction(() => {
                  this.store.updateRun(runId, {
                    status: "failed",
                    errorJson: JSON.stringify(m.error),
                    finishedAtMs: at,
                  });
                  this.store.appendEvent(runId, "run.failed", m.error, at);
                });
                cleanupTerminalRunWorkspaces(this.store, runId, "failed", at);
                this.secrets?.wipe(runId); // terminal failure: wipe secrets
              }
              finish(() => reject(rebuildError(m.error)));
              break;
            }
          }
        } catch (hostErr) {
          if (this.isRunInterrupted(runId)) {
            finishInterrupted();
            return;
          }
          if (hostErr instanceof ProfileSnapshotIntegrityError) {
            const at = this.host.clock();
            const error = serializeError(hostErr);
            this.store.transaction(() => {
              this.store.updateRun(runId, {
                status: "failed",
                errorJson: JSON.stringify(error),
                finishedAtMs: at,
              });
              this.store.appendEvent(runId, "run.failed", error, at);
            });
            cleanupTerminalRunWorkspaces(this.store, runId, "failed", at);
            this.secrets?.wipe(runId);
            finish(() => reject(hostErr));
            return;
          }
          // A host-side fault (e.g. injected crash) — leave the run resumable and
          // tear down; the pending row written before the fault drives re-execution.
          this.store.appendEvent(
            runId,
            "run.aborted",
            { name: "HostFault", message: String(hostErr) },
            this.host.clock(),
          );
          finish(() => reject(hostErr));
        }
      };

      worker.onerror = (e: ErrorEvent) => {
        if (this.isRunInterrupted(runId)) {
          finishInterrupted();
          return;
        }
        finish(() => reject(new Error(`realm worker error: ${e.message}`)));
      };
    });
  }
}

function rebuildError(e: { name: string; message: string }): Error {
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}

function redactInterruptionReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const redacted = redactCapabilityTokens(reason).trim();
  return redacted.length > 0 ? redacted : undefined;
}

function serializeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}

function readSourceSafe(workflowUrl: string): string | null {
  try {
    const path = workflowUrl.startsWith("file:") ? new URL(workflowUrl).pathname : workflowUrl;
    return readFileSync(path, "utf8");
  } catch {
    return null; // not a readable file (e.g. a bare module id) — skip the lint
  }
}
