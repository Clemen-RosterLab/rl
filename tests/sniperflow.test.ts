import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CLI, ROOT, Workspace, write } from "./helpers.js";
import {
  countsAsLogic,
  draftWorkspace,
  workloadLines,
} from "../dist/orchestration/sniper-diff.js";

const patch = (file: string, value: string) =>
  `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${value}\n`;

test("sniperflow enforces exact writer paths and budgets additions from the initial dirty tree", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "existing.ts"), "existing\n");
  const directory = fs.mkdtempSync(path.join(w.root, "draft-"));
  const draft = draftWorkspace(w.a, directory);
  assert.throws(
    () => draft.applyWriter(patch("wrong.ts", "bad"), ["allowed.ts"]),
    /unassigned/,
  );
  assert.equal(draft.tree(), draft.base);
  draft.applyWriter(patch("allowed.ts", "good"), ["allowed.ts"]);
  draft.applyWriter(patch("allowed.test.ts", "test"), ["allowed.test.ts"]);
  assert.equal(workloadLines(draft.cwd, draft.base, draft.tree()), 1);
  for (const name of ["test/example.py", "src/app.test.ts", "x.css", "y.json"])
    assert.equal(countsAsLogic(name), false);
  write(path.join(w.a, "existing.ts"), "external edit\n");
  assert.throws(() => draft.deliver(), /checkout changed/);
  assert.ok(!fs.existsSync(path.join(w.a, "allowed.ts")));
});

function provider(w: Workspace) {
  w.env.SNIPER_LOG = path.join(w.root, "sniper.jsonl");
  w.stub(
    "codex",
    fs.readFileSync(
      path.join(ROOT, "tests/fixtures/sniperflow-provider.cjs"),
      "utf8",
    ),
  );
}
test("public sniperflow launches roles, grants a requested extension, serializes overlapping writers and delivers after review", (t) => {
  const w = new Workspace(t);
  provider(w);
  w.env.SNIPER_REJECT = path.join(w.root, "first-rejection");
  const args = ["workflow", "sniperflow"];
  const started = Date.now();
  const result = w.rl([...args, "Implement the feature", "--lines", "1"], {
    cwd: w.a,
  });
  assert.match(result.stdout, /accepted · 1\/1/);
  assert.equal(
    fs.readFileSync(path.join(w.a, "feature.ts"), "utf8"),
    "hello\n",
  );
  const events = fs
    .readFileSync(w.env.SNIPER_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.find((e) => e.role === "writer-1").seconds, 900);
  assert.equal(events.find((e) => e.role === "quality").seconds, 300);
  const roles = events.map((e) => e.role);
  for (const role of [
    "orchestrator",
    "specialist",
    "product-owner",
    "regression",
    "quality",
    "minimality",
    "writer-1",
    "writer-2",
  ])
    assert.ok(roles.includes(role), role);
  assert.equal(roles.filter((r) => r === "quality").length, 2);
  const state = JSON.parse(w.rl([...args, "--status"], { cwd: w.a }).stdout);
  assert.equal(state.status, "accepted");
  const launchTime = Date.parse(state.deadline) - 3 * 60 * 60 * 1000;
  assert.ok(launchTime >= started && launchTime <= Date.now());
});

test("over-budget approval requires revision and fresh reviews before delivery", (t) => {
  const w = new Workspace(t);
  provider(w);
  w.env.SNIPER_TRIM = "1";
  const result = w.rl(
    [
      "workflow",
      "sniperflow",
      "Implement",
      "--lines",
      "0",
      "--seconds",
      "60",
      "--agent-seconds",
      "45",
      "--writer-seconds",
      "75",
    ],
    { cwd: w.a },
  );
  assert.match(result.stderr, /writer-2: Assigned 75 seconds/);
  assert.match(result.stderr, /quality: Assigned 45 seconds/);
  assert.match(result.stderr, /Acceptance blocked/);
  assert.match(result.stdout, /accepted · 0\/0/);
  assert.ok(!fs.existsSync(path.join(w.a, "feature.ts")));
  assert.ok(fs.existsSync(path.join(w.a, "example.css")));
});

test("live extension updates the overall deadline and overdue agents are warned and terminated", async (t) => {
  const w = new Workspace(t);
  provider(w);
  w.env.SNIPER_HANG = "specialist";
  const args = ["workflow", "sniperflow"];
  const done = assert.rejects(
    w.commandAsync(
      [CLI, ...args, "Implement", "--seconds", "5", "--agent-seconds", "180"],
      { cwd: w.a },
    ),
    /overall deadline/,
  );
  const until = Date.now() + 10000;
  while (!fs.existsSync(w.env.SNIPER_LOG!) && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 30));
  const state = () =>
    JSON.parse(w.rl([...args, "--status"], { cwd: w.a }).stdout);
  const before = state();
  const after = JSON.parse(
    w.rl([...args, "--extend", "2"], { cwd: w.a }).stdout,
  );
  assert.equal(Date.parse(after.deadline) - Date.parse(before.deadline), 2000);
  await done;
  assert.equal(state().status, "stopped");
  const log = fs
    .readFileSync(w.env.SNIPER_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const warning = log.find((entry) => entry.steer);
  assert.equal(warning?.role, "specialist");
  assert.ok(
    log.some((entry) => entry.role === "specialist" && entry.seconds === 2),
  );
  assert.throws(() => process.kill(warning.pid, 0), /ESRCH/);
});

test("orchestrator outlives the delegated-agent deadline without a warning or restart", (t) => {
  const w = new Workspace(t);
  provider(w);
  w.env.SNIPER_HANG = "orchestrator";
  const result = w.rl(
    [
      "workflow",
      "sniperflow",
      "Implement",
      "--seconds",
      "5",
      "--agent-seconds",
      "1",
    ],
    { cwd: w.a, ok: false },
  );
  assert.match(result.stderr, /overall deadline/);
  const events = fs
    .readFileSync(w.env.SNIPER_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].role, "orchestrator");
  assert.equal(events[0].seconds, null);
});

test("a live budget decrease wins over an in-flight acceptance decision", async (t) => {
  const w = new Workspace(t);
  provider(w);
  const gate = path.join(w.root, "accept");
  w.env.SNIPER_ACCEPT_GATE = gate;
  w.env.SNIPER_TRIM = "1";
  const args = ["workflow", "sniperflow"];
  const run = w.commandAsync(
    [CLI, ...args, "Implement", "--lines", "1", "--seconds", "60"],
    { cwd: w.a },
  );
  try {
    const until = Date.now() + 30000;
    while (!fs.existsSync(gate + ".ready") && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(fs.existsSync(gate + ".ready"));
    for (const n of [10, 0])
      assert.equal(
        JSON.parse(w.rl([...args, "--lines", String(n)], { cwd: w.a }).stdout)
          .limit,
        n,
      );
  } finally {
    write(gate, "continue");
  }
  assert.match(await run, /accepted · 0\/0/);
  assert.ok(!fs.existsSync(path.join(w.a, "feature.ts")));
  assert.match(
    w.rl([...args, "--lines", "5"], { cwd: w.a, ok: false }).stderr,
    /No live sniperflow/,
  );
});

test("a writer timeout returns the unfinished assignment to the orchestrator before review", (t) => {
  const w = new Workspace(t);
  provider(w);
  w.env.SNIPER_WRITER_TIMEOUT = path.join(w.root, "stalled");
  const result = w.rl(
    ["workflow", "sniperflow", "Implement", "--seconds", "60"],
    { cwd: w.a },
  );
  assert.match(result.stdout, /accepted/);
  assert.match(result.stderr, /writer assignment did not finish/);
  const events = fs
    .readFileSync(w.env.SNIPER_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const first = events.findIndex(
    (e) => e.role === "writer-1" && e.seconds === 2,
  );
  const retry = events.findIndex(
    (e) => e.role === "writer-1" && e.seconds === 15,
  );
  assert.ok(first >= 0 && retry > first);
  assert.ok(events.findIndex((e) => e.role === "quality") > retry);
});
