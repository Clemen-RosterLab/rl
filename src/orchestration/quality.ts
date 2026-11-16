import { z } from "zod";
import { now } from "../common.js";
import { proseSchema, StrictLowerUuidSchema } from "../schemas/common.js";
import { toCleanJsonSchema } from "../schemas/common.js";
import {
  resolveAgentProfile,
  type AutomationConfig,
} from "../automation-config.js";
import type { WorkflowRun } from "../agent-runner.js";
import { parseJsonObject, isJsonObject } from "../json.js";
import { evaluate } from "../review-policy.js";
import {
  ResearchStateSchema,
  RESEARCH_SCHEMAS,
  researchAction,
} from "./research.js";
import { PRESET } from "../agent-presets.js";
import { AgentWorkflowSchema } from "../schemas/automation.js";
import {
  CriterionSchema,
  ReceiptSchema,
  ReceiptInputSchema,
  PendingCaptureSchema,
  CaptureSchema,
  assertPlan,
  saveReceipt,
  criterionResults,
} from "./evidence.js";
import {
  GovernanceSchema,
  GOVERNANCE_SCHEMAS,
  budgetBlockers,
  governanceAction,
} from "./governance.js";
export { CriterionSchema, criterionResults } from "./evidence.js";
import {
  OutcomeSchema,
  OutcomeInputSchema,
  recordOutcome,
} from "./evaluation.js";
import { agentState } from "./status.js";

export const WorkflowLevelSchema = z.enum([
  "auto",
  "light",
  "standard",
  "deep",
]);
export type WorkflowLevel = Exclude<
  z.infer<typeof WorkflowLevelSchema>,
  "auto"
>;
const CapabilitiesSchema = z.strictObject({
  delegation: z.boolean(),
  messaging: z.boolean(),
  readOnly: z.boolean(),
  models: z.array(z.string().min(1).max(200)).max(64),
  modelOverrides: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
      z.string().min(1).max(200),
    )
    .default({}),
  degradedReason: proseSchema(
    4000,
    "degraded execution acknowledgement",
  ).optional(),
});
export const WorkflowQualitySchema = z.strictObject({
  version: z.literal(1),
  governance: GovernanceSchema.optional(),
  template: AgentWorkflowSchema.optional(),
  capture: PendingCaptureSchema.optional(),
  outcome: OutcomeSchema.optional(),
  level: z.enum(["light", "standard", "deep"]),
  reason: z.string(),
  criteria: z.array(CriterionSchema).max(64),
  receipts: z.array(ReceiptSchema).max(128),
  capabilities: CapabilitiesSchema.optional(),
  capabilitySource: z.literal("host-reported").optional(),
  preflightAt: z.string().optional(),
  research: ResearchStateSchema.optional(),
  events: z
    .array(
      z.strictObject({ at: z.string(), step: z.string(), message: z.string() }),
    )
    .max(256),
});
export type WorkflowQuality = z.infer<typeof WorkflowQualitySchema>;
export type Criterion = z.infer<typeof CriterionSchema>;

const common = { run: z.string().min(1) };
export const QUALITY_SCHEMAS = {
  ...RESEARCH_SCHEMAS,
  ...GOVERNANCE_SCHEMAS,
  check: CaptureSchema,
  outcome: OutcomeInputSchema,
  preflight: z.strictObject({ ...common, capabilities: CapabilitiesSchema }),
  criteria: z.strictObject({
    ...common,
    criteria: z.array(CriterionSchema).min(1).max(64),
  }),
  validation: z.strictObject({ ...common, receipt: ReceiptInputSchema }),
  heartbeat: z.strictObject({
    ...common,
    step: z.string(),
    claim: StrictLowerUuidSchema,
    message: proseSchema(2000, "progress"),
  }),
  recover: z.strictObject({
    ...common,
    step: z.string(),
    claim: StrictLowerUuidSchema,
    stopped: z.literal(true),
    reason: proseSchema(4000, "recovery reason"),
  }),
};
export const QUALITY_TOOLS = Object.entries(QUALITY_SCHEMAS).map(
  ([action, schema]) => {
    const converted = parseJsonObject(
      JSON.stringify(toCleanJsonSchema(schema)),
    );
    if (!isJsonObject(converted.properties))
      throw new Error("Invalid workflow quality schema");
    return {
      name: `rl_workflow_${action}`,
      description: (
        {
          assess:
            "Record coordinator effort reasoning before roles start; respects an explicit user level and can replace an auto baseline.",
          budget:
            "Set research, total time, validation time, handoff and review-round budgets before work starts.",
          orient:
            "Reviewer records an independent first pass before seeing research recommendations or writer rationale.",
          resolve:
            "Coordinator resolves a rejected checkpoint disagreement with evidence; does not approve code or bypass required findings.",
          escalate:
            "After explicitly stopping native children, create a higher-level successor run preserving old evidence and history.",
          check:
            "Execute an explicitly requested planned validation command with bounded time/output and captured provenance. Uses the current host permissions; no shell is added and no provider is launched automatically.",
          outcome:
            "Record a versioned evaluation case/trial using current captured acceptance and regression grader receipts; synthetic trials remain separate from native-agent outcomes.",
          preflight:
            "Declare actual host delegation, messaging, read-only controls and available models before claiming leveled work. Host-reported, never inferred.",
          criteria:
            "Set explicit acceptance criteria before work; changes invalidate prior evidence.",
          validation:
            "Record actual check output bound to a current source fingerprint. Does not execute a command or independently attest results.",
          heartbeat:
            "Record progress for the exact active claim; renews its inactivity lease.",
          recover:
            "Recover an expired native claim only after the parent confirms it stopped that child. Old claim and peer binding are invalidated.",
          research:
            "Save 2–5 substantively different approach seeds, facts, sources, comparison and recommendation for the current researcher claim. No implementation is authorized.",
          decide:
            "Coordinator selects a viable saved research approach with rationale after research completes and before the writer starts.",
        } as Record<string, string>
      )[action],
      properties: converted.properties,
      required: Array.isArray(converted.required)
        ? (converted.required as string[])
        : [],
      readOnly: false,
    };
  },
);

export function selectWorkflowLevel(
  requested: z.infer<typeof WorkflowLevelSchema>,
  files: string[],
  prompt: string,
): { level: WorkflowLevel; reason: string } {
  if (requested !== "auto")
    return { level: requested, reason: "Explicit user/coordinator selection" };
  const risk =
    /auth|permission|payment|billing|migration|security|concurren|credential/i;
  if (risk.test(prompt) || files.some((f) => risk.test(f)))
    return {
      level: "deep",
      reason:
        "Sensitive behavior or a high-risk path requires independent reuse research and review",
    };
  if (files.length > 12)
    return { level: "deep", reason: "Change spans more than twelve files" };
  if (
    files.length &&
    files.every((f) => /\.(md|txt)$/.test(f)) &&
    /document|readme|typo|wording|markdown|spelling|docs/i.test(prompt)
  )
    return {
      level: "light",
      reason: "Intent and current scope indicate documentation/text changes",
    };
  return {
    level: "standard",
    reason: files.length
      ? "Normal implementation scope"
      : "Scope is not yet known; conservative Standard level",
  };
}
export function leveledConfig(
  config: AutomationConfig,
  workflow: string,
  level: WorkflowLevel,
): AutomationConfig {
  if (workflow !== "writer-reviewer-dry")
    throw new Error(
      "--level applies to writer-reviewer-dry; custom workflow definitions retain their own execution plan",
    );
  const copy = structuredClone(config),
    definition = copy.workflows[workflow];
  if (!definition?.collaboration)
    throw new Error(
      "Workflow levels require the writer-reviewer-dry collaboration definition",
    );
  const { writer, reviewer } = definition.collaboration;
  definition.description =
    level === "light"
      ? "Sequential writer and independent reviewer with coordinator exploration"
      : level === "standard"
        ? "Multiple research approaches, coordinator decision, then concurrent writer and reviewer"
        : "Multiple research approaches, coordinator decision, then writer, reviewer and DRY";
  if (level === "light") {
    definition.steps = definition.steps
      .filter((s) => s.id === writer || s.id === reviewer)
      .map((s) => ({ ...s, after: s.id === reviewer ? [writer] : [] }));
    definition.concurrency = 1;
    delete definition.collaboration;
  } else if (level === "standard") {
    definition.steps = definition.steps.filter(
      (s) => s.id === writer || s.id === reviewer,
    );
    definition.concurrency = 2;
    delete definition.collaboration.dry;
    definition.collaboration.rules = [];
  }
  if (level !== "light") {
    copy.agents.researcher ??= structuredClone(PRESET.agents.researcher);
    if (copy.agents.researcher.access !== "read-only")
      throw new Error("The researcher profile must be read-only");
    if (definition.steps.some((s) => s.id === "research"))
      throw new Error(
        "The research step name is reserved by leveled execution",
      );
    definition.steps = [
      { id: "research", agent: "researcher", after: [] },
      ...definition.steps.map((s) => ({ ...s, after: ["research"] })),
    ];
  }
  return copy;
}
export function initializeQuality(
  level: WorkflowLevel,
  reason: string,
  criteria: unknown = [],
): WorkflowQuality {
  const parsed = z.array(CriterionSchema).max(64).parse(criteria);
  assertPlan(parsed);
  return {
    version: 1,
    level,
    reason,
    criteria: parsed,
    receipts: [],
    events: [],
  };
}
export function preflightBlockers(run: WorkflowRun): string[] {
  if (!run.quality) return [];
  const planIssues: string[] = [];
  if (run.quality.governance) {
    if (!run.quality.governance.assessment)
      planIssues.push(
        "Coordinator effort assessment missing · run workflow assess before claiming roles",
      );
    for (const c of run.quality.criteria)
      if (c.required && !c.checks?.length)
        planIssues.push(
          `${c.id}: plan individual checks and observable outcomes before implementation`,
        );
  }
  const caps = run.quality.capabilities;
  if (!caps)
    return [
      "Host capabilities unverified · run workflow preflight before claiming roles",
    ];
  const missing: string[] = [...planIssues];
  if (!run.quality.criteria.length)
    missing.push(
      "Acceptance criteria missing · record workflow criteria before claiming roles",
    );
  if (!caps.delegation)
    missing.push(
      "Native delegation unavailable; dismiss/cancel this run rather than starting another provider process",
    );
  if (run.quality.level !== "light" && !caps.messaging)
    missing.push(
      "Peer messaging unavailable; explicitly start a Light run for sequential execution",
    );
  if (!caps.readOnly && !caps.degradedReason)
    missing.push(
      "Read-only host controls unavailable; an explicit degraded-execution acknowledgement is required",
    );
  for (const step of run.stages) {
    if (!step.agent || !run.owner) continue;
    const profile = resolveAgentProfile(
      run.config.agents[step.agent],
      run.owner.agent,
    );
    const actual = caps.modelOverrides[step.id] ?? profile.model;
    if (actual && !caps.models.includes(actual))
      missing.push(
        `${step.id}: selected model ${actual} is not verified available`,
      );
    if (
      caps.modelOverrides[step.id] &&
      actual !== profile.model &&
      !caps.degradedReason
    )
      missing.push(
        `${step.id}: a model override requires an explicit degraded-execution acknowledgement`,
      );
  }
  return missing;
}
export function qualityBlockers(
  run: WorkflowRun,
  current = run.scope.fingerprint,
): string[] {
  if (!run.quality) return [];
  const blockers = [...preflightBlockers(run), ...budgetBlockers(run)];
  if (run.quality.capture)
    blockers.push("A captured validation command is still running");
  if (run.stages.some((s) => s.agent === "researcher")) {
    if (!run.quality.research)
      blockers.push("Multiple approach seeds have not been recorded");
    else if (!run.quality.research.decision)
      blockers.push("Coordinator has not selected a research approach");
  }
  if (!run.quality.criteria.length)
    blockers.push("Acceptance criteria have not been recorded");
  for (const criterion of criterionResults(run, current))
    if (criterion.required && criterion.status !== "passed")
      blockers.push(
        `${criterion.id}: ${criterion.stale ? "validation predates current source" : criterion.status}`,
      );
  return blockers;
}
export function stageLease(
  run: WorkflowRun,
  stage: WorkflowRun["stages"][number],
  at = Date.now(),
) {
  const timeout = run.config.workflows[run.workflow].timeoutSeconds * 1000;
  const last = Date.parse(
    stage.heartbeatAt ?? stage.startedAt ?? run.updatedAt,
  );
  const started = Date.parse(stage.startedAt ?? run.updatedAt);
  return {
    stale:
      stage.status === "running" &&
      (at - last > Math.min(timeout, 300000) || at - started > timeout),
    idleMs: Math.max(0, at - last),
    elapsedMs:
      stage.status === "running" ? Math.max(0, at - started) : stage.durationMs,
  };
}
export function qualityAction(
  run: WorkflowRun,
  action: keyof typeof QUALITY_SCHEMAS,
  raw: Record<string, unknown>,
  current: string,
) {
  if (!run.quality)
    throw new Error(
      "This legacy run has no evidence plan; start a new run with --level",
    );
  const { agent: _agent, sessionId: _session, ...input } = raw;
  const quality = run.quality;
  if (
    quality.capture &&
    ["criteria", "assess", "budget", "preflight"].includes(action)
  )
    throw new Error(
      "Cannot change the validation plan, effort or capabilities while a command is running",
    );
  if (action === "outcome") return recordOutcome(run, input, current);
  if (
    action === "assess" ||
    action === "budget" ||
    action === "orient" ||
    action === "resolve"
  )
    return governanceAction(run, action, input, current);
  if (action === "check" || action === "escalate")
    throw new Error("This operation requires its native workflow handler");
  if (action === "research" || action === "decide")
    return researchAction(run, action, raw, current);
  if (action === "preflight") {
    if (run.stages.some((s) => s.attempts))
      throw new Error(
        "Capabilities cannot be changed after role execution starts",
      );
    const parsed = QUALITY_SCHEMAS.preflight.parse(input);
    if (
      Object.keys(parsed.capabilities.modelOverrides).some(
        (id) => !run.stages.some((s) => s.id === id && s.agent),
      )
    )
      throw new Error("Model override references an unknown agent step");
    quality.capabilities = parsed.capabilities;
    quality.capabilitySource = "host-reported";
    quality.preflightAt = now();
    return {
      capabilities: quality.capabilities,
      blockers: preflightBlockers(run),
    };
  }
  if (action === "criteria") {
    const parsed = QUALITY_SCHEMAS.criteria.parse(input);
    if (run.stages.some((s) => s.attempts))
      throw new Error(
        "Acceptance criteria are frozen after work starts; create a new run for changed requirements",
      );
    assertPlan(parsed.criteria);
    quality.criteria = parsed.criteria;
    quality.receipts = [];
    return criterionResults(run, current);
  }
  if (action === "validation") {
    const { receipt } = QUALITY_SCHEMAS.validation.parse(input);
    return saveReceipt(run, receipt, current);
  }
  const parsed =
    action === "heartbeat"
      ? QUALITY_SCHEMAS.heartbeat.parse(input)
      : QUALITY_SCHEMAS.recover.parse(input);
  const stage = run.stages.find((s) => s.id === parsed.step);
  if (!stage || stage.status !== "running" || stage.claim !== parsed.claim)
    throw new Error("A current running claim is required");
  if (action === "recover") {
    const recovery = QUALITY_SCHEMAS.recover.parse(input);
    if (!stageLease(run, stage).stale)
      throw new Error(
        "Claim is still active; stop/cancel it normally rather than recovering it",
      );
    stage.durationMs += Math.max(
      0,
      Date.now() - Date.parse(stage.startedAt ?? now()),
    );
    stage.status = "pending";
    stage.error = `Recovered: ${recovery.reason}`;
    delete stage.claim;
    delete stage.childId;
    delete stage.startedAt;
    delete stage.heartbeatAt;
    delete stage.progress;
    // Any completed peer review is now unverified until the recovered role finishes.
    run.status = "running";
    run.controlRequested = null;
    quality.events.push({
      at: now(),
      step: stage.id,
      message: `Expired claim recovered after host-confirmed stop: ${recovery.reason}`,
    });
  } else {
    const heartbeat = QUALITY_SCHEMAS.heartbeat.parse(input);
    stage.heartbeatAt = now();
    stage.progress = heartbeat.message;
    quality.events.push({
      at: stage.heartbeatAt,
      step: stage.id,
      message: heartbeat.message,
    });
  }
  quality.events = quality.events.slice(-256);
  return { step: stage.id, status: stage.status, fingerprint: current };
}

export function qualitySnapshot(
  run: WorkflowRun,
  current = run.scope.fingerprint,
) {
  const reports = [
    ...run.stages.flatMap((stage) =>
      stage.result ? [{ owner: stage.id, result: stage.result }] : [],
    ),
    ...(run.collaboration?.submissions
      .filter((s) => !s.supersededBy)
      .flatMap((s) =>
        s.review ? [{ owner: s.reviewer, result: s.review.result }] : [],
      ) ?? []),
  ];
  const findings = evaluate(
    run.config.policies[run.config.workflows[run.workflow].policy],
    reports,
  ).findings;
  return {
    run: run.id,
    workflow: run.workflow,
    level: run.quality?.level ?? "legacy",
    reason: run.quality?.reason,
    governance: run.quality?.governance,
    capture: run.quality?.capture,
    outcome: run.quality?.outcome,
    status: run.status,
    fingerprint: current,
    roles: run.stages.map((stage) => ({
      ...agentState(run, stage),
      id: stage.id,
      status: stage.status,
      progress: stage.progress,
      claim: stage.claim,
      childId: stage.childId,
      ...stageLease(run, stage),
      requestedModel:
        stage.agent && run.owner
          ? resolveAgentProfile(run.config.agents[stage.agent], run.owner.agent)
              .model
          : undefined,
      declaredModel: run.quality?.capabilities
        ? (run.quality.capabilities.modelOverrides[stage.id] ??
          (stage.agent && run.owner
            ? resolveAgentProfile(
                run.config.agents[stage.agent],
                run.owner.agent,
              ).model
            : undefined))
        : undefined,
      error: stage.error,
    })),
    criteria: criterionResults(run, current),
    research: run.quality?.research,
    receipts: run.quality?.receipts ?? [],
    capabilities: run.quality?.capabilities,
    capabilitySource: run.quality?.capabilitySource,
    blockers: [
      ...qualityBlockers(run, current),
      ...findings
        .filter(
          (f) => !f.disposition && (f.required || f.severity === "critical"),
        )
        .map(
          (f) =>
            `${f.severity.toUpperCase()} · ${f.title} · ${f.file}:${f.line}`,
        ),
      ...run.stages
        .filter((s) => s.status === "failed" || s.status === "blocked")
        .map((s) => `${s.id}: ${s.error ?? s.status}`),
    ],
    findings,
    events: run.quality?.events ?? [],
    source: "parent-reported" as const,
  };
}
