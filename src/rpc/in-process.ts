// In-process implementation of the Keel RPC contract (Phase 11).
//
// Backed directly by a RealmKernel + JournalStore. The Phase 12 daemon will wrap
// this same logic behind a Unix socket; clients see the identical KeelApi.

import { existsSync } from "node:fs";
import {
  type AgentProfileView,
  agentProfileConfigHash,
  assertValidAgentProfileName,
  checkAgentProfileConfig,
  compareAgentProfileNames,
  normalizeAgentProfileConfig,
} from "../agents/profiles.ts";
import type { AgentProviderRegistry } from "../agents/types.ts";
import { canonicalJson } from "../hash.ts";
import type { JournalStore } from "../journal/store.ts";
import type { AgentProfileCatalogRow, AgentWorkspaceRow, RunStatus } from "../journal/types.ts";
import type { RealmKernel, RunHandle } from "../kernel/realm/realm-host.ts";
import {
  assertValidSettingWrite,
  canonicalSettingValueJson,
  effectiveOperationalSettings,
  getSettingDefinition,
  settingViewByKey,
  settingViews,
  validateSettingWrite,
} from "../settings/catalog.ts";
import type { SettingView, SettingsDiagnostic } from "../settings/catalog.ts";
import { requireRunTarget } from "../target.ts";
import {
  DEFAULT_WORKFLOW_DEFINITION_TTL_MS,
  createWorkflowDefinitionSnapshot,
  evictWorkflowDefinitionCache,
  materializeWorkflowDefinition,
  snapshotWorkflowSource,
} from "../workflow-definitions/snapshot.ts";
import type { WorkflowSourceInput } from "../workflow-definitions/source.ts";
import { cleanupTerminalRunWorkspaces } from "../workspace/retention.ts";
import {
  diffCopyWorkspace,
  diffGitFinalTree,
  mergeCloneIntoTarget,
  mergeCopyIntoSource,
  removeManagedWorkspace,
} from "../workspace/worktree.ts";
import type {
  EventEnvelope,
  KeelApi,
  LaunchRequest,
  LaunchSavedWorkflowRequest,
  PutScheduleRequest,
  RunOutcome,
  RunStart,
  RunWorkspaceDiff,
  RunWorkspaceView,
  SaveWorkflowRequest,
  SavedWorkflowSourceView,
  WorkflowProvenance,
  WorkspaceGcResult,
} from "./contract.ts";
import { EventHub } from "./event-hub.ts";
import {
  type Blockage,
  type RunProjection,
  type RunReport,
  type RunSummary,
  buildProjection,
  buildRunReport,
  getBlockage,
  listRunSummaries,
} from "./projection.ts";

const WORKSPACE_RECONCILE_STALE_MS = 30_000;
const WORKSPACE_MERGEABLE_STATUSES = new Set<AgentWorkspaceRow["status"]>([
  "pending_review",
  "diff_error",
]);
const WORKSPACE_DISCARDABLE_STATUSES = new Set<AgentWorkspaceRow["status"]>([
  "pending_review",
  "diff_error",
  "cleanup_error",
  "abandoned",
]);

export class InProcessKeel implements KeelApi {
  private readonly running = new Map<string, Promise<RunHandle<unknown>>>();
  private readonly unsubscribeStoreEvents: () => void;

  constructor(
    private readonly kernel: RealmKernel,
    private readonly store: JournalStore,
    private readonly eventHub: EventHub = new EventHub(),
    private readonly opts: { agents?: AgentProviderRegistry; clock?: () => number } = {},
  ) {
    this.kernel.setLiveEventSink((runId, type, payload, atMs) =>
      this.eventHub.publishEphemeral(runId, type, payload, atMs),
    );
    this.unsubscribeStoreEvents = this.store.onEventAppended((event) =>
      this.eventHub.publishDurable(event),
    );
  }

  async launchRun(req: LaunchRequest): Promise<{ runId: string }> {
    const target = requireRunTarget(req.target, "launchRun");
    const { runId, done } = this.kernel.launch(
      {
        source: req.source,
        name: req.name ?? null,
        provenance: req.provenance,
      },
      req.input,
      { target },
    );
    this.running.set(
      runId,
      done.catch((err) => ({ runId, status: "failed", output: undefined }) as RunHandle<unknown>),
    );
    return { runId };
  }

  saveWorkflow(req: SaveWorkflowRequest) {
    const at = this.opts.clock?.() ?? Date.now();
    const snapshot = createWorkflowDefinitionSnapshot(req.source, {
      name: req.workflowName ?? req.name,
      nowMs: at,
    });
    return this.store.putSavedWorkflowVersion({
      name: req.name,
      ...(req.version !== undefined ? { version: req.version } : {}),
      definition: {
        hash: snapshot.hash,
        name: snapshot.name,
        kind: snapshot.kind,
        code: snapshot.code,
        sourceMap: null,
        manifestJson: canonicalJson(snapshot.manifest),
        createdAtMs: at,
      },
      workflowName: req.workflowName ?? null,
      title: req.title ?? null,
      description: req.description ?? null,
      ...(req.tags !== undefined ? { tags: req.tags } : {}),
      ...(req.inputSchema !== undefined ? { inputSchema: req.inputSchema } : {}),
      ...(req.defaultInput !== undefined ? { defaultInput: req.defaultInput } : {}),
      defaultTarget: req.defaultTarget ?? null,
      ...(req.metadata !== undefined ? { metadata: req.metadata } : {}),
      ...(req.provenance !== undefined ? { sourceProvenance: req.provenance } : {}),
      createdAtMs: at,
      allowDuplicateDefinition: req.allowDuplicateDefinition ?? false,
    });
  }

  listSavedWorkflows(opts: Parameters<KeelApi["listSavedWorkflows"]>[0] = {}) {
    return this.store.listSavedWorkflows(opts);
  }

  getSavedWorkflow(name: string) {
    return this.store.getSavedWorkflow(name);
  }

  getSavedWorkflowSource(req: {
    name: string;
    version?: number | "latest";
    file?: string;
    all?: boolean;
    allowDeprecated?: boolean;
  }): SavedWorkflowSourceView {
    const workflow = this.store.getSavedWorkflow(req.name);
    if (!workflow || workflow.deletedAtMs !== null) {
      throw new Error(`saved workflow "${req.name}" does not exist`);
    }
    const version =
      typeof req.version === "number"
        ? this.store.getSavedWorkflowVersion(req.name, req.version)
        : (workflow.versions.find((candidate) => candidate.deletedAtMs === null) ?? null);
    if (!version || version.deletedAtMs !== null) {
      throw new Error(`saved workflow "${req.name}" has no matching version`);
    }
    const definition = this.store.getWorkflowDefinition(version.definitionHash);
    if (!definition)
      throw new Error(`workflow definition ${version.definitionHash} does not exist`);
    const manifest = definition.manifestJson
      ? (JSON.parse(definition.manifestJson) as {
          entry?: unknown;
          modules?: Array<{ path?: unknown; code?: unknown }>;
        })
      : null;
    let entry = "entry.ts";
    let files: Array<{ path: string; code: string; entry: boolean }>;
    if (manifest?.modules && Array.isArray(manifest.modules)) {
      if (manifest.modules.length === 0) {
        files = [{ path: "entry.ts", code: definition.code, entry: true }];
      } else if (typeof manifest.entry !== "string") {
        throw new Error(`workflow definition ${definition.hash} is missing manifest entry`);
      } else {
        entry = manifest.entry;
        files = manifest.modules.map((module) => {
          if (typeof module.path !== "string" || typeof module.code !== "string") {
            throw new Error(`workflow definition ${definition.hash} has invalid source module`);
          }
          return { path: module.path, code: module.code, entry: module.path === entry };
        });
      }
    } else if (definition.code) {
      files = [{ path: "entry.ts", code: definition.code, entry: true }];
    } else {
      throw new Error(`workflow definition ${definition.hash} cannot display source`);
    }
    if (req.file) {
      const file = files.find((candidate) => candidate.path === req.file);
      if (!file) throw new Error(`workflow source file ${req.file} does not exist`);
      files = [file];
    } else if (!req.all) {
      files = [files.find((candidate) => candidate.entry) ?? (files[0] as (typeof files)[number])];
    }
    return {
      name: version.name,
      version: version.version,
      definitionHash: version.definitionHash,
      entry,
      files,
    };
  }

  async launchSavedWorkflow(req: LaunchSavedWorkflowRequest): Promise<{ runId: string }> {
    const saved = this.store.resolveSavedWorkflowRef(req.ref);
    const target = requireRunTarget(req.target ?? saved.defaultTarget, "launchSavedWorkflow");
    const input =
      req.input !== undefined ? req.input : saved.defaultInputSet ? saved.defaultInput : {};
    const name = req.name ?? saved.workflowName ?? saved.name;
    const { runId, done } = this.kernel.launchDefinition(saved.definitionHash, input, {
      name,
      workflowRef: `saved:${saved.name}@${saved.version} ${saved.definitionHash}`,
      target,
    });
    this.running.set(
      runId,
      done.catch((err) => ({ runId, status: "failed", output: undefined }) as RunHandle<unknown>),
    );
    return { runId };
  }

  setSavedWorkflowDisabled(name: string, disabled: boolean) {
    return this.store.setSavedWorkflowDisabled(name, disabled, this.opts.clock?.() ?? Date.now());
  }

  setSavedWorkflowVersionEnabled(name: string, version: number, enabled: boolean) {
    return this.store.setSavedWorkflowVersionEnabled(name, version, enabled);
  }

  deprecateSavedWorkflowVersion(req: { name: string; version: number; message?: string | null }) {
    return this.store.deprecateSavedWorkflowVersion(
      req.name,
      req.version,
      req.message,
      this.opts.clock?.() ?? Date.now(),
    );
  }

  deleteSavedWorkflow(name: string) {
    return this.store.deleteSavedWorkflow(name, this.opts.clock?.() ?? Date.now());
  }

  deleteSavedWorkflowVersion(name: string, version: number) {
    return this.store.deleteSavedWorkflowVersion(name, version, this.opts.clock?.() ?? Date.now());
  }

  putSchedule(req: PutScheduleRequest): { ok: boolean } {
    const hasSource = "source" in req && req.source !== undefined;
    const hasSavedRef = "savedRef" in req && req.savedRef !== undefined;
    if (hasSource === hasSavedRef) {
      throw new Error("putSchedule requires exactly one of source or savedRef");
    }
    let workflowRef: string;
    let defaultTarget: string | null = null;
    if (hasSavedRef) {
      if ("workflowName" in req && req.workflowName !== undefined) {
        throw new Error("putSchedule workflowName is only valid with source");
      }
      const saved = this.store.resolveSavedWorkflowRef(req.savedRef);
      materializeWorkflowDefinition(this.store, saved.definitionHash);
      workflowRef = saved.definitionHash;
      defaultTarget = saved.defaultTarget;
    } else {
      const snapshot = snapshotWorkflowSource(this.store, req.source, {
        name: req.workflowName ?? req.name,
        nowMs: this.opts.clock?.() ?? Date.now(),
      }).snapshot;
      workflowRef = snapshot.hash;
    }
    const target = requireRunTarget(req.target ?? defaultTarget, "putSchedule");
    this.store.putSchedule({
      name: req.name,
      workflowRef,
      inputJson: req.input != null ? JSON.stringify(req.input) : null,
      scheduleTarget: target,
      intervalMs: req.intervalMs,
      nextFireMs: req.firstFireMs ?? this.opts.clock?.() ?? Date.now(),
    });
    return { ok: true };
  }

  async resumeRun(runId: string): Promise<RunStart> {
    this.start(this.kernel.startResume<unknown>(runId));
    return this.started(runId);
  }

  async interruptRun(
    runId: string,
    reason?: string,
  ): Promise<{ runId: string; status: "interrupted" }> {
    const result = this.kernel.interruptRun(runId, reason);
    this.running.set(runId, Promise.resolve({ runId, status: "interrupted" }));
    return result;
  }

  async rerunRun(
    runId: string,
    opts?: {
      source?: WorkflowSourceInput;
      input?: unknown;
      name?: string | null;
      provenance?: WorkflowProvenance;
    },
  ): Promise<RunStart> {
    this.start(this.kernel.startRerun<unknown>(runId, opts));
    return this.started(runId);
  }

  async retryRun(runId: string): Promise<RunStart> {
    this.start(this.kernel.startRetry<unknown>(runId));
    return this.started(runId);
  }

  async rewindRun(runId: string, toStableKey: string): Promise<RunStart> {
    this.start(this.kernel.startRewind<unknown>(runId, toStableKey));
    return this.started(runId);
  }

  forkRun(runId: string, opts: { atStableKey?: string; newRunId?: string }): { runId: string } {
    const newId = this.kernel.fork(runId, opts);
    return { runId: newId };
  }

  getRun(runId: string): RunProjection | null {
    return buildProjection(this.store, runId);
  }

  getRunReport(runId: string): RunReport | null {
    return buildRunReport(this.store, runId);
  }

  getBlockage(runId: string): Blockage {
    return getBlockage(this.store, runId, Date.now());
  }

  listRuns(): RunSummary[] {
    return listRunSummaries(this.store);
  }

  listRunWorkspaces(runId: string, opts: { includeRemoved?: boolean } = {}): RunWorkspaceView[] {
    const runStatus = this.store.getRun(runId)?.status ?? null;
    return this.store.listAgentWorkspaces(runId, opts).map((row) => workspaceView(row, runStatus));
  }

  getRunWorkspace(runId: string, workspaceId: string): RunWorkspaceView | null {
    const row = this.store.getAgentWorkspace(runId, workspaceId);
    return row ? workspaceView(row, this.store.getRun(runId)?.status ?? null) : null;
  }

  getRunWorkspaceDiff(runId: string, workspaceId: string): RunWorkspaceDiff {
    const row = this.requireWorkspace(runId, workspaceId);
    if (!row.owned || row.mode === "direct") {
      throw new Error(`workspace ${runId}/${workspaceId} is direct and does not support diff`);
    }
    if (!existsSync(row.workspacePath)) {
      throw new Error(`workspace ${runId}/${workspaceId} is missing at ${row.workspacePath}`);
    }
    const diff =
      row.mode === "copy"
        ? diffCopyWorkspace(row.workspacePath, row.copyBaselinePath ?? "")
        : row.mode === "clone" || row.mode === "worktree"
          ? diffGitFinalTree(row.workspacePath, row.baseCommit ?? "HEAD")
          : (() => {
              throw new Error(
                `workspace ${runId}/${workspaceId} mode ${row.mode} does not support diff`,
              );
            })();
    return {
      workspace: workspaceView(row, this.store.getRun(runId)?.status ?? null),
      ...diff,
      mode: row.mode as "worktree" | "copy" | "clone",
      diffKind: diff.diffKind ?? "git-patch",
      baseLabel: diff.baseLabel ?? row.baseCommit ?? "HEAD",
      workspaceLabel: diff.workspaceLabel ?? row.workspacePath,
      fileChanges: diff.fileChanges ?? [],
    };
  }

  reconcileWorkspaces(opts: { staleBeforeMs?: number; nowMs?: number } = {}): {
    updated: RunWorkspaceView[];
    deleted: RunWorkspaceView[];
  } {
    const nowMs = opts.nowMs ?? Date.now();
    const staleBeforeMs = opts.staleBeforeMs ?? nowMs - WORKSPACE_RECONCILE_STALE_MS;
    const updated: RunWorkspaceView[] = [];
    const deleted: RunWorkspaceView[] = [];
    for (const row of this.store.listAllAgentWorkspaces()) {
      const run = this.store.getRun(row.runId);
      if (!run || isTerminalRunStatus(run.status)) {
        if (run) cleanupTerminalRunWorkspaces(this.store, row.runId, run.status, nowMs);
        const next = this.store.getAgentWorkspace(row.runId, row.workspaceId);
        if (next && next.updatedAtMs === nowMs) {
          updated.push(workspaceView(next, run?.status ?? null));
        }
        continue;
      }

      const hasLiveOwner =
        run.runtimeOwnerId !== null &&
        run.heartbeatAtMs !== null &&
        run.heartbeatAtMs >= staleBeforeMs;
      if (
        row.owned &&
        row.status === "creating" &&
        !hasLiveOwner &&
        (row.ownerKind !== "agent_session" ||
          !this.store.hasPendingAgentSessionTurn(row.runId, row.key))
      ) {
        if (existsSync(row.workspacePath)) {
          removeManagedWorkspace({
            mode: row.mode as "worktree" | "copy" | "clone",
            sourcePath: row.sourcePath,
            workspacePath: row.workspacePath,
            baseCommit: row.baseCommit,
            copyBaselinePath: row.copyBaselinePath,
          });
        }
        this.store.deleteAgentWorkspace(row.runId, row.workspaceId);
        deleted.push(workspaceView(row, run?.status ?? null));
      }
    }
    return { updated, deleted };
  }

  mergeRunWorkspace(runId: string, workspaceId: string): RunWorkspaceView {
    const row = this.requireWorkspace(runId, workspaceId);
    this.assertWorkspaceOperatorAllowed(row, "merge");
    if (!existsSync(row.workspacePath)) {
      throw new Error(`workspace ${runId}/${workspaceId} is missing at ${row.workspacePath}`);
    }
    if (!row.sourceMergeEligible) {
      throw new Error(`workspace ${runId}/${workspaceId} mode ${row.mode} does not support merge`);
    }
    if (row.mode === "copy") {
      if (!row.copyBaselinePath)
        throw new Error(`copy workspace ${runId}/${workspaceId} has no baseline`);
      if (!row.sourcePath)
        throw new Error(`copy workspace ${runId}/${workspaceId} has no source path`);
      mergeCopyIntoSource(row.workspacePath, row.copyBaselinePath, row.sourcePath);
    } else if (row.mode === "clone") {
      if (!row.sourcePath || !row.baseCommit) {
        throw new Error(
          `clone workspace ${runId}/${workspaceId} cannot be merged without local source and base commit`,
        );
      }
      mergeCloneIntoTarget(row.workspacePath, row.sourcePath, row.baseCommit);
    } else {
      if (!row.sourcePath || !row.baseCommit) {
        throw new Error(
          `worktree workspace ${runId}/${workspaceId} cannot be merged without source and base commit`,
        );
      }
      mergeCloneIntoTarget(row.workspacePath, row.sourcePath, row.baseCommit);
    }
    const at = Date.now();
    this.store.transaction(() => {
      this.store.updateAgentWorkspace(runId, workspaceId, {
        status: "merged",
        mergedAtMs: at,
        updatedAtMs: at,
      });
      this.store.appendEvent(
        runId,
        "workspace.merged",
        {
          workspaceId,
          mode: row.mode,
          ownerKind: row.ownerKind,
          key: row.key,
          workspacePath: row.workspacePath,
          sourcePath: row.sourcePath,
          baseCommit: row.baseCommit,
        },
        at,
      );
    });
    return workspaceView(
      this.requireWorkspace(runId, workspaceId),
      this.store.getRun(runId)?.status ?? null,
    );
  }

  discardRunWorkspace(runId: string, workspaceId: string): RunWorkspaceView {
    const row = this.requireWorkspace(runId, workspaceId);
    this.assertWorkspaceOperatorAllowed(row, "discard");
    removeManagedWorkspace({
      mode: row.mode as "worktree" | "copy" | "clone",
      sourcePath: row.sourcePath,
      workspacePath: row.workspacePath,
      baseCommit: row.baseCommit,
      copyBaselinePath: row.copyBaselinePath,
    });
    const at = Date.now();
    this.store.transaction(() => {
      this.store.updateAgentWorkspace(runId, workspaceId, {
        status: "discarded",
        discardedAtMs: at,
        updatedAtMs: at,
      });
      this.store.appendEvent(
        runId,
        "workspace.discarded",
        {
          workspaceId,
          mode: row.mode,
          ownerKind: row.ownerKind,
          key: row.key,
          workspacePath: row.workspacePath,
          sourcePath: row.sourcePath,
        },
        at,
      );
    });
    return workspaceView(
      this.requireWorkspace(runId, workspaceId),
      this.store.getRun(runId)?.status ?? null,
    );
  }

  gcWorkspaces(
    opts: { olderThanMs?: number; includePending?: boolean; includeRemoved?: boolean } = {},
  ): WorkspaceGcResult {
    const now = Date.now();
    this.reconcileWorkspaces({ nowMs: now });
    const cutoff = now - (opts.olderThanMs ?? 0);
    const statuses = opts.includePending
      ? ([
          "merged",
          "discarded",
          "abandoned",
          "pending_review",
          ...(opts.includeRemoved ? ["removed" as const] : []),
        ] as const)
      : ([
          "merged",
          "discarded",
          "abandoned",
          ...(opts.includeRemoved ? ["removed" as const] : []),
        ] as const);
    const rows = this.store.gcWorkspaceRows([...statuses], cutoff);
    const removed: AgentWorkspaceRow[] = [];
    for (const row of rows) {
      const existed = existsSync(row.workspacePath);
      if (existed) {
        removeManagedWorkspace({
          mode: row.mode as "worktree" | "copy" | "clone",
          sourcePath: row.sourcePath,
          workspacePath: row.workspacePath,
          baseCommit: row.baseCommit,
          copyBaselinePath: row.copyBaselinePath,
        });
        removed.push(row);
      }
      this.store.deleteAgentWorkspace(row.runId, row.workspaceId);
    }
    return {
      removed: removed.map((row) =>
        workspaceView(row, this.store.getRun(row.runId)?.status ?? null),
      ),
    };
  }

  listAgentProfiles(
    opts: { source?: "all" | "catalog" | "programmatic" } = {},
  ): AgentProfileView[] {
    const source = opts.source ?? "all";
    const views: AgentProfileView[] = [];
    if (source === "all" || source === "programmatic") {
      for (const [name, config] of Object.entries(this.kernel.getProgrammaticAgentProfiles())) {
        views.push({
          name,
          source: "programmatic",
          config,
          configHash: agentProfileConfigHash(config),
          generation: null,
          createdAtMs: null,
          updatedAtMs: null,
        });
      }
    }
    if (source === "all" || source === "catalog") {
      for (const row of this.store.listAgentProfileCatalogRows()) views.push(catalogRowView(row));
    }
    return views.sort(
      (a, b) =>
        compareAgentProfileNames(a.name, b.name) ||
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
    );
  }

  getAgentProfile(name: string): AgentProfileView | null {
    assertValidAgentProfileName(name);
    const programmatic = this.kernel.getProgrammaticAgentProfiles()[name];
    if (programmatic) {
      return {
        name,
        source: "programmatic",
        config: programmatic,
        configHash: agentProfileConfigHash(programmatic),
        generation: null,
        createdAtMs: null,
        updatedAtMs: null,
      };
    }
    const row = this.store.getAgentProfileCatalogRow(name);
    return row ? catalogRowView(row) : null;
  }

  putAgentProfile(req: {
    name: string;
    config: unknown;
    ifGeneration?: number;
    createOnly?: boolean;
    updateOnly?: boolean;
  }): AgentProfileView {
    assertValidAgentProfileName(req.name);
    if (req.createOnly && req.updateOnly)
      throw new Error("createOnly and updateOnly are mutually exclusive");
    if (req.createOnly && req.ifGeneration !== undefined) {
      throw new Error("createOnly cannot be combined with ifGeneration");
    }
    if (this.kernel.getProgrammaticAgentProfiles()[req.name]) {
      throw new Error(`agent profile "${req.name}" is programmatic`);
    }
    const config = normalizeAgentProfileConfig(req.config, {
      path: `profile.${req.name}`,
      providerRegistry: this.opts.agents,
    });
    const configJson = canonicalJson(config);
    const row = this.store.putAgentProfileCatalogRow({
      name: req.name,
      configJson,
      configHash: agentProfileConfigHash(config),
      nowMs: (this.opts.clock ?? Date.now)(),
      ...(req.ifGeneration !== undefined ? { ifGeneration: req.ifGeneration } : {}),
      ...(req.createOnly ? { createOnly: true } : {}),
      ...(req.updateOnly ? { updateOnly: true } : {}),
    });
    return catalogRowView(row);
  }

  deleteAgentProfile(req: { name: string; ifGeneration?: number }): {
    name: string;
    deleted: true;
  } {
    assertValidAgentProfileName(req.name);
    if (this.kernel.getProgrammaticAgentProfiles()[req.name]) {
      throw new Error(`agent profile "${req.name}" is programmatic`);
    }
    const deleted = this.store.deleteAgentProfileCatalogRow(req.name, req.ifGeneration);
    if (!deleted) throw new Error(`agent profile "${req.name}" does not exist`);
    return { name: req.name, deleted: true };
  }

  checkAgentProfile(req: { name?: string; config?: unknown; connect?: boolean }): ReturnType<
    typeof checkAgentProfileConfig
  > {
    const hasName = req.name !== undefined;
    const hasConfig = req.config !== undefined;
    if (hasName === hasConfig) {
      throw new Error("checkAgentProfile requires exactly one of name or config");
    }
    if (hasName) {
      const view = this.getAgentProfile(req.name as string);
      if (!view) throw new Error(`agent profile "${req.name}" does not exist`);
      return checkAgentProfileConfig(view.config, {
        path: `profile.${view.name}`,
        providerRegistry: this.opts.agents,
        connect: req.connect === true,
      });
    }
    return checkAgentProfileConfig(req.config, {
      path: "profile",
      providerRegistry: this.opts.agents,
      connect: req.connect === true,
    });
  }

  listSettings(): SettingView[] {
    return settingViews(this.store.listDaemonSettingRows());
  }

  getSetting(key: string): SettingView | null {
    return settingViewByKey(key, this.store.listDaemonSettingRows());
  }

  putSetting(req: { key: string; value: unknown; ifGeneration?: number }): SettingView {
    assertValidSettingWrite(req.key, req.value);
    const valueJson = canonicalSettingValueJson(req.key, req.value);
    const row = this.store.putDaemonSettingRow({
      key: req.key,
      valueJson,
      nowMs: (this.opts.clock ?? Date.now)(),
      ...(req.ifGeneration !== undefined ? { ifGeneration: req.ifGeneration } : {}),
    });
    const view = settingViewByKey(row.key, [row]);
    if (!view) throw new Error(`setting "${row.key}" was not saved`);
    return view;
  }

  deleteSetting(req: { key: string; ifGeneration?: number }): { key: string; deleted: boolean } {
    const definition = getSettingDefinition(req.key);
    if (!definition) throw new Error(`unknown setting "${req.key}"`);
    if (definition.readOnly) throw new Error(`setting "${req.key}" is read-only`);
    return {
      key: req.key,
      deleted: this.store.deleteDaemonSettingRow(req.key, req.ifGeneration),
    };
  }

  checkSetting(req: { key: string; value: unknown }): {
    ok: boolean;
    diagnostics: SettingsDiagnostic[];
  } {
    const diagnostics = validateSettingWrite(req.key, req.value);
    return {
      ok: !diagnostics.some((diagnostic) => diagnostic.level === "error"),
      diagnostics,
    };
  }

  async waitForRun(runId: string): Promise<RunOutcome> {
    const pending = this.running.get(runId);
    if (pending) {
      const handle = await pending;
      return this.outcome(runId, handle);
    }
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return {
      runId,
      status: run.status,
      output: run.outputRef ? JSON.parse(run.outputRef) : undefined,
      error: run.errorJson ? JSON.parse(run.errorJson) : null,
    };
  }

  async getRunOutput(runId: string): Promise<RunOutcome> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return {
      runId,
      status: run.status,
      output: run.outputRef ? JSON.parse(run.outputRef) : undefined,
      error: run.errorJson ? JSON.parse(run.errorJson) : null,
    };
  }

  async gcDefinitions(opts: { ttlMs?: number; cacheMinAgeMs?: number } = {}): Promise<{
    workflowDefinitionsRemoved: number;
    definitionCacheEntriesRemoved: number;
  }> {
    const nowMs = Date.now();
    const operational = effectiveOperationalSettings(this.store.listDaemonSettingRows());
    const workflowDefinitionsRemoved = this.store.pruneWorkflowDefinitions({
      nowMs,
      ttlMs: opts.ttlMs ?? operational.workflowDefinitionGcTtlMs,
    });
    const definitionCacheEntriesRemoved = evictWorkflowDefinitionCache(this.store, {
      nowMs,
      minAgeMs: opts.cacheMinAgeMs ?? 0,
    });
    return { workflowDefinitionsRemoved, definitionCacheEntriesRemoved };
  }

  subscribeEvents(
    runId: string,
    afterSeq: number,
    onEvent: (event: EventEnvelope) => void,
  ): () => void {
    return this.eventHub.subscribe(this.store, runId, afterSeq, onEvent);
  }

  close(): void {
    this.unsubscribeStoreEvents();
  }

  private start(handle: { runId: string; done: Promise<RunHandle<unknown>> }): void {
    this.running.set(
      handle.runId,
      handle.done.catch(
        (err) =>
          ({ runId: handle.runId, status: "failed", output: undefined }) as RunHandle<unknown>,
      ),
    );
  }

  private started(runId: string): RunStart {
    const status = this.store.getRun(runId)?.status ?? "running";
    return { runId, status };
  }

  private outcome(runId: string, handle: RunHandle<unknown>): RunOutcome {
    const run = this.store.getRun(runId);
    return {
      runId,
      status: handle.status,
      output: handle.output,
      error: run?.errorJson ? JSON.parse(run.errorJson) : null,
    };
  }

  private requireWorkspace(runId: string, workspaceId: string) {
    const row = this.store.getAgentWorkspace(runId, workspaceId);
    if (!row) throw new Error(`workspace ${runId}/${workspaceId} not found`);
    return row;
  }

  private assertWorkspaceOperatorAllowed(
    row: AgentWorkspaceRow,
    operation: "merge" | "discard",
  ): void {
    const run = this.store.getRun(row.runId);
    if (!run) throw new Error(`run ${row.runId} not found`);
    if (!["finished", "failed", "cancelled", "continued"].includes(run.status)) {
      throw new Error(
        `cannot ${operation} workspace ${row.runId}/${row.workspaceId} while run is ${run.status}`,
      );
    }
    if (!row.owned || row.mode === "direct") {
      throw new Error(`cannot ${operation} direct workspace ${row.runId}/${row.workspaceId}`);
    }
    if (row.activeHolderKind) {
      throw new Error(
        `cannot ${operation} workspace ${row.runId}/${row.workspaceId} while it is active`,
      );
    }
    const session =
      row.ownerKind === "agent_session" ? this.store.getAgentSession(row.runId, row.key) : null;
    if (session?.activeTurnKey) {
      throw new Error(
        `cannot ${operation} workspace ${row.runId}/${row.workspaceId} while a turn is active`,
      );
    }
    const allowedStatuses =
      operation === "merge" ? WORKSPACE_MERGEABLE_STATUSES : WORKSPACE_DISCARDABLE_STATUSES;
    if (!allowedStatuses.has(row.status)) {
      throw new Error(
        `cannot ${operation} workspace ${row.runId}/${row.workspaceId} with status ${row.status}`,
      );
    }
  }
}

function catalogRowView(row: AgentProfileCatalogRow): AgentProfileView {
  return {
    name: row.name,
    source: "catalog",
    config: JSON.parse(row.configJson),
    configHash: row.configHash,
    generation: row.generation,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "finished" || status === "failed" || status === "cancelled" || status === "continued"
  );
}

function workspaceView(row: AgentWorkspaceRow, runStatus: RunStatus | null): RunWorkspaceView {
  const mergeSupported =
    runStatus !== null &&
    isTerminalRunStatus(runStatus) &&
    row.owned &&
    row.sourceMergeEligible &&
    WORKSPACE_MERGEABLE_STATUSES.has(row.status) &&
    !row.activeHolderKind;
  return {
    runId: row.runId,
    workspaceId: row.workspaceId,
    mode: row.mode,
    ownerKind: row.ownerKind,
    key: row.key,
    lastAttempt: row.lastAttempt,
    retentionPolicy: row.retentionPolicy,
    workspacePath: row.workspacePath,
    sourceKind: row.sourceKind,
    sourcePath: row.sourcePath,
    sourceUri: row.sourceUri,
    sourceBare: row.sourceBare,
    sourceMergeEligible: row.sourceMergeEligible,
    suppliedPath: row.suppliedPath,
    sourceRef: row.sourceRef,
    resolvedRef: row.resolvedRef,
    checkoutBranch: row.checkoutBranch,
    worktreeCheckoutKind: row.worktreeCheckoutKind,
    worktreeBranchOwned: row.worktreeBranchOwned,
    baseCommit: row.baseCommit,
    copyBaselinePath: row.copyBaselinePath,
    owned: row.owned,
    status: row.status,
    failureSeen: row.failureSeen,
    lastTurnKey: row.lastTurnKey,
    lastTurnAttempt: row.lastTurnAttempt,
    activeHolderKind: row.activeHolderKind,
    activeHolderKey: row.activeHolderKey,
    activeHolderAttempt: row.activeHolderAttempt,
    activeStartedAtMs: row.activeStartedAtMs,
    lastDiffEventSeq: row.lastDiffEventSeq,
    lastErrorEventSeq: row.lastErrorEventSeq,
    cleanupError: row.cleanupErrorJson ? JSON.parse(row.cleanupErrorJson) : null,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    mergedAtMs: row.mergedAtMs,
    discardedAtMs: row.discardedAtMs,
    removedAtMs: row.removedAtMs,
    mergeSupported,
    diffSupported: row.owned && row.mode !== "direct" && row.status !== "removed",
  };
}
