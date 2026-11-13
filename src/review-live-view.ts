import path from "node:path";
import { visible } from "./review-terminal.js";
import type { Commit, Mode, ReviewFile } from "./review-live-engine.js";
import {
  reviewFilterCategories,
  advancedReviewFilters,
  type ReviewFileFilters,
  type ReviewSettings,
} from "./review-live-files.js";
import type { ReviewRanks } from "./review-ranking.js";

const foreground = (hex: string) =>
  process.env.NO_COLOR ? "" : `\x1b[38;2;${rgb(hex)}m`;
const background = (hex: string) =>
  process.env.NO_COLOR ? "" : `\x1b[48;2;${rgb(hex)}m`;
function rgb(hex: string): string {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
}
export const reviewPalette = {
  background: "11151a",
  surface: "1d242d",
  selection: "283448",
  text: "e3e9ef",
  muted: "9baac0",
  blue: "b7cdfb",
  green: "88d5a5",
  red: "f38c83",
  addition: "1c352b",
  deletion: "3b252c",
  amber: "edc776",
  border: "343e4c",
};
export const reviewReset = `\x1b[0m${background(reviewPalette.background)}`;
function charWidth(c: string): number {
  const n = c.codePointAt(0)!;
  return /\p{Mark}/u.test(c)
    ? 0
    : n >= 0x1100 &&
        (n <= 0x115f ||
          (n >= 0x2e80 && n <= 0xa4cf) ||
          (n >= 0xac00 && n <= 0xd7a3) ||
          (n >= 0xf900 && n <= 0xfaff) ||
          (n >= 0xfe10 && n <= 0xfe6f) ||
          (n >= 0xff00 && n <= 0xff60) ||
          n >= 0x1f300)
      ? 2
      : 1;
}
export function terminalText(value: string, width: number, offset = 0): string {
  let text = "",
    used = 0,
    skipped = 0;
  for (const c of visible(value.replaceAll("\t", "    "))) {
    const w = charWidth(c);
    if (skipped < offset) {
      skipped += w;
      continue;
    }
    if (used + w > width) break;
    text += c;
    used += w;
  }
  return text + " ".repeat(Math.max(0, width - used));
}
export interface ReviewTextPoint {
  line: number;
  column: number;
}
export interface ReviewTextSelection {
  anchor: ReviewTextPoint;
  end: ReviewTextPoint;
  lines: string[];
}
export function reviewTextColumn(value: string, requested: number): number {
  let column = 0;
  for (const c of visible(value.replaceAll("\t", "    "))) {
    const width = charWidth(c);
    if (column + width > requested) break;
    column += width;
  }
  return column;
}
export function reviewSelectionBounds(selection: ReviewTextSelection) {
  const { anchor, end } = selection;
  return anchor.line < end.line ||
    (anchor.line === end.line && anchor.column <= end.column)
    ? { start: anchor, end }
    : { start: end, end: anchor };
}
export function reviewSelectedText(selection: ReviewTextSelection): string {
  const { start, end } = reviewSelectionBounds(selection);
  const result: string[] = [];
  for (let line = start.line; line <= end.line; line++) {
    const from = line === start.line ? start.column : 0;
    const to = line === end.line ? end.column : Infinity;
    let column = 0,
      text = "";
    for (const c of visible(
      (selection.lines[line] ?? "").replaceAll("\t", "    "),
    )) {
      const width = charWidth(c);
      if (column >= to && width > 0) break;
      if (column + width > from || (width === 0 && text)) text += c;
      column += width;
    }
    result.push(text);
  }
  return result.join("\n");
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ReviewLayout {
  width: number;
  rows: number;
  narrow: boolean;
  body: Rect;
  commits: Rect;
  files: Rect;
  working?: Rect;
  divider?: Rect;
  diff: Rect;
  viewport: Rect;
}
export function reviewLayout(
  width: number,
  rows: number,
  _focus: number,
  expanded = false,
  sidebarWidth?: number,
  gutterWidth = 0,
): ReviewLayout {
  width = Math.max(1, width);
  rows = Math.max(1, rows);
  const body = {
    x: 1,
    y: 3,
    width: Math.max(1, width - 2),
    height: Math.max(1, rows - 6),
  };
  const narrow = width < 85 || body.height < 12 || expanded;
  const left = narrow
    ? body.width
    : Math.max(
        24,
        Math.min(
          body.width - 37,
          sidebarWidth ??
            Math.min(56, Math.max(30, Math.floor(body.width * 0.4))),
        ),
      );
  const commitHeight = narrow
    ? body.height
    : Math.max(4, Math.floor(body.height * 0.43));
  const fileHeight = narrow
    ? body.height
    : Math.max(4, Math.floor(body.height * 0.36));
  const commits = { x: body.x, y: body.y, width: left, height: commitHeight };
  const files = {
    x: body.x,
    y: narrow ? body.y : body.y + commitHeight,
    width: left,
    height: fileHeight,
  };
  const working = narrow
    ? undefined
    : {
        x: body.x,
        y: files.y + files.height,
        width: left,
        height: body.height - commitHeight - fileHeight,
      };
  const diff = {
    x: narrow ? body.x : left + 3,
    y: body.y,
    width: narrow ? body.width : Math.max(1, body.width - left - 2),
    height: body.height,
  };
  const viewport = {
    x: diff.x + 1 + gutterWidth,
    y: diff.y + 3,
    width: Math.max(1, diff.width - 3 - gutterWidth),
    height: Math.max(1, diff.height - 5),
  };
  const divider = narrow
    ? undefined
    : { x: left + 1, y: body.y, width: 2, height: body.height };
  return {
    width,
    rows,
    narrow,
    body,
    commits,
    files,
    working,
    divider,
    diff,
    viewport,
  };
}
export interface HitRegion extends Rect {
  action:
    | "commits"
    | "toggle-commit"
    | "files"
    | "diff"
    | "scrollbar"
    | "divider"
    | "filter-category"
    | "menu"
    | "working"
    | "expand"
    | "shortcut";
  index?: number;
  shortcut?: string;
}
export interface ReviewView {
  width: number;
  rows: number;
  focus: number;
  expanded: boolean;
  sidebarWidth?: number;
  textSelection?: ReviewTextSelection;
  filterMenu?: {
    filters: ReviewFileFilters;
    index: number;
    settings?: ReviewSettings;
  };
  menu?: ReviewMenu;
  reviewed?: Set<string>;
  changedSinceViewed?: Set<string>;
  ranks?: ReviewRanks;
  fullFile?: boolean;
  beforeFile?: boolean;
  lineNumbers?: boolean;
  previewLabel?: string;
  branch: string;
  head: string;
  frozen: boolean;
  newer: boolean;
  mode: Mode;
  comparison?: string;
  commits: Commit[];
  commitIndex: number;
  commitScroll: number;
  files: ReviewFile[];
  fileIndex: number;
  hideNoise: boolean;
  hiddenFiles: number;
  workingFiles: ReviewFile[];
  hiddenWorkingFiles: number;
  lines: string[];
  scroll: number;
  horizontal: number;
  help?: string[];
  search: string;
  status: string;
  input?: string;
  remote: string;
  pr?: string;
  updates: number;
}
export interface ReviewMenu {
  title: string;
  subtitle?: string;
  index: number;
  items: { label: string; detail?: string }[];
  hint?: string;
}
export interface ReviewFrame {
  rows: string[];
  hits: HitRegion[];
  layout: ReviewLayout;
}
export function listStart(index: number, capacity: number): number {
  return Math.max(0, index - Math.floor(Math.max(1, capacity) / 2));
}
export function scrollLimit(length: number, height: number): number {
  return Math.max(0, length - Math.max(1, height));
}

export function reviewScrollbar(
  length: number,
  height: number,
  scroll: number,
) {
  height = Math.max(1, height);
  const limit = scrollLimit(length, height);
  const thumbSize = Math.min(
    height,
    Math.max(1, Math.floor((height * height) / Math.max(1, length))),
  );
  const travel = height - thumbSize;
  const thumbStart = Math.round(
    (Math.max(0, Math.min(scroll, limit)) / Math.max(1, limit)) * travel,
  );
  return { limit, thumbSize, thumbStart, travel };
}

const lineNumberCache = new WeakMap<
  string[],
  [number | undefined, number | undefined][]
>();
export function reviewLineNumbers(
  lines: string[],
): [number | undefined, number | undefined][] {
  const cached = lineNumberCache.get(lines);
  if (cached) return cached;
  let old = 0,
    next = 0,
    inHunk = false;
  const result = lines.map((line): [number | undefined, number | undefined] => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
    } else if (line.startsWith("diff --git ")) inHunk = false;
    else if (inHunk && line.startsWith("+")) return [undefined, next++];
    else if (inHunk && line.startsWith("-")) return [old++, undefined];
    else if (inHunk && line.startsWith(" ")) return [old++, next++];
    return [undefined, undefined];
  });
  lineNumberCache.set(lines, result);
  return result;
}
const diffColors = new WeakMap<string[], Uint8Array>();
function diffLineColors(lines: string[]): Uint8Array {
  const cached = diffColors.get(lines);
  if (cached) return cached;
  const colors = new Uint8Array(lines.length);
  let inHunk = false;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("diff --git ")) inHunk = false;
    if (line.startsWith("@@ ")) inHunk = true;
    if (inHunk && line.startsWith("+")) colors[index] = 1;
    if (inHunk && line.startsWith("-")) colors[index] = 2;
  }
  diffColors.set(lines, colors);
  return colors;
}

/** The renderer produces only viewport rows; ANSI output is diffed by the host. */
export function reviewFrame(view: ReviewView): ReviewFrame {
  const layout = reviewLayout(
      view.width,
      view.rows,
      view.focus,
      view.expanded,
      view.sidebarWidth,
      view.lineNumbers ? 12 : 0,
    ),
    palette = reviewPalette;
  const spans: {
    x: number;
    width: number;
    text: string;
    fg: string;
    bg: string;
    offset: number;
    selection?: { from: number; to: number };
  }[][] = Array.from({ length: layout.rows }, () => []);
  const hits: HitRegion[] = [];
  function paint(
    x: number,
    y: number,
    width: number,
    text = "",
    fg = palette.text,
    bg = palette.background,
    offset = 0,
    selection?: { from: number; to: number },
  ): void {
    if (y < 0 || y >= layout.rows || x >= layout.width || width <= 0) return;
    const clampedX = Math.max(0, x);
    const clampedWidth = Math.min(width, layout.width - clampedX);
    if (clampedWidth <= 0) return;
    const newEnd = clampedX + clampedWidth;
    const nextRow: (typeof spans)[number] = [];
    for (const existing of spans[y]) {
      const existingEnd = existing.x + existing.width;
      if (existingEnd <= clampedX || existing.x >= newEnd) {
        nextRow.push(existing);
        continue;
      }
      if (existing.x < clampedX) {
        nextRow.push({ ...existing, width: clampedX - existing.x });
      }
      if (existingEnd > newEnd) {
        const delta = newEnd - existing.x;
        nextRow.push({
          ...existing,
          x: newEnd,
          width: existingEnd - newEnd,
          offset: existing.offset + delta,
        });
      }
    }
    nextRow.push({
      x: clampedX,
      width: clampedWidth,
      text,
      fg,
      bg,
      offset,
      selection,
    });
    spans[y] = nextRow;
  }
  const rule = (rect: Rect, y = rect.y) =>
    paint(rect.x, y, rect.width, "─".repeat(rect.width), palette.border);
  const heading = (rect: Rect, title: string, focused: boolean) =>
    paint(
      rect.x,
      rect.y,
      rect.width,
      title,
      focused ? palette.blue : palette.muted,
    );
  const line = (
    rect: Rect,
    y: number,
    text: string,
    fg = palette.text,
    selected = false,
  ) =>
    paint(
      rect.x,
      y,
      rect.width,
      ` ${text}`,
      fg,
      selected ? palette.selection : palette.background,
    );
  const indicator = view.frozen
    ? `❄ FROZEN${view.newer ? " · NEW CHANGES" : ""}`
    : "◎ LIVE";
  const indicatorWidth = Math.min(layout.width, indicator.length + 2);
  paint(
    1,
    0,
    Math.max(0, layout.width - indicatorWidth - 2),
    `PRVIEW / ${view.branch}`,
    palette.text,
  );
  paint(
    Math.max(0, layout.width - indicatorWidth),
    0,
    indicatorWidth,
    indicator,
    view.frozen ? palette.amber : palette.green,
  );
  const testToggle = view.hideNoise
    ? `[t Focus: ${view.hiddenFiles} hidden]`
    : "[t All files]";
  const testToggleWidth = Math.min(
    testToggle.length,
    Math.max(1, layout.width - 2),
  );
  const testToggleX = Math.max(1, layout.width - testToggleWidth - 1);
  const filterButton = "[Filters]";
  const filterX = Math.max(1, testToggleX - filterButton.length - 2);
  paint(
    1,
    1,
    Math.max(0, filterX - 2),
    `${view.comparison ?? "Loading comparison…"}${view.pr ? " · " + view.pr : ""}`,
    palette.muted,
  );
  if (filterX + filterButton.length < testToggleX) {
    paint(
      filterX,
      1,
      filterButton.length,
      filterButton,
      view.filterMenu ? palette.blue : palette.muted,
    );
    hits.push({
      x: filterX,
      y: 1,
      width: filterButton.length,
      height: 1,
      action: "shortcut",
      shortcut: "T",
    });
  }
  paint(
    testToggleX,
    1,
    testToggleWidth,
    testToggle,
    view.hideNoise ? palette.amber : palette.muted,
  );
  hits.push({
    x: testToggleX,
    y: 1,
    width: testToggleWidth,
    height: 1,
    action: "shortcut",
    shortcut: "t",
  });
  rule({ x: 1, y: 2, width: Math.max(1, layout.width - 2), height: 1 });

  function commits(): void {
    const rect = layout.commits;
    const selectedShas = new Set(
      view.mode.kind === "commits"
        ? view.mode.commits.map((commit) => commit.sha)
        : [],
    );
    const selection = selectedShas.size
      ? `${selectedShas.size} selected`
      : "Space to select";
    heading(rect, `1 COMMITS · ${selection}`, view.focus === 0);
    hits.push({ ...rect, action: "commits" });
    const includeWorking = layout.narrow;
    const capacity = Math.max(1, Math.floor((rect.height - 2) / 3));
    const start = Math.max(
      0,
      Math.min(
        view.commitScroll,
        view.commits.length + (includeWorking ? 1 : 0) - capacity,
      ),
    );
    for (let row = 0; row < capacity; row++) {
      const index = start + row + (includeWorking ? 0 : 1),
        commit = index === 0 ? undefined : view.commits[index - 1],
        y = rect.y + 1 + row * 3;
      if (index !== 0 && !commit) break;
      const checked = commit !== undefined && selectedShas.has(commit.sha);
      const active =
        index === 0
          ? view.mode.kind === "working"
          : commit &&
            (checked ||
              (view.mode.kind === "commit" && view.mode.sha === commit.sha));
      const cursor = view.focus === 0 && index === view.commitIndex ? "›" : " ";
      const text = commit
        ? `[${checked ? "x" : " "}] ${cursor} ${commit.sha.slice(0, 7)} ${commit.subject}`
        : "● WORKING TREE";
      line(rect, y, text, active ? palette.blue : palette.text, !!active);
      line(
        rect,
        y + 1,
        commit
          ? `${commit.files} files · +${commit.additions} −${commit.deletions}${commit.parents.length > 1 ? " · merge" : ""}`
          : `${new Set(view.workingFiles.map((f) => f.path)).size} files · staged / unstaged`,
        palette.muted,
        !!active,
      );
      hits.push({
        x: rect.x,
        y,
        width: rect.width,
        height: 2,
        action: "commits",
        index,
      });
      if (commit)
        hits.push({
          x: rect.x + 1,
          y,
          width: 3,
          height: 1,
          action: "toggle-commit",
          index,
        });
    }
    if (!view.commits.length && !includeWorking)
      line(rect, rect.y + 1, "No commits yet", palette.muted);
    if (!layout.narrow) rule(rect, rect.y + rect.height - 1);
  }
  function files(): void {
    const rect = layout.files;
    heading(
      rect,
      `2 FILES IN SELECTION${view.reviewed ? ` · ${view.files.filter((file) => view.reviewed!.has(file.key)).length}/${view.files.length} reviewed` : ""}`,
      view.focus === 1,
    );
    hits.push({ ...rect, action: "files" });
    const capacity = Math.max(1, Math.floor((rect.height - 2) / 2)),
      start = listStart(view.fileIndex, capacity);
    for (let row = 0; row < capacity; row++) {
      const index = start + row,
        file = view.files[index];
      if (!file) break;
      const y = rect.y + 1 + row * 2,
        active = index === view.fileIndex;
      const tone = file.status.startsWith("A")
        ? palette.blue
        : file.status.startsWith("D")
          ? palette.red
          : palette.green;
      line(
        rect,
        y,
        `${view.reviewed?.has(file.key) ? "✓ " : view.changedSinceViewed?.has(file.key) ? "● " : ""}${file.status} ${file.oldPath ? path.basename(file.oldPath) + " → " : ""}${path.basename(file.path)}`,
        active ? palette.blue : tone,
        active,
      );
      line(
        rect,
        y + 1,
        `${file.layer} · ${file.binary ? "binary" : `+${file.additions} −${file.deletions}`} · ${path.dirname(file.path)}`,
        palette.muted,
        active,
      );
      hits.push({
        x: rect.x,
        y,
        width: rect.width,
        height: 2,
        action: "files",
        index,
      });
    }
    if (!view.files.length)
      line(
        rect,
        rect.y + 1,
        view.hiddenFiles ? "Files filtered · t shows all" : "No changed files",
        palette.muted,
      );
    if (!layout.narrow) rule(rect, rect.y + rect.height - 1);
  }
  function working(): void {
    const rect = layout.working;
    if (!rect) return;
    heading(
      rect,
      "WORKING TREE  ·  w",
      view.focus === 0 && view.mode.kind === "working",
    );
    hits.push({ ...rect, action: "working" });
    const unique = [
      ...new Map(view.workingFiles.map((f) => [f.path, f])).values(),
    ];
    const capacity = Math.max(1, rect.height - 2);
    const activePath =
      view.mode.kind === "working"
        ? view.files[view.fileIndex]?.path
        : undefined;
    const start = Math.min(
      listStart(
        unique.findIndex((file) => file.path === activePath),
        capacity,
      ),
      Math.max(0, unique.length - capacity),
    );
    for (let i = 0; i < capacity && start + i < unique.length; i++) {
      const file = unique[start + i];
      const active = file.path === activePath;
      line(
        rect,
        rect.y + 1 + i,
        `● ${path.basename(file.path)} (${file.layer})`,
        active ? palette.blue : palette.amber,
        active,
      );
      hits.push({
        x: rect.x,
        y: rect.y + 1 + i,
        width: rect.width,
        height: 1,
        action: "working",
        index: view.workingFiles.indexOf(file),
      });
    }
    if (!unique.length)
      line(
        rect,
        rect.y + 1,
        view.hiddenWorkingFiles
          ? "Changes filtered · t shows all"
          : "Clean · no local changes",
        palette.muted,
      );
  }
  function diff(): void {
    const rect = layout.diff,
      viewport = layout.viewport,
      file = view.files[view.fileIndex],
      lines = view.help ?? view.lines;
    if (view.menu) {
      heading(rect, view.menu.title, true);
      paint(
        rect.x,
        rect.y + 1,
        rect.width,
        view.menu.subtitle ?? "",
        palette.muted,
      );
      const capacity = Math.max(1, Math.floor((rect.height - 5) / 2));
      const start = Math.min(
        listStart(view.menu.index, capacity),
        Math.max(0, view.menu.items.length - capacity),
      );
      for (let row = 0; row < capacity; row++) {
        const index = start + row,
          item = view.menu.items[index];
        if (!item) break;
        const y = rect.y + 3 + row * 2,
          selected = index === view.menu.index;
        line(
          rect,
          y,
          item.label,
          selected ? palette.blue : palette.text,
          selected,
        );
        line(rect, y + 1, item.detail ?? "", palette.muted, selected);
        hits.push({
          x: rect.x,
          y,
          width: rect.width,
          height: 2,
          action: "menu",
          index,
        });
      }
      paint(
        rect.x,
        rect.y + rect.height - 1,
        rect.width,
        view.menu.hint ?? "j/k Move · Enter Select · Escape Close",
        palette.muted,
      );
      return;
    }
    if (view.filterMenu) {
      heading(rect, "FILE FILTERS · HIDE CHECKED CATEGORIES", true);
      paint(
        rect.x,
        rect.y + 1,
        rect.width,
        "Saved for this worktree",
        palette.muted,
      );
      const categories = [...reviewFilterCategories, ...advancedReviewFilters];
      const capacity = Math.max(1, Math.floor((rect.height - 5) / 3));
      const start = Math.min(
        listStart(view.filterMenu.index, capacity),
        Math.max(0, categories.length - capacity),
      );
      for (let row = 0; row < capacity; row++) {
        const index = start + row,
          category = categories[index];
        if (!category) break;
        const y = rect.y + 3 + row * 3;
        const active = index === view.filterMenu.index;
        const checked =
          category.key === "lockfiles" || category.key === "generated"
            ? (view.filterMenu.settings?.[category.key] ??
              view.filterMenu.filters.boilerplate)
            : view.filterMenu.filters[category.key];
        line(
          rect,
          y,
          `${index + 1} [${checked ? "x" : " "}] ${category.label}`,
          active ? palette.blue : palette.text,
          active,
        );
        line(rect, y + 1, category.description, palette.muted, active);
        hits.push({
          x: rect.x,
          y,
          width: rect.width,
          height: 2,
          action: "filter-category",
          index,
        });
      }
      paint(
        rect.x,
        rect.y + rect.height - 2,
        rect.width,
        "Space Toggle · 1–5 · a/n All/None · d Defaults",
        palette.muted,
      );
      paint(
        rect.x,
        rect.y + rect.height - 1,
        rect.width,
        "h Hide paths · i Include paths · w Wheel speed · Esc Done",
        palette.muted,
      );
      return;
    }
    const offset = Math.min(
      view.scroll,
      scrollLimit(lines.length, viewport.height),
    );
    const contentHeight = Math.min(viewport.height, Math.max(1, lines.length));
    const bar = reviewScrollbar(lines.length, viewport.height, offset);
    const colors =
      view.help || view.fullFile ? undefined : diffLineColors(lines);
    const selection =
      !view.help && view.textSelection
        ? reviewSelectionBounds(view.textSelection)
        : undefined;
    const position = `${view.files.length ? view.fileIndex + 1 : 0} / ${view.files.length}`;
    const expand = view.expanded ? "[Back]" : "[Expand]";
    const controls = Math.min(rect.width, position.length + expand.length + 3);
    paint(
      rect.x,
      rect.y,
      Math.max(0, rect.width - controls),
      view.help
        ? "KEYBOARD"
        : view.fullFile
          ? `3 FILE · ${view.beforeFile ? "BEFORE" : "AFTER"}`
          : "3 DIFF PREVIEW",
      view.focus === 2 ? palette.blue : palette.text,
    );
    paint(
      rect.x + rect.width - controls,
      rect.y,
      controls,
      `${expand}  ${position}`,
      palette.muted,
    );
    hits.push({
      x: rect.x + rect.width - controls,
      y: rect.y,
      width: expand.length,
      height: 1,
      action: "expand",
    });
    paint(
      rect.x,
      rect.y + 1,
      rect.width,
      file
        ? `${file.path} · ${file.layer}${file.binary ? " · binary" : ""}`
        : "Select a file to review",
      palette.muted,
    );
    paint(
      rect.x,
      rect.y + 2,
      rect.width,
      view.previewLabel ??
        (file && view.ranks?.[file.key]
          ? `${view.ranks[file.key].kind}: ${view.ranks[file.key].reason}`
          : ""),
      palette.muted,
      palette.surface,
    );
    const numbers =
      view.lineNumbers && !view.help && !view.fullFile
        ? reviewLineNumbers(lines)
        : undefined;
    for (let i = 0; i < contentHeight; i++) {
      const text = lines[offset + i] ?? "";
      let tone = palette.text;
      let surface = palette.surface;
      if (colors?.[offset + i] === 1) {
        tone = palette.green;
        surface = palette.addition;
      } else if (colors?.[offset + i] === 2) {
        tone = palette.red;
        surface = palette.deletion;
      } else if (
        /^(?:@@|diff |index |---|\+\+\+|new file|deleted file)/.test(text)
      )
        tone = palette.muted;
      if (view.search && text.toLowerCase().includes(view.search.toLowerCase()))
        tone = palette.amber;
      const lineNumber = offset + i;
      const selectedColumns =
        selection &&
        lineNumber >= selection.start.line &&
        lineNumber <= selection.end.line
          ? {
              from:
                lineNumber === selection.start.line
                  ? selection.start.column
                  : 0,
              to:
                lineNumber === selection.end.line
                  ? selection.end.column
                  : Infinity,
            }
          : undefined;
      paint(rect.x, viewport.y + i, 1, "", palette.text, surface);
      if (view.lineNumbers && !view.help) {
        const [old, next] = view.fullFile
          ? [undefined, offset + i + 1]
          : (numbers![offset + i] ?? []);
        paint(
          rect.x + 1,
          viewport.y + i,
          12,
          `${old === undefined ? "" : old}`.padStart(5) +
            " " +
            `${next === undefined ? "" : next}`.padStart(5) +
            " ",
          palette.muted,
          palette.surface,
        );
      }
      paint(
        viewport.x,
        viewport.y + i,
        viewport.width,
        text,
        tone,
        surface,
        view.horizontal,
        selectedColumns,
      );
      const thumb = i >= bar.thumbStart && i < bar.thumbStart + bar.thumbSize;
      paint(
        rect.x + rect.width - 2,
        viewport.y + i,
        2,
        bar.limit ? (thumb ? "▐ " : "│ ") : "",
        thumb ? palette.blue : palette.border,
        palette.surface,
      );
    }
    paint(
      rect.x,
      viewport.y + contentHeight,
      rect.width,
      "",
      palette.text,
      palette.surface,
    );
    paint(
      rect.x,
      viewport.y + contentHeight + 1,
      rect.width,
      `j/k Scroll · [ ] Files · y Copy · ${Math.min(offset + 1, lines.length)}–${Math.min(offset + viewport.height, lines.length)} / ${lines.length}`,
      palette.muted,
    );
    hits.push({ ...rect, action: "diff" });
    if (bar.limit)
      hits.push({
        x: rect.x + rect.width - 2,
        y: viewport.y,
        width: 2,
        height: viewport.height,
        action: "scrollbar",
      });
  }
  if (layout.narrow) {
    if (view.menu || view.filterMenu || view.expanded || view.focus === 2)
      diff();
    else if (view.focus === 0) commits();
    else files();
  } else {
    commits();
    files();
    working();
    diff();
    const divider = layout.divider!;
    for (let y = divider.y; y < divider.y + divider.height; y++)
      paint(divider.x, y, divider.width, "│ ", palette.border);
    hits.push({ ...divider, action: "divider" });
  }
  const footerY = Math.max(0, layout.rows - 3);
  rule({ x: 1, y: footerY, width: Math.max(1, layout.width - 2), height: 1 });
  const state = view.input ?? view.status;
  const meta = `${view.updates} local · ${view.pr ? (view.remote.includes("newer") ? "NEW PR UPDATE" : view.remote.startsWith("#") ? "PR polled" : "PR unavailable") : view.head.slice(0, 8) || "unborn"}`;
  const showMeta =
    !view.input &&
    (view.status.startsWith("Updated") || view.status.startsWith("Frozen")) &&
    layout.width > 90;
  const metaWidth = showMeta ? meta.length + 2 : 0;
  paint(
    1,
    footerY + 1,
    layout.width - 2 - metaWidth,
    state,
    view.input
      ? palette.blue
      : /omitted|conflicts|moving|failed|unavailable/i.test(state)
        ? palette.amber
        : palette.muted,
  );
  if (showMeta)
    paint(
      layout.width - metaWidth,
      footerY + 1,
      metaWidth,
      meta,
      palette.muted,
    );
  const shortcuts = [
    { text: "1 Commits", key: "1" },
    { text: "2 Files", key: "2" },
    { text: "3 Diff", key: "3" },
    { text: "−", key: "-" },
    { text: "+", key: "+" },
    { text: "T Filters", key: "T" },
    { text: "b Compare", key: "b" },
    { text: view.hideNoise ? "t Show all" : "t Focus files", key: "t" },
    { text: "Tab Switch", key: "\t" },
    { text: "R Range", key: "r" },
    { text: "S Since Review", key: "s" },
    { text: "/ Search", key: "/" },
    { text: "F Freeze", key: "f" },
    { text: "? Help", key: "?" },
  ];
  let x = 1;
  for (const item of shortcuts) {
    if (x + item.text.length > layout.width - 9) break;
    paint(x, footerY + 2, item.text.length, item.text, palette.muted);
    hits.push({
      x,
      y: footerY + 2,
      width: item.text.length,
      height: 1,
      action: "shortcut",
      shortcut: item.key,
    });
    x += item.text.length + 2;
  }
  const quitX = Math.max(0, layout.width - 7);
  paint(quitX, footerY + 2, Math.min(6, layout.width), "Q Quit", palette.muted);
  hits.push({
    x: quitX,
    y: footerY + 2,
    width: Math.min(6, layout.width),
    height: 1,
    action: "shortcut",
    shortcut: "q",
  });
  // Small terminals share header/footer rows; keep the final footer authoritative.
  const rows = spans.map((parts) => {
    let row = "",
      end = 0;
    for (const part of parts.sort((a, b) => a.x - b.x)) {
      if (part.x < end) continue;
      row +=
        foreground(palette.text) +
        background(palette.background) +
        " ".repeat(Math.max(0, part.x - end));
      const text = terminalText(part.text, part.width, part.offset);
      let content = text;
      if (part.selection) {
        content = "";
        let column = part.offset,
          selected = false;
        for (const c of text) {
          const next: boolean =
            charWidth(c) === 0
              ? selected
              : column >= part.selection.from && column < part.selection.to;
          if (next !== selected) {
            content += next
              ? background(palette.selection) + foreground(palette.text)
              : background(part.bg) + foreground(part.fg);
            selected = next;
          }
          content += c;
          column += charWidth(c);
        }
      }
      row += foreground(part.fg) + background(part.bg) + content;
      end = part.x + part.width;
    }
    return (
      row +
      foreground(palette.text) +
      background(palette.background) +
      " ".repeat(Math.max(0, layout.width - end)) +
      reviewReset
    );
  });
  return { rows, hits, layout };
}
