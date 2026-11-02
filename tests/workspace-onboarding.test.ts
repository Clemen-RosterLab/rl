import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Workspace, ROOT, readJson, write } from "./helpers.js";

test("opening an already checked-out origin branch adopts it into the picker and shell switching", (t) => {
  const w = new Workspace(t);
  const existing = path.join(w.root, "worker 2");
  const unrelated = path.join(w.root, "not adopted");
  w.git(w.repo, "worktree", "add", "-qb", "test", existing);
  w.git(w.repo, "worktree", "add", "-qb", "unrelated", unrelated);
  w.git(w.repo, "update-ref", "refs/remotes/origin/test", "test");
  const capture = path.join(w.root, "picker.json");
  w.env.PICKER_CAPTURE = capture;
  w.stub(
    "fzf",
    `const fs=require('node:fs');const rows=fs.readFileSync(0,'utf8').trimEnd().split('\\n');fs.writeFileSync(process.env.PICKER_CAPTURE,JSON.stringify(rows));const selected=rows.find(row=>row.startsWith('worker 2\\t'));if(selected) console.log(selected);else process.exit(130);`,
  );
  w.rl(["repo", "add", ".", "--base", "origin/test"], { cwd: w.repo });
  w.rl([], { cwd: w.repo });
  assert.ok(
    !readJson(capture).some((row: string) => row.startsWith("worker 2\t")),
  );
  assert.equal(
    w
      .rl(["switch", "origin/test", "--no-fetch"], { cwd: w.repo })
      .stdout.trim(),
    existing,
  );
  assert.equal(w.rl([], { cwd: w.repo }).stdout.trim(), existing);
  assert.ok(
    readJson(capture).some((row: string) => row.startsWith("worker 2\t")),
  );
  assert.ok(
    !readJson(capture).some((row: string) => row.startsWith("not adopted\t")),
  );
  assert.equal(
    w.rl(["path", "worker 2"], { cwd: w.repo }).stdout.trim(),
    existing,
  );
  assert.equal(
    w.rl(["switch", "worker 2"], { cwd: w.repo }).stdout.trim(),
    existing,
  );
  w.env.RL_SHELL_FILE = path.join(ROOT, "shell/rl.zsh");
  w.env.EXPECTED_WORKTREE = existing;
  w.command(
    [
      "zsh",
      "-f",
      "-c",
      'source "$RL_SHELL_FILE"; rl switch origin/test --no-fetch; [[ "$PWD" == "$EXPECTED_WORKTREE" ]] || exit 90; rl; [[ "$PWD" == "$EXPECTED_WORKTREE" ]] || exit 91',
    ],
    { cwd: w.repo },
  );
  w.rl(["delete", "--dry-run", "worker 2"], { cwd: w.repo, ok: false });
  assert.ok(fs.existsSync(existing) && fs.existsSync(unrelated));
});

test("outside worktrees with duplicate names have distinct picker identities", (t) => {
  const w = new Workspace(t);
  const managed = w.managed("same");
  const outside = path.join(w.root, "same");
  w.git(w.repo, "worktree", "add", "-qb", "outside", outside);
  w.rl(["setup", "adopt"], { cwd: outside });
  assert.equal(w.rl(["path", "same"]).stdout.trim(), managed);
  assert.equal(w.rl(["path", outside]).stdout.trim(), outside);
  assert.equal(w.rl(["path", "outside"]).stdout.trim(), outside);
});

test("missing repository directories report path guidance instead of a misleading missing git error", (t) => {
  const w = new Workspace(t);
  for (const target of ["missing-repository", "not-a-directory"]) {
    if (target === "not-a-directory") write(path.join(w.a, target), "file");
    const failed = w.rl(["repo", "add", target], { cwd: w.a, ok: false });
    assert.match(failed.stderr, /Repository directory does not exist/);
    assert.match(failed.stderr, /rl repo add \./);
    assert.match(failed.stderr, /--alias/);
    assert.doesNotMatch(failed.stderr, /spawnSync|ENOENT/);
  }
  w.rl(["repo", "add", ".", "--alias", "example"], { cwd: w.a });
  assert.equal(
    JSON.parse(w.rl(["repo", "list", "--json"]).stdout).repositories.example
      .root,
    w.repo,
  );
});
