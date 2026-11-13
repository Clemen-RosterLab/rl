import { z } from "zod";
import { ReviewResultSchema } from "./automation.js";
import {
  AgentNameSchema,
  GitOidSchema,
  Sha256HexSchema,
  StrictLowerUuidSchema,
} from "./common.js";

export const SnapshotSchema = z.looseObject({
  baseline: GitOidSchema.optional(),
  id: StrictLowerUuidSchema,
  at: z.string().min(1),
  branch: z.string().min(1),
  head: z.union([z.literal(""), GitOidSchema]),
  headTree: GitOidSchema,
  indexTree: GitOidSchema,
  worktreeTree: GitOidSchema,
  stages: z.array(GitOidSchema).length(3),
  indexHash: z.string().min(1),
  fingerprint: z.string().min(1),
  stable: z.boolean(),
  complete: z.boolean(),
  untracked: z.array(z.string()),
  excluded: z.array(z.string()),
  conflicts: z.array(z.string()),
});

export const ReviewCheckpointSchema = z.strictObject({
  id: StrictLowerUuidSchema,
  snapshot: StrictLowerUuidSchema,
  at: z.string().min(1),
  label: z.string(),
  approved: z.boolean(),
  pr: z.number().int().safe().min(1).optional(),
});

export const ReviewFeedbackEntrySchema = z.strictObject({
  id: StrictLowerUuidSchema,
  at: z.string().min(1),
  snapshot: StrictLowerUuidSchema,
  fingerprint: Sha256HexSchema,
  text: z.string(),
  agent: AgentNameSchema.optional(),
  sessionId: StrictLowerUuidSchema.optional(),
  status: z.enum(["saved", "opened", "delivered", "failed"]),
  error: z.string().optional(),
  output: z.string().optional(),
});

export const ReviewAnalysisMetaSchema = z.strictObject({
  id: StrictLowerUuidSchema,
  snapshot: StrictLowerUuidSchema,
  at: z.string().min(1),
  kind: z.enum(["summary", "review"]),
  provider: AgentNameSchema,
});

export const ReviewHistoryEntrySchema = z.strictObject({
  at: z.string().min(1),
  action: z.string(),
  snapshot: z.string().optional(),
});

export const ReviewStateSchema = z.looseObject({
  version: z.literal(1),
  baseline: z
    .looseObject({
      commit: GitOidSchema,
      ref: z.string(),
      at: z.string(),
      source: z.enum(["creation", "explicit"]),
    })
    .optional(),
  viewing: StrictLowerUuidSchema.optional(),
  viewingFingerprint: z.string().optional(),
  ready: z.string().optional(),
  reviewedFingerprint: Sha256HexSchema.optional(),
  approval: z
    .strictObject({
      snapshot: StrictLowerUuidSchema,
      fingerprint: z.string().min(1),
      at: z.string().min(1),
    })
    .optional(),
  checkpoints: z.array(ReviewCheckpointSchema),
  feedback: z.array(ReviewFeedbackEntrySchema),
  analyses: z.array(ReviewAnalysisMetaSchema),
  history: z.array(ReviewHistoryEntrySchema),
});

const BoundedAnalysisStrings = z.array(z.string().max(16000)).max(100);

export const AnalysisGroupSchema = z.strictObject({
  title: z.string(),
  explanation: z.string(),
  members: z.array(z.string()).max(1000),
  concerns: BoundedAnalysisStrings,
});

export const AnalysisPayloadSchema = z.strictObject({
  overview: z
    .string()
    .max(32000)
    .refine((v) => v.trim().length > 0, "Expected non-empty overview"),
  architecture: BoundedAnalysisStrings,
  behavior: BoundedAnalysisStrings,
  testing: BoundedAnalysisStrings,
  concerns: BoundedAnalysisStrings,
  groups: z.array(AnalysisGroupSchema).max(50),
  review: ReviewResultSchema,
});

export const SavedAnalysisDiskSchema = AnalysisPayloadSchema.extend({
  id: StrictLowerUuidSchema,
  snapshot: StrictLowerUuidSchema,
  fingerprint: z.string().min(1),
  at: z.string().min(1),
  provider: AgentNameSchema,
  kind: z.enum(["summary", "review"]),
  limitations: z.array(z.string()),
  stale: z.boolean(),
});

export const LiveCheckpointSchema = z.strictObject({
  branch: z.string(),
  head: z.string(),
  tree: GitOidSchema,
  index: GitOidSchema,
  label: z.string(),
});
