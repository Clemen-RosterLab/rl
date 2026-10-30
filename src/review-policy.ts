import {
  fields,
  SEVERITIES,
  type ReviewPolicy,
  type Severity,
} from "./automation-config.js";
import path from "node:path";

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
const string = { type: "string" };
const findingProperties = {
  title: string,
  severity: { type: "string", enum: SEVERITIES },
  required: { type: "boolean" },
  rootCause: string,
  file: string,
  line: { type: "integer", minimum: 1 },
  evidence: string,
  recommendation: string,
  confidence: { type: "string", enum: ["observed", "inferred"] },
};
export const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: string,
    complete: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: findingProperties,
        required: Object.keys(findingProperties),
      },
    },
    limitations: { type: "array", items: string },
    checkRequests: { type: "array", items: string },
    routingLeads: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { owner: string, file: string, reason: string },
        required: ["owner", "file", "reason"],
      },
    },
  },
  required: [
    "summary",
    "complete",
    "findings",
    "limitations",
    "checkRequests",
    "routingLeads",
  ],
};
function prose(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 16000 ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(value)
  )
    throw new Error("Expected nonempty review text (up to 16000 characters)");
}
function sourcePath(value: unknown): asserts value is string {
  prose(value);
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\r\n]/.test(value)
  )
    throw new Error(
      "Evidence paths must be relative to the reviewed workspace",
    );
}
export function validateResult(value: unknown): asserts value is ReviewResult {
  fields(value, Object.keys(RESULT_SCHEMA.properties));
  prose(value.summary);
  if (
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.findings) ||
    value.findings.length > 100
  )
    throw new Error("Invalid review completeness or findings");
  for (const finding of value.findings) {
    fields(finding, Object.keys(findingProperties));
    for (const key of ["title", "rootCause", "evidence", "recommendation"])
      prose(finding[key]);
    sourcePath(finding.file);
    if (
      !SEVERITIES.includes(finding.severity as Severity) ||
      typeof finding.required !== "boolean" ||
      !Number.isSafeInteger(finding.line) ||
      Number(finding.line) < 1 ||
      !["observed", "inferred"].includes(String(finding.confidence))
    )
      throw new Error("Invalid finding severity, line or confidence");
  }
  for (const key of ["limitations", "checkRequests"] as const) {
    if (!Array.isArray(value[key]) || value[key].length > 100)
      throw new Error(`Invalid ${key}`);
    for (const item of value[key]) prose(item);
  }
  if (!Array.isArray(value.routingLeads) || value.routingLeads.length > 32)
    throw new Error("Invalid routing leads");
  for (const lead of value.routingLeads) {
    fields(lead, ["owner", "file", "reason"]);
    prose(lead.owner);
    sourcePath(lead.file);
    prose(lead.reason);
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
  reports: { owner: string; result: ReviewResult }[],
  limitations: string[] = [],
): Evaluation {
  const unique = new Map<string, OwnedFinding>();
  for (const { owner, result } of reports) {
    if (!result.complete)
      limitations.push(`${owner}: review coverage is incomplete`);
    limitations.push(...result.limitations.map((note) => `${owner}: ${note}`));
    for (const finding of result.findings) {
      // Deliberately conservative: distinct descriptions/locations remain separate.
      const key = JSON.stringify([
        finding.file,
        finding.line,
        finding.rootCause.toLowerCase().replace(/\s+/g, " ").trim(),
      ]);
      const previous = unique.get(key);
      if (!previous) unique.set(key, { ...finding, owners: [owner] });
      else {
        previous.owners = [...new Set([...previous.owners, owner])];
        previous.required ||= finding.required;
        if (
          SEVERITIES.indexOf(finding.severity) <
          SEVERITIES.indexOf(previous.severity)
        )
          previous.severity = finding.severity;
      }
    }
  }
  const findings = [...unique.values()].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  const deductions: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of findings)
    deductions[finding.severity] += policy.weights[finding.severity];
  const score = reports.length
    ? Math.max(0, 100 - Object.values(deductions).reduce((a, b) => a + b, 0))
    : null;
  return {
    score,
    verdict:
      limitations.length || score === null
        ? "incomplete"
        : (policy.blockRequired && findings.some((f) => f.required)) ||
            score < policy.minimumScore
          ? "fix-required"
          : "ready",
    findings,
    limitations: [...new Set(limitations)],
    deductions,
  };
}
