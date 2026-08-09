import type { Ctx } from "@kcosr/keel";

type OracleInput = {
  question: string;
  context?: string;
  profile?: string;
  reasoning?: string;
  maxTurns?: number;
  signalName?: string;
};

type OracleExchange = {
  turn: number;
  question: string;
  context?: string;
  response: string;
};

const DEFAULT_PROFILE = "claude-fable-5";
const DEFAULT_REASONING = "xhigh";
const DEFAULT_MAX_TURNS = 10;
const HARD_MAX_TURNS = 10;
const DEFAULT_SIGNAL_NAME = "oracle-question";

export default async function oracle(ctx: Ctx, input: OracleInput): Promise<string> {
  const question = requireQuestion(input.question, "Input question");
  const maxTurns = clampTurns(input.maxTurns ?? DEFAULT_MAX_TURNS);
  const signalName = input.signalName?.trim() || DEFAULT_SIGNAL_NAME;
  const target = ctx.run.target;
  const requestedProfile = input.profile?.trim();
  const requestedReasoning = input.reasoning?.trim();

  return await ctx.withWorkspace({ key: "context", mode: "direct", path: target }, async () => {
    const session = ctx.agentSession({
      key: "oracle",
      profile: requestedProfile || DEFAULT_PROFILE,
      ...(requestedReasoning
        ? { reasoning: requestedReasoning }
        : requestedProfile
          ? {}
          : { reasoning: DEFAULT_REASONING }),
      toolPolicy: "read-only",
    });
    const exchanges: OracleExchange[] = [];

    ctx.phase("Oracle consultation 1");
    const initialResponse = await session.turn<string>({
      key: "question-1",
      prompt: initialPrompt(question, input.context, target),
    });
    exchanges.push({
      turn: 1,
      question,
      ...(input.context?.trim() ? { context: input.context.trim() } : {}),
      response: initialResponse,
    });
    ctx.log("oracle.response.1", initialResponse);

    let turn = 2;
    let invalidSignals = 0;
    while (turn <= maxTurns) {
      ctx.phase(`Awaiting oracle question ${turn}`);
      const signal = parseSignal(await ctx.signal<unknown>(signalName));
      if (signal.kind === "done") {
        return transcript(exchanges, "stopped");
      }
      if (signal.kind === "invalid") {
        invalidSignals++;
        ctx.log(`oracle.signal.invalid.${invalidSignals}`, signal.message);
        continue;
      }

      ctx.phase(`Oracle consultation ${turn}`);
      const response = await session.turn<string>({
        key: `question-${turn}`,
        prompt: followupPrompt(signal.question, signal.context),
      });
      exchanges.push({
        turn,
        question: signal.question,
        ...(signal.context?.trim() ? { context: signal.context.trim() } : {}),
        response,
      });
      ctx.log(`oracle.response.${turn}`, response);
      turn++;
    }

    return transcript(exchanges, maxTurns === 1 ? "completed" : "turn limit reached");
  });
}

function initialPrompt(question: string, context: string | undefined, target: string): string {
  return `You are the Oracle, a senior thought partner for difficult technical,
product, and design questions. Give direct, rigorous advice. Identify assumptions,
tradeoffs, risks, and alternatives that materially affect the decision. Distinguish
established facts from inference. The read-only workspace at ${target} is available
for context; inspect relevant files when they would materially improve the answer,
but do not assume the question is about an artifact. Do not modify files. Answer in
clear prose suited to the question; use structure only when it improves the answer.

${context?.trim() ? `Context:\n${context.trim()}\n\n` : ""}Question:
${question}`;
}

function followupPrompt(question: string, context: string | undefined): string {
  return `Continue the same consultation. Use the prior conversation as context,
but reconsider earlier conclusions when this question or context warrants it.

${context?.trim() ? `Additional context:\n${context.trim()}\n\n` : ""}Question:
${question}`;
}

function requireQuestion(value: unknown, label: string): string {
  const question = typeof value === "string" ? value.trim() : "";
  if (!question) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return question;
}

function parseSignal(
  value: unknown,
):
  | { kind: "done" }
  | { kind: "question"; question: string; context?: string }
  | { kind: "invalid"; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", message: "Signal payload must be an object" };
  }

  const payload = value as Record<string, unknown>;
  if (payload.done === true) {
    return { kind: "done" };
  }

  const question = typeof payload.question === "string" ? payload.question.trim() : "";
  if (!question) {
    return {
      kind: "invalid",
      message: "Signal payload requires a non-empty question unless done is true",
    };
  }
  if (payload.context !== undefined && typeof payload.context !== "string") {
    return { kind: "invalid", message: "Signal context must be a string when provided" };
  }

  return {
    kind: "question",
    question,
    ...(typeof payload.context === "string" && payload.context.trim()
      ? { context: payload.context.trim() }
      : {}),
  };
}

function clampTurns(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TURNS;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  if (whole > HARD_MAX_TURNS) return HARD_MAX_TURNS;
  return whole;
}

function transcript(exchanges: OracleExchange[], outcome: string): string {
  const sections = exchanges.map((exchange) => {
    const context = exchange.context ? `\n\nContext:\n${exchange.context}` : "";
    return `## Question ${exchange.turn}\n${exchange.question}${context}\n\n## Oracle ${exchange.turn}\n${exchange.response}`;
  });
  return `Oracle consultation ${outcome} after ${exchanges.length} answer(s).\n\n${sections.join("\n\n")}`;
}
