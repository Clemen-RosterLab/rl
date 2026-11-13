import { z } from "zod";
import {
  AutomationConfigSchema,
  RelativeWorkspaceFileSchema,
  ReviewPolicySchema,
  ReviewResultSchema,
  RoutingLeadSchema,
} from "./automation.js";
import {
  AgentNameSchema,
  proseSchema,
  StrictLowerUuidSchema,
} from "./common.js";

const UniqueBoundedStringsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(512)
      .refine((v) => !/[\x00-\x1f]/.test(v), "Invalid string entry"),
  )
  .max(256)
  .refine(
    (items) => new Set(items).size === items.length,
    "Expected unique entries",
  );

export const ConsultationEntrySchema = z.strictObject({
  id: StrictLowerUuidSchema,
  from: proseSchema(16000, "from"),
  to: proseSchema(16000, "to"),
  event: proseSchema(16000, "event"),
  subject: proseSchema(16000, "subject"),
  question: proseSchema(16000, "question"),
  createdAt: proseSchema(100, "record timestamp"),
  answer: z
    .strictObject({
      text: proseSchema(16000, "answer"),
      at: proseSchema(100, "answer timestamp"),
    })
    .optional(),
});

export const SubmissionReviewSchema = z.strictObject({
  rating: z.number().finite(),
  rationale: proseSchema(16000, "rating rationale"),
  result: ReviewResultSchema,
  duplicateSuspicions: UniqueBoundedStringsSchema,
  accepted: z.boolean(),
  at: z.string().min(1),
});

export const SubmissionEntrySchema = z.strictObject({
  id: StrictLowerUuidSchema,
  writer: proseSchema(16000, "writer"),
  reviewer: proseSchema(16000, "reviewer"),
  files: UniqueBoundedStringsSchema.pipe(z.array(RelativeWorkspaceFileSchema)),
  newFunctions: UniqueBoundedStringsSchema,
  summary: proseSchema(16000, "summary"),
  fingerprint: proseSchema(16000, "fingerprint"),
  snapshot: proseSchema(16000, "snapshot"),
  createdAt: proseSchema(100, "record timestamp"),
  round: z.number().int().safe().min(1),
  supersededBy: StrictLowerUuidSchema.optional(),
  review: SubmissionReviewSchema.optional(),
});

export const CollaborationStateSchema = z
  .strictObject({
    consultations: z.array(ConsultationEntrySchema).max(256),
    submissions: z.array(SubmissionEntrySchema).max(128),
    baseline: z.record(z.string(), z.string()),
  })
  .refine((state) => {
    const ids = new Set<string>();
    for (const item of [...state.consultations, ...state.submissions]) {
      if (ids.has(item.id)) return false;
      ids.add(item.id);
    }
    return true;
  }, "Invalid or duplicate collaboration record");

export const StageUsageSchema = z.strictObject({
  inputTokens: z.number().finite().min(0).nullable(),
  outputTokens: z.number().finite().min(0).nullable(),
  costUsd: z.number().finite().min(0).nullable(),
});

export const StageCheckOutputSchema = z
  .strictObject({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().safe(),
  })
  .refine(
    (check) => check.stdout.length + check.stderr.length <= 256000,
    "Check output exceeds 256000 characters",
  );

export const WorkflowStageDiskSchema = z.looseObject({
  id: z.string().regex(/^(?:followup-)?[a-z][a-z0-9_-]{0,63}$/),
  after: z.array(z.string()),
  agent: z.string().optional(),
  command: z.array(z.string()).optional(),
  claim: StrictLowerUuidSchema.optional(),
  startedAt: z
    .string()
    .refine(
      (val) => Number.isFinite(Date.parse(val)),
      "Invalid stage start time",
    )
    .optional(),
  childId: z.string().optional(),
  scopeFingerprint: z.string().optional(),
  status: z.enum(["pending", "running", "completed", "failed", "blocked"]),
  attempts: z.number().int().safe().min(0),
  durationMs: z.number().min(0),
  error: z.string().optional(),
  result: ReviewResultSchema.optional(),
  usage: StageUsageSchema.optional(),
  check: StageCheckOutputSchema.optional(),
  leads: z.array(RoutingLeadSchema).optional(),
});

export const WorkflowRunDiskSchema = z.looseObject({
  version: z.literal(1),
  execution: z.literal("native").optional(),
  owner: z
    .strictObject({
      agent: AgentNameSchema,
      sessionId: z.string().min(1),
    })
    .optional(),
  requestId: StrictLowerUuidSchema.optional(),
  id: StrictLowerUuidSchema,
  key: z.string().min(1),
  workspace: z.string().min(1),
  branch: z.string().min(1),
  workflow: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  status: z.enum(["running", "paused", "cancelled", "completed"]),
  controlRequested: z.enum(["pause", "cancel"]).nullable(),
  config: AutomationConfigSchema,
  scope: z.strictObject({
    base: z.string(),
    baseCommit: z.string(),
    head: z.string(),
    fingerprint: z.string(),
    files: z.array(z.string()),
  }),
  prompt: z.string(),
  stages: z.array(WorkflowStageDiskSchema),
  routed: z.boolean(),
  evaluation: z.unknown().optional(),
  assessments: z.array(
    z.looseObject({
      at: z.string(),
      policyName: z.string(),
      policy: ReviewPolicySchema,
      evaluation: z.unknown(),
    }),
  ),
  collaboration: CollaborationStateSchema.optional(),
});

export const WorkflowRequestDiskSchema = z.strictObject({
  id: StrictLowerUuidSchema,
  agent: AgentNameSchema,
  sessionId: z.string().min(1),
  workflow: z.string().min(1),
  event: z.string().min(1),
  fingerprint: z.string().min(1),
  createdAt: z.string().min(1),
  runId: StrictLowerUuidSchema.optional(),
  dismissed: z.string().optional(),
  tool: z.string().optional(),
  paths: z.array(z.string()).optional(),
});

export const WorkflowEventsFileSchema = z.strictObject({
  version: z.literal(1),
  requests: z.array(WorkflowRequestDiskSchema).max(128),
});
