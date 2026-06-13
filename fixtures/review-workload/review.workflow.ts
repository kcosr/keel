// Large fan-out review workload using Keel's ctx API.
//
// The 111-agent shape has 13 subsystem reviewers + 7 cross-cutting lenses,
// dedupes findings in plain code, fans out one adversarial verifier per finding,
// and synthesizes the report. The orchestration body (the `review` function plus
// the dedupe/norm/bySeverity helpers) is intentionally kept compact; the
// DOMAINS/LENSES/prompt data below is config, excluded from that count.
//
// Provider and root are inputs: provider "mock" drives CI, and provider "pi"
// drives the gated live rehearsal against a real target.

import type { Ctx } from "../../src/kernel/ctx.ts";
import { jsonSchema, passthrough } from "../../src/kernel/schema.ts";

// ---- schemas ---------------------------------------------------------------

interface Finding {
  title: string;
  category: string;
  severity: string;
  file: string;
  line: string;
  description: string;
  evidence: string;
  recommendation: string;
  confidence: string;
}
interface Verdict {
  is_real: boolean;
  verdict: string;
  adjusted_severity: string;
  reasoning: string;
}

const Findings = jsonSchema<{ findings: Finding[] }>({
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "category", "severity", "file", "line", "description", "evidence", "recommendation", "confidence"],
        properties: {
          title: { type: "string" },
          category: { type: "string", enum: ["bug", "security", "smell", "refactor", "perf", "other"] },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          file: { type: "string" },
          line: { type: "string" },
          description: { type: "string" },
          evidence: { type: "string" },
          recommendation: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
});

const Verdict = jsonSchema<Verdict>({
  type: "object",
  additionalProperties: false,
  required: ["is_real", "verdict", "adjusted_severity", "reasoning"],
  properties: {
    is_real: { type: "boolean" },
    verdict: { type: "string", enum: ["confirmed", "uncertain", "rejected"] },
    adjusted_severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
    reasoning: { type: "string" },
  },
});

const Report = passthrough<string>();

// ---- config (data; excluded from the orchestration line count) ------------

const DOMAIN_LABELS = [
  "ssh-boundary", "http-core", "http-auth", "priv-bootstrap", "container-exec",
  "runtime-pty", "health", "config-core", "config-targets", "gateway-core",
  "gateway-sockets", "agent-supervision", "utilities",
];
const LENS_LABELS = [
  "lens:injection", "lens:authz", "lens:privilege", "lens:fs-safety",
  "lens:concurrency", "lens:resources", "lens:secrets",
];

function domainPrompt(label: string, root: string): string {
  return `Review the ${label} subsystem of the repository at ${root}. Read the files in depth, trace data flow, and report every substantiated bug, security issue, and actionable code smell via the structured schema.`;
}
function lensPrompt(label: string, root: string): string {
  return `Hunt the whole src/ tree of ${root} for the cross-cutting class of problem: ${label}. Trace untrusted inputs to dangerous sinks. Report concrete, substantiated instances via the schema.`;
}
function verifyPrompt(f: Finding, root: string): string {
  return `You are an ADVERSARIAL VERIFIER. Re-read the actual code at ${root}/${f.file} and decide whether this finding is real:\n- title: ${f.title}\n- location: ${f.file}:${f.line}\n- description: ${f.description}\n- evidence: ${f.evidence}\nReturn your verdict via the schema.`;
}
function synthPrompt(confirmed: Finding[]): string {
  return `You are the lead reviewer writing the executive narrative. Below are the CONFIRMED findings as JSON. Write tight Markdown: Executive Summary, Systemic Themes, Prioritized Recommendations.\n\n${JSON.stringify(confirmed.map((f) => ({ title: f.title, severity: f.severity, file: f.file })))}`;
}

// ---- plain-code reducers (part of the orchestration) ----------------------

function norm(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
}
function dedupeByFileAndTitle(raw: Finding[]): { findings: Finding[] } {
  const byKey = new Map<string, Finding>();
  for (const f of raw) {
    const key = `${f.file ?? ""}|${norm(f.title)}`;
    if (!byKey.has(key)) byKey.set(key, f);
  }
  return { findings: [...byKey.values()] };
}
const SEV = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
function bySeverity(a: Finding, b: Finding): number {
  return (SEV[a.severity as keyof typeof SEV] ?? 9) - (SEV[b.severity as keyof typeof SEV] ?? 9);
}

export interface ReviewInput {
  root: string;
  provider?: string;
  /** Override the reviewer set for a budget-scaled rehearsal (default: full). */
  domains?: string[];
  lenses?: string[];
}

// ---- the orchestration (binding acceptance: ~140 lines, plain Promise.all) -

export default async function review(ctx: Ctx, input: ReviewInput) {
  const root = input.root;
  const provider = input.provider ?? "pi";
  const toolPolicy = "read-only" as const;
  const domains = input.domains ?? DOMAIN_LABELS;
  const lenses = input.lenses ?? LENS_LABELS;

  ctx.phase("Review");
  const finders = [
    ...domains.map((label) =>
      ctx.agent({
        key: ctx.stepKey("review", label),
        prompt: domainPrompt(label, root),
        schema: Findings,
        provider,
        toolPolicy,
        onFailure: "null",
        lenient: true,
      }),
    ),
    ...lenses.map((label) =>
      ctx.agent({
        key: label,
        prompt: lensPrompt(label, root),
        schema: Findings,
        provider,
        toolPolicy,
        onFailure: "null",
        lenient: true,
      }),
    ),
  ];
  const raw = (await Promise.all(finders)).filter(Boolean).flatMap((r) => r.findings);
  ctx.log(`collected ${raw.length} raw findings from ${finders.length} reviewers`);

  const deduped = await ctx.step("dedupe", Findings, { raw }, ({ raw }) =>
    dedupeByFileAndTitle(raw),
  );
  ctx.log(`deduped to ${deduped.findings.length} unique findings`);

  ctx.phase("Verify");
  const verified = await Promise.all(
    deduped.findings.map((f) =>
      ctx
        .agent({
          key: ctx.stepKey("verify", `${f.file}|${norm(f.title)}`),
          prompt: verifyPrompt(f, root),
          schema: Verdict,
          provider,
          toolPolicy,
          onFailure: "null",
          lenient: true,
        })
        .then((verdict) => (verdict ? { ...f, verdict } : null)),
    ),
  );
  const confirmed = verified
    .filter((f): f is Finding & { verdict: Verdict } => !!f && f.verdict.is_real && f.verdict.verdict !== "rejected")
    .sort(bySeverity);

  ctx.phase("Synthesize");
  const summary = await ctx.agent({
    key: "synthesize",
    prompt: synthPrompt(confirmed),
    schema: Report,
    provider,
  });

  return {
    summary,
    confirmed,
    stats: { raw: raw.length, deduped: deduped.findings.length, confirmed: confirmed.length },
  };
}
