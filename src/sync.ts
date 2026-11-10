import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  args,
  canonical,
  execute,
  git,
  gitRaw,
  inside,
  json,
  locked,
  message,
} from "./common.js";
import { commandContext, contextOptions } from "./command-context.js";
import {
  assertReady,
  GIT_WORKFLOW_DIRECTORY,
  GIT_WORKFLOW_LOCK,
} from "./git-safety.js";
import { worktrees } from "./repos.js";
import type { Instance } from "./store.js";

type Status =
  "updated" | "up-to-date" | "would-update" | "conflict" | "skipped" | "failed";
interface Base {
  ref: string;
  oid: string;
}
interface Target {
  instance: Instance;
  name: string;
  requestedBase: string;
  base?: Base;
}
interface Result {
  branch: string;
  workspace: string;
  base: string;
  status: Status;
  detail: string;
  headBefore?: string;
  headAfter?: string;
  baseCommit?: string;
  behindCommits?: number;
  conflicts?: string[];
}

function revision(root: string, ref: string): string | undefined {
  try {
    return git(
      root,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    );
  } catch {
    return undefined;
  }
}

function resolveBase(
  repo: string,
  requested: string,
  remotes: string[],
): Base | undefined {
  // Explicit remote bases must not silently fall back to a stale local branch
  // after fetch prunes a deleted remote ref. Unqualified names prefer origin.
  const refs = requested.startsWith("refs/")
    ? [requested]
    : requested.startsWith("origin/") ||
        remotes.some((remote) => requested.startsWith(remote + "/"))
      ? [`refs/remotes/${requested}`]
      : [
          ...(remotes.includes("origin")
            ? [`refs/remotes/origin/${requested}`]
            : []),
          `refs/heads/${requested}`,
          requested,
        ];
  for (const ref of refs) {
    if (
      ref.startsWith("refs/remotes/") &&
      !remotes.some((remote) => ref.startsWith(`refs/remotes/${remote}/`))
    )
      continue;
    const oid = revision(repo, ref);
    if (oid) {
      // Canonicalize shorthand refs too, so a removed remote cannot leave a
      // cached tracking branch masquerading as an unfetched local base.
      const fullRef =
        git(
          repo,
          "rev-parse",
          "--symbolic-full-name",
          "--verify",
          "--end-of-options",
          ref,
        ) || ref;
      if (
        fullRef.startsWith("refs/remotes/") &&
        !remotes.some((remote) => fullRef.startsWith(`refs/remotes/${remote}/`))
      )
        continue;
      return { ref: fullRef, oid };
    }
  }
  return undefined;
}

const displayRef = (ref: string) =>
  ref.replace(/^refs\/(?:heads|remotes)\//, "");
const visible = (value: string) =>
  stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, contextOptions, [
    "dry-run",
    "json",
  ]);
  const context = commandContext(values);
  const targets: Target[] = context.store
    .records()
    .map(([, instance]) => instance)
    .filter(
      (instance) =>
        instance.status === "active" && instance.worktree !== context.repo,
    )
    .map((instance) => ({
      instance,
      name: inside(instance.worktree, context.managedDir)
        ? path.relative(context.managedDir, instance.worktree)
        : path.basename(instance.worktree),
      requestedBase:
        typeof instance.baseBranch === "string" && instance.baseBranch
          ? instance.baseBranch
          : context.defaultBase,
    }))
    .sort((a, b) => a.instance.branch.localeCompare(b.instance.branch));
  const selected = positionals.length
    ? [
        ...new Set(
          positionals.map((name) => {
            const matches = targets.filter(
              (target) =>
                target.name === name ||
                target.instance.branch === name ||
                (path.isAbsolute(name) &&
                  target.instance.worktree === canonical(name)),
            );
            if (matches.length !== 1)
              throw new Error(
                matches.length
                  ? `Ambiguous RL workspace: ${name}; use its branch or absolute path`
                  : `Active RL workspace not found: ${name}. Use rl list.`,
              );
            return matches[0];
          }),
        ),
      ]
    : targets;
  const dryRun = !!values["dry-run"];
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
        const results: Result[] = [];
        const fetches: {
          remote: string;
          status: "fetched" | "failed";
          detail?: string;
        }[] = [];
        const remotes = git(context.repo, "remote").split("\n").filter(Boolean);
        const report = () => {
          const summary = Object.fromEntries(
            (
              [
                "updated",
                "up-to-date",
                "would-update",
                "conflict",
                "skipped",
                "failed",
              ] as Status[]
            ).map((status) => [
              status,
              results.filter((result) => result.status === status).length,
            ]),
          );
          if (values.json)
            json({
              repository: context.repo,
              dryRun,
              fetches,
              results,
              summary,
            });
          else {
            if (!selected.length)
              console.log(
                "No active RL workspaces to sync in this repository.",
              );
            else {
              console.log(
                `\n${dryRun ? "Sync preview" : "Sync results"} · ${visible(context.repo)}\n`,
              );
              for (const row of results) {
                console.log(
                  `  ${visible(row.branch)} ← ${visible(row.base)}  [${row.status}]`,
                );
                console.log(`    ${visible(row.detail)}`);
                if (row.conflicts?.length)
                  console.log(
                    `    Conflicts: ${row.conflicts.map(visible).join(", ")}`,
                  );
              }
              console.log(
                "\n" +
                  Object.entries(summary)
                    .filter(([, count]) => count)
                    .map(([status, count]) => `${count} ${status}`)
                    .join(" · "),
              );
            }
          }
          return results.some((result) =>
            ["conflict", "failed", "skipped"].includes(result.status),
          )
            ? 1
            : 0;
        };
        if (!selected.length) return report();
        // Fetch every configured remote once, before merging anything. A failed
        // fetch stops the batch instead of presenting cached bases as current.
        for (const remote of remotes) {
          if (interrupted) {
            fetches.push({
              remote,
              status: "failed",
              detail: "Sync interrupted",
            });
            break;
          }
          if (!values.json) console.error(`Fetching ${visible(remote)}…`);
          const fetched = await execute(
            ["git", "fetch", "--prune", "--", remote],
            context.repo,
          );
          fetches.push({
            remote,
            status: fetched.code ? "failed" : "fetched",
            ...(fetched.code
              ? { detail: fetched.stderr.trim() || "Fetch failed" }
              : {}),
          });
        }
        if (fetches.some((fetch) => fetch.status === "failed")) {
          for (const target of selected)
            results.push({
              branch: target.instance.branch,
              workspace: target.instance.worktree,
              base: target.requestedBase,
              status: "failed",
              detail: `Fetch failed; no branches were merged. ${fetches
                .filter((fetch) => fetch.status === "failed")
                .map((fetch) => `${fetch.remote}: ${fetch.detail}`)
                .join("; ")}`,
            });
          return report();
        }
        for (const target of selected)
          target.base = resolveBase(
            context.repo,
            target.requestedBase,
            remotes,
          );
        const pending = [...selected];
        while (pending.length) {
          if (interrupted) {
            for (const target of pending)
              results.push({
                branch: target.instance.branch,
                workspace: target.instance.worktree,
                base: target.requestedBase,
                status: "skipped",
                detail: "Sync interrupted; workspace left unchanged",
              });
            break;
          }
          // Local stacked branches follow their base workspace. Remote bases use
          // the fetched snapshot and are independent of local feature updates.
          const index = pending.findIndex(
            (target) =>
              !target.base?.ref.startsWith("refs/heads/") ||
              !pending.some(
                (other) =>
                  other !== target &&
                  target.base!.ref === `refs/heads/${other.instance.branch}`,
              ),
          );
          if (index < 0) {
            for (const target of pending)
              results.push({
                branch: target.instance.branch,
                workspace: target.instance.worktree,
                base: target.requestedBase,
                status: "skipped",
                detail:
                  "Cyclic local base dependencies; choose a base outside the cycle",
              });
            break;
          }
          const [target] = pending.splice(index, 1);
          const { instance } = target;
          const row: Result = {
            branch: instance.branch,
            workspace: instance.worktree,
            base: displayRef(target.base?.ref ?? target.requestedBase),
            status: "skipped",
            detail: "",
          };
          results.push(row);
          try {
            const [, current] = context.store.current(instance.worktree);
            if (
              current.key !== instance.key ||
              current.worktree !== instance.worktree
            )
              throw new Error("RL workspace changed during sync; retry");
            const checkout = worktrees(context.repo).find(
              (entry) => canonical(entry.worktree) === instance.worktree,
            );
            if (
              !checkout ||
              checkout.branch !== `refs/heads/${instance.branch}`
            )
              throw new Error("Workspace branch changed; retry");
            if ("locked" in checkout) throw new Error("Worktree is locked");
            assertReady(instance.worktree, true, instance.branch);
            if (!target.base) {
              row.status = "failed";
              throw new Error(`Base does not exist: ${target.requestedBase}`);
            }
            const parent = target.base.ref.startsWith("refs/heads/")
              ? results.find(
                  (other) =>
                    other !== row &&
                    `refs/heads/${other.branch}` === target.base!.ref,
                )
              : undefined;
            if (
              parent &&
              !["updated", "up-to-date", "would-update"].includes(parent.status)
            )
              throw new Error(`Base workspace ${parent.branch} was not synced`);
            const base = target.base.ref.startsWith("refs/heads/")
              ? {
                  ...target.base,
                  oid: revision(context.repo, target.base.ref)!,
                }
              : target.base;
            if (!base.oid) {
              row.status = "failed";
              throw new Error("Base changed during sync; retry");
            }
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
              !row.behindCommits &&
              !(dryRun && parent?.status === "would-update")
            ) {
              row.status = "up-to-date";
              row.headAfter = row.headBefore;
              row.detail = "Already contains its base";
              continue;
            }
            if (dryRun) {
              row.status = "would-update";
              row.detail =
                parent?.status === "would-update"
                  ? "Would merge its updated local base; conflicts checked during sync"
                  : `Would merge ${row.behindCommits} base commit(s); conflicts checked during sync`;
              continue;
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
            interrupted ||= merged.code === 130 || merged.code === 143;
            row.headAfter = git(instance.worktree, "rev-parse", "HEAD");
            if (merged.code) {
              const conflicts = gitRaw(
                instance.worktree,
                "diff",
                "--name-only",
                "--diff-filter=U",
                "-z",
              )
                .split("\0")
                .filter(Boolean);
              if (conflicts.length) row.conflicts = conflicts;
              const mergeHead = revision(instance.worktree, "MERGE_HEAD");
              if (mergeHead) {
                if (mergeHead !== base.oid || row.headAfter !== row.headBefore)
                  throw new Error(
                    "Merge state changed externally; inspect this workspace before continuing",
                  );
                const aborted = await execute(
                  ["git", "merge", "--abort"],
                  instance.worktree,
                );
                if (aborted.code)
                  throw new Error(
                    `Could not abort the merge: ${aborted.stderr.trim()}. Inspect ${instance.worktree}`,
                  );
                assertReady(instance.worktree, true, instance.branch);
                if (
                  git(instance.worktree, "rev-parse", "HEAD") !== row.headBefore
                )
                  throw new Error(
                    "Branch changed while aborting the merge; inspect the workspace",
                  );
              }
              if (conflicts.length && !mergeHead)
                throw new Error(
                  "Conflicts remain without the expected merge state; inspect the workspace",
                );
              row.status = conflicts.length ? "conflict" : "failed";
              row.detail = interrupted
                ? `Sync interrupted${mergeHead ? "; merge was aborted" : ""}`
                : conflicts.length
                  ? "Merge conflicted and was aborted; branch left unchanged"
                  : `Merge failed${mergeHead ? " and was aborted" : ""}: ${merged.stderr.trim() || merged.stdout.trim()}`;
              continue;
            }
            assertReady(instance.worktree, true, instance.branch);
            const contains = await execute(
              ["git", "merge-base", "--is-ancestor", base.oid, "HEAD"],
              instance.worktree,
            );
            if (contains.code)
              throw new Error(
                "Merge finished but the branch no longer contains the selected base; inspect the workspace",
              );
            row.status = "updated";
            row.detail = `Merged ${row.behindCommits} base commit(s)`;
          } catch (error) {
            row.detail = message(error);
          }
        }
        return report();
      },
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
