import type { ReviewFile } from "./review-live-engine.js";

export type FileLineHighlight = "added" | "deleted" | "modified";

export interface FileDiffMarker {
  kind: "added" | "deleted";
  count: number;
}

export interface FileDiffHighlights {
  /** 1-based line numbers in the displayed file that were added, deleted, or modified. */
  lines: Map<number, FileLineHighlight>;
  /** 1-based anchor line numbers where pure opposite-side deletions/additions occurred. */
  markers: Map<number, FileDiffMarker>;
  /** 0-based line indices of hunk starts for `{` / `}` navigation. */
  hunks: number[];
}

export interface TreeRow {
  kind: "dir" | "file";
  path: string;
  name: string;
  depth: number;
  expanded?: boolean;
  status?: string;
  hasChanges?: boolean;
  changeCount?: number;
  file?: ReviewFile;
}

export interface FileTreeNode {
  name: string;
  path: string;
  dirs: Map<string, FileTreeNode>;
  files: { name: string; path: string }[];
}

/**
 * Parse a unified diff (at any context level, including `-U0`) into per-line
 * highlights and pure-deletion/insertion gutter markers for full-file view.
 */
export function parseFileDiffHighlights(
  patchText: string,
  side: "before" | "after",
  totalLines: number,
): FileDiffHighlights {
  const lines = new Map<number, FileLineHighlight>();
  const markers = new Map<number, FileDiffMarker>();
  const hunkSet = new Set<number>();

  if (!patchText) return { lines, markers, hunks: [] };

  const diffLines = patchText.split("\n");
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  let blockOldStart = 0;
  let blockNewStart = 0;
  let delCount = 0;
  let addCount = 0;

  const flushBlock = () => {
    if (delCount === 0 && addCount === 0) return;

    if (side === "after") {
      if (addCount > 0) {
        const kind: FileLineHighlight = delCount > 0 ? "modified" : "added";
        for (let ln = blockNewStart; ln < blockNewStart + addCount; ln++) {
          if (ln >= 1 && (totalLines === 0 || ln <= totalLines)) {
            lines.set(ln, kind);
          }
        }
        hunkSet.add(Math.max(0, blockNewStart - 1));
      } else if (delCount > 0 && totalLines > 0) {
        const anchor = Math.max(1, Math.min(totalLines, blockNewStart));
        const existing = markers.get(anchor);
        markers.set(anchor, {
          kind: "deleted",
          count: (existing?.count ?? 0) + delCount,
        });
        hunkSet.add(anchor - 1);
      }
    } else {
      if (delCount > 0) {
        const kind: FileLineHighlight = addCount > 0 ? "modified" : "deleted";
        for (let ln = blockOldStart; ln < blockOldStart + delCount; ln++) {
          if (ln >= 1 && (totalLines === 0 || ln <= totalLines)) {
            lines.set(ln, kind);
          }
        }
        hunkSet.add(Math.max(0, blockOldStart - 1));
      } else if (addCount > 0 && totalLines > 0) {
        const anchor = Math.max(1, Math.min(totalLines, blockOldStart));
        const existing = markers.get(anchor);
        markers.set(anchor, {
          kind: "added",
          count: (existing?.count ?? 0) + addCount,
        });
        hunkSet.add(anchor - 1);
      }
    }

    delCount = 0;
    addCount = 0;
  };

  for (const text of diffLines) {
    if (text.startsWith("diff --git ")) {
      flushBlock();
      inHunk = false;
      continue;
    }
    const match = hunkHeader.exec(text);
    if (match) {
      flushBlock();
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      // When a side has count 0 (pure deletion or pure insertion in -U0), Git
      // reports the line immediately *before* the gap (0 at start of file).
      oldLine = oldCount === 0 ? oldStart + 1 : oldStart;
      newLine = newCount === 0 ? newStart + 1 : newStart;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (text.startsWith("\\")) continue; // "\ No newline at end of file"
    if (text.startsWith("-")) {
      if (delCount === 0 && addCount === 0) {
        blockOldStart = oldLine;
        blockNewStart = newLine;
      }
      delCount++;
      oldLine++;
    } else if (text.startsWith("+")) {
      if (delCount === 0 && addCount === 0) {
        blockOldStart = oldLine;
        blockNewStart = newLine;
      }
      addCount++;
      newLine++;
    } else if (text.startsWith(" ")) {
      flushBlock();
      oldLine++;
      newLine++;
    } else {
      flushBlock();
    }
  }
  flushBlock();

  const hunks = [...hunkSet].toSorted((a, b) => a - b);
  return { lines, markers, hunks };
}

export function ancestorDirs(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  const dirs: string[] = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    dirs.push(current);
  }
  return dirs;
}

export function parentDirPath(itemPath: string): string | undefined {
  const idx = itemPath.lastIndexOf("/");
  return idx > 0 ? itemPath.slice(0, idx) : undefined;
}

export function buildFileTree(paths: readonly string[]): FileTreeNode {
  const root: FileTreeNode = {
    name: "",
    path: "",
    dirs: new Map(),
    files: [],
  };
  const seen = new Set<string>();
  for (const raw of paths) {
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const parts = raw.split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      prefix = prefix ? `${prefix}/${part}` : part;
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, path: prefix, dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], path: raw });
  }
  return root;
}

const compareNames = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: "base" }) ||
  (a < b ? -1 : a > b ? 1 : 0);

export function flattenFileTree(
  root: FileTreeNode,
  expandedDirs: ReadonlySet<string>,
  changedByPath: ReadonlyMap<string, ReviewFile>,
): TreeRow[] {
  const dirChangeCounts = new Map<string, number>();
  for (const filePath of changedByPath.keys()) {
    for (const dir of ancestorDirs(filePath)) {
      dirChangeCounts.set(dir, (dirChangeCounts.get(dir) ?? 0) + 1);
    }
  }

  const rows: TreeRow[] = [];
  const visit = (node: FileTreeNode, depth: number) => {
    const dirs = [...node.dirs.values()].toSorted((a, b) =>
      compareNames(a.name, b.name),
    );
    for (const dir of dirs) {
      const expanded = expandedDirs.has(dir.path);
      const changeCount = dirChangeCounts.get(dir.path) ?? 0;
      rows.push({
        kind: "dir",
        path: dir.path,
        name: dir.name,
        depth,
        expanded,
        hasChanges: changeCount > 0,
        changeCount,
      });
      if (expanded) visit(dir, depth + 1);
    }

    const files = node.files.toSorted((a, b) => compareNames(a.name, b.name));
    for (const entry of files) {
      const changed = changedByPath.get(entry.path);
      rows.push({
        kind: "file",
        path: entry.path,
        name: entry.name,
        depth,
        status: changed?.status,
        hasChanges: Boolean(changed),
        file: changed,
      });
    }
  };

  visit(root, 0);
  return rows;
}
