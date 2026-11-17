import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Workspace, read, write } from "./helpers.js";

function fixture(t: TestContext) {
  const w = new Workspace(t, { minimal: true });
  for (const key of [
    "RL_CLOUD_HOST",
    "RL_CLOUD_VM",
    "RL_CLOUD_PROJECT",
    "RL_CLOUD_ZONE",
    "RL_CLOUD_TEMPLATE",
  ])
    delete w.env[key];
  const calls = path.join(w.root, "ssh-calls.jsonl");
  w.env.CLOUD_CONFIG_CALLS = calls;
  w.stub(
    "ssh",
    `const fs = require('node:fs');
fs.appendFileSync(process.env.CLOUD_CONFIG_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({home:'/remote',rlInstalled:true,defaultRepo:null,repositories:[],instances:[],errors:[]}));`,
  );
  w.stub(
    "gcloud",
    `require('node:fs').writeFileSync(process.env.CLOUD_CONFIG_CALLS + '.gcloud', 'called'); process.exit(99);`,
  );
  return { w, calls };
}

test("host selection honors flags, environment, private config and saved hosts without using GCP", (t) => {
  const { w, calls } = fixture(t);
  w.rl(["cloud", "use", "saved-host"]);
  const host = (flags: string[] = []) => {
    w.rl(["cloud", "list", "--json", ...flags]);
    return JSON.parse(read(calls).trim().split("\n").at(-1)!)[2];
  };
  assert.equal(host(), "saved-host");
  write(w.config, 'cloudVm = "legacy-host"\n');
  assert.equal(host(), "legacy-host");
  const config =
    'cloudHost = "config-host"\ncloudProject = "ignored"\ncloudZone = "ignored"\ncloudTemplate = "ignored"\n';
  write(w.config, config);
  assert.equal(host(), "config-host");
  w.env.RL_CLOUD_VM = "legacy-env";
  assert.equal(host(), "legacy-env");
  w.env.RL_CLOUD_HOST = "env-host";
  assert.equal(host(), "env-host");
  assert.equal(host(["--host", "flag-host"]), "flag-host");
  assert.equal(host(["--vm", "legacy-flag"]), "legacy-flag");
  assert.match(
    w.rl(["cloud", "list", "--host", "one", "--vm", "two"], { ok: false })
      .stderr,
    /different hosts/,
  );
  assert.equal(read(w.config), config);
  assert.ok(!fs.existsSync(calls + ".gcloud"));
});

test("removed infrastructure commands and invalid creation never contact the server", (t) => {
  const { w, calls } = fixture(t);
  for (const command of [
    "vms",
    "ssh-config",
    "ssh",
    "tunnel",
    "start",
    "stop",
    "delete",
  ]) {
    assert.match(
      w.rl(["cloud", command], { ok: false }).stderr,
      /infrastructure commands have been removed/,
    );
  }
  assert.match(
    w.rl(["cloud", "list"], { ok: false }).stderr,
    /No cloud host configured/,
  );
  w.rl(["cloud", "create", "bad name", "--host", "dev-box"], { ok: false });
  w.rl(["cloud", "create", "--host", "dev-box"], { ok: false });
  w.rl(["cloud", "create", "new-work", "--host", "-bad"], { ok: false });
  assert.ok(!fs.existsSync(calls));
  assert.ok(!fs.existsSync(calls + ".gcloud"));
  const help = w.rl(["cloud", "--help"]).stdout;
  assert.match(help, /create\s+Create a workspace/);
  assert.doesNotMatch(
    help,
    /\n  (vms|start|stop|delete|ssh-config|tunnel|ssh)\s/,
  );
});

test("workspace creation requires a registered repository and remote rl", (t) => {
  const { w, calls } = fixture(t);
  assert.match(
    w.rl(["cloud", "create", "new-work", "--host", "dev-box"], { ok: false })
      .stderr,
    /No registered remote repositories/,
  );
  assert.equal(read(calls).trim().split("\n").length, 1);
  w.stub(
    "ssh",
    `console.log(JSON.stringify({home:'/remote',rlInstalled:false,defaultRepo:null,repositories:[],instances:[],errors:[]}));`,
  );
  assert.match(
    w.rl(["cloud", "create", "new-work", "--host", "dev-box"], { ok: false })
      .stderr,
    /Install rl on the SSH host/,
  );
});
