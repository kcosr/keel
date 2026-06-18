import { describe, expect, test } from "bun:test";
import { parseWorkflowSource } from "./workflow-flow-extract.ts";

describe("workflow flow extraction", () => {
  test("ignores ctx calls in helpers outside the default workflow entry", () => {
    const source = `
      function helper(ctx, input) {
        ctx.step("dead-helper", async () => input.dead ?? true);
      }

      export default async function workflow(ctx, input: { live: string }) {
        await ctx.step("live-step", async () => input.live);
      }
    `;

    const ir = parseWorkflowSource("entry-only.workflow.ts", source);

    expect(ir.operations.map((op) => op.key?.value)).toEqual(["live-step"]);
    expect(ir.input?.fields.map((field) => field.name)).toEqual(["live"]);
  });

  test("annotates literal Promise.all array elements as deterministic parallel lanes", () => {
    const source = `
      export default async function workflow(ctx) {
        await Promise.all([
          (async () => {
            await ctx.agent({ key: "proposal", prompt: "write proposal" });
            await ctx.human({ key: "approve-proposal", prompt: "approve proposal" });
            await ctx.step("proposal-approved", async () => true);
          })(),
          (async () => {
            await ctx.agent({ key: "review", prompt: "review proposal" });
            await ctx.human({ key: "approve-review", prompt: "approve review" });
            await ctx.step("review-approved", async () => true);
          })(),
        ]);
      }
    `;

    const ir = parseWorkflowSource("lane.workflow.ts", source);
    const keyed = ir.operations.map((op) => ({
      key: op.key?.value,
      kind: op.kind,
      parallelLane: op.parallelLane,
    }));

    expect(keyed).toEqual([
      { key: "proposal", kind: "agent", parallelLane: 0 },
      { key: "approve-proposal", kind: "human", parallelLane: 0 },
      { key: "proposal-approved", kind: "step", parallelLane: 0 },
      { key: "review", kind: "agent", parallelLane: 1 },
      { key: "approve-review", kind: "human", parallelLane: 1 },
      { key: "review-approved", kind: "step", parallelLane: 1 },
    ]);
  });

  test("leaves dynamic Promise.all fan-outs without lane metadata", () => {
    const source = `
      export default async function workflow(ctx) {
        await Promise.all(["a", "b"].map((name) => ctx.step(name, async () => name)));
      }
    `;

    const ir = parseWorkflowSource("map.workflow.ts", source);

    expect(ir.operations).toHaveLength(1);
    expect(ir.operations[0]?.containers).toContain("parallel");
    expect(ir.operations[0]?.parallelLane).toBeUndefined();
  });
});
