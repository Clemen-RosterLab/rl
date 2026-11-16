import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildManagedSshBlock,
  extractDryRunSshDetails,
  parseShellWords,
  upsertSshConfigContent,
} from "../dist/cloud.js";
import { CLI, Workspace, read, readJson, write } from "./helpers.js";

test("gcloud dry-run parser and ssh_config generator preserve user settings and deduplicate rl-cloud alias", () => {
  const sample =
    '/usr/bin/ssh -t -i /Users/clemen/.ssh/google_compute_engine -o CheckHostIP=no -o HashKnownHosts=no -o HostKeyAlias=compute.1234567890123456789 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/Users/clemen/.ssh/google_compute_known_hosts -o "ProxyCommand /opt/homebrew/bin/python3.14 -S /opt/homebrew/Caskroom/gcloud-cli/593.0.0/google-cloud-sdk/lib/gcloud.py compute start-iap-tunnel dev-example-rl %p --listen-on-stdin --project=example-cloud-project --zone=us-central1-a --verbosity=warning" -o ProxyUseFdpass=no developer_example_com@compute.1234567890123456789';

  const words = parseShellWords(sample);
  assert.equal(words[0], "/usr/bin/ssh");
  assert.equal(
    words.at(-1),
    "developer_example_com@compute.1234567890123456789",
  );

  const details = extractDryRunSshDetails(sample);
  assert.deepEqual(details, {
    user: "developer_example_com",
    hostKeyAlias: "compute.1234567890123456789",
    identityFile: "/Users/clemen/.ssh/google_compute_engine",
    userKnownHostsFile: "/Users/clemen/.ssh/google_compute_known_hosts",
  });

  const blockA = buildManagedSshBlock({
    vm: "dev-example-rl",
    isDefault: true,
    project: "example-cloud-project",
    zone: "us-central1-a",
    gcloudPath: "/opt/homebrew/bin/gcloud",
    details,
  });
  assert.match(blockA, /Host dev-example-rl rl-cloud/);
  assert.match(blockA, /ControlMaster auto/);
  assert.match(blockA, /start-iap-tunnel dev-example-rl %p/);

  const existing = "Host github.com\n  User git\n";
  const withA = upsertSshConfigContent(existing, "dev-example-rl", blockA, true);
  assert.match(withA, /Host github\.com/);
  assert.match(withA, /Host dev-example-rl rl-cloud/);

  const blockB = buildManagedSshBlock({
    vm: "dev-clemen-api",
    isDefault: true,
    project: "example-cloud-project",
    zone: "us-central1-a",
    gcloudPath: "/opt/homebrew/bin/gcloud",
    details: { ...details, hostKeyAlias: "compute.99999" },
  });
  const withBoth = upsertSshConfigContent(
    withA,
    "dev-clemen-api",
    blockB,
    true,
  );
  assert.match(withBoth, /Host dev-example-rl\n/);
  assert.match(withBoth, /Host dev-clemen-api rl-cloud\n/);
});

test("end-to-end cloud repos, list, ssh-config, fetch, checkout and uncommitted cloud review", (t) => {
  const w = new Workspace(t);
  const localHome = path.join(w.root, "local-home");
  const cloudHome = path.join(w.root, "cloud-home");
  fs.mkdirSync(localHome, { recursive: true });
  fs.mkdirSync(cloudHome, { recursive: true });

  // Isolate os.homedir() for the local CLI process so ~/.ssh/config is written inside w.root.
  const preload = path.join(w.root, "home-preload.cjs");
  write(
    preload,
    `require('node:os').homedir = () => ${JSON.stringify(localHome)}; require('node:module').syncBuiltinESMExports();`,
  );
  w.env.NODE_OPTIONS =
    `${w.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preload)}`.trim();

  // Set shared GitHub origin identity on local repo (alias: "frontend") and cloud repo (alias: "rosterlab-frontend").
  w.git(
    w.repo,
    "remote",
    "add",
    "origin",
    "https://github.com/rosterlab/rosterlab-frontend.git",
  );
  w.rl(["repo", "add", "frontend", w.repo, "--base", "develop"]);

  // Prepare simulated remote RL installation + repositories inside cloudHome.
  const cloudRepo = path.join(cloudHome, "rosterlab-frontend");
  const cloudUnregistered = path.join(cloudHome, "playground-api");
  const cloudStateDir = path.join(cloudHome, ".rl/instances");
  const cloudWorktreeDir = path.join(cloudHome, ".rl/worktrees");

  w.command(["git", "clone", "-q", w.repo, cloudRepo]);
  w.git(
    cloudRepo,
    "remote",
    "set-url",
    "origin",
    "git@github.com:rosterlab/rosterlab-frontend.git",
  );
  w.command(["git", "init", "-q", "-b", "main", cloudUnregistered]);
  w.git(cloudUnregistered, "commit", "-q", "--allow-empty", "-m", "Init api");

  const cloudEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: cloudHome,
    RL_STATE_DIR: cloudStateDir,
    RL_WORKTREE_DIR: cloudWorktreeDir,
    RL_CONFIG: path.join(cloudHome, "empty.toml"),
    RL_PR_OFFLINE: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Cloud Dev",
    GIT_AUTHOR_EMAIL: "cloud@rosterlab.com",
    GIT_COMMITTER_NAME: "Cloud Dev",
    GIT_COMMITTER_EMAIL: "cloud@rosterlab.com",
  };
  write(path.join(cloudHome, "empty.toml"), "# cloud\n");

  const runOnCloud = (argv: string[], cwd = cloudRepo) => {
    const res = w.command([CLI, ...argv], { cwd });
    return res;
  };
  void runOnCloud;

  // Register cloudRepo and create a cloud RL workspace with both a commit AND uncommitted changes.
  const cloudWorktree = path.join(
    cloudWorktreeDir,
    "rosterlab-frontend/ROS-9999-cloud-feature",
  );
  fs.mkdirSync(path.dirname(cloudWorktree), { recursive: true });
  w.git(
    cloudRepo,
    "worktree",
    "add",
    "-q",
    "-b",
    "ROS-9999-cloud-feature",
    cloudWorktree,
    "develop",
  );
  write(path.join(cloudWorktree, "committed.ts"), "export const cloud = 1;\n");
  w.git(cloudWorktree, "add", "committed.ts");
  w.git(cloudWorktree, "commit", "-qm", "Cloud committed work");
  write(
    path.join(cloudWorktree, "uncommitted.ts"),
    "export const draft = true;\n",
  );

  // Run RL on cloudHome to register the repo and adopt the worktree.
  for (const [cmd, cwd] of [
    [
      ["repo", "add", "rosterlab-frontend", cloudRepo, "--base", "develop"],
      cloudRepo,
    ],
    [["setup", "adopt"], cloudWorktree],
  ] as const) {
    const prevEnv = w.env;
    w.env = cloudEnv;
    try {
      w.command([CLI, ...cmd], { cwd });
    } finally {
      w.env = prevEnv;
    }
  }

  // Stub gcloud and ssh in w.bin.
  const sshLog = path.join(w.root, "ssh-calls.jsonl");
  const codeLog = path.join(w.root, "code-calls.jsonl");
  w.env.CLOUD_TEST_HOME = cloudHome;
  w.env.CLOUD_TEST_STATE = cloudStateDir;
  w.env.CLOUD_TEST_WT = cloudWorktreeDir;
  w.env.CLOUD_TEST_CLI = CLI;
  w.env.SSH_CALL_LOG = sshLog;
  w.env.CODE_CALL_LOG = codeLog;

  w.stub(
    "gcloud",
    `
const args = process.argv.slice(2);
if (args[0] === "config" && args[1] === "get-value" && args[2] === "account") {
  console.log("clemen@rosterlab.com");
  process.exit(0);
}
if (args[0] === "compute" && args[1] === "instances" && args[2] === "list") {
  console.log(JSON.stringify([{
    name: "dev-example-rl",
    zone: "https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a",
    machineType: "zones/us-central1-a/machineTypes/e2-standard-4",
    status: "RUNNING",
    labels: { owner: "clemen" }
  }]));
  process.exit(0);
}
if (args[0] === "compute" && args[1] === "ssh" && args.includes("--dry-run")) {
  console.log("/usr/bin/ssh -t -i /tmp/fake_key -o HostKeyAlias=compute.12345 -o UserKnownHostsFile=/tmp/fake_kh developer_example_com@compute.12345");
  process.exit(0);
}
console.error("Unexpected gcloud call: " + args.join(" "));
process.exit(1);
`,
  );

  // Expose `rl` inside a cloud-bin dir for simulated remote commands.
  const cloudBin = path.join(w.root, "cloud-bin");
  fs.mkdirSync(cloudBin, { recursive: true });
  const cloudRlShim = path.join(cloudBin, "rl");
  write(
    cloudRlShim,
    `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.join(path.dirname(CLI), "../dist/public-cli.js")}" "$@"\n`,
  );
  fs.chmodSync(cloudRlShim, 0o755);
  w.env.CLOUD_TEST_BIN = cloudBin;

  w.stub(
    "ssh",
    `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.SSH_CALL_LOG, JSON.stringify(argv) + "\\n");

// Strip ssh flags (-t, -N, -o k=v, -L spec, -p port) to find host and remote command.
const flagsWithArg = new Set(["-o", "-L", "-i", "-p", "-l", "-F", "-S"]);
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (flagsWithArg.has(argv[i])) { i++; continue; }
  if (argv[i].startsWith("-")) continue;
  rest.push(argv[i]);
}
const host = rest[0];
const remoteCmd = rest.slice(1).join(" ");
const env = {
  ...process.env,
  HOME: process.env.CLOUD_TEST_HOME,
  RL_STATE_DIR: process.env.CLOUD_TEST_STATE,
  RL_WORKTREE_DIR: process.env.CLOUD_TEST_WT,
  RL_CONFIG: process.env.CLOUD_TEST_HOME + "/empty.toml",
  RL_PR_OFFLINE: "1",
  NODE_OPTIONS: "",
  PATH: process.env.CLOUD_TEST_BIN + ":" + process.env.PATH,
};
const res = spawnSync("/bin/sh", ["-c", remoteCmd], {
  cwd: process.env.CLOUD_TEST_HOME,
  env,
  stdio: "inherit",
});
process.exit(res.status ?? 1);
`,
  );

  w.stub(
    "code",
    `
const fs = require("node:fs");
fs.appendFileSync(process.env.CODE_CALL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
  );

  // 1. rl cloud vms
  const vmsJson = JSON.parse(w.rl(["cloud", "vms", "--json"]).stdout);
  assert.equal(vmsJson.vms.length, 1);
  assert.equal(vmsJson.vms[0].name, "dev-example-rl");

  // 2. rl cloud ssh-config writes ~/.ssh/config inside localHome
  w.rl(["cloud", "ssh-config"]);
  const sshCfg = read(path.join(localHome, ".ssh/config"));
  assert.match(sshCfg, /Host dev-example-rl rl-cloud/);
  assert.match(sshCfg, /ControlMaster auto/);

  // 3. rl cloud repos discovers both registered RL repo AND unregistered git repo in $HOME
  const cloudRepos = JSON.parse(w.rl(["cloud", "repos", "--json"]).stdout);
  assert.equal(cloudRepos.vm, "dev-example-rl");
  const repoNames = cloudRepos.repositories.map(
    (r: { name: string }) => r.name,
  );
  assert.ok(repoNames.includes("rosterlab-frontend"));
  assert.ok(repoNames.includes("playground-api"));

  // 4. rl list --cloud and rl list --include-cloud
  const cloudList = JSON.parse(w.rl(["list", "--cloud", "--json"]).stdout);
  assert.equal(cloudList.vm, "dev-example-rl");
  assert.equal(cloudList.instances.length, 1);
  assert.equal(cloudList.instances[0].id, "ROS-9999-cloud-feature");
  assert.equal(
    cloudList.instances[0].repositoryName,
    "dev-example-rl:rosterlab-frontend",
  );

  const combinedList = JSON.parse(
    w.rl(["list", "--all", "--include-cloud", "--json"]).stdout,
  );
  assert.equal(combinedList.cloudVm, "dev-example-rl");
  assert.ok(
    combinedList.instances.some(
      (i: { repositoryName: string }) => i.repositoryName === "frontend",
    ),
  );
  assert.ok(
    combinedList.instances.some(
      (i: { repositoryName: string }) =>
        i.repositoryName === "dev-example-rl:rosterlab-frontend",
    ),
  );

  // 5. rl cloud code opens VS Code Remote-SSH URI
  w.rl(["cloud", "code", "ROS-9999-cloud-feature"]);
  const codeArgs = readJson(codeLog);
  assert.equal(codeArgs[0], "--folder-uri");
  assert.match(
    codeArgs[1],
    /^vscode-remote:\/\/ssh-remote\+dev-example-rl\/.*ROS-9999-cloud-feature$/,
  );

  // 6. rl cloud review --json and --diff inspect BOTH committed and uncommitted cloud changes locally!
  const reviewJson = JSON.parse(
    w.rl(["cloud", "review", "ROS-9999-cloud-feature", "--json"]).stdout,
  );
  assert.equal(reviewJson.dirty, true);
  assert.equal(reviewJson.commits.length, 1);
  const changedPaths = reviewJson.files.map((f: { path: string }) => f.path);
  assert.ok(changedPaths.includes("committed.ts"));
  assert.ok(changedPaths.includes("uncommitted.ts"));

  const reviewDiff = w.rl([
    "cloud",
    "review",
    "ROS-9999-cloud-feature",
    "--diff",
  ]).stdout;
  assert.match(reviewDiff, /\+export const cloud = 1;/);
  assert.match(reviewDiff, /\+export const draft = true;/);

  // Verify remote worktree index on cloud was NOT mutated by snapshot capture!
  assert.equal(
    w.git(cloudWorktree, "status", "--porcelain"),
    "?? uncommitted.ts",
  );

  // 7. rl cloud checkout --include-uncommitted pulls the unpushed branch + uncommitted file into a local RL worktree!
  const destOut = path.join(w.root, "dest.txt");
  write(destOut, "");
  w.env.RL_SHELL_OUTPUT = destOut;
  w.env.RL_SHELL_PROTOCOL = "v2";
  try {
    w.rl([
      "cloud",
      "checkout",
      "ROS-9999-cloud-feature",
      "--include-uncommitted",
    ]);
  } finally {
    delete w.env.RL_SHELL_OUTPUT;
    delete w.env.RL_SHELL_PROTOCOL;
  }
  const localCheckedOut = path.join(
    w.root,
    "worktrees/example/ROS-9999-cloud-feature",
  );
  assert.equal(read(destOut).trim(), `cd:${fs.realpathSync(localCheckedOut)}`);
  assert.equal(
    read(path.join(localCheckedOut, "committed.ts")),
    "export const cloud = 1;\n",
  );
  assert.equal(
    read(path.join(localCheckedOut, "uncommitted.ts")),
    "export const draft = true;\n",
  );
});
