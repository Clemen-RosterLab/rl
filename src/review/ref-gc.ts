import fs from "node:fs";
import path from "node:path";
import { reviewGit } from "../review-git.js";
import type { ReviewState } from "../review-store.js";

export function isSnapshotReferenced(
  state: ReviewState,
  snapshotId: string,
): boolean {
  if (state.viewing === snapshotId) return true;
  if (state.approval?.snapshot === snapshotId) return true;
  if (state.checkpoints.some((item) => item.snapshot === snapshotId))
    return true;
  if (state.feedback.some((item) => item.snapshot === snapshotId)) return true;
  if (state.analyses.some((item) => item.snapshot === snapshotId)) return true;
  return false;
}

/**
 * Remove a superseded transient `viewing` snapshot and its private Git refs
 * once no checkpoint, approval, feedback, or AI analysis references it.
 */
export function pruneOrphanedSnapshot(
  reviewsDirectory: string,
  worktree: string,
  instanceKey: string,
  state: ReviewState,
  candidateId: string | undefined,
): void {
  if (!candidateId || isSnapshotReferenced(state, candidateId)) {
    return;
  }

  const snapshotFile = path.join(
    reviewsDirectory,
    "snapshots",
    `${candidateId}.json`,
  );
  try {
    fs.rmSync(snapshotFile, { force: true });
  } catch {
    // Best-effort metadata cleanup.
  }

  const refs = [
    `refs/rl/reviews/${instanceKey}/${candidateId}`,
    `refs/rl/review-heads/${instanceKey}/${candidateId}`,
    `refs/rl/review-snapshot-bases/${instanceKey}/${candidateId}`,
  ];
  try {
    reviewGit(
      worktree,
      ["update-ref", "--stdin"],
      refs.map((ref) => `delete ${ref}\n`).join(""),
    );
  } catch {
    // Missing worktree or ref does not invalidate the new viewing snapshot.
  }
}
