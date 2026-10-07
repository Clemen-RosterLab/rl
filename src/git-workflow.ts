import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  args,
  arity,
  canonical,
  execute,
  git,
  gitRaw,
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
const BACKUP_PREFIX = "refs/rl/backups/";
const READ_OPTIONS = new Set([
  "--stat",
  "--name-only",
  "--name-status",
  "--numstat",
  "--patch",
  "--oneline",
  "--graph",
  "--decorate",
  "--all",
]);

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
  const separator = argv.indexOf("--");
  const trailing = separator < 0 ? [] : argv.slice(separator + 1);
  const { values, positionals } = args(
    separator < 0 ? argv : argv.slice(0, separator),
    [...contextOptions, "base", "message"],
    ["all", "squash", "cleanup", "dry-run"],
    { message: "m" },
  );
  const context = commandContext(values);
  const [command, ...rest] = positionals;
  const source = resolveWorkspace(context);
  if (command === "diff" || command === "log") {
    arity(rest, 0);
    if (
      values.all ||
      values.squash ||
      values.cleanup ||
      values.message ||
      values["dry-run"]
    )
      throw new Error("Invalid display options");
    const pathSeparator = trailing.indexOf("--");
    const flags =
      pathSeparator < 0 ? trailing : trailing.slice(0, pathSeparator);
    const paths = pathSeparator < 0 ? [] : trailing.slice(pathSeparator + 1);
    for (const flag of flags)
      if (!READ_OPTIONS.has(flag) && !/^(-\d+|--max-count=\d+)$/.test(flag))
        throw new Error(`Unsupported display option: ${flag}`);
    const base = revision(
      source.path,
      String(values.base ?? context.defaultBase),
    );
    const range =
      command === "diff"
        ? git(source.path, "merge-base", base, "HEAD")
        : `${base}..HEAD`;
    process.stdout.write(
      gitRaw(
        source.path,
        "--no-pager",
        command,
        "--no-ext-diff",
        "--no-textconv",
        ...(command === "log" ? ["--oneline"] : []),
        ...flags,
        range,
        "--",
        ...paths,
      ),
    );
    return 0;
  }
  if (trailing.length)
    throw new Error("Extra arguments are only supported by diff and log");
  return locked(
    path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
    GIT_WORKFLOW_LOCK,
    async () => {
      if (command === "step") {
        arity(rest, 1);
        const [action] = rest;
        if (!["commit", "rebase", "squash"].includes(action))
          throw new Error("Usage: rl step commit|rebase|squash");
        if (
          values.cleanup ||
          values.squash ||
          (values.all && action !== "commit")
        )
          throw new Error("Invalid step options");
        assertReady(source.path, action !== "commit", source.branch);
        if (action === "commit") {
          if (values.base) throw new Error("commit does not accept --base");
          const commitMessage = required(values, "message");
          if (values["dry-run"]) {
            const changes = git(
              source.path,
              "diff",
              "--name-only",
              ...(values.all ? ["HEAD"] : ["--cached"]),
            );
            if (!changes) throw new Error("No changes to commit");
            console.log(
              `Would commit ${values.all ? "tracked" : "staged"} changes in ${source.branch}: ${commitMessage}\n${changes}`,
            );
            return 0;
          }
          console.log(
            git(
              source.path,
              "commit",
              ...(values.all ? ["--all"] : []),
              "-m",
              required(values, "message"),
            ),
          );
          return 0;
        }
        if (action === "rebase" && values.message)
          throw new Error("rebase does not accept --message");
        const base = revision(
          source.path,
          String(values.base ?? context.defaultBase),
        );
        if (action === "rebase") {
          if (values["dry-run"]) {
            console.log(`Would rebase ${source.branch} onto ${base}`);
            return 0;
          }
          const result = await execute(
            ["git", "-C", source.path, "rebase", base],
            source.path,
          );
          process.stdout.write(result.stdout);
          if (result.code)
            throw new Error(
              `${result.stderr.trim()}\nRebase did not complete. Resolve conflicts and run git rebase --continue, or git rebase --abort in ${source.path}`,
            );
          return 0;
        }
        const message = required(values, "message");
        const head = revision(source.path, "HEAD");
        const baseCommit = git(source.path, "merge-base", base, head);
        if (baseCommit === head)
          throw new Error("No feature commits to squash");
        if (values["dry-run"]) {
          console.log(
            `Would squash commits after ${baseCommit} in ${source.branch}: ${message}`,
          );
          return 0;
        }
        const tree = git(source.path, "rev-parse", `${head}^{tree}`);
        const backup = BACKUP_PREFIX + randomUUID();
        const squashed = git(
          source.path,
          "commit-tree",
          tree,
          "-p",
          baseCommit,
          "-m",
          message,
        );
        git(source.path, "update-ref", backup, head);
        // CAS leaves concurrent branch changes untouched; the worktree and index never change.
        git(
          source.path,
          "update-ref",
          "-m",
          "rl step squash",
          `refs/heads/${source.branch}`,
          squashed,
          head,
        );
        console.log(
          `Squashed feature commits. Original HEAD retained at ${backup}`,
        );
        return 0;
      }
      if (command !== "merge") throw new Error("Unknown Git workflow command");
      arity(rest, 0, 1);
      if (values.all || values.base || (values.message && !values.squash))
        throw new Error("Invalid merge options");
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
