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
import { Instance, Store } from "./store.js";
export interface PrLookup {
  pr: Instance["pr"];
  checkedAt?: string;
  stale: boolean;
}
interface CacheEntry {
  pr: Instance["pr"];
  checkedAt: string;
}
const TTL = 60_000;
const fields =
  "number url title state headRefName baseRefName isDraft updatedAt headRepository { nameWithOwner }";

export async function discoverPrs(
  store: Store,
  branches: string[],
): Promise<Map<string, PrLookup>> {
  const file = path.join(store.root, "pr-cache.json"),
    cached = new Map<string, CacheEntry>();
  try {
    if (fs.existsSync(file)) {
      const data = readJson(file);
      if (data.schemaVersion === 1 && object(data.branches))
        for (const [branch, entry] of Object.entries(data.branches)) {
          if (
            object(entry) &&
            typeof entry.checkedAt === "string" &&
            Number.isFinite(Date.parse(entry.checkedAt)) &&
            (entry.pr === null ||
              (object(entry.pr) &&
                typeof entry.pr.url === "string" &&
                entry.pr.headRefName === branch))
          )
            cached.set(branch, entry as unknown as CacheEntry);
        }
    }
  } catch {
    /* A disposable lookup cache must not prevent opening a worktree. */
  }
  const results = new Map<string, PrLookup>();
  for (const [, data] of store.records()) {
    if (data.status !== "active" || !data.pr) continue;
    const previous = cached.get(data.branch),
      stamp = data.pr.syncedAt;
    if (
      !previous ||
      (typeof stamp === "string" &&
        Date.parse(stamp) > Date.parse(previous.checkedAt))
    )
      results.set(data.branch, {
        pr: data.pr,
        checkedAt: typeof stamp === "string" ? stamp : undefined,
        stale: false,
      });
  }
  for (const [branch, entry] of cached)
    if (!results.has(branch)) results.set(branch, { ...entry, stale: false });
  const pending = [...new Set(branches.filter(Boolean))].filter((branch) => {
    const value = results.get(branch),
      age = value?.checkedAt
        ? Date.now() - Date.parse(value.checkedAt)
        : Infinity;
    return !(age >= 0 && age < TTL);
  });
  if (!pending.length) return results;
  const fail = (branch: string) =>
    results.set(branch, {
      pr: results.get(branch)?.pr ?? null,
      checkedAt: results.get(branch)?.checkedAt,
      stale: true,
    });
  if (process.env.RL_PR_OFFLINE === "1") {
    pending.forEach(fail);
    return results;
  }
  const started = now(),
    deadline = Date.now() + 8000;
  const ghEnv: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1" };
  delete ghEnv.GH_REPO;
  async function gh(args: string[]): Promise<unknown> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("GitHub lookup timed out");
    const result = await execute(["gh", ...args], store.repo, {
      timeoutMs: remaining,
      env: ghEnv,
    });
    if (result.code)
      throw new Error(
        result.stderr.trim() || "GitHub lookup failed or timed out",
      );
    return JSON.parse(result.stdout);
  }
  const refreshed = new Map<string, CacheEntry>(),
    failures: string[] = [];
  console.error("Checking GitHub PRs…");
  try {
    const identity = await gh(["repo", "view", "--json", "nameWithOwner,url"]);
    if (
      !object(identity) ||
      typeof identity.nameWithOwner !== "string" ||
      typeof identity.url !== "string"
    )
      throw new Error("Invalid GitHub repository identity");
    const repositoryName = identity.nameWithOwner;
    const [owner, name, extra] = repositoryName.split("/"),
      url = new URL(identity.url);
    if (
      !owner ||
      !name ||
      extra ||
      url.protocol !== "https:" ||
      url.pathname.replace(/\/$/, "") !== `/${owner}/${name}`
    )
      throw new Error("Invalid GitHub repository URL");
    const prefix = identity.url.replace(/\/$/, "") + "/pull/";
    const batches: string[][] = [];
    for (let i = 0; i < pending.length; i += 20)
      batches.push(pending.slice(i, i + 20));
    await pooled(batches, 2, async (batch) => {
      try {
        const selections = batch
          .map((branch, i) =>
            [
              `o${i}: pullRequests(headRefName: ${JSON.stringify(branch)}, states: [OPEN], first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${fields} } pageInfo { hasNextPage } }`,
              `h${i}: pullRequests(headRefName: ${JSON.stringify(branch)}, states: [CLOSED, MERGED], first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${fields} } pageInfo { hasNextPage } }`,
            ].join("\n"),
          )
          .join("\n");
        const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${selections} } }`;
        const response = await gh([
          "api",
          "graphql",
          "--hostname",
          url.host,
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
        )
          throw new Error("Incomplete GitHub PR response");
        const repository = response.data.repository;
        for (const [i, branch] of batch.entries()) {
          try {
            let selected: Instance["pr"] = null;
            for (const alias of [`o${i}`, `h${i}`]) {
              const connection = repository[alias];
              if (
                !object(connection) ||
                !Array.isArray(connection.nodes) ||
                !object(connection.pageInfo) ||
                typeof connection.pageInfo.hasNextPage !== "boolean"
              )
                throw new Error("Incomplete branch lookup");
              for (const pr of connection.nodes) {
                if (
                  !object(pr) ||
                  pr.headRefName !== branch ||
                  typeof pr.url !== "string" ||
                  !pr.url.startsWith(prefix) ||
                  !object(pr.headRepository) ||
                  typeof pr.headRepository.nameWithOwner !== "string"
                )
                  throw new Error("Invalid branch PR identity");
                // A fork can reuse the branch name; it is not this repository's workspace.
                if (
                  pr.headRepository.nameWithOwner.toLowerCase() !==
                  repositoryName.toLowerCase()
                )
                  continue;
                if (
                  !Number.isInteger(pr.number) ||
                  typeof pr.baseRefName !== "string" ||
                  !pr.baseRefName ||
                  !["OPEN", "CLOSED", "MERGED"].includes(String(pr.state)) ||
                  typeof pr.isDraft !== "boolean" ||
                  typeof pr.updatedAt !== "string"
                )
                  throw new Error("Incomplete PR metadata");
                selected = { ...pr, url: pr.url, syncedAt: started };
                break;
              }
              if (selected) break;
              if (connection.pageInfo.hasNextPage)
                throw new Error("Branch PR results truncated");
            }
            const entry = { pr: selected, checkedAt: started };
            refreshed.set(branch, entry);
            results.set(branch, { ...entry, stale: false });
          } catch (error) {
            fail(branch);
            failures.push(`${branch}: ${message(error)}`);
          }
        }
      } catch (error) {
        batch.forEach(fail);
        failures.push(message(error));
      }
    });
  } catch (error) {
    pending.forEach(fail);
    failures.push(message(error));
  }
  if (refreshed.size) {
    try {
      await store.locked(() => {
        let existing: Record<string, unknown> = {};
        try {
          const data = readJson(file);
          if (object(data.branches)) existing = data.branches;
        } catch {
          /* New/disposable cache. */
        }
        const merged = new Map(Object.entries(existing));
        for (const [branch, entry] of refreshed) {
          const previous = merged.get(branch);
          if (
            !object(previous) ||
            typeof previous.checkedAt !== "string" ||
            Date.parse(previous.checkedAt) <= Date.parse(started)
          )
            merged.set(branch, entry);
        }
        writeJson(file, {
          schemaVersion: 1,
          branches: Object.fromEntries(merged),
        });
        for (const [record, data] of store.records()) {
          const entry = refreshed.get(data.branch);
          if (data.status !== "active" || !entry) continue;
          if (
            typeof data.pr?.syncedAt === "string" &&
            Date.parse(data.pr.syncedAt) > Date.parse(started)
          )
            continue;
          data.pr = entry.pr;
          store.save(record, data);
        }
      });
    } catch (error) {
      failures.push(`Could not save PR cache: ${message(error)}`);
    }
  }
  if (failures.length)
    console.error(
      `rl: PR lookup incomplete; * marks a saved snapshot, unknown means not verified. ${failures[0]}`,
    );
  return results;
}
