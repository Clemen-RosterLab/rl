import fs from "node:fs";
import path from "node:path";
import { captureSnapshot, changedFiles, reviewGit } from "../review-git.js";
import { isExcludedUntrackedPath } from "../core/protected-paths.js";

import { reviewFileCategory } from "../review-live-files.js";

export function countsAsLogic(file: string): boolean {
  if (
    reviewFileCategory(file) !== undefined ||
    /(^|\/)(__tests__|tests?|specs?|fixtures|__fixtures__|testdata|docs)(\/|$)/i.test(
      file,
    ) ||
    /(?:[._-](?:test|tests|spec)|_test\.go)(?:\.|$)/i.test(file) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(file) ||
    /(?:Test|Tests|Spec)\.(?:cs|java|kt|scala|swift)$/.test(file)
  )
    return false;
  return !/\.(?:css|scss|sass|less|styl|jsonc?|jsonl|ya?ml|toml|lock|mdx?|rst|txt|csv|tsv|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|snap|map|html?|xml)$/i.test(
    file,
  );
}

export function workloadLines(cwd: string, base: string, tree: string) {
  return changedFiles(cwd, base, tree).reduce(
    (sum, file) => sum + (countsAsLogic(file.path) ? (file.additions ?? 0) : 0),
    0,
  );
}

export function draftWorkspace(root: string, directory: string) {
  const source = captureSnapshot(root);
  if (!source.stable || source.conflicts.length)
    throw new Error(
      "Resolve unstable or conflicted checkout before starting sniperflow",
    );
  const cwd = path.join(directory, "draft");
  reviewGit(root, [
    "clone",
    "--quiet",
    "--shared",
    "--no-checkout",
    "--",
    root,
    cwd,
  ]);
  const base = source.worktreeTree;
  reviewGit(cwd, ["read-tree", "--reset", "-u", base]);
  const tree = () => reviewGit(cwd, ["write-tree"]).trim();
  const patch = (from: string, to: string) =>
    reviewGit(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--full-index",
      "--no-renames",
      from,
      to,
      "--",
    ]);
  return {
    cwd,
    base,
    tree,
    applyWriter(diff: string, files: string[]) {
      if (!diff.trim()) return;
      const index = path.join(directory, "candidate-index");
      const before = tree();
      try {
        reviewGit(cwd, ["read-tree", before], undefined, index);
        reviewGit(
          cwd,
          ["apply", "--cached", "--whitespace=nowarn", "-"],
          diff,
          index,
        );
        const after = reviewGit(cwd, ["write-tree"], undefined, index).trim();
        const touched = reviewGit(cwd, [
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          before,
          after,
          "--",
        ])
          .split("\0")
          .filter(Boolean);
        for (const file of touched) {
          if (!files.includes(file) || isExcludedUntrackedPath(file))
            throw new Error(
              "Writer changed an unassigned or protected path: " + file,
            );
        }
        reviewGit(cwd, ["read-tree", "-u", "-m", before, after]);
      } finally {
        fs.rmSync(index, { force: true });
      }
    },
    deliver(checkDeadline = () => {}) {
      const current = captureSnapshot(root);
      if (
        !current.stable ||
        current.branch !== source.branch ||
        current.head !== source.head ||
        current.fingerprint !== source.fingerprint
      )
        throw new Error(
          "The source checkout changed during sniperflow. Accepted draft is available in " +
            cwd,
        );
      const diff = patch(base, tree());
      checkDeadline();
      if (diff) reviewGit(root, ["apply", "--whitespace=nowarn", "-"], diff);
    },
  };
}
