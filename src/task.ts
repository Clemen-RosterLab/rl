import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  args,
  arity,
  canonical,
  json,
  now,
  object,
  timestamp,
} from "./common.js";
import { agentAdapter } from "./agent-registry.js";
import { resumeAgent } from "./agent-resume.js";
import { currentSessionId } from "./session.js";
import {
  commandContext,
  contextOptions,
  resolveWorkspace,
  writeWorkspaceOutput,
  type CommandContext,
} from "./command-context.js";
import { Store, type RecordEntry } from "./store.js";
import {
  HANDOFF_FIELDS,
  handoffNotes,
  handoffText,
  type TaskHandoff,
} from "./task-state.js";

export const PAUSE_FIELDS = [...HANDOFF_FIELDS, "agent", "sessionId"];

export async function pauseTask(
  store: Store,
  input: unknown,
  cwd = process.cwd(),
): Promise<TaskHandoff> {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !PAUSE_FIELDS.includes(key))
  )
    throw new Error("Unexpected task handoff argument");
  const notes = handoffNotes(input);
  if (input.agent !== undefined && typeof input.agent !== "string")
    throw new Error("agent must be codex or claude");
  const agent = agentAdapter(input.agent ?? "codex").name;
  const sid = currentSessionId(agent, input.sessionId);
  return store.locked(() => {
    const [file, data] = store.current(cwd);
    const stamp = now();
    const handoff: TaskHandoff = {
      ...notes,
      id: randomUUID(),
      agent,
      sessionId: sid,
      savedAt: stamp,
    };
    store.associateSession(file, data, agent, sid, stamp);
    const task = data.task ?? { state: "paused" as const, handoffs: [] };
    task.handoffs.push(handoff);
    task.state = "paused";
    delete task.continuedAt;
    data.task = task;
    store.touch(file, data, stamp);
    return handoff;
  });
}

function selectTask(context: CommandContext, selector?: string): RecordEntry {
  let records = context.store
    .records()
    .filter(([, data]) => data.status === "active" && data.task);
  if (selector !== undefined) {
    records = records.filter(
      ([, data]) =>
        data.id === selector ||
        data.branch === selector ||
        path.relative(context.managedDir, data.worktree) === selector ||
        (path.isAbsolute(selector) && canonical(selector) === data.worktree),
    );
    if (records.length !== 1)
      throw new Error(
        records.length
          ? "Ambiguous task; use the full branch or workspace path"
          : `No saved handoff for workspace ${selector}`,
      );
  } else {
    records.sort(([, a], [, b]) => {
      const paused =
        Number(b.task!.state === "paused") - Number(a.task!.state === "paused");
      if (paused) return paused;
      const at = timestamp(
        a.task!.continuedAt ?? a.task!.handoffs.at(-1)!.savedAt,
      );
      const bt = timestamp(
        b.task!.continuedAt ?? b.task!.handoffs.at(-1)!.savedAt,
      );
      return at > bt ? -1 : at < bt ? 1 : a.key.localeCompare(b.key);
    });
  }
  const selected = records[0];
  if (!selected)
    throw new Error(
      "No saved task handoffs in this repository. Ask your agent to pause the task first",
    );
  // Fail visibly on a missing or switched workspace instead of silently choosing another task.
  const current = context.store.current(selected[1].worktree);
  if (current[0] !== selected[0])
    throw new Error("Task workspace instance changed");
  return current;
}

export async function continueTask(
  context: CommandContext,
  options: { workspace?: string; noAgent?: boolean; output?: string } = {},
): Promise<number> {
  const [file, data, handoff, previousState, previousTime, stamp] =
    await context.store.locked(() => {
      const [file, data] = selectTask(context, options.workspace);
      const handoff = data.task!.handoffs.at(-1)!;
      if (
        !data.sessions[handoff.agent].some(
          (item) => item.id === handoff.sessionId,
        )
      )
        throw new Error("Handoff session is missing from workspace history");
      const stamp = now();
      const previousState = data.task!.state;
      const previousTime = data.task!.continuedAt;
      // Validate shell output before changing task state.
      writeWorkspaceOutput(data.worktree, options.output);
      data.task!.state = "active";
      data.task!.continuedAt = stamp;
      context.store.touch(file, data, stamp);
      return [file, data, handoff, previousState, previousTime, stamp] as const;
    });
  const prompt = [
    `Continue RL task ${data.id} on branch ${data.branch}.`,
    handoffText(handoff),
    `Read the full shared task documents before continuing:\n${path.join(path.dirname(file), "context.md")}\n${path.join(path.dirname(file), "progress.md")}`,
    "Recheck the current code and Git state. The handoff records what the previous agent reported; it does not establish that checks still pass. Follow the next steps and record new milestones. When asked to pause again, save a new handoff with rl_task_pause or rl pause.",
  ].join("\n\n");
  console.error(handoffText(handoff));
  if (options.noAgent) return 0;
  const restore = () =>
    context.store.locked(() => {
      const [currentFile, current] = context.store.current(data.worktree);
      const task = current.task;
      if (
        currentFile !== file ||
        task?.handoffs.at(-1)?.id !== handoff.id ||
        task.state !== "active" ||
        task.continuedAt !== stamp
      )
        return;
      task.state = previousState;
      if (previousTime === undefined) delete task.continuedAt;
      else task.continuedAt = previousTime;
      context.store.save(file, current);
    });
  try {
    const code = await resumeAgent(context.store, handoff.agent, {
      cwd: data.worktree,
      sessionId: handoff.sessionId,
      prompt,
      expectedKey: data.key,
    });
    if (code !== 0) await restore();
    return code;
  } catch (error) {
    // Retain a newer pause written by the running agent or another process.
    try {
      await restore();
    } catch {
      /* Preserve the original launch error. */
    }
    throw error;
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [
      ...contextOptions,
      ...HANDOFF_FIELDS,
      "agent",
      "session",
      "workspace",
      "file",
      "output-path",
    ],
    ["json", "no-agent"],
  );
  const context = commandContext(values);
  const [command, ...rest] = positionals;
  const supplied = Object.keys(values).filter(
    (key) => !contextOptions.includes(key),
  );
  if (command === "pause") {
    arity(rest, 0);
    if (
      supplied.some(
        (key) =>
          ![
            ...HANDOFF_FIELDS,
            "agent",
            "session",
            "workspace",
            "file",
            "json",
          ].includes(key),
      )
    )
      throw new Error("Unsupported pause option");
    if (
      values.file !== undefined &&
      supplied.some((key) =>
        [...HANDOFF_FIELDS, "agent", "session"].includes(key),
      )
    )
      throw new Error("Use --file or handoff fields, not both");
    const target = resolveWorkspace(
      context,
      typeof values.workspace === "string" ? values.workspace : undefined,
    );
    const input: unknown =
      typeof values.file === "string"
        ? JSON.parse(
            fs.readFileSync(values.file === "-" ? 0 : values.file, "utf8"),
          )
        : Object.fromEntries(
            [...HANDOFF_FIELDS, "agent", "session"]
              .filter((key) => values[key] !== undefined)
              .map((key) => [
                key === "session" ? "sessionId" : key,
                values[key],
              ]),
          );
    const handoff = await pauseTask(context.store, input, target.path);
    if (values.json) json(handoff);
    else
      console.log(
        `Paused ${target.branch}. Handoff saved; return with rl continue.`,
      );
    return 0;
  }
  if (command !== "continue")
    throw new Error("Usage: rl pause | rl continue [workspace] [--no-agent]");
  arity(rest, 0, 1);
  if (
    supplied.some(
      (key) => !["workspace", "no-agent", "output-path"].includes(key),
    ) ||
    (rest.length && values.workspace !== undefined)
  )
    throw new Error("Usage: rl continue [workspace] [--no-agent]");
  return continueTask(context, {
    workspace:
      rest[0] ??
      (typeof values.workspace === "string" ? values.workspace : undefined),
    noAgent: !!values["no-agent"],
    output:
      typeof values["output-path"] === "string"
        ? values["output-path"]
        : undefined,
  });
}
