import { git } from "./common.js";

/** Resolve cached refs only; never fetch or infer a base from a feature's upstream. */
export function resolveBase(
  repo: string,
  requested: string,
): { ref: string; oid: string } | null {
  const refs = [
    requested,
    requested.startsWith("origin/")
      ? requested.slice(7)
      : "origin/" + requested,
  ];
  for (const ref of refs) {
    try {
      return {
        ref,
        oid: git(
          repo,
          "rev-parse",
          "--verify",
          "--end-of-options",
          ref + "^{commit}",
        ),
      };
    } catch {
      /* Try the corresponding local or remote ref. */
    }
  }
  return null;
}

export function repositoryBase(
  repo: string,
  configured: string,
): { ref: string; oid: string } | null {
  const configuredBase = resolveBase(repo, configured);
  if (configuredBase) return configuredBase;
  try {
    const head = git(
      repo,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    );
    const resolved = resolveBase(repo, head);
    if (resolved) return resolved;
  } catch {
    /* A local clone may not have origin/HEAD. */
  }
  for (const ref of ["origin/main", "origin/master", "origin/develop"]) {
    const resolved = resolveBase(repo, ref);
    if (resolved) return resolved;
  }
  return null;
}

/** A PR target is a branch, not a tag or the feature branch's upstream. */
export function pullRequestBase(
  repo: string,
  pr: Record<string, unknown> | null | undefined,
): { target: string; resolved: { ref: string; oid: string } | null } | null {
  if (typeof pr?.baseRefName !== "string" || !pr.baseRefName) return null;
  const target = pr.baseRefName;
  for (const [ref, fullRef] of [
    [`origin/${target}`, `refs/remotes/origin/${target}`],
    [target, `refs/heads/${target}`],
  ]) {
    try {
      return {
        target,
        resolved: {
          ref,
          oid: git(
            repo,
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${fullRef}^{commit}`,
          ),
        },
      };
    } catch {
      /* The local target branch can exist without a cached remote ref. */
    }
  }
  return { target, resolved: null };
}
