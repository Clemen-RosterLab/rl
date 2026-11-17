import type { OverviewRow } from "./repos.js";
import {
  displayWidth,
  padCell,
  paintAnsi,
  supportsAnsiColor,
} from "./tui/ansi.js";

interface Cell {
  text: string;
  color: number;
}

function changes(row: OverviewRow): Cell {
  const s = row.gitStatus;
  if (s.availability !== "ok") return { text: s.availability, color: 31 };
  if (!s.dirty) return { text: "clean", color: 32 };
  const text = (
    [
      ["conflicts", "!"],
      ["staged", "S"],
      ["unstaged", "M"],
      ["untracked", "?"],
    ] as const
  )
    .filter(([key]) => s[key] > 0)
    .map(([key, letter]) => `${s[key]}${letter}`)
    .join("/");
  return { text: text || "modified", color: s.conflicts ? 31 : 33 };
}

function sync(row: OverviewRow): Cell {
  const s = row.gitStatus;
  if (s.availability !== "ok") return { text: "—", color: 90 };
  if (!s.upstream) return { text: "no upstream", color: 90 };
  if (s.ahead === null || s.behind === null)
    return { text: "unknown", color: 33 };
  if (!s.ahead && !s.behind) return { text: "synced", color: 90 };
  return {
    text: [s.ahead ? `↑${s.ahead}` : "", s.behind ? `↓${s.behind}` : ""]
      .filter(Boolean)
      .join(" "),
    color: s.behind ? 33 : 36,
  };
}

function pullRequest(row: OverviewRow): Cell {
  const pr = row.pr;
  if (!pr) return { text: "—", color: 90 };
  const state =
    typeof pr.state === "string" ? pr.state.toLowerCase() : "unknown";
  let label = state === "open" ? "" : ` ${state}`;
  if (pr.isDraft) label = " draft";
  const colors: Record<string, number> = { open: 32, merged: 35, closed: 31 };
  const color = pr.isDraft ? 33 : (colors[state] ?? 90);
  const number = typeof pr.number === "number" ? `#${pr.number}` : "PR";
  return { text: `${number}${label}`, color };
}

function sessionCount(row: OverviewRow): number {
  return Object.values(row.sessions ?? {}).reduce(
    (count, sessions) => count + (sessions?.length ?? 0),
    0,
  );
}

function details(row: OverviewRow): string[] {
  const result: string[] = [];
  if (row.status !== "active")
    result.push(row.status === "unregistered" ? "not initialized" : row.status);
  if (row.gitStatus.branchChanged)
    result.push(`[changed] ${row.gitStatus.branch || "(detached)"}`);
  else if (row.branch !== row.id) result.push(`branch: ${row.branch}`);
  if (row.task) result.push(`task ${row.task.state}`);
  return result;
}

export function overviewTerminalWidth(): number {
  const configured = Number(process.env.COLUMNS);
  return (
    process.stdout.columns ||
    (Number.isSafeInteger(configured) && configured > 0 ? configured : 120)
  );
}

/** A compact, automatic summary. Full identities and metadata remain in --json. */
export function formatOverviewTable(
  rows: OverviewRow[],
  options: { width?: number; color?: boolean; fetched?: boolean } = {},
): string {
  const width = Math.max(
    1,
    Math.min(140, Math.floor(options.width ?? overviewTerminalWidth())),
  );
  const colored =
    options.color ?? supportsAnsiColor(process.stdout, process.env);
  const paint = (text: string, color: number) =>
    paintAnsi(text, color, colored);
  const line = (text: string, color = 90) =>
    paint(padCell(text, width).trimEnd(), color);
  if (!rows.length) return line("No RL workspaces found.");
  const groups = new Map<string, OverviewRow[]>();
  for (const row of rows) {
    const group = groups.get(row.repositoryName) ?? [];
    group.push(row);
    groups.set(row.repositoryName, group);
  }
  const output: string[] = [""];
  for (const [name, group] of groups) {
    output.push(
      line(
        `  ${name} · ${group.length} workspace${group.length === 1 ? "" : "s"}`,
        1,
      ),
      "",
    );
    const showPr = group.some((row) => row.pr);
    const showSessions = width >= 110 && group.some((row) => sessionCount(row));
    const compact = width < 70;
    const sideWidths = [
      14,
      12,
      ...(showPr ? [16] : []),
      ...(showSessions ? [8] : []),
    ];
    const nameWidth =
      width - 2 - sideWidths.reduce((sum, size) => sum + size + 2, 0);
    const widths = [nameWidth, ...sideWidths];
    if (!compact) {
      const headers = [
        "WORKSPACE",
        "CHANGES",
        "SYNC",
        ...(showPr ? ["PR"] : []),
        ...(showSessions ? ["SESSIONS"] : []),
      ];
      output.push(
        paint(
          "  " +
            headers
              .map((header, i) => padCell(header, widths[i]))
              .join("  ")
              .trimEnd(),
          90,
        ),
      );
    }
    for (const row of group) {
      const status = changes(row);
      const progress = sync(row);
      const pr = pullRequest(row);
      if (compact) {
        output.push(line(`  ${row.id}`, 1));
        const info = [status.text, progress.text, ...(row.pr ? [pr.text] : [])];
        output.push(line(`    ${info.join(" · ")}`, status.color));
      } else {
        const cells: Cell[] = [
          { text: row.id, color: 37 },
          status,
          progress,
          ...(showPr ? [pr] : []),
          ...(showSessions
            ? [{ text: String(sessionCount(row) || "—"), color: 90 }]
            : []),
        ];
        output.push(
          "  " +
            cells
              .map((cell, i) => {
                const text = padCell(cell.text, widths[i]);
                return paint(
                  i === cells.length - 1 ? text.trimEnd() : text,
                  cell.color,
                );
              })
              .join("  "),
        );
      }
      for (const detail of details(row))
        output.push(line(`    ↳ ${detail}`, 33));
      if (compact) output.push("");
    }
    if (!compact) output.push("");
  }
  // Short, wrapped notes replace the old wide legend and duplicate remote-ref notice.
  const notes = [
    ...(rows.some((row) => row.gitStatus.dirty)
      ? ["S staged · M modified · ? new · ! conflict"]
      : []),
    "↑ ahead · ↓ behind",
    options.fetched
      ? "Fetch requested; see errors if any."
      : "Refs cached; --fetch refreshes.",
    ...(rows.some((row) => row.pr) ? ["PRs cached."] : []),
  ];
  let footer = "  ";
  for (const note of notes) {
    const next = footer.trim() ? `${footer} · ${note}` : `  ${note}`;
    if (displayWidth(next) > width && footer.trim()) {
      output.push(line(footer));
      footer = `  ${note}`;
    } else footer = next;
  }
  if (footer.trim()) output.push(line(footer));
  return output.join("\n");
}
