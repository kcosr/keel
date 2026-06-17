import { type Ctx, jsonSchema } from "@kcosr/keel";

export type RoutingRole = "implementer" | "reviewer" | "planner" | "summarizer" | "verifier";

export type RoutingTask =
  | "implementation"
  | "implementation-review"
  | "code-review"
  | "plan-review"
  | "docs-review"
  | "debugging"
  | "summarization"
  | "workflow-authoring";

export type RoutingComplexity = "low" | "medium" | "high" | "xhigh";
export type RoutingBudget = "cheap" | "balanced" | "best";

export const ROUTING_SURFACES = [
  "cli",
  "rpc",
  "journal",
  "workflow-sdk",
  "provider-adapter",
  "workspace",
  "web-ui",
  "docs",
  "tests",
  "build",
  "unknown",
] as const;

export type RoutingSurface = (typeof ROUTING_SURFACES)[number];

export const ROUTING_RISKS = [
  "migration",
  "authorization",
  "replay",
  "provider-lifecycle",
  "security",
  "data-loss",
  "concurrency",
  "public-api",
  "accessibility",
  "unknown",
] as const;

export type RoutingRisk = (typeof ROUTING_RISKS)[number];

export interface RoutingInput {
  role: RoutingRole;
  task: RoutingTask;
  complexity?: RoutingComplexity;
  budget?: RoutingBudget;
  surfaces?: RoutingSurface[];
  risks?: RoutingRisk[];
  languages?: string[];
  notes?: string;
}

export interface AgentRoute {
  profile: string;
  reasoning?: string;
  /** Apply to ctx.agent(...) or individual session.turn(...) calls. */
  timeoutMs?: number;
  /** Workflow-owned loop hint. Do not pass to ctx.agent/ctx.agentSession. */
  maxRounds?: number;
  rationale: string;
}

export interface MultiAgentRoute {
  implementer?: AgentRoute;
  reviewer?: AgentRoute;
  complexity: RoutingComplexity;
  surfaces: RoutingSurface[];
  risks: RoutingRisk[];
  /** Workflow-owned loop hint. Do not pass to ctx.agent/ctx.agentSession. */
  maxRounds?: number;
  verification: string[];
  rationale: string;
}

export interface RoutingConstraints {
  /** Profile used by the router agent itself; must be daemon-configured. */
  routerProfile?: string;
  allowedProfiles: string[];
  /** Must be a subset of the active reasoning order. */
  allowedReasoning: string[];
  /** Optional custom order; defaults to ROUTING_REASONING_ORDER. */
  reasoningOrder?: readonly string[];
  maxReasoning: string;
  minReasoning?: string;
  defaultImplementerProfile: string;
  defaultReviewerProfile: string;
  allowToolPolicyEscalation?: false;
}

export interface RouteWithAgentInput {
  /** Stable ctx.agent step key for this routing decision. */
  key: string;
  request: string;
  specPath?: string;
  target: string;
  candidateSurfaces?: RoutingSurface[];
  candidateRisks?: RoutingRisk[];
  constraints: RoutingConstraints;
}

export interface RouterAgentOutput {
  complexity: RoutingComplexity;
  surfaces: RoutingSurface[];
  risks: RoutingRisk[];
  languages: string[];
  implementer: {
    profile: string;
    reasoning: string;
    timeoutMs?: number;
  };
  reviewer: {
    profile: string;
    reasoning: string;
    timeoutMs?: number;
  };
  /** Workflow-loop hint; not an SDK agent/session field. */
  maxRounds?: number;
  /** Workflow-owned verification plan; not enforced by the SDK. */
  verification: string[];
  rationale: string;
}

export interface SanitizeRouteOptions {
  constraints: RoutingConstraints;
  declaredSurfaces?: RoutingSurface[];
  declaredRisks?: RoutingRisk[];
}

type NormalizedConstraints = {
  routerProfile?: string;
  allowedProfiles: string[];
  allowedReasoning: string[];
  activeOrder: readonly string[];
  maxReasoning: string;
  minReasoning?: string;
  defaultImplementerProfile: string;
  defaultReviewerProfile: string;
};

type NormalizedValues<T extends string> = {
  values: T[];
  warnings: string[];
};

const DEFAULT_IMPLEMENTER_PROFILE = "codex-default";
const DEFAULT_REVIEWER_PROFILE = "claude-default";
const DEFAULT_ROUTER_PROFILE = "claude-default";
const DEFAULT_ROUTER_REASONING = "medium";
const DEFAULT_TIMEOUT_MS_BY_REASONING = {
  low: 20 * 60 * 1000,
  medium: 45 * 60 * 1000,
  high: 60 * 60 * 1000,
  xhigh: 90 * 60 * 1000,
} as const satisfies Record<RoutingComplexity, number>;
const DEFAULT_MAX_ROUNDS_BY_REASONING = {
  low: 2,
  medium: 3,
  high: 5,
  xhigh: 7,
} as const satisfies Record<RoutingComplexity, number>;

export const ROUTING_REASONING_ORDER = ["low", "medium", "high", "xhigh"] as const;

export const CRITICAL_REASONING_FLOORS = {
  surfaces: {
    journal: "high",
    rpc: "high",
    "workflow-sdk": "high",
    "provider-adapter": "high",
  },
  risks: {
    migration: "high",
    authorization: "high",
    replay: "high",
    security: "high",
    "data-loss": "xhigh",
    "provider-lifecycle": "high",
  },
} as const;

const ROUTING_COMPLEXITIES = ROUTING_REASONING_ORDER;
const ROUTING_BUDGETS = ["cheap", "balanced", "best"] as const satisfies readonly RoutingBudget[];
const ROUTING_TASKS = [
  "implementation",
  "implementation-review",
  "code-review",
  "plan-review",
  "docs-review",
  "debugging",
  "summarization",
  "workflow-authoring",
] as const satisfies readonly RoutingTask[];
const ROUTING_ROLES = [
  "implementer",
  "reviewer",
  "planner",
  "summarizer",
  "verifier",
] as const satisfies readonly RoutingRole[];

const AgentRouteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "reasoning"],
  properties: {
    profile: { type: "string" },
    reasoning: { type: "string" },
    timeoutMs: { type: "number" },
  },
};

export const RoutingPlanSchema = jsonSchema<RouterAgentOutput>({
  type: "object",
  additionalProperties: false,
  required: [
    "complexity",
    "surfaces",
    "risks",
    "languages",
    "implementer",
    "reviewer",
    "verification",
    "rationale",
  ],
  properties: {
    complexity: { type: "string", enum: [...ROUTING_COMPLEXITIES] },
    surfaces: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    languages: { type: "array", items: { type: "string" } },
    implementer: AgentRouteSchema,
    reviewer: AgentRouteSchema,
    maxRounds: { type: "number" },
    verification: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
});

export function selectModelRoute(input: RoutingInput): AgentRoute {
  validateRoutingInput(input);
  const surfaces = normalizeSurfaces(input.surfaces ?? [], "routing surfaces", "throw").values;
  const risks = normalizeRisks(input.risks ?? [], "routing risks", "throw").values;
  const floor = floorFrom(surfaces, risks, ROUTING_REASONING_ORDER);
  let reasoning = input.complexity ?? defaultReasoningFor(input.role, input.task);

  if (input.budget === "best") {
    reasoning = promoteReasoning(reasoning, ROUTING_REASONING_ORDER);
  } else if (input.budget === "cheap" && reasoning === "xhigh" && floor !== "xhigh") {
    reasoning = "high";
  }

  reasoning = maxReasoning([reasoning, floor], ROUTING_REASONING_ORDER) as RoutingComplexity;

  return {
    profile: defaultProfileFor(input.role),
    reasoning,
    timeoutMs: DEFAULT_TIMEOUT_MS_BY_REASONING[reasoning],
    maxRounds: DEFAULT_MAX_ROUNDS_BY_REASONING[reasoning],
    rationale: staticRouteRationale(input, surfaces, risks, floor, reasoning),
  };
}

export function buildRoutingPrompt(input: RouteWithAgentInput): string {
  const constraints = normalizeConstraints(input.constraints);
  const declaredSurfaces = normalizeSurfaces(
    input.candidateSurfaces ?? [],
    "candidateSurfaces",
    "throw",
  ).values;
  const declaredRisks = normalizeRisks(
    input.candidateRisks ?? [],
    "candidateRisks",
    "throw",
  ).values;
  const specPath = input.specPath?.trim();

  return [
    "You are routing a Keel workflow task to later implementer and reviewer agents.",
    "",
    "Return JSON only matching the provided schema. Do not include markdown.",
    "",
    "Hard bounds:",
    `- Allowed output profiles: ${constraints.allowedProfiles.join(", ")}`,
    `- Allowed output reasoning: ${constraints.allowedReasoning.join(", ")}`,
    `- Maximum output reasoning: ${constraints.maxReasoning}`,
    constraints.minReasoning ? `- Minimum output reasoning: ${constraints.minReasoning}` : null,
    "- You may not choose tool policy, capabilities, secrets, provider config, workspace mode, or workflow source.",
    "- Prefer the default implementer and reviewer profiles unless there is a clear reason within the allowlist.",
    `- Default implementer profile: ${constraints.defaultImplementerProfile}`,
    `- Default reviewer profile: ${constraints.defaultReviewerProfile}`,
    "",
    "Task:",
    input.request,
    "",
    `Target path: ${input.target}`,
    specPath ? `Spec path: ${specPath}` : null,
    declaredSurfaces.length > 0
      ? `Caller-declared candidate surfaces: ${declaredSurfaces.join(", ")}`
      : "Caller-declared candidate surfaces: none",
    declaredRisks.length > 0
      ? `Caller-declared candidate risks: ${declaredRisks.join(", ")}`
      : "Caller-declared candidate risks: none",
    "",
    "Classify surfaces and risks using only these vocabularies:",
    `- surfaces: ${ROUTING_SURFACES.join(", ")}`,
    `- risks: ${ROUTING_RISKS.join(", ")}`,
    "",
    "Choose implementer and reviewer profile/reasoning. Include concise rationale and concrete verification steps.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function routeWithAgent(
  ctx: Ctx,
  input: RouteWithAgentInput,
): Promise<MultiAgentRoute> {
  const constraints = normalizeConstraints(input.constraints);
  const key = input.key.trim();
  if (key.length === 0) throw new Error("routeWithAgent key cannot be empty");
  const declaredSurfaces = normalizeSurfaces(
    input.candidateSurfaces ?? [],
    "candidateSurfaces",
    "throw",
  ).values;
  const declaredRisks = normalizeRisks(
    input.candidateRisks ?? [],
    "candidateRisks",
    "throw",
  ).values;
  const declaredFloor = requiredReasoningFloor(declaredSurfaces, declaredRisks, constraints);
  if (
    rank(declaredFloor, constraints.activeOrder) >
    rank(constraints.maxReasoning, constraints.activeOrder)
  ) {
    throw new Error(
      "model routing requires reasoning above maxReasoning for declared critical surfaces/risks",
    );
  }
  const raw = await ctx.agent({
    key,
    profile: constraints.routerProfile ?? DEFAULT_ROUTER_PROFILE,
    reasoning: DEFAULT_ROUTER_REASONING,
    toolPolicy: "read-only",
    prompt: buildRoutingPrompt(input),
    schema: RoutingPlanSchema,
    lenient: true,
  });
  return sanitizeRoute(raw, {
    constraints: input.constraints,
    declaredSurfaces: input.candidateSurfaces ?? [],
    declaredRisks: input.candidateRisks ?? [],
  });
}

export function sanitizeRoute(raw: unknown, options: SanitizeRouteOptions): MultiAgentRoute {
  const constraints = normalizeConstraints(options.constraints);
  const declaredSurfaces = normalizeSurfaces(
    options.declaredSurfaces ?? [],
    "declaredSurfaces",
    "throw",
  ).values;
  const declaredRisks = normalizeRisks(
    options.declaredRisks ?? [],
    "declaredRisks",
    "throw",
  ).values;
  const output = requireRecord(raw, "router output");
  const complexity = requireKnownValue(
    output.complexity,
    ROUTING_COMPLEXITIES,
    "router output complexity",
  );
  const reportedSurfaces = normalizeSurfaces(output.surfaces, "router output surfaces", "drop");
  const reportedRisks = normalizeRisks(output.risks, "router output risks", "drop");
  const surfaces = unionValues(declaredSurfaces, reportedSurfaces.values);
  const risks = unionValues(declaredRisks, reportedRisks.values);
  const requiredFloor = requiredReasoningFloor(surfaces, risks, constraints);

  if (
    rank(requiredFloor, constraints.activeOrder) >
    rank(constraints.maxReasoning, constraints.activeOrder)
  ) {
    throw new Error(
      "model routing requires reasoning above maxReasoning for declared critical surfaces/risks",
    );
  }

  const maxRounds = normalizeOptionalPositiveInteger(output.maxRounds, "router output maxRounds");
  const implementer = sanitizeAgentRoute(output.implementer, {
    label: "implementer",
    constraints,
    requiredFloor,
    maxRounds,
  });
  const reviewer = sanitizeAgentRoute(output.reviewer, {
    label: "reviewer",
    constraints,
    requiredFloor,
    maxRounds,
  });
  const verification = normalizeStringArray(output.verification, "router output verification");
  const rationale = appendWarnings(
    requireString(output.rationale, "router output rationale").trim(),
    [...reportedSurfaces.warnings, ...reportedRisks.warnings],
  );

  return {
    implementer,
    reviewer,
    complexity,
    surfaces,
    risks,
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    verification,
    rationale,
  };
}

function sanitizeAgentRoute(
  raw: unknown,
  input: {
    label: string;
    constraints: NormalizedConstraints;
    requiredFloor: string;
    maxRounds?: number;
  },
): AgentRoute {
  const route = requireRecord(raw, `${input.label} route`);
  const profile = requireString(route.profile, `${input.label} profile`).trim();
  if (profile.length === 0) throw new Error(`${input.label} profile cannot be empty`);
  assertAllowedProfile(profile, input.constraints, `${input.label} profile`);
  const routerReasoning = requireString(route.reasoning, `${input.label} reasoning`).trim();
  validateInOrder(routerReasoning, input.constraints.activeOrder, `${input.label} reasoning`);
  validateAllowed(routerReasoning, input.constraints.allowedReasoning, `${input.label} reasoning`);
  const reasoning = clampBetween(
    routerReasoning,
    input.requiredFloor,
    input.constraints.maxReasoning,
    {
      activeOrder: input.constraints.activeOrder,
      allowedReasoning: input.constraints.allowedReasoning,
      label: `${input.label} reasoning`,
    },
  );
  const timeoutMs = normalizeOptionalPositiveInteger(route.timeoutMs, `${input.label} timeoutMs`);
  return {
    profile,
    reasoning,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
    rationale: `${input.label} route selected ${profile} at ${reasoning}`,
  };
}

function normalizeConstraints(constraints: RoutingConstraints): NormalizedConstraints {
  const activeOrder = constraints.reasoningOrder ?? ROUTING_REASONING_ORDER;
  validateReasoningOrder(activeOrder);
  validateCriticalFloors(activeOrder);
  validateInOrder(constraints.maxReasoning, activeOrder, "maxReasoning");
  if (constraints.minReasoning) {
    validateInOrder(constraints.minReasoning, activeOrder, "minReasoning");
  }
  validateReasoningSubset(constraints.allowedReasoning, activeOrder, "allowedReasoning");
  if (constraints.allowedReasoning.length === 0) {
    throw new Error("allowedReasoning must include at least one level");
  }
  const allowedProfiles = normalizeProfileList(constraints.allowedProfiles, "allowedProfiles");
  if (allowedProfiles.length === 0) {
    throw new Error("allowedProfiles must include at least one profile");
  }
  if ((constraints as { allowToolPolicyEscalation?: unknown }).allowToolPolicyEscalation === true) {
    throw new Error("router output cannot escalate tool policy in v1");
  }
  const routerProfile = constraints.routerProfile?.trim();
  if (routerProfile !== undefined && routerProfile.length === 0) {
    throw new Error("routerProfile cannot be empty");
  }
  const defaultImplementerProfile = constraints.defaultImplementerProfile.trim();
  const defaultReviewerProfile = constraints.defaultReviewerProfile.trim();
  assertAllowedProfile(defaultImplementerProfile, { allowedProfiles }, "defaultImplementerProfile");
  assertAllowedProfile(defaultReviewerProfile, { allowedProfiles }, "defaultReviewerProfile");
  return {
    ...(routerProfile ? { routerProfile } : {}),
    allowedProfiles,
    allowedReasoning: [...constraints.allowedReasoning],
    activeOrder,
    maxReasoning: constraints.maxReasoning,
    ...(constraints.minReasoning ? { minReasoning: constraints.minReasoning } : {}),
    defaultImplementerProfile,
    defaultReviewerProfile,
  };
}

function validateCriticalFloors(order: readonly string[]): void {
  const floors = new Set<string>([
    ...Object.values(CRITICAL_REASONING_FLOORS.surfaces),
    ...Object.values(CRITICAL_REASONING_FLOORS.risks),
  ]);
  for (const floor of floors) {
    if (!order.includes(floor)) {
      throw new Error(
        `reasoningOrder must include critical floor level ${floor} from CRITICAL_REASONING_FLOORS`,
      );
    }
  }
}

function requiredReasoningFloor(
  surfaces: readonly RoutingSurface[],
  risks: readonly RoutingRisk[],
  constraints: NormalizedConstraints,
): string {
  return maxReasoning(
    [
      firstReasoning(constraints.activeOrder),
      constraints.minReasoning,
      floorFrom(surfaces, risks, constraints.activeOrder),
    ],
    constraints.activeOrder,
  );
}

function floorFrom(
  surfaces: readonly RoutingSurface[],
  risks: readonly RoutingRisk[],
  order: readonly string[],
): string | undefined {
  const surfaceFloors = CRITICAL_REASONING_FLOORS.surfaces as Partial<
    Record<RoutingSurface, string>
  >;
  const riskFloors = CRITICAL_REASONING_FLOORS.risks as Partial<Record<RoutingRisk, string>>;
  const floors = [
    ...surfaces.map((surface) => surfaceFloors[surface]),
    ...risks.map((risk) => riskFloors[risk]),
  ].filter((value): value is string => value !== undefined);
  return floors.length > 0 ? maxReasoning(floors, order) : undefined;
}

function clampBetween(
  value: string,
  minValue: string,
  maxValue: string,
  options: { activeOrder: readonly string[]; allowedReasoning: readonly string[]; label: string },
): string {
  const valueRank = rank(value, options.activeOrder);
  const minRank = rank(minValue, options.activeOrder);
  const maxRank = rank(maxValue, options.activeOrder);
  const candidates = options.allowedReasoning
    .filter((candidate) => {
      const candidateRank = rank(candidate, options.activeOrder);
      return candidateRank >= minRank && candidateRank <= maxRank;
    })
    .sort((left, right) => rank(left, options.activeOrder) - rank(right, options.activeOrder));
  if (candidates.length === 0) {
    throw new Error(`${options.label} has no allowed value between ${minValue} and ${maxValue}`);
  }
  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) {
    throw new Error(`${options.label} has no allowed value between ${minValue} and ${maxValue}`);
  }
  let nearest = firstCandidate;
  let nearestDistance = Math.abs(rank(nearest, options.activeOrder) - valueRank);
  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(rank(candidate, options.activeOrder) - valueRank);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function maxReasoning(values: readonly (string | undefined)[], order: readonly string[]): string {
  let selected = firstReasoning(order);
  for (const value of values) {
    if (value === undefined) continue;
    validateInOrder(value, order, "reasoning");
    if (rank(value, order) > rank(selected, order)) {
      selected = value;
    }
  }
  return selected;
}

function promoteReasoning(
  value: RoutingComplexity,
  order: readonly RoutingComplexity[],
): RoutingComplexity {
  const index = order.indexOf(value);
  const promoted = order[Math.min(index + 1, order.length - 1)];
  if (promoted === undefined) {
    throw new Error(`cannot promote reasoning ${value}`);
  }
  return promoted;
}

function defaultReasoningFor(role: RoutingRole, task: RoutingTask): RoutingComplexity {
  if (task === "docs-review" || task === "summarization" || role === "summarizer") return "low";
  if (task === "implementation") return "medium";
  if (task === "debugging" || task === "workflow-authoring" || role === "planner") return "high";
  if (task === "implementation-review" || task === "code-review" || task === "plan-review") {
    return "high";
  }
  return "medium";
}

function defaultProfileFor(role: RoutingRole): string {
  if (role === "reviewer" || role === "planner") return DEFAULT_REVIEWER_PROFILE;
  return DEFAULT_IMPLEMENTER_PROFILE;
}

function staticRouteRationale(
  input: RoutingInput,
  surfaces: readonly RoutingSurface[],
  risks: readonly RoutingRisk[],
  floor: string | undefined,
  reasoning: RoutingComplexity,
): string {
  const parts = [
    `static route for ${input.role}/${input.task}`,
    `reasoning ${reasoning}`,
    floor ? `critical floor ${floor}` : "no critical floor",
  ];
  if (surfaces.length > 0) parts.push(`surfaces: ${surfaces.join(", ")}`);
  if (risks.length > 0) parts.push(`risks: ${risks.join(", ")}`);
  if (input.budget) parts.push(`budget: ${input.budget}`);
  return parts.join("; ");
}

function validateRoutingInput(input: RoutingInput): void {
  requireKnownValue(input.role, ROUTING_ROLES, "routing role");
  requireKnownValue(input.task, ROUTING_TASKS, "routing task");
  if (input.complexity !== undefined) {
    requireKnownValue(input.complexity, ROUTING_COMPLEXITIES, "complexity");
  }
  if (input.budget !== undefined) {
    requireKnownValue(input.budget, ROUTING_BUDGETS, "budget");
  }
}

function normalizeSurfaces(
  raw: unknown,
  label: string,
  unknownPolicy: "drop" | "throw",
): NormalizedValues<RoutingSurface> {
  return normalizeKnownArray(raw, ROUTING_SURFACES, label, unknownPolicy);
}

function normalizeRisks(
  raw: unknown,
  label: string,
  unknownPolicy: "drop" | "throw",
): NormalizedValues<RoutingRisk> {
  return normalizeKnownArray(raw, ROUTING_RISKS, label, unknownPolicy);
}

function normalizeKnownArray<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  label: string,
  unknownPolicy: "drop" | "throw",
): NormalizedValues<T> {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
  const values: T[] = [];
  const warnings: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new Error(`${label} values must be strings`);
    if (!includesValue(allowed, item)) {
      if (unknownPolicy === "throw") throw new Error(`${label} contains unknown value ${item}`);
      warnings.push(`${label} dropped unknown value ${item}`);
      continue;
    }
    if (!values.includes(item)) values.push(item);
  }
  return { values, warnings };
}

function normalizeStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new Error(`${label} values must be strings`);
    const trimmed = item.trim();
    if (trimmed.length > 0) values.push(trimmed);
  }
  return values;
}

function normalizeOptionalPositiveInteger(raw: unknown, label: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return raw;
}

function requireRecord(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function requireString(raw: unknown, label: string): string {
  if (typeof raw !== "string") throw new Error(`${label} must be a string`);
  return raw;
}

function requireKnownValue<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof raw !== "string" || !includesValue(allowed, raw)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return raw;
}

function validateReasoningOrder(order: readonly string[]): void {
  if (order.length === 0) throw new Error("reasoningOrder must include at least one level");
  const seen = new Set<string>();
  for (const value of order) {
    if (value.trim().length === 0) throw new Error("reasoningOrder cannot contain empty values");
    if (seen.has(value)) throw new Error(`reasoningOrder contains duplicate value ${value}`);
    seen.add(value);
  }
}

function validateReasoningSubset(
  values: readonly string[],
  order: readonly string[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    validateInOrder(value, order, label);
    if (seen.has(value)) throw new Error(`${label} contains duplicate value ${value}`);
    seen.add(value);
  }
}

function validateInOrder(value: string, order: readonly string[], label: string): void {
  if (!order.includes(value))
    throw new Error(`${label} ${value} is outside the active reasoning order`);
}

function validateAllowed(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) throw new Error(`${label} ${value} is outside allowedReasoning`);
}

function rank(value: string, order: readonly string[]): number {
  const index = order.indexOf(value);
  if (index === -1) throw new Error(`reasoning ${value} is outside the active reasoning order`);
  return index;
}

function firstReasoning(order: readonly string[]): string {
  const first = order[0];
  if (first === undefined) throw new Error("reasoningOrder must include at least one level");
  return first;
}

function normalizeProfileList(profiles: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const profile of profiles) {
    const trimmed = profile.trim();
    if (trimmed.length === 0) throw new Error(`${label} cannot contain empty profiles`);
    if (seen.has(trimmed)) throw new Error(`${label} contains duplicate profile ${trimmed}`);
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function assertAllowedProfile(
  profile: string,
  constraints: Pick<RoutingConstraints, "allowedProfiles">,
  label: string,
): void {
  if (!constraints.allowedProfiles.includes(profile)) {
    throw new Error(`${label} ${profile} is outside allowedProfiles`);
  }
}

function unionValues<T extends string>(left: readonly T[], right: readonly T[]): T[] {
  const out: T[] = [];
  for (const value of [...left, ...right]) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function appendWarnings(rationale: string, warnings: readonly string[]): string {
  if (warnings.length === 0) return rationale;
  const suffix = ` Routing warnings: ${warnings.join("; ")}.`;
  return rationale.length > 0 ? `${rationale}${suffix}` : suffix.trim();
}

function includesValue<T extends string>(allowed: readonly T[], value: string): value is T {
  return (allowed as readonly string[]).includes(value);
}
