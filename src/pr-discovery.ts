import fs from "node:fs";
import path from "node:path";
import {
  execute,
  message,
  now,
  object,
  pooled,
  readJson,
  writeJson,
} from "./common.js";
import { cleanGhEnvironment } from "./github/client.js";
import { parseJson } from "./json.js";
import type { Instance, Store } from "./store.js";

export interface PrLookup {
  pr: Instance["pr"];
  checkedAt?: string;
  stale: boolean;
}

interface CacheEntry {
  pr: Instance["pr"];
  checkedAt: string;
}

const TTL_MS = 60_000;
const LOOKUP_DEADLINE_MS = 8_000;
const GRAPHQL_FIELDS =
  "number url title state headRefName baseRefName isDraft updatedAt headRepository { nameWithOwner }";

function loadValidCache(file: string): Map<string, CacheEntry> {
  const cached = new Map<string, CacheEntry>();
  try {
    if (!fs.existsSync(file)) {
      return cached;
    }
    const data = readJson(file);
    if (data.schemaVersion === 1 && object(data.branches)) {
      for (const [branch, entry] of Object.entries(data.branches)) {
        if (
          object(entry) &&
          typeof entry.checkedAt === "string" &&
          Number.isFinite(Date.parse(entry.checkedAt)) &&
          (entry.pr === null ||
            (object(entry.pr) &&
              typeof entry.pr.url === "string" &&
              entry.pr.headRefName === branch))
        ) {
          cached.set(branch, {
            pr: entry.pr as Instance["pr"],
            checkedAt: entry.checkedAt,
          });
        }
      }
    }
  } catch {
    // Disposable lookup caches never block opening a worktree.
  }
  return cached;
}

export function readCachedBranchPr(
  store: Store,
  branch: string,
): Instance["pr"] {
  return (
    loadValidCache(path.join(store.root, "pr-cache.json")).get(branch)?.pr ??
    null
  );
}

export function writeCachedBranchPr(
  store: Store,
  branch: string,
  pr: Instance["pr"],
  checkedAt = now(),
): void {
  if (pr !== null && pr?.headRefName !== branch) {
    return;
  }
  const cacheFile = path.join(store.root, "pr-cache.json");
  let existing: Record<string, unknown> = {};
  try {
    const data = readJson(cacheFile);
    if (object(data.branches)) {
      existing = data.branches;
    }
  } catch {
    // Initialize disposable cache cleanly.
  }
  const merged = new Map(Object.entries(existing));
  const previous = merged.get(branch);
  if (
    !object(previous) ||
    typeof previous.checkedAt !== "string" ||
    Date.parse(previous.checkedAt) <= Date.parse(checkedAt)
  ) {
    merged.set(branch, { pr, checkedAt });
    writeJson(cacheFile, {
      schemaVersion: 1,
      branches: Object.fromEntries(merged),
    });
  }
}

function selectBranchPrFromGraphql(
  repositoryNode: Record<string, unknown>,
  index: number,
  branch: string,
  urlPrefix: string,
  expectedRepoName: string,
  startedAt: string,
): Instance["pr"] {
  for (const alias of [`o${index}`, `h${index}`]) {
    const connection = repositoryNode[alias];
    if (
      !object(connection) ||
      !Array.isArray(connection.nodes) ||
      !object(connection.pageInfo) ||
      typeof connection.pageInfo.hasNextPage !== "boolean"
    ) {
      throw new Error("Incomplete branch lookup");
    }

    for (const pr of connection.nodes) {
      if (
        !object(pr) ||
        pr.headRefName !== branch ||
        typeof pr.url !== "string" ||
        !pr.url.startsWith(urlPrefix)
      ) {
        throw new Error("Invalid branch PR identity");
      }

      // Deleted source forks return headRepository: null in GraphQL.
      if (pr.headRepository === null) {
        continue;
      }

      if (
        !object(pr.headRepository) ||
        typeof pr.headRepository.nameWithOwner !== "string"
      ) {
        throw new Error("Invalid branch PR identity");
      }

      // Fork PRs can share a branch name without belonging to this repository.
      if (
        pr.headRepository.nameWithOwner.toLowerCase() !==
        expectedRepoName.toLowerCase()
      ) {
        continue;
      }

      if (
        !Number.isInteger(pr.number) ||
        typeof pr.baseRefName !== "string" ||
        !pr.baseRefName ||
        !["OPEN", "CLOSED", "MERGED"].includes(String(pr.state)) ||
        typeof pr.isDraft !== "boolean" ||
        typeof pr.updatedAt !== "string"
      ) {
        throw new Error("Incomplete PR metadata");
      }

      return { ...pr, url: pr.url, syncedAt: startedAt };
    }

    if (connection.pageInfo.hasNextPage) {
      throw new Error("Branch PR results truncated");
    }
  }

  return null;
}

export async function discoverPrs(
  store: Store,
  branches: string[],
): Promise<Map<string, PrLookup>> {
  const cacheFile = path.join(store.root, "pr-cache.json");
  const cached = loadValidCache(cacheFile);
  const results = new Map<string, PrLookup>();
  const remoteBranchByLocal = new Map<string, string>();

  for (const [, data] of store.records()) {
    if (data.status !== "active" || !data.pr) {
      continue;
    }
    const remoteBranch =
      typeof data.pr.headRefName === "string" && data.pr.headRefName
        ? data.pr.headRefName
        : data.branch;
    if (remoteBranch !== data.branch) {
      remoteBranchByLocal.set(data.branch, remoteBranch);
    }
    const previous = cached.get(remoteBranch);
    const stamp = data.pr.syncedAt;
    if (
      !previous ||
      (typeof stamp === "string" &&
        Date.parse(stamp) > Date.parse(previous.checkedAt))
    ) {
      results.set(data.branch, {
        pr: data.pr,
        checkedAt: typeof stamp === "string" ? stamp : undefined,
        stale: false,
      });
    }
  }

  for (const [branch, entry] of cached) {
    if (!results.has(branch)) {
      results.set(branch, { ...entry, stale: false });
    }
  }
  for (const [localBranch, remoteBranch] of remoteBranchByLocal) {
    if (!results.has(localBranch)) {
      const entry = cached.get(remoteBranch);
      if (entry) {
        results.set(localBranch, { ...entry, stale: false });
      }
    }
  }

  const pendingLocal = [...new Set(branches.filter(Boolean))].filter(
    (branch) => {
      const existing = results.get(branch);
      const age = existing?.checkedAt
        ? Date.now() - Date.parse(existing.checkedAt)
        : Infinity;
      return !(age >= 0 && age < TTL_MS);
    },
  );

  if (pendingLocal.length === 0) {
    return results;
  }

  const localBranchesByLookup = new Map<string, string[]>();
  for (const localBranch of pendingLocal) {
    const lookupBranch = remoteBranchByLocal.get(localBranch) ?? localBranch;
    const targets = localBranchesByLookup.get(lookupBranch) ?? [];
    targets.push(localBranch);
    localBranchesByLookup.set(lookupBranch, targets);
  }
  const pending = [...localBranchesByLookup.keys()];

  const markLocalStale = (localBranch: string) =>
    results.set(localBranch, {
      pr: results.get(localBranch)?.pr ?? null,
      checkedAt: results.get(localBranch)?.checkedAt,
      stale: true,
    });
  const markStale = (lookupBranch: string) => {
    for (const localBranch of localBranchesByLookup.get(lookupBranch) ?? [
      lookupBranch,
    ]) {
      markLocalStale(localBranch);
    }
  };

  if (process.env.RL_PR_OFFLINE === "1") {
    pending.forEach(markStale);
    return results;
  }

  const started = now();
  const deadline = Date.now() + LOOKUP_DEADLINE_MS;
  const ghEnv = cleanGhEnvironment();

  async function queryGh(argv: string[]): Promise<unknown> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("GitHub lookup timed out");
    }
    const result = await execute(["gh", ...argv], store.repo, {
      timeoutMs: remaining,
      env: ghEnv,
    });
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || "GitHub lookup failed or timed out",
      );
    }
    return parseJson(result.stdout);
  }

  const refreshed = new Map<string, CacheEntry>();
  const failures: string[] = [];
  console.error("Checking GitHub PRs…");

  try {
    const identity = await queryGh([
      "repo",
      "view",
      "--json",
      "nameWithOwner,url",
    ]);
    if (
      !object(identity) ||
      typeof identity.nameWithOwner !== "string" ||
      typeof identity.url !== "string"
    ) {
      throw new Error("Invalid GitHub repository identity");
    }

    const repositoryName = identity.nameWithOwner;
    const [owner, name, extra] = repositoryName.split("/");
    const parsedUrl = new URL(identity.url);
    if (
      !owner ||
      !name ||
      extra ||
      parsedUrl.protocol !== "https:" ||
      parsedUrl.pathname.replace(/\/$/, "") !== `/${owner}/${name}`
    ) {
      throw new Error("Invalid GitHub repository URL");
    }

    const prefix = `${identity.url.replace(/\/$/, "")}/pull/`;
    const batches: string[][] = [];
    for (let i = 0; i < pending.length; i += 20) {
      batches.push(pending.slice(i, i + 20));
    }

    await pooled(batches, 2, async (batch) => {
      try {
        const selections = batch
          .map((branch, index) =>
            [
              `o${index}: pullRequests(headRefName: ${JSON.stringify(branch)}, states: [OPEN], first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${GRAPHQL_FIELDS} } pageInfo { hasNextPage } }`,
              `h${index}: pullRequests(headRefName: ${JSON.stringify(branch)}, states: [CLOSED, MERGED], first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${GRAPHQL_FIELDS} } pageInfo { hasNextPage } }`,
            ].join("\n"),
          )
          .join("\n");

        const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${selections} } }`;
        const response = await queryGh([
          "api",
          "graphql",
          "--hostname",
          parsedUrl.host,
          "-f",
          `query=${query}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
        ]);

        if (
          !object(response) ||
          response.errors ||
          !object(response.data) ||
          !object(response.data.repository)
        ) {
          throw new Error("Incomplete GitHub PR response");
        }

        const repositoryNode = response.data.repository;
        for (const [index, branch] of batch.entries()) {
          try {
            const selected = selectBranchPrFromGraphql(
              repositoryNode,
              index,
              branch,
              prefix,
              repositoryName,
              started,
            );
            const entry: CacheEntry = { pr: selected, checkedAt: started };
            refreshed.set(branch, entry);
            for (const localBranch of localBranchesByLookup.get(branch) ?? [
              branch,
            ]) {
              results.set(localBranch, { ...entry, stale: false });
            }
          } catch (error) {
            markStale(branch);
            failures.push(`${branch}: ${message(error)}`);
          }
        }
      } catch (error) {
        batch.forEach(markStale);
        failures.push(message(error));
      }
    });
  } catch (error) {
    pending.forEach(markStale);
    failures.push(message(error));
  }

  if (refreshed.size > 0) {
    try {
      await store.locked(() => {
        let existing: Record<string, unknown> = {};
        try {
          const data = readJson(cacheFile);
          if (object(data.branches)) {
            existing = data.branches;
          }
        } catch {
          // Initialize disposable cache cleanly.
        }

        const merged = new Map(Object.entries(existing));
        for (const [branch, entry] of refreshed) {
          const previous = merged.get(branch);
          if (
            !object(previous) ||
            typeof previous.checkedAt !== "string" ||
            Date.parse(previous.checkedAt) <= Date.parse(started)
          ) {
            merged.set(branch, entry);
          }
        }

        writeJson(cacheFile, {
          schemaVersion: 1,
          branches: Object.fromEntries(merged),
        });

        for (const [record, data] of store.records()) {
          if (data.status !== "active") {
            continue;
          }
          const lookupBranch =
            typeof data.pr?.headRefName === "string" && data.pr.headRefName
              ? data.pr.headRefName
              : data.branch;
          const entry = refreshed.get(lookupBranch);
          if (!entry) {
            continue;
          }
          if (
            typeof data.pr?.syncedAt === "string" &&
            Date.parse(data.pr.syncedAt) > Date.parse(started)
          ) {
            continue;
          }
          if (lookupBranch !== data.branch && entry.pr === null) {
            continue;
          }
          data.pr = entry.pr;
          store.save(record, data);
        }
      });
    } catch (error) {
      failures.push(`Could not save PR cache: ${message(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `rl: PR lookup incomplete; * marks a saved snapshot, unknown means not verified. ${failures[0]}`,
    );
  }

  return results;
}
