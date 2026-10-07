import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { canonical, object, sessionId, timestamp } from "./common.js";
import { Session, Store } from "./store.js";

interface DiscoveredSession extends Session {
  cwd: string;
  branch?: string;
}
const SOURCES = ["cli", "vscode", "exec", "appServer"];

// Ask Codex for workspace-filtered metadata only. Never read transcripts or
// request a model turn, and never fall back to an unfiltered history query.
async function discover(
  cwd: string,
  roots: string[],
): Promise<DiscoveredSession[]> {
  const child = spawn("codex", ["app-server"], {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  let requestId = 0;
  let pending:
    | {
        id: number;
        resolve: (value: Record<string, unknown>) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let failure: Error | undefined;
  let bytes = 0;
  const fail = (error: Error) => {
    failure = error;
    pending?.reject(error);
    pending = undefined;
    child.kill();
  };
  const timer = setTimeout(
    () => fail(new Error("Codex session discovery timed out")),
    3000,
  );
  child.on("error", fail);
  child.on("close", () => fail(new Error("Codex session discovery closed")));
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024)
      fail(new Error("Codex session metadata is too large"));
  });
  lines.on("line", (line) => {
    try {
      const reply: unknown = JSON.parse(line);
      if (!object(reply) || reply.id !== pending?.id || !pending) return;
      if (reply.error !== undefined || !object(reply.result))
        throw new Error("Codex rejected session discovery");
      const request = pending;
      pending = undefined;
      request.resolve(reply.result);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (failure) return reject(failure);
      pending = { id: ++requestId, resolve, reject };
      child.stdin.write(
        JSON.stringify({ id: requestId, method, params }) + "\n",
      );
    });
  try {
    await request("initialize", { clientInfo: { name: "rl", version: "1" } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const sessions: DiscoveredSession[] = [];
    // A string cwd also works with older app-server versions.
    for (const root of roots) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const result = await request("thread/list", {
          cwd: root,
          useStateDbOnly: true,
          sourceKinds: SOURCES,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(result.data))
          throw new Error("Invalid Codex thread list");
        for (const thread of result.data) {
          if (
            !object(thread) ||
            thread.ephemeral === true ||
            (thread.source !== undefined &&
              (typeof thread.source !== "string" ||
                !SOURCES.includes(thread.source))) ||
            typeof thread.cwd !== "string" ||
            canonical(thread.cwd) !== root
          )
            continue;
          // Only UUIDs can be passed unambiguously to the installed resume CLI.
          try {
            if (
              typeof thread.createdAt !== "number" ||
              typeof thread.updatedAt !== "number"
            )
              continue;
            const createdAt = new Date(thread.createdAt * 1000).toISOString();
            const lastUsedAt = new Date(thread.updatedAt * 1000).toISOString();
            sessions.push({
              id: sessionId(thread.id),
              cwd: root,
              createdAt,
              lastUsedAt,
              branch:
                object(thread.gitInfo) &&
                typeof thread.gitInfo.branch === "string"
                  ? thread.gitInfo.branch
                  : undefined,
            });
          } catch {
            /* Unsupported identifiers or invalid timestamps are not resume targets. */
          }
        }
        if (
          result.nextCursor !== null &&
          result.nextCursor !== undefined &&
          typeof result.nextCursor !== "string"
        )
          throw new Error("Invalid Codex thread cursor");
        cursor = result.nextCursor as string | undefined;
        if (cursor && cursors.has(cursor))
          throw new Error("Repeated Codex thread cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    return sessions;
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

export async function syncCodexSessions(
  store: Store,
  cwd?: string,
): Promise<void> {
  const records = await store.locked(() =>
    cwd
      ? [store.current(cwd)]
      : store.records().filter(([, data]) => data.status === "active"),
  );
  const eligible = records.filter(([, data]) => {
    try {
      return store.current(data.worktree)[1].key === data.key;
    } catch {
      return false;
    }
  });
  if (!eligible.length) return;
  let sessions: DiscoveredSession[];
  try {
    sessions = await discover(
      eligible[0][1].worktree,
      eligible.map(([, data]) => data.worktree),
    );
  } catch {
    // Missing/older Codex or a temporarily unavailable server must not hide RL
    // status or erase already saved sessions. Hooks/manual save still work.
    return;
  }
  await store.locked(() => {
    for (const [file, snapshot] of eligible) {
      let current;
      try {
        current = store.current(snapshot.worktree);
      } catch {
        continue;
      }
      const [currentFile, data] = current;
      if (currentFile !== file || data.key !== snapshot.key) continue;
      let changed = false;
      for (const session of sessions) {
        if (
          session.cwd !== data.worktree ||
          (session.branch !== undefined && session.branch !== data.branch) ||
          (session.branch === undefined &&
            timestamp(session.createdAt) < timestamp(data.createdAt))
        )
          continue;
        try {
          store.assertSessionOwner(file, "codex", session.id);
        } catch {
          continue;
        }
        const saved = data.sessions.codex.find(
          (item) => item.id === session.id,
        );
        if (!saved) {
          data.sessions.codex.push({
            id: session.id,
            createdAt: session.createdAt,
            lastUsedAt: session.lastUsedAt,
          });
          changed = true;
        } else if (
          timestamp(session.lastUsedAt) > timestamp(saved.lastUsedAt)
        ) {
          saved.lastUsedAt = session.lastUsedAt;
          changed = true;
        }
      }
      if (changed) store.save(file, data);
    }
  });
}
