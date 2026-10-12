import { stripVTControlCharacters } from "node:util";
import {
  args,
  arity,
  execute,
  git,
  json,
  message,
  object,
  pooled,
  shellQuote,
} from "./common.js";
import { commandContext, contextOptions } from "./command-context.js";
import { github, repositoryIdentity } from "./pr-workflow.js";
import { parseJson, parseJsonObject } from "./json.js";

const FIELDS =
  "number,url,title,state,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository,headRepository,headRepositoryOwner,mergeable,isDraft";
const HASH = /^[a-f0-9]{40,64}$/;
type Status =
  | "ready"
  | "would-update"
  | "updated"
  | "up-to-date"
  | "conflict"
  | "changed"
  | "failed"
  | "pending"
  | "skipped";
interface PullRequest {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  state: string;
  mergeable: string;
  isCrossRepository: boolean;
  headRepository: { name: string };
  headRepositoryOwner: { login: string };
  isDraft: boolean;
}
interface Result {
  number: number;
  url?: string;
  branch?: string;
  title?: string;
  status: Status;
  behindCommits?: number;
  headBefore?: string;
  headAfter?: string;
  baseCommit?: string;
  mergeability?: string;
  detail: string;
}
const visible = (value: string) =>
  stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

function validatePr(
  raw: unknown,
  number: number,
  repository: { name: string; url: string },
): PullRequest {
  if (
    !object(raw) ||
    raw.number !== number ||
    raw.url !== `${repository.url}/pull/${number}` ||
    typeof raw.title !== "string" ||
    typeof raw.state !== "string" ||
    typeof raw.headRefName !== "string" ||
    typeof raw.baseRefName !== "string" ||
    typeof raw.headRefOid !== "string" ||
    !HASH.test(raw.headRefOid) ||
    typeof raw.baseRefOid !== "string" ||
    !HASH.test(raw.baseRefOid) ||
    typeof raw.isCrossRepository !== "boolean" ||
    typeof raw.mergeable !== "string" ||
    typeof raw.isDraft !== "boolean" ||
    !object(raw.headRepository) ||
    typeof raw.headRepository.name !== "string" ||
    !object(raw.headRepositoryOwner) ||
    typeof raw.headRepositoryOwner.login !== "string"
  )
    throw new Error(`Invalid metadata for PR #${number}`);
  return raw as unknown as PullRequest;
}
function apiError(stdout: string, stderr: string): string {
  try {
    const response = parseJsonObject(stdout);
    if (typeof response.message === "string") return response.message;
  } catch {
    /* gh may report a transport error without a JSON response. */
  }
  return stderr.trim() || "GitHub request failed";
}
function errorStatus(error: string): Status {
  if (/\bconflicts?\b/i.test(error)) return "conflict";
  if (
    /(?:head|sha).*(?:changed|modified|match|expected)|(?:changed|modified).*(?:head|sha)/i.test(
      error,
    )
  )
    return "changed";
  return "failed";
}
async function choose(
  rows: Result[],
  cwd: string,
  base: string,
  dryRun: boolean,
): Promise<number[]> {
  const choices = rows.filter(
    (row) =>
      (row.behindCommits ?? 0) > 0 &&
      ["ready", "conflict"].includes(row.status),
  );
  if (!choices.length) return [];
  const lines = choices.map(
    (row) =>
      `${row.number}\t#${row.number}  ${row.behindCommits} commits behind  ${visible(row.branch!)}  ${row.status === "conflict" ? "[conflicts] " : ""}${visible(row.title!)}`,
  );
  let selected;
  try {
    selected = await execute(
      [
        "fzf",
        "--multi",
        "--delimiter=\t",
        "--with-nth=2..",
        "--no-sort",
        "--height=70%",
        "--border=rounded",
        "--reverse",
        "--prompt=Update PRs › ",
        "--bind=ctrl-a:select-all,ctrl-d:deselect-all",
        `--header=Tab select · Enter ${dryRun ? "preview" : "merge base into selected PR branches"} · Esc cancel\nBase: ${visible(base)} · behind counts are commits`,
      ],
      cwd,
      { input: lines.join("\n") + "\n", terminalError: true },
    );
  } catch (error) {
    throw new Error(
      `Cannot open PR selector: ${message(error)}. Install fzf or pass PR numbers explicitly`,
    );
  }
  if ([1, 130].includes(selected.code)) return [];
  if (selected.code)
    throw new Error(`PR selector failed (exit ${selected.code})`);
  const ids = selected.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = lines.find(
        (choice) => choice === line || choice.split("\t")[0] === line,
      );
      if (!match) throw new Error("PR selector returned an unknown selection");
      return Number(match.split("\t")[0]);
    });
  return [...new Set(ids)];
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [...contextOptions, "base", "limit"],
    ["json", "dry-run"],
  );
  const [command, action, ...requested] = positionals;
  if (command !== "pr" || action !== "update")
    throw new Error(
      "Usage: rl pr update [PR numbers...] [--base test] [--dry-run] [--json]",
    );
  arity(requested, 0, 50);
  if (
    requested.some(
      (number) =>
        !/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)),
    )
  )
    throw new Error("Expected positive PR numbers");
  const context = commandContext(values);
  const [file, data] = context.store.current();
  const base = String(values.base ?? context.defaultBase).replace(
    /^origin\//,
    "",
  );
  if (
    base.startsWith("-") ||
    git(data.worktree, "check-ref-format", "--branch", base) !== base
  )
    throw new Error("Expected a literal base branch name");
  const limit = Number(values.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("--limit must be between 1 and 200");
  const repository = await repositoryIdentity(data.worktree);
  const hostname = new URL(repository.url).host;
  const endpoint = `repos/${repository.name}`;
  const recheck = () => {
    const [currentFile, current] = context.store.current();
    if (
      currentFile !== file ||
      current.key !== data.key ||
      current.worktree !== data.worktree
    )
      throw new Error("Current RL workspace changed during PR updates");
  };
  async function getPr(number: number): Promise<PullRequest> {
    const result = await github(data.worktree, [
      "pr",
      "view",
      String(number),
      "--repo",
      repository.url,
      "--json",
      FIELDS,
    ]);
    if (result.code) throw new Error(apiError(result.stdout, result.stderr));
    const pr = validatePr(parseJsonObject(result.stdout), number, repository);
    git(data.worktree, "check-ref-format", "--branch", pr.headRefName);
    git(data.worktree, "check-ref-format", "--branch", pr.baseRefName);
    return pr;
  }
  async function inspect(number: number): Promise<Result> {
    try {
      recheck();
      const pr = await getPr(number);
      const row: Result = {
        number,
        url: pr.url,
        branch: pr.headRefName,
        title: pr.title,
        status: "ready",
        headBefore: pr.headRefOid,
        baseCommit: pr.baseRefOid,
        mergeability: pr.mergeable,
        detail: "",
      };
      if (
        pr.state !== "OPEN" ||
        pr.baseRefName !== base ||
        pr.headRefName === base ||
        pr.isCrossRepository ||
        `${pr.headRepositoryOwner.login}/${pr.headRepository.name}`.toLowerCase() !==
          repository.name.toLowerCase()
      )
        return {
          ...row,
          status: "skipped",
          detail: `Requires an open PR in this repository targeting ${base}; fork PRs are not updated`,
        };
      const compared = await github(data.worktree, [
        "api",
        "--hostname",
        hostname,
        "--method",
        "GET",
        `${endpoint}/compare/${pr.baseRefOid}...${pr.headRefOid}?per_page=1`,
      ]);
      if (compared.code)
        throw new Error(apiError(compared.stdout, compared.stderr));
      const comparison = parseJsonObject(compared.stdout);
      if (
        typeof comparison.behind_by !== "number" ||
        !Number.isSafeInteger(comparison.behind_by) ||
        comparison.behind_by < 0
      )
        throw new Error("Invalid commit comparison from GitHub");
      row.behindCommits = comparison.behind_by;
      if (!row.behindCommits)
        return {
          ...row,
          status: "up-to-date",
          detail: `Already contains ${base}`,
        };
      if (pr.mergeable === "CONFLICTING")
        return {
          ...row,
          status: "conflict",
          detail: "GitHub reports merge conflicts; resolve this PR separately",
        };
      return { ...row, detail: `${row.behindCommits} commits behind ${base}` };
    } catch (error) {
      return { number, status: "failed", detail: message(error) };
    }
  }
  let selected = [...new Set(requested.map(Number))];
  const initial = new Map<number, Result>();
  if (!selected.length) {
    const listed = await github(data.worktree, [
      "pr",
      "list",
      "--repo",
      repository.url,
      "--base",
      base,
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number",
    ]);
    if (listed.code) throw new Error(apiError(listed.stdout, listed.stderr));
    const list = parseJson(listed.stdout);
    if (
      !Array.isArray(list) ||
      list.some(
        (item) =>
          !object(item) ||
          !Number.isSafeInteger(item.number) ||
          Number(item.number) < 1,
      )
    )
      throw new Error("Invalid PR list from GitHub");
    const ids = [
      ...new Set(
        list.map((item) => Number((item as { number: number }).number)),
      ),
    ];
    if (!values.json)
      console.error(`Checking up to ${limit} open PRs targeting ${base}…`);
    await pooled(ids, 4, async (number) => {
      initial.set(number, await inspect(number));
    });
    const failed = [...initial.values()].filter(
      (row) => row.status === "failed" || row.status === "skipped",
    );
    for (const row of failed)
      console.error(`#${row.number}: ${visible(row.detail)}`);
    selected = await choose(
      [...initial.values()].sort((a, b) => a.number - b.number),
      data.worktree,
      base,
      !!values["dry-run"],
    );
    if (!selected.length) {
      const report = {
        repository: repository.name,
        workspace: data.worktree,
        base,
        dryRun: !!values["dry-run"],
        results: failed,
        summary: { selected: 0, failures: failed.length },
      };
      if (values.json) json(report);
      else
        console.log(
          `No PRs selected for update.${failed.length ? ` ${failed.length} PRs could not be checked.` : ""}`,
        );
      return failed.length ? 1 : 0;
    }
  }
  if (selected.length > 50)
    throw new Error("Select at most 50 PRs per update batch");
  if (requested.length)
    await pooled(selected, 4, async (number) => {
      initial.set(number, await inspect(number));
    });
  const results: Result[] = [];
  for (const number of selected) {
    let row = initial.get(number)!;
    if (row.status !== "ready") {
      results.push(row);
      continue;
    }
    if (values["dry-run"]) {
      results.push({
        ...row,
        status: "would-update",
        detail: `Would merge latest ${base} into ${row.branch}${row.mergeability === "UNKNOWN" ? "; GitHub has not yet determined mergeability" : ""}`,
      });
      continue;
    }
    try {
      recheck();
      const latest = await inspect(number);
      if (latest.status !== "ready") {
        results.push(latest);
        continue;
      }
      if (
        latest.headBefore !== row.headBefore ||
        latest.branch !== row.branch
      ) {
        results.push({
          ...row,
          status: "changed",
          detail: "PR head changed since selection; review and retry",
        });
        continue;
      }
      row = latest;
      if (!values.json)
        console.error(
          `Merging latest ${base} into #${number} ${visible(row.branch!)}…`,
        );
      recheck();
      const update = await github(data.worktree, [
        "api",
        "--hostname",
        hostname,
        "--method",
        "PUT",
        `${endpoint}/pulls/${number}/update-branch`,
        "-f",
        `expected_head_sha=${row.headBefore}`,
      ]);
      if (update.code) {
        const error = apiError(update.stdout, update.stderr);
        results.push({ ...row, status: errorStatus(error), detail: error });
        continue;
      }
      // Acceptance is asynchronous. Only report updated after verifying base ancestry.
      let verified = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
        const observed = await inspect(number);
        if (observed.status === "up-to-date") {
          results.push({
            ...row,
            status: "updated",
            headAfter: observed.headBefore,
            baseCommit: observed.baseCommit,
            detail: `Latest ${base} is included in the PR branch`,
          });
          verified = true;
          break;
        }
        if (["failed", "skipped", "conflict"].includes(observed.status)) {
          results.push({
            ...row,
            status: "pending",
            detail: `Update accepted; verification incomplete: ${observed.detail}`,
          });
          verified = true;
          break;
        }
      }
      if (!verified)
        results.push({
          ...row,
          status: "pending",
          detail: `GitHub accepted the update; completion is not yet verified. Run rl pr update ${number} --base ${shellQuote(base)} --dry-run to recheck`,
        });
    } catch (error) {
      results.push({ ...row, status: "failed", detail: message(error) });
    }
  }
  const summary = Object.fromEntries(
    [
      "updated",
      "would-update",
      "up-to-date",
      "conflict",
      "changed",
      "failed",
      "pending",
      "skipped",
    ].map((status) => [
      status,
      results.filter((row) => row.status === status).length,
    ]),
  );
  const report = {
    repository: repository.name,
    workspace: data.worktree,
    base,
    dryRun: !!values["dry-run"],
    results,
    summary: { selected: selected.length, ...summary },
  };
  if (values.json) json(report);
  else {
    console.log(
      `\nPR updates: ${repository.name} · base ${visible(base)}${values["dry-run"] ? " · preview" : ""}\nPR      RESULT         BEHIND (COMMITS)  BRANCH`,
    );
    for (const row of results) {
      console.log(
        `${`#${row.number}`.padEnd(8)}${row.status.padEnd(15)}${String(row.behindCommits ?? "?").padEnd(18)}${visible(row.branch ?? "—")}`,
      );
      console.log(`  ${visible(row.detail)}${row.url ? `\n  ${row.url}` : ""}`);
    }
    console.log(
      `\n${results.length} selected · ${Object.entries(summary)
        .filter(([, count]) => count)
        .map(([status, count]) => `${count} ${status}`)
        .join(" · ")}`,
    );
  }
  return results.some((row) =>
    ["conflict", "changed", "failed", "pending", "skipped"].includes(
      row.status,
    ),
  )
    ? 1
    : 0;
}
