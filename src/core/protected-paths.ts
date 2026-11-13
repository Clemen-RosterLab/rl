import path from "node:path";

export const RESERVED_META_DIRECTORIES = new Set([
  ".git",
  ".rl",
  ".codex",
  ".claude",
  ".agents",
]);

export const DEPENDENCY_DIRECTORIES = new Set([
  "node_modules",
  ".venv",
  "venv",
]);

export const BUILD_AND_CACHE_DIRECTORIES = new Set([
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".tmp",
  "tmp",
  "temp",
  "dist",
  "build",
  "coverage",
  ".vite",
  "out",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".parcel-cache",
  ".svelte-kit",
]);

const PROTECTED_LOWERCASE_NAMES = new Set([
  ...RESERVED_META_DIRECTORIES,
  ".ssh",
  ".aws",
  ".azure",
  ".config",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  "agents.md",
  "claude.md",
]);

const SENSITIVE_NAME_PATTERN =
  /^(?:\.env(?:\.|$)|credentials(?:\.|$)|secrets(?:\.|$)|\.rl-clean-)/i;

const SNAPSHOT_EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".codex",
  ".claude",
  ".agents",
  ".ssh",
  ".aws",
  ".azure",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ...DEPENDENCY_DIRECTORIES,
]);

const SNAPSHOT_SENSITIVE_PATTERN =
  /^(?:\.env(?:\.|$)|credentials(?:\.|$)|secrets(?:\.|$))/i;

const WATCH_IGNORED_SEGMENTS = new Set([
  ".git",
  ...DEPENDENCY_DIRECTORIES,
  ...BUILD_AND_CACHE_DIRECTORIES,
]);

/** Metadata, credentials, and agent instructions are never cleanup targets. */
export function isProtectedCleanupSegment(name: string): boolean {
  return (
    PROTECTED_LOWERCASE_NAMES.has(name.toLowerCase()) ||
    SENSITIVE_NAME_PATTERN.test(name)
  );
}

/** Untracked secrets, agent metadata, and dependency trees omitted from snapshots/scopes. */
export function isExcludedUntrackedPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some(
      (part) =>
        SNAPSHOT_SENSITIVE_PATTERN.test(part) ||
        SNAPSHOT_EXCLUDED_SEGMENTS.has(part),
    );
}

/** Generated/dependency directories skipped by live source directory watchers. */
export function isIgnoredWatchDirectory(name: string): boolean {
  return WATCH_IGNORED_SEGMENTS.has(name);
}

export function assertSafeRelativeCleanupPath(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    path.isAbsolute(value) ||
    /[\x00-\x1f\x7f\\*?[\]{}]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          isProtectedCleanupSegment(part),
      )
  ) {
    throw new Error(`Unsafe cleanup path: ${String(value)}`);
  }
}
