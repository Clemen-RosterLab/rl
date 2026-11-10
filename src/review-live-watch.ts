import fs from "node:fs";
import path from "node:path";
import type { LiveState } from "./review-live-engine.js";

/** Watch only Git-listed source directories, never recursively enter dependencies. */
export class ReviewWatcher {
  private watches = new Map<string, fs.FSWatcher>();
  private timer?: ReturnType<typeof setTimeout>;
  private polling: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    private refresh: () => void,
    pollMs = 2500,
  ) {
    this.polling = setInterval(() => this.schedule(), pollMs);
  }
  schedule(): void {
    if (this.stopped || this.timer) return;
    // Leading bounded debounce also makes progress during continuous writes.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, 180);
  }
  update(state: LiveState): void {
    const dirs = new Set(state.directories);
    for (const base of new Set([state.gitDir, state.commonDir])) {
      dirs.add(base);
      const refs = path.join(base, "refs");
      const walk = (dir: string) => {
        dirs.add(dir);
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true }))
            if (
              e.isDirectory() &&
              !e.isSymbolicLink() &&
              !(dir === refs && e.name === "rl")
            )
              walk(path.join(dir, e.name));
        } catch {
          /* Polling remains active. */
        }
      };
      walk(refs);
    }
    for (const [dir, watch] of this.watches)
      if (!dirs.has(dir)) {
        watch.close();
        this.watches.delete(dir);
      }
    for (const dir of dirs) {
      if (this.watches.has(dir)) continue;
      try {
        const watch = fs.watch(dir, (_event, name) => {
          // Snapshot object writes must not cause self-triggered refresh loops.
          if (
            dir === state.commonDir &&
            name &&
            /^(objects|rl|live-review)$/.test(name.toString())
          )
            return;
          if (dir.includes(`${path.sep}refs${path.sep}rl`)) return;
          this.schedule();
        });
        watch.on("error", () => {
          watch.close();
          this.watches.delete(dir);
          this.schedule();
        });
        this.watches.set(dir, watch);
      } catch {
        /* Missing directories and exhausted watcher limits use polling. */
      }
    }
  }
  close(): void {
    this.stopped = true;
    clearInterval(this.polling);
    clearTimeout(this.timer);
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
  }
}
