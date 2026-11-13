import {
  SEVERITIES,
  type ReviewPolicy,
  type Severity,
} from "./automation-config.js";
import type { JsonObject } from "./json.js";
import { ReviewResultSchema } from "./schemas/automation.js";
import { toCleanJsonSchema } from "./schemas/common.js";

export interface Finding {
  title: string;
  severity: Severity;
  required: boolean;
  rootCause: string;
  file: string;
  line: number;
  evidence: string;
  recommendation: string;
  confidence: "observed" | "inferred";
}

export interface ReviewResult {
  summary: string;
  complete: boolean;
  findings: Finding[];
  limitations: string[];
  checkRequests: string[];
  routingLeads: { owner: string; file: string; reason: string }[];
}

export const RESULT_SCHEMA = toCleanJsonSchema(
  ReviewResultSchema,
) as JsonObject;

export function validateResult(value: unknown): asserts value is ReviewResult {
  const parsed = ReviewResultSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue?.message || "Invalid review result");
  }
}

export interface OwnedFinding extends Finding {
  owners: string[];
}

export interface Evaluation {
  score: number | null;
  verdict: "ready" | "fix-required" | "incomplete";
  findings: OwnedFinding[];
  limitations: string[];
  deductions: Record<Severity, number>;
}

/** Scoring belongs to RL. Agents supply evidence and qualitative classifications. */
export function evaluate(
  policy: ReviewPolicy,
  reports: readonly { owner: string; result: ReviewResult }[],
  initialLimitations: readonly string[] = [],
): Evaluation {
  const limitations = [...initialLimitations];
  const unique = new Map<string, OwnedFinding>();

  for (const { owner, result } of reports) {
    if (!result.complete) {
      limitations.push(`${owner}: review coverage is incomplete`);
    }
    for (const note of result.limitations) {
      limitations.push(`${owner}: ${note}`);
    }
    for (const finding of result.findings) {
      // Deliberately conservative: distinct descriptions/locations remain separate.
      const key = JSON.stringify([
        finding.file,
        finding.line,
        finding.rootCause.toLowerCase().replace(/\s+/g, " ").trim(),
      ]);
      const previous = unique.get(key);
      if (!previous) {
        unique.set(key, { ...finding, owners: [owner] });
      } else {
        previous.owners = [...new Set([...previous.owners, owner])];
        previous.required ||= finding.required;
        if (
          SEVERITIES.indexOf(finding.severity) <
          SEVERITIES.indexOf(previous.severity)
        ) {
          previous.severity = finding.severity;
        }
      }
    }
  }

  const findings = [...unique.values()].toSorted(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  const deductions: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of findings) {
    deductions[finding.severity] += policy.weights[finding.severity];
  }

  const totalDeduction = Object.values(deductions).reduce((a, b) => a + b, 0);
  const score = reports.length > 0 ? Math.max(0, 100 - totalDeduction) : null;

  let verdict: Evaluation["verdict"];
  if (limitations.length > 0 || score === null) {
    verdict = "incomplete";
  } else if (
    (policy.blockRequired && findings.some((f) => f.required)) ||
    score < policy.minimumScore
  ) {
    verdict = "fix-required";
  } else {
    verdict = "ready";
  }

  return {
    score,
    verdict,
    findings,
    limitations: [...new Set(limitations)],
    deductions,
  };
}
