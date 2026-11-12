import {
  LiveRepository,
  saveCheckpoint,
  type Mode,
  type LiveState,
  type ReviewFile,
  type Checkpoint,
} from "./review-live-engine.js";
import { message } from "./common.js";
const [root, workspaceRepo, temporaryRoot, freezeId] = process.argv.slice(2);
let repository: LiveRepository | undefined;
process.on(
  "message",
  (request: {
    id: number;
    op: string;
    force?: boolean;
    mode?: Mode;
    state?: LiveState;
    file?: ReviewFile;
    directory?: string;
    key?: string;
    point?: Checkpoint;
    head?: string;
    base?: string;
    target?: string;
    revisions?: string[];
  }) => {
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
        result = repository.patch(request.file!);
      else if (request.op === "mark") {
        saveCheckpoint(
          repository.root,
          request.directory!,
          request.key!,
          request.point!,
        );
        result = true;
      } else throw new Error("Unknown review worker operation");
      if (process.connected) process.send!({ id: request.id, result });
    } catch (error) {
      if (process.connected)
        process.send!({ id: request.id, error: message(error) });
    }
  },
);
