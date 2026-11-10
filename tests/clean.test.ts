import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, read, readJson, write } from "./helpers.js";

function generated(root: string, relative = "node_modules/pkg/index.js") {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  write(file, "generated content");
  return file;
}
function ignore(root: string) {
  write(
    path.join(root, ".gitignore"),
    "node_modules/\n.next/\n.cache/\ndist/\n.venv/\ngenerated/\n",
  );
}
function configure(root: string, clean: unknown) {
  fs.mkdirSync(path.join(root, ".rl"), { recursive: true });
  write(path.join(root, ".rl/workflows.json"), JSON.stringify({ clean }));
}
function run(w: Workspace, argv: string[] = [], ok = true, cwd = w.repo) {
  return JSON.parse(w.rl(["clean", ...argv, "--json"], { cwd, ok }).stdout);
}

test("the multi-select clean picker removes selected dependencies and caches while preserving source, notes and sessions", (t) => {
  const w = new Workspace(t);
  const [one, two, three] = ["one", "feature/two", "three"].map((name) =>
    w.managed(name),
  );
  for (const root of [one, two, three]) {
    ignore(root);
    generated(root);
    generated(root, ".next/output");
  }
  write(path.join(one, "source.ts"), "unfinished source");
  const sid = randomUUID();
  w.rl(["agent", "save", "claude", sid], { cwd: one });
  w.rl(["notes", "append", "progress", "-"], {
    cwd: one,
    input: "Preserve task progress",
  });
  const stateDirectory = w.status(one).stateDirectory;
  const record = read(path.join(stateDirectory, "instance.json"));
  const notes = read(path.join(stateDirectory, "progress.md"));
  const head = w.git(one, "rev-parse", "HEAD"),
    dirty = w.git(one, "status", "--porcelain");
  w.env.CLEAN_PICK_CAPTURE = path.join(w.root, "picker.json");
  w.stub(
    "fzf",
    `const fs=require('node:fs'); const input=fs.readFileSync(0,'utf8'); fs.writeFileSync(process.env.CLEAN_PICK_CAPTURE,JSON.stringify({input,args:process.argv.slice(2)})); const selected=input.trimEnd().split('\\n').filter(row=>row.startsWith('one\\t')||row.startsWith('feature/two\\t')); console.log([...selected,selected[0]].join('\\n'));`,
  );
  const report = run(w);
  assert.equal(report.summary.cleaned, 2);
  const picker = readJson(w.env.CLEAN_PICK_CAPTURE);
  assert.ok(picker.args.includes("--multi"));
  assert.ok(picker.args.includes("--prompt=Clean › "));
  assert.ok(picker.args.some((arg: string) => arg.includes("Enter clean")));
  assert.ok(!picker.args.some((arg: string) => arg.includes("Enter delete")));
  for (const root of [one, two]) {
    assert.ok(fs.existsSync(root));
    assert.ok(!fs.existsSync(path.join(root, "node_modules")));
    assert.ok(!fs.existsSync(path.join(root, ".next")));
  }
  assert.ok(fs.existsSync(path.join(three, "node_modules")));
  assert.equal(read(path.join(one, "source.ts")), "unfinished source");
  assert.equal(w.git(one, "rev-parse", "HEAD"), head);
  assert.equal(w.git(one, "status", "--porcelain"), dirty);
  assert.equal(read(path.join(stateDirectory, "instance.json")), record);
  assert.equal(read(path.join(stateDirectory, "progress.md")), notes);
  assert.ok(fs.existsSync(path.join(one, ".codex/hooks.json")));
});

test("--all covers managed and adopted worktrees only, and a dry run leaves files and saved state unchanged", (t) => {
  const w = new Workspace(t);
  const managed = w.managed("one");
  const legacy = path.join(w.root, "worktrees/example/legacy");
  const outside = path.join(w.root, "unadopted");
  w.git(w.repo, "worktree", "add", "-qb", "legacy", legacy);
  w.git(w.repo, "worktree", "add", "-qb", "outside", outside);
  const included = [w.a, w.b, managed, legacy];
  for (const root of [...included, outside, w.repo]) {
    ignore(root);
    generated(root);
  }
  w.stub("fzf", "process.exit(90)");
  const recordFile = path.join(w.status(w.a).stateDirectory, "instance.json");
  const before = read(recordFile);
  const preview = run(w, ["--all", "--dry-run"]);
  assert.equal(preview.summary.selected, 4);
  assert.equal(preview.summary["would-clean"], 4);
  assert.ok(preview.summary.estimatedBytes > 0);
  assert.equal(read(recordFile), before);
  assert.ok(!fs.existsSync(path.join(legacy, ".codex")));
  for (const root of included)
    assert.ok(fs.existsSync(path.join(root, "node_modules")));
  const cleaned = run(w, ["--all"]);
  assert.equal(cleaned.summary.cleaned, 4);
  for (const root of included)
    assert.ok(!fs.existsSync(path.join(root, "node_modules")));
  assert.ok(fs.existsSync(path.join(outside, "node_modules")));
  assert.ok(fs.existsSync(path.join(w.repo, "node_modules")));
  assert.equal(read(recordFile), before);
  assert.ok(!fs.existsSync(path.join(legacy, ".codex")));
});

test("explicit clean configuration overrides defaults, including an empty list to disable cleanup", (t) => {
  const w = new Workspace(t);
  const one = w.managed("one"),
    two = w.managed("two");
  for (const root of [one, two]) {
    ignore(root);
    generated(root);
    generated(root, ".next/output");
  }
  configure(one, ["generated"]);
  configure(two, []);
  generated(one, "generated/output");
  const report = run(w, ["one", "two"]);
  assert.equal(report.summary.cleaned, 1);
  assert.equal(report.summary.unchanged, 1);
  assert.ok(!fs.existsSync(path.join(one, "generated")));
  for (const root of [one, two]) {
    assert.ok(fs.existsSync(path.join(root, "node_modules")));
    assert.ok(fs.existsSync(path.join(root, ".next")));
  }
  configure(one, null);
  assert.equal(run(w, ["one"], false).summary.failed, 1);
  assert.ok(fs.existsSync(path.join(one, "node_modules")));
});

test("unsafe, locked, missing and busy worktrees are reported while safe targets still clean", (t) => {
  const w = new Workspace(t);
  const safe = w.managed("safe"),
    unsafe = w.managed("unsafe"),
    locked = w.managed("locked"),
    busy = w.managed("busy"),
    missing = w.managed("missing");
  for (const root of [safe, unsafe, locked, busy, missing]) {
    ignore(root);
    generated(root);
  }
  const credential = generated(unsafe, ".cache/.env.local");
  w.git(w.repo, "worktree", "lock", locked);
  const marker = w.git(busy, "rev-parse", "--git-path", "CHERRY_PICK_HEAD");
  write(marker, w.git(busy, "rev-parse", "HEAD"));
  fs.rmSync(missing, { recursive: true });
  const report = run(w, ["safe", "unsafe", "locked", "busy", "missing"], false);
  assert.equal(report.summary.cleaned, 1);
  assert.equal(report.summary.failed, 3);
  assert.equal(report.summary.skipped, 1);
  assert.ok(!fs.existsSync(path.join(safe, "node_modules")));
  for (const root of [unsafe, locked, busy])
    assert.ok(fs.existsSync(path.join(root, "node_modules")));
  assert.ok(fs.existsSync(credential));
  assert.ok(fs.existsSync(marker));
  assert.match(
    report.results.find((row: { name: string }) => row.name === "unsafe")
      .detail,
    /protected metadata or credentials/,
  );
});

test("defaults skip non-ignored build folders and never remove tracked output or follow symlink targets", (t) => {
  const w = new Workspace(t),
    one = w.managed("one");
  ignore(one);
  generated(one);
  const source = generated(one, "build/user-data.txt");
  run(w, ["one"]);
  assert.ok(fs.existsSync(source));
  assert.ok(!fs.existsSync(path.join(one, "node_modules")));
  generated(one);
  const tracked = generated(one, "dist/tracked.txt");
  w.git(one, "add", "-f", "dist/tracked.txt");
  assert.equal(run(w, ["one"], false).summary.failed, 1);
  assert.ok(fs.existsSync(tracked));
  assert.ok(fs.existsSync(path.join(one, "node_modules")));
  w.git(one, "reset", "-q", "--", "dist/tracked.txt");
  fs.rmSync(path.join(one, "dist"), { recursive: true });
  const external = generated(w.b, "shared/keep");
  fs.symlinkSync(path.dirname(external), path.join(one, ".cache"));
  assert.equal(run(w, ["one"]).summary.cleaned, 1);
  assert.ok(fs.existsSync(external));
  assert.ok(fs.lstatSync(path.join(one, ".cache")).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(one, "node_modules")));
});

test("selection validates names before mutation, cancellation is harmless, and cleanup cannot remove the caller's directory", (t) => {
  const w = new Workspace(t),
    one = w.managed("one");
  ignore(one);
  const file = generated(one);
  for (const args of [
    ["--all", "one"],
    ["one", "missing"],
    ["--force", "one"],
    ["@"],
  ])
    w.rl(["clean", ...args], { cwd: w.repo, ok: false });
  w.stub("fzf", "process.exit(130)");
  assert.equal(run(w).summary.selected, 0);
  assert.ok(fs.existsSync(file));
  const prevented = run(w, ["one"], false, path.dirname(file));
  assert.match(prevented.results[0].detail, /current directory/);
  assert.ok(fs.existsSync(file));
  const output = w.rl(["clean", "one", "--dry-run"], { cwd: w.repo }).stdout;
  assert.match(output, /Cleanup preview/);
  assert.match(output, /node_modules/);
  assert.match(output, /1 would clean/);
  w.env.RL_CONFIG = path.join(w.root, "missing-config");
  assert.match(w.rl(["clean", "--help"]).stdout, /Usage: rl clean/);
});

test("explicit repository selection scopes --all without touching another registered repository", (t) => {
  const w = new Workspace(t),
    other = path.join(w.root, "other");
  w.command(["git", "init", "-q", "-b", "test", other]);
  w.git(other, "commit", "-qm", "Initial", "--allow-empty");
  w.rl(["repo", "add", w.repo, "--alias", "primary"]);
  w.rl(["repo", "add", other, "--alias", "other"]);
  const otherTree = w
    .rl(["--repo", "other", "switch", "other-task", "-c", "--no-fetch"], {
      cwd: other,
    })
    .stdout.trim();
  for (const root of [w.a, w.b, otherTree]) {
    ignore(root);
    generated(root);
  }
  const result = JSON.parse(
    w.rl(["--repo", "primary", "clean", "--all", "--json"], { cwd: otherTree })
      .stdout,
  );
  assert.equal(result.repository, w.repo);
  assert.equal(result.summary.cleaned, 2);
  assert.ok(fs.existsSync(path.join(otherTree, "node_modules")));
  assert.ok(!fs.existsSync(path.join(w.a, "node_modules")));
  assert.ok(!fs.existsSync(path.join(w.b, "node_modules")));
});
