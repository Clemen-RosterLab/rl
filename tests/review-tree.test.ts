import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, Workspace, write } from "./helpers.js";

const url = (name: string) =>
  pathToFileURL(path.join(ROOT, `dist/${name}.js`)).href;
const tree = await import(url("review-tree"));
const symbols = await import(url("review-symbols"));
const engine = await import(url("review-live-engine"));
const preview = await import(url("review-live-preview"));
const view = await import(url("review-live-view"));

test("parseFileDiffHighlights matches -U0 and -U3 diffs across additions, modifications and pure deletions", () => {
  const before = [
    "line 1",
    "line 2 old",
    "line 3",
    "line 4 deleted",
    "line 5 deleted",
    "line 6",
    "line 7",
    "line 8 tail deleted",
  ];
  const after = [
    "line 0 inserted top",
    "line 1",
    "line 2 new",
    "line 2b added",
    "line 3",
    "line 6",
    "line 7",
  ];
  const u0 = [
    "diff --git a/sample.ts b/sample.ts",
    "@@ -0,0 +1,1 @@",
    "+line 0 inserted top",
    "@@ -2,1 +3,2 @@",
    "-line 2 old",
    "+line 2 new",
    "+line 2b added",
    "@@ -4,2 +5,0 @@",
    "-line 4 deleted",
    "-line 5 deleted",
    "@@ -8,1 +7,0 @@",
    "-line 8 tail deleted",
  ].join("\n");
  const u3 = [
    "diff --git a/sample.ts b/sample.ts",
    "@@ -1,8 +1,7 @@",
    "+line 0 inserted top",
    " line 1",
    "-line 2 old",
    "+line 2 new",
    "+line 2b added",
    " line 3",
    "-line 4 deleted",
    "-line 5 deleted",
    " line 6",
    " line 7",
    "-line 8 tail deleted",
  ].join("\n");

  const afterU0 = tree.parseFileDiffHighlights(u0, "after", after.length);
  const afterU3 = tree.parseFileDiffHighlights(u3, "after", after.length);
  assert.deepEqual([...afterU0.lines], [...afterU3.lines]);
  assert.deepEqual([...afterU0.markers], [...afterU3.markers]);
  assert.deepEqual(afterU0.hunks, afterU3.hunks);

  assert.equal(afterU0.lines.get(1), "added");
  assert.equal(afterU0.lines.get(2), undefined);
  assert.equal(afterU0.lines.get(3), "modified");
  assert.equal(afterU0.lines.get(4), "modified");
  assert.deepEqual(afterU0.markers.get(6), { kind: "deleted", count: 2 });
  assert.deepEqual(afterU0.markers.get(7), { kind: "deleted", count: 1 });
  assert.deepEqual(afterU0.hunks, [0, 2, 5, 6]);

  const beforeU0 = tree.parseFileDiffHighlights(u0, "before", before.length);
  const beforeU3 = tree.parseFileDiffHighlights(u3, "before", before.length);
  assert.deepEqual([...beforeU0.lines], [...beforeU3.lines]);
  assert.deepEqual([...beforeU0.markers], [...beforeU3.markers]);
  assert.deepEqual(beforeU0.hunks, beforeU3.hunks);

  assert.deepEqual(beforeU0.markers.get(1), { kind: "added", count: 1 });
  assert.equal(beforeU0.lines.get(2), "modified");
  assert.equal(beforeU0.lines.get(4), "deleted");
  assert.equal(beforeU0.lines.get(5), "deleted");
  assert.equal(beforeU0.lines.get(8), "deleted");
});

test("buildFileTree and flattenFileTree sort folders first, respect expansion and aggregate change counts", () => {
  const root = tree.buildFileTree([
    "README.md",
    "src/utils/math.ts",
    "src/app.ts",
    "docs/guide.md",
    "src/utils/format.ts",
  ]);
  const changed = new Map([
    [
      "src/app.ts",
      {
        id: "f1",
        path: "src/app.ts",
        status: "M",
        additions: 2,
        deletions: 1,
        binary: false,
        layer: "unstaged",
        from: "a".repeat(40),
        to: "b".repeat(40),
        key: "unstaged\0src/app.ts",
      },
    ],
    [
      "src/utils/math.ts",
      {
        id: "f2",
        path: "src/utils/math.ts",
        status: "A",
        additions: 10,
        deletions: 0,
        binary: false,
        layer: "untracked",
        from: "a".repeat(40),
        to: "b".repeat(40),
        key: "unstaged\0src/utils/math.ts",
      },
    ],
  ]);

  const collapsed = tree.flattenFileTree(root, new Set(), changed);
  assert.deepEqual(
    collapsed.map((row: any) => [row.kind, row.path, row.changeCount ?? 0]),
    [
      ["dir", "docs", 0],
      ["dir", "src", 2],
      ["file", "README.md", 0],
    ],
  );

  const expanded = tree.flattenFileTree(
    root,
    new Set(tree.ancestorDirs("src/utils/math.ts")),
    changed,
  );
  assert.deepEqual(
    expanded.map((row: any) => [
      row.kind,
      row.path,
      row.depth,
      row.status ?? "",
    ]),
    [
      ["dir", "docs", 0, ""],
      ["dir", "src", 0, ""],
      ["dir", "src/utils", 1, ""],
      ["file", "src/utils/format.ts", 2, ""],
      ["file", "src/utils/math.ts", 2, "A"],
      ["file", "src/app.ts", 1, "M"],
      ["file", "README.md", 0, ""],
    ],
  );
  assert.equal(tree.parentDirPath("src/utils/math.ts"), "src/utils");
  assert.equal(tree.parentDirPath("README.md"), undefined);
});

test("LiveRepository.treeFiles and ReviewPreview.readFullFile expose repo trees and -U0 diff patches", async (t) => {
  const w = new Workspace(t);
  fs.mkdirSync(path.join(w.a, "src"), { recursive: true });
  fs.mkdirSync(path.join(w.a, "docs"), { recursive: true });
  write(path.join(w.a, ".gitignore"), "ignored.log\n");
  write(path.join(w.a, "src/app.ts"), "const a = 1;\nconst b = 2;\n");
  write(path.join(w.a, "docs/guide.md"), "# Guide\n");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-qm", "Initial tree");
  write(
    path.join(w.a, "src/app.ts"),
    "const a = 1;\nconst b = 3;\nconst c = 4;\n",
  );
  write(path.join(w.a, "src/new.ts"), "export const created = true;\n");
  write(path.join(w.a, "ignored.log"), "secret\n");

  const repo = new engine.LiveRepository(w.a);
  const state = repo.refresh();
  const comparison = repo.comparison({ kind: "working" }, state);
  const paths = repo.treeFiles(comparison.target);
  assert.ok(paths.includes("src/app.ts"));
  assert.ok(paths.includes("src/new.ts"));
  assert.ok(paths.includes("docs/guide.md"));
  assert.ok(!paths.includes("ignored.log"));

  const file = repo
    .files(comparison, state)
    .find((entry: any) => entry.path === "src/app.ts");
  const reader = new preview.ReviewPreview(w.a);
  t.after(() => reader.close());
  const full = await reader.readFullFile(file, {
    gitDir: state.gitDir,
    context: 0,
    fullFile: true,
    side: "after",
    includePatch: true,
  });
  assert.equal(full.text, "const a = 1;\nconst b = 3;\nconst c = 4;\n");
  assert.match(full.patch ?? "", /\+const b = 3;/);
  const highlights = tree.parseFileDiffHighlights(
    full.patch ?? "",
    "after",
    full.text.split("\n").length,
  );
  assert.equal(highlights.lines.get(1), undefined);
  assert.equal(highlights.lines.get(2), "modified");
  assert.equal(highlights.lines.get(3), "modified");
});

test("reviewFrame renders sidebar tabs, tree rows, file toggle controls and full-file diff highlights", () => {
  const file = {
    id: "f1",
    path: "src/app.ts",
    status: "M",
    additions: 1,
    deletions: 1,
    binary: false,
    layer: "unstaged",
    from: "a".repeat(40),
    to: "b".repeat(40),
    key: "unstaged\0src/app.ts",
  };
  const root = tree.buildFileTree(["src/app.ts", "docs/guide.md"]);
  const treeRows = tree.flattenFileTree(
    root,
    new Set(["src"]),
    new Map([[file.path, file]]),
  );
  const highlights = tree.parseFileDiffHighlights(
    ["@@ -2,1 +2,1 @@", "-const old = 1;", "+const updated = 2;"].join("\n"),
    "after",
    3,
  );
  const frame = view.reviewFrame({
    width: 140,
    rows: 26,
    focus: 2,
    expanded: false,
    sidebarTab: "tree",
    treeRows,
    treeIndex: 2,
    treeScroll: 0,
    treeTotalFiles: 2,
    activeFile: file,
    fileHighlights: highlights,
    fullFile: true,
    beforeFile: false,
    lineNumbers: true,
    branch: "feature/tree",
    head: "a".repeat(40),
    frozen: false,
    newer: false,
    mode: { kind: "working" },
    comparison: "Working tree",
    commits: [],
    commitIndex: 0,
    commitScroll: 0,
    files: [file],
    fileIndex: 0,
    hideNoise: true,
    hiddenFiles: 0,
    workingFiles: [file],
    hiddenWorkingFiles: 0,
    lines: ["const unchanged = 0;", "const updated = 2;", "const tail = 3;"],
    scroll: 0,
    horizontal: 0,
    search: "",
    status: "Updated",
    remote: "",
    updates: 1,
  });

  const plain = frame.rows.join("\n");
  assert.match(plain, /1 TREE · 2 files/);
  assert.match(plain, /\[Commits\]/);
  assert.match(plain, /\[c: Diff\]/);
  assert.match(plain, /\[e: Before\]/);
  assert.ok(
    frame.hits.some(
      (hit: any) => hit.action === "sidebar-tab" && hit.tab === "commits",
    ),
  );
  assert.ok(
    frame.hits.some(
      (hit: any) => hit.action === "shortcut" && hit.shortcut === "c",
    ),
  );
  assert.ok(
    frame.hits.some((hit: any) => hit.action === "tree" && hit.index === 0),
  );
});

test(
  "real terminal directory tree tab, repository file browsing, and full-file diff highlighting",
  { timeout: 120000 },
  (t) => {
    const w = new Workspace(t);
    fs.mkdirSync(path.join(w.a, "src"), { recursive: true });
    fs.mkdirSync(path.join(w.a, "docs"), { recursive: true });
    const baseApp =
      [
        "const headerContext = 1;",
        "const changedLine = 1;",
        ...Array.from(
          { length: 10 },
          (_, i) => `const keep${i + 1} = ${i + 1};`,
        ),
        "const deletedLine = 99;",
        "const afterDeleted = 100;",
      ].join("\n") + "\n";
    const nextApp =
      [
        "const headerContext = 1;",
        "const changedLine = 2;",
        "const addedLine = 3;",
        ...Array.from(
          { length: 10 },
          (_, i) => `const keep${i + 1} = ${i + 1};`,
        ),
        "const afterDeleted = 100;",
      ].join("\n") + "\n";
    write(path.join(w.a, "src/app.ts"), baseApp);
    write(path.join(w.a, "src/removed.ts"), "export const gone = true;\n");
    write(path.join(w.a, "docs/guide.md"), "unchanged guide documentation\n");
    w.git(w.a, "add", ".");
    w.git(w.a, "commit", "-qm", "Base codebase");

    write(path.join(w.a, "src/app.ts"), nextApp);
    w.git(w.a, "rm", "-q", "src/removed.ts");

    const result = w.command(
      [
        "python3",
        path.join(ROOT, "tests/review-live-pty.py"),
        w.a,
        process.execPath,
        path.join(ROOT, "dist/cli.js"),
        w.repo,
        w.state,
        path.join(w.root, "worktrees/example"),
        "tree-and-file",
      ],
      { timeoutMs: 90000 },
    );
    assert.match(result.stdout, /PTY: tree-and-file.*passed/);
  },
);

test("symbol extraction and definition ranking prioritize imported declarations, local variables, and skip keywords", () => {
  assert.equal(
    symbols.symbolAtColumn("+const total = computeBonus(rate);", 18, true),
    "computeBonus",
  );
  assert.equal(
    symbols.symbolAtColumn("+computeBonus(1);", 1, true),
    "computeBonus",
  );
  assert.equal(symbols.symbolAtColumn("+const total = 1;", 3, true), undefined);
  assert.equal(symbols.symbolAtColumn("@@ -1,3 +1,3 @@", 4, true), undefined);

  const currentFileText = [
    'import { computeBonus } from "./helpers.js";',
    "const localRate = 10;",
    "export function run() {",
    "  return computeBonus(localRate);",
    "}",
  ].join("\n");

  const imported = symbols.rankDefinitions(
    [
      {
        path: "src/helpers.ts",
        line: 3,
        text: "export function computeBonus(n: number) {",
      },
      {
        path: "tests/helpers.test.ts",
        line: 5,
        text: "function computeBonus() {}",
      },
      {
        path: "src/app.ts",
        line: 4,
        text: "  return computeBonus(localRate);",
      },
    ],
    "computeBonus",
    {
      currentPath: "src/app.ts",
      currentLine: 4,
      currentFileText,
    },
  );
  assert.equal(imported.autoJump, true);
  assert.equal(imported.definitions[0].path, "src/helpers.ts");
  assert.equal(imported.definitions[0].line, 3);

  const local = symbols.rankDefinitions(
    [
      {
        path: "src/other.ts",
        line: 1,
        text: "const localRate = 99;",
      },
    ],
    "localRate",
    {
      currentPath: "src/app.ts",
      currentLine: 4,
      currentFileText,
    },
  );
  assert.equal(local.autoJump, true);
  assert.equal(local.definitions[0].path, "src/app.ts");
  assert.equal(local.definitions[0].line, 2);

  const ambiguous = symbols.rankDefinitions(
    [
      {
        path: "src/a.ts",
        line: 1,
        text: "export function duplicateHelper() {}",
      },
      {
        path: "src/b.ts",
        line: 1,
        text: "export function duplicateHelper() {}",
      },
    ],
    "duplicateHelper",
    { currentPath: "src/app.ts", currentLine: 4, currentFileText },
  );
  assert.equal(ambiguous.autoJump, false);
  assert.equal(ambiguous.definitions.length, 2);
});

test("LiveRepository.grep searches immutable trees and handles no-match cleanly", (t) => {
  const w = new Workspace(t);
  fs.mkdirSync(path.join(w.a, "src"), { recursive: true });
  write(path.join(w.a, "src/a.ts"), "export const magicToken = 123;\n");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-qm", "Add token");
  write(path.join(w.a, "src/b.ts"), "const x = magicToken + 1;\n");

  const repo = new engine.LiveRepository(w.a);
  const state = repo.refresh();
  const target = repo.comparison({ kind: "working" }, state).target;

  const found = repo.grep(target, "magicToken", { wholeWord: true });
  assert.equal(found.limited, false);
  assert.deepEqual(
    found.hits.map((h: any) => [h.path, h.line]),
    [
      ["src/a.ts", 1],
      ["src/b.ts", 1],
    ],
  );

  const empty = repo.grep(target, "definitelyMissingSymbol123");
  assert.deepEqual(empty.hits, []);
});

test(
  "real terminal Ctrl-click go-to-definition, Back navigation, symbol prompt and repository-wide search",
  { timeout: 120000 },
  (t) => {
    const w = new Workspace(t);
    fs.mkdirSync(path.join(w.a, "src"), { recursive: true });
    fs.mkdirSync(path.join(w.a, "docs"), { recursive: true });
    write(
      path.join(w.a, "src/helpers.ts"),
      [
        "export const version = 1;",
        "",
        "export function computeBonus(rate: number) {",
        "  return rate * 2;",
        "}",
      ].join("\n") + "\n",
    );
    write(
      path.join(w.a, "src/one.ts"),
      "export function duplicateHelper() {\n  return 1;\n}\n",
    );
    write(
      path.join(w.a, "src/two.ts"),
      "export function duplicateHelper() {\n  return 2;\n}\n",
    );
    write(
      path.join(w.a, "docs/notes.md"),
      "Notes with uniqueRepoNeedle inside unchanged docs.\n",
    );
    write(
      path.join(w.a, "src/app.ts"),
      [
        'import { computeBonus } from "./helpers.js";',
        "const localRate = 42;",
        ...Array.from({ length: 12 }, (_, i) => `const pad${i + 1} = ${i};`),
        "const total = 0;",
      ].join("\n") + "\n",
    );
    w.git(w.a, "add", ".");
    w.git(w.a, "commit", "-qm", "Base codebase");

    write(
      path.join(w.a, "src/app.ts"),
      [
        'import { computeBonus } from "./helpers.js";',
        "const localRate = 42;",
        ...Array.from({ length: 12 }, (_, i) => `const pad${i + 1} = ${i};`),
        "const total = computeBonus(localRate);",
        "const dup = duplicateHelper();",
      ].join("\n") + "\n",
    );

    const result = w.command(
      [
        "python3",
        path.join(ROOT, "tests/review-live-pty.py"),
        w.a,
        process.execPath,
        path.join(ROOT, "dist/cli.js"),
        w.repo,
        w.state,
        path.join(w.root, "worktrees/example"),
        "definition-and-search",
      ],
      { timeoutMs: 90000 },
    );
    assert.match(result.stdout, /PTY: definition-and-search.*passed/);
  },
);
