import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CLI, Workspace, read, readJson, write } from "./helpers.js";

test("end-to-end SSH workspace listing, creation, checkout and uncommitted review", (t) => {
  const w = new Workspace(t);
  const localHome = path.join(w.root, "local-home");
  const cloudHome = path.join(w.root, "cloud-home");
  fs.mkdirSync(localHome, { recursive: true });
  fs.mkdirSync(cloudHome, { recursive: true });

  write(w.config, 'cloudHost = "dev-vm-1"\n');

  // Isolate os.homedir() for the local CLI process so ~/.ssh/config is written inside w.root.
  const preload = path.join(w.root, "home-preload.cjs");
  write(
    preload,
    `require('node:os').homedir = () => ${JSON.stringify(localHome)}; require('node:module').syncBuiltinESMExports();`,
  );
  w.env.NODE_OPTIONS =
    `${w.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preload)}`.trim();

  // Set shared GitHub origin identity on local repo (alias: "frontend") and cloud repo (alias: "webapp").
  w.git(
    w.repo,
    "remote",
    "add",
    "origin",
    "https://github.com/example/webapp.git",
  );
  w.rl(["repo", "add", "frontend", w.repo, "--base", "develop"]);

  // Prepare simulated remote RL installation + repositories inside cloudHome.
  const cloudRepo = path.join(cloudHome, "webapp");
  const cloudUnregistered = path.join(cloudHome, "playground-api");
  const cloudStateDir = path.join(cloudHome, ".rl/instances");
  const cloudWorktreeDir = path.join(cloudHome, ".rl/worktrees");

  w.command(["git", "clone", "-q", w.repo, cloudRepo]);
  w.git(
    cloudRepo,
    "remote",
    "set-url",
    "origin",
    "git@github.com:example/webapp.git",
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
    GIT_AUTHOR_EMAIL: "cloud@example.invalid",
    GIT_COMMITTER_NAME: "Cloud Dev",
    GIT_COMMITTER_EMAIL: "cloud@example.invalid",
  };
  write(path.join(cloudHome, "empty.toml"), "# cloud\n");

  // Register cloudRepo and create a cloud RL workspace with both a commit AND uncommitted changes.
  const cloudWorktree = path.join(
    cloudWorktreeDir,
    "webapp/cloud-sync-feature",
  );
  fs.mkdirSync(path.dirname(cloudWorktree), { recursive: true });
  w.git(
    cloudRepo,
    "worktree",
    "add",
    "-q",
    "-b",
    "cloud-sync-feature",
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
    [["repo", "add", "webapp", cloudRepo, "--base", "develop"], cloudRepo],
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
    `require('node:fs').writeFileSync(process.env.CLOUD_TEST_HOME + '/unexpected-gcloud', 'called'); process.exit(99);`,
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

  fs.mkdirSync(path.join(localHome, ".ssh"), { recursive: true });
  const sshConfig =
    "Host dev-vm-1\n  HostName example.invalid\n  ProxyCommand existing-user-proxy %h %p\n";
  write(path.join(localHome, ".ssh/config"), sshConfig);

  // 3. rl cloud repos discovers both registered RL repo AND unregistered git repo in $HOME
  const cloudRepos = JSON.parse(w.rl(["cloud", "repos", "--json"]).stdout);
  assert.equal(cloudRepos.vm, "dev-vm-1");
  const repoNames = cloudRepos.repositories.map(
    (r: { name: string }) => r.name,
  );
  assert.ok(repoNames.includes("webapp"));
  assert.ok(repoNames.includes("playground-api"));

  // 4. rl list --cloud and rl list --include-cloud
  const cloudList = JSON.parse(w.rl(["list", "--cloud", "--json"]).stdout);
  assert.equal(cloudList.vm, "dev-vm-1");
  assert.equal(cloudList.instances.length, 1);
  assert.equal(cloudList.instances[0].id, "cloud-sync-feature");
  assert.equal(cloudList.instances[0].repositoryName, "dev-vm-1:webapp");

  const combinedList = JSON.parse(
    w.rl(["list", "--all", "--include-cloud", "--json"]).stdout,
  );
  assert.equal(combinedList.cloudVm, "dev-vm-1");
  assert.ok(
    combinedList.instances.some(
      (i: { repositoryName: string }) => i.repositoryName === "frontend",
    ),
  );
  assert.ok(
    combinedList.instances.some(
      (i: { repositoryName: string }) => i.repositoryName === "dev-vm-1:webapp",
    ),
  );

  // 5. rl cloud code opens VS Code Remote-SSH URI
  w.rl(["cloud", "code", "cloud-sync-feature"]);
  const codeArgs = readJson(codeLog);
  assert.equal(codeArgs[0], "--folder-uri");
  assert.match(
    codeArgs[1],
    /^vscode-remote:\/\/ssh-remote\+dev-vm-1\/.*cloud-sync-feature$/,
  );

  // 6. rl cloud review --json and --diff inspect BOTH committed and uncommitted cloud changes locally!
  const reviewJson = JSON.parse(
    w.rl(["cloud", "review", "cloud-sync-feature", "--json"]).stdout,
  );
  assert.equal(reviewJson.dirty, true);
  assert.equal(reviewJson.commits.length, 1);
  const changedPaths = reviewJson.files.map((f: { path: string }) => f.path);
  assert.ok(changedPaths.includes("committed.ts"));
  assert.ok(changedPaths.includes("uncommitted.ts"));

  const reviewDiff = w.rl([
    "cloud",
    "review",
    "cloud-sync-feature",
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
    w.rl(["cloud", "checkout", "cloud-sync-feature", "--include-uncommitted"]);
  } finally {
    delete w.env.RL_SHELL_OUTPUT;
    delete w.env.RL_SHELL_PROTOCOL;
  }
  const localCheckedOut = path.join(
    w.root,
    "worktrees/example/cloud-sync-feature",
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
  // Create on the explicitly chosen remote repository, never the local selection.
  const localHead = w.git(w.repo, "rev-parse", "HEAD");
  const localStatus = w.git(w.repo, "status", "--porcelain");
  w.rl([
    "--repo",
    "frontend",
    "cloud",
    "create",
    "feature/new-work",
    "--repo",
    "webapp",
    "--base",
    "develop",
    "--no-fetch",
  ]);
  assert.match(
    w.git(cloudRepo, "worktree", "list", "--porcelain"),
    /refs\/heads\/feature\/new-work/,
  );
  w.rl(["cloud", "create", "default-work", "--base", "develop", "--no-fetch"]);
  assert.match(
    w.git(cloudRepo, "worktree", "list", "--porcelain"),
    /refs\/heads\/default-work/,
  );
  assert.match(
    w.rl(
      ["cloud", "create", "feature/new-work", "--repo", "webapp", "--no-fetch"],
      {
        ok: false,
      },
    ).stderr,
    /already/,
  );
  assert.match(
    w.rl(["cloud", "create", "missing-work", "--repo", "missing"], {
      ok: false,
    }).stderr,
    /not registered/,
  );
  w.rl(["cloud", "code", "webapp/feature/new-work"]);
  assert.equal(w.git(w.repo, "rev-parse", "HEAD"), localHead);
  assert.equal(w.git(w.repo, "status", "--porcelain"), localStatus);
  assert.equal(
    w.git(w.repo, "branch", "--list", "feature/new-work", "default-work"),
    "",
  );
  assert.equal(read(path.join(localHome, ".ssh/config")), sshConfig);
  assert.ok(!fs.existsSync(path.join(cloudHome, "unexpected-gcloud")));
});

test("rl cloud works with any plain SSH host without gcloud or GCP config", (t) => {
  const w = new Workspace(t);
  const localHome = path.join(w.root, "local-home");
  const remoteHome = path.join(w.root, "remote-home");
  fs.mkdirSync(path.join(localHome, ".ssh"), { recursive: true });
  fs.mkdirSync(remoteHome, { recursive: true });

  const preload = path.join(w.root, "home-preload.cjs");
  write(
    preload,
    `require('node:os').homedir = () => ${JSON.stringify(localHome)}; require('node:module').syncBuiltinESMExports();`,
  );
  w.env.NODE_OPTIONS =
    `${w.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preload)}`.trim();

  // Pre-existing user SSH host in ~/.ssh/config (no cloudProject / cloudZone in config.toml).
  write(
    path.join(localHome, ".ssh/config"),
    "Host my-ssh-box\n  HostName 127.0.0.1\n  User developer\n",
  );

  const remoteRepo = path.join(remoteHome, "service-api");
  w.command(["git", "init", "-q", "-b", "main", remoteRepo]);
  w.git(remoteRepo, "commit", "-q", "--allow-empty", "-m", "Init");

  w.env.REMOTE_HOME = remoteHome;
  w.stub(
    "ssh",
    `
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const flagsWithArg = new Set(["-o", "-L", "-i", "-p", "-l", "-F", "-S"]);
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (flagsWithArg.has(argv[i])) { i++; continue; }
  if (argv[i].startsWith("-")) continue;
  rest.push(argv[i]);
}
const remoteCmd = rest.slice(1).join(" ");
const res = spawnSync("/bin/sh", ["-c", remoteCmd], {
  cwd: process.env.REMOTE_HOME,
  env: { ...process.env, HOME: process.env.REMOTE_HOME, NODE_OPTIONS: "" },
  stdio: "inherit",
});
process.exit(res.status ?? 1);
`,
  );

  w.rl(["cloud", "use", "my-ssh-box"]);
  const reposJson = JSON.parse(w.rl(["cloud", "repos", "--json"]).stdout);
  assert.equal(reposJson.vm, "my-ssh-box");
  assert.equal(reposJson.repositories.length, 1);
  assert.equal(reposJson.repositories[0].name, "service-api");
});
