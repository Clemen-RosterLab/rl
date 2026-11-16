import { spawn, type ChildProcess } from "node:child_process";
import { canonical, gitEnv } from "./common.js";
import { diffArgs, OID } from "./review-git.js";
import type { ReviewFile } from "./review-live-engine.js";
import type { ViewedFile } from "./review-progress.js";

export interface PreviewRequest {
  gitDir: string;
  context: number;
  fullFile?: boolean;
  side?: "before" | "after";
  viewed?: ViewedFile;
}
const LIMIT = 8 * 1024 * 1024;
const aborted = () => new Error("Preview superseded by a newer selection");

/** One cancellable, read-only Git operation, independent of snapshot/save work. */
export class ReviewPreview {
  private gitDir?: string;
  private current?: AbortController;
  private child?: ChildProcess;
  private closed = false;

  constructor(private readonly root: string) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  cancel(): void {
    this.current?.abort();
    this.current = undefined;
  }

  close(): void {
    this.closed = true;
    this.cancel();
  }

  async read(file: ReviewFile, request: PreviewRequest): Promise<string> {
    this.cancel();
    if (this.closed) throw new Error("Review closed");
    const gitDir = canonical(request.gitDir);
    // The snapshot worker validated this worktree's Git directory. Pin reads
    // there rather than rediscovering a possibly replaced checkout per file.
    this.gitDir ??= gitDir;
    if (this.gitDir !== gitDir)
      throw new Error("Worktree identity changed; reopen review explicitly");
    const controller = new AbortController();
    this.current = controller;
    try {
      if (request.fullFile) {
        const before = request.side === "before";
        let oid = before ? file.beforeBlob : file.afterBlob;
        if (!oid) {
          const tree = before ? file.from : file.to;
          const name = before ? (file.oldPath ?? file.path) : file.path;
          oid = (
            await this.git(
              ["rev-parse", "--verify", `${tree}:${name}`],
              controller.signal,
            )
          ).text.trim();
        }
        if (!OID.test(oid)) throw new Error("Invalid reviewed file identity");
        if (/^0+$/.test(oid)) return "";
        const size = Number(
          (
            await this.git(["cat-file", "-s", oid], controller.signal)
          ).text.trim(),
        );
        if (size > LIMIT)
          return `[File exceeds ${LIMIT} bytes; use o to inspect the captured version.]`;
        if (file.binary) return `[Binary file: ${size} bytes]`;
        const result = await this.git(
          ["cat-file", "blob", oid],
          controller.signal,
        );
        return result.text.includes("\0")
          ? `[Binary file: ${size} bytes]`
          : result.text;
      }
      const from = request.viewed?.tree ?? file.from;
      if (!OID.test(from) || !OID.test(file.to))
        throw new Error("Invalid preview revision identity");
      const paths = [
        ...new Set(
          [
            request.viewed ? request.viewed.path : file.oldPath,
            file.path,
          ].filter((name): name is string => !!name),
        ),
      ];
      const result = await this.git(
        diffArgs(from, file.to, paths, request.context),
        controller.signal,
      );
      return (
        result.text +
        (result.truncated
          ? "\n[Diff truncated at 8 MiB; open the file with o for further inspection.]"
          : request.viewed && !result.text
            ? "No changes since you last viewed this file.\n"
            : "")
      );
    } finally {
      if (this.current === controller) this.current = undefined;
    }
  }

  private git(
    args: string[],
    signal: AbortSignal,
  ): Promise<{ text: string; truncated: boolean }> {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "--git-dir=" + this.gitDir!,
          "--no-optional-locks",
          "--no-pager",
          "-c",
          "color.ui=false",
          ...args,
        ],
        {
          cwd: this.root,
          env: {
            ...gitEnv(),
            GIT_TERMINAL_PROMPT: "0",
            GH_PROMPT_DISABLED: "1",
          },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.child = child;
      const chunks: Buffer[] = [];
      let size = 0,
        stderr = "",
        truncated = false,
        timedOut = false;
      const kill = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, 30000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
        if (this.child === child) this.child = undefined;
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, LIMIT - size);
        if (remaining) {
          chunks.push(chunk.subarray(0, remaining));
          size += Math.min(chunk.length, remaining);
        }
        if (chunk.length > remaining) {
          truncated = true;
          kill();
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (stderr.length < 16000)
          stderr += chunk.toString("utf8").slice(0, 16000 - stderr.length);
      });
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code, exitSignal) => {
        cleanup();
        if (signal.aborted) reject(aborted());
        else if (timedOut) reject(new Error("Git preview timed out"));
        else if (code !== 0 && !truncated)
          reject(
            new Error(
              stderr.trim() || `Git preview failed (${exitSignal ?? code})`,
            ),
          );
        else
          resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated });
      });
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
    });
  }
}
