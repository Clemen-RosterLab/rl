import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, ROOT, Workspace, write } from "./helpers.js";

const url = (name: string) =>
  pathToFileURL(path.join(ROOT, `dist/${name}.js`)).href;
const { LiveRepository } = await import(url("review-live-engine"));
const { ReviewPreview } = await import(url("review-live-preview"));

test("independent previews match immutable Git diffs across staged, unstaged, deleted and renamed files", async (t) => {
  const w = new Workspace(t),
    repository = new LiveRepository(w.a);
  write(path.join(w.a, "old name.txt"), "original\n");
  write(path.join(w.a, "deleted.txt"), "removed\n");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-qm", "Base");
  w.git(w.a, "mv", "old name.txt", "new name.txt");
  w.git(w.a, "rm", "deleted.txt");
  write(path.join(w.a, "new name.txt"), "changed\n");
  write(path.join(w.a, "untracked.txt"), "new file\n");
  const state = repository.refresh(),
    files = repository.files(
      repository.comparison({ kind: "working" }, state),
      state,
    );
  const reader = new ReviewPreview(w.a);
  t.after(() => reader.close());
  for (const file of files) {
    assert.equal(
      await reader.read(file, { gitDir: state.gitDir, context: 12 }),
      repository.patch(file, 12),
    );
    for (const side of ["before", "after"] as const)
      assert.equal(
        await reader.read(file, {
          gitDir: state.gitDir,
          context: 3,
          fullFile: true,
          side,
        }),
        repository.content(file, side).text,
      );
  }
});

test("previews compare the last-viewed target and keep Git directory identity pinned", async (t) => {
  const w = new Workspace(t),
    repository = new LiveRepository(w.a),
    reader = new ReviewPreview(w.a);
  t.after(() => reader.close());
  write(path.join(w.a, "source.txt"), "earlier\n");
  const first = repository.refresh(),
    before = repository.files(
      repository.comparison({ kind: "working" }, first),
      first,
    )[0];
  write(path.join(w.a, "source.txt"), "latest\n");
  const next = repository.refresh(),
    file = repository.files(
      repository.comparison({ kind: "working" }, next),
      next,
    )[0];
  const viewed = {
    fingerprint: "",
    tree: before.to,
    path: before.path,
    at: "",
  };
  const patch = await reader.read(file, {
    gitDir: next.gitDir,
    context: 3,
    viewed,
  });
  assert.match(patch, /-earlier/);
  assert.match(patch, /\+latest/);
  assert.equal(
    await reader.read(file, {
      gitDir: next.gitDir,
      context: 3,
      viewed: { ...viewed, tree: file.to },
    }),
    "No changes since you last viewed this file.\n",
  );
  await assert.rejects(
    reader.read(file, { gitDir: path.join(w.root, "foreign-git"), context: 3 }),
    /identity changed/,
  );
});

test("a newer preview cancels a stalled older Git process immediately", async (t) => {
  const w = new Workspace(t),
    repository = new LiveRepository(w.a);
  write(path.join(w.a, "a.txt"), "slow file\n");
  write(path.join(w.a, "b.txt"), "fast file\n");
  const state = repository.refresh(),
    files = repository.files(
      repository.comparison({ kind: "working" }, state),
      state,
    );
  w.env.REVIEW_FILES = JSON.stringify(files);
  w.env.REVIEW_GIT_DIR = state.gitDir;
  w.env.REVIEW_PREVIEW_STARTED = path.join(w.root, "preview-started");
  w.env.REVIEW_REAL_GIT = w.command(["which", "git"]).stdout.trim();
  w.stub(
    "git",
    `const fs=require('node:fs'),cp=require('node:child_process');if(process.argv.includes('diff')&&process.argv.includes('a.txt')) {fs.writeFileSync(process.env.REVIEW_PREVIEW_STARTED,'started');setInterval(()=>{},1000);}else{const result=cp.spawnSync(process.env.REVIEW_REAL_GIT,process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(result.status??1);}`,
  );
  const script = `import fs from 'node:fs';import assert from 'node:assert/strict';import {ReviewPreview} from ${JSON.stringify(url("review-live-preview"))};const reader=new ReviewPreview(process.cwd()),files=JSON.parse(process.env.REVIEW_FILES),options={gitDir:process.env.REVIEW_GIT_DIR,context:3};const old=reader.read(files.find(f=>f.path==='a.txt'),options);const rejected=assert.rejects(old,/superseded/);const deadline=Date.now()+5000;while(!fs.existsSync(process.env.REVIEW_PREVIEW_STARTED)){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}const start=performance.now();const value=await reader.read(files.find(f=>f.path==='b.txt'),options);assert.match(value,/\\+fast file/);await rejected;reader.close();assert.ok(performance.now()-start<1500,'New preview waited for the stale Git process');`;
  await w.commandAsync(
    [process.execPath, "--input-type=module", "-e", script],
    { cwd: w.a, timeoutMs: 15000 },
  );
});

test("oversized previews stay bounded and binary context is labelled", async (t) => {
  const w = new Workspace(t),
    repository = new LiveRepository(w.a),
    reader = new ReviewPreview(w.a);
  t.after(() => reader.close());
  write(path.join(w.a, "large.txt"), "x".repeat(9 * 1024 * 1024));
  fs.writeFileSync(path.join(w.a, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  const state = repository.refresh(),
    files = repository.files(
      repository.comparison({ kind: "working" }, state),
      state,
    );
  const large = files.find((file: any) => file.path === "large.txt"),
    binary = files.find((file: any) => file.path === "binary.bin");
  const value = await reader.read(large, { gitDir: state.gitDir, context: 3 });
  assert.match(value, /Diff truncated at 8 MiB/);
  assert.ok(Buffer.byteLength(value) < 8 * 1024 * 1024 + 200);
  assert.match(
    await reader.read(large, {
      gitDir: state.gitDir,
      context: 3,
      fullFile: true,
    }),
    /File exceeds/,
  );
  assert.match(
    await reader.read(binary, {
      gitDir: state.gitDir,
      context: 3,
      fullFile: true,
    }),
    /Binary file: 4 bytes/,
  );
});

test(
  "terminal file switches bypass a blocked snapshot refresh and reuse cached previews",
  { timeout: 90000 },
  (t) => {
    const w = new Workspace(t);
    for (const name of ["a", "b"])
      write(path.join(w.a, `${name}.txt`), `${name}-base\n`);
    w.git(w.a, "add", ".");
    w.git(w.a, "commit", "-qm", "Sources");
    for (const name of ["a", "b"])
      write(path.join(w.a, `${name}.txt`), `${name}-v1\n`);
    w.env.REVIEW_REAL_GIT = w.command(["which", "git"]).stdout.trim();
    w.env.REVIEW_PAUSE_GIT = path.join(w.root, "pause-snapshot");
    w.env.REVIEW_GIT_INDEX_MARKER = path.join(w.root, "snapshot-started");
    write(
      path.join(w.bin, "git"),
      `#!/bin/sh\ncase " $* " in *" read-tree "*) if [ -n "$GIT_INDEX_FILE" ] && [ -f "$REVIEW_PAUSE_GIT" ]; then printf '%s' "$GIT_INDEX_FILE" > "$REVIEW_GIT_INDEX_MARKER"; while [ -f "$REVIEW_PAUSE_GIT" ]; do sleep 0.05; done; fi;; esac\nexec "$REVIEW_REAL_GIT" "$@"\n`,
    );
    fs.chmodSync(path.join(w.bin, "git"), 0o755);
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
        "switch-performance",
      ],
      { timeoutMs: 80000 },
    );
    assert.match(result.stdout, /PTY: switch-performance.*passed/);
    t.diagnostic(
      result.stdout.match(
        /SWITCH_LATENCY=[\d.]+s CACHE_SWITCH_LATENCY=[\d.]+s/,
      )?.[0] ?? result.stdout,
    );
  },
);
