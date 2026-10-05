import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Workspace, read, readJson, write } from "./helpers.js";

function setup(w: Workspace) {
  delete w.env.RL_PR_OFFLINE;
  w.env.GH_REPO = "unrelated/repo";
  w.env.GH_CALLS = path.join(w.root, "gh-calls.jsonl");
  w.env.PICKER_CAPTURE = path.join(w.root, "rows.json");
  w.env.PR_DATA = "{}";
  w.stub(
    "gh",
    String.raw`
const fs=require('node:fs'); const args=process.argv.slice(2);
if(process.env.GH_REPO) {console.error('GH_REPO must not retarget the workspace');process.exit(9);}
fs.appendFileSync(process.env.GH_CALLS,JSON.stringify(args)+'\n');
if(process.env.GH_FAIL) {console.error('Authentication unavailable');process.exit(1);}
if(args[0]==='repo') {console.log(JSON.stringify({nameWithOwner:'example/repo',url:'https://github.com/example/repo'}));process.exit(0);}
const query=args.find(a=>a.startsWith('query='));
if(!query) process.exit(8);
const data=JSON.parse(process.env.PR_DATA), repository={};
for(const match of query.matchAll(/([oh]\d+): pullRequests\(headRefName: ("(?:[^"\\]|\\.)*")/g)) {
 const branch=JSON.parse(match[2]), open=match[1][0]==='o';
 repository[match[1]]={nodes:(data[branch]||[]).filter(pr=>(pr.state==='OPEN')===open),pageInfo:{hasNextPage:process.env.TRUNCATED_BRANCH===branch}};
}
console.log(JSON.stringify({data:{repository}}));`,
  );
  w.stub(
    "fzf",
    String.raw`const fs=require('node:fs');const text=fs.readFileSync(0,'utf8').replace(/\x1b\[[0-9;]*m/g,'');fs.writeFileSync(process.env.PICKER_CAPTURE,JSON.stringify(text.trim().split('\n')));if(process.env.SELECT_NAME) console.log(text.split('\n').find(row=>row.startsWith(process.env.SELECT_NAME+'\t')));else process.exit(130);`,
  );
}
function pr(
  branch: string,
  state: string,
  number: number,
  isDraft = false,
  owner = "example/repo",
) {
  return {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    title: branch,
    state,
    headRefName: branch,
    baseRefName: "develop",
    isDraft,
    updatedAt: "2026-10-02T00:00:00Z",
    headRepository: { nameWithOwner: owner },
  };
}
const rows = (w: Workspace): string[] => readJson(w.env.PICKER_CAPTURE!);
const calls = (w: Workspace) =>
  read(w.env.GH_CALLS!)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
function expire(w: Workspace) {
  const root = path.dirname(w.status().stateDirectory),
    file = path.join(root, "pr-cache.json"),
    data = readJson(file);
  for (const entry of Object.values(data.branches) as { checkedAt: string }[])
    entry.checkedAt = "2020-01-01T00:00:00Z";
  write(file, JSON.stringify(data));
  for (const dir of fs.readdirSync(root)) {
    const record = path.join(root, dir, "instance.json");
    if (!fs.existsSync(record)) continue;
    const value = readJson(record);
    if (value.pr) value.pr.syncedAt = "2020-01-01T00:00:00Z";
    write(record, JSON.stringify(value));
  }
}
test("pickers discover existing PRs in one batch, cache absence, and leave access timestamps unchanged", (t) => {
  const w = new Workspace(t);
  setup(w);
  const roots = ["open", "merged", "draft", "none"].map((name) =>
    w.managed(name),
  );
  const before = roots.map((root) => w.status(root).lastAccessedAt);
  w.env.PR_DATA = JSON.stringify({
    open: [pr("open", "OPEN", 2), pr("open", "MERGED", 1)],
    merged: [pr("merged", "MERGED", 3)],
    draft: [pr("draft", "OPEN", 4, true)],
  });
  w.rl([]);
  for (const state of ["open", "merged", "draft", "none"])
    assert.ok(
      rows(w).some(
        (row) =>
          row.startsWith(state + "\t") &&
          new RegExp(`\\s${state}\\s`).test(row),
      ),
      state,
    );
  assert.equal(calls(w).length, 2);
  assert.equal(calls(w)[1][0], "api");
  assert.deepEqual(
    roots.map((root) => w.status(root).lastAccessedAt),
    before,
  );
  assert.equal(w.status(roots[0]).pr.number, 2);
  w.rl(["delete"]);
  assert.equal(calls(w).length, 2);
  expire(w);
  w.env.PR_DATA = JSON.stringify({ open: [pr("open", "MERGED", 2)] });
  w.rl([]);
  assert.ok(
    rows(w).some((row) => row.startsWith("open\t") && /\smerged\s/.test(row)),
  );
});
test("unadopted worktrees get PR detection by branch, including PR target comparison", (t) => {
  const w = new Workspace(t);
  setup(w);
  const root = path.join(w.root, "worktrees/example/display-name");
  fs.mkdirSync(path.dirname(root), { recursive: true });
  w.git(w.repo, "worktree", "add", "-q", "-b", "feature/existing", root);
  w.git(root, "commit", "-q", "--allow-empty", "-m", "Target commit");
  w.git(root, "branch", "release");
  w.git(root, "commit", "-q", "--allow-empty", "-m", "Feature commit");
  w.env.PR_DATA = JSON.stringify({
    "feature/existing": [
      { ...pr("feature/existing", "OPEN", 9), baseRefName: "release" },
    ],
  });
  w.rl([]);
  assert.match(rows(w)[0], /\sopen\s+\+1 \/ -0\s+release/);
  assert.ok(!fs.existsSync(path.join(root, ".codex")));
  w.env.SELECT_NAME = "display-name";
  w.rl([]);
  assert.equal(w.status(root).pr.baseRefName, "release");
});
test("failed lookups show unknown or stale snapshots, never false none or lost PR state", (t) => {
  const w = new Workspace(t);
  setup(w);
  const root = w.managed("task");
  w.env.GH_FAIL = "1";
  w.rl([]);
  assert.match(rows(w)[0], /\sunknown\s/);
  assert.doesNotMatch(rows(w)[0], /\snone\s/);
  delete w.env.GH_FAIL;
  w.env.PR_DATA = JSON.stringify({ task: [pr("task", "OPEN", 10)] });
  w.rl([]);
  expire(w);
  w.env.GH_FAIL = "1";
  w.rl([]);
  assert.match(rows(w)[0], /\sopen\*\s/);
  assert.equal(w.status(root).pr.number, 10);
});
test("fork branches and truncated results are not misidentified as local PRs or absence", (t) => {
  const w = new Workspace(t);
  setup(w);
  w.managed("task");
  w.env.PR_DATA = JSON.stringify({
    task: [
      pr("task", "OPEN", 20, false, "someone/fork"),
      pr("task", "MERGED", 19),
    ],
  });
  w.rl([]);
  assert.match(rows(w)[0], /\smerged\s/);
  expire(w);
  w.env.PR_DATA = "{}";
  w.env.TRUNCATED_BRANCH = "task";
  w.rl([]);
  assert.match(rows(w)[0], /\smerged\*\s/);
  assert.doesNotMatch(rows(w)[0], /\snone\s/);
});
