import { parentPort, workerData } from "node:worker_threads";
import {
  LiveRepository,
  saveCheckpoint,
  type Mode,
  type LiveState,
  type ReviewFile,
  type Checkpoint,
} from "./review-live-engine.js";
import { message } from "./common.js";
const repository = new LiveRepository(workerData.root, workerData.repository);
parentPort!.on(
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
      parentPort!.postMessage({ id: request.id, result });
    } catch (error) {
      parentPort!.postMessage({ id: request.id, error: message(error) });
    }
  },
);
