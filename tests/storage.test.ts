import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, read, readJson, write } from "./helpers.js";

function configure(workspace: string, clean: unknown): void {
  fs.mkdirSync(path.join(workspace, ".rl"), { recursive: true });
  write(path.join(workspace, ".rl/workflows.json"), JSON.stringify({ clean }));
}
function generated(workspace: string, name: string, bytes = 8192): string {
  const target = path.join(workspace, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(bytes, "a"));
  return target;
}
function ignored(workspace: string): void {
  write(
    path.join(workspace, ".gitignore"),
    "node_modules/\n.next/\n.cache/\n.env\n",
  );
}
function record(w: Workspace): string {
  return path.join(w.status().stateDirectory, "instance.json");
}

test("storage measures only the current workspace without following links or updating task state", (t) => {
  const w = new Workspace(t);
  ignored(w.a);
  configure(w.a, ["node_modules", ".next"]);
  generated(w.a, "node_modules/pkg/index.js", 32768);
  generated(w.a, ".next/output", 16384);
  generated(w.a, "src/app.ts", 8192);
  const neighbor = generated(w.b, "huge/neighbor", 1024 * 1024);
  fs.symlinkSync(path.dirname(neighbor), path.join(w.a, "neighbor-link"));
  const file = record(w);
  const data = readJson(file);
  data.createdAt = data.lastAccessedAt = "2000-01-01T00:00:00Z";
  data.pr = { url: "https://github.com/example/repo/pull/42", state: "MERGED" };
  write(file, JSON.stringify(data));
  const before = read(file);
  const report = JSON.parse(
    w.rl(["storage", "--json"], { cwd: path.join(w.a, "src") }).stdout,
  );
  assert.equal(report.workspace.path, w.a);
  assert.equal(report.workspace.branch, "feature/a");
  assert.ok(report.usage.dependenciesBytes > 0);
  assert.ok(report.usage.buildsBytes > 0);
  assert.ok(report.usage.otherBytes > 0);
  assert.ok(report.usage.logicalBytes < 1024 * 1024);
  assert.equal(report.usage.symlinks, 1);
  assert.ok(report.clean.estimatedBytes > 0);
  assert.deepEqual(
    new Set(report.clean.paths),
    new Set(["node_modules", ".next"]),
  );
  assert.match(report.suggestions.join("\n"), /at least 14 days/);
  assert.match(report.suggestions.join("\n"), /cached PR is merged/);
  assert.ok(
    report.usage.largestPaths[0].allocatedBytes >=
      report.usage.largestPaths.at(-1).allocatedBytes,
  );
  assert.ok(!JSON.stringify(report).includes(w.b));
  const human = w.rl(["storage"], { cwd: w.a }).stdout;
  assert.match(human, /Dependencies:/);
  assert.match(human, /Largest paths:/);
  assert.equal(read(file), before);
  assert.equal(fs.statSync(neighbor).size, 1024 * 1024);
});

test("cleanup previews and removes only configured generated directories while preserving dirty code, credentials and sessions", (t) => {
  const w = new Workspace(t);
  ignored(w.a);
  configure(w.a, ["node_modules", "node_modules/cache", ".next"]);
  generated(w.a, "node_modules/pkg/index.js");
  generated(w.a, ".next/output");
  const neighbor = generated(w.b, "node_modules/pkg/index.js");
  fs.symlinkSync(
    path.dirname(neighbor),
    path.join(w.a, "node_modules/external"),
  );
  write(path.join(w.a, ".env"), "secret=keep");
  write(path.join(w.a, "source.ts"), "unfinished work");
  const sid = randomUUID();
  w.hook("codex", sid);
  w.rl(
    [
      "pause",
      "--session",
      sid,
      "--summary",
      "Task",
      "--changes",
      "WIP",
      "--validation",
      "Not run",
      "--next",
      "Continue",
    ],
    { cwd: w.a },
  );
  const file = record(w);
  const before = read(file);
  const head = w.git(w.a, "rev-parse", "HEAD");
  const dirty = w.git(w.a, "status", "--porcelain");
  const preview = JSON.parse(
    w.rl(["clean", "--dry-run", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(preview.dryRun, true);
  assert.equal(preview.workspace.path, w.a);
  assert.equal(preview.paths.length, 2);
  assert.deepEqual(preview.removedPaths, []);
  assert.ok(fs.existsSync(path.join(w.a, "node_modules/pkg/index.js")));
  assert.equal(read(file), before);
  const cleaned = JSON.parse(w.rl(["clean", "--json"], { cwd: w.a }).stdout);
  assert.equal(cleaned.dryRun, false);
  assert.equal(cleaned.removedPaths.length, 2);
  assert.ok(!fs.existsSync(path.join(w.a, "node_modules")));
  assert.ok(!fs.existsSync(path.join(w.a, ".next")));
  assert.equal(read(path.join(w.a, ".env")), "secret=keep");
  assert.equal(read(path.join(w.a, "source.ts")), "unfinished work");
  assert.ok(fs.existsSync(path.join(w.a, ".codex/hooks.json")));
  assert.ok(fs.existsSync(neighbor));
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), head);
  assert.equal(w.git(w.a, "status", "--porcelain"), dirty);
  assert.equal(read(file), before);
  assert.ok(!fs.readdirSync(w.a).some((name) => name.startsWith(".rl-clean-")));
});

test("storage and clean reject workspace selectors, wrong repository routing and switched instances", (t) => {
  const w = new Workspace(t);
  ignored(w.a);
  configure(w.a, ["node_modules"]);
  const target = generated(w.a, "node_modules/keep");
  for (const command of ["storage", "clean"]) {
    for (const args of [[w.b], ["--workspace", w.b], ["--all"], ["--force"]])
      w.rl([command, ...args], { cwd: w.a, ok: false });
  }
  const other = path.join(w.root, "another-repo");
  w.command(["git", "init", "-q", "-b", "main", other]);
  w.git(other, "commit", "-q", "--allow-empty", "-m", "Initial");
  w.rl(["repo", "add", "current", w.repo]);
  w.rl(["repo", "add", "other", other]);
  for (const command of ["storage", "clean"])
    assert.match(
      w.rl(["--repo", "other", command], { cwd: w.a, ok: false }).stderr,
      /does not belong/,
    );
  const file = record(w);
  const before = read(file);
  w.git(w.a, "checkout", "-qb", "switched");
  for (const command of ["storage", "clean"])
    assert.match(
      w.rl([command], { cwd: w.a, ok: false }).stderr,
      /Instance owns branch/,
    );
  assert.equal(read(file), before);
  assert.ok(fs.existsSync(target));
});

test("cleanup validates the entire plan before removing anything and refuses tracked files and unsafe config", (t) => {
  const w = new Workspace(t);
  ignored(w.a);
  const keep = generated(w.a, "node_modules/keep");
  const tracked = generated(w.a, ".next/tracked");
  w.git(w.a, "add", "-f", ".next/tracked");
  configure(w.a, ["node_modules", ".next"]);
  assert.match(
    w.rl(["clean"], { cwd: w.a, ok: false }).stderr,
    /tracked files/,
  );
  assert.ok(fs.existsSync(keep) && fs.existsSync(tracked));
  for (const clean of [
    ["../escape"],
    [w.b],
    [".env"],
    [".codex"],
    [".rl"],
    [".cache/*"],
    ["node_modules", 1],
    "node_modules",
  ]) {
    configure(w.a, clean);
    w.rl(["clean"], { cwd: w.a, ok: false });
    assert.ok(fs.existsSync(keep));
  }
});

test("cleanup rejects credential-containing directories, nested Git repositories and symlink targets", (t) => {
  const w = new Workspace(t);
  ignored(w.a);
  configure(w.a, ["node_modules", ".cache"]);
  const keep = generated(w.a, "node_modules/keep");
  const credential = generated(w.a, ".cache/.env.local");
  assert.match(
    w.rl(["clean"], { cwd: w.a, ok: false }).stderr,
    /protected metadata or credentials/,
  );
  assert.ok(fs.existsSync(keep) && fs.existsSync(credential));
  fs.unlinkSync(credential);
  fs.mkdirSync(path.join(w.a, ".cache/nested/.git"), { recursive: true });
  assert.match(
    w.rl(["clean"], { cwd: w.a, ok: false }).stderr,
    /protected metadata or credentials/,
  );
  fs.rmSync(path.join(w.a, ".cache"), { recursive: true });
  const neighbor = generated(w.b, "cache/keep");
  fs.symlinkSync(path.dirname(neighbor), path.join(w.a, ".cache"));
  assert.match(w.rl(["clean"], { cwd: w.a, ok: false }).stderr, /symlinks/);
  assert.ok(fs.existsSync(keep) && fs.existsSync(neighbor));
  const report = JSON.parse(w.rl(["storage", "--json"], { cwd: w.a }).stdout);
  assert.match(report.clean.error, /symlinks/);
  assert.equal(report.clean.estimatedBytes, 0);
});

test("cleanup estimates account for hard links retained outside its configured targets", (t) => {
  const w = new Workspace(t);
  ignored(w.a);
  configure(w.a, ["node_modules"]);
  const local = generated(w.a, "node_modules/a", 1024 * 1024);
  fs.linkSync(local, path.join(w.a, "node_modules/b"));
  const neighbor = path.join(w.b, "shared-content");
  fs.linkSync(local, neighbor);
  const report = JSON.parse(w.rl(["storage", "--json"], { cwd: w.a }).stdout);
  assert.ok(report.clean.estimatedBytes < fs.statSync(local).blocks * 512);
  assert.ok(
    report.usage.dependenciesBytes < 2 * fs.statSync(local).blocks * 512,
  );
  w.rl(["clean"], { cwd: w.a });
  assert.equal(fs.statSync(neighbor).size, 1024 * 1024);
  assert.ok(!fs.existsSync(path.join(w.a, "node_modules")));
});

test("cleanup requires configuration, ignored directories, and a working directory outside its targets", (t) => {
  const w = new Workspace(t);
  ignored(w.a);
  const keep = generated(w.a, "node_modules/pkg/keep");
  assert.match(w.rl(["clean"], { cwd: w.a }).stdout, /Configure "clean"/);
  assert.ok(fs.existsSync(keep));
  configure(w.a, ["node_modules"]);
  assert.match(
    w.rl(["clean"], { cwd: path.dirname(keep), ok: false }).stderr,
    /current directory/,
  );
  write(path.join(w.a, ".gitignore"), "");
  assert.match(
    w.rl(["clean"], { cwd: w.a, ok: false }).stderr,
    /must be ignored/,
  );
  ignored(w.a);
  const marker = w.git(
    w.a,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "MERGE_HEAD",
  );
  write(marker, w.git(w.a, "rev-parse", "HEAD"));
  assert.match(
    w.rl(["clean"], { cwd: w.a, ok: false }).stderr,
    /operation is already in progress/,
  );
  assert.ok(fs.existsSync(keep));
});

test("cleanup restores staged artifacts when protected files appear after its initial inspection", (t) => {
  const w = new Workspace(t);
  ignored(w.a);
  configure(w.a, ["node_modules", ".next"]);
  const dependency = generated(w.a, "node_modules/keep");
  const output = generated(w.a, ".next/keep");
  const realGit = w.command(["which", "git"]).stdout.trim();
  const marker = path.join(w.root, "inspection-count");
  w.env.CLEAN_REAL_GIT = realGit;
  w.env.CLEAN_INSPECTION_COUNT = marker;
  w.env.CLEAN_CREDENTIAL = path.join(w.a, ".next/.env.local");
  w.stub(
    "git",
    `const fs=require('node:fs'); const args=process.argv.slice(2); if(args.includes('--cached')&&args.at(-1)==='.next'){const count=fs.existsSync(process.env.CLEAN_INSPECTION_COUNT)?Number(fs.readFileSync(process.env.CLEAN_INSPECTION_COUNT,'utf8'))+1:1;fs.writeFileSync(process.env.CLEAN_INSPECTION_COUNT,String(count));if(count===2)fs.writeFileSync(process.env.CLEAN_CREDENTIAL,'keep this credential');}const result=require('node:child_process').spawnSync(process.env.CLEAN_REAL_GIT,args,{stdio:'inherit'});process.exit(result.status??1);`,
  );
  const failed = w.rl(["clean"], { cwd: w.a, ok: false });
  assert.match(failed.stderr, /protected metadata or credentials/);
  assert.ok(fs.existsSync(dependency) && fs.existsSync(output));
  assert.equal(
    read(path.join(w.a, ".next/.env.local")),
    "keep this credential",
  );
  assert.ok(!fs.readdirSync(w.a).some((name) => name.startsWith(".rl-clean-")));
});

test("cleanup never follows a replaced staging directory during removal or rollback", (t) => {
  const w = new Workspace(t);
  ignored(w.a);
  configure(w.a, ["node_modules", ".next"]);
  generated(w.a, "node_modules/keep");
  generated(w.a, ".next/keep");
  const neighbor = generated(w.b, "0/keep", 128);
  const realGit = w.command(["which", "git"]).stdout.trim();
  w.env.CLEAN_REAL_GIT = realGit;
  w.env.CLEAN_COUNT = path.join(w.root, "staging-count");
  w.env.CLEAN_NEIGHBOR = w.b;
  w.stub(
    "git",
    `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);if(args.includes('--cached')&&args.at(-1)==='.next'){const count=fs.existsSync(process.env.CLEAN_COUNT)?Number(fs.readFileSync(process.env.CLEAN_COUNT,'utf8'))+1:1;fs.writeFileSync(process.env.CLEAN_COUNT,String(count));if(count===3){const holding=fs.readdirSync(process.cwd()).find(name=>name.startsWith('.rl-clean-'));if(holding){fs.renameSync(holding,'retained-staging');fs.symlinkSync(process.env.CLEAN_NEIGHBOR,holding);}}}const result=require('node:child_process').spawnSync(process.env.CLEAN_REAL_GIT,args,{stdio:'inherit'});process.exit(result.status??1);`,
  );
  const failed = w.rl(["clean"], { cwd: w.a, ok: false });
  assert.match(failed.stderr, /staging directory changed|Staging path changed/);
  assert.ok(fs.existsSync(neighbor));
  assert.equal(fs.statSync(neighbor).size, 128);
  assert.ok(fs.existsSync(path.join(w.a, "retained-staging/0/keep")));
  assert.ok(fs.existsSync(path.join(w.a, "retained-staging/1/keep")));
});
