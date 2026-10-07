import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Workspace, CLI, ROOT, read, write } from "./helpers.js";

function configure(w: Workspace, config: object): void {
  fs.mkdirSync(path.join(w.repo, ".rl"), { recursive: true });
  write(path.join(w.repo, ".rl/workflows.json"), JSON.stringify(config));
}

test("unconfigured creation and registration default to origin/test even when main and develop exist", (t) => {
  const w = new Workspace(t);
  delete w.env.RL_DEFAULT_BASE;
  w.git(w.repo, "branch", "main");
  w.git(w.repo, "update-ref", "refs/remotes/origin/main", "main");
  w.git(w.repo, "checkout", "-qb", "test");
  w.git(w.repo, "commit", "-q", "--allow-empty", "-m", "Test-only commit");
  const testBase = w.git(w.repo, "rev-parse", "HEAD");
  w.git(w.repo, "update-ref", "refs/remotes/origin/test", testBase);
  w.git(w.repo, "update-ref", "refs/remotes/origin/develop", "develop");
  assert.notEqual(testBase, w.git(w.repo, "rev-parse", "develop"));
  assert.notEqual(testBase, w.git(w.repo, "rev-parse", "main"));

  const created = w.rl(["new", "default-test", "--no-fetch"]).stdout.trim();
  assert.equal(w.git(created, "rev-parse", "HEAD"), testBase);
  assert.equal(w.status(created).baseBranch, "origin/test");
  const direct = w
    .command([
      process.execPath,
      path.join(ROOT, "dist/cli.js"),
      "workflow",
      "--repo",
      w.repo,
      "--state-dir",
      w.state,
      "--base-dir",
      path.join(w.root, "worktrees/example"),
      "switch",
      "direct-default",
      "--create",
      "--no-fetch",
    ])
    .stdout.trim();
  assert.equal(w.git(direct, "rev-parse", "HEAD"), testBase);
  assert.equal(w.status(direct).baseBranch, "origin/test");
  w.rl(["repo", "add", "example", w.repo]);
  const registry = JSON.parse(w.rl(["repo", "list", "--json"]).stdout);
  assert.equal(registry.repositories.example.base, "origin/test");
  const help = w.rl(["help"]).stdout;
  assert.match(help, /default: origin\/test/);
  assert.doesNotMatch(help, /default: origin\/main/);
  assert.doesNotMatch(help, /default: origin\/develop/);

  w.env.RL_DEFAULT_BASE = "develop";
  // Use the legacy route to check that an explicit environment setting still works.
  w.rl(["repo", "remove", "example"]);
  const explicit = w
    .rl(["new", "explicit-develop", "--no-fetch"])
    .stdout.trim();
  assert.equal(
    w.git(explicit, "rev-parse", "HEAD"),
    w.git(w.repo, "rev-parse", "develop"),
  );
  assert.equal(w.status(explicit).baseBranch, "develop");
});

test("switch creates, resolves nested names, opens branches, and preserves argv and exit status", (t) => {
  const w = new Workspace(t);
  const created = w
    .rl([
      "switch",
      "feature/new",
      "--create",
      "--base",
      "develop",
      "--no-fetch",
    ])
    .stdout.trim();
  assert.equal(created, path.join(w.root, "worktrees/example/feature/new"));
  assert.equal(w.rl(["path", "feature/new"]).stdout.trim(), created);
  assert.equal(w.rl(["switch", "feature/new"]).stdout.trim(), created);
  assert.equal(w.rl(["path", "@"], { cwd: created }).stdout.trim(), w.repo);
  const result = w.rl(
    [
      "exec",
      "--workspace",
      "feature/new",
      "--",
      process.execPath,
      "-e",
      "console.log(JSON.stringify([process.cwd(),...process.argv.slice(1)]));process.exit(17)",
      "space ' quote",
      "$(not-a-command)",
    ],
    { ok: false },
  );
  assert.equal(result.status, 17);
  assert.deepEqual(JSON.parse(result.stdout), [
    created,
    "space ' quote",
    "$(not-a-command)",
  ]);
  assert.match(w.rl(["list", "--json"]).stdout, /feature\/new/);
  w.rl(["switch", "../escape", "-c", "--no-fetch"], { ok: false });
  w.rl(["switch", "feature/new", "-c", "--no-fetch"], { ok: false });
  assert.equal(
    w.rl(["new", "feature/new", "--no-fetch"]).stdout.trim(),
    created,
  );
  assert.equal(
    w.rl(["open", "-b", "feature/new", "--no-fetch"]).stdout.trim(),
    created,
  );
  assert.equal(
    w
      .rl(["exec", "--workspace", "feature/new", "--", CLI, "path", "@"])
      .stdout.trim(),
    w.repo,
  );
  w.rl(
    [
      "switch",
      "bad-dry-run",
      "-c",
      "--dry-run",
      "--base",
      "develop",
      "--no-fetch",
    ],
    { ok: false },
  );
  assert.ok(!fs.existsSync(path.join(w.root, "worktrees/example/bad-dry-run")));
  w.rl(["path", "feature/new", "--create"], { ok: false });
  w.git(w.repo, "remote", "add", "origin", w.repo);
  w.git(w.repo, "update-ref", "refs/remotes/origin/remote-work", "HEAD");
  const remoteWorkspace = w
    .rl(["open", "-b", "remote-work", "--no-fetch"])
    .stdout.trim();
  assert.equal(
    w.git(remoteWorkspace, "rev-parse", "--abbrev-ref", "@{upstream}"),
    "origin/remote-work",
  );
  assert.equal(w.status(remoteWorkspace).baseBranch, "origin/develop");
});

test("setup explicitly copies ignored files independently, skips existing files, and supplies deterministic environment", (t) => {
  const w = new Workspace(t);
  write(path.join(w.repo, ".gitignore"), ".env\n.cache/\n");
  w.git(w.repo, "add", ".gitignore");
  w.git(w.repo, "commit", "-qm", "Ignore local setup files");
  write(path.join(w.repo, ".env"), "secret source");
  fs.mkdirSync(path.join(w.repo, ".cache/nested"), { recursive: true });
  write(path.join(w.repo, ".cache/nested/file"), "cached");
  const script =
    "require('node:fs').appendFileSync('setup.log',JSON.stringify([process.env.RL_PORT,process.env.RL_WORKSPACE,process.env.APP_MODE,process.argv[1]])+'\\n')";
  configure(w, {
    copy: [".env", ".cache", ".cache/nested/file"],
    env: { APP_MODE: "test" },
    onCreate: [[process.execPath, "-e", script, "create"]],
    onOpen: [[process.execPath, "-e", script, "open"]],
  });
  const workspace = w
    .rl(["switch", "setup-test", "-c", "--base", "develop", "--no-fetch"])
    .stdout.trim();
  assert.ok(!fs.existsSync(path.join(workspace, ".env")));
  assert.ok(!fs.existsSync(path.join(workspace, "setup.log")));
  const preview = w.rl(["setup", "--dry-run"], { cwd: workspace });
  assert.match(preview.stderr, /Would copy/);
  assert.ok(!fs.existsSync(path.join(workspace, ".env")));
  w.rl(["setup"], { cwd: workspace });
  assert.equal(read(path.join(workspace, ".env")), "secret source");
  assert.equal(read(path.join(workspace, ".cache/nested/file")), "cached");
  write(path.join(workspace, ".env"), "local edited");
  assert.equal(read(path.join(w.repo, ".env")), "secret source");
  w.rl(["setup"], { cwd: workspace });
  assert.equal(read(path.join(workspace, ".env")), "local edited");
  const events = read(path.join(workspace, "setup.log"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event[3]),
    ["create", "open", "create", "open"],
  );
  assert.ok(
    events.every(
      (event) =>
        event[0] === events[0][0] &&
        event[1] === workspace &&
        event[2] === "test",
    ),
  );
  w.rl(["switch", "setup-test", "--setup"]);
  const updated = read(path.join(workspace, "setup.log")).trim().split("\n");
  assert.equal(updated.length, 5);
  assert.equal(JSON.parse(updated[4])[3], "open");
});

test("copy rejects escape, symlinks, tracked files and unsafe later entries before writing", (t) => {
  const w = new Workspace(t);
  write(path.join(w.repo, ".gitignore"), ".env\n.cache/\n");
  write(path.join(w.repo, "tracked"), "tracked");
  w.git(w.repo, "add", ".gitignore", "tracked");
  w.git(w.repo, "commit", "-qm", "Setup fixtures");
  write(path.join(w.repo, ".env"), "source");
  const workspace = w.managed("safe-copy");
  for (const unsafe of ["../escape", ".git/config", "tracked"]) {
    configure(w, { copy: [".env", unsafe] });
    w.rl(["setup"], { cwd: workspace, ok: false });
    assert.ok(!fs.existsSync(path.join(workspace, ".env")));
  }
  fs.mkdirSync(path.join(w.repo, ".cache"));
  fs.symlinkSync(path.join(w.repo, ".env"), path.join(w.repo, ".cache/link"));
  configure(w, { copy: [".env", ".cache"] });
  assert.match(
    w.rl(["setup"], { cwd: workspace, ok: false }).stderr,
    /symlinks/,
  );
  assert.ok(!fs.existsSync(path.join(workspace, ".env")));
  fs.symlinkSync(path.join(w.root, "missing"), path.join(workspace, ".env"));
  configure(w, { copy: [".env"] });
  assert.match(
    w.rl(["setup"], { cwd: workspace, ok: false }).stderr,
    /symlinks/,
  );
});

test("config validation and hook failures are reported without silently continuing", (t) => {
  const w = new Workspace(t);
  w.rl(["config", "init"]);
  assert.deepEqual(JSON.parse(w.rl(["config", "show"]).stdout), {
    copy: [],
    env: {},
    onCreate: [],
    onOpen: [],
  });
  w.rl(["config", "init"], { ok: false });
  for (const config of [
    { onCreate: ["echo unsafe"] },
    { env: { RL_PORT: "1" } },
    { unexpected: true },
  ]) {
    configure(w, config);
    w.rl(["config", "show"], { ok: false });
  }
  configure(w, {
    onCreate: [[process.execPath, "-e", "process.exit(23)"]],
    onOpen: [[process.execPath, "-e", "throw Error('should not run')"]],
  });
  assert.equal(w.rl(["setup"], { cwd: w.a, ok: false }).status, 23);
});

test("zsh and bash integration switch directories, remember previous workspace, and reload stale runtime", (t) => {
  const w = new Workspace(t);
  const workspace = w.managed("shell-test");
  for (const shell of ["zsh", "bash"]) {
    w.managed(`remove-${shell}`);
    const script =
      `eval "$("$RL_TEST_CLI" init ${shell})"\nrl switch shell-test\n[[ "$PWD" == "$RL_TEST_WORKSPACE" ]] || exit 10\nrl switch @\n[[ "$PWD" == "$RL_REPO_ROOT" ]] || exit 11\nrl switch -\n[[ "$PWD" == "$RL_TEST_WORKSPACE" ]] || exit 12\n` +
      (shell === "zsh"
        ? `_rl_main() { return 88; }\nrl path @\n`
        : "rl path @\n") +
      `rl exec -- "$RL_TEST_CLI" switch @ >/dev/null\n[[ "$PWD" == "$RL_TEST_WORKSPACE" ]] || exit 14\n` +
      `rl switch remove-${shell}\nrl delete remove-${shell} >/dev/null\n[[ "$PWD" == "$RL_REPO_ROOT" ]] || exit 13\n`;
    w.env.RL_TEST_CLI = CLI;
    w.env.RL_TEST_WORKSPACE = workspace;
    assert.equal(
      w.command([shell, "-c", script], { cwd: w.repo }).stdout.trim(),
      w.repo,
    );
  }
});

test("switch launches either agent in the selected workspace with literal arguments", (t) => {
  const w = new Workspace(t),
    workspace = w.managed("agents");
  for (const agent of ["codex", "claude"])
    w.rl(["switch", "agents", "--agent", agent, "--", "literal prompt"]);
  const calls = w.calls();
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) => call.cwd === workspace && call.argv.includes("literal prompt"),
    ),
  );
});

test("project environment cannot inject executable loaders into exec or either agent", (t) => {
  const w = new Workspace(t),
    workspace = w.managed("env-safety");
  const marker = path.join(w.root, "injected"),
    loader = path.join(w.root, "loader.cjs");
  write(
    loader,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'injected')`,
  );
  for (const [key, value] of [
    ["NODE_OPTIONS", `--require ${JSON.stringify(loader)}`],
    ["PATH", w.bin],
    ["LD_PRELOAD", loader],
    ["BASH_ENV", loader],
  ]) {
    configure(w, { env: { [key]: value } });
    const commands = [
      ["config", "show"],
      ["exec", "--", process.execPath, "-e", "process.exit(0)"],
      ...["codex", "claude"].flatMap((agent) => [
        ["agent", "start", agent],
        ["agent", "run", agent, "--prompt", "test"],
      ]),
    ];
    for (const command of commands)
      assert.match(
        w.rl(command, { cwd: workspace, ok: false }).stderr,
        /Unsupported workflow environment variable/,
      );
    assert.ok(!fs.existsSync(marker));
    assert.ok(!fs.existsSync(w.log));
  }
});

test("explicit repository selection follows exec into nested rl despite environment or config aliases", (t) => {
  const w = new Workspace(t),
    backend = path.join(w.root, "backend");
  w.command(["git", "init", "-q", "-b", "main", backend]);
  w.git(backend, "commit", "-q", "--allow-empty", "-m", "Initial backend");
  w.rl(["repo", "add", "front", w.repo, "--base", "develop"]);
  w.rl(["repo", "add", "back", backend, "--base", "main"]);
  w.env.RL_REPO = "front";
  w.rl(["--repo", "back", "switch", "selected", "--create", "--no-fetch"]);
  const command = [
    "--repo",
    "back",
    "exec",
    "--workspace",
    "selected",
    "--",
    CLI,
    "path",
    "@",
  ];
  assert.equal(w.rl(command).stdout.trim(), backend);
  delete w.env.RL_REPO;
  write(w.config, "RL_REPO=front\n");
  assert.equal(w.rl(command).stdout.trim(), backend);
});
