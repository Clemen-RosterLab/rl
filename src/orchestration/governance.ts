import { z } from "zod";
import { now } from "../common.js";
import { proseSchema, StrictLowerUuidSchema } from "../schemas/common.js";
import { FingerprintSchema } from "./evidence.js";
import type { WorkflowRun, Stage } from "../agent-runner.js";

export const LevelSchema = z.enum(["light", "standard", "deep"]);
const notes = z.array(proseSchema(4000, "assessment evidence")).max(16);
export const AssessmentSchema = z.strictObject({
  level: LevelSchema,
  rationale: proseSchema(8000, "effort selection rationale"),
  uncertainty: notes,
  systems: notes.min(1),
  consequences: notes.min(1),
});
export const BudgetsSchema = z.strictObject({
  researchMs: z.number().int().min(1000).max(3600000).default(300000),
  runMs: z.number().int().min(1000).max(86400000).default(3600000),
  checkMs: z.number().int().min(100).max(3600000).default(600000),
  submissions: z.number().int().min(1).max(128).default(32),
  consultations: z.number().int().min(1).max(256).default(64),
  reviewRounds: z.number().int().min(1).max(16).default(3),
});
export const OrientationSchema = z.strictObject({
  step: z.string(),
  claim: StrictLowerUuidSchema,
  fingerprint: FingerprintSchema,
  risks: notes.min(1),
  checksToChallenge: notes.min(1),
  assumptions: notes,
  at: z.string(),
});
export const ResolutionSchema = z.strictObject({
  submission: StrictLowerUuidSchema,
  decision: z.enum(["fix", "reject", "blocked"]),
  rationale: proseSchema(8000, "disagreement resolution"),
  evidence: proseSchema(8000, "resolution evidence"),
  at: z.string(),
});
export const GovernanceSchema = z.strictObject({
  version: z.literal(1),
  requested: z.enum(["auto", "light", "standard", "deep"]),
  baseline: LevelSchema,
  assessment: AssessmentSchema.extend({ at: z.string() }).optional(),
  budgets: BudgetsSchema,
  orientations: z.array(OrientationSchema).max(32),
  resolutions: z.array(ResolutionSchema).max(32),
  previousRun: StrictLowerUuidSchema.optional(),
  successor: StrictLowerUuidSchema.optional(),
});
export const GOVERNANCE_SCHEMAS = {
  assess: z.strictObject({ run: z.string(), assessment: AssessmentSchema }),
  budget: z.strictObject({ run: z.string(), budgets: BudgetsSchema }),
  orient: z.strictObject({
    run: z.string(),
    step: z.string(),
    claim: StrictLowerUuidSchema,
    fingerprint: FingerprintSchema,
    risks: notes.min(1),
    checksToChallenge: notes.min(1),
    assumptions: notes,
  }),
  resolve: z.strictObject({
    run: z.string(),
    ...ResolutionSchema.omit({ at: true }).shape,
  }),
  escalate: z.strictObject({
    run: z.string(),
    level: LevelSchema,
    rationale: proseSchema(8000, "escalation reason"),
    stopped: z.literal(true),
  }),
};
export function reviewerStage(run: WorkflowRun, stage: Stage): boolean {
  const config = run.config.workflows[run.workflow];
  return (
    stage.id === config.collaboration?.reviewer ||
    (stage.agent === "reviewer" &&
      run.config.agents[stage.agent]?.access === "read-only")
  );
}
export function oriented(run: WorkflowRun, stage: Stage): boolean {
  return (
    !run.quality?.governance ||
    Boolean(
      run.quality.governance.orientations.some(
        (o) => o.step === stage.id && o.claim === stage.claim,
      ),
    )
  );
}
export function assertOrientation(run: WorkflowRun, stage: Stage) {
  if (reviewerStage(run, stage) && !oriented(run, stage))
    throw new Error(
      "Record an independent first pass with workflow orient before reading rationale or rating/reporting implementation",
    );
}
export function budgetBlockers(run: WorkflowRun, at = Date.now()): string[] {
  const governance = run.quality?.governance;
  if (!governance) return [];
  const issues: string[] = [],
    b = governance.budgets;
  const end =
    run.status === "completed" || run.status === "cancelled"
      ? Date.parse(run.updatedAt)
      : at;
  if (end - Date.parse(run.createdAt) > b.runMs)
    issues.push(
      "Run time budget exhausted; stop native children and report a blocker or start a successor run",
    );
  const researcher = run.stages.find(
    (s) => s.id === "research" && s.agent === "researcher",
  );
  if (
    researcher &&
    researcher.durationMs +
      (researcher.status === "running"
        ? Math.max(0, at - Date.parse(researcher.startedAt!))
        : 0) >
      b.researchMs
  )
    issues.push(
      "Research time budget exhausted; report the limitation instead of extending exploration",
    );
  if (
    (run.quality?.receipts.reduce((n, r) => n + r.durationMs, 0) ?? 0) >
    b.checkMs
  )
    issues.push(
      "Validation time budget exhausted; report remaining unverified criteria",
    );
  for (const resolution of governance.resolutions.filter(
    (r) => r.decision === "blocked",
  ))
    issues.push(
      `Unresolved review disagreement ${resolution.submission}: ${resolution.rationale}`,
    );
  return issues;
}
export function assertBudget(run: WorkflowRun) {
  const issues = budgetBlockers(run);
  if (issues.length) throw new Error(issues.join("; "));
}
export function governanceAction(
  run: WorkflowRun,
  action: Exclude<keyof typeof GOVERNANCE_SCHEMAS, "escalate">,
  raw: Record<string, unknown>,
  current: string,
) {
  const g = run.quality?.governance;
  if (!g) throw new Error("Start a new leveled run to use workflow governance");
  if (action === "assess") {
    if (run.stages.some((s) => s.attempts))
      throw new Error(
        "Effort assessment is frozen after roles start; escalate using a successor run",
      );
    const { assessment } = GOVERNANCE_SCHEMAS.assess.parse(raw);
    if (g.requested !== "auto" && assessment.level !== g.requested)
      throw new Error(
        "The explicit user-selected level is pinned; record its assessment without changing that level",
      );
    if (
      g.previousRun &&
      ["light", "standard", "deep"].indexOf(assessment.level) <
        ["light", "standard", "deep"].indexOf(g.baseline)
    )
      throw new Error(
        "An escalated successor cannot lower its escalation level",
      );
    g.assessment = { ...assessment, at: now() };
    run.quality!.level = assessment.level;
    run.quality!.reason = assessment.rationale;
    return g.assessment;
  }
  if (action === "budget") {
    if (run.stages.some((s) => s.attempts))
      throw new Error("Budgets are frozen after roles start");
    g.budgets = GOVERNANCE_SCHEMAS.budget.parse(raw).budgets;
    return g.budgets;
  }
  if (action === "orient") {
    const { run: _run, ...orientation } = GOVERNANCE_SCHEMAS.orient.parse(raw);
    const stage = run.stages.find(
      (s) =>
        s.id === orientation.step &&
        s.claim === orientation.claim &&
        s.status === "running",
    );
    if (!stage || !reviewerStage(run, stage))
      throw new Error(
        "A current reviewer claim is required for independent orientation",
      );
    if (orientation.fingerprint !== current)
      throw new Error(
        "First-pass source changed; inspect current source before recording risks",
      );
    if (oriented(run, stage))
      throw new Error(
        "Independent first pass is already recorded for this claim",
      );
    if (g.orientations.length >= 32)
      throw new Error("First-pass record limit reached");
    g.orientations.push({ ...orientation, at: now() });
    return {
      orientation: g.orientations.at(-1),
      research: run.quality!.research,
      dependencies: run.stages
        .filter((dependency) => stage.after.includes(dependency.id))
        .map((dependency) => ({
          id: dependency.id,
          result: dependency.result,
          check: dependency.check,
        })),
      instruction:
        "First pass recorded. You may now inspect the chosen approach and writer rationale, challenge assumptions, and review the implementation.",
    };
  }
  const { run: _run, ...resolution } = GOVERNANCE_SCHEMAS.resolve.parse(raw);
  const submission = run.collaboration?.submissions.find(
    (s) => s.id === resolution.submission && !s.supersededBy,
  );
  if (!submission?.review || submission.review.accepted)
    throw new Error(
      "Resolve a current rejected review checkpoint with concrete evidence",
    );
  if (g.resolutions.some((r) => r.submission === resolution.submission))
    throw new Error("This disagreement already has a coordinator decision");
  if (g.resolutions.length >= 32) throw new Error("Resolution limit reached");
  const saved = { ...resolution, at: now() };
  g.resolutions.push(saved);
  return {
    ...saved,
    instruction:
      "This routes the next action; it does not accept the checkpoint or dismiss required findings. Resubmit changed work for a fresh independent rating.",
  };
}
