import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Workspace, readJson, write } from "./helpers.js";
import type { OverviewRow } from "../dist/repos.js";

function outside(
  w: Workspace,
  directory = "existing checkout",
  branch = "existing/feature",
): string {
  const root = path.join(w.root, directory);
  w.git(w.repo, "worktree", "add", "-q", "-b", branch, root);
  return root;
}

function picker(w: Workspace): string {
  const file = path.join(w.root, "existing-picker.json");
  w.env.PICKER_CAPTURE = file;
  w.stub(
    "fzf",
    String.raw`
const fs = require('node:fs');
const rows = fs.readFileSync(0, 'utf8').trim().split('\n');
fs.writeFileSync(process.env.PICKER_CAPTURE, JSON.stringify(rows));
if (process.env.SWITCH_BEFORE_PICK) require('node:child_process').execFileSync('git', ['-C',process.env.SWITCH_BEFORE_PICK,'switch','-c','moved-during-picker']);
if (!process.env.SELECT_NAME) process.exit(130);
const row = rows.find(row => row.startsWith(process.env.SELECT_NAME+'\t'));
if (!row) throw new Error('Requested row missing');
console.log(row);
`,
  );
  return file;
}

function list(w: Workspace, include = false): OverviewRow[] {
  return JSON.parse(
    w.rl(["list", "--json", ...(include ? ["--include-existing"] : [])], {
      cwd: w.repo,
    }).stdout,
  ).instances;
}

test("existing worktrees appear by default with an initialization label; preview and cancellation do not adopt", (t) => {
  const w = new Workspace(t);
  const root = outside(w);
  write(path.join(root, "source.txt"), "keep this work\n");
  assert.equal(
    list(w).find((row) => row.worktree === root)!.status,
    "unregistered",
  );
  const found = list(w).find((row) => row.worktree === root)!;
  assert.equal(found.status, "unregistered");
  assert.equal(found.id, "existing/feature");
  assert.equal(found.gitStatus.untracked, 1);
  assert.ok(!fs.existsSync(path.join(root, ".codex")));
  const capture = picker(w);
  w.rl([]);
  assert.ok(
    readJson(capture).some(
      (row: string) =>
        row.startsWith("existing checkout\t") &&
        row.includes("not initialized"),
    ),
  );
  assert.match(w.rl(["list"], { cwd: w.repo }).stdout, /not initialized/);
  assert.deepEqual(list(w, true), list(w));
  assert.equal(
    list(w).find((row) => row.worktree === root)!.status,
    "unregistered",
  );
  assert.ok(!fs.existsSync(path.join(root, ".codex")));
  write(capture, "[]");
  w.rl(["delete"]);
  assert.ok(
    !readJson(capture).some((row: string) =>
      row.startsWith("existing checkout\t"),
    ),
  );
  assert.ok(fs.existsSync(root));
});

test("picking an existing worktree adopts that exact checkout without moving or changing its source", (t) => {
  const w = new Workspace(t);
  const root = outside(w);
  const other = outside(w, "leave alone", "other-existing");
  write(path.join(root, "source.txt"), "staged\n");
  w.git(root, "add", "source.txt");
  write(path.join(root, "source.txt"), "working\n");
  const head = w.git(root, "rev-parse", "HEAD");
  const staged = w.git(root, "diff", "--cached");
  const worktrees = w.git(w.repo, "worktree", "list", "--porcelain");
  const capture = picker(w);
  w.env.SELECT_NAME = "existing checkout";
  assert.equal(w.rl([]).stdout.trim(), root);
  assert.equal(w.git(root, "rev-parse", "HEAD"), head);
  assert.equal(w.git(root, "branch", "--show-current"), "existing/feature");
  assert.equal(w.git(root, "diff", "--cached"), staged);
  assert.equal(
    fs.readFileSync(path.join(root, "source.txt"), "utf8"),
    "working\n",
  );
  assert.equal(w.git(w.repo, "worktree", "list", "--porcelain"), worktrees);
  assert.equal(list(w).filter((row) => row.worktree === root).length, 1);
  assert.ok(!fs.existsSync(path.join(other, ".codex")));
  assert.equal(w.rl([]).stdout.trim(), root);
  assert.ok(
    !readJson(capture)
      .find((row: string) => row.startsWith("existing checkout\t"))
      .includes("not initialized"),
  );
  assert.equal(w.rl(["switch", "existing/feature"]).stdout.trim(), root);
});

test("adopt accepts relative paths, remains idempotent and rejects unrelated or detached checkouts", (t) => {
  const w = new Workspace(t);
  const root = outside(w);
  w.rl(["setup", "adopt", path.relative(w.repo, root)], { cwd: w.repo });
  const key = list(w).find((row) => row.worktree === root)!.key;
  w.rl(["setup", "adopt", root], { cwd: w.repo });
  assert.equal(list(w).find((row) => row.worktree === root)!.key, key);
  const unrelated = path.join(w.root, "unrelated");
  w.command(["git", "init", "-q", "-b", "main", unrelated]);
  w.git(unrelated, "commit", "--allow-empty", "-qm", "Initial");
  assert.match(
    w.rl(["setup", "adopt", unrelated], { cwd: w.repo, ok: false }).stderr,
    /does not belong/,
  );
  assert.ok(!fs.existsSync(path.join(unrelated, ".codex")));
  const detached = path.join(w.root, "detached");
  w.git(w.repo, "worktree", "add", "-q", "--detach", detached);
  assert.match(
    w.rl(["setup", "adopt", detached], { ok: false }).stderr,
    /checked-out branch/,
  );
  assert.ok(list(w, true).some((row) => row.worktree === detached));
  const capture = picker(w);
  w.rl([]);
  assert.ok(
    !readJson(capture).some((row: string) => row.startsWith("detached\t")),
  );
});

test("existing picker disambiguates names and rejects branch changes during selection", (t) => {
  const w = new Workspace(t);
  w.managed("collision");
  const root = outside(w, "collision", "outside-collision");
  const capture = picker(w);
  w.rl([]);
  const rows: string[] = readJson(capture);
  assert.ok(rows.some((row) => row.startsWith("collision\t")));
  assert.ok(rows.some((row) => row.startsWith(root + "\t")));
  w.env.SELECT_NAME = root;
  w.env.SWITCH_BEFORE_PICK = root;
  assert.match(
    w.rl([], { ok: false }).stderr,
    /branch changed during selection/,
  );
  assert.equal(
    list(w).find((row) => row.worktree === root)!.status,
    "unregistered",
  );
  assert.ok(!fs.existsSync(path.join(root, ".codex")));
});
