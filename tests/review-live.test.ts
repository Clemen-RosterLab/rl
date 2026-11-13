import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { CLI, ROOT, Workspace, write } from "./helpers.js";
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

test(
  "Git worker reports failures without terminating and safely reads a specific worktree",
  { timeout: 30000 },
  async (t) => {
    const w = new Workspace(t);
    write(path.join(w.a, "only-a.txt"), "A\n");
    write(path.join(w.b, "only-b.txt"), "B\n");
    const worker = fork(path.join(ROOT, "dist/review-live-worker.js"), [w.a]);
    t.after(() => {
      worker.kill();
    });
    const ready = await new Promise<any>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    assert.equal(ready.ready, true);
    async function request(id: number, op: string, data: object = {}) {
      return new Promise<any>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", resolve);
        worker.send({ id, op, ...data });
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
  },
);

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

test(
  "real terminal clicks select files, faster wheel and held scrollbar drags scroll independently, and expansion restores positions",
  { timeout: 120000 },
  (t) => {
    const w = new Workspace(t);
    for (const name of ["a", "b"])
      write(
        path.join(w.a, `${name}.txt`),
        Array.from(
          { length: 120 },
          (_, i) => `${name}${String(i + 1).padStart(3, "0")}`,
        ).join("\n") + "\n",
      );
    w.git(w.a, "add", "a.txt", "b.txt");
    w.git(w.a, "commit", "-qm", "Reviewable source");
    write(path.join(w.a, "skipped.txt"), "middle-only\n");
    w.git(w.a, "add", "skipped.txt");
    w.git(w.a, "commit", "-qm", "Middle source");
    write(path.join(w.a, "latest.txt"), "latest-only\n");
    w.git(w.a, "add", "latest.txt");
    w.git(w.a, "commit", "-qm", "Latest source");
    const firstFile = path.join(w.a, "a.txt");
    write(
      firstFile,
      fs.readFileSync(firstFile, "utf8").replace("a120\n", "++working-a\n"),
    );
    fs.appendFileSync(path.join(w.a, "b.txt"), "working-b\n");
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
        "mouse",
      ],
      { timeoutMs: 90000 },
    );
    assert.match(result.stdout, /PTY: mouse.*passed/);
  },
);

test(
  "file filters retain selection and live updates, support configurable categories and persist across TUI launches",
  { timeout: 120000 },
  (t) => {
    const w = new Workspace(t);
    write(path.join(w.a, "deleted.spec.ts"), "deleted test\n");
    write(path.join(w.a, "old.ts"), "renamed test\n");
    w.git(w.a, "add", ".");
    w.git(w.a, "commit", "-qm", "Initial test sources");
    w.git(w.a, "rm", "deleted.spec.ts");
    w.git(w.a, "mv", "old.ts", "renamed.test.ts");
    write(
      path.join(w.a, "source.ts"),
      Array.from({ length: 80 }, (_, i) => `source${i + 1}`).join("\n") + "\n",
    );
    write(path.join(w.a, "source.test.ts"), "test-one\n");
    write(path.join(w.a, "styles.css"), ".box { color: red; }\n");
    write(path.join(w.a, "package-lock.json"), "{}\n");
    write(
      path.join(w.a, "types.generated.ts"),
      "export type Value = string;\n",
    );
    fs.mkdirSync(path.join(w.a, "tests"));
    write(path.join(w.a, "tests/helper.ts"), "test helper\n");
    w.git(w.a, "add", ".");
    w.git(w.a, "commit", "-qm", "Mixed source and tests");
    write(path.join(w.a, "tests/only.spec.ts"), "only-test\n");
    w.git(w.a, "add", ".");
    w.git(w.a, "commit", "-qm", "Tests only");
    fs.appendFileSync(path.join(w.a, "source.ts"), "live-source\n");
    fs.appendFileSync(path.join(w.a, "source.test.ts"), "live-test\n");
    fs.appendFileSync(path.join(w.a, "styles.css"), ".box { color: green; }\n");
    fs.appendFileSync(path.join(w.a, "package-lock.json"), " ");
    fs.appendFileSync(
      path.join(w.a, "types.generated.ts"),
      "export type Other = number;\n",
    );
    write(path.join(w.a, "tests/new.spec.ts"), "untracked-test\n");
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
        "filter",
      ],
      { timeoutMs: 90000 },
    );
    assert.match(result.stdout, /PTY: filter.*passed/);
    const reopened = w.command(
      [
        "python3",
        path.join(ROOT, "tests/review-live-pty.py"),
        w.a,
        process.execPath,
        path.join(ROOT, "dist/cli.js"),
        w.repo,
        w.state,
        path.join(w.root, "worktrees/example"),
        "filter-reopen",
      ],
      { timeoutMs: 45000 },
    );
    assert.match(reopened.stdout, /PTY: filter-reopen.*passed/);
  },
);

test(
  "preview text selection and copy survive live edits, panel dragging resizes, and expanded keyboard navigation preserves file positions",
  { timeout: 120000 },
  (t) => {
    const w = new Workspace(t);
    write(
      path.join(w.a, "a.txt"),
      "alpha 界é\tomega\n" +
        Array.from(
          { length: 99 },
          (_, i) => `a${String(i + 2).padStart(3, "0")}`,
        ).join("\n") +
        "\n",
    );
    write(
      path.join(w.a, "b.txt"),
      "beta\n" +
        Array.from(
          { length: 99 },
          (_, i) => `b${String(i + 2).padStart(3, "0")}`,
        ).join("\n") +
        "\n",
    );
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
        "preview",
      ],
      { timeoutMs: 90000 },
    );
    assert.match(result.stdout, /PTY: preview.*passed/);
  },
);

test("preview selection uses terminal columns, preserves Unicode and tabs, and layout widths stay bounded", async () => {
  const { reviewSelectedText, reviewTextColumn, reviewLayout } = await import(
    pathToFileURL(path.join(ROOT, "dist/review-live-view.js")).href
  );
  const lines = ["+界é\tblue", "+next"];
  assert.equal(
    reviewSelectedText({
      lines,
      anchor: { line: 0, column: 1 },
      end: { line: 0, column: 4 },
    }),
    "界é",
  );
  assert.equal(
    reviewSelectedText({
      lines,
      anchor: { line: 1, column: 3 },
      end: { line: 0, column: 3 },
    }),
    "é    blue\n+ne",
  );
  assert.equal(reviewTextColumn("界é\tblue", 1), 0);
  assert.equal(reviewTextColumn("界é\tblue", 3), 3);
  assert.equal(reviewLayout(100, 34, 2, false, -100).commits.width, 24);
  assert.ok(reviewLayout(100, 34, 2, false, 10000).diff.width >= 35);
  assert.equal(reviewLayout(70, 24, 2, false, 40).divider, undefined);
  assert.equal(reviewLayout(160, 34, 2, true, 40).viewport.width, 155);
});

test("review filter preferences are atomic, worktree-scoped and validated; disabled categories and show-all preserve files", async (t) => {
  const w = new Workspace(t);
  const preferences = await import(
    pathToFileURL(path.join(ROOT, "dist/review-live-files.js")).href
  );
  const directory = path.join(w.root, "review-preferences");
  const defaults = preferences.loadReviewFilters(directory, w.a);
  assert.deepEqual(defaults, { test: true, style: true, boilerplate: true });
  const configured = { test: true, style: false, boilerplate: false };
  preferences.saveReviewFilters(directory, w.a, configured);
  assert.deepEqual(preferences.loadReviewFilters(directory, w.a), configured);
  assert.deepEqual(preferences.loadReviewFilters(directory, w.b), defaults);
  const files = [
    { path: "source.ts", key: "source" },
    { path: "source.test.ts", key: "test" },
    { path: "source.css", key: "style" },
    { path: "package-lock.json", key: "boilerplate" },
  ];
  assert.deepEqual(
    preferences
      .visibleReviewFiles(files, true, configured)
      .map((file: any) => file.key),
    ["source", "style", "boilerplate"],
  );
  assert.equal(preferences.visibleReviewFiles(files, false, configured), files);
  const saved = preferences.reviewFilterFile(directory, w.a);
  fs.writeFileSync(
    saved,
    JSON.stringify({ version: 1, hidden: { test: "false" } }),
  );
  assert.throws(
    () => preferences.loadReviewFilters(directory, w.a),
    /Invalid review filter/,
  );
  fs.writeFileSync(
    saved,
    JSON.stringify({ version: 1, hidden: { style: false } }),
  );
  assert.deepEqual(preferences.loadReviewFilters(directory, w.a), {
    test: true,
    style: false,
    boilerplate: true,
  });
  const outside = path.join(w.root, "outside.json");
  fs.writeFileSync(outside, "untouched");
  fs.unlinkSync(saved);
  fs.symlinkSync(outside, saved);
  assert.throws(
    () => preferences.saveReviewFilters(directory, w.a, configured),
    /symlinks/,
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
});

test("file visibility recognises conventional test, style and boilerplate paths while retaining source and configuration", async () => {
  const { isReviewTestPath, reviewFileCategory, visibleReviewFiles } =
    await import(
      pathToFileURL(path.join(ROOT, "dist/review-live-files.js")).href
    );
  for (const file of [
    "tests/helpers.ts",
    "src/__tests__/helpers.ts",
    "src/__mocks__/service.ts",
    "src/__snapshots__/view.snap",
    "e2e/login.ts",
    "cypress/support.ts",
    "spec/helpers.rb",
    "src/service.test.ts",
    "src/view.spec.tsx",
    "src/service_test.go",
    "test_service.py",
    "service_test.py",
    "src/ServiceTests.cs",
    "src/ServiceTest.java",
    "src/TestService.java",
    "src/ServiceSpec.scala",
    "nested\\tests\\helpers.ts",
  ])
    assert.equal(isReviewTestPath(file), true, file);
  for (const file of [
    "src/service.ts",
    "src/latest.ts",
    "src/contest.ts",
    "src/testimonials.ts",
    "src/testing.ts",
    "fixtures/production.json",
    "package.json",
  ])
    assert.equal(isReviewTestPath(file), false, file);
  for (const file of [
    "src/base.css",
    "src/view.module.scss",
    "src/view.sass",
    "src/site.less",
    "src/variables.styl",
    "src/theme.pcss",
    "src/view.styles.ts",
    "src/theme.css.ts",
  ])
    assert.equal(reviewFileCategory(file), "style", file);
  for (const file of [
    "package-lock.json",
    "nested/pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "Cargo.lock",
    "go.sum",
    "Gemfile.lock",
    "composer.lock",
    "uv.lock",
    "src/__generated__/api.ts",
    "src/generated/api.ts",
    "dist/app.js",
    "src/api.generated.ts",
    "src/types.gen.ts",
    "src/Form.Designer.cs",
    "src/types.g.cs",
    "app.js.map",
    "app.min.js",
    "cache.tsbuildinfo",
    ".gitkeep",
  ])
    assert.equal(reviewFileCategory(file), "boilerplate", file);
  for (const file of [
    "src/index.ts",
    "src/service.ts",
    "src/GeneratedReport.ts",
    "src/styles.ts",
    "src/styles/service.ts",
    "package.json",
    "tsconfig.json",
    "tailwind.config.js",
    "src/contracts.d.ts",
    "README.md",
  ])
    assert.equal(reviewFileCategory(file), undefined, file);
  const source = {
    path: "src/service.ts",
    oldPath: "src/service.test.ts",
    key: "source",
  };
  const tests = { path: "tests/helpers.ts", key: "test" };
  const files = [tests, source];
  assert.equal(visibleReviewFiles(files, false), files);
  assert.deepEqual(visibleReviewFiles(files, true), [source]);
  assert.equal(visibleReviewFiles(files, true)[0], source);
  assert.deepEqual(files, [tests, source]);
});

test("mouse packets are removed before keyboard shortcuts, including fragmented UTF-8 and SGR packets", async () => {
  const { ReviewInput } = await import(
    pathToFileURL(path.join(ROOT, "dist/review-live-input.js")).href
  );
  const clicks: any[] = [],
    keys: string[] = [];
  const input = new ReviewInput((event: any) => clicks.push(event));
  input.keys.on("data", (data: Buffer) => keys.push(data.toString()));
  input.feed(Buffer.from("j\x1b["));
  input.feed(Buffer.from("<65;100;12M\x1b[<0;3;4m"));
  const text = Buffer.from("界");
  input.feed(text.subarray(0, 1));
  input.feed(text.subarray(1));
  input.feed(Buffer.from("k"));
  assert.equal(keys.join(""), "j界k");
  assert.equal(clicks.length, 2);
  assert.deepEqual(clicks[0], { button: 65, x: 99, y: 11, release: false });
  input.close();
});

test("wheel pacing limits bursts, accepts direction changes immediately and keeps panels independent", async () => {
  const { ReviewWheel } = await import(
    pathToFileURL(path.join(ROOT, "dist/review-live-input.js")).href
  );
  const wheel = new ReviewWheel();
  assert.equal(wheel.accept("diff", 1, 0), true);
  for (let at = 1; at < 60; at++)
    assert.equal(wheel.accept("diff", 1, at), false);
  assert.equal(wheel.accept("diff", 1, 60), true);
  assert.equal(wheel.accept("diff", -1, 61), true);
  assert.equal(wheel.accept("files", -1, 62), true);
  assert.equal(wheel.accept("diff", 1, 63), true);
  assert.equal(wheel.accept("diff-horizontal", 1, 64), true);
  assert.equal(wheel.accept("diff", 1, 65), false);
});

test("history is limited to ten recent commits, loads statistics in one Git call and reuses immutable results", (t) => {
  const w = new Workspace(t);
  for (let i = 0; i < 12; i++)
    w.git(w.a, "commit", "-q", "--allow-empty", "-m", `Recent ${i}`);
  w.env.REVIEW_REAL_GIT = w.command(["which", "git"]).stdout.trim();
  w.env.REVIEW_HISTORY_CALLS = path.join(w.root, "history-calls.jsonl");
  w.stub(
    "git",
    `const fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);fs.appendFileSync(process.env.REVIEW_HISTORY_CALLS,JSON.stringify(args)+'\\n');const result=cp.spawnSync(process.env.REVIEW_REAL_GIT,args,{stdio:'inherit'});process.exit(result.status??1);`,
  );
  const result = JSON.parse(
    w.command([
      process.execPath,
      "--input-type=module",
      "-e",
      `import {LiveRepository} from ${JSON.stringify(path.join(ROOT, "dist/review-live-engine.js"))};const repo=new LiveRepository(process.argv[1]);const first=repo.history('HEAD');console.log(JSON.stringify({first,same:repo.history('HEAD')===first}));`,
      w.a,
    ]).stdout,
  );
  assert.equal(result.first.length, 10);
  assert.equal(result.first[0].subject, "Recent 11");
  assert.equal(result.first.at(-1).subject, "Recent 2");
  assert.equal(result.same, true);
  const calls = fs
    .readFileSync(w.env.REVIEW_HISTORY_CALLS!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.filter((args) => args.includes("log")).length, 1);
  assert.ok(
    !calls.some((args) => args.includes("diff") || args.includes("diff-tree")),
    "history does not spawn a diff for every commit",
  );
  const repo = new engine.LiveRepository(w.a),
    state = repo.refresh();
  assert.equal(
    repo.comparison({ kind: "range", from: "HEAD~11", to: "HEAD" }, state)
      .target,
    state.snapshot.head,
  );
});

test("batched history statistics preserve initial, rename, binary and merge commit counts", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "old name.txt"), "one\ntwo\nthree\n");
  w.git(w.a, "add", "old name.txt");
  w.git(w.a, "commit", "-qm", "Original source");
  const original = w.git(w.a, "rev-parse", "HEAD");
  w.git(w.a, "mv", "old name.txt", "new\tname.txt");
  fs.writeFileSync(path.join(w.a, "image.bin"), Buffer.from([0, 1, 2]));
  w.git(w.a, "add", "image.bin");
  w.git(w.a, "commit", "-qm", "Rename and binary");
  const repo = new engine.LiveRepository(w.a),
    history = repo.history("HEAD"),
    head = history[0];
  assert.equal(head.files, 2);
  assert.equal(head.additions, 0);
  assert.equal(head.deletions, 0);
  const source = history.find((commit: any) => commit.sha === original);
  assert.equal(source.files, 1);
  assert.equal(source.additions, 3);
  assert.equal(history.at(-1).files, 0);
  write(path.join(w.b, "merged.txt"), "merged line\n");
  w.git(w.b, "add", "merged.txt");
  w.git(w.b, "commit", "-qm", "Other side");
  w.git(w.a, "merge", "--no-ff", "-qm", "Merge", "feature/b");
  const merge = repo.history("HEAD")[0];
  assert.equal(merge.parents.length, 2);
  assert.equal(merge.files, 1);
  assert.equal(merge.additions, 1);
  assert.equal(merge.deletions, 0);
  assert.deepEqual(repo.history("HEAD", "HEAD"), []);
});

test(
  "Quit cancels a blocked Git refresh and cleans up the frozen review session",
  { timeout: 120000 },
  (t) => {
    const w = new Workspace(t);
    write(path.join(w.a, "live.txt"), "version-one\n");
    w.env.REVIEW_REAL_GIT = w.command(["which", "git"]).stdout.trim();
    w.env.REVIEW_PAUSE_GIT = path.join(w.root, "pause-review-git");
    w.env.REVIEW_GIT_INDEX_MARKER = path.join(w.root, "review-index-marker");
    w.env.REVIEW_GIT_HEARTBEAT = path.join(w.root, "review-git-heartbeat");
    w.stub(
      "git",
      String.raw`
const fs = require("node:fs"), cp = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("read-tree") && process.env.GIT_INDEX_FILE && fs.existsSync(process.env.REVIEW_PAUSE_GIT)) {
  fs.writeFileSync(process.env.REVIEW_GIT_INDEX_MARKER, JSON.stringify(process.env.GIT_INDEX_FILE));
  cp.spawn(process.execPath, ["-e", 'setInterval(() => require("node:fs").writeFileSync(process.env.REVIEW_GIT_HEARTBEAT, "."), 25)'], {stdio:"ignore"});
  setInterval(() => {}, 1000);
} else {
  const result = cp.spawnSync(process.env.REVIEW_REAL_GIT, args, {stdio:"inherit"});
  process.exit(result.status ?? 1);
}
`,
    );
    const result = w.command(
      [
        "python3",
        path.join(ROOT, "tests/review-live-pty.py"),
        w.a,
        process.execPath,
        CLI,
        w.repo,
        w.state,
        path.join(w.root, "worktrees/example"),
        "quit",
      ],
      { timeoutMs: 90000 },
    );
    assert.match(result.stdout, /PTY: quit.*passed/);
  },
);

test(
  "Quit and Ctrl-C drain late mouse packets and immediately cancel stubborn GitHub descendants through the public CLI",
  { timeout: 120000 },
  (t) => {
    for (const quitKey of ["q", "\x03"]) {
      const w = new Workspace(t);
      write(path.join(w.a, "live.txt"), "version-one\n");
      w.env.RL_PR_OFFLINE = "0";
      w.env.REVIEW_QUIT_KEY = quitKey;
      w.env.REVIEW_GH_HEARTBEAT = path.join(w.root, "review-gh-heartbeat");
      w.stub(
        "gh",
        String.raw`
const cp = require('node:child_process');
process.on('SIGTERM', () => {});
cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>require("node:fs").writeFileSync(process.env.REVIEW_GH_HEARTBEAT,"."),10)'], {stdio:'inherit'});
setInterval(() => {}, 1000);
`,
      );
      const result = w.command(
        [
          "python3",
          path.join(ROOT, "tests/review-live-pty.py"),
          w.a,
          process.execPath,
          CLI,
          w.repo,
          w.state,
          path.join(w.root, "worktrees/example"),
          "handoff",
        ],
        { timeoutMs: 45000 },
      );
      assert.match(result.stdout, /PTY: handoff.*passed/);
      assert.match(result.stdout, /QUIT_LATENCY=/);
      t.diagnostic(
        `${quitKey === "q" ? "q" : "Ctrl-C"}: ${result.stdout.match(/QUIT_LATENCY=[\d.]+s/)?.[0]}`,
      );
    }
  },
);

test(
  "Quit returns working input to an interactive shell and repairs inherited raw or no-echo terminal modes",
  { timeout: 120000 },
  (t) => {
    for (const scenario of [
      "terminal-raw",
      "terminal-noecho",
      "shell",
      "shell-function",
    ]) {
      const w = new Workspace(t);
      write(path.join(w.a, "live.txt"), "version-one\n");
      const result = w.command(
        [
          "python3",
          path.join(ROOT, "tests/review-live-pty.py"),
          w.a,
          process.execPath,
          CLI,
          w.repo,
          w.state,
          path.join(w.root, "worktrees/example"),
          scenario,
        ],
        { timeoutMs: 45000 },
      );
      assert.match(result.stdout, new RegExp(`PTY: ${scenario}.*passed`));
    }
  },
);
