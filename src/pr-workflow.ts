import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  args,
  arity,
  canonical,
  execute,
  git,
  inside,
  locked,
} from "./common.js";
import {
  commandContext,
  contextOptions,
  resolveWorkspace,
} from "./command-context.js";
import { GIT_WORKFLOW_DIRECTORY, GIT_WORKFLOW_LOCK } from "./git-safety.js";
import { isJsonObject, parseJsonObject } from "./json.js";

const GH_TIMEOUT_MS = 20_000;
const PR_FIELDS =
  "number,url,headRefName,headRefOid,baseRefName,isCrossRepository,headRepository,headRepositoryOwner";
const CHECK_FIELDS = "name,state,bucket,link,workflow";
const FETCH_PREFIX = "refs/rl/pr-fetch/";

/** Bound requests and ignore a caller's unrelated GH_REPO override. */
async function github(repo: string, argv: string[]) {
  if (process.env.RL_PR_OFFLINE === "1")
    throw new Error("GitHub is offline (RL_PR_OFFLINE=1)");
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1" };
  delete env.GH_REPO;
  return execute(["gh", ...argv], repo, { timeoutMs: GH_TIMEOUT_MS, env });
}

/** Bind GitHub reads and Git fetches to the same origin before changing local refs. */
async function repositoryIdentity(
  repo: string,
): Promise<{ name: string; url: string }> {
  const result = await github(repo, [
    "repo",
    "view",
    "--json",
    "nameWithOwner,url",
  ]);
  if (result.code)
    throw new Error(
      result.stderr.trim() || "Cannot determine GitHub repository",
    );
  const raw = parseJsonObject(result.stdout);
  if (
    typeof raw.nameWithOwner !== "string" ||
    typeof raw.url !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(raw.nameWithOwner)
  )
    throw new Error("Invalid GitHub repository identity");
  const url = new URL(raw.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/${raw.nameWithOwner}`
  )
    throw new Error("Invalid GitHub repository URL");
  const remote = git(repo, "remote", "get-url", "origin");
  const expected = `${url.host}/${raw.nameWithOwner}`.toLowerCase();
  const normalized = remote
    .replace(/^https:\/\//, "")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "")
    .toLowerCase();
  if (normalized !== expected)
    throw new Error("GitHub repository identity does not match origin");
  return { name: raw.nameWithOwner, url: raw.url };
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [...contextOptions, "name"],
    ["json"],
  );
  const context = commandContext(values);
  const [command, action, ...rest] = positionals;
  if (command !== "pr" || !["checks", "checkout"].includes(action))
    throw new Error("Usage: rl pr checks|checkout");
  const identity = await repositoryIdentity(context.repo);
  if (action === "checks") {
    arity(rest, 0);
    if (values.name) throw new Error("checks does not accept --name");
    const workspace = resolveWorkspace(context);
    const result = await github(workspace.path, [
      "pr",
      "checks",
      workspace.branch,
      "--repo",
      identity.url,
      ...(values.json ? ["--json", CHECK_FIELDS] : []),
    ]);
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  }
  arity(rest, 1);
  if (values.json) throw new Error("checkout does not accept --json");
  const [number] = rest;
  if (!/^[1-9]\d*$/.test(number))
    throw new Error("Expected a positive PR number");
  const name = String(values.name ?? `pr-${number}`);
  if (name.startsWith("-") || /[\r\n]/.test(name))
    throw new Error("Invalid workspace name");
  if (git(context.repo, "check-ref-format", "--branch", name) !== name)
    throw new Error("Workspace name must be a literal branch name");
  const destination = canonical(path.join(context.managedDir, name));
  if (!inside(destination, context.managedDir) || fs.existsSync(destination))
    throw new Error(
      "Workspace destination must be a new path inside the managed directory",
    );
  const result = await github(context.repo, [
    "pr",
    "view",
    number,
    "--repo",
    identity.url,
    "--json",
    PR_FIELDS,
  ]);
  if (result.code)
    throw new Error(result.stderr.trim() || "Cannot load PR metadata");
  const raw = parseJsonObject(result.stdout);
  if (
    raw.number !== Number(number) ||
    raw.url !== `${identity.url}/pull/${number}` ||
    raw.isCrossRepository !== false ||
    !isJsonObject(raw.headRepository) ||
    !isJsonObject(raw.headRepositoryOwner) ||
    typeof raw.headRepository.name !== "string" ||
    typeof raw.headRepositoryOwner.login !== "string" ||
    `${raw.headRepositoryOwner.login}/${raw.headRepository.name}`.toLowerCase() !==
      identity.name.toLowerCase() ||
    typeof raw.headRefName !== "string" ||
    typeof raw.baseRefName !== "string" ||
    typeof raw.headRefOid !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(raw.headRefOid)
  )
    throw new Error(
      "PR identity is invalid or belongs to a fork; fork checkouts are not supported",
    );
  const head = raw.headRefOid;
  const base = raw.baseRefName;
  git(context.repo, "check-ref-format", `refs/heads/${raw.headRefName}`);
  git(context.repo, "check-ref-format", `refs/heads/${base}`);
  return locked(
    path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
    GIT_WORKFLOW_LOCK,
    async () => {
      if (fs.existsSync(destination))
        throw new Error("Workspace already exists");
      const existing = await execute(
        [
          "git",
          "-C",
          context.repo,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${name}`,
        ],
        context.repo,
      );
      if (existing.code === 0)
        throw new Error(`Local branch already exists: ${name}`);
      if (existing.code !== 1)
        throw new Error(existing.stderr || "Cannot inspect local branch");
      const temporary = FETCH_PREFIX + randomUUID();
      try {
        git(
          context.repo,
          "fetch",
          "--no-tags",
          "origin",
          `refs/pull/${number}/head:${temporary}`,
        );
        if (
          git(
            context.repo,
            "rev-parse",
            "--verify",
            `${temporary}^{commit}`,
          ) !== head
        )
          throw new Error(
            "PR changed during checkout; retry to fetch its current head",
          );
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        git(context.repo, "worktree", "add", "-b", name, destination, head);
        try {
          await context.store.adopt(destination, base);
        } catch (error) {
          // Preserve the valid checkout on adoption failure so hooks/files can be inspected.
          throw new Error(
            `Created ${destination}, but RL adoption failed: ${error instanceof Error ? error.message : "unknown error"}. Run rl adopt inside it`,
          );
        }
        console.log(destination);
        return 0;
      } finally {
        git(context.repo, "update-ref", "-d", temporary);
      }
    },
  );
}
