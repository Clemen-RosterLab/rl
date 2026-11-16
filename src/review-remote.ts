import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  args,
  arity,
  canonical,
  execute,
  expandHome,
  git,
  gitEnv,
  json,
  locked,
} from "./common.js";
import { UsageError } from "./errors.js";
import { contextOptions } from "./command-context.js";
import { loadUserConfig, resolveCliEnvironment } from "./user-config.js";
import { resolveRepositorySettings } from "./repos.js";
import { GhReviewService } from "./review-github.js";
import { LiveRepository } from "./review-live-engine.js";
import { liveReview } from "./review-live.js";

export interface RemoteReviewTarget {
  repository: string;
  url: string;
  number: number;
}

export function remoteReviewRequested(argv: string[]): boolean {
  const options = argv.slice(
    0,
    argv.indexOf("--") < 0 ? argv.length : argv.indexOf("--"),
  );
  return (
    !options.includes("--local") &&
    options.some((arg) => arg === "--pr" || arg.startsWith("--pr="))
  );
}

function repositoryIdentity(input: string): string {
  const parts = input
    .replace(/^https:\/\//, "")
    .replace(/\/$/, "")
    .split("/");
  if (parts.length === 2) parts.unshift(process.env.GH_HOST || "github.com");
  if (
    parts.length !== 3 ||
    !/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(parts[0]) ||
    parts
      .slice(1)
      .some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")
  )
    throw new UsageError("Expected --github-repo [HOST/]OWNER/REPO");
  return parts.join("/").toLowerCase();
}

export function remoteReviewTarget(
  selector: string,
  repository?: string,
): RemoteReviewTarget {
  let identity = repository ? repositoryIdentity(repository) : undefined;
  let number = selector;
  if (selector.startsWith("https://")) {
    const url = new URL(selector);
    const match =
      /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(?:files|commits))?\/?$/.exec(
        url.pathname,
      );
    if (!match || url.username || url.password)
      throw new UsageError("Expected --pr <number or GitHub PR URL>");
    const fromUrl = repositoryIdentity(`${url.host}/${match[1]}/${match[2]}`);
    if (identity && identity !== fromUrl)
      throw new UsageError(
        "PR URL and --github-repo refer to different repositories",
      );
    identity = fromUrl;
    number = match[3];
  }
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)))
    throw new UsageError("Expected --pr <positive PR number or GitHub PR URL>");
  if (!identity)
    throw new UsageError(
      "Cannot determine the GitHub repository. Pass --github-repo OWNER/REPO or a full PR URL.",
    );
  return {
    repository: identity,
    number: Number(number),
    url: `https://${identity}`,
  };
}

export async function remoteReviewCache(
  stateDir: string,
  target: RemoteReviewTarget,
): Promise<{ root: string; directory: string }> {
  const id = createHash("sha256").update(target.repository).digest("hex");
  const directory = path.join(canonical(stateDir), "remote-review", id),
    root = path.join(directory, "objects.git");
  if (canonical(root) !== root)
    throw new Error("Remote review cache must not traverse symlinks");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  await locked(directory, ".init.lock", async () => {
    const run = async (argv: string[]) => {
      const result = await execute(["git", ...argv], directory, {
        timeoutMs: 15000,
        processGroup: true,
        abortGraceMs: 0,
        env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0" },
      });
      if (result.code)
        throw new Error(
          result.stderr.trim() || "Cannot initialize the remote review cache",
        );
      return result.stdout.trim();
    };
    if (!fs.existsSync(root))
      await run(["init", "--bare", "--initial-branch=rl-unborn", root]);
    if (
      (await run([
        `--git-dir=${root}`,
        "rev-parse",
        "--is-bare-repository",
      ])) !== "true"
    )
      throw new Error("Remote review cache is not a bare repository");
    const config = async (key: string, value: string) =>
      run([`--git-dir=${root}`, "config", "--local", key, value]);
    const identity = await run([
      `--git-dir=${root}`,
      "rev-parse",
      "--absolute-git-dir",
    ]);
    if (canonical(identity) !== root)
      throw new Error("Remote review cache identity changed");
    await config("remote.origin.url", `${target.url}.git`);
    await config("remote.origin.promisor", "true");
    await config("remote.origin.partialclonefilter", "blob:none");
    await config("core.hooksPath", "/dev/null");
    await config("credential.helper", "");
    await config(
      `credential.${target.url.split("/").slice(0, 3).join("/")}.helper`,
      "!gh auth git-credential",
    );
  });
  return { root, directory };
}

export async function main(
  argv: string[],
  selectedRepo?: string,
): Promise<number> {
  const { values, positionals } = args(
    argv,
    [...contextOptions, "pr", "github-repo", "remote-interval"],
    ["json", "diff", "live"],
  );
  arity(positionals, 0, 0);
  if (!values.pr)
    throw new UsageError("Expected rl review --pr <number or PR URL>");
  const interval = Number(values["remote-interval"] ?? 60);
  if (!Number.isFinite(interval) || interval < 10)
    throw new UsageError("Expected --remote-interval of at least 10 seconds");
  if (values.live && (values.json || values.diff))
    throw new UsageError("Expected --live without --json or --diff");
  const config = loadUserConfig();
  const stateDir = expandHome(
    String(
      values["state-dir"] ??
        process.env.RL_STATE_DIR ??
        config.stateDir ??
        path.join(os.homedir(), ".rl/instances"),
    ),
  );
  if (!path.isAbsolute(stateDir))
    throw new UsageError("Remote review state directory must be absolute");
  let repository =
    typeof values["github-repo"] === "string"
      ? values["github-repo"]
      : undefined;
  if (!repository && !String(values.pr).startsWith("https://")) {
    try {
      let root = typeof values.repo === "string" ? values.repo : undefined;
      if (!root) {
        const env = resolveCliEnvironment(selectedRepo);
        const resolved = resolveRepositorySettings({
          stateDir: env.stateDir,
          baseDir: env.worktreeDir,
          legacyRoot: env.repoRoot,
          legacyName: env.repoName,
          legacyBase: env.defaultBase,
          selection: env.selectedRepo,
        });
        root = resolved?.root ?? env.repoRoot;
      }
      const origin = git(root, "config", "--get", "remote.origin.url");
      const normal = origin
        .replace(/^git@([^:]+):/, "$1/")
        .replace(/^ssh:\/\/git@/, "")
        .replace(/^https:\/\//, "")
        .replace(/\.git$/, "");
      repository = repositoryIdentity(normal);
    } catch {
      /* The explicit usage error below explains how to select a repository. */
    }
  }
  const target = remoteReviewTarget(String(values.pr), repository);
  const cache = await remoteReviewCache(stateDir, target);
  if (
    (process.stdin.isTTY &&
      process.stdout.isTTY &&
      !values.json &&
      !values.diff) ||
    values.live
  ) {
    await liveReview({
      root: cache.root,
      repository: cache.root,
      directory: cache.directory,
      defaultBase: `refs/rl/live-pr/${target.number}/base`,
      pr: target.number,
      remoteInterval: interval * 1000,
      remote: target,
    });
  } else {
    const github = new GhReviewService({
      repository: target.repository,
      cache: true,
    });
    const pr = await github.discover(cache.root, target.number);
    await github.ensureObjects(cache.root, pr);
    const repo = new LiveRepository(cache.root, cache.root, {
      remote: target.number,
    });
    const state = repo.remoteState(pr.headRefOid, pr.baseRefOid);
    const comparison = repo.comparison(
        { kind: "branch", base: pr.baseRefOid, head: pr.headRefOid },
        state,
      ),
      files = repo.files(comparison, state);
    if (values.json)
      json({
        source: "remote",
        repository: target.repository,
        root: cache.root,
        checkout: false,
        snapshot: state.snapshot,
        commits: state.commits,
        comparison,
        files,
        pr,
      });
    else {
      console.log(`PR #${pr.number}: ${pr.title}\n${comparison.label}`);
      for (const file of files) console.log(repo.patch(file));
    }
  }
  return 0;
}
