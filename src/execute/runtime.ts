import { resolve } from "node:path";
import type { DaemonClient } from "../daemon/client.ts";
import type { EventEnvelope, RunOutcome, RunStart } from "../rpc/contract.ts";
import type { Blockage, RunProjection } from "../rpc/projection.ts";

export interface ExecuteKeel {
  launch(req: ExecuteLaunchRequest): Promise<ExecuteRunHandle>;
  resume(runId: string): Promise<RunStart>;
  retry(runId: string): Promise<RunStart>;
  rewind(runId: string, toStableKey: string): Promise<RunStart>;
  fork(
    runId: string,
    opts?: { atStableKey?: string; newRunId?: string },
  ): Promise<ExecuteRunHandle>;
  get(runId: string): Promise<RunProjection | null>;
  blockage(runId: string): Promise<Blockage>;
  wait(runId: string, opts?: { timeoutMs?: number }): Promise<RunOutcome | ExecuteRunning>;
  output(runId: string): Promise<unknown>;
  events(runId: string, opts?: { afterSeq?: number }): AsyncIterable<EventEnvelope>;
  signal(runId: string, name: string, payload?: unknown): Promise<{ status: string }>;
  approve(
    runId: string,
    key: string,
    opts?: { note?: string; grantedCaps?: unknown },
  ): Promise<{ status: string }>;
  deny(runId: string, key: string, opts?: { note?: string }): Promise<{ status: string }>;
}

export type ExecuteLaunchRequest =
  | string
  | {
      workflow: string | { kind: "path"; path: string };
      input?: unknown;
      name?: string;
    };

export interface ExecuteRunHandle {
  runId: string;
  capabilityRef?: string;
  capability?: string;
}

export interface ExecuteRunning {
  runId: string;
  status: "running";
  blockage: Blockage;
}

export interface ExecuteRuntimeOptions {
  client: DaemonClient;
  cwd: string;
  args: string[];
  state: unknown;
  env: Record<string, string | undefined>;
  emitCapability?: boolean;
  writeCapability?: (runId: string, capability: string) => string;
}

export interface ExecuteScriptOptions extends ExecuteRuntimeOptions {
  source: string;
  entry?: string;
}

const tsTranspiler = new Bun.Transpiler({ loader: "tsx" });
const AsyncFunction = (async () => {}).constructor as new (
  ...args: string[]
) => (
  keel: ExecuteKeel,
  args: string[],
  state: unknown,
  env: Record<string, string | undefined>,
) => Promise<unknown>;

export async function runExecuteScript(opts: ExecuteScriptOptions): Promise<unknown> {
  const keel = createExecuteKeel(opts);
  const wrapped = opts.entry
    ? `${opts.source}\nasync function __keel_execute__(keel: unknown, args: string[], state: unknown, env: Record<string, string | undefined>) { return await ${opts.entry}({ keel, args, state, env }); }`
    : `async function __keel_execute__(keel: unknown, args: string[], state: unknown, env: Record<string, string | undefined>) {\n${opts.source}\n}`;
  const js = tsTranspiler.transformSync(wrapped);
  const body = `${js}\nreturn await __keel_execute__(keel, args, state, env);`;
  const fn = new AsyncFunction("keel", "args", "state", "env", body);
  return await fn(keel, opts.args, opts.state, opts.env);
}

export function createExecuteKeel(opts: ExecuteRuntimeOptions): ExecuteKeel {
  const runCaps = new Map<string, string>();
  const remember = async (runId: string, capability: string | undefined) => {
    if (!capability) return;
    runCaps.set(runId, capability);
    await opts.client.authenticate(capability);
  };
  const authenticateKnownRun = async (runId: string) => {
    const cap = runCaps.get(runId);
    if (cap) await opts.client.authenticate(cap);
  };
  const handle = async (
    runId: string,
    capability: string | undefined,
  ): Promise<ExecuteRunHandle> => {
    await remember(runId, capability);
    if (!capability) return { runId };
    if (opts.emitCapability) return { runId, capability };
    return { runId, capabilityRef: opts.writeCapability?.(runId, capability) };
  };

  return {
    async launch(req) {
      const normalized = normalizeLaunch(req, opts.cwd);
      const launched = await opts.client.launchRun(normalized);
      return handle(launched.runId, launched.capability);
    },
    async resume(runId) {
      await authenticateKnownRun(runId);
      return opts.client.resumeRun(runId);
    },
    async retry(runId) {
      await authenticateKnownRun(runId);
      return opts.client.retryRun(runId);
    },
    async rewind(runId, toStableKey) {
      await authenticateKnownRun(runId);
      return opts.client.rewindRun(runId, toStableKey);
    },
    async fork(runId, forkOpts = {}) {
      await authenticateKnownRun(runId);
      const forked = await opts.client.forkRun(runId, forkOpts);
      return handle(forked.runId, forked.capability);
    },
    async get(runId) {
      await authenticateKnownRun(runId);
      return opts.client.getRun(runId);
    },
    async blockage(runId) {
      await authenticateKnownRun(runId);
      return opts.client.getBlockage(runId);
    },
    async wait(runId, waitOpts = {}) {
      await authenticateKnownRun(runId);
      if (waitOpts.timeoutMs == null) return opts.client.waitForRun(runId);
      const result = await Promise.race([
        opts.client.waitForRun(runId),
        Bun.sleep(waitOpts.timeoutMs).then(() => null),
      ]);
      if (result) return result;
      return { runId, status: "running", blockage: await opts.client.getBlockage(runId) };
    },
    async output(runId) {
      await authenticateKnownRun(runId);
      const outcome = await opts.client.waitForRun(runId);
      if (outcome.status !== "finished") {
        throw new Error(`run ${runId} has no finished output (status ${outcome.status})`);
      }
      return outcome.output;
    },
    events(runId, eventOpts = {}) {
      return eventIterable(opts.client, runId, eventOpts.afterSeq ?? 0, () =>
        authenticateKnownRun(runId),
      );
    },
    async signal(runId, name, payload = null) {
      await authenticateKnownRun(runId);
      return opts.client.sendSignal(runId, name, payload);
    },
    async approve(runId, key, approveOpts = {}) {
      return opts.client.decideApproval(runId, key, { status: "approved", ...approveOpts });
    },
    async deny(runId, key, denyOpts = {}) {
      return opts.client.decideApproval(runId, key, { status: "denied", ...denyOpts });
    },
  };
}

function normalizeLaunch(
  req: ExecuteLaunchRequest,
  cwd: string,
): {
  workflowUrl: string;
  input: unknown;
  name: string;
} {
  if (typeof req === "string") {
    const workflowUrl = resolve(cwd, req);
    return { workflowUrl, input: {}, name: workflowName(workflowUrl) };
  }
  const workflow = typeof req.workflow === "string" ? req.workflow : req.workflow.path;
  const workflowUrl = resolve(cwd, workflow);
  return {
    workflowUrl,
    input: req.input ?? {},
    name: req.name ?? workflowName(workflowUrl),
  };
}

function workflowName(workflowUrl: string): string {
  return workflowUrl.split(/[\\/]/).at(-1) || "workflow";
}

async function* eventIterable(
  client: DaemonClient,
  runId: string,
  afterSeq: number,
  authenticate: () => Promise<void>,
): AsyncIterable<EventEnvelope> {
  await authenticate();
  const queue: EventEnvelope[] = [];
  let notify: (() => void) | null = null;
  const unsub = client.subscribeEvents(runId, afterSeq, (event) => {
    queue.push(event);
    notify?.();
    notify = null;
  });
  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const event = queue.shift();
      if (!event) continue;
      yield event;
      if (
        event.type === "run.finished" ||
        event.type === "run.failed" ||
        event.type === "run.continued"
      ) {
        return;
      }
    }
  } finally {
    unsub();
  }
}
