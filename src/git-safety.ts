import fs from "node:fs";
import { git } from "./common.js";

export const GIT_WORKFLOW_DIRECTORY = ".git-workflow";
export const GIT_WORKFLOW_LOCK = ".lock";
const OPERATION_FILES = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
];

/** Shared mutation guard; untracked content counts as dirty. */
export function assertReady(
  root: string,
  clean: boolean,
  expectedBranch: string,
): void {
  if (git(root, "branch", "--show-current") !== expectedBranch)
    throw new Error("Workspace branch changed; retry from the intended branch");
  for (const marker of OPERATION_FILES)
    if (
      fs.existsSync(
        git(root, "rev-parse", "--path-format=absolute", "--git-path", marker),
      )
    )
      throw new Error(
        `An operation is already in progress in ${root}; finish or abort it first`,
      );
  if (git(root, "ls-files", "--unmerged"))
    throw new Error(`Unresolved conflicts in ${root}`);
  if (clean && git(root, "status", "--porcelain", "--untracked-files=normal"))
    throw new Error(
      `Workspace is dirty: ${root}. Commit or stash changes explicitly first`,
    );
}
