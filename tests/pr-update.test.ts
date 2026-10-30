import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Workspace, read, readJson, write } from "./helpers.js";

const BASE = "a".repeat(40);
const head = (number: number) => number.toString(16).padStart(40, "0");
function pr(number: number, extra: object = {}) {
  return {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    title: `Feature ${number}`,
    state: "OPEN",
    headRefName: `feature/${number}`,
    headRefOid: head(number),
    baseRefName: "test",
    baseRefOid: BASE,
    isCrossRepository: false,
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: "example" },
    mergeable: "MERGEABLE",
    isDraft: false,
    ...extra,
  };
}
function fixture(w: Workspace, entries: Record<string, object>) {
  const adopted = new Set(["feature/a", "feature/b"]);
  for (const entry of Object.values(entries) as any[]) {
    const branch = entry.raw.headRefName;
    if (entry.rlManaged !== false && !adopted.has(branch)) {
      w.managed(branch);
      adopted.add(branch);
    }
  }
  delete w.env.RL_PR_OFFLINE;
  w.env.RL_DEFAULT_BASE = "origin/test";
  w.env.GH_REPO = "wrong/repository";
  w.git(
    w.repo,
    "remote",
    "add",
    "origin",
    "https://github.com/example/repo.git",
  );
  const state = path.join(w.root, "github-state.json");
  const log = path.join(w.root, "github-calls.jsonl");
  write(state, JSON.stringify(entries));
  w.env.PR_UPDATE_STATE = state;
  w.env.PR_UPDATE_LOG = log;
  w.stub(
    "gh",
    `
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PR_UPDATE_LOG, JSON.stringify({args, cwd:process.cwd(), repo:process.env.GH_REPO??null})+'\\n');
const data = JSON.parse(fs.readFileSync(process.env.PR_UPDATE_STATE,'utf8'));
const save = () => fs.writeFileSync(process.env.PR_UPDATE_STATE,JSON.stringify(data));
const output = value => console.log(JSON.stringify(value));
const fail = msg => { output({message:msg}); console.error(msg); process.exit(1); };
if(args[0]==='repo') { output({nameWithOwner:'example/repo',url:process.env.PR_IDENTITY_URL||'https://github.com/example/repo'}); process.exit(0); }
if(args[0]==='pr' && args[1]==='list') {
 const branch=args[args.indexOf('--head')+1];
 output(Object.entries(data).filter(([,item])=>process.env.BAD_PR_LIST || item.raw.headRefName===branch).map(([number,item])=>({number:Number(number),headRefName:item.raw.headRefName})));process.exit(0);
}

if(args[0]==='pr' && args[1]==='view') {
 const item=data[args[2]]; if(!item) fail('PR not found');
 item.views=(item.views||0)+1;
 if(item.headChangeAt && item.views>=item.headChangeAt) item.raw.headRefOid='b'.repeat(40);
 if(item.retargetAt && item.views>=item.retargetAt) item.raw.baseRefName='main';
 if(item.deleteSessionAt && item.views>=item.deleteSessionAt) {
  const record=JSON.parse(fs.readFileSync(item.instanceFile,'utf8'));record.status='deleted';fs.writeFileSync(item.instanceFile,JSON.stringify(record));
 }
 if(item.put && item.verificationFails) fail('Verification temporarily unavailable');
 if(process.env.SWITCH_ON_VIEW && item.views===1) cp.spawnSync('git',['checkout','-qb','switched-during-query'],{cwd:process.cwd()});
 save(); output(item.raw);process.exit(0);
}
const endpoint=args.find(a=>a.startsWith('repos/'))||'';
if(endpoint.includes('/compare/')) {
 const oid=endpoint.split('...')[1].split('?')[0];
 const item=Object.values(data).find(item=>item.raw.headRefOid===oid);if(!item) fail('Unknown comparison');
 item.comparisons=(item.comparisons||0)+1;
 if(item.deleteSessionOnCompareAt && item.comparisons>=item.deleteSessionOnCompareAt) {
  const record=JSON.parse(fs.readFileSync(item.instanceFile,'utf8'));record.status='deleted';fs.writeFileSync(item.instanceFile,JSON.stringify(record));
 }
 save();
 output({behind_by:item.badComparison?'invalid':item.behind,base_commit:{sha:item.raw.baseRefOid}});process.exit(0);
}
const match=endpoint.match(/\\/pulls\\/(\\d+)\\/update-branch$/);
if(match) {
 const item=data[match[1]];const expected=args.find(a=>a.startsWith('expected_head_sha='));
 if(expected!=='expected_head_sha='+item.raw.headRefOid) fail('Expected head SHA does not match');
 item.put=(item.put||0)+1;save();
 if(item.error) fail(item.error);
 if(!item.queued && !item.verificationFails) { item.behind=0;item.raw.headRefOid='f'+Number(match[1]).toString(16).padStart(39,'0');save(); }
 output({message:'Updating pull request branch.'});process.exit(0);
}
fail('Unexpected gh invocation');
`,
  );
  return {
    state,
    log,
    calls: () =>
      fs.existsSync(log)
        ? read(log)
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    puts: () =>
      fs.existsSync(log)
        ? read(log)
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((call) => call.args.includes("PUT"))
        : [],
  };
}

test("PR batch updates verified branches, reports conflicts and up-to-date PRs, and preserves all local worktrees", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    11: { raw: pr(11), behind: 3 },
    12: { raw: pr(12, { mergeable: "CONFLICTING" }), behind: 2 },
    13: { raw: pr(13), behind: 0 },
  });
  write(path.join(w.a, "unfinished.txt"), "keep my edits");
  write(path.join(w.b, "neighbor.txt"), "keep neighboring work");
  const file = path.join(w.status().stateDirectory, "instance.json");
  const before = read(file);
  const gitBefore = w.git(w.a, "status", "--porcelain");
  const headBefore = w.git(w.a, "rev-parse", "HEAD");
  const report = JSON.parse(
    w.rl(["pr", "update", "11", "12", "13", "--json"], { cwd: w.a, ok: false })
      .stdout,
  );
  assert.equal(report.base, "test");
  assert.equal(report.workspace, w.a);
  assert.equal(report.repository, "example/repo");
  assert.deepEqual(
    report.results.map((row: { status: string }) => row.status),
    ["updated", "conflict", "up-to-date"],
  );
  assert.equal(report.results[0].headBefore, head(11));
  assert.notEqual(report.results[0].headAfter, head(11));
  assert.equal(report.summary.updated, 1);
  assert.equal(report.summary.conflict, 1);
  assert.equal(mock.puts().length, 1);
  assert.ok(
    mock.puts()[0].args.includes("repos/example/repo/pulls/11/update-branch"),
  );
  assert.ok(mock.puts()[0].args.includes(`expected_head_sha=${head(11)}`));
  assert.ok(
    mock.calls().every((call) => call.cwd === w.a && call.repo === null),
  );
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), headBefore);
  assert.equal(w.git(w.a, "status", "--porcelain"), gitBefore);
  assert.equal(read(file), before);
  assert.equal(read(path.join(w.b, "neighbor.txt")), "keep neighboring work");
});

test("PR batch dry run reports commit counts and never issues update requests", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    11: { raw: pr(11), behind: 4 },
    12: { raw: pr(12), behind: 0 },
  });
  const report = JSON.parse(
    w.rl(
      [
        "pr",
        "update",
        "11",
        "12",
        "11",
        "--base",
        "origin/test",
        "--dry-run",
        "--json",
      ],
      { cwd: w.a },
    ).stdout,
  );
  assert.equal(report.dryRun, true);
  assert.equal(report.summary.selected, 2);
  assert.deepEqual(
    report.results.map((row: { status: string }) => row.status),
    ["would-update", "up-to-date"],
  );
  assert.equal(report.results[0].behindCommits, 4);
  assert.equal(mock.puts().length, 0);
  const human = w.rl(["pr", "update", "11", "--dry-run"], { cwd: w.a }).stdout;
  assert.match(human, /BEHIND \(COMMITS\)/);
  assert.match(human, /Would merge latest test into feature\/11/);
  assert.equal(mock.puts().length, 0);
});

test("PR batch continues after API conflicts, changed heads and permission failures", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    11: { raw: pr(11), behind: 2, error: "Merge conflict" },
    12: { raw: pr(12), behind: 2, error: "Expected head SHA does not match" },
    13: { raw: pr(13), behind: 2, error: "Permission denied" },
  });
  const report = JSON.parse(
    w.rl(["pr", "update", "11", "12", "13", "--json"], { cwd: w.a, ok: false })
      .stdout,
  );
  assert.deepEqual(
    report.results.map((row: { status: string }) => row.status),
    ["conflict", "changed", "failed"],
  );
  assert.equal(mock.puts().length, 3);
  assert.ok(
    Object.values(readJson(mock.state)).every(
      (entry: any) => entry.behind === 2,
    ),
  );
});

test("PR batch multi-select shows only behind PRs and cancellation cannot update branches", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    11: { raw: pr(11), behind: 2 },
    12: { raw: pr(12), behind: 0 },
    13: { raw: pr(13), behind: 3 },
  });
  const capture = path.join(w.root, "picker.json");
  w.env.PR_PICKER_CAPTURE = capture;
  w.stub(
    "fzf",
    "const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');fs.writeFileSync(process.env.PR_PICKER_CAPTURE,JSON.stringify({input,args:process.argv.slice(2)}));if(process.env.PICK_CANCEL)process.exit(130);console.log('11');console.log(input.trim().split('\\n').find(line=>line.startsWith('13\\t')));",
  );
  const report = JSON.parse(
    w.rl(["pr", "update", "--dry-run", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(report.summary.selected, 2);
  assert.deepEqual(
    report.results.map((row: { number: number }) => row.number),
    [11, 13],
  );
  assert.ok(readJson(capture).args.includes("--multi"));
  assert.match(readJson(capture).input, /2 commits behind/);
  assert.ok(!readJson(capture).input.includes("#12"));
  assert.equal(mock.puts().length, 0);
  w.env.PICK_CANCEL = "1";
  const canceled = JSON.parse(
    w.rl(["pr", "update", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(canceled.summary.selected, 0);
  assert.equal(mock.puts().length, 0);
});

test("PR batch detects changed selections, retargeted and foreign PRs before updating", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    11: { raw: pr(11), behind: 2, headChangeAt: 2 },
    12: { raw: pr(12), behind: 2, retargetAt: 2 },
    13: {
      raw: pr(13, {
        isCrossRepository: true,
        headRepositoryOwner: { login: "someone" },
      }),
      behind: 2,
    },
  });
  const report = JSON.parse(
    w.rl(["pr", "update", "11", "12", "13", "--json"], { cwd: w.a, ok: false })
      .stdout,
  );
  assert.deepEqual(
    report.results.map((row: { status: string }) => row.status),
    ["changed", "skipped", "skipped"],
  );
  assert.equal(mock.puts().length, 0);
});

test("PR batch distinguishes accepted but pending or unverifiable updates from completed updates", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    11: { raw: pr(11), behind: 2, queued: true },
    12: { raw: pr(12), behind: 2, verificationFails: true },
  });
  const report = JSON.parse(
    w.rl(["pr", "update", "11", "12", "--json"], { cwd: w.a, ok: false })
      .stdout,
  );
  assert.deepEqual(
    report.results.map((row: { status: string }) => row.status),
    ["pending", "pending"],
  );
  assert.equal(report.summary.updated, 0);
  assert.equal(report.summary.pending, 2);
  assert.equal(mock.puts().length, 2);
});

test("PR batch rejects invalid inputs, unknown picker results and wrong origin identity", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, { 11: { raw: pr(11), behind: 2 } });
  for (const args of [
    ["0"],
    ["-1"],
    ["abc"],
    ["11", "--workspace", w.b],
    ["11", "--all"],
    ["11", "--limit", "0"],
  ])
    w.rl(["pr", "update", ...args], { cwd: w.a, ok: false });
  assert.equal(mock.calls().length, 0);
  w.stub("fzf", "console.log('999');");
  assert.match(
    w.rl(["pr", "update"], { cwd: w.a, ok: false }).stderr,
    /unknown selection/,
  );
  assert.equal(mock.puts().length, 0);
  w.env.PR_IDENTITY_URL = "https://github.com/unrelated/repo";
  assert.match(
    w.rl(["pr", "update", "11"], { cwd: w.a, ok: false }).stderr,
    /Invalid GitHub repository URL/,
  );
  assert.equal(mock.puts().length, 0);
});

test("PR batch refuses updates after its current workspace branch changes", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, { 11: { raw: pr(11), behind: 2 } });
  w.env.SWITCH_ON_VIEW = "1";
  const report = JSON.parse(
    w.rl(["pr", "update", "11", "--json"], { cwd: w.a, ok: false }).stdout,
  );
  assert.equal(report.results[0].status, "failed");
  assert.match(report.results[0].detail, /Instance owns branch/);
  assert.equal(mock.puts().length, 0);
});

function instanceFile(w: Workspace, branch: string): string {
  const root = path.dirname(w.status().stateDirectory);
  for (const key of fs.readdirSync(root)) {
    const file = path.join(root, key, "instance.json");
    if (fs.existsSync(file) && readJson(file).branch === branch) return file;
  }
  throw new Error(`Missing test RL session for ${branch}`);
}

test("PR updates offer only active RL session branches and reject unrelated explicit numbers", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    11: { raw: pr(11), behind: 2 },
    12: { raw: pr(12), behind: 2, rlManaged: false },
    13: { raw: pr(13), behind: 2 },
  });
  // A real local worktree and a stale cached PR do not grant RL ownership.
  w.git(
    w.repo,
    "worktree",
    "add",
    "-q",
    "-b",
    "feature/12",
    path.join(w.root, "unadopted"),
  );
  const current = instanceFile(w, "feature/a");
  write(current, JSON.stringify({ ...readJson(current), pr: pr(12) }));
  const deleted = instanceFile(w, "feature/13");
  write(deleted, JSON.stringify({ ...readJson(deleted), status: "deleted" }));
  // Records from another repository in the same state directory are excluded.
  const foreignRepository = path.join(w.root, "other-repository");
  const foreign = path.join(
    w.state,
    createHash("sha256").update(foreignRepository).digest("hex").slice(0, 24),
    readJson(deleted).key,
  );
  fs.mkdirSync(foreign, { recursive: true });
  write(
    path.join(foreign, "instance.json"),
    JSON.stringify({
      ...readJson(deleted),
      status: "active",
      repository: foreignRepository,
    }),
  );
  const capture = path.join(w.root, "scoped-picker.txt");
  w.env.PR_PICKER_CAPTURE = capture;
  w.stub(
    "fzf",
    "const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');fs.writeFileSync(process.env.PR_PICKER_CAPTURE,input);console.log('11');",
  );
  const report = JSON.parse(
    w.rl(["pr", "update", "--limit", "1", "--dry-run", "--json"], { cwd: w.a })
      .stdout,
  );
  assert.deepEqual(
    report.results.map((row: { number: number }) => row.number),
    [11],
  );
  assert.match(read(capture), /#11/);
  assert.doesNotMatch(read(capture), /#12|#13/);
  const lists = mock
    .calls()
    .filter((call) => call.args[0] === "pr" && call.args[1] === "list");
  assert.deepEqual(
    lists.map((call) => call.args[call.args.indexOf("--head") + 1]).sort(),
    ["feature/11", "feature/a", "feature/b"],
  );
  assert.ok(
    !mock
      .calls()
      .some(
        (call) =>
          call.args[0] === "pr" &&
          call.args[1] === "view" &&
          ["12", "13"].includes(call.args[2]),
      ),
  );
  const explicit = JSON.parse(
    w.rl(["pr", "update", "11", "12", "13", "--json"], { cwd: w.a, ok: false })
      .stdout,
  );
  assert.deepEqual(
    explicit.results.map((row: { status: string }) => row.status),
    ["updated", "skipped", "skipped"],
  );
  assert.match(explicit.results[1].detail, /active RL session/);
  assert.equal(mock.puts().length, 1);
  assert.ok(
    mock.puts()[0].args.includes("repos/example/repo/pulls/11/update-branch"),
  );
  assert.ok(
    !mock
      .calls()
      .some((call) =>
        call.args.some(
          (arg: string) =>
            arg.includes(`/compare/${BASE}...${head(12)}`) ||
            arg.includes(`/compare/${BASE}...${head(13)}`),
        ),
      ),
  );
});

test("PR updates recheck session ownership after selection and before writing", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    11: { raw: pr(11), behind: 2, deleteSessionOnCompareAt: 2 },
  });
  const entries = readJson(mock.state);
  entries[11].instanceFile = instanceFile(w, "feature/11");
  write(mock.state, JSON.stringify(entries));
  const report = JSON.parse(
    w.rl(["pr", "update", "11", "--json"], { cwd: w.a, ok: false }).stdout,
  );
  assert.equal(report.results[0].status, "skipped");
  assert.match(report.results[0].detail, /active RL session/);
  assert.equal(mock.puts().length, 0);
});

test("PR updates reject a branch-filtered list containing another session's PRs", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    11: { raw: pr(11), behind: 2 },
    12: { raw: pr(12), behind: 2, rlManaged: false },
  });
  w.env.BAD_PR_LIST = "1";
  assert.match(
    w.rl(["pr", "update"], { cwd: w.a, ok: false }).stderr,
    /Invalid RL session PR list/,
  );
  assert.equal(mock.puts().length, 0);
});
