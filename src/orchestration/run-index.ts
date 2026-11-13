import fs from "node:fs";
import path from "node:path";
import { object, writeJson } from "../common.js";
import { readJsonObject } from "../json.js";

const MAX_RETAINED_RUNS = 40;

export interface WorkflowRunsIndex {
  version: 1;
  latestRunId?: string;
  peerBindings: Record<string, { runId: string; stageId: string }>;
}

function indexFilePath(runsParentDir: string): string {
  return path.join(runsParentDir, "index.json");
}

export function readWorkflowRunsIndex(
  runsParentDir: string,
): WorkflowRunsIndex | null {
  const file = indexFilePath(runsParentDir);
  if (
    !fs.existsSync(file) ||
    fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()
  ) {
    return null;
  }
  try {
    const raw = readJsonObject(file);
    if (raw.version !== 1 || !object(raw.peerBindings)) {
      return null;
    }
    const peerBindings: WorkflowRunsIndex["peerBindings"] = {};
    for (const [childId, entry] of Object.entries(raw.peerBindings)) {
      if (
        object(entry) &&
        typeof entry.runId === "string" &&
        typeof entry.stageId === "string"
      ) {
        peerBindings[childId] = {
          runId: entry.runId,
          stageId: entry.stageId,
        };
      }
    }
    return {
      version: 1,
      latestRunId:
        typeof raw.latestRunId === "string" ? raw.latestRunId : undefined,
      peerBindings,
    };
  } catch {
    return null;
  }
}

export function updateWorkflowRunsIndex(
  runsParentDir: string,
  update: {
    latestRunId?: string;
    bindPeers?: ReadonlyArray<{
      childId: string;
      runId: string;
      stageId: string;
    }>;
  },
): void {
  if (
    fs.lstatSync(runsParentDir, { throwIfNoEntry: false })?.isSymbolicLink()
  ) {
    return;
  }
  const current = readWorkflowRunsIndex(runsParentDir) ?? {
    version: 1 as const,
    peerBindings: {},
  };
  if (update.latestRunId) {
    current.latestRunId = update.latestRunId;
  }
  for (const binding of update.bindPeers ?? []) {
    current.peerBindings[binding.childId] = {
      runId: binding.runId,
      stageId: binding.stageId,
    };
  }
  writeJson(indexFilePath(runsParentDir), current);
}

export function pruneTerminalWorkflowRuns(runsParentDir: string): void {
  if (!fs.existsSync(runsParentDir)) {
    return;
  }
  const runIds = fs
    .readdirSync(runsParentDir)
    .filter((id) => /^[a-f0-9-]{36}$/.test(id));
  if (runIds.length <= MAX_RETAINED_RUNS) {
    return;
  }

  const entries: {
    id: string;
    dir: string;
    createdAt: string;
    terminal: boolean;
  }[] = [];
  for (const id of runIds) {
    const dir = path.join(runsParentDir, id);
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      continue;
    }
    try {
      const raw = readJsonObject(path.join(dir, "run.json"));
      entries.push({
        id,
        dir,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
        terminal: raw.status === "completed" || raw.status === "cancelled",
      });
    } catch {
      // Keep unreadable directories untouched so validation surfaces errors explicitly.
    }
  }

  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let remaining = entries.length;
  for (
    let i = entries.length - 1;
    i >= 1 && remaining > MAX_RETAINED_RUNS;
    i--
  ) {
    if (entries[i].terminal) {
      fs.rmSync(entries[i].dir, { recursive: true, force: true });
      remaining--;
    }
  }
}
