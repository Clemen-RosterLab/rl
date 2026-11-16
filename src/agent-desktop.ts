import path from "node:path";
import { sessionId } from "./common.js";
import { UsageError } from "./errors.js";

export function desktopAgent(name: string): "codex" | "claude" {
  if (name !== "codex" && name !== "claude")
    throw new UsageError("Desktop launch supports codex or claude");
  return name;
}

/** Use native launchers; never guess deep links or write either app's settings. */
export function desktopLaunch(
  name: string,
  workspace: string,
  savedSession?: string,
): { command: string[]; resumesSession: boolean } {
  const agent = desktopAgent(name);
  if (!path.isAbsolute(workspace))
    throw new Error("Desktop launch requires an absolute workspace path");
  const id = savedSession === undefined ? undefined : sessionId(savedSession);
  if (agent === "codex")
    return { command: ["codex", "app", workspace], resumesSession: false };
  return {
    command: ["claude", "--desktop", ...(id ? ["--resume", id] : [])],
    resumesSession: id !== undefined,
  };
}
