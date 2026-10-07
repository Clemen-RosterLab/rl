import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { Workspace, ROOT, read } from "./helpers.js";

for (const agent of ["codex", "claude"]) {
  test(`${agent} launch preserves argv, cwd, exit status and hook-owned sessions`, (t) => {
    const w = new Workspace(t);
    w.stub(
      agent,
      `if (process.argv[2] === 'app-server') process.exit(0); const fs = require('node:fs'); fs.appendFileSync(process.env.AGENT_LOG, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), port: process.env.RL_PORT, workspace: process.env.RL_WORKSPACE }) + '\\n'); process.exit(Number(process.env.AGENT_EXIT || 0));`,
    );
    const launch = (args: string[], ok = true) =>
      w.command(
        [
          process.execPath,
          "--input-type=module",
          "-e",
          `import { main } from ${JSON.stringify(path.join(ROOT, "dist/agent-launch.js"))}; process.exitCode = await main(process.argv.slice(1));`,
          "--",
          "--repo",
          w.repo,
          "--state-dir",
          w.state,
          "--base-dir",
          path.join(w.root, "worktrees"),
          ...args,
        ],
        { cwd: w.a, ok },
      );
    launch(["start", agent, "--", "--model", "test model"]);
    launch([
      "run",
      agent,
      "--prompt=-- literal $(touch nope)",
      "--",
      "--model",
      "test model",
    ]);
    const calls = read(w.log)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls[0].argv.slice(1), ["--model", "test model"]);
    assert.deepEqual(calls[1].argv.slice(1), [
      agent === "codex" ? "exec" : "--print",
      "--model",
      "test model",
      "--",
      "-- literal $(touch nope)",
    ]);
    assert.equal(calls[1].cwd, w.a);
    assert.equal(calls[0].port, calls[1].port);
    assert.match(calls[1].port, /^\d+$/);
    assert.equal(calls[1].workspace, w.a);
    assert.deepEqual(w.status().sessions[agent], []);
    launch(["run", agent, "--prompt", " "], false);
    w.env.AGENT_EXIT = "7";
    assert.equal(launch(["run", agent, "--prompt", "test"], false).status, 7);
  });
}

test("handoff includes saved shared notes without inventing conversations", (t) => {
  const w = new Workspace(t);
  w.rl(["progress", "append", "-"], {
    cwd: w.a,
    input: "Next: run integration tests.",
  });
  const result = w.command(
    [
      process.execPath,
      "--input-type=module",
      "-e",
      `import { main } from ${JSON.stringify(path.join(ROOT, "dist/agent-launch.js"))}; process.exitCode = await main(process.argv.slice(1));`,
      "--",
      "--repo",
      w.repo,
      "--state-dir",
      w.state,
      "--base-dir",
      path.join(w.root, "worktrees"),
      "handoff",
      "claude",
    ],
    { cwd: w.a },
  );
  assert.match(result.stdout, /Handoff to claude/);
  assert.match(result.stdout, /Next: run integration tests/);
});

test("handoff output refuses existing files and state documents", (t) => {
  const w = new Workspace(t);
  const progress = w.rl(["progress", "path"], { cwd: w.a }).stdout.trim();
  const before = read(progress);
  const result = w.command(
    [
      process.execPath,
      "--input-type=module",
      "-e",
      `import { main } from ${JSON.stringify(path.join(ROOT, "dist/agent-launch.js"))}; process.exitCode = await main(process.argv.slice(1));`,
      "--",
      "--repo",
      w.repo,
      "--state-dir",
      w.state,
      "--base-dir",
      path.join(w.root, "worktrees"),
      "handoff",
      "--output",
      progress,
    ],
    { cwd: w.a, ok: false },
  );
  assert.match(result.stderr, /EEXIST/);
  assert.equal(read(progress), before);
  assert.ok(fs.existsSync(progress));
});
