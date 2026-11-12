import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** Keep in-flight terminal reports out of the shell during the mouse-off handoff. */
export function drainReviewInput(
  input: NodeJS.ReadStream,
): () => Promise<void> {
  let lastInput = performance.now();
  const consume = () => {
    lastInput = performance.now();
  };
  input.on("data", consume);
  input.resume();
  return async () => {
    try {
      await new Promise<void>((resolve) => {
        const deadline = performance.now() + 150;
        const settle = () => {
          const now = performance.now();
          const remaining = Math.min(50 - (now - lastInput), deadline - now);
          if (remaining <= 0) resolve();
          else setTimeout(settle, Math.ceil(remaining));
        };
        settle();
      });
    } finally {
      input.off("data", consume);
    }
  };
}
export interface ReviewMouse {
  x: number;
  y: number;
  button: number;
  release: boolean;
}
/** Remove mouse packets before readline can interpret their digits as shortcuts. */
export class ReviewInput {
  readonly keys = new PassThrough();
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private mouse: (event: ReviewMouse) => void) {}
  feed(data: Buffer): void {
    clearTimeout(this.timer);
    this.pending += this.decoder.write(data);
    this.drain();
  }
  private drain(): void {
    while (this.pending) {
      if (this.pending.startsWith("\x1b[<")) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.pending);
        if (match) {
          this.pending = this.pending.slice(match[0].length);
          this.mouse({
            button: Number(match[1]),
            x: Number(match[2]) - 1,
            y: Number(match[3]) - 1,
            release: match[4] === "m",
          });
          continue;
        }
        if (/^\x1b\[<[\d;]*$/.test(this.pending) && this.pending.length < 64) {
          this.timer = setTimeout(() => {
            this.pending = "";
          }, 100);
          return;
        }
        // Discard malformed mouse traffic, including its shortcut-shaped tail.
        const end = this.pending.slice(3).search(/[Mm]/);
        this.pending = end < 0 ? "" : this.pending.slice(end + 4);
        continue;
      }
      if (this.pending === "\x1b" || this.pending === "\x1b[") {
        this.timer = setTimeout(() => {
          const value = this.pending;
          this.pending = "";
          this.keys.write(value);
        }, 25);
        return;
      }
      const next = this.pending.indexOf("\x1b", 1),
        length = next < 0 ? this.pending.length : next;
      this.keys.write(this.pending.slice(0, length));
      this.pending = this.pending.slice(length);
    }
  }
  close(): void {
    clearTimeout(this.timer);
    this.pending = "";
    this.keys.destroy();
  }
}

/** Discard excess wheel packets instead of queuing a fling after scrolling stops. */
export class ReviewWheel {
  private last = new Map<string, { direction: number; at: number }>();
  accept(target: string, direction: number, now = performance.now()): boolean {
    const previous = this.last.get(target);
    if (previous?.direction === direction && now - previous.at < 60)
      return false;
    this.last.set(target, { direction, at: now });
    if (this.last.size > 64) this.last.delete(this.last.keys().next().value!);
    return true;
  }
}
