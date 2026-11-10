import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentAdapter } from "./agent-registry.js";
import { agyTurn, agyResult } from "./agent-agy.js";
import { resumeAgent } from "./agent-resume.js";
import {
  args,
  arity,
  execute,
  json,
  now,
  sessionId,
  timestamp,
  atomicWrite,
} from "./common.js";
import {
  commandContext,
  contextOptions,
  resolveWorkspace,
} from "./command-context.js";
import { readWorkflowConfig, workflowEnvironment } from "./workflow-config.js";
import { captureSnapshot, type Snapshot } from "./review-git.js";
import { ReviewStore, type Feedback } from "./review-store.js";
import { choose, editText } from "./review-terminal.js";
import { STALE_AFTER_MS } from "./activity.js";

export interface FeedbackOptions {
  text?: string;
  agent?: string;
  session?: string;
  send?: boolean;
  resume?: boolean;
  retry?: string;
}
export async function feedback(
  review: ReviewStore,
  snapshot: Snapshot,
  options: FeedbackOptions,
): Promise<Feedback> {
  review.assertCurrent();
  let item: Feedback | undefined;
  if (options.retry) {
    sessionId(options.retry);
    item = review.load().feedback.find((item) => item.id === options.retry);
    if (!item) throw new Error("Feedback does not belong to this workspace");
  }
  if (!item) {
    let text = options.text;
    if (text === undefined) {
      if (!process.stdin.isTTY)
        throw new Error(
          "Supply feedback with --message or --file (- reads stdin)",
        );
      const draft = review.path(`drafts/${randomUUID()}.md`);
      atomicWrite(draft, "");
      text = await editText(draft, review.data.worktree);
    }
    if (!text.trim() || Buffer.byteLength(text) > 64000 || text.includes("\0"))
      throw new Error("Feedback must be non-empty text up to 64 KiB");
    review.saveSnapshot(snapshot);
    item = {
      id: randomUUID(),
      at: now(),
      snapshot: snapshot.id,
      fingerprint: snapshot.fingerprint,
      text: text.trim(),
      status: "saved",
    };
    await review.update((state) => {
      state.feedback.push(item!);
      delete state.approval;
      state.history.push({
        at: item!.at,
        action: "Changes requested",
        snapshot: snapshot.id,
      });
    });
  }
  const target = item;
  if (!options.send && !options.resume) return target;
  try {
    const [, current] = review.store.current(review.data.worktree);
    let choices = (
      options.agent
        ? [agentAdapter(options.agent).name]
        : (["codex", "claude", "agy"] as const)
    )
      .flatMap((agent) =>
        (current.sessions[agent] ?? []).map((session) => ({
          ...session,
          agent,
        })),
      )
      .sort((a, b) =>
        timestamp(a.lastUsedAt) > timestamp(b.lastUsedAt)
          ? -1
          : timestamp(a.lastUsedAt) < timestamp(b.lastUsedAt)
            ? 1
            : a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id),
      );
    if (options.session) {
      sessionId(options.session);
      choices = choices.filter((choice) => choice.id === options.session);
    }
    let selected = choices[0];
    if (!selected)
      throw new Error(
        "No matching coding session belongs to this worktree. Feedback is saved; start an agent here and use --retry after saving its session.",
      );
    if (choices.length > 1 && !options.session) {
      if (process.stdin.isTTY) {
        const picked = await choose(
          choices.map((choice) => ({
            id: `${choice.agent}:${choice.id}`,
            text: `${choice.agent} ${choice.id} · last used ${choice.lastUsedAt}`,
          })),
          review.data.worktree,
          "Coding session",
          "Choose the coding conversation for this worktree · Esc keeps feedback saved",
        );
        if (!picked) return target;
        selected = choices.find(
          (choice) => `${choice.agent}:${choice.id}` === picked.id,
        )!;
      } else
        throw new Error(
          "Multiple coding sessions; choose --agent and --session explicitly. Feedback remains saved.",
        );
    }
    review.store.assertSessionOwner(review.file, selected.agent, selected.id);
    target.agent = selected.agent;
    target.sessionId = selected.id;
    const recent = current.activity?.[selected.agent]?.find(
      (activity) => !activity.childId && activity.sessionId === selected.id,
    );
    if (
      options.send &&
      recent?.state === "working" &&
      Date.now() - Date.parse(recent.observedAt) < STALE_AFTER_MS
    )
      throw new Error(
        "This session was recently observed working. Feedback is saved; wait or use --resume to inspect the conversation.",
      );
    const context = ["context.md", "progress.md"]
      .map(
        (name) =>
          `${name} (recorded claims, not verified test results):\n${fs.readFileSync(path.join(path.dirname(review.file), name), "utf8").slice(0, 8000)}`,
      )
      .join("\n\n");
    const prompt = `RL review feedback ${target.id}\nRepository: ${review.store.repo}\nWorktree: ${current.worktree}\nBranch: ${current.branch}\nReviewed snapshot: ${target.snapshot}\nSource fingerprint: ${target.fingerprint}\n\nRequested corrections:\n${target.text}\n\n${context}\n\nRecheck current source before editing. Preserve unrelated work. Report changes and actual validation honestly. Do not approve the implementation on the user's behalf.`;
    // Persist the selected destination before any external process starts.
    await review.update((state) => {
      const saved = state.feedback.find((item) => item.id === target.id)!;
      Object.assign(saved, target);
    });
    if (options.resume) {
      const code = await resumeAgent(review.store, selected.agent, {
        cwd: current.worktree,
        sessionId: selected.id,
        prompt,
        expectedKey: current.key,
      });
      if (code) throw new Error(`Session resume failed (${code})`);
      target.status = "opened"; // Opening is not an acknowledgement of delivery.
    } else {
      review.assertCurrent();
      const [, latest] = review.store.current(current.worktree);
      if (
        !latest.sessions[selected.agent]?.some(
          (session) => session.id === selected.id,
        )
      )
        throw new Error("Coding session association changed before delivery");
      const turn =
        selected.agent === "agy"
          ? agyTurn(prompt, [
              "--conversation",
              selected.id,
              "--disable-slash-commands",
            ])
          : undefined;
      const command =
        turn?.command ??
        (selected.agent === "codex"
          ? ["codex", "exec", "resume", selected.id, "--", "-"]
          : [
              "claude",
              "--print",
              "--resume",
              selected.id,
              "--",
              "Apply the RL review feedback provided on stdin.",
            ]);
      const result = await execute(command, current.worktree, {
        input: turn?.input ?? prompt,
        timeoutMs: 10 * 60 * 1000,
        maxOutputBytes: 4 * 1024 * 1024,
        env: {
          ...workflowEnvironment(
            review.store.repo,
            current.worktree,
            readWorkflowConfig(review.store.repo),
          ),
          RL_STATE_DIR: review.store.stateDir,
        },
      });
      if (result.code)
        throw new Error(
          `Feedback turn failed (${result.code}): ${result.stderr.trim().slice(0, 3000)}`,
        );
      if (selected.agent === "agy") {
        const response = agyResult(result.stdout);
        if (response.conversation_id !== selected.id)
          throw new Error(
            "Antigravity did not confirm a successful turn in the selected conversation",
          );
      }
      target.status = "delivered";
      target.output = result.stdout.slice(-64000);
    }
    delete target.error;
  } catch (error) {
    target.status = "failed";
    target.error = error instanceof Error ? error.message : String(error);
  }
  await review.update((state) => {
    const saved = state.feedback.find((item) => item.id === target.id);
    if (!saved) throw new Error("Feedback changed during delivery");
    Object.assign(saved, target);
  });
  return target;
}
export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [...contextOptions, "message", "file", "agent", "session", "retry"],
    ["send", "resume", "list", "json"],
  );
  arity(positionals, 0, 1);
  if (
    (values.send && values.resume) ||
    (values.message !== undefined && values.file !== undefined)
  )
    throw new Error(
      "Expected one feedback input and at most one of --send or --resume",
    );
  const context = commandContext(values),
    target = resolveWorkspace(context, positionals[0]);
  const review = new ReviewStore(
    context.store,
    context.store.current(target.path),
  );
  if (values.list) {
    const items = review.load().feedback;
    if (values.json) json(items);
    else
      for (const item of items)
        console.log(
          `${item.id} ${item.status} ${item.at}\n${item.text}\n${item.error ?? ""}`,
        );
    return 0;
  }
  let text = typeof values.message === "string" ? values.message : undefined;
  if (typeof values.file === "string")
    text = fs.readFileSync(values.file === "-" ? 0 : values.file, "utf8");
  if (text && text.length > 64000)
    throw new Error("Feedback input exceeds 64 KiB");
  const snapshot = captureSnapshot(target.path);
  const item = await feedback(review, snapshot, {
    text,
    agent: values.agent as string | undefined,
    session: values.session as string | undefined,
    retry: values.retry as string | undefined,
    send: !!values.send,
    resume: !!values.resume,
  });
  if (values.json) json(item);
  else
    console.log(
      `Feedback ${item.id}: ${item.status}\n${item.error ?? (item.status === "saved" ? "Saved for this worktree. Use --retry <id> --send or --resume when ready." : item.status === "opened" ? "Opened the coding session with feedback; delivery was not independently acknowledged." : "Coding turn completed successfully.")}`,
    );
  return item.status === "failed" ? 1 : 0;
}
