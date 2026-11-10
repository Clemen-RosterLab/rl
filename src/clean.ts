import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { args, canonical, locked, message, json } from "./common.js";
import { commandContext, contextOptions } from "./command-context.js";
import { GIT_WORKFLOW_DIRECTORY, GIT_WORKFLOW_LOCK } from "./git-safety.js";
import { candidates, select } from "./picker.js";
import { worktrees } from "./repos.js";
import { cleanWorkspace, size, type CleanupReport } from "./storage.js";

type Status = "cleaned" | "would-clean" | "unchanged" | "skipped" | "failed";
interface Result {
  name: string;
  branch: string;
  path: string;
  status: Status;
  detail: string;
  cleanup?: CleanupReport;
}
const visible = (value: string) =>
  stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, contextOptions, [
    "all",
    "dry-run",
    "json",
  ]);
  if (values.all && positionals.length)
    throw new Error("--all cannot be combined with workspace names");
  const context = commandContext(values);
  const choices = candidates(context.repo, context.managedDir, context.store);
  const selected = values.all
    ? choices
    : positionals.length
      ? [
          ...new Set(
            positionals.map((name) => {
              const matches = choices.filter(
                (item) =>
                  item.name === name ||
                  item.branch === name ||
                  (path.isAbsolute(name) && item.path === canonical(name)),
              );
              if (matches.length !== 1)
                throw new Error(
                  matches.length
                    ? `Ambiguous RL worktree: ${name}; use its branch or absolute path`
                    : `RL worktree not found: ${name}. Use rl list.`,
                );
              return matches[0];
            }),
          ),
        ]
      : await select(context.store, choices, context.defaultBase, "clean");
  const dryRun = !!values["dry-run"];
  const perform = async () => {
    const results: Result[] = [];
    for (const item of selected) {
      const result: Result = {
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
        if (!current || current.branch !== `refs/heads/${item.branch}`)
          throw new Error(
            "Worktree branch changed or is unavailable; inspect it and retry",
          );
        if ("locked" in current) throw new Error("Worktree is locked");
        result.status = "failed";
        result.cleanup = cleanWorkspace(context, item.path, dryRun, true);
        result.status = result.cleanup.paths.length
          ? dryRun
            ? "would-clean"
            : "cleaned"
          : "unchanged";
        result.detail = result.cleanup.paths.length
          ? `${dryRun ? "Would remove" : "Removed"} ${result.cleanup.paths.join(", ")} (${size(result.cleanup.estimatedBytes)} estimated)`
          : "No eligible generated directories";
      } catch (error) {
        result.detail = message(error);
      }
      // Let the shared Git lock renew between large worktree cleanups.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const summary = {
      selected: selected.length,
      cleaned: results.filter((result) => result.status === "cleaned").length,
      "would-clean": results.filter((result) => result.status === "would-clean")
        .length,
      unchanged: results.filter((result) => result.status === "unchanged")
        .length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "failed").length,
      estimatedBytes: results.reduce(
        (total, result) => total + (result.cleanup?.estimatedBytes ?? 0),
        0,
      ),
    };
    if (values.json)
      json({ repository: context.repo, dryRun, results, summary });
    else {
      if (!selected.length)
        console.log("No RL worktrees selected for cleanup.");
      else {
        console.log(`\n${dryRun ? "Cleanup preview" : "Cleanup results"}\n`);
        for (const result of results) {
          console.log(`  ${visible(result.name)}  [${result.status}]`);
          console.log(`    ${visible(result.detail)}`);
        }
        console.log(
          `\n${summary.selected} worktree(s) · ${dryRun ? summary["would-clean"] + " would clean" : summary.cleaned + " cleaned"} · ${summary.unchanged} unchanged · ${summary.skipped} skipped · ${summary.failed} failed`,
        );
        console.log(
          `Estimated ${dryRun ? "space to free" : "cleanup size"}: ${size(summary.estimatedBytes)}`,
        );
      }
    }
    return summary.skipped || summary.failed ? 1 : 0;
  };
  return dryRun || !selected.length
    ? perform()
    : locked(
        path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
        GIT_WORKFLOW_LOCK,
        perform,
      );
}
