import { activityView } from "./activity.js";
import { accessLabel } from "./access.js";
import { stripVTControlCharacters } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import type { BranchStatus, Instance } from "./store.js";
import type { RunSummary } from "./agent-runner.js";

// Keep names and remote titles on one terminal line without control sequences.
const text = (value: unknown): string =>
  stripVTControlCharacters(String(value ?? ""))
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .trim();

export function prText(pr: Instance["pr"]): string {
  if (!pr) return "PR: none saved. Run rl pr sync to refresh.";
  const number = typeof pr.number === "number" ? ` #${pr.number}` : "";
  const state = [pr.isDraft ? "draft" : "", text(pr.state).toLowerCase()]
    .filter(Boolean)
    .join(" · ");
  return [
    `PR${number}${pr.title ? `: ${text(pr.title)}` : ""}${state ? ` [${state}]` : ""}`,
    pr.headRefName && pr.baseRefName
      ? `  ${text(pr.headRefName)} → ${text(pr.baseRefName)}`
      : "",
    `  ${text(pr.url)}`,
    pr.syncedAt ? `  Cached ${text(pr.syncedAt)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function statusText(
  data: Instance,
  git: BranchStatus,
  workflow: RunSummary | null = null,
): string {
  const color =
    process.env.NO_COLOR === undefined &&
    process.env.FORCE_COLOR !== "0" &&
    process.env.TERM !== "dumb" &&
    (!!process.stdout.isTTY || !!process.env.FORCE_COLOR);
  const paint = (value: string, code: number) =>
    color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const muted = (value: string) => paint(value, 90);
  const row = (label: string, value: string) =>
    `  ${muted(label.padEnd(Math.max(10, label.length + 1)))}${value}`;
  const files = (count: number, state: string, code: number) =>
    count ? paint(`${count} ${state} file${count === 1 ? "" : "s"}`, code) : "";
  const changes = [
    files(git.staged, "staged", 32),
    files(git.unstaged, "modified", 33),
    files(git.untracked, "untracked", 33),
    files(git.conflicts, "conflicted", 31),
  ].filter(Boolean);
  const home = homedir();
  const directory =
    data.worktree === home
      ? "~"
      : data.worktree.startsWith(home + path.sep)
        ? "~" + data.worktree.slice(home.length)
        : data.worktree;
  const lines = [
    "",
    `  ${paint(text(data.id), 1)}`,
    "",
    ...(data.branch !== data.id ? [row("Branch", text(data.branch))] : []),
    row("Path", muted(text(directory))),
    ...(data.baseBranch ? [row("Base", text(data.baseBranch))] : []),
    row(
      "Git",
      git.availability === "ok"
        ? changes.join(" · ") || paint("clean", 32)
        : paint(text(git.error ?? git.availability), 31),
    ),
  ];
  if (git.upstream) {
    const sync =
      git.ahead === 0 && git.behind === 0
        ? paint("up to date", 32)
        : git.ahead === null || git.behind === null
          ? muted("commit counts unavailable")
          : `${paint(`${git.ahead} ahead`, git.ahead ? 32 : 90)} · ${paint(`${git.behind} behind`, git.behind ? 33 : 90)} ${muted("(commits)")}`;
    lines.push(row("Upstream", `${sync} ${muted("· " + text(git.upstream))}`));
  }
  lines.push("");
  const pr = data.pr;
  if (pr) {
    const number = typeof pr.number === "number" ? ` #${pr.number}` : "";
    const state = text(pr.state).toLowerCase();
    const label = [pr.isDraft ? "draft" : "", state]
      .filter(Boolean)
      .join(" · ");
    const badge = paint(
      label,
      pr.isDraft
        ? 33
        : state === "open"
          ? 32
          : state === "merged"
            ? 35
            : state === "closed"
              ? 31
              : 33,
    );
    const target = pr.baseRefName
      ? `${pr.headRefName && pr.headRefName !== data.branch ? text(pr.headRefName) + " " : ""}→ ${text(pr.baseRefName)}`
      : "";
    lines.push(
      `  ${paint(`PR${number}`, 1)}${badge ? ` · ${badge}` : ""}${target ? ` ${muted("· " + target)}` : ""}`,
    );
    if (pr.title) lines.push(`  ${text(pr.title)}`);
    lines.push(`  ${paint(text(pr.url), 36)}`);
    if (pr.syncedAt) {
      const stamp = text(pr.syncedAt);
      lines.push(
        `  ${muted(`Cached ${Number.isFinite(Date.parse(stamp)) ? accessLabel(stamp) : stamp}`)}`,
      );
    }
  } else {
    lines.push(
      `  ${paint("PR", 1)} ${muted("· none saved")}`,
      `  ${muted("Run rl pr sync to refresh")}`,
    );
  }
  lines.push("", `  ${paint("Sessions", 1)}`);
  for (const agent of ["codex", "claude", "agy"] as const) {
    if (
      agent === "agy" &&
      !data.sessions.agy?.length &&
      !data.activity?.agy?.length
    )
      continue;
    const activity = activityView(data.activity?.[agent]).filter(
      (item) => !item.childId,
    );
    const states = ["working", "idle", "stale"]
      .map((state) => {
        const count = activity.filter((item) => item.state === state).length;
        return count
          ? paint(
              `${count} ${state}`,
              state === "working" ? 32 : state === "stale" ? 33 : 90,
            )
          : "";
      })
      .filter(Boolean);
    lines.push(
      row(
        agent === "codex"
          ? "Codex"
          : agent === "agy"
            ? "Antigravity"
            : "Claude",
        `${data.sessions[agent]?.length ?? 0} saved${states.length ? ` · ${states.join(" · ")}` : ""}`,
      ),
    );
  }
  if (workflow) {
    lines.push(
      "",
      `  ${paint("Workflow", 1)} · ${text(workflow.workflow)} · ${text(workflow.status)}`,
      row("Steps", `${workflow.completed}/${workflow.total} completed`),
      ...(workflow.owner
        ? [
            row(
              "Owner",
              `${workflow.owner.agent} · native subagents · ${workflow.owner.sessionId}`,
            ),
          ]
        : []),
      ...(workflow.verdict
        ? [
            row(
              "Review",
              `${workflow.score === null ? "not scored" : `${workflow.score}/100`} · ${text(workflow.verdict)}`,
            ),
          ]
        : []),
    );
  }
  const handoff = data.task?.handoffs.at(-1);
  if (handoff) {
    lines.push(
      "",
      `  ${paint("Task", 1)} · ${paint(data.task!.state, data.task!.state === "paused" ? 33 : 32)}`,
      `  ${text(handoff.summary)}`,
      row("Next", text(handoff.next)),
    );
    if (handoff.blockers)
      lines.push(row("Blockers", paint(text(handoff.blockers), 33)));
  }
  if (Object.values(data.sessions).some((sessions) => sessions.length))
    lines.push("", `  ${muted("Resume with")} ${paint("rl resume", 36)}`);
  lines.push("");
  return lines.join("\n");
}
