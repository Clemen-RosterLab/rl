import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { canonical, gitRaw, inside, now } from "../common.js";
import {
  proseSchema,
  RelativeWorkspaceFileSchema,
  StrictLowerUuidSchema,
} from "../schemas/common.js";
import type { WorkflowRun } from "../agent-runner.js";

export const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const CheckIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const ArgvSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(4000)
      .refine((arg) => !arg.includes("\0")),
  )
  .min(1)
  .max(128);
const EvidenceScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("repository") }),
  z.strictObject({
    kind: z.literal("files"),
    files: z.array(RelativeWorkspaceFileSchema).min(1).max(128),
    dependencies: z.array(RelativeWorkspaceFileSchema).max(128),
    rationale: proseSchema(4000, "explicit dependency coverage rationale"),
  }),
]);
export const PlannedCheckSchema = z
  .strictObject({
    id: CheckIdSchema,
    expected: proseSchema(4000, "expected observable outcome"),
    command: ArgvSchema.optional(),
    mode: z.enum(["any", "static", "mocked", "live"]).default("any"),
    source: z.enum(["reported", "captured"]).default("reported"),
    scope: EvidenceScopeSchema.default({ kind: "repository" }),
  })
  .refine(
    (check) => check.source !== "captured" || Boolean(check.command),
    "Captured checks require the exact planned command",
  );
export const CriterionSchema = z.strictObject({
  id: CheckIdSchema,
  text: proseSchema(4000, "acceptance criterion"),
  required: z.boolean().default(true),
  validation: z.enum(["any", "mocked", "live"]).default("any"),
  checks: z.array(PlannedCheckSchema).min(1).max(16).optional(),
});
export const ReceiptInputSchema = z.strictObject({
  criteria: z.array(z.string()).min(1).max(64),
  check: CheckIdSchema.optional(),
  command: ArgvSchema,
  cwd: z
    .string()
    .min(1)
    .refine(
      (value) => path.isAbsolute(value) && !value.includes("\0"),
      "Validation cwd must be absolute",
    ),
  exitCode: z.number().int(),
  mode: z.enum(["mocked", "live", "static"]),
  fingerprint: FingerprintSchema,
  files: z.array(RelativeWorkspaceFileSchema).max(256),
  artifacts: z.array(RelativeWorkspaceFileSchema).max(64),
  stdout: z.string().max(128000),
  stderr: z.string().max(128000),
  durationMs: z.number().min(0).max(86400000),
});
export const ReceiptSchema = ReceiptInputSchema.extend({
  id: StrictLowerUuidSchema,
  at: z.string(),
  source: z.enum(["parent-reported", "command-captured"]),
  scoped: z
    .strictObject({
      fingerprint: FingerprintSchema,
      files: z.array(RelativeWorkspaceFileSchema).max(256),
    })
    .optional(),
  inheritedFrom: StrictLowerUuidSchema.optional(),
  invalidated: z.boolean().optional(),
});
export const CaptureSchema = z.strictObject({
  run: z.string().min(1),
  check: CheckIdSchema,
  command: ArgvSchema,
  cwd: z.string().min(1),
  mode: z.enum(["static", "mocked", "live"]),
  timeoutMs: z.number().int().min(50).max(600000).default(120000),
});
export const PendingCaptureSchema = CaptureSchema.omit({ run: true }).extend({
  id: StrictLowerUuidSchema,
  startedAt: z.string(),
  fingerprint: FingerprintSchema,
  scoped: ReceiptSchema.shape.scoped,
});

export function assertPlan(criteria: z.infer<typeof CriterionSchema>[]) {
  if (new Set(criteria.map((c) => c.id)).size !== criteria.length)
    throw new Error("Acceptance criterion IDs must be unique");
  const ids = criteria.flatMap((c) => c.checks?.map((check) => check.id) ?? []);
  if (new Set(ids).size !== ids.length)
    throw new Error("Validation check IDs must be unique across criteria");
  if (ids.length > 128) throw new Error("Validation plan exceeds 128 checks");
}

export function plannedCheck(run: WorkflowRun, id: string) {
  const criterion = run.quality?.criteria.find((c) =>
    c.checks?.some((candidate) => candidate.id === id),
  );
  const check = criterion?.checks?.find((check) => check.id === id);
  if (!criterion || !check) throw new Error("Unknown planned validation check");
  return { criterion, check };
}

/** Explicit coverage only: callers/configuration must be listed by the coordinator.
 * Unknown dependency coverage always keeps the repository fingerprint fallback. */
export function scopedFingerprint(
  run: WorkflowRun,
  files: readonly string[],
): string {
  const unique = [...new Set(files)].sort();
  let bytes = 0;
  const versions = unique.map((file) => {
    RelativeWorkspaceFileSchema.parse(file);
    const absolute = path.join(run.workspace, file);
    let component = run.workspace;
    for (const part of file.split("/")) {
      component = path.join(component, part);
      const entry = fs.lstatSync(component, { throwIfNoEntry: false });
      if (
        entry?.isSymbolicLink() &&
        (!fs.existsSync(component) ||
          (canonical(component) !== run.workspace &&
            !inside(canonical(component), run.workspace)))
      )
        throw new Error(
          "Validation paths must remain in this workspace; dangling or external symlinks cannot establish dependency coverage",
        );
    }
    if (!inside(canonical(absolute), run.workspace))
      throw new Error("Validation paths must remain in this workspace");
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stat && !stat.isFile() && !stat.isSymbolicLink())
      throw new Error(
        "Validation dependency scopes require files, not directories",
      );
    if (stat && (bytes += stat.size) > 4 * 1024 * 1024)
      throw new Error("Validation dependency scope exceeds 4 MiB");
    return {
      file,
      mode: stat ? stat.mode & 0o777 : null,
      kind: !stat ? "missing" : stat.isSymbolicLink() ? "symlink" : "file",
      content: !stat
        ? null
        : stat.isSymbolicLink()
          ? fs.readlinkSync(absolute)
          : fs.readFileSync(absolute).toString("base64"),
    };
  });
  const index = gitRaw(
    run.workspace,
    "--literal-pathspecs",
    "ls-files",
    "--stage",
    "-z",
    "--",
    ...unique,
  );
  return createHash("sha256")
    .update(JSON.stringify({ base: run.scope.baseCommit, versions, index }))
    .digest("hex");
}

export function checkScope(
  run: WorkflowRun,
  check: z.infer<typeof PlannedCheckSchema>,
) {
  if (check.scope.kind !== "files") return undefined;
  const files = [
    ...new Set([...check.scope.files, ...check.scope.dependencies]),
  ].sort();
  return { files, fingerprint: scopedFingerprint(run, files) };
}

export function receiptCurrent(
  run: WorkflowRun,
  receipt: z.infer<typeof ReceiptSchema>,
  current: string,
): boolean {
  if (receipt.invalidated) return false;
  // Explicit scopes may include ignored configuration that the Git-wide identity
  // cannot see. Always validate their captured inputs, even when Git is unchanged.
  if (!receipt.check || !receipt.scoped) return receipt.fingerprint === current;
  try {
    const scope = checkScope(run, plannedCheck(run, receipt.check).check);
    return Boolean(
      scope &&
      isDeepStrictEqual(scope.files, receipt.scoped.files) &&
      scope.fingerprint === receipt.scoped.fingerprint,
    );
  } catch {
    return false;
  }
}

export function saveReceipt(
  run: WorkflowRun,
  raw: unknown,
  current: string,
  source: z.infer<typeof ReceiptSchema>["source"] = "parent-reported",
  scoped?: z.infer<typeof ReceiptSchema>["scoped"],
) {
  if (!run.quality) throw new Error("Validation requires a leveled workflow");
  const receipt = ReceiptInputSchema.parse(raw),
    quality = run.quality;
  if (receipt.fingerprint !== current)
    throw new Error(
      "Validation source changed; run the check again against the current fingerprint",
    );
  if (receipt.criteria.some((id) => !quality.criteria.some((c) => c.id === id)))
    throw new Error("Validation references an unknown acceptance criterion");
  if (
    canonical(receipt.cwd) !== run.workspace &&
    !inside(canonical(receipt.cwd), run.workspace)
  )
    throw new Error(
      "Validation cwd must remain inside this run's exact workspace",
    );
  for (const filename of [...receipt.files, ...receipt.artifacts])
    if (!inside(canonical(path.join(run.workspace, filename)), run.workspace))
      throw new Error("Validation paths must remain in this workspace");
  if (quality.governance && !receipt.check)
    throw new Error("Validation must identify an individual planned check");
  if (receipt.check) {
    const { criterion, check } = plannedCheck(run, receipt.check);
    if (receipt.criteria.length !== 1 || receipt.criteria[0] !== criterion.id)
      throw new Error(
        "A check receipt must identify its own acceptance criterion",
      );
    if (check.command && !isDeepStrictEqual(check.command, receipt.command))
      throw new Error("Validation command does not match the planned check");
    if (
      (check.mode !== "any" && check.mode !== receipt.mode) ||
      (criterion.validation !== "any" && criterion.validation !== receipt.mode)
    )
      throw new Error(
        "Validation mode does not match the planned criterion/check",
      );
    if (check.source === "captured" && source !== "command-captured")
      throw new Error("This check requires captured command evidence");
    // Self-reported checks retain full-repository invalidation: they cannot attest when scoped input was captured.
    scoped = source === "command-captured" ? scoped : undefined;
  }
  if (quality.receipts.length >= 128)
    throw new Error("Validation receipt limit reached");
  const saved = {
    ...receipt,
    id: randomUUID(),
    at: now(),
    source,
    ...(scoped ? { scoped } : {}),
  };
  quality.receipts.push(saved);
  return saved;
}

export function criterionResults(
  run: WorkflowRun,
  current = run.scope.fingerprint,
) {
  return (run.quality?.criteria ?? []).map((criterion) => {
    const receipts = (run.quality?.receipts ?? []).filter((r) =>
      r.criteria.includes(criterion.id),
    );
    const checks = (criterion.checks ?? []).map((check) => {
      const latest = receipts.filter((r) => r.check === check.id).at(-1);
      const valid =
        latest &&
        receiptCurrent(run, latest, current) &&
        (criterion.validation === "any" ||
          criterion.validation === latest.mode) &&
        (check.mode === "any" || check.mode === latest.mode) &&
        (check.source !== "captured" || latest.source === "command-captured") &&
        (!check.command || isDeepStrictEqual(check.command, latest.command));
      return {
        ...check,
        status: validationStatus(Boolean(valid), latest?.exitCode),
        stale: Boolean(latest && !valid),
        receipt: latest?.id,
      };
    });
    // Legacy records retain their original single-receipt semantics.
    const latest = receipts
      .filter(
        (r) =>
          !r.invalidated &&
          r.fingerprint === current &&
          (criterion.validation === "any" || r.mode === criterion.validation),
      )
      .at(-1);
    let status: "unverified" | "passed" | "failed" = "unverified";
    if (checks.length) {
      if (checks.some((c) => c.status === "failed")) status = "failed";
      else if (checks.every((c) => c.status === "passed")) status = "passed";
    } else if (!run.quality?.governance)
      status = validationStatus(Boolean(latest), latest?.exitCode);
    return {
      ...criterion,
      checks,
      status,
      receipts: receipts.map((r) => r.id),
      stale: checks.length
        ? checks.some((c) => c.stale)
        : receipts.length > 0 && !latest,
    };
  });
}

function validationStatus(
  valid: boolean,
  exitCode?: number,
): "unverified" | "passed" | "failed" {
  if (!valid) return "unverified";
  return exitCode === 0 ? "passed" : "failed";
}
