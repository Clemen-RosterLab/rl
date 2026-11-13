import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { isIgnoredWatchDirectory } from "./core/protected-paths.js";
import type { LiveState } from "./review-live-engine.js";

function hasIgnoredSegment(
  worktreeRoot: string | undefined,
  dir: string,
): boolean {
  if (!worktreeRoot || dir === worktreeRoot) {
    return false;
  }
  const rel = path.relative(worktreeRoot, dir);
  if (!rel || rel.startsWith("..")) {
    return false;
  }
  return rel.split(path.sep).some((part) => isIgnoredWatchDirectory(part));
}

/** Reconcile bounded batches so a large checkout cannot monopolize keyboard input. */
export class ReviewWatcher {
  private watches = new Map<string, fs.FSWatcher>();
  private timer?: ReturnType<typeof setTimeout>;
  private polling: ReturnType<typeof setInterval>;
  private stopped = false;
  private generation = 0;

  constructor(
    private refresh: () => void,
    pollMs = 2500,
  ) {
    this.polling = setInterval(() => this.schedule(), pollMs);
  }

  schedule(): void {
    if (this.stopped || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, 180);
  }

  update(state: LiveState): void {
    if (this.stopped) {
      return;
    }
    void this.reconcile(state, ++this.generation).catch(() => this.schedule());
  }

  private async reconcile(state: LiveState, generation: number): Promise<void> {
    const active = () => !this.stopped && generation === this.generation;
    const worktreeRoot = state.directories[0];
    const dirs = new Set(
      state.directories.filter((dir) => !hasIgnoredSegment(worktreeRoot, dir)),
    );

    const pending: string[] = [];
    for (const base of new Set([state.gitDir, state.commonDir])) {
      dirs.add(base);
      pending.push(path.join(base, "refs"));
    }

    while (pending.length > 0 && active()) {
      const dir = pending.pop()!;
      dirs.add(dir);
      try {
        const children = await fs.promises.readdir(dir, {
          withFileTypes: true,
        });
        for (const child of children) {
          if (
            child.isDirectory() &&
            !child.isSymbolicLink() &&
            child.name !== "rl"
          ) {
            pending.push(path.join(dir, child.name));
          }
        }
      } catch {
        // Polling covers absent ref directories.
      }
    }

    let count = 0;
    for (const dir of dirs) {
      if (!active()) return;
      if (++count % 32 === 0) {
        await yieldTurn();
      }
      if (!active()) return;
      if (this.watches.has(dir)) continue;

      try {
        const watch = fs.watch(dir, { persistent: false }, (_event, name) => {
          const filename = name ? name.toString() : "";
          if (
            dir === state.commonDir &&
            filename &&
            /^(objects|rl|live-review)$/.test(filename)
          ) {
            return;
          }
          if (filename && isIgnoredWatchDirectory(filename)) {
            return;
          }
          if (dir.includes(`${path.sep}refs${path.sep}rl`)) {
            return;
          }
          this.schedule();
        });
        watch.on("error", () => {
          watch.close();
          if (this.watches.get(dir) === watch) {
            this.watches.delete(dir);
          }
          this.schedule();
        });
        this.watches.set(dir, watch);
      } catch {
        // Exhausted watcher limits use polling.
      }
    }

    if (!active()) return;
    for (const [dir, watch] of this.watches) {
      if (!dirs.has(dir)) {
        watch.close();
        this.watches.delete(dir);
      }
    }
  }

  close(): void {
    this.stopped = true;
    this.generation++;
    clearInterval(this.polling);
    clearTimeout(this.timer);
    for (const watch of this.watches.values()) {
      watch.close();
    }
    this.watches.clear();
  }
}
