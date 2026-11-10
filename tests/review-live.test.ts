import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ROOT, Workspace, write } from "./helpers.js";
const engine = await import(
  pathToFileURL(path.join(ROOT, "dist/review-live-engine.js")).href
);
const watching = await import(
  pathToFileURL(path.join(ROOT, "dist/review-live-watch.js")).href
);
const terminal = await import(
  pathToFileURL(path.join(ROOT, "dist/review-live.js")).href
);

test("live comparisons retain all source layers, immutable snapshots and checkpoint objects without touching the real index", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "source.txt"), "base\n");
  w.git(w.a, "add", "source.txt");
  w.git(w.a, "commit", "-qm", "Source");
  const base = w.git(w.a, "rev-parse", "HEAD");
  write(path.join(w.a, "source.txt"), "staged\n");
  w.git(w.a, "add", "source.txt");
  write(path.join(w.a, "source.txt"), "working\n");
  write(path.join(w.a, "new file.txt"), "untracked\n");
  const index = w.git(w.a, "rev-parse", "--git-path", "index"),
    before = fs.readFileSync(index);
  const repo = new engine.LiveRepository(w.a),
    first = repo.refresh();
  const comparison = repo.comparison({ kind: "working" }, first),
    files = repo.files(comparison, first);
  assert.deepEqual(
    new Set(files.map((f: any) => f.layer)),
    new Set(["staged", "unstaged", "untracked"]),
  );
  const file = files.find(
    (f: any) => f.path === "source.txt" && f.layer === "unstaged",
  );
  assert.match(repo.patch(file), /\+working/);
  const key = engine.checkpointKey(w.a, first.snapshot.branch);
  engine.saveCheckpoint(w.a, w.state, key, {
    branch: first.snapshot.branch,
    head: base,
    tree: first.snapshot.worktreeTree,
    index: first.snapshot.indexTree,
    label: "frozen source",
  });
  write(path.join(w.a, "source.txt"), "later correction\n");
  w.git(w.a, "gc", "--prune=now");
  const second = repo.refresh();
  assert.notEqual(first.signature, second.signature);
  assert.match(repo.patch(file), /\+working/);
  assert.doesNotMatch(repo.patch(file), /later correction/);
  const checkpoint = engine.loadCheckpoint(w.state, key);
  const since = repo.comparison({ kind: "since", checkpoint }, second);
  assert.match(repo.patch(repo.files(since, second)[0]), /\+later correction/);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), base);
  assert.throws(
    () =>
      engine.loadCheckpoint(
        w.state,
        engine.checkpointKey(w.b, first.snapshot.branch),
      ),
    /No checkpoint/,
  );
  assert.throws(
    () =>
      repo.comparison(
        { kind: "since", checkpoint: { ...checkpoint, branch: "unrelated" } },
        second,
      ),
    /different branch/,
  );
  assert.throws(
    () =>
      repo.comparison(
        { kind: "since", checkpoint: { ...checkpoint, tree: "f".repeat(40) } },
        second,
      ),
    /missing/,
  );
});

test("commit, initial, merge, range, non-main branch and rewritten checkpoints have explicit identities", (t) => {
  const w = new Workspace(t),
    repo = new engine.LiveRepository(w.a);
  const initial = w.git(w.a, "rev-parse", "HEAD");
  write(path.join(w.a, "feature.txt"), "feature\n");
  w.git(w.a, "add", "feature.txt");
  w.git(w.a, "commit", "-qm", "Feature");
  const feature = w.git(w.a, "rev-parse", "HEAD");
  write(path.join(w.b, "other.txt"), "other\n");
  w.git(w.b, "add", "other.txt");
  w.git(w.b, "commit", "-qm", "Other");
  w.git(w.a, "merge", "--no-ff", "-qm", "Merge", "feature/b");
  const state = repo.refresh();
  assert.match(
    repo.comparison({ kind: "commit", sha: initial }, state).label,
    /Initial commit/,
  );
  const merge = repo.comparison(
    { kind: "commit", sha: state.snapshot.head },
    state,
  );
  assert.match(merge.label, /first parent/);
  assert.equal(merge.scopes[0].from, feature);
  const range = repo.comparison(
    { kind: "range", from: initial, to: feature },
    state,
  );
  assert.equal(repo.files(range, state)[0].path, "feature.txt");
  const branch = repo.comparison({ kind: "branch", base: "develop" }, state);
  assert.equal(branch.scopes[0].from, initial);
  assert.equal(repo.files(branch, state).length, 2);
  const key = engine.checkpointKey(w.a, state.snapshot.branch);
  engine.saveCheckpoint(w.a, w.state, key, {
    branch: state.snapshot.branch,
    head: feature,
    tree: feature,
    index: feature,
    label: "commit checkpoint",
  });
  const saved = engine.loadCheckpoint(w.state, key);
  assert.equal(saved.tree, w.git(w.a, "rev-parse", `${feature}^{tree}`));
  const rewritten = repo.comparison(
    {
      kind: "since",
      checkpoint: { ...saved, head: w.git(w.b, "rev-parse", "HEAD") },
    },
    { ...state, snapshot: { ...state.snapshot, head: initial } },
  );
  assert.match(rewritten.label, /history rewritten/);
});

test("unborn repositories and detached HEAD can be reviewed and current worktree identity is enforced", (t) => {
  const w = new Workspace(t);
  const root = path.join(w.root, "unborn");
  w.git(w.root, "init", "-q", "-b", "new", root);
  write(path.join(root, "new.txt"), "first file\n");
  const repo = new engine.LiveRepository(root),
    first = repo.refresh();
  assert.equal(first.snapshot.head, "");
  assert.equal(first.commits.length, 0);
  assert.equal(
    repo.files(repo.comparison({ kind: "working" }, first), first)[0].layer,
    "untracked",
  );
  w.git(w.a, "checkout", "--detach", "-q");
  const detached = new engine.LiveRepository(w.a).refresh();
  assert.equal(detached.snapshot.branch, "(detached)");
  assert.equal(engine.reviewRoot(w.a, w.repo), w.a);
  assert.throws(() => engine.reviewRoot(root, w.repo), /does not belong/);
});

test("watching detects atomic replacement, nested untracked creation, commits, index and branch changes in a linked worktree", async (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "source.txt"), "first\n");
  w.git(w.a, "add", "source.txt");
  w.git(w.a, "commit", "-qm", "First");
  const repo = new engine.LiveRepository(w.a);
  let state = repo.refresh(),
    events = 0;
  const watcher = new watching.ReviewWatcher(() => events++, 100);
  t.after(() => watcher.close());
  watcher.update(state);
  async function changed(action: () => void) {
    const count = events;
    action();
    const deadline = Date.now() + 5000;
    while (events === count && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(events > count, "filesystem event or polling fallback fired");
    const next = repo.refresh();
    assert.notEqual(next.signature, state.signature);
    state = next;
    watcher.update(state);
  }
  await changed(() => {
    write(path.join(w.a, "replacement"), "atomic replacement\n");
    fs.renameSync(path.join(w.a, "replacement"), path.join(w.a, "source.txt"));
  });
  await changed(() => {
    fs.mkdirSync(path.join(w.a, "nested"));
    write(path.join(w.a, "nested/new.txt"), "nested\n");
  });
  assert.ok(state.directories.includes(path.join(w.a, "nested")));
  await changed(() => w.git(w.a, "add", "source.txt"));
  await changed(() => w.git(w.a, "commit", "-qm", "Next"));
  assert.equal(state.commits[0].subject, "Next");
  await changed(() => w.git(w.a, "checkout", "-qb", "changed-branch"));
  assert.equal(state.snapshot.branch, "changed-branch");
  assert.notEqual(state.gitDir, state.commonDir);
});

test("Git worker reports failures without terminating and safely reads a specific worktree", async (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "only-a.txt"), "A\n");
  write(path.join(w.b, "only-b.txt"), "B\n");
  const worker = new Worker(path.join(ROOT, "dist/review-live-worker.js"), {
    workerData: { root: w.a },
  });
  t.after(() => worker.terminate());
  async function request(id: number, op: string, data: object = {}) {
    return new Promise<any>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", resolve);
      worker.postMessage({ id, op, ...data });
    });
  }
  const state = (await request(1, "refresh")).result;
  const result = await request(2, "compare", {
    mode: { kind: "working" },
    state,
  });
  assert.ok(result.result.files.some((f: any) => f.path === "only-a.txt"));
  assert.ok(!result.result.files.some((f: any) => f.path === "only-b.txt"));
  const failure = await request(3, "compare", {
    mode: { kind: "range", from: "missing-ref", to: "HEAD" },
    state,
  });
  assert.ok(failure.error);
  assert.equal(
    (await request(4, "refresh")).result.snapshot.branch,
    "feature/a",
  );
});

test("terminal utilities sanitize control sequences, respect wide characters and locate source lines", () => {
  assert.equal(terminal.terminalText("\x1b[31mred\x1b[0m\x00", 5), "red  ");
  assert.equal(terminal.terminalText("界abc", 4), "界ab");
  assert.equal(
    terminal.sourceLine(
      ["@@ -1,2 +42,3 @@", " context", "+new", "-old", " tail"],
      4,
    ),
    44,
  );
});

test(
  "real terminal keyboard navigation, freeze, live updates, checkpoints, resize and cleanup",
  { timeout: 120000 },
  (t) => {
    const w = new Workspace(t);
    write(path.join(w.a, "live.txt"), "version-one\n");
    const result = w.command(
      [
        "python3",
        path.join(ROOT, "tests/review-live-pty.py"),
        w.a,
        process.execPath,
        path.join(ROOT, "dist/cli.js"),
        w.repo,
        w.state,
        path.join(w.root, "worktrees/example"),
      ],
      { timeoutMs: 90000 },
    );
    assert.match(result.stdout, /PTY:.*passed/);
  },
);

test("CLI revision ranges use the active worktree; explicit PR discovery uses gh and authentication failures keep local data", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "committed.txt"), "commit in A\n");
  w.git(w.a, "add", "committed.txt");
  w.git(w.a, "commit", "-qm", "A change");
  write(path.join(w.a, "local.txt"), "local A\n");
  write(path.join(w.b, "other.txt"), "local B\n");
  const range = JSON.parse(
    w.rl(["review", "--since", "HEAD~1", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(range.root, w.a);
  assert.deepEqual(
    range.files.map((f: any) => f.path),
    ["committed.txt"],
  );
  const offline = JSON.parse(
    w.rl(["review", "--pr", "99", "--json"], { cwd: w.a }).stdout,
  );
  assert.match(offline.warning, /offline/);
  assert.equal(offline.files[0].path, "local.txt");
  const head = w.git(w.a, "rev-parse", "HEAD"),
    base = w.git(w.repo, "rev-parse", "HEAD");
  delete w.env.RL_PR_OFFLINE;
  w.env.GH_REPO = "unrelated/repo";
  w.env.REVIEW_PR_JSON = JSON.stringify({
    number: 99,
    title: "Review A",
    url: "https://github.com/example/repo/pull/99",
    headRefName: "feature/a",
    baseRefName: "develop",
    headRefOid: head,
    baseRefOid: base,
    commits: [{ oid: head }],
    files: [{ path: "committed.txt", additions: 1, deletions: 0 }],
  });
  w.stub(
    "gh",
    `if(process.env.GH_REPO)process.exit(9);if(process.argv[2]!=='pr'||process.argv[3]!=='view'||process.argv[4]!=='99')process.exit(8);console.log(process.env.REVIEW_PR_JSON);`,
  );
  const before = w.git(w.a, "status", "--porcelain"),
    index = fs.readFileSync(w.git(w.a, "rev-parse", "--git-path", "index"));
  const pr = JSON.parse(
    w.rl(["review", "--pr", "99", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(pr.pr.number, 99);
  assert.equal(pr.comparison.target, head);
  assert.deepEqual(
    pr.files.map((f: any) => f.path),
    ["committed.txt"],
  );
  assert.equal(w.git(w.a, "status", "--porcelain"), before);
  assert.deepEqual(
    fs.readFileSync(w.git(w.a, "rev-parse", "--git-path", "index")),
    index,
  );
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), head);
});

test("explicit PR downloads use private refs and preserve the worktree, index, FETCH_HEAD and user branches", (t) => {
  const w = new Workspace(t);
  const remote = path.join(w.root, "pr-source");
  w.git(w.root, "init", "-q", "-b", "target", remote);
  write(path.join(remote, "base.txt"), "base\n");
  w.git(remote, "add", ".");
  w.git(remote, "commit", "-qm", "PR base");
  const base = w.git(remote, "rev-parse", "HEAD");
  write(path.join(remote, "remote-feature.txt"), "remote feature\n");
  w.git(remote, "add", ".");
  w.git(remote, "commit", "-qm", "PR head");
  const head = w.git(remote, "rev-parse", "HEAD");
  w.git(remote, "update-ref", "refs/pull/88/head", head);
  w.git(
    w.a,
    "config",
    `url.${remote}.insteadOf`,
    "https://github.com/example/download.git",
  );
  delete w.env.RL_PR_OFFLINE;
  w.env.REVIEW_PR_JSON = JSON.stringify({
    number: 88,
    title: "Remote review",
    url: "https://github.com/example/download/pull/88",
    headRefName: "feature/remote",
    baseRefName: "target",
    headRefOid: head,
    baseRefOid: base,
    commits: [{ oid: head }],
    files: [{ path: "remote-feature.txt", additions: 1, deletions: 0 }],
  });
  w.stub("gh", "console.log(process.env.REVIEW_PR_JSON)");
  write(path.join(w.a, "agent-work.txt"), "leave untouched\n");
  w.git(w.a, "add", "agent-work.txt");
  const index = w.git(w.a, "rev-parse", "--git-path", "index"),
    before = fs.readFileSync(index),
    localHead = w.git(w.a, "rev-parse", "HEAD"),
    refs = w.git(w.a, "for-each-ref", "refs/heads", "refs/remotes");
  const fetchHead = w.git(w.a, "rev-parse", "--git-path", "FETCH_HEAD");
  write(fetchHead, "keep this fetch record\n");
  const result = JSON.parse(
    w.rl(["review", "--pr", "88", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(result.comparison.target, head);
  assert.equal(result.files[0].path, "remote-feature.txt");
  assert.equal(w.git(w.a, "rev-parse", "refs/rl/live-pr/88/head"), head);
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), localHead);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.equal(fs.readFileSync(fetchHead, "utf8"), "keep this fetch record\n");
  assert.equal(w.git(w.a, "for-each-ref", "refs/heads", "refs/remotes"), refs);
  assert.equal(
    fs.readFileSync(path.join(w.a, "agent-work.txt"), "utf8"),
    "leave untouched\n",
  );
});

test("a removed or replaced worktree is never silently replaced with another repository", (t) => {
  const w = new Workspace(t),
    repo = new engine.LiveRepository(w.a, w.repo);
  repo.refresh();
  fs.renameSync(path.join(w.a, ".git"), path.join(w.a, "saved-git-metadata"));
  w.git(w.root, "init", "-q", "-b", "unrelated", w.a);
  assert.throws(() => repo.refresh(), /identity changed/);
});

test("frozen source and index survive aggressive Git GC until explicitly released", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "frozen.txt"), "exact inspected content\n");
  const repo = new engine.LiveRepository(w.a),
    state = repo.refresh(),
    comparison = repo.comparison({ kind: "working" }, state),
    file = repo.files(comparison, state)[0];
  repo.freeze(state.snapshot, comparison.target);
  write(path.join(w.a, "frozen.txt"), "new content after freeze\n");
  w.git(w.a, "gc", "--prune=now");
  assert.match(repo.patch(file), /\+exact inspected content/);
  repo.releaseFreeze();
  assert.equal(w.git(w.a, "for-each-ref", "refs/rl/live-freeze"), "");
});

test("very large patches are bounded and explicitly report truncation", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "large.txt"), "large source ".repeat(750000) + "\n");
  const repo = new engine.LiveRepository(w.a),
    state = repo.refresh(),
    file = repo.files(repo.comparison({ kind: "working" }, state), state)[0];
  const patch = repo.patch(file);
  assert.match(patch, /Diff truncated at 8 MiB/);
  assert.ok(patch.length < 9 * 1024 * 1024);
});

test("frozen commit comparisons survive a rewritten branch and expired reflogs", (t) => {
  const w = new Workspace(t),
    base = w.git(w.a, "rev-parse", "HEAD");
  write(path.join(w.a, "old-feature.txt"), "old reviewed commit\n");
  w.git(w.a, "add", "old-feature.txt");
  w.git(w.a, "commit", "-qm", "Reviewed feature");
  const repo = new engine.LiveRepository(w.a),
    state = repo.refresh(),
    comparison = repo.comparison(
      { kind: "commit", sha: state.snapshot.head },
      state,
    ),
    file = repo.files(comparison, state)[0];
  repo.freeze(
    state.snapshot,
    comparison.target,
    comparison.scopes.flatMap((s: any) => [s.from, s.to]),
  );
  w.git(w.a, "reset", "--hard", base);
  w.git(w.a, "reflog", "expire", "--expire=now", "--all");
  w.git(w.a, "gc", "--prune=now");
  assert.match(repo.patch(file), /\+old reviewed commit/);
  repo.releaseFreeze();
});
