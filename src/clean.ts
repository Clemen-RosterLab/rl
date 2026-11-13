import path from "node:path";
import { commandContext, contextOptions } from "./command-context.js";
import { args, canonical, json, locked, message } from "./common.js";
import { UsageError } from "./errors.js";
import { GIT_WORKFLOW_DIRECTORY, GIT_WORKFLOW_LOCK } from "./git-safety.js";
import { candidates, select } from "./picker.js";
import { worktrees } from "./repos.js";
import { cleanWorkspace, size, type CleanupReport } from "./storage.js";
import { sanitizeTerminalText } from "./tui/ansi.js";
import { selectMatchingItem } from "./workspaces/resolve.js";

type CleanStatus =
  "cleaned" | "would-clean" | "unchanged" | "skipped" | "failed";

interface CleanWorktreeResult {
  name: string;
  branch: string;
  path: string;
  status: CleanStatus;
  detail: string;
  cleanup?: CleanupReport;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, contextOptions, [
    "all",
    "dry-run",
    "json",
  ]);
  if (values.all && positionals.length > 0) {
    throw new UsageError("--all cannot be combined with workspace names");
  }

  const context = commandContext(values);
  const choices = candidates(context.repo, context.managedDir, context.store);

  let selected;
  if (values.all) {
    selected = choices;
  } else if (positionals.length > 0) {
    selected = [
      ...new Set(
        positionals.map((selector) =>
          selectMatchingItem(choices, selector, {
            ambiguousMessage: (s) =>
              `Ambiguous RL worktree: ${s}; use its branch or absolute path`,
            notFoundMessage: (s) => `RL worktree not found: ${s}. Use rl list.`,
          }),
        ),
      ),
    ];
  } else {
    selected = await select(
      context.store,
      choices,
      context.defaultBase,
      "clean",
    );
  }

  const dryRun = Boolean(values["dry-run"]);

  const perform = async () => {
    const results: CleanWorktreeResult[] = [];
    for (const item of selected) {
      const result: CleanWorktreeResult = {
        name: item.name,
        branch: item.branch,
        path: item.path,
        status: "skipped",
        detail: "",
      };
      results.push(result);

      try {
        const current = worktrees(context.repo).find(
          (record) => canonical(record.worktree) === item.path,
        );
        if (!current || current.branch !== `refs/heads/${item.branch}`) {
          throw new Error(
            "Worktree branch changed or is unavailable; inspect it and retry",
          );
        }
        if ("locked" in current) {
          throw new Error("Worktree is locked");
        }

        result.status = "failed";
        result.cleanup = cleanWorkspace(context, item.path, dryRun, true);

        if (result.cleanup.paths.length > 0) {
          result.status = dryRun ? "would-clean" : "cleaned";
          const verb = dryRun ? "Would remove" : "Removed";
          result.detail = `${verb} ${result.cleanup.paths.join(", ")} (${size(result.cleanup.estimatedBytes)} estimated)`;
        } else {
          result.status = "unchanged";
          result.detail = "No eligible generated directories";
        }
      } catch (error) {
        result.detail = message(error);
      }

      // Yield between large worktrees so proper-lockfile heartbeats can run.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const summary = {
      selected: selected.length,
      cleaned: results.filter((row) => row.status === "cleaned").length,
      "would-clean": results.filter((row) => row.status === "would-clean")
        .length,
      unchanged: results.filter((row) => row.status === "unchanged").length,
      skipped: results.filter((row) => row.status === "skipped").length,
      failed: results.filter((row) => row.status === "failed").length,
      estimatedBytes: results.reduce(
        (total, row) => total + (row.cleanup?.estimatedBytes ?? 0),
        0,
      ),
    };

    if (values.json) {
      json({ repository: context.repo, dryRun, results, summary });
    } else if (selected.length === 0) {
      console.log("No RL worktrees selected for cleanup.");
    } else {
      console.log(`\n${dryRun ? "Cleanup preview" : "Cleanup results"}\n`);
      for (const row of results) {
        console.log(`  ${sanitizeTerminalText(row.name)}  [${row.status}]`);
        console.log(`    ${sanitizeTerminalText(row.detail)}`);
      }
      const actionSummary = dryRun
        ? `${summary["would-clean"]} would clean`
        : `${summary.cleaned} cleaned`;
      console.log(
        `\n${summary.selected} worktree(s) · ${actionSummary} · ${summary.unchanged} unchanged · ${summary.skipped} skipped · ${summary.failed} failed`,
      );
      console.log(
        `Estimated ${dryRun ? "space to free" : "cleanup size"}: ${size(summary.estimatedBytes)}`,
      );
    }

    return summary.skipped > 0 || summary.failed > 0 ? 1 : 0;
  };

  if (dryRun || selected.length === 0) {
    return perform();
  }
  return locked(
    path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
    GIT_WORKFLOW_LOCK,
    perform,
  );
}
