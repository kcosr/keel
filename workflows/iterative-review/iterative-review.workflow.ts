import { type Ctx, jsonSchema } from "@kcosr/keel";

type Finding = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  file: string;
  line: number;
  problem: string;
  recommendation: string;
};

type Review = {
  summary: string;
  findings: Finding[];
};

type IterativeReviewInput = {
  repository?: string;
  task: string;
  spec?: string;
  focus?: string;
  reasoning?: string;
  maxRounds?: number;
  signalName?: string;
  stopWhenClean?: boolean;
};

type ReviewCycleSignal = {
  summary: string;
  instructions?: string;
  done?: boolean;
};

type ReviewRound = {
  round: number;
  signal: ReviewCycleSignal;
  review: Review;
};

type ResolvedIterativeReviewInput = IterativeReviewInput & {
  repository: string;
};

const FindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "title", "file", "line", "problem", "recommendation"],
  properties: {
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    title: { type: "string" },
    file: { type: "string" },
    line: { type: "number" },
    problem: { type: "string" },
    recommendation: { type: "string" },
  },
};

const ReviewSchema = jsonSchema<Review>({
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: FindingSchema,
    },
  },
});

const DEFAULT_MAX_ROUNDS = 3;
const HARD_MAX_ROUNDS = 20;
const REVIEWER_PROFILE = "claude-default";

export default async function iterativeReview(
  ctx: Ctx,
  input: IterativeReviewInput,
): Promise<{
  status: "clean" | "stopped" | "max-rounds-reached";
  initial: Review;
  rounds: ReviewRound[];
}> {
  const repository = resolveRepository(input.repository, ctx.run.target);
  const resolvedInput: ResolvedIterativeReviewInput = { ...input, repository };
  const maxRounds = clampRounds(input.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const signalName = input.signalName ?? "review-cycle";
  const stopWhenClean = input.stopWhenClean ?? true;

  return await ctx.withWorkspace(
    { key: "repository", mode: "direct", path: repository },
    async () => {
      const reviewer = ctx.agentSession({
        key: "reviewer",
        profile: REVIEWER_PROFILE,
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        toolPolicy: "read-only",
      });

      ctx.phase("Initial review");
      const initial = await reviewer.turn({
        key: "initial",
        prompt: initialPrompt(resolvedInput),
        schema: ReviewSchema,
        lenient: true,
      });
      ctx.log("review.initial", initial);

      if (stopWhenClean && initial.findings.length === 0) {
        return { status: "clean", initial, rounds: [] };
      }

      const rounds: ReviewRound[] = [];
      for (let round = 1; round <= maxRounds; round++) {
        ctx.phase(`Awaiting review cycle ${round}`);
        const signal = await ctx.signal<ReviewCycleSignal>(signalName);
        if (signal.done === true) {
          return { status: "stopped", initial, rounds };
        }

        ctx.phase(`Follow-up review ${round}`);
        const review = await reviewer.turn({
          key: `followup-${round}`,
          prompt: followupPrompt(resolvedInput, round, signal),
          schema: ReviewSchema,
          lenient: true,
        });
        ctx.log(`review.followup.${round}`, review);

        rounds.push({ round, signal, review });
        if (stopWhenClean && review.findings.length === 0) {
          return { status: "clean", initial, rounds };
        }
      }

      return { status: "max-rounds-reached", initial, rounds };
    },
  );
}

function initialPrompt(input: ResolvedIterativeReviewInput): string {
  return `Review the requested work.

Repository: ${input.repository}
Task: ${input.task}
${input.spec ? `Spec or design reference: ${input.spec}\n` : ""}${input.focus ? `Focus: ${input.focus}\n` : ""}
Read the relevant files and current repository state yourself. Report only concrete,
actionable findings grounded in files and line numbers. If there are no findings,
return an empty findings array.`;
}

function followupPrompt(
  input: ResolvedIterativeReviewInput,
  round: number,
  signal: ReviewCycleSignal,
): string {
  return `Follow-up review cycle ${round}.

Repository: ${input.repository}
Task: ${input.task}
${input.spec ? `Spec or design reference: ${input.spec}\n` : ""}${input.focus ? `Focus: ${input.focus}\n` : ""}
The implementer reports these changes since your prior review:
${signal.summary}
${signal.instructions ? `\nAdditional review instructions:\n${signal.instructions}\n` : ""}
Re-read the relevant files and diff. Verify whether the reported fixes address
the prior findings and look for regressions introduced by the fixes. Return only
remaining or new actionable findings. If there are no findings, return an empty
findings array.`;
}

function clampRounds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  const whole = Math.floor(value);
  if (whole < 0) return 0;
  if (whole > HARD_MAX_ROUNDS) return HARD_MAX_ROUNDS;
  return whole;
}

function resolveRepository(repository: string | undefined, runTarget: string): string {
  return repository && repository.trim().length > 0 ? repository : runTarget;
}
