import path from "node:path";

/** Metadata, credentials, and task instructions are never cleanup targets. */
export function protectedCleanupName(name: string): boolean {
  return (
    [
      ".git",
      ".rl",
      ".codex",
      ".claude",
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
    ].includes(name.toLowerCase()) ||
    /^(?:\.env(?:\.|$)|credentials(?:\.|$)|secrets(?:\.|$)|\.rl-clean-)/i.test(
      name,
    )
  );
}

export function validateCleanupPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    path.isAbsolute(value) ||
    /[\x00-\x1f\x7f\\*?\[\]{}]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || protectedCleanupName(part),
      )
  )
    throw new Error(`Unsafe cleanup path: ${String(value)}`);
}
