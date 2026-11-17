import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { isIgnoredWatchDirectory } from "./core/protected-paths.js";
import type { LiveState } from "./review-live-engine.js";

const SUPPORTS_RECURSIVE_WATCH =
  process.platform === "darwin" || process.platform === "win32";

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

function splitWatchPath(filename: string): string[] {
  return filename.split(/[/\\]/).filter(Boolean);
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
    private recursive = SUPPORTS_RECURSIVE_WATCH,
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
    const generation = ++this.generation;
    if (this.recursive && this.reconcileRecursive(state)) {
      return;
    }
    void this.reconcile(state, generation).catch(() => this.schedule());
  }

  private reconcileRecursive(state: LiveState): boolean {
    const desired = new Map<
      string,
      {
        dir: string;
        recursive: boolean;
        ignore: (filename: string) => boolean;
      }
    >();
    const worktreeRoot = state.directories[0];
    if (worktreeRoot) {
      desired.set(`tree:${worktreeRoot}`, {
        dir: worktreeRoot,
        recursive: true,
        ignore: (filename) =>
          Boolean(filename) &&
          splitWatchPath(filename).some((part) =>
            isIgnoredWatchDirectory(part),
          ),
      });
    }

    for (const base of new Set([state.gitDir, state.commonDir])) {
      if (!base) continue;
      desired.set(`git:${base}`, {
        dir: base,
        recursive: false,
        ignore: (filename) => {
          const first = splitWatchPath(filename)[0];
          return Boolean(
            first &&
            (first.endsWith(".lock") ||
              /^(objects|rl|live-review)$/.test(first)),
          );
        },
      });
      const refsDir = path.join(base, "refs");
      if (fs.existsSync(refsDir)) {
        desired.set(`refs:${refsDir}`, {
          dir: refsDir,
          recursive: true,
          ignore: (filename) => {
            const parts = splitWatchPath(filename);
            return Boolean(
              parts[0] === "rl" || parts[parts.length - 1]?.endsWith(".lock"),
            );
          },
        });
      }
    }

    for (const [key, spec] of desired) {
      if (this.watches.has(key)) continue;
      try {
        const watch = fs.watch(
          spec.dir,
          { persistent: false, recursive: spec.recursive },
          (_event, name) => {
            const filename = name ? name.toString() : "";
            if (spec.ignore(filename)) {
              return;
            }
            this.schedule();
          },
        );
        watch.on("error", () => {
          watch.close();
          if (this.watches.get(key) === watch) {
            this.watches.delete(key);
          }
          this.schedule();
        });
        this.watches.set(key, watch);
      } catch {
        if (spec.recursive) {
          this.recursive = false;
          for (const watch of this.watches.values()) {
            watch.close();
          }
          this.watches.clear();
          return false;
        }
      }
    }

    for (const [key, watch] of this.watches) {
      if (!desired.has(key)) {
        watch.close();
        this.watches.delete(key);
      }
    }
    return true;
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
