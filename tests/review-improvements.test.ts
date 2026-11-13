import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, ROOT, Workspace, write } from "./helpers.js";

const moduleURL = (name: string) =>
  pathToFileURL(path.join(ROOT, `dist/${name}.js`)).href;
const engine = await import(moduleURL("review-live-engine"));
const progress = await import(moduleURL("review-progress"));
const settings = await import(moduleURL("review-live-files"));
const searching = await import(moduleURL("review-search"));
const ranking = await import(moduleURL("review-ranking"));
const history = await import(moduleURL("review-history"));
const stores = await import(moduleURL("store"));
const reviews = await import(moduleURL("review-store"));

test("deferred cleanup removes only its own frozen refs when Git is slow", (t) => {
  const w = new Workspace(t);
  const firstId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    secondId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const first = new engine.LiveRepository(w.a, w.repo, { freezeId: firstId });
  const second = new engine.LiveRepository(w.a, w.repo, { freezeId: secondId });
  const state = first.refresh();
  first.freeze(state.snapshot, state.snapshot.worktreeTree);
  second.freeze(state.snapshot, state.snapshot.worktreeTree);
  w.env.REVIEW_REAL_GIT = w.command(["which", "git"]).stdout.trim();
  w.stub(
    "git",
    `const cp=require('node:child_process');setTimeout(()=>{const result=cp.spawnSync(process.env.REVIEW_REAL_GIT,process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(result.status??1);},200);`,
  );
  w.command([
    process.execPath,
    path.join(ROOT, "dist/review-live-cleanup.js"),
    state.gitDir,
    firstId,
  ]);
  assert.equal(
    w.git(
      w.a,
      "for-each-ref",
      "--format=%(refname)",
      `refs/rl/live-freeze/${firstId}`,
    ),
    "",
  );
  assert.match(
    w.git(
      w.a,
      "for-each-ref",
      "--format=%(refname)",
      `refs/rl/live-freeze/${secondId}`,
    ),
    /trees/,
  );
});

test("source positions distinguish before/after lines and ignore plus signs in hunk summaries", async () => {
  const { sourceLine } = await import(moduleURL("review-live"));
  const { reviewLineNumbers } = await import(moduleURL("review-live-view"));
  const lines = [
    "diff --git a/a b/a",
    "@@ -40,2 +70,2 @@ expression +123",
    "-old",
    "+new",
    " context",
  ];
  assert.equal(sourceLine(lines, 0), 70);
  assert.equal(sourceLine(lines, 2, "before"), 40);
  assert.equal(sourceLine(lines, 4), 71);
  assert.deepEqual(reviewLineNumbers(lines).slice(2), [
    [40, undefined],
    [undefined, 70],
    [41, 71],
  ]);
});

test("large reviewed files open as exact immutable bytes without the preview's memory cap", (t) => {
  const w = new Workspace(t),
    repo = new engine.LiveRepository(w.a);
  const bytes = Buffer.alloc(9 * 1024 * 1024, "a");
  bytes[0] = 0xe9; // Preserve a non-UTF-8 byte instead of re-encoding decoded text.
  fs.writeFileSync(path.join(w.a, "large.txt"), bytes);
  const state = repo.refresh(),
    file = repo
      .files(repo.comparison({ kind: "working" }, state), state)
      .find((file: any) => file.path === "large.txt");
  assert.equal(repo.content(file).truncated, true);
  const cached = repo.editorFile(file, w.state);
  assert.deepEqual(fs.readFileSync(cached), bytes);
  assert.equal(fs.statSync(cached).mode & 0o222, 0);
  assert.equal(
    searching.searchReviewFiles(repo, [file], "aaaa", "changes").limited,
    true,
    "Search must label results from a truncated Git patch",
  );
});

test("a one-file live refresh avoids rebuilding three empty conflict stages per snapshot pass", (t) => {
  const w = new Workspace(t);
  w.env.REVIEW_REAL_GIT = w.command(["which", "git"]).stdout.trim();
  w.env.REVIEW_GIT_CALLS = path.join(w.root, "git-calls.jsonl");
  w.stub(
    "git",
    `const fs=require('node:fs'),cp=require('node:child_process');fs.appendFileSync(process.env.REVIEW_GIT_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');const result=cp.spawnSync(process.env.REVIEW_REAL_GIT,process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(result.status??1);`,
  );
  const script = `import fs from 'node:fs';import {LiveRepository} from ${JSON.stringify(moduleURL("review-live-engine"))};const repo=new LiveRepository(process.cwd());fs.writeFileSync('source.txt','one\\n');repo.refresh();fs.writeFileSync(process.env.REVIEW_GIT_CALLS,'');fs.writeFileSync('source.txt','two\\n');repo.refresh();`;
  w.command([process.execPath, "--input-type=module", "-e", script], {
    cwd: w.a,
  });
  const calls = fs
    .readFileSync(w.env.REVIEW_GIT_CALLS, "utf8")
    .trim()
    .split("\n");
  assert.ok(
    calls.length <= 40,
    `${calls.length} Git processes for one changed file`,
  );
  t.diagnostic(`${calls.length} Git processes, down from the audited 53`);
});

test("file review identities follow blobs, survive unrelated edits and invalidate when either reviewed side changes", (t) => {
  const w = new Workspace(t),
    repo = new engine.LiveRepository(w.a);
  write(path.join(w.a, "logic.ts"), "export const value = 1;\n");
  let state = repo.refresh();
  const key = engine.checkpointKey(w.a, state.snapshot.branch);
  const file = repo
    .files(repo.comparison({ kind: "working" }, state), state)
    .find((file: any) => file.path === "logic.ts");
  let marked = progress.toggleFileReviewed(w.state, key, file);
  assert.ok(progress.isFileReviewed(marked, file));
  write(path.join(w.a, "unrelated.txt"), "unrelated\n");
  state = repo.refresh();
  let next = repo
    .files(repo.comparison({ kind: "working" }, state), state)
    .find((file: any) => file.path === "logic.ts");
  assert.notEqual(next.to, file.to);
  assert.ok(progress.isFileReviewed(marked, next));
  progress.recordFileViewed(w.state, key, file);
  write(path.join(w.a, "logic.ts"), "export const value = 2;\n");
  state = repo.refresh();
  next = repo
    .files(repo.comparison({ kind: "working" }, state), state)
    .find((file: any) => file.path === "logic.ts");
  marked = progress.loadReviewProgress(w.state, key);
  assert.ok(!progress.isFileReviewed(marked, next));
  assert.equal(marked.viewed[file.key].tree, file.to);
  assert.equal(
    progress.loadReviewProgress(
      w.state,
      engine.checkpointKey(w.b, state.snapshot.branch),
    ).viewed[file.key],
    undefined,
  );
  assert.throws(() => progress.progressFile(w.state, "../escape"), /Invalid/);
});

test("reviewed file context and editor files use immutable Git blobs, including deleted, renamed and PR-only files", (t) => {
  const w = new Workspace(t),
    repo = new engine.LiveRepository(w.a);
  write(path.join(w.a, "historical.ts"), "export const historical = 1;\n");
  w.git(w.a, "add", "historical.ts");
  w.git(w.a, "commit", "-qm", "Before");
  const base = w.git(w.a, "rev-parse", "HEAD");
  write(path.join(w.a, "historical.ts"), "export const historical = 2;\n");
  write(path.join(w.a, "remote-only.ts"), "export const remote = 42;\n");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-qm", "Remote version");
  const head = w.git(w.a, "rev-parse", "HEAD");
  w.git(w.a, "checkout", "--detach", "-q", base);
  const state = repo.refresh();
  const files = repo.files(
    repo.comparison({ kind: "range", from: base, to: head }, state),
    state,
  );
  const historical = files.find((file: any) => file.path === "historical.ts");
  assert.match(repo.content(historical).text, /historical = 2/);
  assert.match(repo.content(historical, "before").text, /historical = 1/);
  const editor = repo.editorFile(historical, w.state);
  assert.notEqual(editor, path.join(w.a, historical.path));
  assert.match(fs.readFileSync(editor, "utf8"), /historical = 2/);
  assert.equal(fs.statSync(editor).mode & 0o222, 0);
  const remote = files.find((file: any) => file.path === "remote-only.ts");
  assert.ok(!fs.existsSync(path.join(w.a, remote.path)));
  assert.match(
    fs.readFileSync(repo.editorFile(remote, w.state), "utf8"),
    /remote = 42/,
  );
  const removed = repo
    .files(
      repo.comparison({ kind: "range", from: head, to: base }, state),
      state,
    )
    .find((file: any) => file.path === "remote-only.ts");
  assert.equal(repo.content(removed).text, "");
  assert.match(
    fs.readFileSync(repo.editorFile(removed, w.state), "utf8"),
    /remote = 42/,
  );
  assert.match(
    fs.readFileSync(repo.editorFile(historical, w.state, "before"), "utf8"),
    /historical = 1/,
  );
});

test("advanced filters, path exceptions, sidebar size and wheel speed persist without clobbering category settings", (t) => {
  const w = new Workspace(t);
  const configured = {
    ...settings.defaultReviewSettings,
    generated: false,
    lockfiles: true,
    hidePaths: ["**/vendor/**", "docs/"],
    showPaths: ["**/important.test.ts"],
    sidebarWidth: 51,
    wheelStep: 7,
  };
  settings.saveReviewSettings(w.state, w.a, configured);
  settings.saveReviewFilters(w.state, w.a, {
    test: true,
    style: false,
    boilerplate: true,
  });
  assert.deepEqual(settings.loadReviewSettings(w.state, w.a), configured);
  const filters = settings.loadReviewFilters(w.state, w.a);
  assert.equal(
    settings.hiddenReviewReason("src/important.test.ts", filters, configured),
    undefined,
  );
  assert.equal(
    settings.hiddenReviewReason("generated/api.ts", filters, configured),
    undefined,
  );
  assert.equal(
    settings.hiddenReviewReason("package-lock.json", filters, configured),
    "Dependency lockfile",
  );
  assert.match(
    settings.hiddenReviewReason("vendor/a.ts", filters, configured),
    /Path rule/,
  );
  assert.match(
    settings.hiddenReviewReason("docs/a.md", filters, configured),
    /Path rule/,
  );
  assert.ok(settings.matchesReviewPath("a.ts", "**/*.ts"));
  assert.ok(!settings.matchesReviewPath("src/a.ts", "*.ts"));
  assert.equal(settings.loadReviewSettings(w.state, w.b).wheelStep, 3);
});

test("search distinguishes changed lines from complete reviewed files and returns exact positions with expanded context", (t) => {
  const w = new Workspace(t),
    repo = new engine.LiveRepository(w.a);
  const original =
    Array.from({ length: 90 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  write(path.join(w.a, "text.txt"), original);
  w.git(w.a, "add", "text.txt");
  w.git(w.a, "commit", "-qm", "Text");
  write(
    path.join(w.a, "text.txt"),
    original.replace("line 50\n", "keyword target\n"),
  );
  const state = repo.refresh(),
    files = repo.files(repo.comparison({ kind: "working" }, state), state);
  assert.equal(
    searching.searchReviewFiles(repo, files, "line 20", "changes").hits.length,
    0,
  );
  const full = searching.searchReviewFiles(repo, files, "line 20", "files");
  assert.equal(full.hits[0].line, 19);
  assert.equal(full.hits[0].fullFile, true);
  const changed = searching.searchReviewFiles(
    repo,
    files,
    "keyword",
    "changes",
    12,
  );
  assert.equal(
    repo.patch(files[0], 12).split("\n")[changed.hits[0].line],
    "+keyword target",
  );
  assert.equal(changed.hits[0].fileKey, files[0].key);
});

test("live marks and command checkpoints share exact source/index identities and queue review status", async (t) => {
  const w = new Workspace(t),
    repo = new engine.LiveRepository(w.a),
    store = new stores.Store(w.repo, w.state);
  const review = new reviews.ReviewStore(store, store.current(w.a));
  write(path.join(w.a, "source.txt"), "reviewed source\n");
  const state = repo.refresh(),
    key = engine.checkpointKey(w.a, state.snapshot.branch);
  const point = {
    branch: state.snapshot.branch,
    head: state.snapshot.head,
    tree: state.snapshot.worktreeTree,
    index: state.snapshot.indexTree,
    label: "Live pass",
  };
  await history.saveUnifiedCheckpoint(
    w.a,
    w.repo,
    store.root,
    key,
    point,
    state.snapshot,
  );
  assert.equal(review.load().checkpoints.length, 1);
  assert.equal(review.lastCheckpoint().worktreeTree, point.tree);
  assert.equal(
    reviews.reviewStatus(review.load(), state.snapshot, 1),
    "Reviewed",
  );
  write(path.join(w.a, "source.txt"), "later source\n");
  const next = repo.refresh();
  assert.equal(
    reviews.reviewStatus(review.load(), next.snapshot, 1),
    "Changed since review",
  );
  assert.match(
    repo.patch(
      repo.files(
        repo.comparison(
          {
            kind: "since",
            checkpoint: history.loadUnifiedCheckpoint(
              w.a,
              w.repo,
              store.root,
              key,
              state.snapshot.branch,
            ),
          },
          next,
        ),
        next,
      )[0],
    ),
    /-reviewed source/,
  );
  await review.setBaseline("develop");
  const capture = repo.refresh(true).snapshot;
  review.saveSnapshot(capture);
  await review.checkpoint(capture, false, "Command pass");
  assert.equal(
    engine.loadCheckpoint(store.root, key).tree,
    capture.worktreeTree,
  );
  const prKey = engine.checkpointKey(w.a, state.snapshot.branch, 99);
  assert.throws(
    () =>
      history.loadUnifiedCheckpoint(
        w.a,
        w.repo,
        store.root,
        prKey,
        state.snapshot.branch,
        99,
      ),
    /No checkpoint/,
  );
  await history.saveUnifiedCheckpoint(
    w.a,
    w.repo,
    store.root,
    prKey,
    point,
    state.snapshot,
    99,
  );
  assert.equal(
    review.lastCheckpoint().worktreeTree,
    capture.worktreeTree,
    "A PR-specific checkpoint must not become the local branch checkpoint",
  );
  assert.equal(
    history.loadUnifiedCheckpoint(
      w.a,
      w.repo,
      store.root,
      prKey,
      state.snapshot.branch,
      99,
    ).tree,
    point.tree,
  );
  const checkpoints = review.load().checkpoints.length;
  write(path.join(w.a, "source.txt"), "uninspected correction\n");
  await assert.rejects(
    review.checkpoint(capture, true),
    /Source changed since the review snapshot/,
  );
  assert.equal(review.load().checkpoints.length, checkpoints);
  assert.equal(review.load().approval, undefined);
});

test("logic ranking is stable, labels heuristic evidence and prioritises behavior above generated noise", async (t) => {
  const w = new Workspace(t),
    repo = new engine.LiveRepository(w.a);
  write(
    path.join(w.a, "logic.ts"),
    "export function validate(value: number) { if (value < 0) throw new Error('negative'); return value; }\n",
  );
  write(path.join(w.a, "format.txt"), "// formatting only\n");
  fs.mkdirSync(path.join(w.a, "generated"));
  write(
    path.join(w.a, "generated/api.ts"),
    "export function generated() { return 1; }\n",
  );
  const state = repo.refresh(),
    files = repo.files(repo.comparison({ kind: "working" }, state), state);
  const scores = await ranking.rankReviewFiles(repo, files),
    sorted = ranking.sortReviewFiles(files, scores);
  assert.equal(sorted[0].path, "logic.ts");
  assert.ok(["syntax", "heuristic"].includes(scores[sorted[0].key].kind));
  assert.match(
    scores[files.find((f: any) => f.path === "generated/api.ts").key].reason,
    /boilerplate/,
  );
  assert.deepEqual(ranking.sortReviewFiles(files, {}), files);
  assert.equal(ranking.heuristicReviewRank("+// only comment\n").score, 0);
});

test("signalled Git output is rejected, and process deadlines kill stubborn descendants", (t) => {
  const w = new Workspace(t),
    realGit = w.command(["which", "git"]).stdout.trim();
  w.env.REAL_REVIEW_GIT = realGit;
  w.stub(
    "git",
    `if(process.argv.includes('signal-probe')) { process.stdout.write('incomplete'); process.kill(process.pid, 'SIGTERM'); } else { const cp=require('node:child_process'); const r=cp.spawnSync(process.env.REAL_REVIEW_GIT,process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(r.status??1); }`,
  );
  const stubborn = `process.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify("process.on('SIGTERM',()=>{});setInterval(()=>{},100)")}],{stdio:'inherit'});setInterval(()=>{},100)`;
  const script = `
    import assert from 'node:assert/strict';
    import { reviewGit } from ${JSON.stringify(moduleURL("review-git"))};
    import { execute } from ${JSON.stringify(moduleURL("common"))};
    assert.throws(() => reviewGit(process.cwd(), ['signal-probe']), /SIGTERM/);
    const start=Date.now();
    const result=await execute([process.execPath, '-e', ${JSON.stringify(stubborn)}],process.cwd(),{processGroup:true,timeoutMs:250,abortGraceMs:50});
    assert.equal(result.code,124);
    assert.ok(Date.now()-start<2000,'Deadline waited for a stubborn descendant');
    assert.match(result.stderr,/timed out/);
  `;
  w.command([process.execPath, "--input-type=module", "-e", script], {
    cwd: w.a,
    timeoutMs: 5000,
  });
});

test("explicit agent ranking validates response identities and uses a read-only, tool-free provider invocation", (t) => {
  const w = new Workspace(t),
    capture = path.join(w.root, "ranking-args.json");
  w.env.RANK_CAPTURE = capture;
  w.stub(
    "claude",
    `const fs=require('node:fs'); const prompt=fs.readFileSync(0,'utf8');fs.writeFileSync(process.env.RANK_CAPTURE,JSON.stringify({args:process.argv.slice(2),prompt}));console.log(JSON.stringify({structured_output:{files:[{id:process.env.BAD_RANK?'foreign':'file-1',score:90,reason:'Changes validation control flow'}]}}));`,
  );
  const script = `import assert from 'node:assert/strict';import {rankWithReviewAgent} from ${JSON.stringify(moduleURL("review-rank-agent"))};const run=()=>rankWithReviewAgent(process.cwd(),'claude',[{id:'file-1',path:'logic.ts',layer:'commit',patch:'+if(value) return 2;'}],new AbortController().signal);assert.equal((await run())['file-1'].kind,'agent');process.env.BAD_RANK='1';await assert.rejects(run(),/invalid file/);`;
  w.command([process.execPath, "--input-type=module", "-e", script], {
    cwd: w.a,
  });
  const args = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.ok(args.args.includes("--strict-mcp-config"));
  assert.equal(args.args[args.args.indexOf("--tools") + 1], "");
  assert.match(args.prompt, /untrusted evidence/);
});

test(
  "terminal review progress, context, comparison picker, cross-file search and persisted controls work together",
  { timeout: 90000 },
  (t) => {
    const w = new Workspace(t);
    const original =
      Array.from({ length: 100 }, (_, n) =>
        n === 0
          ? "return 1;"
          : n === 80
            ? "return 4;"
            : `// context marker ${n}`,
      ).join("\n") + "\n";
    for (const name of ["alpha.ts", "beta.ts"])
      write(path.join(w.a, name), original);
    w.git(w.a, "add", ".");
    w.git(w.a, "commit", "-qm", "Source context");
    for (const name of ["alpha.ts", "beta.ts"])
      write(
        path.join(w.a, name),
        original
          .replace("return 1;", "return 2;")
          .replace("return 4;", "return 5;"),
      );
    // Search a single exact context line in both complete files.
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
        "improvements",
      ],
      { timeoutMs: 80000 },
    );
    assert.match(result.stdout, /PTY: improvements.*passed/);
    const store = new stores.Store(w.repo, w.state);
    const saved = settings.loadReviewSettings(store.root, w.a);
    assert.equal(saved.sidebarWidth, 60);
    assert.equal(saved.wheelStep, 7);
  },
);

for (const scenario of ["pr-navigation", "pr-freeze"])
  test(
    `terminal ${scenario} rejects unintended remote revision changes`,
    { timeout: 120000 },
    (t) => {
      const w = new Workspace(t);
      const base = w.git(w.a, "rev-parse", "HEAD");
      write(path.join(w.a, "remote.txt"), "old remote\n");
      w.git(w.a, "add", "remote.txt");
      w.git(w.a, "commit", "-qm", "Old remote");
      const old = w.git(w.a, "rev-parse", "HEAD");
      write(path.join(w.b, "remote.txt"), "new remote\n");
      w.git(w.b, "add", "remote.txt");
      w.git(w.b, "commit", "-qm", "New remote");
      const next = w.git(w.b, "rev-parse", "HEAD");
      write(path.join(w.a, "local.txt"), "local pending\n");
      delete w.env.RL_PR_OFFLINE;
      w.env.REVIEW_NEXT_PR = path.join(w.root, "next-pr");
      w.env.REVIEW_PR_DELAY = scenario === "pr-navigation" ? "1800" : "0";
      w.env.REVIEW_OLD_PR = JSON.stringify({
        number: 99,
        title: "Remote review",
        url: "https://github.com/example/repo/pull/99",
        headRefName: "feature/a",
        baseRefName: "develop",
        headRefOid: old,
        baseRefOid: base,
        commits: [{ oid: old }],
        files: [],
      });
      w.env.REVIEW_NEW_PR = JSON.stringify({
        ...JSON.parse(w.env.REVIEW_OLD_PR),
        headRefOid: next,
        commits: [{ oid: next }],
      });
      w.stub(
        "gh",
        `setTimeout(()=>console.log(require('node:fs').existsSync(process.env.REVIEW_NEXT_PR)?process.env.REVIEW_NEW_PR:process.env.REVIEW_OLD_PR),Number(process.env.REVIEW_PR_DELAY));`,
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
          scenario,
        ],
        { timeoutMs: 110000 },
      );
      assert.match(result.stdout, new RegExp(`PTY: ${scenario}.*passed`));
    },
  );

test("failed compilation preserves the last runnable build", (t) => {
  const w = new Workspace(t),
    fixture = path.join(w.root, "build-fixture");
  fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src"));
  fs.symlinkSync(
    path.join(ROOT, "node_modules"),
    path.join(fixture, "node_modules"),
  );
  fs.copyFileSync(
    path.join(ROOT, "scripts/build.mjs"),
    path.join(fixture, "scripts/build.mjs"),
  );
  write(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        outDir: "dist",
        rootDir: "src",
        target: "ES2023",
        skipLibCheck: true,
        types: [],
      },
      include: ["src"],
    }),
  );
  write(
    path.join(fixture, "src/example.ts"),
    "export const works: string = 'previous build';\n",
  );
  w.command([process.execPath, "scripts/build.mjs"], { cwd: fixture });
  const previous = fs.readFileSync(
    path.join(fixture, "dist/example.js"),
    "utf8",
  );
  write(
    path.join(fixture, "src/example.ts"),
    "export const works: string = 42;\n",
  );
  w.command([process.execPath, "scripts/build.mjs"], {
    cwd: fixture,
    ok: false,
  });
  assert.equal(
    fs.readFileSync(path.join(fixture, "dist/example.js"), "utf8"),
    previous,
  );
  assert.ok(
    !fs.readdirSync(fixture).some((name) => name.startsWith(".rl-dist-")),
  );
});

test(
  "Quit hands back terminal input promptly while a contended checkpoint safely finishes",
  { timeout: 30000 },
  (t) => {
    const w = new Workspace(t),
      store = new stores.Store(w.repo, w.state);
    const review = new reviews.ReviewStore(store, store.current(w.a));
    write(path.join(w.a, "live.txt"), "version-one\n");
    w.env.REVIEW_STORE_LOCK = path.join(store.root, ".typescript.lock");
    w.env.REVIEW_SNAPSHOT_DIRECTORY = path.join(review.directory, "snapshots");
    w.env.REVIEW_CHECKPOINT_STATE = review.path("state.json");
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
        "checkpoint-quit",
      ],
      { timeoutMs: 25000 },
    );
    assert.match(result.stdout, /PTY: checkpoint-quit.*passed/);
    assert.equal(review.load().checkpoints.length, 1);
    t.diagnostic(
      result.stdout.match(/QUIT_LATENCY=[\d.]+s/)?.[0] ?? result.stdout,
    );
  },
);
