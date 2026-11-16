import { execute, git, gitEnv, object } from "./common.js";
import { normalizeGitRemoteHostPath, runGh } from "./github/client.js";
import { OID, reviewGit } from "./review-git.js";

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

/** Read-only discovery boundary. Explicit submissions use ReviewCommentService. */
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
  constructor(
    private readonly options: { repository?: string; cache?: boolean } = {},
  ) {}

  async ensureObjects(
    root: string,
    pr: PullRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.options.repository) this.assertRepository(pr);
    const hasCommit = async (oid: string): Promise<boolean> =>
      (
        await execute(["git", "cat-file", "-e", `${oid}^{commit}`], root, {
          timeoutMs: 5000,
          signal,
          abortGraceMs: 0,
          processGroup: true,
          env: {
            ...gitEnv(),
            GIT_NO_LAZY_FETCH: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        })
      ).code === 0;

    if ((await hasCommit(pr.headRefOid)) && (await hasCommit(pr.baseRefOid))) {
      if (this.options.cache) this.pinRemote(pr, root);
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
      const originUrl = this.options.cache
        ? git(root, "config", "--get", "remote.origin.url")
        : git(root, "remote", "get-url", "origin");
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
        ...(this.options.cache ? ["--filter=blob:none"] : []),
        this.options.cache
          ? "origin"
          : `${url.origin}/${match[1]}/${match[2]}.git`,
        `+refs/pull/${pr.number}/head:refs/rl/live-pr/${pr.number}/head`,
        `+refs/heads/${pr.baseRefName}:refs/rl/live-pr/${pr.number}/base`,
      ],
      root,
      {
        timeoutMs: this.options.cache ? 120000 : 30000,
        maxOutputBytes: 1024 * 1024,
        signal,
        abortGraceMs: 0,
        processGroup: true,
        env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      },
    );
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          (this.options.cache
            ? "PR object download failed; press Ctrl-r to retry"
            : "PR object download failed; local review remains available with w"),
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
    if (this.options.cache) this.pinRemote(pr, root);
  }

  private pinRemote(pr: PullRequest, root: string): void {
    reviewGit(
      root,
      ["update-ref", "--stdin"],
      `start\nupdate refs/rl/live-pr/${pr.number}/head ${pr.headRefOid}\nupdate refs/rl/live-pr/${pr.number}/base ${pr.baseRefOid}\nprepare\ncommit\n`,
    );
  }

  private assertRepository(pr: PullRequest): void {
    const url = new URL(pr.url);
    const identity =
      `${url.host}${url.pathname.replace(/\/pull\/\d+\/?$/, "")}`.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      identity !== this.options.repository!.toLowerCase()
    )
      throw new Error("GitHub PR does not belong to the requested repository");
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
        ...(this.options.repository ? ["--repo", this.options.repository] : []),
        "--json",
        "number,title,url,headRefName,baseRefName,headRefOid,baseRefOid,commits,files",
      ],
      {
        timeoutMs: 8000,
        maxOutputBytes: 8 * 1024 * 1024,
        signal,
        abortGraceMs: 0,
        processGroup: true,
        respectOffline: true,
        offlineMessage: this.options.cache
          ? "GitHub is offline; remote PR review needs network access"
          : "GitHub offline; local review remains live",
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
    const pr = data as unknown as PullRequest;
    if (selector && pr.number !== selector)
      throw new Error("GitHub returned a different PR number");
    if (this.options.repository) this.assertRepository(pr);
    return pr;
  }
}
