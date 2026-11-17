import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Workspace, read, write } from "./helpers.js";

function cloudFixture(t: TestContext) {
  const w = new Workspace(t, { minimal: true });
  for (const key of [
    "RL_CLOUD_PROJECT",
    "RL_CLOUD_ZONE",
    "RL_CLOUD_TEMPLATE",
    "RL_CLOUD_VM",
  ])
    delete w.env[key];
  const calls = path.join(w.root, "cloud-calls.jsonl");
  w.env.CLOUD_CONFIG_CALLS = calls;
  w.stub(
    "gcloud",
    `const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.CLOUD_CONFIG_CALLS, JSON.stringify(argv) + '\\n');
if (argv[0] === 'config') console.log('developer@example.invalid');
else console.log('[]');`,
  );
  return { w, calls };
}

test("GCP commands fail before contacting gcloud when project or zone is missing", (t) => {
  const { w, calls } = cloudFixture(t);
  for (const argv of [
    ["vms"],
    ["start", "dev-box"],
    ["stop", "dev-box"],
    ["create", "dev-box"],
    ["ssh-config", "dev-box", "--dry-run"],
  ]) {
    assert.match(
      w.rl(["cloud", ...argv], { ok: false }).stderr,
      /No Google Cloud project configured/,
    );
  }
  write(w.config, 'cloudProject = "example-project"\n');
  for (const argv of [
    ["start", "dev-box"],
    ["stop", "dev-box"],
    ["create", "dev-box"],
    ["ssh-config", "dev-box", "--dry-run"],
  ]) {
    assert.match(
      w.rl(["cloud", ...argv], { ok: false }).stderr,
      /No Google Cloud zone configured/,
    );
  }
  assert.ok(
    !fs.existsSync(calls),
    "Missing settings must not contact a cloud account",
  );
});

test("cloud settings resolve from private config, then environment, then command flags", (t) => {
  const { w, calls } = cloudFixture(t);
  const config = [
    'cloudProject = "file-project"',
    'cloudZone = "us-central1-a"',
    'cloudTemplate = "file-template"',
    'cloudVm = "file-vm"',
    "",
  ].join("\n");
  write(w.config, config);
  const invocation = () => JSON.parse(read(calls).trim().split("\n").at(-1)!);
  w.rl(["cloud", "start"]);
  assert.deepEqual(invocation(), [
    "compute",
    "instances",
    "start",
    "file-vm",
    "--project=file-project",
    "--billing-project=file-project",
    "--zone=us-central1-a",
  ]);
  w.env.RL_CLOUD_PROJECT = "env-project";
  w.env.RL_CLOUD_ZONE = "us-east1-b";
  w.env.RL_CLOUD_TEMPLATE = "env-template";
  w.env.RL_CLOUD_VM = "env-vm";
  w.rl(["cloud", "start"]);
  assert.deepEqual(invocation(), [
    "compute",
    "instances",
    "start",
    "env-vm",
    "--project=env-project",
    "--billing-project=env-project",
    "--zone=us-east1-b",
  ]);
  w.rl([
    "cloud",
    "start",
    "--project",
    "flag-project",
    "--zone",
    "us-west1-a",
    "--vm",
    "flag-vm",
  ]);
  assert.deepEqual(invocation(), [
    "compute",
    "instances",
    "start",
    "flag-vm",
    "--project=flag-project",
    "--billing-project=flag-project",
    "--zone=us-west1-a",
  ]);
  w.rl(["cloud", "create", "new-vm"]);
  assert.ok(invocation().includes("--source-instance-template=env-template"));
  delete w.env.RL_CLOUD_TEMPLATE;
  w.rl(["cloud", "create", "another-vm"]);
  assert.ok(invocation().includes("--source-instance-template=file-template"));
  assert.equal(
    read(w.config),
    config,
    "Commands must not rewrite private configuration",
  );
});
