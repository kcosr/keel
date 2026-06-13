// Phase 15: secret never appears in the journal — injected via the side channel,
// redacted from the agent's output at the journal boundary (§11.2).

import { describe, expect, test } from "bun:test";
import { SecretStore } from "../../agents/secrets.ts";
import type { AgentInvocation, AgentProvider, AgentResult } from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { RealmKernel } from "./realm-host.ts";

const url = new URL("./fixtures/secret.workflow.ts", import.meta.url).pathname;

/** A provider that echoes whatever secret env it was injected with. */
const echoProvider: AgentProvider = {
  name: "mock",
  async generate(inv: AgentInvocation): Promise<AgentResult> {
    return { text: `the token is ${inv.env?.TOKEN ?? "<none>"}`, transcript: [] };
  },
};

describe("secrets side-channel + journal redaction", () => {
  test("an injected secret is used by the agent but never lands in the journal", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "sup3r-s3cret-value");

    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(echoProvider),
      secrets,
    });
    const handle = await kernel.run<string>(url, null, { name: "leak" });

    expect(handle.status).toBe("finished");
    // the agent DID receive the secret (proving injection)…
    expect(handle.output).toContain("the token is");
    // …but the secret VALUE is redacted everywhere it's recorded.
    expect(handle.output).not.toContain("sup3r-s3cret-value");
    expect(handle.output).toContain("«redacted»");

    const row = store.getJournalRow("r", "leak", 1);
    expect(JSON.stringify(row)).not.toContain("sup3r-s3cret-value");
    // scan the entire journal (events + rows) for the secret
    const all = JSON.stringify(store.listJournalRows("r")) + JSON.stringify(store.listEvents("r"));
    expect(all).not.toContain("sup3r-s3cret-value");
    // a redaction was recorded
    expect(store.listEvents("r").some((e) => e.type === "agent.redacted")).toBe(true);
  });
});
