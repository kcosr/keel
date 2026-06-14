// Trusted-local secret side channel: named refs are injected as provider env, while
// agent outputs/events/errors are journaled as ordinary data.

import { describe, expect, test } from "bun:test";
import { SecretStore } from "../../agents/secrets.ts";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
} from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const url = captureWorkflowFile(new URL("./fixtures/secret.workflow.ts", import.meta.url).pathname);

/** A provider that echoes whatever secret env it was injected with. */
const echoProvider: AgentProvider = {
  name: "mock",
  async generate(inv: AgentInvocation): Promise<AgentResult> {
    return { text: `the token is ${inv.env?.TOKEN ?? "<none>"}`, transcript: [] };
  },
};

const SESSION_SECRET_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string> {
      const primary = ctx.agentSession({
        key: "primary",
        provider: "session",
        capabilities: { fs: "workspace-write", shell: true },
        allowTools: ["mcp__local__edit"],
        secrets: ["TOKEN"],
      });
      return await primary.turn({ key: "draft", prompt: "draft" });
    }
  `,
  name: "session-secret",
};

const TOLERATED_FAILURE_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string> {
      const value = await ctx.agent({
        key: "maybe",
        prompt: "p",
        provider: "mock",
        secrets: ["TOKEN"],
        onFailure: "null",
        maxRetries: 0,
      });
      return value === null ? "tolerated" : String(value);
    }
  `,
  name: "tolerated-secret",
};

describe("trusted-local secrets side-channel", () => {
  test("an injected secret can appear in output and journal rows without exact-value redaction", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "sup3r-s3cret-value");

    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(echoProvider),
      secrets,
    });
    const handle = await kernel.run<string>(url, null, { name: "leak", target: process.cwd() });

    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("the token is sup3r-s3cret-value");

    const row = store.getJournalRow("r", "leak", 1);
    expect(JSON.stringify(row)).toContain("sup3r-s3cret-value");
    const all = JSON.stringify(store.listJournalRows("r")) + JSON.stringify(store.listEvents("r"));
    expect(all).toContain("sup3r-s3cret-value");
    expect(all).not.toContain("«redacted»");
    expect(store.listEvents("r").some((e) => e.type === "agent.redacted")).toBe(false);
  });

  test("ctx.agentSession with secrets and write/shell/native tools receives secret env", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "session-secret-value");
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "session",
      supportsSessions: true,
      async generate(inv: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
        invocation = inv;
        const token = inv.resumeToken ?? "sess-1";
        hooks.onSessionToken?.(token);
        return { text: `session saw ${inv.env?.TOKEN}`, transcript: [], sessionToken: token };
      },
    };

    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      secrets,
    });
    const handle = await kernel.run<string>(SESSION_SECRET_WORKFLOW, null, {
      target: process.cwd(),
    });

    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("session saw session-secret-value");
    expect(invocation?.env?.TOKEN).toBe("session-secret-value");
    expect(invocation?.capabilities?.fs).toBe("workspace-write");
    expect(invocation?.capabilities?.shell).toBe(true);
    expect(invocation?.allowTools).toContain("mcp__local__edit");
  });

  test("tolerated failure payloads containing a secret are journaled without redaction", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "failure-secret-value");
    const provider: AgentProvider = {
      name: "mock",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        throw new Error(`provider failed with ${inv.env?.TOKEN}`);
      },
    };

    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      secrets,
    });
    const handle = await kernel.run<string>(TOLERATED_FAILURE_WORKFLOW, null, {
      target: process.cwd(),
    });

    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("tolerated");
    const tolerated = store
      .listEvents("r")
      .find((event) => event.type === "agent.tolerated_failure");
    expect(tolerated?.payloadJson).toContain("failure-secret-value");
    expect(tolerated?.payloadJson).not.toContain("«redacted»");
  });
});
