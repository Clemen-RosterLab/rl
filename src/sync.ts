import path from "node:path";
import {
  commandContext,
  contextOptions,
  type CommandContext,
} from "./command-context.js";
import {
  args,
  canonical,
  execute,
  git,
  gitRaw,
  json,
  locked,
  message,
} from "./common.js";
import {
  assertReady,
  GIT_WORKFLOW_DIRECTORY,
  GIT_WORKFLOW_LOCK,
} from "./git-safety.js";
import {
  resolveBaseRef,
  resolveCommitOid,
  type ResolvedBaseRef,
} from "./git/base.js";
import { worktrees } from "./repos.js";
import type { Instance } from "./store.js";
import { sanitizeTerminalText } from "./tui/ansi.js";
import {
  nameActiveInstances,
  selectMatchingItem,
} from "./workspaces/resolve.js";

type SyncStatus =
  "updated" | "up-to-date" | "would-update" | "conflict" | "skipped" | "failed";

interface SyncTarget {
  instance: Instance;
  name: string;
  branch: string;
  path: string;
  requestedBase: string;
  base?: ResolvedBaseRef;
}

interface SyncResultRow {
  branch: string;
  workspace: string;
  base: string;
  status: SyncStatus;
  detail: string;
  headBefore?: string;
  headAfter?: string;
  baseCommit?: string;
  behindCommits?: number;
  conflicts?: string[];
}

interface RemoteFetchResult {
  remote: string;
  status: "fetched" | "failed";
  detail?: string;
}

const displayRef = (ref: string): string =>
  ref.replace(/^refs\/(?:heads|remotes)\//, "");

async function fetchAllRemotes(
  repoRoot: string,
  remotes: readonly string[],
  asJson: boolean,
  isInterrupted: () => boolean,
): Promise<RemoteFetchResult[]> {
  const fetches: RemoteFetchResult[] = [];
  for (const remote of remotes) {
    if (isInterrupted()) {
      fetches.push({
        remote,
        status: "failed",
        detail: "Sync interrupted",
      });
      break;
    }
    if (!asJson) {
      console.error(`Fetching ${sanitizeTerminalText(remote)}…`);
    }
    const fetched = await execute(
      ["git", "fetch", "--prune", "--", remote],
      repoRoot,
    );
    fetches.push({
      remote,
      status: fetched.code !== 0 ? "failed" : "fetched",
      ...(fetched.code !== 0
        ? { detail: fetched.stderr.trim() || "Fetch failed" }
        : {}),
    });
  }
  return fetches;
}

function renderSyncSummary(options: {
  repoRoot: string;
  dryRun: boolean;
  selectedCount: number;
  fetches: readonly RemoteFetchResult[];
  results: readonly SyncResultRow[];
  asJson: boolean;
}): number {
  const allStatuses: SyncStatus[] = [
    "updated",
    "up-to-date",
    "would-update",
    "conflict",
    "skipped",
    "failed",
  ];
  const summary = Object.fromEntries(
    allStatuses.map((status) => [
      status,
      options.results.filter((row) => row.status === status).length,
    ]),
  );

  if (options.asJson) {
    json({
      repository: options.repoRoot,
      dryRun: options.dryRun,
      fetches: options.fetches,
      results: options.results,
      summary,
    });
  } else if (options.selectedCount === 0) {
    console.log("No active RL workspaces to sync in this repository.");
  } else {
    console.log(
      `\n${options.dryRun ? "Sync preview" : "Sync results"} · ${sanitizeTerminalText(options.repoRoot)}\n`,
    );
    for (const row of options.results) {
      console.log(
        `  ${sanitizeTerminalText(row.branch)} ← ${sanitizeTerminalText(row.base)}  [${row.status}]`,
      );
      console.log(`    ${sanitizeTerminalText(row.detail)}`);
      if (row.conflicts?.length) {
        console.log(
          `    Conflicts: ${row.conflicts.map((item) => sanitizeTerminalText(item)).join(", ")}`,
        );
      }
    }
    const countsLine = Object.entries(summary)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`)
      .join(" · ");
    console.log(`\n${countsLine}`);
  }

  return options.results.some((row) =>
    ["conflict", "failed", "skipped"].includes(row.status),
  )
    ? 1
    : 0;
}

async function syncOneWorkspace(options: {
  context: CommandContext;
  target: SyncTarget;
  results: readonly SyncResultRow[];
  dryRun: boolean;
  markInterrupted: (flag: boolean) => boolean;
}): Promise<SyncResultRow> {
  const { context, target, results, dryRun, markInterrupted } = options;
  const { instance } = target;

  const row: SyncResultRow = {
    branch: instance.branch,
    workspace: instance.worktree,
    base: displayRef(target.base?.ref ?? target.requestedBase),
    status: "skipped",
    detail: "",
  };

  try {
    const [, current] = context.store.current(instance.worktree);
    if (
      current.key !== instance.key ||
      current.worktree !== instance.worktree
    ) {
      throw new Error("RL workspace changed during sync; retry");
    }

    const checkout = worktrees(context.repo).find(
      (entry) => canonical(entry.worktree) === instance.worktree,
    );
    if (!checkout || checkout.branch !== `refs/heads/${instance.branch}`) {
      throw new Error("Workspace branch changed; retry");
    }
    if ("locked" in checkout) {
      throw new Error("Worktree is locked");
    }

    assertReady(instance.worktree, true, instance.branch);

    if (!target.base) {
      row.status = "failed";
      throw new Error(`Base does not exist: ${target.requestedBase}`);
    }

    const parent = target.base.ref.startsWith("refs/heads/")
      ? results.find(
          (other) => `refs/heads/${other.branch}` === target.base!.ref,
        )
      : undefined;
    if (
      parent &&
      !["updated", "up-to-date", "would-update"].includes(parent.status)
    ) {
      throw new Error(`Base workspace ${parent.branch} was not synced`);
    }

    const resolvedOid = target.base.ref.startsWith("refs/heads/")
      ? resolveCommitOid(context.repo, target.base.ref)
      : target.base.oid;
    if (!resolvedOid) {
      row.status = "failed";
      throw new Error("Base changed during sync; retry");
    }

    const base: ResolvedBaseRef = { ref: target.base.ref, oid: resolvedOid };
    row.headBefore = git(instance.worktree, "rev-parse", "HEAD");
    row.baseCommit = base.oid;
    row.behindCommits = Number(
      git(
        instance.worktree,
        "rev-list",
        "--count",
        `${row.headBefore}..${base.oid}`,
      ),
    );

    if (
      row.behindCommits === 0 &&
      !(dryRun && parent?.status === "would-update")
    ) {
      row.status = "up-to-date";
      row.headAfter = row.headBefore;
      row.detail = "Already contains its base";
      return row;
    }

    if (dryRun) {
      row.status = "would-update";
      row.detail =
        parent?.status === "would-update"
          ? "Would merge its updated local base; conflicts checked during sync"
          : `Would merge ${row.behindCommits} base commit(s); conflicts checked during sync`;
      return row;
    }

    assertReady(instance.worktree, true, instance.branch);
    row.status = "failed";

    const merged = await execute(
      [
        "git",
        "merge",
        "--ff",
        "--no-edit",
        "--no-autostash",
        "-m",
        `Merge ${displayRef(base.ref)} into ${instance.branch}`,
        base.oid,
      ],
      instance.worktree,
    );

    const wasInterrupted = markInterrupted(
      merged.code === 130 || merged.code === 143,
    );
    row.headAfter = git(instance.worktree, "rev-parse", "HEAD");

    if (merged.code !== 0) {
      const conflicts = gitRaw(
        instance.worktree,
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
      )
        .split("\0")
        .filter(Boolean);
      if (conflicts.length > 0) {
        row.conflicts = conflicts;
      }

      const mergeHead = resolveCommitOid(instance.worktree, "MERGE_HEAD");
      if (mergeHead) {
        if (mergeHead !== base.oid || row.headAfter !== row.headBefore) {
          throw new Error(
            "Merge state changed externally; inspect this workspace before continuing",
          );
        }
        const aborted = await execute(
          ["git", "merge", "--abort"],
          instance.worktree,
        );
        if (aborted.code !== 0) {
          throw new Error(
            `Could not abort the merge: ${aborted.stderr.trim()}. Inspect ${instance.worktree}`,
          );
        }
        assertReady(instance.worktree, true, instance.branch);
        if (git(instance.worktree, "rev-parse", "HEAD") !== row.headBefore) {
          throw new Error(
            "Branch changed while aborting the merge; inspect the workspace",
          );
        }
      }

      if (conflicts.length > 0 && !mergeHead) {
        throw new Error(
          "Conflicts remain without the expected merge state; inspect the workspace",
        );
      }

      row.status = conflicts.length > 0 ? "conflict" : "failed";
      if (wasInterrupted) {
        row.detail = `Sync interrupted${mergeHead ? "; merge was aborted" : ""}`;
      } else if (conflicts.length > 0) {
        row.detail = "Merge conflicted and was aborted; branch left unchanged";
      } else {
        row.detail = `Merge failed${mergeHead ? " and was aborted" : ""}: ${merged.stderr.trim() || merged.stdout.trim()}`;
      }
      return row;
    }

    assertReady(instance.worktree, true, instance.branch);
    const contains = await execute(
      ["git", "merge-base", "--is-ancestor", base.oid, "HEAD"],
      instance.worktree,
    );
    if (contains.code !== 0) {
      throw new Error(
        "Merge finished but the branch no longer contains the selected base; inspect the workspace",
      );
    }

    row.status = "updated";
    row.detail = `Merged ${row.behindCommits} base commit(s)`;
  } catch (error) {
    row.detail = message(error);
  }

  return row;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, contextOptions, [
    "dry-run",
    "json",
  ]);
  const context = commandContext(values);

  const namedInstances = nameActiveInstances(
    context.store.records().map(([, instance]) => instance),
    context.repo,
    context.managedDir,
  );

  const targets: SyncTarget[] = namedInstances
    .map(({ instance, name }) => ({
      instance,
      name,
      branch: instance.branch,
      path: instance.worktree,
      requestedBase:
        typeof instance.baseBranch === "string" && instance.baseBranch
          ? instance.baseBranch
          : context.defaultBase,
    }))
    .toSorted((a, b) => a.branch.localeCompare(b.branch));

  const selected =
    positionals.length > 0
      ? [
          ...new Set(
            positionals.map((selector) =>
              selectMatchingItem(targets, selector, {
                ambiguousMessage: (s) =>
                  `Ambiguous RL workspace: ${s}; use its branch or absolute path`,
                notFoundMessage: (s) =>
                  `Active RL workspace not found: ${s}. Use rl list.`,
              }),
            ),
          ),
        ]
      : targets;

  const dryRun = Boolean(values["dry-run"]);
  const asJson = Boolean(values.json);
  let interrupted = false;
  const stop = () => {
    interrupted = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    return await locked(
      path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
      GIT_WORKFLOW_LOCK,
      async () => {
        const results: SyncResultRow[] = [];
        if (selected.length === 0) {
          return renderSyncSummary({
            repoRoot: context.repo,
            dryRun,
            selectedCount: 0,
            fetches: [],
            results,
            asJson,
          });
        }

        const remotes = git(context.repo, "remote").split("\n").filter(Boolean);
        const fetches = await fetchAllRemotes(
          context.repo,
          remotes,
          asJson,
          () => interrupted,
        );

        const failedFetches = fetches.filter(
          (fetchItem) => fetchItem.status === "failed",
        );
        if (failedFetches.length > 0) {
          const failureSummary = failedFetches
            .map((fetchItem) => `${fetchItem.remote}: ${fetchItem.detail}`)
            .join("; ");
          for (const target of selected) {
            results.push({
              branch: target.branch,
              workspace: target.path,
              base: target.requestedBase,
              status: "failed",
              detail: `Fetch failed; no branches were merged. ${failureSummary}`,
            });
          }
          return renderSyncSummary({
            repoRoot: context.repo,
            dryRun,
            selectedCount: selected.length,
            fetches,
            results,
            asJson,
          });
        }

        for (const target of selected) {
          target.base =
            resolveBaseRef(context.repo, target.requestedBase, {
              prefer: "remote",
              remotes,
            }) ?? undefined;
        }

        const pending = [...selected];
        while (pending.length > 0) {
          if (interrupted) {
            for (const target of pending) {
              results.push({
                branch: target.branch,
                workspace: target.path,
                base: target.requestedBase,
                status: "skipped",
                detail: "Sync interrupted; workspace left unchanged",
              });
            }
            break;
          }

          const readyIndex = pending.findIndex(
            (target) =>
              !target.base?.ref.startsWith("refs/heads/") ||
              !pending.some(
                (other) =>
                  other !== target &&
                  target.base!.ref === `refs/heads/${other.branch}`,
              ),
          );

          if (readyIndex < 0) {
            for (const target of pending) {
              results.push({
                branch: target.branch,
                workspace: target.path,
                base: target.requestedBase,
                status: "skipped",
                detail:
                  "Cyclic local base dependencies; choose a base outside the cycle",
              });
            }
            break;
          }

          const [target] = pending.splice(readyIndex, 1);
          const row = await syncOneWorkspace({
            context,
            target,
            results,
            dryRun,
            markInterrupted: (flag) => {
              if (flag) interrupted = true;
              return interrupted;
            },
          });
          results.push(row);
        }

        return renderSyncSummary({
          repoRoot: context.repo,
          dryRun,
          selectedCount: selected.length,
          fetches,
          results,
          asJson,
        });
      },
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
