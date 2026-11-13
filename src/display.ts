import { accessLabel } from "./access.js";
import { activityView } from "./activity.js";
import type { RunSummary } from "./agent-runner.js";
import type { Agent } from "./agents.js";
import type { BranchStatus, Instance } from "./store.js";
import {
  formatHomePath,
  paintAnsi,
  sanitizeTerminalText,
  supportsAnsiColor,
} from "./tui/ansi.js";

const cleanLine = (value: unknown): string =>
  sanitizeTerminalText(value, { trim: true });

function prBadgeColor(isDraft: boolean, state: string): number {
  if (isDraft) return 33;
  if (state === "open") return 32;
  if (state === "merged") return 35;
  if (state === "closed") return 31;
  return 33;
}

const AGENT_LABELS: Readonly<Record<Agent, string>> = {
  codex: "Codex",
  claude: "Claude",
  agy: "Antigravity",
};

export function prText(pr: Instance["pr"]): string {
  if (!pr) {
    return "PR: none saved. Run rl pr sync to refresh.";
  }

  const number = typeof pr.number === "number" ? ` #${pr.number}` : "";
  const state = [pr.isDraft ? "draft" : "", cleanLine(pr.state).toLowerCase()]
    .filter(Boolean)
    .join(" · ");

  return [
    `PR${number}${pr.title ? `: ${cleanLine(pr.title)}` : ""}${state ? ` [${state}]` : ""}`,
    pr.headRefName && pr.baseRefName
      ? `  ${cleanLine(pr.headRefName)} → ${cleanLine(pr.baseRefName)}`
      : "",
    `  ${cleanLine(pr.url)}`,
    pr.syncedAt ? `  Cached ${cleanLine(pr.syncedAt)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function statusText(
  data: Instance,
  gitStatus: BranchStatus,
  workflow: RunSummary | null = null,
): string {
  const colorEnabled = supportsAnsiColor(process.stdout, process.env);
  const paint = (value: string, code: number) =>
    paintAnsi(value, code, colorEnabled);
  const muted = (value: string) => paint(value, 90);
  const row = (label: string, value: string) =>
    `  ${muted(label.padEnd(Math.max(10, label.length + 1)))}${value}`;
  const fileCountLabel = (count: number, state: string, code: number) =>
    count > 0
      ? paint(`${count} ${state} file${count === 1 ? "" : "s"}`, code)
      : "";

  const changes = [
    fileCountLabel(gitStatus.staged, "staged", 32),
    fileCountLabel(gitStatus.unstaged, "modified", 33),
    fileCountLabel(gitStatus.untracked, "untracked", 33),
    fileCountLabel(gitStatus.conflicts, "conflicted", 31),
  ].filter(Boolean);

  const directory = formatHomePath(data.worktree);
  const lines = [
    "",
    `  ${paint(cleanLine(data.id), 1)}`,
    "",
    ...(data.branch !== data.id ? [row("Branch", cleanLine(data.branch))] : []),
    row("Path", muted(cleanLine(directory))),
    ...(data.baseBranch ? [row("Base", cleanLine(data.baseBranch))] : []),
    row(
      "Git",
      gitStatus.availability === "ok"
        ? changes.join(" · ") || paint("clean", 32)
        : paint(cleanLine(gitStatus.error ?? gitStatus.availability), 31),
    ),
  ];

  if (gitStatus.upstream) {
    let syncText: string;
    if (gitStatus.ahead === 0 && gitStatus.behind === 0) {
      syncText = paint("up to date", 32);
    } else if (gitStatus.ahead === null || gitStatus.behind === null) {
      syncText = muted("commit counts unavailable");
    } else {
      const aheadText = paint(
        `${gitStatus.ahead} ahead`,
        gitStatus.ahead ? 32 : 90,
      );
      const behindText = paint(
        `${gitStatus.behind} behind`,
        gitStatus.behind ? 33 : 90,
      );
      syncText = `${aheadText} · ${behindText} ${muted("(commits)")}`;
    }
    lines.push(
      row(
        "Upstream",
        `${syncText} ${muted("· " + cleanLine(gitStatus.upstream))}`,
      ),
    );
  }

  lines.push("");

  const pr = data.pr;
  if (pr) {
    const number = typeof pr.number === "number" ? ` #${pr.number}` : "";
    const state = cleanLine(pr.state).toLowerCase();
    const label = [pr.isDraft ? "draft" : "", state]
      .filter(Boolean)
      .join(" · ");
    const badge = paint(label, prBadgeColor(Boolean(pr.isDraft), state));
    const headPrefix =
      pr.headRefName && pr.headRefName !== data.branch
        ? `${cleanLine(pr.headRefName)} `
        : "";
    const target = pr.baseRefName
      ? `${headPrefix}→ ${cleanLine(pr.baseRefName)}`
      : "";

    lines.push(
      `  ${paint(`PR${number}`, 1)}${badge ? ` · ${badge}` : ""}${target ? ` ${muted("· " + target)}` : ""}`,
    );
    if (pr.title) {
      lines.push(`  ${cleanLine(pr.title)}`);
    }
    lines.push(`  ${paint(cleanLine(pr.url), 36)}`);
    if (pr.syncedAt) {
      const stamp = cleanLine(pr.syncedAt);
      const relative = Number.isFinite(Date.parse(stamp))
        ? accessLabel(stamp)
        : stamp;
      lines.push(`  ${muted(`Cached ${relative}`)}`);
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
    ) {
      continue;
    }
    const activity = activityView(data.activity?.[agent]).filter(
      (item) => !item.childId,
    );
    const states = (["working", "idle", "stale"] as const)
      .map((state) => {
        const count = activity.filter((item) => item.state === state).length;
        if (!count) return "";
        const code = state === "working" ? 32 : state === "stale" ? 33 : 90;
        return paint(`${count} ${state}`, code);
      })
      .filter(Boolean);

    const savedCount = data.sessions[agent]?.length ?? 0;
    const stateSuffix = states.length ? ` · ${states.join(" · ")}` : "";
    lines.push(row(AGENT_LABELS[agent], `${savedCount} saved${stateSuffix}`));
  }

  if (workflow) {
    lines.push(
      "",
      `  ${paint("Workflow", 1)} · ${cleanLine(workflow.workflow)} · ${cleanLine(workflow.status)}`,
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
              `${workflow.score === null ? "not scored" : `${workflow.score}/100`} · ${cleanLine(workflow.verdict)}`,
            ),
          ]
        : []),
    );
  }

  const handoff = data.task?.handoffs.at(-1);
  if (handoff && data.task) {
    const taskTone = data.task.state === "paused" ? 33 : 32;
    lines.push(
      "",
      `  ${paint("Task", 1)} · ${paint(data.task.state, taskTone)}`,
      `  ${cleanLine(handoff.summary)}`,
      row("Next", cleanLine(handoff.next)),
    );
    if (handoff.blockers) {
      lines.push(row("Blockers", paint(cleanLine(handoff.blockers), 33)));
    }
  }

  if (Object.values(data.sessions).some((sessions) => sessions.length > 0)) {
    lines.push("", `  ${muted("Resume with")} ${paint("rl resume", 36)}`);
  }

  lines.push("");
  return lines.join("\n");
}
