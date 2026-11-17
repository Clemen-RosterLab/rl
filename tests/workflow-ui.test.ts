import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CLI, Workspace, read, readJson, write } from "./helpers.js";

test("workflow show defaults to the configured workflow and retains JSON export", (t) => {
  const w = new Workspace(t);
  const shown = w.rl(["workflow", "show"], { cwd: w.a }).stdout;
  assert.match(shown, /writer-reviewer-dry \(default\)/);
  assert.match(shown, /writer · writer/);
  assert.doesNotMatch(shown, /steps: \[/);
  const before = JSON.parse(
    w.rl(["workflow", "show", "--json"], { cwd: w.a }).stdout,
  );
  w.rl(["workflow", "configure", "--paths"], { cwd: w.a });
  const file = path.join(w.a, ".rl/agent-workflows.json");
  const config = readJson(file);
  config.workflows.custom = { ...before, description: "My custom workflow" };
  config.default = "custom";
  write(file, JSON.stringify(config));
  assert.match(
    w.rl(["workflow", "show"], { cwd: w.a }).stdout,
    /custom \(default\)\nMy custom workflow/,
  );
  assert.deepEqual(
    JSON.parse(w.rl(["workflow", "show", "--json"], { cwd: w.a }).stdout),
    config.workflows.custom,
  );
  assert.deepEqual(
    JSON.parse(
      w.rl(["workflow", "show", "writer-reviewer-dry", "--json"], { cwd: w.a })
        .stdout,
    ),
    before,
  );
});

test("configure preserves existing and inherited settings and never launches an editor in pipes", (t) => {
  const w = new Workspace(t);
  w.env.EDITOR = "missing-editor";
  w.env.VISUAL = "missing-editor";
  const result = JSON.parse(
    w.rl(["workflow", "configure", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(result.files.length, 3);
  for (const file of result.files)
    assert.ok(file.startsWith(w.a + path.sep) && fs.existsSync(file));
  const agents = path.join(w.a, ".rl/agents.json");
  const saved = readJson(agents);
  saved.agents.writer.instructions = "Preserve my custom instructions";
  write(agents, JSON.stringify(saved));
  const original = read(agents);
  fs.unlinkSync(path.join(w.a, ".rl/policies.json"));
  w.rl(["workflow", "configure"], { cwd: w.a });
  assert.equal(read(agents), original);
  assert.ok(!fs.existsSync(path.join(w.a, ".rl/policies.json")));
  assert.ok(!fs.existsSync(path.join(w.b, ".rl/agents.json")));
  // Broken settings must remain accessible for repair instead of blocking the editor.
  write(agents, "invalid JSON");
  w.rl(["workflow", "configure", "--paths"], { cwd: w.a });
  assert.equal(read(agents), "invalid JSON");
  w.rl(["workflow", "show", "--paths"], { cwd: w.a, ok: false });
});

test("configure opens the chosen editor with literal arguments and validates edited settings", (t) => {
  const w = new Workspace(t);
  const capture = path.join(w.root, "editor.json");
  w.env.EDITOR_CAPTURE = capture;
  w.env.VISUAL = 'workflow-editor "argument with spaces" "$(touch sentinel)"';
  w.stub(
    "workflow-editor",
    `
const fs = require('node:fs');
fs.writeFileSync(process.env.EDITOR_CAPTURE, JSON.stringify({args:process.argv.slice(2), cwd:process.cwd()}));
if(process.env.BREAK_WORKFLOW) fs.writeFileSync(process.argv.at(-1), 'broken json');
process.exit(Number(process.env.EDITOR_EXIT || 0));
`,
  );
  const terminal = `
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], sys.argv[2], 'workflow', 'configure'], stdin=slave, stdout=slave, stderr=slave)
output = b''
try:
    deadline = time.monotonic() + 15
    while child.poll() is None:
        if time.monotonic() > deadline: raise RuntimeError('configure timed out')
        if select.select([master], [], [], .05)[0]: output += os.read(master, 65536)
    while select.select([master], [], [], .05)[0]: output += os.read(master, 65536)
    print(output.decode())
    sys.exit(child.returncode)
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
    os.close(slave)
`;
  const command = ["python3", "-c", terminal, process.execPath, CLI];
  const output = w.command(command, { cwd: w.a });
  assert.match(output.stdout, /Workflow settings validated/);
  const recorded = readJson(capture);
  assert.equal(recorded.cwd, w.a);
  assert.deepEqual(recorded.args.slice(0, 2), [
    "argument with spaces",
    "$(touch sentinel)",
  ]);
  assert.deepEqual(
    recorded.args.slice(2),
    ["agents.json", "policies.json", "agent-workflows.json"].map((name) =>
      path.join(w.a, ".rl", name),
    ),
  );
  assert.ok(!fs.existsSync(path.join(w.a, "sentinel")));
  w.env.EDITOR_EXIT = "2";
  assert.match(
    w.command(command, { cwd: w.a, ok: false }).stdout,
    /Editor exited with code 2/,
  );
  delete w.env.EDITOR_EXIT;
  w.env.BREAK_WORKFLOW = "1";
  const invalid = w.command(command, { cwd: w.a, ok: false });
  assert.doesNotMatch(invalid.stdout, /Workflow settings validated/);
  assert.equal(read(path.join(w.a, ".rl/agent-workflows.json")), "broken json");
});
