import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore } from "../../src/journal/store.ts";
import { RealmKernel } from "../../src/kernel/realm/realm-host.ts";
import { captureWorkflowFile } from "../../src/workflow-definitions/capture.ts";
import type { CommandCompletionFixtureOutput } from "./command-completion.fixture.workflow.ts";

const tempRoots: string[] = [];
const fixtureWorkflow = captureWorkflowFile(
  new URL("command-completion.fixture.workflow.ts", import.meta.url).pathname,
);

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function kernel(store: JournalStore): RealmKernel {
  let clock = 1_000;
  return new RealmKernel(store, {
    idgen: () => "run_command_completion_fixture",
    clock: () => clock++,
    rng: () => 0.5,
  });
}

describe("command-completion fixture workflow", () => {
  test("runs a durable command and default completion check", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-completion-fixture-");
    writeFileSync(join(workspace, "README.md"), "fixture\n");

    const result = await kernel(store).run(fixtureWorkflow, { workspace }, { target: workspace });

    expect(result.status).toBe("finished");
    const output = result.output as CommandCompletionFixtureOutput;
    expect(output.command).toMatchObject({
      key: "list-workspace",
      status: "exited",
      exitCode: 0,
      attempt: 1,
    });
    expect(output.command.stdout).toContain("README.md");
    expect(output.completion).toMatchObject({
      attempt: 1,
      status: "passed",
      workspaceId: "fixture-workspace",
      checks: [
        {
          key: "workspace-readable",
          type: "command",
          status: "passed",
        },
      ],
    });
    expect(
      store.getJournalRow("run_command_completion_fixture", "command.list-workspace", 1),
    ).toMatchObject({
      effectType: "command",
      status: "completed",
    });
    expect(
      store.getJournalRow(
        "run_command_completion_fixture",
        "completion-check.1.workspace-readable",
        1,
      ),
    ).toMatchObject({
      effectType: "completion_check",
      status: "completed",
    });
  });
});
