import { z } from "zod";
import { commandContext, contextOptions } from "./command-context.js";
import {
  args,
  arity,
  git,
  json,
  message,
  object,
  pooled,
  shellQuote,
} from "./common.js";
import { UsageError } from "./errors.js";
import { classifyPrUpdateFailure, extractGhApiError } from "./github/client.js";
import { parseJson, parseJsonObject } from "./json.js";
import { github, repositoryIdentity } from "./pr-workflow.js";
import { GitOidSchema } from "./schemas/common.js";
import type { Store } from "./store.js";
import { sanitizeTerminalText } from "./tui/ansi.js";
import { runFzf } from "./tui/fzf.js";

const PR_FIELDS =
  "number,url,title,state,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository,headRepository,headRepositoryOwner,mergeable,isDraft";

type UpdateStatus =
  | "ready"
  | "would-update"
  | "updated"
  | "up-to-date"
  | "conflict"
  | "changed"
  | "failed"
  | "pending"
  | "skipped";

const PullRequestMetadataSchema = z.looseObject({
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  headRefName: z.string(),
  headRefOid: GitOidSchema,
  baseRefName: z.string(),
  baseRefOid: GitOidSchema,
  state: z.string(),
  mergeable: z.string(),
  isCrossRepository: z.boolean(),
  headRepository: z.looseObject({ name: z.string() }),
  headRepositoryOwner: z.looseObject({ login: z.string() }),
  isDraft: z.boolean(),
});

type PullRequestMetadata = z.infer<typeof PullRequestMetadataSchema>;

interface PrUpdateRow {
  number: number;
  url?: string;
  branch?: string;
  title?: string;
  status: UpdateStatus;
  behindCommits?: number;
  headBefore?: string;
  headAfter?: string;
  baseCommit?: string;
  mergeability?: string;
  detail: string;
}

function validatePullRequest(
  raw: unknown,
  number: number,
  repository: { name: string; url: string },
): PullRequestMetadata {
  const parsed = PullRequestMetadataSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.number !== number ||
    parsed.data.url !== `${repository.url}/pull/${number}`
  ) {
    throw new Error(`Invalid metadata for PR #${number}`);
  }
  return parsed.data;
}

async function selectPrNumbersInteractively(
  rows: readonly PrUpdateRow[],
  cwd: string,
  base: string,
  dryRun: boolean,
): Promise<number[]> {
  const eligible = rows.filter(
    (row) =>
      (row.behindCommits ?? 0) > 0 &&
      (row.status === "ready" || row.status === "conflict"),
  );
  if (eligible.length === 0) {
    return [];
  }

  const fzfRows = eligible.map((row) => ({
    id: String(row.number),
    line: `#${row.number}  ${row.behindCommits} commits behind  ${sanitizeTerminalText(row.branch ?? "")}  ${row.status === "conflict" ? "[conflicts] " : ""}${sanitizeTerminalText(row.title ?? "")}`,
    value: row.number,
  }));

  const actionLabel = dryRun
    ? "preview"
    : "merge base into selected PR branches";

  let picked;
  try {
    picked = await runFzf(fzfRows, {
      cwd,
      prompt: "Update PRs › ",
      header: `Your active RL session PRs · Tab select · Enter ${actionLabel} · Esc cancel\nBase: ${sanitizeTerminalText(base)} · behind counts are commits`,
      multi: true,
      heightPercent: 70,
      errorLabel: "PR selector",
    });
  } catch (error) {
    const detail = message(error);
    if (detail.includes("unknown selection") || detail.includes("exit ")) {
      throw error;
    }
    throw new Error(
      `Cannot open PR selector: ${detail}. Install fzf or pass PR numbers explicitly`,
      { cause: error },
    );
  }

  if (!picked) {
    return [];
  }
  return [...new Set(picked.items)];
}

async function discoverMatchingSessionPrNumbers(options: {
  worktree: string;
  repositoryUrl: string;
  branches: readonly string[];
  base: string;
  limit: number;
}): Promise<number[]> {
  const byBranch = new Map<string, number[]>();

  await pooled([...options.branches], 4, async (branch) => {
    const listed = await github(options.worktree, [
      "pr",
      "list",
      "--repo",
      options.repositoryUrl,
      "--head",
      branch,
      "--base",
      options.base,
      "--state",
      "open",
      "--limit",
      String(options.limit),
      "--json",
      "number,headRefName",
    ]);
    if (listed.code !== 0) {
      throw new Error(extractGhApiError(listed.stdout, listed.stderr));
    }
    const list = parseJson(listed.stdout);
    if (
      !Array.isArray(list) ||
      list.some(
        (item) =>
          !object(item) ||
          !Number.isSafeInteger(item.number) ||
          Number(item.number) < 1 ||
          item.headRefName !== branch,
      )
    ) {
      throw new Error("Invalid RL session PR list from GitHub");
    }
    byBranch.set(
      branch,
      list.map((item) => Number((item as { number: number }).number)),
    );
  });

  return [
    ...new Set(
      options.branches.flatMap((branch) => byBranch.get(branch) ?? []),
    ),
  ].slice(0, options.limit);
}

function renderPrUpdatesReport(options: {
  repositoryName: string;
  workspace: string;
  base: string;
  dryRun: boolean;
  selectedCount: number;
  results: readonly PrUpdateRow[];
  asJson: boolean;
}): number {
  const summaryStatuses: UpdateStatus[] = [
    "updated",
    "would-update",
    "up-to-date",
    "conflict",
    "changed",
    "failed",
    "pending",
    "skipped",
  ];
  const summary = Object.fromEntries(
    summaryStatuses.map((status) => [
      status,
      options.results.filter((row) => row.status === status).length,
    ]),
  );

  const report = {
    repository: options.repositoryName,
    workspace: options.workspace,
    base: options.base,
    dryRun: options.dryRun,
    results: options.results,
    summary: { selected: options.selectedCount, ...summary },
  };

  if (options.asJson) {
    json(report);
  } else {
    console.log(
      `\nPR updates: ${options.repositoryName} · base ${sanitizeTerminalText(options.base)}${options.dryRun ? " · preview" : ""}\nPR      RESULT         BEHIND (COMMITS)  BRANCH`,
    );
    for (const row of options.results) {
      console.log(
        `${`#${row.number}`.padEnd(8)}${row.status.padEnd(15)}${String(row.behindCommits ?? "?").padEnd(18)}${sanitizeTerminalText(row.branch ?? "—")}`,
      );
      console.log(
        `  ${sanitizeTerminalText(row.detail)}${row.url ? `\n  ${row.url}` : ""}`,
      );
    }
    const nonZeroCounts = Object.entries(summary)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`)
      .join(" · ");
    console.log(`\n${options.results.length} selected · ${nonZeroCounts}`);
  }

  return options.results.some((row) =>
    ["conflict", "changed", "failed", "pending", "skipped"].includes(
      row.status,
    ),
  )
    ? 1
    : 0;
}

function captureInitialBranchOwners(store: Store): {
  owners: Map<string, Set<string>>;
  ownsBranch: (branch: string) => boolean;
} {
  const owners = new Map<string, Set<string>>();
  for (const [, instance] of store.records()) {
    if (instance.status !== "active") continue;
    const keys = owners.get(instance.branch) ?? new Set<string>();
    keys.add(instance.key);
    owners.set(instance.branch, keys);
  }

  const ownsBranch = (branch: string): boolean => {
    const keys = owners.get(branch);
    if (!keys) return false;
    return store
      .records()
      .some(
        ([, instance]) =>
          instance.status === "active" &&
          instance.branch === branch &&
          keys.has(instance.key),
      );
  };

  return { owners, ownsBranch };
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [...contextOptions, "base", "limit"],
    ["json", "dry-run"],
  );
  const [command, action, ...requested] = positionals;
  if (command !== "pr" || action !== "update") {
    throw new UsageError(
      "Usage: rl pr update [PR numbers...] [--base test] [--dry-run] [--json]",
    );
  }
  arity(requested, 0, 50);

  if (
    requested.some(
      (number) =>
        !/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)),
    )
  ) {
    throw new UsageError("Expected positive PR numbers");
  }

  const context = commandContext(values);
  const [file, data] = context.store.current();
  const { owners, ownsBranch } = captureInitialBranchOwners(context.store);

  const base = String(values.base ?? context.defaultBase).replace(
    /^origin\//,
    "",
  );
  if (
    base.startsWith("-") ||
    git(data.worktree, "check-ref-format", "--branch", base) !== base
  ) {
    throw new UsageError("Expected a literal base branch name");
  }

  const limit = Number(values.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new UsageError("--limit must be between 1 and 200");
  }

  const repository = await repositoryIdentity(data.worktree);
  const hostname = new URL(repository.url).host;
  const endpoint = `repos/${repository.name}`;

  const assertSameActiveWorkspace = () => {
    const [currentFile, current] = context.store.current();
    if (
      currentFile !== file ||
      current.key !== data.key ||
      current.worktree !== data.worktree
    ) {
      throw new Error("Current RL workspace changed during PR updates");
    }
  };

  async function inspectPr(number: number): Promise<PrUpdateRow> {
    try {
      assertSameActiveWorkspace();
      const result = await github(data.worktree, [
        "pr",
        "view",
        String(number),
        "--repo",
        repository.url,
        "--json",
        PR_FIELDS,
      ]);
      if (result.code !== 0) {
        throw new Error(extractGhApiError(result.stdout, result.stderr));
      }
      const pr = validatePullRequest(
        parseJsonObject(result.stdout),
        number,
        repository,
      );
      git(data.worktree, "check-ref-format", "--branch", pr.headRefName);
      git(data.worktree, "check-ref-format", "--branch", pr.baseRefName);

      const row: PrUpdateRow = {
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

      if (!ownsBranch(pr.headRefName)) {
        return {
          ...row,
          status: "skipped",
          detail:
            "PR branch does not belong to an active RL session in this repository",
        };
      }

      if (
        pr.state !== "OPEN" ||
        pr.baseRefName !== base ||
        pr.headRefName === base ||
        pr.isCrossRepository ||
        `${pr.headRepositoryOwner.login}/${pr.headRepository.name}`.toLowerCase() !==
          repository.name.toLowerCase()
      ) {
        return {
          ...row,
          status: "skipped",
          detail: `Requires an open PR in this repository targeting ${base}; fork PRs are not updated`,
        };
      }

      const compared = await github(data.worktree, [
        "api",
        "--hostname",
        hostname,
        "--method",
        "GET",
        `${endpoint}/compare/${pr.baseRefOid}...${pr.headRefOid}?per_page=1`,
      ]);
      if (compared.code !== 0) {
        throw new Error(extractGhApiError(compared.stdout, compared.stderr));
      }

      const comparison = parseJsonObject(compared.stdout);
      if (
        typeof comparison.behind_by !== "number" ||
        !Number.isSafeInteger(comparison.behind_by) ||
        comparison.behind_by < 0
      ) {
        throw new Error("Invalid commit comparison from GitHub");
      }

      row.behindCommits = comparison.behind_by;
      if (row.behindCommits === 0) {
        return {
          ...row,
          status: "up-to-date",
          detail: `Already contains ${base}`,
        };
      }
      if (pr.mergeable === "CONFLICTING") {
        return {
          ...row,
          status: "conflict",
          detail: "GitHub reports merge conflicts; resolve this PR separately",
        };
      }
      return { ...row, detail: `${row.behindCommits} commits behind ${base}` };
    } catch (error) {
      return { number, status: "failed", detail: message(error) };
    }
  }

  let selectedNumbers = [...new Set(requested.map(Number))];
  const initialInspections = new Map<number, PrUpdateRow>();
  const dryRun = Boolean(values["dry-run"]);
  const asJson = Boolean(values.json);

  if (selectedNumbers.length === 0) {
    if (!asJson) {
      console.error(
        `Checking up to ${limit} open PRs from your active RL sessions targeting ${base}…`,
      );
    }

    const candidateNumbers = await discoverMatchingSessionPrNumbers({
      worktree: data.worktree,
      repositoryUrl: repository.url,
      branches: [...owners.keys()].toSorted(),
      base,
      limit,
    });

    await pooled(candidateNumbers, 4, async (number) => {
      initialInspections.set(number, await inspectPr(number));
    });

    const failedRows = [...initialInspections.values()].filter(
      (row) => row.status === "failed" || row.status === "skipped",
    );
    for (const row of failedRows) {
      console.error(`#${row.number}: ${sanitizeTerminalText(row.detail)}`);
    }

    selectedNumbers = await selectPrNumbersInteractively(
      [...initialInspections.values()].toSorted((a, b) => a.number - b.number),
      data.worktree,
      base,
      dryRun,
    );

    if (selectedNumbers.length === 0) {
      const emptyReport = {
        repository: repository.name,
        workspace: data.worktree,
        base,
        dryRun,
        results: failedRows,
        summary: { selected: 0, failures: failedRows.length },
      };
      if (asJson) {
        json(emptyReport);
      } else {
        const suffix =
          failedRows.length > 0
            ? ` ${failedRows.length} PRs could not be checked.`
            : "";
        console.log(`No RL session PRs selected for update.${suffix}`);
      }
      return failedRows.length > 0 ? 1 : 0;
    }
  }

  if (selectedNumbers.length > 50) {
    throw new UsageError("Select at most 50 PRs per update batch");
  }

  if (requested.length > 0) {
    await pooled(selectedNumbers, 4, async (number) => {
      initialInspections.set(number, await inspectPr(number));
    });
  }

  const results: PrUpdateRow[] = [];
  for (const number of selectedNumbers) {
    let row = initialInspections.get(number)!;
    if (row.status !== "ready") {
      results.push(row);
      continue;
    }

    if (dryRun) {
      const mergeabilityNote =
        row.mergeability === "UNKNOWN"
          ? "; GitHub has not yet determined mergeability"
          : "";
      results.push({
        ...row,
        status: "would-update",
        detail: `Would merge latest ${base} into ${row.branch}${mergeabilityNote}`,
      });
      continue;
    }

    try {
      assertSameActiveWorkspace();
      const latest = await inspectPr(number);
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
      if (!asJson) {
        console.error(
          `Merging latest ${base} into #${number} ${sanitizeTerminalText(row.branch ?? "")}…`,
        );
      }

      assertSameActiveWorkspace();
      if (!ownsBranch(row.branch!)) {
        results.push({
          ...row,
          status: "skipped",
          detail:
            "PR branch no longer belongs to the selected active RL session",
        });
        continue;
      }

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
      if (update.code !== 0) {
        const errorText = extractGhApiError(update.stdout, update.stderr);
        results.push({
          ...row,
          status: classifyPrUpdateFailure(errorText),
          detail: errorText,
        });
        continue;
      }

      // Acceptance is asynchronous; verify base ancestry before reporting updated.
      let verified = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const observed = await inspectPr(number);
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

      if (!verified) {
        results.push({
          ...row,
          status: "pending",
          detail: `GitHub accepted the update; completion is not yet verified. Run rl pr update ${number} --base ${shellQuote(base)} --dry-run to recheck`,
        });
      }
    } catch (error) {
      results.push({ ...row, status: "failed", detail: message(error) });
    }
  }

  return renderPrUpdatesReport({
    repositoryName: repository.name,
    workspace: data.worktree,
    base,
    dryRun,
    selectedCount: selectedNumbers.length,
    results,
    asJson,
  });
}
