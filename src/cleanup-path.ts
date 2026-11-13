import {
  assertSafeRelativeCleanupPath,
  isProtectedCleanupSegment,
} from "./core/protected-paths.js";

/** Metadata, credentials, and task instructions are never cleanup targets. */
export function protectedCleanupName(name: string): boolean {
  return isProtectedCleanupSegment(name);
}

export function validateCleanupPath(value: unknown): asserts value is string {
  assertSafeRelativeCleanupPath(value);
}
