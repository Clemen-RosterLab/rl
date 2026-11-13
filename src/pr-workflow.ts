import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { commandContext, contextOptions } from "./command-context.js";
import {
  args,
  arity,
  canonical,
  execute,
  git,
  inside,
  locked,
} from "./common.js";
import { UsageError } from "./errors.js";
import { GIT_WORKFLOW_DIRECTORY, GIT_WORKFLOW_LOCK } from "./git-safety.js";
import { resolveGitHubRepository, runGh } from "./github/client.js";
import { isJsonObject, parseJsonObject } from "./json.js";

const PR_FIELDS =
  "number,url,headRefName,headRefOid,baseRefName,isCrossRepository,headRepository,headRepositoryOwner";
const FETCH_PREFIX = "refs/rl/pr-fetch/";

/** Bound requests and ignore a caller's unrelated GH_REPO override. */
export async function github(repo: string, argv: string[]) {
  return runGh(repo, argv);
}

/** Bind GitHub reads and Git fetches to the same origin before changing local refs. */
export async function repositoryIdentity(
  repo: string,
): Promise<{ name: string; url: string }> {
  const resolved = await resolveGitHubRepository(repo, { verifyOrigin: true });
  return { name: resolved.name, url: resolved.url };
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, [...contextOptions, "name"], []);
  const [command, action, ...rest] = positionals;
  if (command !== "pr" || action !== "checkout") {
    throw new UsageError("Usage: rl pr checkout <number> [--name <branch>]");
  }
  arity(rest, 1);

  const context = commandContext(values);
  const identity = await repositoryIdentity(context.repo);
  const [number] = rest;
  if (!/^[1-9]\d*$/.test(number)) {
    throw new UsageError("Expected a positive PR number");
  }

  const name = String(values.name ?? `pr-${number}`);
  if (name.startsWith("-") || /[\r\n]/.test(name)) {
    throw new UsageError("Invalid workspace name");
  }
  if (git(context.repo, "check-ref-format", "--branch", name) !== name) {
    throw new UsageError("Workspace name must be a literal branch name");
  }

  const destination = canonical(path.join(context.managedDir, name));
  if (!inside(destination, context.managedDir) || fs.existsSync(destination)) {
    throw new Error(
      "Workspace destination must be a new path inside the managed directory",
    );
  }

  const result = await github(context.repo, [
    "pr",
    "view",
    number,
    "--repo",
    identity.url,
    "--json",
    PR_FIELDS,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Cannot load PR metadata");
  }

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
  ) {
    throw new Error(
      "PR identity is invalid or belongs to a fork; fork checkouts are not supported",
    );
  }

  const head = raw.headRefOid;
  const base = raw.baseRefName;
  git(context.repo, "check-ref-format", `refs/heads/${raw.headRefName}`);
  git(context.repo, "check-ref-format", `refs/heads/${base}`);

  return locked(
    path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
    GIT_WORKFLOW_LOCK,
    async () => {
      if (fs.existsSync(destination)) {
        throw new Error("Workspace already exists");
      }
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
      if (existing.code === 0) {
        throw new Error(`Local branch already exists: ${name}`);
      }
      if (existing.code !== 1) {
        throw new Error(existing.stderr || "Cannot inspect local branch");
      }

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
        ) {
          throw new Error(
            "PR changed during checkout; retry to fetch its current head",
          );
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        git(context.repo, "worktree", "add", "-b", name, destination, head);
        try {
          await context.store.adopt(destination, base);
        } catch (error) {
          throw new Error(
            `Created ${destination}, but RL adoption failed: ${error instanceof Error ? error.message : "unknown error"}. Run rl setup adopt inside it`,
            { cause: error },
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
