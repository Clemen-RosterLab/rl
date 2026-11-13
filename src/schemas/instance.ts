import { z } from "zod";
import {
  AbsolutePathSchema,
  AgentNameSchema,
  AGENTS,
  GitOidSchema,
  IsoTimestampSchema,
  StrictLowerUuidSchema,
} from "./common.js";

export const MAX_HANDOFF_TEXT = 16000;
export const HANDOFF_FIELDS = [
  "summary",
  "changes",
  "validation",
  "next",
  "blockers",
] as const;

export const SessionSchema = z.strictObject({
  id: StrictLowerUuidSchema,
  createdAt: IsoTimestampSchema,
  lastUsedAt: IsoTimestampSchema,
});

function uniqueSessionList() {
  return z
    .array(SessionSchema)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "Duplicate session ID in instance metadata",
    );
}

export const ActivityEntrySchema = z.strictObject({
  sessionId: z.string().min(1),
  childId: z.string().min(1).optional(),
  state: z.enum(["idle", "working", "ended"]),
  lastEvent: z.string().min(1),
  observedAt: IsoTimestampSchema,
  resumable: z.boolean(),
  contextHash: z.string().optional(),
});

export const HookHealthSchema = z.strictObject({
  lastSuccess: z
    .strictObject({
      event: z.string(),
      at: IsoTimestampSchema,
    })
    .optional(),
  lastError: z
    .strictObject({
      message: z.string(),
      at: IsoTimestampSchema,
    })
    .optional(),
});

export const HandoffNotesInputSchema = z
  .looseObject({
    summary: z.string(),
    changes: z.string(),
    validation: z.string(),
    next: z.string(),
    blockers: z.string().optional(),
  })
  .transform((raw, ctx) => {
    const cleaned = {
      summary: raw.summary.trim(),
      changes: raw.changes.trim(),
      validation: raw.validation.trim(),
      next: raw.next.trim(),
      blockers: (raw.blockers ?? "").trim(),
    };
    for (const field of HANDOFF_FIELDS) {
      const val = raw[field] ?? (field === "blockers" ? "" : "");
      if (val.includes("\0") || (field !== "blockers" && !cleaned[field])) {
        ctx.addIssue({
          code: "custom",
          message: `Handoff ${field} must be non-empty text (use 'Not run' for unperformed validation)`,
        });
        return z.NEVER;
      }
    }
    if (Object.values(cleaned).join("\n").length > MAX_HANDOFF_TEXT) {
      ctx.addIssue({
        code: "custom",
        message: `Handoff text must be at most ${MAX_HANDOFF_TEXT} characters`,
      });
      return z.NEVER;
    }
    return cleaned;
  });

export const TaskHandoffSchema = z
  .strictObject({
    id: StrictLowerUuidSchema,
    agent: AgentNameSchema,
    sessionId: StrictLowerUuidSchema,
    savedAt: IsoTimestampSchema,
    summary: z.string(),
    changes: z.string(),
    validation: z.string(),
    next: z.string(),
    blockers: z.string(),
  })
  .superRefine((val, ctx) => {
    const check = HandoffNotesInputSchema.safeParse(val);
    if (!check.success) {
      ctx.addIssue({
        code: "custom",
        message: check.error.issues[0]?.message ?? "Invalid task handoff notes",
      });
    }
  });

export const TaskStateSchema = z
  .strictObject({
    state: z.enum(["paused", "active"]),
    handoffs: z.array(TaskHandoffSchema).min(1),
    continuedAt: IsoTimestampSchema.optional(),
  })
  .refine(
    (task) =>
      new Set(task.handoffs.map((item) => item.id)).size ===
      task.handoffs.length,
    "Duplicate task handoff ID",
  );

function agentRecordSchema<T extends z.ZodType>(valueSchema: T) {
  return z
    .record(z.string(), valueSchema)
    .refine(
      (rec) =>
        Object.keys(rec).every((key) =>
          (AGENTS as readonly string[]).includes(key),
        ),
      "Unknown agent key",
    );
}

/**
 * Uses `looseObject` so future unknown properties in `instance.json` survive round-trip writes,
 * while all known fields are strictly validated at the persistence boundary.
 */
export const InstanceDiskSchema = z.looseObject({
  schemaVersion: z.literal(1),
  key: z.string().min(1),
  id: z.string().min(1),
  repository: AbsolutePathSchema,
  branch: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  startingCommit: GitOidSchema.optional(),
  reviewBaseCommit: GitOidSchema.optional(),
  worktree: AbsolutePathSchema,
  status: z.enum(["active", "deleted"]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deletedAt: z.string().min(1).optional(),
  lastAccessedAt: z.string().min(1).optional(),
  sessions: z.looseObject({
    codex: uniqueSessionList(),
    claude: uniqueSessionList(),
    agy: uniqueSessionList().optional(),
  }),
  pr: z.union([z.null(), z.looseObject({ url: z.string() })]),
  hookCommands: z
    .object({
      codex: z.string(),
      claude: z.string(),
      agy: z.string(),
    })
    .partial()
    .optional(),
  extendedHooks: z.boolean().optional(),
  task: TaskStateSchema.optional(),
  activity: agentRecordSchema(z.array(ActivityEntrySchema)).optional(),
  hookHealth: agentRecordSchema(HookHealthSchema).optional(),
});

const RepoAliasNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid repository alias");

const NoNewlinePathSchema = AbsolutePathSchema.refine(
  (val) => !/[\r\n]/.test(val),
  "Path must not contain newlines",
);

export const RepositoryEntrySchema = z.strictObject({
  root: NoNewlinePathSchema,
  commonDir: NoNewlinePathSchema,
  worktreeName: RepoAliasNameSchema,
  base: z
    .string()
    .min(1)
    .refine((val) => !/[\r\n]/.test(val), "Base must not contain newlines"),
});

export const RegistryDataSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    default: z.string().nullable(),
    repositories: z.record(RepoAliasNameSchema, RepositoryEntrySchema),
  })
  .superRefine((data, ctx) => {
    const roots = new Set<string>();
    const dirs = new Set<string>();
    for (const repo of Object.values(data.repositories)) {
      if (roots.has(repo.root)) {
        ctx.addIssue({ code: "custom", message: "Duplicate repository root" });
        return;
      }
      if (dirs.has(repo.worktreeName)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate repository worktree directory",
        });
        return;
      }
      roots.add(repo.root);
      dirs.add(repo.worktreeName);
    }
    if (
      data.default !== null &&
      !Object.hasOwn(data.repositories, data.default)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Default repository is not registered",
      });
    }
  });
