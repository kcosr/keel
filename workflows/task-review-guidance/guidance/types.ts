export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface GuidanceFinding {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  title: string;
  evidence: string;
  recommendation: string;
}

export interface ReviewChecklistItem {
  id: string;
  label: string;
  prompt: string;
  required: boolean;
}

export interface ReviewRubric {
  id: string;
  title: string;
  audience: "code" | "plan";
  checklist: ReviewChecklistItem[];
  cleanCriteria: string[];
  severityRules: Record<ReviewSeverity, string>;
}
