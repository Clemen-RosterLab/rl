import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, read, readJson, write } from "./helpers.js";

test("main help lists each command once with details reserved for command help", (t) => {
  const w = new Workspace(t);
  const output = w.rl(["help"]).stdout;
  const names = [...output.matchAll(/^  (\S+)\s{2,}/gm)].map(
    (match) => match[1],
  );
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, 19);
  assert.ok(output.split("\n").length < 40);
  assert.ok(!output.includes("--") && !output.includes("[--"));
  assert.ok(
    ["git", "notes", "storage", "agent", "setup"].every((name) =>
      names.includes(name),
    ),
  );
  assert.ok(
    [
      "step",
      "merge",
      "diff",
      "log",
      "context",
      "progress",
      "summary",
      "session",
      "handoff",
      "clean",
      "config",
      "init",
      "new",
      "open",
    ].every((name) => !names.includes(name)),
  );
});

test("help is specific and works without valid configuration or repository selection", (t) => {
  const w = new Workspace(t);
  const file = path.join(w.status().stateDirectory, "instance.json"),
    before = read(file);
  w.env.RL_CONFIG = path.join(w.root, "missing-config");
  for (const args of [
    ["help", "pr", "update"],
    ["pr", "update", "--help"],
    ["--repo", "missing", "help", "pr", "update"],
    ["--repo=missing", "pr", "update", "-h"],
  ]) {
    const output = w.rl(args).stdout;
    assert.match(output, /Usage: rl pr update/);
    assert.match(output, /--dry-run/);
    assert.doesNotMatch(output, /rl resume|rl doctor|rl adopt/);
  }
  const workflow = w.rl(["workflow"]).stdout;
  assert.match(workflow, /Commands:/);
  assert.match(workflow, /score\s+Rescore/);
  assert.doesNotMatch(workflow, /--provider|--policy|--base/);
  assert.match(w.rl(["workflow", "run", "--help"]).stdout, /--base/);
  assert.match(w.rl(["init", "--help"]).stdout, /rl setup shell/);
  assert.match(w.rl(["setup", "shell", "--help"]).stdout, /rl setup shell/);
  assert.equal(read(file), before);
  assert.ok(!fs.existsSync(w.log));
  const bad = w.rl(["help", "pr", "unknown"], { ok: false });
  assert.match(bad.stderr, /Unknown help topic/);
  assert.equal(bad.stdout, "");
});

test("invalid arguments print only the command's usage and options", (t) => {
  const w = new Workspace(t);
  const bad = w.rl(["pr", "update", "not-a-number"], { cwd: w.a, ok: false });
  assert.match(bad.stderr, /Expected positive PR numbers/);
  assert.match(bad.stderr, /Usage: rl pr update/);
  assert.match(bad.stderr, /--dry-run/);
  assert.doesNotMatch(bad.stderr, /rl resume|rl workflow run|rl doctor/);
  const missingFlag = w.rl(["workflow", "run", "--base"], {
    cwd: w.a,
    ok: false,
  });
  assert.match(missingFlag.stderr, /--prompt <text>/);
  assert.doesNotMatch(missingFlag.stderr, /rl resume/);
  const missing = w.rl(["git", "merge", "--squash"], { cwd: w.a, ok: false });
  assert.match(missing.stderr, /Missing --message/);
  assert.match(missing.stderr, /Usage: rl git merge/);
  const unknown = w.rl(["nonsense"], { cwd: w.a, ok: false });
  assert.equal(unknown.stdout, "");
  assert.ok(unknown.stderr.split("\n").length <= 4);
});

test("Git help exposes only merge and removed wrappers are rejected", (t) => {
  const w = new Workspace(t);
  const help = w.rl(["help", "git"]).stdout;
  assert.match(help, /merge\s+Integrate/);
  for (const command of ["diff", "log", "commit", "rebase", "squash"]) {
    assert.doesNotMatch(help, new RegExp(`^  ${command}\\s`, "m"));
    const removed = w.rl(["git", command], { cwd: w.a, ok: false });
    assert.match(removed.stderr, /Unknown git command/);
    w.rl(["help", "git", command], { ok: false });
  }
  for (const command of [
    ["diff"],
    ["log"],
    ["step", "commit"],
    ["step", "rebase"],
    ["step", "squash"],
  ])
    w.rl(command, { cwd: w.a, ok: false });
});

test("canonical merge, notes and agent commands preserve behavior", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "feature.txt"), "change");
  w.git(w.a, "add", "feature.txt");
  w.git(w.a, "commit", "-qm", "Feature");
  assert.match(
    w.rl(["git", "merge", "develop", "--dry-run"], { cwd: w.a }).stdout,
    /Would fast-forward merge/,
  );
  w.rl(["notes", "append", "progress", "-"], {
    cwd: w.a,
    input: "Saved milestone",
  });
  assert.equal(
    w.rl(["notes", "show", "progress"], { cwd: w.a }).stdout,
    w.rl(["progress", "show"], { cwd: w.a }).stdout,
  );
  assert.equal(
    w.rl(["notes", "show"], { cwd: w.a }).stdout,
    w.rl(["context", "show"], { cwd: w.a }).stdout,
  );
  assert.equal(
    w.rl(["notes", "path", "progress"], { cwd: w.a }).stdout,
    w.rl(["progress", "path"], { cwd: w.a }).stdout,
  );
  assert.match(
    w.rl(["notes", "summary", "--stdout"], { cwd: w.a }).stdout,
    /Saved milestone/,
  );
  const id = randomUUID();
  w.rl(["agent", "save", "claude", id], { cwd: w.a });
  assert.equal(
    JSON.parse(w.rl(["agent", "sessions", "claude"], { cwd: w.a }).stdout)[0]
      .id,
    id,
  );
  assert.match(
    w.rl(["agent", "handoff", "claude"], { cwd: w.a }).stdout,
    /Saved milestone/,
  );
  const mcp = w.rl(["agent", "mcp"], {
    cwd: w.a,
    input:
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "help-test", version: "1" },
        },
      }) + "\n",
  });
  assert.equal(
    JSON.parse(mcp.stdout.trim()).result.protocolVersion,
    "2025-11-25",
  );
  w.rl(["agent", "start", "claude", "--", "--help"], { cwd: w.a });
  assert.deepEqual(w.calls()[0].argv.slice(1), ["--help"]);
});

test("setup, cleanup and repository selectors work through the grouped commands", (t) => {
  const w = new Workspace(t);
  w.rl(["setup", "init"], { cwd: w.a });
  assert.deepEqual(
    JSON.parse(w.rl(["setup", "show"], { cwd: w.a }).stdout),
    JSON.parse(w.rl(["config", "show"], { cwd: w.a }).stdout),
  );
  w.rl(["setup", "run", "--dry-run"], { cwd: w.a });
  for (const shell of ["zsh", "bash"])
    assert.equal(
      w.rl(["setup", "shell", shell]).stdout,
      w.rl(["init", shell]).stdout,
    );
  fs.mkdirSync(path.join(w.a, ".rl"));
  write(
    path.join(w.a, ".rl/workflows.json"),
    JSON.stringify({ clean: ["generated"] }),
  );
  write(path.join(w.a, ".gitignore"), "generated/\n");
  fs.mkdirSync(path.join(w.a, "generated"));
  write(path.join(w.a, "generated/cache"), "cache");
  const preview = JSON.parse(
    w.rl(["storage", "clean", "--dry-run", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(preview.dryRun, true);
  assert.equal(read(path.join(w.a, "generated/cache")), "cache");
  w.rl(["repo", "add", "local", w.repo], { cwd: w.a });
  for (const prefix of [["--repo", "local"], ["--repo=local"]])
    assert.equal(
      w.rl([...prefix, "notes", "show"], { cwd: w.a }).stdout,
      w.rl(["context", "show"], { cwd: w.a }).stdout,
    );
  const all = JSON.parse(
    w.rl(["list", "--all", "--json"], { cwd: w.a }).stdout,
  );
  assert.ok(all.instances.length >= 2);
  assert.deepEqual(
    all,
    JSON.parse(w.rl(["status", "--all", "--json"], { cwd: w.a }).stdout),
  );
  assert.ok(
    readJson(path.join(w.a, ".rl/workflows.json")).clean.includes("generated"),
  );
});
