import { canonical, git } from "../common.js";

export interface ResolvedBaseRef {
  ref: string;
  oid: string;
}

export function resolveCommitOid(cwd: string, ref: string): string | null {
  try {
    return git(
      cwd,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    );
  } catch {
    return null;
  }
}

export function gitCommonDir(cwd: string): string {
  return canonical(
    git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
}

/**
 * Resolve a base branch or commit from cached local/remote refs without fetching.
 * `prefer: "local"` tries the requested name first, then `origin/<name>` (or strips `origin/`).
 * `prefer: "remote"` canonicalizes against configured remotes so pruned remotes cannot masquerade as local refs.
 */
export function resolveBaseRef(
  repo: string,
  requested: string,
  options: {
    prefer?: "local" | "remote";
    remotes?: readonly string[];
    allowLocalFallbackForExplicitOrigin?: boolean;
  } = {},
): ResolvedBaseRef | null {
  const prefer = options.prefer ?? "local";

  if (prefer === "remote" && options.remotes) {
    const remotes = options.remotes;
    let candidates: string[];
    if (requested.startsWith("refs/")) {
      candidates = [requested];
    } else if (
      requested.startsWith("origin/") ||
      remotes.some((remote) => requested.startsWith(`${remote}/`))
    ) {
      candidates = [`refs/remotes/${requested}`];
    } else {
      candidates = [
        ...(remotes.includes("origin")
          ? [`refs/remotes/origin/${requested}`]
          : []),
        `refs/heads/${requested}`,
        requested,
      ];
    }

    for (const candidate of candidates) {
      if (
        candidate.startsWith("refs/remotes/") &&
        !remotes.some((remote) =>
          candidate.startsWith(`refs/remotes/${remote}/`),
        )
      ) {
        continue;
      }
      const oid = resolveCommitOid(repo, candidate);
      if (!oid) continue;
      const fullRef =
        git(
          repo,
          "rev-parse",
          "--symbolic-full-name",
          "--verify",
          "--end-of-options",
          candidate,
        ) || candidate;
      if (
        fullRef.startsWith("refs/remotes/") &&
        !remotes.some((remote) => fullRef.startsWith(`refs/remotes/${remote}/`))
      ) {
        continue;
      }
      return { ref: fullRef, oid };
    }
    return null;
  }

  const allowFallback = options.allowLocalFallbackForExplicitOrigin ?? true;
  const candidates = [requested];
  if (!requested.startsWith("origin/")) {
    candidates.push(`origin/${requested}`);
  } else if (allowFallback) {
    candidates.push(requested.slice("origin/".length));
  }

  for (const candidate of candidates) {
    const oid = resolveCommitOid(repo, candidate);
    if (oid) {
      return { ref: candidate, oid };
    }
  }
  return null;
}

export function resolveRepositoryBase(
  repo: string,
  configured: string,
): ResolvedBaseRef | null {
  const configuredBase = resolveBaseRef(repo, configured);
  if (configuredBase) {
    return configuredBase;
  }
  try {
    const head = git(
      repo,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    );
    const resolved = resolveBaseRef(repo, head);
    if (resolved) return resolved;
  } catch {
    // A local clone may not have origin/HEAD.
  }
  for (const ref of ["origin/main", "origin/master", "origin/develop"]) {
    const resolved = resolveBaseRef(repo, ref);
    if (resolved) return resolved;
  }
  return null;
}

/** A PR target is a branch, never a tag or the feature branch's upstream. */
export function resolvePullRequestBase(
  repo: string,
  pr: Record<string, unknown> | null | undefined,
): { target: string; resolved: ResolvedBaseRef | null } | null {
  if (typeof pr?.baseRefName !== "string" || !pr.baseRefName) {
    return null;
  }
  const target = pr.baseRefName;
  for (const [ref, fullRef] of [
    [`origin/${target}`, `refs/remotes/origin/${target}`],
    [target, `refs/heads/${target}`],
  ]) {
    const oid = resolveCommitOid(repo, fullRef);
    if (oid) {
      return { target, resolved: { ref, oid } };
    }
  }
  return { target, resolved: null };
}
