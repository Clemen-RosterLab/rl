import path from "node:path";
import {
  args,
  arity,
  canonical,
  execute,
  git,
  locked,
  required,
} from "./common.js";
import {
  commandContext,
  contextOptions,
  resolveWorkspace,
} from "./command-context.js";
import { worktrees } from "./repos.js";
import {
  assertReady,
  GIT_WORKFLOW_DIRECTORY,
  GIT_WORKFLOW_LOCK,
} from "./git-safety.js";
function revision(root: string, ref: string): string {
  return git(
    root,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  );
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [...contextOptions, "message"],
    ["squash", "cleanup", "dry-run"],
    { message: "m" },
  );
  const [command, ...rest] = positionals;
  if (command !== "merge") throw new Error("Unknown Git workflow command");
  arity(rest, 0, 1);
  if (values.message && !values.squash)
    throw new Error("Invalid merge options");
  const context = commandContext(values);
  const source = resolveWorkspace(context);
  return locked(
    path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
    GIT_WORKFLOW_LOCK,
    async () => {
      const selected = rest[0] ?? context.defaultBase.replace(/^origin\//, "");
      const targetRecord = worktrees(context.repo).find(
        (record) => record.branch === `refs/heads/${selected}`,
      );
      if (!targetRecord)
        throw new Error(
          `Target must be a checked-out local branch: ${selected}`,
        );
      const target = canonical(targetRecord.worktree);
      // Main and managed worktrees are the only mutation targets.
      resolveWorkspace(context, target === context.repo ? "@" : target);
      if (target === source.path)
        throw new Error("Source and target are the same worktree");
      if ("locked" in targetRecord)
        throw new Error("Target worktree is locked");
      assertReady(source.path, true, source.branch);
      assertReady(target, true, selected);
      const sourceHead = revision(source.path, "HEAD");
      const targetHead = revision(target, "HEAD");
      const mergeBase = git(target, "merge-base", targetHead, sourceHead);
      if (
        !values.squash &&
        mergeBase !== targetHead &&
        mergeBase !== sourceHead
      )
        throw new Error(
          "Fast-forward merge is not possible. Rebase the feature explicitly first",
        );
      if (values.squash) required(values, "message");
      if (values["dry-run"]) {
        console.log(
          `Would ${values.squash ? "squash merge" : "fast-forward merge"} ${source.branch} into ${selected}${values.cleanup ? " and remove the clean source worktree" : ""}`,
        );
        return 0;
      }
      const result = await execute(
        [
          "git",
          "-C",
          target,
          "merge",
          ...(values.squash ? ["--squash"] : ["--ff-only"]),
          sourceHead,
        ],
        target,
      );
      process.stdout.write(result.stdout);
      if (result.code)
        throw new Error(
          `${result.stderr.trim()}\nMerge did not complete in ${target}; source workspace was retained. Inspect git status before continuing`,
        );
      if (values.squash) {
        const integratedTree = git(target, "write-tree");
        const staged = await execute(
          ["git", "-C", target, "diff", "--cached", "--quiet"],
          target,
        );
        if (staged.code > 1)
          throw new Error(staged.stderr || "Cannot inspect squash result");
        if (staged.code === 1)
          console.log(git(target, "commit", "-m", required(values, "message")));
        if (git(target, "rev-parse", "HEAD^{tree}") !== integratedTree)
          throw new Error(
            "Squash result changed during commit; source workspace retained",
          );
      }
      assertReady(target, true, selected);
      if (
        !values.squash &&
        git(target, "merge-base", "HEAD", sourceHead) !== sourceHead
      )
        throw new Error(
          "Target no longer contains the source; cleanup skipped",
        );
      if (!values.cleanup) return 0;
      // Recheck source immediately before removal; never force worktree/branch deletion.
      assertReady(source.path, true, source.branch);
      if (revision(source.path, "HEAD") !== sourceHead)
        throw new Error("Source changed during merge; cleanup skipped");
      if (source.path === context.repo)
        throw new Error(
          "Integration succeeded; main checkout cannot be removed",
        );
      process.chdir(target);
      git(context.repo, "worktree", "remove", source.path);
      await context.store.locked(() =>
        context.store.archiveWorktrees([source.path]),
      );
      const deleted = await execute(
        ["git", "-C", target, "branch", "-d", "--", source.branch],
        target,
      );
      if (deleted.code)
        console.log(
          `Worktree removed; branch ${source.branch} retained: ${deleted.stderr.trim()}`,
        );
      else process.stdout.write(deleted.stdout);
      return 0;
    },
  );
}
