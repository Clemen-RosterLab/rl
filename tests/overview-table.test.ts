import test from "node:test";
import assert from "node:assert/strict";
import { formatOverviewTable } from "../dist/overview-table.js";
import type { OverviewRow } from "../dist/repos.js";
import { displayWidth } from "../dist/tui/ansi.js";
import { Workspace, write } from "./helpers.js";

const longBranch = "feature/" + "long-branch-name-".repeat(10);
function row(id = longBranch): OverviewRow {
  return {
    id,
    key: null,
    repository: "/example",
    repositoryName: "example",
    branch: id,
    status: "active",
    worktree: "/example/worktree",
    pr: null,
    gitStatus: {
      availability: "ok",
      branch: id,
      expectedBranch: id,
      head: "a".repeat(40),
      upstream: `origin/${id}`,
      ahead: 44,
      behind: 2,
      staged: 1,
      unstaged: 2,
      untracked: 1,
      conflicts: 0,
      dirty: true,
      branchChanged: false,
    },
  };
}

test("default list groups repositories and keeps long workspace names in a compact grid", () => {
  const rows = [row(), row("short")];
  for (const width of [70, 80, 100, 120, 160, 300]) {
    const text = formatOverviewTable(rows, { width, color: false });
    const lines = text.split("\n");
    assert.ok(lines.every((line) => displayWidth(line) <= width));
    assert.equal(lines.filter((line) => line.includes("example ·")).length, 1);
    assert.match(text, /WORKSPACE\s+CHANGES\s+SYNC/);
    assert.doesNotMatch(
      text,
      /UPSTREAM|CODEX|CLAUDE|SESSIONS|REPOSITORY|INSTANCE/,
    );
    const entries = lines.filter((line) => line.includes("↑44 ↓2"));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].indexOf("↑44 ↓2"), entries[1].indexOf("↑44 ↓2"));
    assert.match(entries[0], /…/);
    assert.match(entries[0], /1S\/2M\/1\?/);
    assert.ok(lines.length <= 9);
  }
  assert.equal(rows[0].id, longBranch);
});

test("narrow terminals use two lines per workspace, without a wall of labelled fields", () => {
  for (const width of [1, 5, 20, 40, 60]) {
    const text = formatOverviewTable([row(), row("short")], {
      width,
      color: false,
    });
    assert.ok(text.split("\n").every((line) => displayWidth(line) <= width));
    assert.doesNotMatch(text, /WORKTREE|UPSTREAM|COMMITS|CODEX|CLAUDE/);
    assert.ok(text.split("\n").length <= 14);
    if (width >= 40) assert.match(text, /1S\/2M\/1\? · ↑44 ↓2/);
  }
});

test("Unicode and terminal controls cannot break alignment or escape the list", () => {
  const rows = [row("fix/界面/👨‍👩‍👧‍👦/e\u0301/".repeat(12)), row("short")];
  rows.forEach((r) => (r.repositoryName = "bad\n\x1b[2Jname"));
  const text = formatOverviewTable(rows, { width: 80, color: false });
  const lines = text.split("\n");
  assert.ok(lines.every((line) => displayWidth(line) <= 80));
  assert.doesNotMatch(text, /[\x1b\r]/);
  const entries = lines.filter((line) => line.includes("↑44 ↓2"));
  assert.equal(
    displayWidth(entries[0].split("1S/")[0]),
    displayWidth(entries[1].split("1S/")[0]),
  );
});

test("PR and saved session columns appear only when relevant, and JSON data is not mutated", () => {
  const first = row("review-me");
  first.pr = {
    number: 42,
    state: "OPEN",
    isDraft: true,
    title: "Review me",
    url: "https://github.com/example/repo/pull/42",
    headRefName: "review-me",
    baseRefName: "main",
    updatedAt: "2026-01-01",
    syncedAt: "2026-01-01",
  };
  first.sessions = { codex: [], claude: [] };
  // Use a real saved-session fixture shape without claiming these are active agents.
  const rows = [first, row("other")];
  const before = JSON.stringify(rows);
  const text = formatOverviewTable(rows, { width: 110, color: true });
  assert.match(text, /PR/);
  assert.match(text, /#42 draft/);
  assert.doesNotMatch(text, /SESSIONS/);
  assert.match(text, /\x1b\[/);
  assert.ok(text.split("\n").every((line) => displayWidth(line) <= 110));
  assert.equal(JSON.stringify(rows), before);
  assert.equal(
    formatOverviewTable([], { width: 80, color: false }),
    "No RL workspaces found.",
  );
});

test("missing worktrees, branch changes and tasks remain explicit", () => {
  const input = row("switched-workspace");
  input.gitStatus.branchChanged = true;
  input.gitStatus.branch = "switched";
  input.gitStatus.availability = "missing";
  input.gitStatus.dirty = null;
  input.status = "deleted";
  const text = formatOverviewTable([input], { width: 80, color: false });
  assert.match(text, /missing/);
  assert.match(text, /↳ deleted/);
  assert.match(text, /\[changed\] switched/);
  assert.doesNotMatch(text, /↑44|clean/);
});

test("plain rl list uses the automatic layout and JSON retains every field", (t) => {
  const w = new Workspace(t);
  w.env.NO_COLOR = "1";
  w.env.COLUMNS = "80";
  // Settings suggested by the previous preview must not break the new default.
  write(w.config, 'listColumns = "instance,changes"\n');
  w.env.RL_LIST_COLUMNS = "pr,instance";
  let output = w.rl(["list"], { cwd: w.a }).stdout;
  assert.match(output, /example · 2 workspaces/);
  assert.match(output, /WORKSPACE\s+CHANGES\s+SYNC/);
  assert.doesNotMatch(output, /INSTANCE|UPSTREAM|CODEX|CLAUDE/);
  assert.ok(output.split("\n").every((line) => displayWidth(line) <= 80));
  w.env.COLUMNS = "40";
  output = w.rl(["list"], { cwd: w.a }).stdout;
  assert.match(output, /feature\/a/);
  assert.doesNotMatch(output, /WORKSPACE/);
  assert.ok(output.split("\n").every((line) => displayWidth(line) <= 40));
  const json = JSON.parse(w.rl(["list", "--json"], { cwd: w.a }).stdout);
  assert.ok(
    json.instances.every(
      (entry: OverviewRow) => entry.branch && entry.gitStatus && entry.worktree,
    ),
  );
  assert.doesNotMatch(w.rl(["list", "--help"]).stdout, /--columns|listColumns/);
});
