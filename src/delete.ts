import path from "node:path";
import {
  args,
  canonical,
  execute,
  git,
  inside,
  locked,
  message,
  pooled,
  required,
} from "./common.js";
import { Store } from "./store.js";
import { worktrees } from "./repos.js";
import { candidates, select, Candidate } from "./picker.js";
import {
  assertReady,
  GIT_WORKFLOW_DIRECTORY,
  GIT_WORKFLOW_LOCK,
} from "./git-safety.js";
export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    ["repo", "state-dir", "base-dir", "jobs", "default-base"],
    ["dry-run", "force"],
  );
  const jobs = Number(values.jobs ?? 4);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 32)
    throw new Error("jobs must be an integer from 1 to 32");
  const repo = canonical(required(values, "repo")),
    base = canonical(required(values, "base-dir")),
    registered = worktrees(repo),
    items = new Map<string, Candidate>();
  for (const item of candidates(repo, base)) items.set(item.name, item);
  let names = positionals;
  if (!names.length)
    names = (
      await select(
        new Store(repo, required(values, "state-dir")),
        [...items.values()],
        String(values["default-base"] ?? "origin/test"),
        true,
      )
    ).map((item) => item.name);
  names = [...new Set(names)];
  if (!names.length) return 0;
  const unknown = names.filter((name) => !items.has(name));
  if (unknown.length)
    throw new Error("Not registered managed worktrees: " + unknown.join(", "));
  const selected = names.map((name) => items.get(name)!);
  for (const item of selected)
    if (
      registered.some((other) => inside(canonical(other.worktree), item.path))
    )
      throw new Error(
        `${item.name} contains another registered worktree; delete its children first`,
      );
  for (const item of selected)
    console.log(
      `${values["dry-run"] ? "Would delete" : "Selected"}: ${item.name} [branch: ${item.branch || "(detached)"}]${item.locked ? " [locked: will be skipped]" : ""}`,
    );
  if (values["dry-run"]) return 0;
  const store = new Store(repo, required(values, "state-dir"));
  return locked(
    path.join(store.root, GIT_WORKFLOW_DIRECTORY),
    GIT_WORKFLOW_LOCK,
    async () => {
      await store.locked(() => store.records());
      process.chdir(repo);
      console.log(
        `Removing ${selected.length} workspace(s), up to ${jobs} at a time...`,
      );
      const removed: Candidate[] = [],
        failed: Candidate[] = [];
      await pooled(selected, jobs, async (item) => {
        try {
          const current = worktrees(repo).find(
            (entry) => canonical(entry.worktree) === item.path,
          );
          if (
            !current ||
            (current.branch ?? "").replace(/^refs\/heads\//, "") !== item.branch
          )
            throw new Error("Workspace branch changed; inspect it and retry");
          if (!values.force && !item.branch)
            throw new Error(
              "Detached workspace may contain unmerged commits; inspect it or use --force",
            );
          if (!values.force) assertReady(item.path, true, item.branch);
          if (!values.force && item.branch) {
            const upstream = git(
              repo,
              "for-each-ref",
              "--format=%(upstream)",
              `refs/heads/${item.branch}`,
            );
            const merged = await execute(
              [
                "git",
                "-C",
                repo,
                "merge-base",
                "--is-ancestor",
                `refs/heads/${item.branch}`,
                upstream || "HEAD",
              ],
              repo,
            );
            if (merged.code)
              throw new Error(
                "Branch has unmerged commits; merge it first or use --force",
              );
          }
          const result = await execute(
            [
              "git",
              "-C",
              repo,
              "worktree",
              "remove",
              ...(values.force ? ["--force"] : []),
              item.path,
            ],
            repo,
          );
          if (result.code) throw new Error(result.stderr.trim());
          removed.push(item);
          console.log(`Removed worktree: ${item.name}`);
        } catch (error) {
          failed.push(item);
          console.error(`Failed: ${item.name}: ${message(error)}`);
        }
      });
      await store.locked(() =>
        store.archiveWorktrees(removed.map((item) => item.path)),
      );
      let cleanupFailed = false;
      const branches = [
        ...new Set(removed.map((item) => item.branch).filter(Boolean)),
      ];
      if (branches.length) {
        const result = await execute(
          [
            "git",
            "-C",
            repo,
            "branch",
            values.force ? "-D" : "-d",
            "--",
            ...branches,
          ],
          repo,
        );
        process.stdout.write(result.stdout);
        if (result.code) {
          cleanupFailed = true;
          console.error(
            "Some worktrees were removed but local branch cleanup failed:\n" +
              result.stderr.trim(),
          );
        }
      }
      if (removed.length) {
        const result = await execute(
          ["git", "-C", repo, "worktree", "prune"],
          repo,
        );
        if (result.code) {
          cleanupFailed = true;
          console.error("Worktree pruning failed: " + result.stderr.trim());
        }
      }
      console.log(
        `Removed ${removed.length} worktree(s); failed ${failed.length}. Saved documentation and session history retained.`,
      );
      return failed.length || cleanupFailed ? 1 : 0;
    },
  );
}
