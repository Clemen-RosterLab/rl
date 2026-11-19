import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, Workspace, read, readJson, write } from "./helpers.js";

const source = fs.readFileSync(
  path.join(ROOT, "dist/cloud-job-runner.js"),
  "utf8",
);
function request(w: Workspace, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: "launch",
    workspace: w.a,
    repository: "example",
    repositoryRoot: w.repo,
    branch: "feature/a",
    agent: "agy",
    prompt: "Task",
    source,
    ...extra,
  });
}
const command = [process.execPath, "--input-type=module", "-e", source];

test("cloud launch rejects missing executables and records an unconfirmed supervisor crash", (t) => {
  const w = new Workspace(t);
  const missing = w.command(command, {
    input: request(w, { agent: "rl-missing-test-agent" }),
    ok: false,
  });
  assert.match(missing.stderr, /not installed/);
  const crash = w.command(command, {
    input: request(w, { source: "process.exit(9);" }),
    ok: false,
  });
  assert.match(crash.stderr, /before confirmation/);
  const jobs = path.join(w.state, "cloud-jobs");
  const id = fs.readdirSync(jobs).find((name) => /^[a-f\d-]{36}$/.test(name))!;
  const state = JSON.parse(
    w.command(command, { input: JSON.stringify({ action: "status", id }) })
      .stdout,
  );
  assert.equal(state.status, "interrupted");
  assert.ok(
    fs.existsSync(state.lock),
    "An unconfirmed launch must not silently unlock a possibly running job",
  );
  assert.match(
    w.command(command, { input: request(w), ok: false }).stderr,
    /already has a job lock/,
  );
});

test("concurrent detached launches acquire exactly one workspace lock and keep private records", async (t) => {
  const w = new Workspace(t);
  const release = path.join(w.root, "release");
  w.stub(
    "rl",
    `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(release)})) process.exit(0); }, 50);`,
  );
  const results = await Promise.allSettled([
    w.commandAsync(command, { input: request(w), timeoutMs: 20000 }),
    w.commandAsync(command, { input: request(w), timeoutMs: 20000 }),
  ]);
  const launched = results.filter((result) => result.status === "fulfilled");
  assert.equal(launched.length, 1);
  const failed = results.find((result) => result.status === "rejected");
  assert.match(String(failed?.reason), /already has a job lock/);
  const job = JSON.parse(launched[0].value);
  t.after(() => {
    try {
      process.kill(-job.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  });
  assert.equal(job.status, "running");
  const dir = path.dirname(job.log);
  for (const file of [
    job.log,
    path.join(dir, "job.json"),
    path.join(dir, "request.json"),
  ])
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.doesNotMatch(read(path.join(dir, "job.json")), /"prompt"/);
  write(release, "continue");
  const deadline = Date.now() + 10000;
  while (readJson(path.join(dir, "job.json")).status !== "completed") {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(readJson(path.join(dir, "job.json")).exitCode, 0);
  assert.ok(!fs.existsSync(job.lock));
});
