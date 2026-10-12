import { activityView } from "./activity.js";
import { stripVTControlCharacters } from "node:util";
import type { BranchStatus, Instance } from "./store.js";

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

export function statusText(data: Instance, git: BranchStatus): string {
  const changes = [
    git.staged ? `${git.staged} staged` : "",
    git.unstaged ? `${git.unstaged} modified` : "",
    git.untracked ? `${git.untracked} untracked` : "",
    git.conflicts ? `${git.conflicts} conflicts` : "",
  ].filter(Boolean);
  const lines = [
    `Workspace: ${text(data.id)}`,
    `Branch: ${text(data.branch)}`,
    `Path: ${text(data.worktree)}`,
    ...(data.baseBranch ? [`Base: ${text(data.baseBranch)}`] : []),
    `Git: ${git.availability === "ok" ? changes.join(", ") || "clean" : text(git.error ?? git.availability)}`,
    ...(git.upstream
      ? [
          `Upstream: ${text(git.upstream)} (commits: +${git.ahead ?? "?"} ahead / -${git.behind ?? "?"} behind)`,
        ]
      : []),
    "",
    prText(data.pr),
    "",
  ];
  for (const agent of ["codex", "claude"] as const) {
    const activity = activityView(data.activity?.[agent]).filter(
      (item) => !item.childId,
    );
    const states = ["working", "idle", "stale"]
      .map((state) => {
        const count = activity.filter((item) => item.state === state).length;
        return count ? `${count} ${state}` : "";
      })
      .filter(Boolean);
    lines.push(
      `${agent === "codex" ? "Codex" : "Claude"}: ${data.sessions[agent].length} saved sessions${states.length ? ` · ${states.join(", ")}` : ""}`,
    );
  }
  const handoff = data.task?.handoffs.at(-1);
  if (handoff) {
    lines.push(
      "",
      `Task: ${data.task!.state} · ${text(handoff.summary)}`,
      `Next: ${text(handoff.next)}`,
    );
    if (handoff.blockers) lines.push(`Blockers: ${text(handoff.blockers)}`);
  }
  return lines.join("\n");
}
