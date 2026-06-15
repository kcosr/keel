import { describe, expect, test } from "bun:test";
import {
  renderChecklist,
  renderCleanCriteria,
  renderSeverityRules,
} from "./guidance/checklist";
import { renderFindingContract, validateReviewOutput } from "./guidance/finding";
import { buildCodeReviewPrompt, buildPlanReviewPrompt } from "./guidance/prompt";
import { CODE_REVIEW_RUBRIC, PLAN_REVIEW_RUBRIC } from "./guidance/rubric";

describe("task review guidance", () => {
  test("renders stable code and plan rubrics", () => {
    expect(renderChecklist(CODE_REVIEW_RUBRIC)).toContain(
      "code.persistence (required) Persistence and migrations",
    );
    expect(renderChecklist(PLAN_REVIEW_RUBRIC)).toContain(
      "plan.keel-native (required) Keel-native scope",
    );
    expect(renderSeverityRules(CODE_REVIEW_RUBRIC)).toBe(
      [
        "Severity Rules",
        `- critical: ${CODE_REVIEW_RUBRIC.severityRules.critical}`,
        `- high: ${CODE_REVIEW_RUBRIC.severityRules.high}`,
        `- medium: ${CODE_REVIEW_RUBRIC.severityRules.medium}`,
        `- low: ${CODE_REVIEW_RUBRIC.severityRules.low}`,
      ].join("\n"),
    );
    expect(renderCleanCriteria(PLAN_REVIEW_RUBRIC)).toContain(
      "No unresolved blocker or contradiction remains",
    );
  });

  test("prompts include rubrics, clean criteria, contracts, and caller focus", () => {
    const code = buildCodeReviewPrompt({
      repository: "/repo",
      task: "review auth change",
      focus: ["capability mapping", "saved source"],
      maxFindings: 3,
    });
    expect(code).toContain("Repository: /repo");
    expect(code).toContain("- capability mapping");
    expect(code).toContain("Advisory finding cap: 3");
    expect(code).toContain("Clean Review Criteria");
    expect(code).toContain(renderFindingContract("code"));

    const plan = buildPlanReviewPrompt({
      specPath: ".specs/plan.md",
      request: "review plan",
      focus: ["migration boundary"],
      appendCorrespondence: true,
      correspondenceHeader: "### 2026-06-15 - Reviewer",
    });
    expect(plan).toContain("Spec path: .specs/plan.md");
    expect(plan).toContain("Correspondence header to add exactly: ### 2026-06-15 - Reviewer");
    expect(plan).toContain("plan.migrations");
    expect(plan).toContain(renderFindingContract("plan"));
  });

  test("validates and normalizes structured review output", () => {
    expect(
      validateReviewOutput({
        status: "changes-requested",
        summary: "  fix required  ",
        findings: [
          {
            severity: "high",
            file: " src/a.ts ",
            line: 4,
            title: "  Broken behavior  ",
            evidence: "  fails under replay  ",
            recommendation: "  add validation  ",
          },
        ],
      }),
    ).toEqual({
      status: "changes-requested",
      summary: "fix required",
      findings: [
        {
          severity: "high",
          file: "src/a.ts",
          line: 4,
          title: "Broken behavior",
          evidence: "fails under replay",
          recommendation: "add validation",
        },
      ],
    });
    expect(() =>
      validateReviewOutput({
        status: "clean",
        summary: "bad",
        findings: [
          { severity: "low", title: "x", evidence: "x", recommendation: "x" },
        ],
      }),
    ).toThrow(/clean/);
    expect(() =>
      validateReviewOutput({
        status: "changes-requested",
        summary: "bad",
        findings: [{ severity: "major", title: "x", evidence: "x", recommendation: "x" }],
      }),
    ).toThrow(/severity/);
  });
});
