import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, CLI, Workspace, write } from "./helpers.js";

const url = (name: string) =>
  pathToFileURL(path.join(ROOT, `dist/${name}.js`)).href;
const remote = await import(url("review-remote"));
const { LiveRepository, saveCheckpoint, loadCheckpoint, checkpointKey } =
  await import(url("review-live-engine"));
const { ReviewPreview } = await import(url("review-live-preview"));

function source(w: Workspace) {
  write(path.join(w.repo, "unchanged.txt"), "unchanged payload\n".repeat(500));
  w.git(w.repo, "add", ".");
  w.git(w.repo, "commit", "-qm", "Base payload");
  w.git(w.a, "merge", "--ff-only", "develop");
  const base = w.git(w.a, "rev-parse", "HEAD");
  write(path.join(w.a, "pr-only.txt"), "remote version one\n");
  w.git(w.a, "add", "pr-only.txt");
  w.git(w.a, "commit", "-qm", "PR source");
  const head = w.git(w.a, "rev-parse", "HEAD");
  w.git(w.repo, "update-ref", "refs/pull/99/head", head);
  w.git(w.repo, "config", "uploadpack.allowFilter", "true");
  return { base, head };
}
function github(w: Workspace, base: string, head: string) {
  delete w.env.RL_PR_OFFLINE;
  w.env.REVIEW_METADATA_FILE = path.join(w.root, "pr-metadata.json");
  w.env.REVIEW_SOURCE = pathToFileURL(w.repo).href;
  w.env.REVIEW_REAL_GIT = w.command(["which", "git"]).stdout.trim();
  w.env.REVIEW_GH_LOG = path.join(w.root, "gh.jsonl");
  const metadata = {
    number: 99,
    title: "Remote review",
    url: "https://github.com/example/repo/pull/99",
    headRefName: "feature/a",
    baseRefName: "develop",
    headRefOid: head,
    baseRefOid: base,
    commits: [{ oid: head }],
    files: [],
  };
  write(w.env.REVIEW_METADATA_FILE, JSON.stringify(metadata));
  w.stub(
    "gh",
    `const fs=require('node:fs');fs.appendFileSync(process.env.REVIEW_GH_LOG,JSON.stringify(process.argv.slice(2))+'\\n');if(process.env.REVIEW_AUTH_FAIL){console.error('Authenticate with gh auth login');process.exit(1)}console.log(fs.readFileSync(process.env.REVIEW_METADATA_FILE,'utf8'));`,
  );
  // A real Git upload-pack transport, redirected only inside this fixture.
  write(
    path.join(w.bin, "git"),
    `#!/bin/sh\nexec "$REVIEW_REAL_GIT" -c "url.$REVIEW_SOURCE.insteadOf=https://github.com/example/repo.git" "$@"\n`,
  );
  fs.chmodSync(path.join(w.bin, "git"), 0o755);
  return metadata;
}
function review(w: Workspace, args: string[] = []) {
  return JSON.parse(
    w.rl(
      [
        "review",
        "--pr",
        "99",
        "--github-repo",
        "example/repo",
        "--json",
        ...args,
      ],
      { cwd: w.root, timeoutMs: 60000 },
    ).stdout,
  );
}

test("remote selectors accept a number/repository or URL and reject ambiguous or mismatched identities", () => {
  assert.deepEqual(remote.remoteReviewTarget("99", "Example/Repo"), {
    repository: "github.com/example/repo",
    number: 99,
    url: "https://github.com/example/repo",
  });
  assert.equal(
    remote.remoteReviewTarget(
      "https://github.com/Example/Repo/pull/99/files?diff=split#x",
    ).number,
    99,
  );
  assert.throws(() => remote.remoteReviewTarget("99"), /Cannot determine/);
  assert.throws(() => remote.remoteReviewTarget("99", "../repo"), /Expected/);
  assert.throws(
    () =>
      remote.remoteReviewTarget(
        "https://github.com/example/repo/pull/99",
        "other/repo",
      ),
    /different repositories/,
  );
  assert.throws(
    () =>
      remote.remoteReviewTarget(
        "https://secret@github.com/example/repo/pull/99",
      ),
    /Expected/,
  );
  assert.equal(remote.remoteReviewRequested(["--pr", "99"]), true);
  assert.equal(remote.remoteReviewRequested(["--pr", "99", "--local"]), false);
});

test("--pr reviews remote Git objects from outside a checkout without touching any local worktree or index", async (t) => {
  const w = new Workspace(t),
    { base, head } = source(w);
  github(w, base, head);
  w.env.RL_REPO_ROOT = path.join(w.root, "no-client-checkout");
  w.env.RL_REPO = "unregistered-client-repository";
  write(path.join(w.a, "pr-only.txt"), "uncommitted local agent edits\n");
  const before = w.git(w.a, "status", "--porcelain"),
    index = fs.readFileSync(w.git(w.a, "rev-parse", "--git-path", "index")),
    branches = w.git(w.repo, "show-ref", "--heads");
  const result = review(w);
  assert.equal(result.source, "remote");
  assert.equal(result.checkout, false);
  assert.equal(w.git(result.root, "rev-parse", "--is-bare-repository"), "true");
  assert.deepEqual(
    w.git(result.root, "for-each-ref", "--format=%(refname)", "refs/heads"),
    "",
  );
  assert.ok(!fs.existsSync(path.join(result.root, "index")));
  assert.ok(!fs.existsSync(path.join(result.root, "pr-only.txt")));
  assert.equal(result.snapshot.head, head);
  assert.deepEqual(
    result.files.map((f: any) => f.path),
    ["pr-only.txt"],
  );
  assert.equal(result.commits[0].sha, head);
  assert.equal(w.git(w.a, "status", "--porcelain"), before);
  assert.deepEqual(
    fs.readFileSync(w.git(w.a, "rev-parse", "--git-path", "index")),
    index,
  );
  assert.equal(w.git(w.repo, "show-ref", "--heads"), branches);
  assert.equal(
    w.git(result.root, "config", "remote.origin.partialclonefilter"),
    "blob:none",
  );
  const untouchedBlob = w.git(w.repo, "rev-parse", `${base}:unchanged.txt`);
  assert.ok(
    w
      .git(result.root, "rev-list", "--objects", "--missing=print", head)
      .includes(`?${untouchedBlob}`),
    "Unchanged file contents should remain on the remote",
  );
  assert.equal(
    w.git(result.root, "config", "credential.https://github.com.helper"),
    "!gh auth git-credential",
  );
  const reader = new ReviewPreview(result.root);
  t.after(() => reader.close());
  const patch = await reader.read(result.files[0], {
    gitDir: result.root,
    context: 3,
  });
  assert.match(patch, /\+remote version one/);
  assert.doesNotMatch(patch, /agent edits/);
  const args = JSON.parse(
    fs.readFileSync(w.env.REVIEW_GH_LOG!, "utf8").trim().split("\n")[0],
  );
  assert.equal(args[args.indexOf("--repo") + 1], "github.com/example/repo");
});

test("PR URLs work outside Git, infer no local state, and explicit numbers can use the current origin", (t) => {
  const w = new Workspace(t),
    { base, head } = source(w);
  github(w, base, head);
  const explicit = JSON.parse(
    w.rl(
      ["review", "--pr", "https://github.com/example/repo/pull/99", "--json"],
      { cwd: w.root, timeoutMs: 60000 },
    ).stdout,
  );
  const missing = w.rl(["review", "--pr", "99", "--json"], {
    cwd: w.root,
    ok: false,
  });
  assert.match(missing.stderr, /--github-repo/);
  w.git(w.a, "remote", "add", "origin", "https://github.com/example/repo.git");
  const inferred = JSON.parse(
    w.rl(["review", "--pr", "99", "--json"], { cwd: w.a, timeoutMs: 60000 })
      .stdout,
  );
  assert.equal(inferred.root, explicit.root);
});

test("remote checkpoints retain exact old PR heads through force pushes and cache reuse", async (t) => {
  const w = new Workspace(t),
    { base, head } = source(w),
    metadata = github(w, base, head);
  const first = review(w),
    repository = new LiveRepository(first.root, first.root, { remote: 99 }),
    initial = repository.remoteState(head, base);
  const directory = path.dirname(first.root),
    key = checkpointKey(first.root, initial.snapshot.branch, 99);
  saveCheckpoint(first.root, directory, key, {
    branch: initial.snapshot.branch,
    head,
    tree: head,
    index: head,
    label: "First PR pass",
  });
  w.git(w.a, "reset", "--hard", base);
  write(path.join(w.a, "pr-only.txt"), "rebased version two\n");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-qm", "Rewritten PR");
  const next = w.git(w.a, "rev-parse", "HEAD");
  w.git(w.repo, "update-ref", "refs/pull/99/head", next);
  write(
    w.env.REVIEW_METADATA_FILE!,
    JSON.stringify({ ...metadata, headRefOid: next, commits: [{ oid: next }] }),
  );
  const updated = review(w);
  assert.equal(updated.root, first.root);
  assert.equal(updated.snapshot.head, next);
  w.git(first.root, "gc", "--prune=now");
  const current = repository.remoteState(next, base),
    comparison = repository.comparison(
      { kind: "since", checkpoint: loadCheckpoint(directory, key) },
      current,
    );
  assert.match(comparison.label, /history rewritten/);
  assert.equal(comparison.scopes.length, 1);
  assert.match(
    repository.patch(repository.files(comparison, current)[0]),
    /-remote version one/,
  );
  assert.match(
    repository.patch(repository.files(comparison, current)[0]),
    /\+rebased version two/,
  );
  const range = repository.comparison(
    { kind: "range", from: "BASE", to: "HEAD" },
    current,
  );
  assert.equal(range.target, next);
  assert.equal(range.scopes[0].from, base);
  assert.throws(
    () => repository.comparison({ kind: "working" }, current),
    /no working tree/,
  );
});

test("remote authentication and wrong-PR responses fail clearly instead of showing a local diff", (t) => {
  const w = new Workspace(t),
    { base, head } = source(w),
    metadata = github(w, base, head);
  w.env.REVIEW_AUTH_FAIL = "1";
  const failed = w.rl(
    ["review", "--pr", "99", "--github-repo", "example/repo", "--json"],
    { cwd: w.root, ok: false, timeoutMs: 60000 },
  );
  assert.match(failed.stderr, /gh auth login/);
  assert.equal(failed.stdout, "");
  delete w.env.REVIEW_AUTH_FAIL;
  write(
    w.env.REVIEW_METADATA_FILE!,
    JSON.stringify({
      ...metadata,
      url: "https://github.com/foreign/repo/pull/99",
    }),
  );
  const mismatch = w.rl(
    ["review", "--pr", "99", "--github-repo", "example/repo", "--json"],
    { cwd: w.root, ok: false, timeoutMs: 60000 },
  );
  assert.match(mismatch.stderr, /requested repository/);
});

test(
  "remote TUI navigation, checkpoints, polling and freeze work without a checkout",
  { timeout: 120000 },
  (t) => {
    const w = new Workspace(t),
      { base, head } = source(w);
    github(w, base, head);
    w.env.REVIEW_BASE = base;
    w.env.REVIEW_PR_WORKTREE = w.a;
    w.env.REVIEW_CODE_CAPTURE = path.join(w.root, "code-args.json");
    w.stub(
      "code",
      `require('node:fs').writeFileSync(process.env.REVIEW_CODE_CAPTURE,JSON.stringify(process.argv.slice(2)));`,
    );
    const result = w.command(
      [
        "python3",
        path.join(ROOT, "tests/review-live-pty.py"),
        w.root,
        process.execPath,
        CLI,
        w.repo,
        w.state,
        path.join(w.root, "worktrees/example"),
        "remote-pr",
      ],
      { timeoutMs: 110000 },
    );
    assert.match(result.stdout, /PTY: remote-pr.*passed/);
  },
);
