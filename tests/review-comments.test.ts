import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ROOT, CLI, Workspace, write } from "./helpers.js";

const moduleUrl = pathToFileURL(
  path.join(ROOT, "dist/review-comments.js"),
).href;
const { ReviewDraftStore, patchHasReviewLine } = await import(moduleUrl);
const patch =
  "@@ -2,3 +2,4 @@\n context\n-old\n+new\n+extra\n tail\n@@ -90 +91 @@\n-last\n+next\n\\ No newline at end of file";
const pr = {
  number: 99,
  title: "Comments",
  url: "https://github.com/example/repo/pull/99",
  headRefName: "feature/a",
  baseRefName: "develop",
  headRefOid: "a".repeat(40),
  baseRefOid: "b".repeat(40),
  files: [],
  commits: [],
};
const inline = {
  id: randomUUID(),
  path: "file 'quoted'.ts",
  line: 3,
  side: "RIGHT",
  body: "Needs validation\n`$(touch BAD)` ✓",
};

function api(w: Workspace, options: Record<string, unknown> = {}) {
  delete w.env.RL_PR_OFFLINE;
  w.env.REVIEW_API_FIXTURE = path.join(w.root, "review-api.json");
  w.env.REVIEW_API_LOG = path.join(w.root, "review-api.jsonl");
  w.env.REVIEW_API_POSTS = path.join(w.root, "review-posts.json");
  write(
    w.env.REVIEW_API_FIXTURE,
    JSON.stringify({
      pr,
      files: [{ filename: inline.path, patch }],
      ...options,
    }),
  );
  w.stub(
    "gh",
    `
const fs = require('node:fs');
const args=process.argv.slice(2), file=process.env.REVIEW_API_FIXTURE, data=JSON.parse(fs.readFileSync(file,'utf8'));
const input=args.includes('--input') ? JSON.parse(fs.readFileSync(0,'utf8')) : undefined;
fs.appendFileSync(process.env.REVIEW_API_LOG,JSON.stringify({args,input})+'\\n');
if(args[0]==='pr') { console.log(JSON.stringify(data.pr)); process.exit(0); }
if(data.authFail){ console.error('HTTP 403: insufficient permissions'); process.exit(1); }
const endpoint=args.find(a=>a.startsWith('repos/'));
if(!endpoint) throw new Error('missing endpoint');
if(endpoint.includes('/files?')) {
 if(data.moveDuringFiles){data.pr.headRefOid='c'.repeat(40); fs.writeFileSync(file,JSON.stringify(data));}
 console.log(JSON.stringify(endpoint.endsWith('page=1') && data.pageTwo ? Array.from({length:100},(_,i)=>({filename:'other'+i})) : data.files));
} else if(endpoint.includes('/reviews?')) {
 console.log(fs.existsSync(process.env.REVIEW_API_POSTS)?fs.readFileSync(process.env.REVIEW_API_POSTS,'utf8'):'[]');
} else if(endpoint.endsWith('/reviews') && input) {
 if(data.hangPost){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);process.exit(1);}
 if(data.rejectPost){console.error('HTTP 422: validation failed');process.exit(1);}
 const reviews=fs.existsSync(process.env.REVIEW_API_POSTS)?JSON.parse(fs.readFileSync(process.env.REVIEW_API_POSTS,'utf8')):[];
 const review={id:reviews.length+1,html_url:data.pr.url+'#pullrequestreview-'+(reviews.length+1),state:({COMMENT:'COMMENTED',APPROVE:'APPROVED',REQUEST_CHANGES:'CHANGES_REQUESTED'})[input.event],body:input.body,commit_id:input.commit_id,comments:input.comments};
 reviews.push(review);fs.writeFileSync(process.env.REVIEW_API_POSTS,JSON.stringify(reviews));
 if(data.dropResponse){console.error('connection closed');process.exit(1);}
 console.log(JSON.stringify(review));
} else {
 console.log(JSON.stringify({number:data.pr.number,html_url:data.wrongUrl||data.pr.url,head:{sha:data.pr.headRefOid},base:{sha:data.pr.baseRefOid},state:data.closed?'closed':'open'}));
}
`,
  );
}
async function run(w: Workspace, code: string) {
  return w.commandAsync([
    process.execPath,
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import fs from 'node:fs';import {GhReviewComments,ReviewDraftStore,emptyReviewDraft} from ${JSON.stringify(moduleUrl)};const pr=${JSON.stringify(pr)},inline=${JSON.stringify(inline)};const service=new GhReviewComments(${JSON.stringify(w.a)});${code}`,
  ]);
}
function calls(
  w: Workspace,
): { args: string[]; input?: Record<string, unknown> }[] {
  return fs
    .readFileSync(w.env.REVIEW_API_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("review locations distinguish deletion/addition/context sides, multiple hunks and omitted lines", () => {
  for (const [line, side, expected] of [
    [2, "LEFT", true],
    [2, "RIGHT", true],
    [3, "LEFT", true],
    [3, "RIGHT", true],
    [4, "RIGHT", true],
    [5, "RIGHT", true],
    [90, "LEFT", true],
    [91, "RIGHT", true],
    [90, "RIGHT", false],
    [1, "LEFT", false],
    [6, "RIGHT", false],
  ] as const)
    assert.equal(
      patchHasReviewLine(patch, line, side),
      expected,
      `${line}:${side}`,
    );
  assert.equal(patchHasReviewLine("Binary files differ", 1, "RIGHT"), false);
  assert.equal(patchHasReviewLine("@@ -1 +1 @@\n", 1, "RIGHT"), false);
  assert.equal(patchHasReviewLine("@@ -1,0 +1 @@\n+new", 1, "LEFT"), false);
});

test("drafts survive restart, isolate PRs, reject stale sessions and never overwrite corrupt data", async (t) => {
  const w = new Workspace(t);
  const store = new ReviewDraftStore(w.state, pr);
  const initial = store.load();
  const saved = await store.update(
    initial,
    (d: { comments: (typeof inline)[]; body: string }) => {
      d.comments.push(inline);
      d.body = "summary";
    },
  );
  assert.deepEqual(new ReviewDraftStore(w.state, pr).load(), saved);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  await assert.rejects(
    store.update(initial, (d: { body: string }) => {
      d.body = "lost update";
    }),
    /another session/,
  );
  assert.equal(
    new ReviewDraftStore(w.state, {
      ...pr,
      number: 100,
      url: pr.url.replace("99", "100"),
    }).load().comments.length,
    0,
  );
  await assert.rejects(
    store.update(saved, (d: { comments: (typeof inline)[] }) => {
      d.comments.push(inline);
    }),
    /Invalid/,
  );
  assert.deepEqual(store.load(), saved);
  fs.mkdirSync(`${store.file}.lock`);
  await assert.rejects(
    store.update(saved, () => {}),
    { code: "ELOCKED" },
  );
  fs.rmdirSync(`${store.file}.lock`);
  write(store.file, '{"version": 777}');
  assert.throws(() => store.load(), /Invalid saved/);
  assert.equal(fs.readFileSync(store.file, "utf8"), '{"version": 777}');
  fs.unlinkSync(store.file);
  fs.symlinkSync(path.join(w.root, "elsewhere"), store.file);
  assert.throws(() => store.load(), /symlinks/);
});

test("GitHub validation paginates files and never writes while drafting", async (t) => {
  const w = new Workspace(t);
  api(w, { pageTwo: true });
  await run(w, "await service.validate(pr,[inline]);");
  assert.ok(calls(w).some((c) => c.args.some((a) => a.includes("page=2"))));
  assert.ok(calls(w).every((c) => !c.input && c.args.includes("GET")));
  assert.equal(fs.existsSync(w.env.REVIEW_API_POSTS!), false);
});

test("Comment, Approve and Request changes submit one explicit review with safe stdin and exact line identities", async (t) => {
  const w = new Workspace(t);
  api(w);
  await run(
    w,
    `for(const event of ['COMMENT','APPROVE','REQUEST_CHANGES']) { const d=emptyReviewDraft(pr);d.comments=[inline];d.body='Review summary';let sent=false;const r=await service.submit(pr,d,event,randomUUID(),undefined,async()=>{sent=true});assert.ok(sent);assert.ok(r.id); }`,
  );
  const posted = calls(w).filter((c) => c.input);
  assert.equal(posted.length, 3);
  for (const call of posted) {
    assert.equal(call.input!.commit_id, pr.headRefOid);
    assert.deepEqual(call.input!.comments, [
      { path: inline.path, line: 3, side: "RIGHT", body: inline.body },
    ]);
    assert.ok(!call.args.join(" ").includes(inline.body));
    assert.ok(call.args.includes("github.com"));
    assert.equal(
      call.input!.event,
      ["COMMENT", "APPROVE", "REQUEST_CHANGES"][posted.indexOf(call)],
    );
  }
  assert.equal(fs.existsSync(path.join(w.root, "BAD")), false);
});

test("stale revisions, moving targets, wrong repositories and unsupported locations block writes", async (t) => {
  const w = new Workspace(t);
  const scenarios = [
    { moveDuringFiles: true },
    { closed: true },
    { wrongUrl: "https://github.com/other/repo/pull/99" },
    { files: [{ filename: inline.path }] },
    { files: [{ filename: inline.path, patch: "@@ -90 +90 @@\n-old\n+new" }] },
    { files: [] },
    { authFail: true },
  ];
  for (const scenario of scenarios) {
    api(w, scenario);
    await run(
      w,
      `const d=emptyReviewDraft(pr);d.body='Summary';d.comments=[inline];let sent=false;await assert.rejects(service.submit(pr,d,'COMMENT',randomUUID(),undefined,async()=>{sent=true}));assert.equal(sent,false);`,
    );
  }
  api(w);
  await run(
    w,
    `const d=emptyReviewDraft(pr);d.head='d'.repeat(40);d.body='stale';await assert.rejects(service.submit(pr,d,'COMMENT',randomUUID()),/older PR revision/);const empty=emptyReviewDraft(pr);await assert.rejects(service.submit(pr,empty,'REQUEST_CHANGES',randomUUID()),/summary/);await assert.rejects(service.submit(pr,empty,'COMMENT',randomUUID()),/first/);`,
  );
  assert.equal(fs.existsSync(w.env.REVIEW_API_POSTS!), false);
});

test("interrupted submission persists a protected draft and finds the accepted review without posting twice", async (t) => {
  const w = new Workspace(t);
  api(w, { dropResponse: true });
  const code = `const store=new ReviewDraftStore(${JSON.stringify(w.state)},pr);let d=store.load();d=await store.update(d,n=>{n.body='Summary';n.comments=[inline]});const token=randomUUID();await assert.rejects(service.submit(pr,d,'COMMENT',token,undefined,async()=>{d=await store.update(d,n=>{n.attempt={token,event:'COMMENT'}})}),/connection closed/);assert.equal(store.load().attempt.token,token);`;
  await run(w, code);
  await run(
    w,
    `const store=new ReviewDraftStore(${JSON.stringify(w.state)},pr);const d=store.load();const result=await service.findSubmission(pr,d.attempt.token);assert.equal(result.id,1);await store.update(d,n=>Object.assign(n,emptyReviewDraft(pr),{attempt:undefined}));`,
  );
  assert.equal(calls(w).filter((c) => c.input).length, 1);
  assert.equal(new ReviewDraftStore(w.state, pr).load().comments.length, 0);
});

test("aborting a blocked review write returns promptly and preserves its protected draft", async (t) => {
  const w = new Workspace(t);
  api(w, { hangPost: true });
  await run(
    w,
    `const store=new ReviewDraftStore(${JSON.stringify(w.state)},pr);let draft=store.load();draft=await store.update(draft,d=>{d.body='Summary'});const controller=new AbortController(),token=randomUUID();const start=performance.now();await assert.rejects(service.submit(pr,draft,'COMMENT',token,controller.signal,async()=>{draft=await store.update(draft,d=>{d.attempt={token,event:'COMMENT'}});setTimeout(()=>controller.abort(),100)}));assert.ok(performance.now()-start<4000);assert.equal(store.load().attempt.token,token);assert.equal(await service.findSubmission(pr,token),undefined);await assert.rejects(service.submit(pr,store.load(),'COMMENT',token),/verification/);`,
  );
  assert.equal(fs.existsSync(w.env.REVIEW_API_POSTS!), false);
});

test("real PR terminal drafts, edits, deletes, confirms and submits comments through the provider boundary", async (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "pr-comment.txt"), "review this line\n");
  w.git(w.a, "add", "pr-comment.txt");
  w.git(w.a, "commit", "-qm", "Review comment source");
  const head = w.git(w.a, "rev-parse", "HEAD"),
    base = w.git(w.repo, "rev-parse", "HEAD");
  const actualPr = { ...pr, headRefOid: head, baseRefOid: base };
  api(w, {
    pr: actualPr,
    files: [
      { filename: "pr-comment.txt", patch: "@@ -0,0 +1 @@\n+review this line" },
    ],
  });
  // Exercise remote mode with an actual object-only Git cache and fixture transport.
  w.git(w.repo, "update-ref", "refs/pull/99/head", head);
  w.git(w.repo, "config", "uploadpack.allowFilter", "true");
  w.env.REVIEW_SOURCE = pathToFileURL(w.repo).href;
  w.env.REVIEW_REAL_GIT = w.command(["which", "git"]).stdout.trim();
  write(
    path.join(w.bin, "git"),
    '#!/bin/sh\nexec "$REVIEW_REAL_GIT" -c "url.$REVIEW_SOURCE.insteadOf=https://github.com/example/repo.git" "$@"\n',
  );
  fs.chmodSync(path.join(w.bin, "git"), 0o755);
  const output = await w.commandAsync(
    [
      "python3",
      path.join(ROOT, "tests/review-live-pty.py"),
      w.a,
      process.execPath,
      CLI,
      w.repo,
      w.state,
      path.join(w.root, "worktrees"),
      "pr-comments",
    ],
    { timeoutMs: 90000 },
  );
  assert.match(output, /PTY:.*passed/);
  const posted = JSON.parse(fs.readFileSync(w.env.REVIEW_API_POSTS!, "utf8"));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].commit_id, head);
  assert.equal(posted[0].comments.length, 1);
  assert.equal(posted[0].comments[0].path, "pr-comment.txt");
  assert.equal(posted[0].comments[0].line, 1);
  assert.equal(posted[0].comments[0].side, "RIGHT");
  assert.equal(posted[0].comments[0].body, "edited comment\nsecond paragraph");
  assert.ok(posted[0].body.startsWith("review summary"));
  assert.equal(w.git(w.a, "status", "--porcelain"), "");
  w.env.REVIEW_LOCAL_COMMENTS = "1";
  const fixture = JSON.parse(
    fs.readFileSync(w.env.REVIEW_API_FIXTURE!, "utf8"),
  );
  fixture.dropResponse = true;
  write(w.env.REVIEW_API_FIXTURE!, JSON.stringify(fixture));
  const local = await w.commandAsync(
    [
      "python3",
      path.join(ROOT, "tests/review-live-pty.py"),
      w.a,
      process.execPath,
      CLI,
      w.repo,
      w.state,
      path.join(w.root, "worktrees"),
      "pr-comments",
    ],
    { timeoutMs: 90000 },
  );
  assert.match(local, /PTY:.*passed/);
  assert.equal(
    JSON.parse(fs.readFileSync(w.env.REVIEW_API_POSTS!, "utf8")).length,
    2,
  );
  assert.equal(w.git(w.a, "status", "--porcelain"), "");
});
