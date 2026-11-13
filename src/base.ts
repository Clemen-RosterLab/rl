import {
  resolveBaseRef,
  resolvePullRequestBase,
  resolveRepositoryBase,
  type ResolvedBaseRef,
} from "./git/base.js";

/** Resolve cached refs only; never fetch or infer a base from a feature's upstream. */
export function resolveBase(
  repo: string,
  requested: string,
): ResolvedBaseRef | null {
  return resolveBaseRef(repo, requested, { prefer: "local" });
}

export function repositoryBase(
  repo: string,
  configured: string,
): ResolvedBaseRef | null {
  return resolveRepositoryBase(repo, configured);
}

/** A PR target is a branch, not a tag or the feature branch's upstream. */
export function pullRequestBase(
  repo: string,
  pr: Record<string, unknown> | null | undefined,
): { target: string; resolved: ResolvedBaseRef | null } | null {
  return resolvePullRequestBase(repo, pr);
}
