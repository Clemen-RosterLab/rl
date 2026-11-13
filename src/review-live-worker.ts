import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  LiveRepository,
  type Mode,
  type LiveState,
  type ReviewFile,
  type Checkpoint,
} from "./review-live-engine.js";
import { message } from "./common.js";
import { reviewGit } from "./review-git.js";
import {
  saveUnifiedCheckpoint,
  loadUnifiedCheckpoint,
} from "./review-history.js";
import {
  loadReviewProgress,
  toggleFileReviewed,
  recordFileViewed,
} from "./review-progress.js";
import { searchReviewFiles } from "./review-search.js";
import { rankReviewFiles } from "./review-ranking.js";
import type { ViewedFile } from "./review-progress.js";
import { changedFiles } from "./review-git.js";
const [root, workspaceRepo = root, temporaryRoot, freezeId] =
  process.argv.slice(2);
let repository: LiveRepository | undefined;
let active = 0,
  disconnected = false;
function cleanup(): void {
  try {
    repository?.releaseFreeze();
  } catch {
    /* A removed worktree may no longer have refs. */
  }
  if (
    temporaryRoot &&
    path.basename(temporaryRoot).startsWith("rl-review-live-")
  )
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch {
      /* Cleanup must not retain the worker. */
    }
  process.removeAllListeners("message");
}
process.once("disconnect", () => {
  disconnected = true;
  if (!active) cleanup();
});
interface Request {
  id: number;
  op: string;
  force?: boolean;
  mode?: Mode;
  state?: LiveState;
  file?: ReviewFile;
  files?: ReviewFile[];
  directory?: string;
  key?: string;
  point?: Checkpoint;
  head?: string;
  base?: string;
  target?: string;
  revisions?: string[];
  context?: number;
  side?: "before" | "after";
  query?: string;
  scope?: "changes" | "files";
  branch?: string;
  pr?: number;
  viewed?: ViewedFile;
}
process.on("message", async (request: Request) => {
  active++;
  try {
    repository ??= new LiveRepository(root, workspaceRepo, {
      temporaryRoot,
      freezeId,
    });
    if (request.op !== "refresh") repository.assertIdentity();
    let result: unknown;
    if (request.op === "refresh") result = repository.refresh(request.force);
    else if (request.op === "history")
      result = repository.history(request.head!, request.base);
    else if (request.op === "identity") result = true;
    else if (request.op === "freeze") {
      repository.freeze(
        request.state!.snapshot,
        request.target!,
        request.revisions,
      );
      result = true;
    } else if (request.op === "release") {
      repository.releaseFreeze();
      result = true;
    } else if (request.op === "compare") {
      const comparison = repository.comparison(request.mode!, request.state!);
      result = {
        comparison,
        files: repository.files(comparison, request.state!),
      };
    } else if (request.op === "patch")
      result = repository.patch(request.file!, request.context);
    else if (request.op === "content")
      result = repository.content(request.file!, request.side);
    else if (request.op === "editor")
      result = repository.editorFile(
        request.file!,
        request.directory!,
        request.side,
      );
    else if (request.op === "references") result = repository.references();
    else if (request.op === "rank")
      result = await rankReviewFiles(repository, request.files!);
    else if (request.op === "rank-evidence")
      result = request.files!.slice(0, 60).map((file) => ({
        id: file.key,
        path: file.path,
        layer: file.layer,
        patch: repository!.patch(file).slice(0, 4000),
      }));
    else if (request.op === "delta") {
      const file = request.file!,
        viewed = request.viewed!;
      const changed = changedFiles(root, viewed.tree, file.to).find(
        (candidate) =>
          candidate.path === file.path || candidate.oldPath === viewed.path,
      );
      result = changed
        ? repository.patch(
            {
              ...changed,
              layer: "since viewed",
              from: viewed.tree,
              to: file.to,
              key: file.key,
            },
            request.context,
          )
        : "No changes since you last viewed this file.\n";
    } else if (request.op === "search")
      result = searchReviewFiles(
        repository,
        request.files!,
        request.query!,
        request.scope!,
        request.context,
      );
    else if (request.op === "progress")
      result = loadReviewProgress(request.directory!, request.key!);
    else if (request.op === "review-file")
      result = toggleFileReviewed(
        request.directory!,
        request.key!,
        request.file!,
      );
    else if (request.op === "viewed") {
      const previous = loadReviewProgress(request.directory!, request.key!);
      result = recordFileViewed(
        request.directory!,
        request.key!,
        request.file!,
      );
      const progress = result as ReturnType<typeof recordFileViewed>;
      const refFor = (key: string) =>
        `refs/rl/live-viewed/${request.key}/${createHash("sha256").update(key).digest("hex")}`;
      const commands = [
        `update ${refFor(request.file!.key)} ${request.file!.to}`,
        ...Object.keys(previous.viewed)
          .filter((key) => !progress.viewed[key])
          .map((key) => `delete ${refFor(key)}`),
      ];
      reviewGit(
        root,
        ["-c", "core.hooksPath=/dev/null", "update-ref", "--stdin"],
        commands.join("\n") + "\n",
      );
    } else if (request.op === "checkpoint")
      result = loadUnifiedCheckpoint(
        root,
        workspaceRepo,
        request.directory!,
        request.key!,
        request.branch!,
        request.pr,
      );
    else if (request.op === "mark") {
      await saveUnifiedCheckpoint(
        root,
        workspaceRepo,
        request.directory!,
        request.key!,
        request.point!,
        request.state!.snapshot,
        request.pr,
      );
      result = true;
    } else throw new Error("Unknown review worker operation");
    if (process.connected) process.send!({ id: request.id, result });
  } catch (error) {
    if (process.connected)
      process.send!({ id: request.id, error: message(error) });
  } finally {
    active--;
    if (disconnected && !active) cleanup();
  }
});
if (process.connected) process.send!({ ready: true });
