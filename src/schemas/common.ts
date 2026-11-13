import path from "node:path";
import { z } from "zod";
import { sessionId, timestamp } from "../common.js";
import { StateValidationError } from "../errors.js";

export const AGENTS = ["codex", "claude", "agy"] as const;
export const AgentNameSchema = z.enum(AGENTS);

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const SeveritySchema = z.enum(SEVERITIES);

export const GIT_OID_REGEX = /^[a-f0-9]{40,64}$/;
export const GitOidSchema = z.string().regex(GIT_OID_REGEX, "Expected Git OID");

export const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;
export const Sha256HexSchema = z
  .string()
  .regex(SHA256_HEX_REGEX, "Expected SHA-256 hex digest");

export const IdentifierSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,63}$/,
    "Expected an identifier using lowercase letters, numbers, hyphens or underscores",
  )
  .refine(
    (val) => val !== "constructor" && !val.startsWith("followup-"),
    "Reserved identifier",
  );

export const UuidSchema = z.string().transform((val, ctx) => {
  try {
    const normalized = sessionId(val);
    if (normalized !== val) {
      // Callers expecting canonical lowercase UUIDs on disk reject uppercase unless normalized.
      return normalized;
    }
    return normalized;
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid UUID",
    });
    return z.NEVER;
  }
});

export const StrictLowerUuidSchema = z.string().refine((val) => {
  try {
    return sessionId(val) === val;
  } catch {
    return false;
  }
}, "Expected lowercase canonical UUID");

export const IsoTimestampSchema = z.string().refine((val) => {
  try {
    timestamp(val);
    return true;
  } catch {
    return false;
  }
}, "Invalid ISO timestamp");

export const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((val) => path.isAbsolute(val), "Expected an absolute path");

export function proseSchema(maxLength = 16000, label = "nonempty text") {
  return z
    .string()
    .max(maxLength, `Expected ${label} (up to ${maxLength} characters)`)
    .refine(
      (val) => val.trim().length > 0 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(val),
      `Expected ${label}`,
    );
}

export function nonNullTextSchema(maxLength = 64000, label = "nonempty text") {
  return z
    .string()
    .max(maxLength, `Expected ${label} (up to ${maxLength} characters)`)
    .refine(
      (val) => val.trim().length > 0 && !val.includes("\0"),
      `Expected ${label}`,
    );
}

export const RelativeWorkspaceFileSchema = proseSchema(
  1024,
  "relative workspace path",
).refine(
  (val) =>
    !path.isAbsolute(val) &&
    !val.includes("\\") &&
    !/[\r\n]/.test(val) &&
    !val
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part === ".git",
      ),
  "Paths must be relative files inside this workspace",
);

export function toCleanJsonSchema(
  schema: z.ZodType,
  io: "input" | "output" = "input",
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    io,
    reused: "inline",
    unrepresentable: "any",
    override({ jsonSchema }) {
      const target = jsonSchema as Record<string, unknown>;
      delete target.maxLength;
      delete target.minLength;
      delete target.maxItems;
      delete target.minItems;
      if (target.maximum === Number.MAX_SAFE_INTEGER) {
        delete target.maximum;
      }
      if (target.minimum === Number.MIN_SAFE_INTEGER) {
        delete target.minimum;
      }
    },
  });
  const plain = JSON.parse(JSON.stringify(generated)) as Record<
    string,
    unknown
  >;
  delete plain.$schema;
  return plain;
}

export function parseWithStateError<T>(
  schema: z.ZodType<T>,
  data: unknown,
  fallbackMessage: string,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const detail = issue?.message
      ? `${fallbackMessage}: ${issue.message}`
      : fallbackMessage;
    throw new StateValidationError(detail);
  }
  return result.data;
}
