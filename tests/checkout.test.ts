import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CLI, Workspace, read, readJson, write } from "./helpers.js";

function fixture(t: TestContext) {
  const w = new Workspace(t);
  const other = path.join(w.root, "other repository");
  w.command(["git", "init", "-q", "-b", "test", other]);
  w.git(other, "commit", "-qm", "Initial", "--allow-empty");
  w.git(
    w.repo,
    "remote",
    "add",
    "origin",
    "git@example.invalid:example/frontend.git",
  );
  w.git(
    other,
    "remote",
    "add",
    "origin",
    "https://example.invalid/team/backend.git",
  );
  w.rl(["repo", "add", "."], { cwd: w.a });
  w.rl(["repo", "add"], { cwd: other });
  return { w, other, registry: path.join(w.state, "repositories.json") };
}

function picker(w: Workspace) {
  const capture = path.join(w.root, "repositories.txt");
  w.env.CHECKOUT_CAPTURE = capture;
  w.env.CHECKOUT_REGISTRY = path.join(w.state, "repositories.json");
  w.stub(
    "fzf",
    `
const fs = require('node:fs');
// fzf versions before 0.34 (including distro-provided 0.29) reject adaptive heights.
if (process.argv.some(arg => /^--height=~/.test(arg))) {console.error('height must be a non-negative integer');process.exit(2);}
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.CHECKOUT_CAPTURE, input);
if (process.env.CHECKOUT_EXIT) process.exit(Number(process.env.CHECKOUT_EXIT));
if (process.env.CHECKOUT_REPLACE) {
 const file = process.env.CHECKOUT_REGISTRY;
 const data = JSON.parse(fs.readFileSync(file, 'utf8'));
 data.repositories.backend.root = process.env.CHECKOUT_REPLACE;
 fs.writeFileSync(file, JSON.stringify(data));
}
console.log(process.env.CHECKOUT_OUTPUT ?? input.trimEnd().split('\\n').find(line => line.startsWith('backend\\t')));
`,
  );
  return capture;
}

test("registration infers origin names from linked worktrees and accepts optional aliases", (t) => {
  const { w, other, registry } = fixture(t);
  const data = readJson(registry);
  assert.equal(data.repositories["frontend"].root, w.repo);
  assert.equal(data.repositories["frontend"].worktreeName, "example");
  assert.equal(data.repositories.backend.root, other);
  w.rl(["repo", "remove", "backend"]);
  w.rl(["repo", "add", ".", "--alias", "services"], { cwd: other });
  assert.equal(readJson(registry).repositories.services.root, other);
  w.rl(["repo", "remove", "services"]);
  w.rl(["repo", "add", "legacy", other]);
  assert.equal(readJson(registry).repositories.legacy.root, other);
});

test("registration falls back to the main directory and reports inferred name collisions", (t) => {
  const { w, other, registry } = fixture(t);
  w.rl(["repo", "remove", "frontend"]);
  w.git(w.repo, "remote", "remove", "origin");
  w.rl(["repo", "add", "."], { cwd: w.b });
  assert.equal(readJson(registry).repositories.repo.root, w.repo);
  w.rl(["repo", "remove", "backend"]);
  w.git(
    other,
    "remote",
    "set-url",
    "origin",
    "ssh://git@example.invalid/team/repo.git/",
  );
  const before = read(registry);
  assert.match(
    w.rl(["repo", "add", other], { ok: false }).stderr,
    /already registered: repo.*--alias/,
  );
  assert.equal(read(registry), before);
  w.rl(["repo", "add", other, "--alias", "backend"]);
});

test("checkout selects across repositories without changing branches, dirty files or default", (t) => {
  const { w, other, registry } = fixture(t);
  write(path.join(other, "dirty.txt"), "keep");
  w.git(other, "add", "dirty.txt");
  write(path.join(other, "dirty.txt"), "keep unstaged");
  const before = read(registry),
    status = w.git(other, "status", "--porcelain");
  assert.equal(
    w.rl(["checkout", "backend"], { cwd: w.a }).stdout.trim(),
    other,
  );
  assert.equal(
    w.rl(["checkout", "frontend"], { cwd: other }).stdout.trim(),
    w.repo,
  );
  assert.equal(w.git(other, "branch", "--show-current"), "test");
  assert.equal(w.git(other, "status", "--porcelain"), status);
  assert.equal(read(path.join(other, "dirty.txt")), "keep unstaged");
  assert.equal(read(registry), before);
  assert.ok(!fs.existsSync(path.join(other, ".codex")));
  assert.ok(!fs.existsSync(w.log));
});

test("repository picker includes every registration, supports cancellation and rejects unknown output", (t) => {
  const { w, other, registry } = fixture(t),
    capture = picker(w);
  const before = read(registry);
  assert.equal(w.rl(["checkout"], { cwd: w.a }).stdout.trim(), other);
  assert.match(read(capture), /frontend\t/);
  assert.match(read(capture), /backend\t/);
  for (const code of [1, 130]) {
    w.env.CHECKOUT_EXIT = String(code);
    assert.equal(w.rl(["checkout"]).stdout, "");
  }
  delete w.env.CHECKOUT_EXIT;
  w.env.CHECKOUT_OUTPUT = "unknown";
  assert.match(w.rl(["checkout"], { ok: false }).stderr, /unknown repository/);
  assert.equal(read(registry), before);
});

test("one repository is selected automatically and empty registries explain registration", (t) => {
  const w = new Workspace(t);
  assert.match(w.rl(["checkout"], { ok: false }).stderr, /rl repo add \./);
  w.rl(["repo", "add", "."], { cwd: w.a });
  w.stub("fzf", "process.exit(99)");
  assert.equal(w.rl(["checkout"]).stdout.trim(), w.repo);
  assert.match(
    w.rl(["checkout", "missing"], { ok: false }).stderr,
    /Unknown repository: missing/,
  );
  assert.match(
    w.rl(["checkout", "repo", "extra"], { ok: false }).stderr,
    /Usage: rl checkout/,
  );
});

test("checkout rejects missing or replaced repositories and registrations changed in the picker", (t) => {
  const { w, other } = fixture(t);
  picker(w);
  w.env.CHECKOUT_REPLACE = other + "-different";
  assert.match(
    w.rl(["checkout"], { ok: false }).stderr,
    /registration changed/,
  );
  delete w.env.CHECKOUT_REPLACE;
  w.rl(["repo", "remove", "backend"]);
  w.rl(["repo", "add", other]);
  fs.renameSync(other, other + "-moved");
  assert.equal(w.rl(["checkout", "backend"], { ok: false }).stdout, "");
  w.git(w.repo, "worktree", "add", "-q", "-b", "replacement", other);
  assert.match(
    w.rl(["checkout", "backend"], { ok: false }).stderr,
    /no longer matches/,
  );
});

test("zsh and bash checkout enter the selected repository and scope subsequent workspace lists", (t) => {
  const { w, other, registry } = fixture(t);
  const before = read(registry);
  w.env.RL_TEST_CLI = CLI;
  w.env.RL_TEST_OTHER = other;
  w.env.RL_TEST_SCRIPT = path.join(w.root, "checkout-shell");
  picker(w);
  for (const shell of ["zsh", "bash"]) {
    write(
      w.env.RL_TEST_SCRIPT!,
      `
eval "$("$RL_TEST_CLI" setup shell ${shell})"
rl checkout backend || exit 10
[[ "$PWD" == "$RL_TEST_OTHER" ]] || exit 11
rl list --json > "$RL_TEST_OTHER/list.json" || exit 12
rl status --json > "$RL_TEST_OTHER/status.json" || exit 21
rl checkout frontend || exit 13
[[ "$PWD" == "$RL_REPO_ROOT" ]] || exit 14
rl checkout || exit 15
[[ "$PWD" == "$RL_TEST_OTHER" ]] || exit 16
export CHECKOUT_EXIT=130
rl checkout || exit 17
[[ "$PWD" == "$RL_TEST_OTHER" ]] || exit 18
rl checkout missing && exit 19
[[ "$PWD" == "$RL_TEST_OTHER" ]] || exit 20
`,
    );
    w.command(
      [shell, shell === "zsh" ? "-f" : "--norc", w.env.RL_TEST_SCRIPT!],
      { cwd: w.a },
    );
    assert.deepEqual(readJson(path.join(other, "list.json")).instances, []);
    assert.equal(
      readJson(path.join(other, "status.json")).repository.name,
      "backend",
    );
  }
  assert.equal(read(registry), before);
});

test("repository status explains selection, current workspace, base and scoped session counts", (t) => {
  const { w, other } = fixture(t);
  w.rl(["agent", "save", "claude", "9d904862-9219-4a17-a080-297f1c3240b2"], {
    cwd: w.a,
  });
  write(path.join(w.a, "dirty.txt"), "change");
  const report = (args: string[] = [], cwd = w.a) =>
    JSON.parse(w.rl(["status", ...args, "--json"], { cwd }).stdout);
  const status = report();
  assert.equal(status.repository.name, "frontend");
  assert.equal(status.repository.root, w.repo);
  assert.equal(status.repository.base, "origin/develop");
  assert.equal(status.selection, "current checkout");
  assert.deepEqual(status.currentWorkspace, {
    path: w.a,
    branch: "feature/a",
    main: false,
  });
  assert.deepEqual(status.workspaces, { total: 2, dirty: 1, unavailable: 0 });
  assert.deepEqual(status.sessions, { codex: 0, claude: 1 });
  const main = report([], other);
  assert.equal(main.repository.name, "backend");
  assert.equal(main.currentWorkspace.main, true);
  assert.deepEqual(main.sessions, { codex: 0, claude: 0 });
  assert.equal(report([], w.root).selection, "default");
  w.env.RL_REPO = "backend";
  assert.equal(report().selection, "explicit");
  assert.equal(report().currentWorkspace, null);
  delete w.env.RL_REPO;
  const output = w.rl(["status"], { cwd: w.a }).stdout;
  assert.match(output, /Selected via\s+current checkout/);
  assert.match(output, /Workspaces\s+2 total · 1 dirty/);
  assert.match(output, /rl checkout.*rl list/);
  assert.match(output, /rl status --workspace/);
  const workspace = JSON.parse(
    w.rl(["status", "--workspace", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(workspace.branch, "feature/a");
  assert.equal(workspace.sessions.claude.length, 1);
});

test("repository status supports legacy configuration and reports missing workspaces", (t) => {
  const w = new Workspace(t);
  fs.rmSync(w.b, { recursive: true });
  const status = JSON.parse(w.rl(["status", "--json"], { cwd: w.a }).stdout);
  assert.equal(status.repository.name, "example");
  assert.equal(status.repository.registered, false);
  assert.equal(status.workspaces.total, 2);
  assert.equal(status.workspaces.unavailable, 1);
});
