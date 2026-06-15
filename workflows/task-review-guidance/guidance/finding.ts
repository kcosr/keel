import type { GuidanceFinding, ReviewSeverity } from "./types";

export const FINDING_JSON_SCHEMA_DESCRIPTION =
  'Return JSON: {"status":"clean"|"changes-requested","findings":[{"severity":"critical"|"high"|"medium"|"low","file":"path","line":1,"title":"...","evidence":"...","recommendation":"..."}],"summary":"..."}. Clean reviews must use status "clean" and an empty findings array. Non-clean reviews must use status "changes-requested" and at least one finding.';

const SEVERITIES: ReviewSeverity[] = ["critical", "high", "medium", "low"];

export function renderFindingContract(kind: "code" | "plan"): string {
  const subject = kind === "code" ? "code review" : "plan review";
  return [
    "Reviewer Output Contract",
    `Return one JSON object for this ${subject}.`,
    FINDING_JSON_SCHEMA_DESCRIPTION,
    "Put findings first in severity order: critical, high, medium, then low.",
    "Include file and line when available. Omit them when they are not available; do not invent locations.",
    'Use status "clean" only when there are no findings. Use status "changes-requested" when findings are present.',
    "Each finding must include non-empty title, evidence, and recommendation strings.",
  ].join("\n");
}

export function normalizeFindingForLog(finding: GuidanceFinding): GuidanceFinding {
  const normalized: GuidanceFinding = {
    severity: finding.severity,
    title: finding.title.trim(),
    evidence: finding.evidence.trim(),
    recommendation: finding.recommendation.trim(),
  };
  if (finding.file !== undefined) {
    const file = finding.file.trim();
    if (file.length > 0) normalized.file = file;
  }
  if (finding.line !== undefined) normalized.line = finding.line;
  return normalized;
}

export function validateReviewOutput(value: unknown): {
  status: "clean" | "changes-requested";
  findings: GuidanceFinding[];
  summary: string;
} {
  if (!isRecord(value)) throw new Error("review output must be an object");
  const status = value.status;
  if (status !== "clean" && status !== "changes-requested") {
    throw new Error('review output status must be "clean" or "changes-requested"');
  }
  const summary = requiredString(value.summary, "summary");
  if (!Array.isArray(value.findings)) throw new Error("review output findings must be an array");
  const findings = value.findings.map((item, index) => validateFinding(item, index));
  if (status === "clean" && findings.length !== 0) {
    throw new Error('review output status "clean" requires an empty findings array');
  }
  if (status === "changes-requested" && findings.length === 0) {
    throw new Error('review output status "changes-requested" requires one or more findings');
  }
  return { status, findings, summary };
}

function validateFinding(value: unknown, index: number): GuidanceFinding {
  const path = `findings[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const severity = value.severity;
  if (!isReviewSeverity(severity)) throw new Error(`${path}.severity is invalid`);
  const finding: GuidanceFinding = {
    severity,
    title: requiredString(value.title, `${path}.title`),
    evidence: requiredString(value.evidence, `${path}.evidence`),
    recommendation: requiredString(value.recommendation, `${path}.recommendation`),
  };
  if (value.file !== undefined) {
    if (typeof value.file !== "string") throw new Error(`${path}.file must be a string`);
    const file = value.file.trim();
    if (file.length > 0) finding.file = file;
  }
  if (value.line !== undefined) {
    const line = value.line;
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
      throw new Error(`${path}.line must be a positive integer`);
    }
    finding.line = line;
  }
  return normalizeFindingForLog(finding);
}

function isReviewSeverity(value: unknown): value is ReviewSeverity {
  return typeof value === "string" && SEVERITIES.includes(value as ReviewSeverity);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`review output ${path} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`review output ${path} must be non-empty`);
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
