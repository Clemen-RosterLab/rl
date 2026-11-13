import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { ReviewStore } from "./review-store.js";
import { now, canonical } from "./common.js";
import { reviewGit, type Snapshot } from "./review-git.js";
import {
  checkpointFile,
  loadCheckpoint,
  saveCheckpoint,
  type Checkpoint,
} from "./review-live-engine.js";

function registeredReview(
  root: string,
  repository: string,
  directory: string,
  branch: string,
): ReviewStore | undefined {
  const store = new Store(repository, path.dirname(directory));
  if (canonical(store.root) !== canonical(directory))
    throw new Error("Review history belongs to another repository");
  const entry = store
    .records()
    .find(
      ([, item]) =>
        item.status === "active" &&
        item.worktree === root &&
        item.branch === branch,
    );
  return entry ? new ReviewStore(store, entry) : undefined;
}
export async function saveUnifiedCheckpoint(
  root: string,
  repository: string,
  directory: string,
  key: string,
  point: Checkpoint,
  source: Snapshot,
  pr?: number,
): Promise<void> {
  const tree = reviewGit(root, ["rev-parse", `${point.tree}^{tree}`]).trim();
  const index = reviewGit(root, ["rev-parse", `${point.index}^{tree}`]).trim();
  const review = registeredReview(root, repository, directory, point.branch);
  if (review) {
    let snapshot = source;
    if (
      tree !== source.worktreeTree ||
      index !== source.indexTree ||
      point.head !== source.head
    ) {
      const raw = reviewGit(root, ["ls-tree", "-r", "-z", index]);
      const entries = raw
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const tab = entry.indexOf("\t");
          const [mode, , oid] = entry.slice(0, tab).split(" ");
          return `${mode} ${oid} 0\t${entry.slice(tab + 1)}\0`;
        })
        .join("");
      const empty = reviewGit(root, ["mktree"], "").trim();
      const indexHash = createHash("sha256").update(entries).digest("hex");
      snapshot = {
        ...source,
        id: randomUUID(),
        at: now(),
        head: point.head,
        headTree: tree,
        indexTree: index,
        worktreeTree: tree,
        stages: [empty, empty, empty],
        indexHash,
        excluded: [],
        untracked: [],
        conflicts: [],
        complete: true,
        stable: true,
        fingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              indexHash,
              indexTree: index,
              worktreeTree: tree,
              excluded: [],
            }),
          )
          .digest("hex"),
      };
    }
    await review.recordLiveCheckpoint(
      snapshot,
      `${pr ? `PR #${pr} · ` : ""}${point.label}`,
      pr,
    );
  }
  saveCheckpoint(root, directory, key, point);
}
export function loadUnifiedCheckpoint(
  root: string,
  repository: string,
  directory: string,
  key: string,
  branch: string,
  pr?: number,
): Checkpoint {
  if (fs.existsSync(checkpointFile(directory, key)))
    return loadCheckpoint(directory, key);
  const review = registeredReview(root, repository, directory, branch);
  const item = review
    ?.load()
    .checkpoints.filter((point) => point.pr === pr)
    .at(-1);
  if (!review || !item) return loadCheckpoint(directory, key);
  const snapshot = review.snapshot(item.snapshot);
  const point = {
    branch: snapshot.branch,
    head: snapshot.head,
    tree: snapshot.worktreeTree,
    index: snapshot.indexTree,
    label: item.label,
  };
  saveCheckpoint(root, directory, key, point);
  return point;
}
