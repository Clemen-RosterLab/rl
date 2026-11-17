import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, Workspace, read, readJson, write } from "./helpers.js";

test("repo add clones Git URLs, infers the remote base and enters through the shell protocol", (t) => {
  const w = new Workspace(t, { minimal: true });
  write(path.join(w.repo, "hello.txt"), "hello\n");
  w.git(w.repo, "add", ".");
  w.git(w.repo, "commit", "-qm", "Content");
  const output = path.join(w.root, "shell-output");
  write(output, "");
  w.env.RL_SHELL_OUTPUT = output;
  w.env.RL_SHELL_PROTOCOL = "v2";
  const source = pathToFileURL(w.repo).href;
  const parent = path.join(w.root, "downloads");
  fs.mkdirSync(parent);
  w.rl(["repo", "add", source], { cwd: parent });
  const clone = path.join(parent, "repo");
  assert.equal(read(output), `cd:${clone}`);
  assert.equal(read(path.join(clone, "hello.txt")), "hello\n");
  const data = readJson(path.join(w.state, "repositories.json"));
  assert.equal(data.default, "repo");
  assert.equal(data.repositories.repo.root, clone);
  assert.equal(data.repositories.repo.base, "origin/develop");
  assert.equal(w.git(clone, "remote", "get-url", "origin"), source);
});

test("HTTPS and SSH add forms clone into the requested directory without shell interpolation", (t) => {
  const w = new Workspace(t, { minimal: true });
  const source = pathToFileURL(w.repo).href;
  const urls = [
    "https://example.invalid/team/project.git",
    "git@example.invalid:team/project.git",
    "git@example.invalid:/team/project.git",
  ];
  for (const [i, url] of urls.entries()) {
    w.env.GIT_CONFIG_COUNT = "1";
    w.env.GIT_CONFIG_KEY_0 = `url.${source}.insteadOf`;
    w.env.GIT_CONFIG_VALUE_0 = url;
    const destination = path.join(w.root, `clone ${i}; $(touch injected)`);
    w.rl(["repo", "add", url, destination, "--alias", `project${i}`]);
    assert.equal(
      w.git(destination, "rev-parse", "HEAD"),
      w.git(w.repo, "rev-parse", "HEAD"),
    );
    assert.equal(
      readJson(path.join(w.state, "repositories.json")).repositories[
        `project${i}`
      ].base,
      "origin/develop",
    );
  }
  assert.ok(!fs.existsSync(path.join(w.root, "injected")));
});

test("repo clone supports local paths and overrides while preserving the existing default", (t) => {
  const w = new Workspace(t, { minimal: true });
  w.rl(["repo", "add", w.repo, "--alias", "original"]);
  const destination = path.join(w.root, "nested", "new checkout");
  const result = w.rl([
    "repo",
    "clone",
    w.repo,
    destination,
    "--alias",
    "copy",
    "--base",
    "origin/custom",
    "--worktree-name",
    "copy-worktrees",
  ]);
  const data = readJson(path.join(w.state, "repositories.json"));
  assert.equal(data.default, "original");
  assert.equal(data.repositories.copy.root, destination);
  assert.equal(data.repositories.copy.base, "origin/custom");
  assert.equal(data.repositories.copy.worktreeName, "copy-worktrees");
  assert.ok(result.stdout.trim().endsWith(destination));
  assert.equal(w.rl(["checkout", "copy"]).stdout.trim(), destination);
});

test("cloning refuses existing destinations and registration collisions without changing them", (t) => {
  const w = new Workspace(t, { minimal: true });
  const before = w.git(w.repo, "status", "--porcelain");
  const empty = path.join(w.root, "empty");
  const link = path.join(w.root, "dangling");
  fs.mkdirSync(empty);
  fs.symlinkSync(path.join(w.root, "missing"), link);
  for (const destination of [w.repo, empty, link]) {
    assert.match(
      w.rl(["repo", "clone", w.repo, destination, "--alias", "copy"], {
        ok: false,
      }).stderr,
      /destination already exists/,
    );
  }
  w.rl(["repo", "add", w.repo, "--alias", "original"]);
  const registry = path.join(w.state, "repositories.json");
  const registered = read(registry);
  const target = path.join(w.root, "new-copy");
  for (const flags of [
    ["--alias", "original"],
    ["--alias", "copy", "--worktree-name", "example"],
    ["--alias", "../bad"],
  ]) {
    w.rl(["repo", "clone", w.repo, target, ...flags], { ok: false });
    assert.ok(!fs.existsSync(target));
    assert.equal(read(registry), registered);
  }
  assert.equal(w.git(w.repo, "status", "--porcelain"), before);
  assert.deepEqual(fs.readdirSync(empty), []);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test("failed cloning leaves the registry and shell destination untouched", (t) => {
  const w = new Workspace(t, { minimal: true });
  const output = path.join(w.root, "shell-output");
  write(output, "");
  w.env.RL_SHELL_OUTPUT = output;
  const failed = w.rl(
    ["repo", "clone", path.join(w.root, "missing.git"), "failed"],
    { ok: false },
  );
  assert.match(failed.stderr, /Git clone failed/);
  assert.equal(read(output), "");
  assert.ok(!fs.existsSync(path.join(w.state, "repositories.json")));
});

test("clone enters the new checkout in zsh and bash", (t) => {
  const w = new Workspace(t, { minimal: true });
  w.env.RL_TEST_CLI = CLI;
  const script = path.join(w.root, "clone-shell");
  for (const shell of ["zsh", "bash"]) {
    w.env.RL_TEST_DESTINATION = path.join(w.root, shell);
    write(
      script,
      `
eval "$("$RL_TEST_CLI" setup shell ${shell})"
rl repo clone "$RL_REPO_ROOT" "$RL_TEST_DESTINATION" --alias ${shell} || exit 10
[[ "$PWD" == "$RL_TEST_DESTINATION" ]] || exit 11
`,
    );
    w.command([shell, shell === "zsh" ? "-f" : "--norc", script]);
  }
});

test("a registration collision during cloning keeps the checkout and never switches the shell", (t) => {
  const w = new Workspace(t, { minimal: true });
  w.rl(["repo", "add", w.repo, "--alias", "original"]);
  const registry = path.join(w.state, "repositories.json");
  const output = path.join(w.root, "shell-output");
  write(output, "");
  w.env.RL_SHELL_OUTPUT = output;
  w.env.CLONE_TEST_GIT = w.command(["which", "git"]).stdout.trim();
  w.env.CLONE_TEST_REGISTRY = registry;
  w.stub(
    "git",
    `
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(process.env.CLONE_TEST_GIT, args, {stdio:'inherit'});
if (args[0] === 'clone' && result.status === 0) {
  const file = process.env.CLONE_TEST_REGISTRY;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.repositories.copy = {...data.repositories.original, worktreeName:'copy'};
  delete data.repositories.original;
  data.default = 'copy';
  fs.writeFileSync(file, JSON.stringify(data));
}
process.exit(result.status ?? 1);
`,
  );
  const destination = path.join(w.root, "retained-clone");
  const result = w.rl(
    ["repo", "clone", w.repo, destination, "--alias", "copy"],
    { ok: false },
  );
  assert.match(result.stderr, /registration failed.*already registered/);
  assert.equal(
    w.git(destination, "rev-parse", "HEAD"),
    w.git(w.repo, "rev-parse", "HEAD"),
  );
  assert.equal(readJson(registry).repositories.copy.root, w.repo);
  assert.equal(read(output), "");
});

test("clone supports empty remotes and documents the command without repository setup", (t) => {
  const w = new Workspace(t, { minimal: true });
  const empty = path.join(w.root, "empty.git");
  w.command(["git", "init", "--bare", "-q", "-b", "trunk", empty]);
  w.rl(["repo", "clone", empty, "empty-copy", "--alias", "empty"]);
  assert.equal(
    readJson(path.join(w.state, "repositories.json")).repositories.empty.base,
    "trunk",
  );
  w.env.RL_CONFIG = path.join(w.root, "missing-config");
  assert.match(
    w.rl(["repo", "clone", "--help"]).stdout,
    /Clone, register and enter/,
  );
});
