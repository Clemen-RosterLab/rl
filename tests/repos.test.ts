import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, read, write, readJson } from "./helpers.js";
function fixture(t: TestContext) {
  const w = new Workspace(t),
    other = path.join(w.root, "other repository");
  w.command(["git", "init", "-q", "-b", "main", other]);
  w.git(other, "commit", "-q", "--allow-empty", "-m", "Other initial");
  for (const [repo, branch, name] of [
    [w.repo, "develop", "remote-a.git"],
    [other, "main", "remote-b.git"],
  ]) {
    const remote = path.join(w.root, name);
    w.command(["git", "init", "--bare", "-q", remote]);
    w.git(repo, "remote", "add", "origin", remote);
    w.git(repo, "push", "-q", "-u", "origin", branch);
  }
  w.rl(["repo", "add", "alpha", w.repo, "--base", "origin/develop"]);
  w.rl(["repo", "add", "beta", other, "--base", "origin/main"]);
  return {
    w,
    other,
    overview: (extra: string[] = [], ok = true) =>
      JSON.parse(w.rl(["status", "--all", "--json", ...extra], { ok }).stdout),
  };
}
test("repository routing isolates identical branches and prioritizes current checkout over default", (t) => {
  const { w, other } = fixture(t);
  for (const name of ["alpha", "beta"])
    w.rl(["--repo", name, "new", "same-task"]);
  const alpha = path.join(w.root, "worktrees/example/same-task"),
    beta = path.join(w.root, "worktrees/beta/same-task"),
    [sidA, sidB] = [randomUUID(), randomUUID()];
  w.rl(["session", "add", "codex", sidA], { cwd: alpha });
  w.rl(["session", "add", "codex", sidB], { cwd: beta });
  w.rl(["repo", "use", "beta"]);
  w.rl(["resume", "codex"], { cwd: alpha });
  w.rl(["resume", "codex"], { cwd: beta });
  assert.deepEqual(
    w.calls().map((c) => c.argv[2]),
    [sidA, sidB],
  );
  assert.deepEqual(
    new Set(
      JSON.parse(w.rl(["instances"]).stdout).map(
        (r: { repository: string }) => r.repository,
      ),
    ),
    new Set([other]),
  );
  const sub = path.join(alpha, "nested");
  fs.mkdirSync(sub);
  assert.equal(w.status(sub).repository, w.repo);
  w.rl(["--repo", "alpha", "delete", "same-task"]);
  assert.ok(!fs.existsSync(alpha));
  assert.equal(w.status(beta).sessions.codex[0].id, sidB);
});
test("registry validation and unregister preserve state and explicit hook identity", (t) => {
  const { w, other } = fixture(t);
  assert.equal(
    JSON.parse(w.rl(["repo", "list", "--json"]).stdout).repositories.alpha
      .worktreeName,
    "example",
  );
  w.rl(["repo", "add", "duplicate", w.repo], { ok: false });
  w.rl(["repo", "add", "../escape", other], { ok: false });
  w.rl(["--repo", "missing", "new", "task"], { ok: false });
  const before = w.status();
  w.rl(["repo", "remove", "alpha"]);
  const sid = randomUUID();
  w.hook("codex", sid);
  assert.equal(
    readJson(path.join(before.stateDirectory, "instance.json")).sessions
      .codex[0].id,
    sid,
  );
  w.rl(["repo", "add", "alpha", w.repo]);
  assert.equal(w.status().key, before.key);
});
test("overview reports staged, unstaged, untracked and diverged upstream counts", (t) => {
  const { w, overview } = fixture(t),
    file = path.join(w.a, "tracked.txt");
  write(file, "base\n");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-q", "-m", "Base");
  w.git(w.a, "branch", "comparison");
  w.git(w.a, "branch", "--set-upstream-to", "comparison");
  const comparison = path.join(w.root, "comparison");
  w.git(w.repo, "worktree", "add", "-q", comparison, "comparison");
  w.git(comparison, "commit", "-q", "--allow-empty", "-m", "Upstream work");
  w.git(w.a, "commit", "-q", "--allow-empty", "-m", "Local work");
  write(file, "staged\n");
  w.git(w.a, "add", ".");
  write(file, "unstaged\n");
  write(path.join(w.a, "new file.txt"), "untracked");
  const s = w.status().gitStatus;
  assert.deepEqual(
    [s.ahead, s.behind, s.staged, s.unstaged, s.untracked],
    [1, 1, 1, 1, 1],
  );
  assert.equal(s.upstream, "comparison");
  assert.equal(s.dirty, true);
  assert.deepEqual(
    overview().instances.find((r: { worktree: string }) => r.worktree === w.a)
      .gitStatus,
    s,
  );
  const table = w.rl(["status", "--all"]).stdout;
  assert.match(table, /1S\/1M\/1\?/);
  assert.match(table, /\+1\/-1/);
});
test("unadopted managed worktrees are visible without state mutations", (t) => {
  const { w, overview } = fixture(t),
    root = path.join(w.root, "worktrees/example/feature/legacy");
  fs.mkdirSync(path.dirname(root), { recursive: true });
  w.git(w.repo, "worktree", "add", "-q", "-b", "feature/legacy", root);
  const row = overview().instances.find(
    (r: { worktree: string }) => r.worktree === root,
  );
  assert.equal(row.status, "unregistered");
  assert.equal(row.gitStatus.dirty, false);
  assert.ok(!fs.existsSync(path.join(root, ".codex")));
});
test("overview exposes detached, switched, missing and archived worktrees", (t) => {
  const { w, overview } = fixture(t);
  const row = () =>
    overview().instances.find((r: { worktree: string }) => r.worktree === w.a);
  w.git(w.a, "checkout", "-q", "--detach");
  assert.equal(row().gitStatus.branch, "(detached)");
  assert.equal(row().gitStatus.branchChanged, true);
  w.git(w.a, "checkout", "-q", "-b", "switched");
  assert.match(w.rl(["status", "--all"]).stdout, /switched \[changed\]/);
  w.git(w.repo, "worktree", "remove", "--force", w.a);
  assert.equal(row().gitStatus.availability, "missing");
  w.rl(["--repo", "beta", "new", "deleted-task"]);
  w.rl(["--repo", "beta", "delete", "deleted-task"]);
  assert.ok(
    !overview().instances.some((r: { id: string }) => r.id === "deleted-task"),
  );
  assert.equal(
    overview(["--include-deleted"]).instances.find(
      (r: { id: string }) => r.id === "deleted-task",
    ).gitStatus.availability,
    "deleted",
  );
});
test("fetch is explicit and failed repositories do not hide successful ones", (t) => {
  const { w, other, overview } = fixture(t);
  w.git(other, "remote", "set-url", "origin", path.join(w.root, "missing.git"));
  assert.deepEqual(overview().errors, []);
  const report = overview(["--fetch"], false);
  assert.ok(
    report.errors.some((e: { repository: string }) => e.repository === "beta"),
  );
  assert.ok(
    report.instances.some(
      (r: { repositoryName: string }) => r.repositoryName === "alpha",
    ),
  );
});
test("rename source with status-like filename is not counted as untracked", (t) => {
  const { w } = fixture(t),
    name = "? misleading\nname";
  write(path.join(w.a, name), "content");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-q", "-m", "Filename");
  w.git(w.a, "mv", name, "renamed");
  assert.equal(w.status().gitStatus.staged, 1);
  assert.equal(w.status().gitStatus.untracked, 0);
});
test("selected overview and corrupt registry fail closed", (t) => {
  const { w, other } = fixture(t);
  const report = JSON.parse(
    w.rl(["--repo", "alpha", "status", "--list", "--json"]).stdout,
  );
  assert.deepEqual(
    new Set(
      report.instances.map((r: { repositoryName: string }) => r.repositoryName),
    ),
    new Set(["alpha"]),
  );
  w.rl(["--repo", "alpha", "status", "--all"], { ok: false });
  const file = path.join(w.state, "repositories.json");
  write(file, "{broken");
  w.rl(["status", "--all"], { ok: false });
  w.rl(["repo", "add", "new", other], { ok: false });
  assert.equal(read(file), "{broken");
});
test("real merge conflicts are counted", (t) => {
  const { w } = fixture(t),
    file = path.join(w.a, "conflict.txt");
  write(file, "base\n");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-q", "-m", "Base");
  w.git(w.a, "branch", "conflicting");
  const other = path.join(w.root, "conflicting");
  w.git(w.repo, "worktree", "add", "-q", other, "conflicting");
  write(path.join(other, "conflict.txt"), "other\n");
  w.git(other, "commit", "-q", "-am", "Other");
  write(file, "local\n");
  w.git(w.a, "commit", "-q", "-am", "Local");
  w.command(["git", "merge", "--no-edit", "conflicting"], {
    cwd: w.a,
    ok: false,
  });
  assert.equal(w.status().gitStatus.conflicts, 1);
});
test("environment selection and linked-worktree registration resolve the correct main repository", (t) => {
  const { w } = fixture(t);
  w.env.RL_REPO = "beta";
  assert.deepEqual(
    JSON.parse(w.rl(["status", "--list", "--json"], { cwd: w.a }).stdout)
      .instances,
    [],
  );
  assert.equal(
    JSON.parse(
      w.rl(["--repo", "alpha", "status", "--list", "--json"], { cwd: w.a })
        .stdout,
    ).instances.length,
    2,
  );
  delete w.env.RL_REPO;
  w.rl(["repo", "remove", "alpha"]);
  w.rl(["repo", "add", "alpha", w.a]);
  assert.equal(
    JSON.parse(w.rl(["repo", "list", "--json"]).stdout).repositories.alpha.root,
    w.repo,
  );
  assert.equal(w.status().branch, "feature/a");
});
