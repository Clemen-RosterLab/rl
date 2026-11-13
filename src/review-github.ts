import { execute, git, object } from "./common.js";
import { normalizeGitRemoteHostPath, runGh } from "./github/client.js";
import { OID } from "./review-git.js";

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  commits: { oid: string }[];
  files: { path: string; additions: number; deletions: number }[];
}

/** Read-only provider boundary; future threads/reviews belong on this service. */
export interface ReviewGitHub {
  discover(
    root: string,
    selector?: number,
    signal?: AbortSignal,
  ): Promise<PullRequest>;
  ensureObjects(
    root: string,
    pr: PullRequest,
    signal?: AbortSignal,
  ): Promise<void>;
}

export class GhReviewService implements ReviewGitHub {
  async ensureObjects(
    root: string,
    pr: PullRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const hasCommit = async (oid: string): Promise<boolean> =>
      (
        await execute(["git", "cat-file", "-e", `${oid}^{commit}`], root, {
          timeoutMs: 5000,
          signal,
          abortGraceMs: 0,
          processGroup: true,
        })
      ).code === 0;

    if ((await hasCommit(pr.headRefOid)) && (await hasCommit(pr.baseRefOid))) {
      return;
    }

    const url = new URL(pr.url);
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !match ||
      Number(match[3]) !== pr.number
    ) {
      throw new Error("Cannot verify PR repository URL for object download");
    }

    try {
      const originUrl = git(root, "remote", "get-url", "origin");
      if (originUrl.includes("://") || originUrl.includes("@")) {
        const expected = `${url.host}/${match[1]}/${match[2]}`.toLowerCase();
        if (normalizeGitRemoteHostPath(originUrl) !== expected) {
          throw new Error(
            "PR repository URL does not match local origin remote",
          );
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("does not match local origin")
      ) {
        throw error;
      }
    }

    const valid = await execute(
      ["git", "check-ref-format", `refs/heads/${pr.baseRefName}`],
      root,
      { timeoutMs: 5000, signal, processGroup: true, abortGraceMs: 0 },
    );
    if (valid.code !== 0) {
      throw new Error("Invalid PR target branch");
    }

    // Download only into private refs. Never touch HEAD, FETCH_HEAD, the index,
    // working files, the user's branches or their remote-tracking refs.
    const result = await execute(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        `${url.origin}/${match[1]}/${match[2]}.git`,
        `+refs/pull/${pr.number}/head:refs/rl/live-pr/${pr.number}/head`,
        `+refs/heads/${pr.baseRefName}:refs/rl/live-pr/${pr.number}/base`,
      ],
      root,
      {
        timeoutMs: 30000,
        maxOutputBytes: 1024 * 1024,
        signal,
        abortGraceMs: 0,
        processGroup: true,
      },
    );
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          "PR object download failed; local review remains available with w",
      );
    }
    if (
      !(await hasCommit(pr.headRefOid)) ||
      !(await hasCommit(pr.baseRefOid))
    ) {
      throw new Error(
        "PR changed during download; press Ctrl-r to refresh its revision identities",
      );
    }
  }

  async discover(
    root: string,
    selector?: number,
    signal?: AbortSignal,
  ): Promise<PullRequest> {
    const result = await runGh(
      root,
      [
        "pr",
        "view",
        ...(selector ? [String(selector)] : []),
        "--json",
        "number,title,url,headRefName,baseRefName,headRefOid,baseRefOid,commits,files",
      ],
      {
        timeoutMs: 8000,
        maxOutputBytes: 8 * 1024 * 1024,
        signal,
        abortGraceMs: 0,
        processGroup: true,
        offlineMessage: "GitHub offline; local review remains live",
      },
    );

    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          "GitHub unavailable; authenticate with gh auth login",
      );
    }

    const data: unknown = JSON.parse(result.stdout);
    if (
      !object(data) ||
      !Number.isInteger(data.number) ||
      ![data.title, data.url, data.headRefName, data.baseRefName].every(
        (v) => typeof v === "string",
      ) ||
      ![data.headRefOid, data.baseRefOid].every(
        (v) => typeof v === "string" && OID.test(v),
      ) ||
      !Array.isArray(data.commits) ||
      !Array.isArray(data.files)
    ) {
      throw new Error("Invalid GitHub PR metadata");
    }
    return data as unknown as PullRequest;
  }
}
