import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, Workspace, read, write } from "./helpers.js";

function review(w: Workspace, args: string[] = [], ok = true) {
  return JSON.parse(
    w.rl(["review", ...args, "--json"], { cwd: w.repo, ok }).stdout,
  );
}
function base(w: Workspace, name = "feature/a") {
  return review(w, [name, "--base", "develop"]);
}
function queue(w: Workspace, filter = "all") {
  return review(w, ["--filter", filter]).worktrees;
}
function ai(w: Workspace, provider = "codex") {
  w.env.REVIEW_AI_LOG = path.join(w.root, "review-ai.json");
  w.stub(
    provider,
    `
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='app-server') process.exit(0);
const input=fs.readFileSync(0,'utf8');fs.writeFileSync(process.env.REVIEW_AI_LOG,JSON.stringify({args,cwd:process.cwd(),input}));
if(process.env.REVIEW_AI_FAIL){console.error('Authentication unavailable');process.exit(1);}
const data=JSON.parse(input.split('\\n\\n').at(-1));
const ids=data.evidence.files.map(file=>file.id);
const result={overview:'Implemented the supplied feature',architecture:['Updated the changed source interface'],behavior:['New behaviour described by the patch'],testing:['Tests were not executed by this analysis'],concerns:[],groups:[{title:'Implementation',explanation:'Related source changes',members:process.env.REVIEW_AI_INVALID?['invented-id']:ids,concerns:[]}],review:{summary:'Reviewed supplied Git evidence',complete:true,findings:[],limitations:[],checkRequests:[],routingLeads:[]}};
if(process.env.REVIEW_AI_MUTATE) fs.appendFileSync(process.env.REVIEW_AI_MUTATE,'later correction\\n');
const output=args.indexOf('--output-last-message');if(output>=0)fs.writeFileSync(args[output+1],JSON.stringify(result));
else console.log(JSON.stringify({structured_output:result,is_error:false}));
`,
  );
}

test("the review queue requires explicit legacy baselines and includes clean new feature branches", (t) => {
  const w = new Workspace(t);
  let rows = queue(w);
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((row: { status: string }) => row.status === "Baseline required"),
  );
  const created = w
    .rl(["switch", "new-feature", "-c", "--base", "develop", "--no-fetch"])
    .stdout.trim();
  rows = queue(w);
  const fresh = rows.find((row: { path: string }) => row.path === created);
  assert.equal(fresh.status, "Clean");
  assert.equal(fresh.files, 0);
  assert.equal(queue(w, "clean").length, 1);
  assert.equal(queue(w, "needs-review").length, 2);
  base(w);
  write(path.join(w.a, "new.ts"), "export const value = 1;\n");
  const row = queue(w).find(
    (row: { branch: string }) => row.branch === "feature/a",
  );
  assert.equal(row.status, "Unreviewed");
  assert.equal(row.files, 1);
  assert.equal(row.layers.untracked, 1);
  assert.equal(row.layers.unstaged, 0);
  assert.equal(row.agent, "unknown");
});
test("feature diffs include committed, staged, unstaged and untracked changes from the fixed baseline", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, "committed.txt"), "first implementation\n");
  w.git(w.a, "add", "committed.txt");
  w.git(w.a, "commit", "-qm", "Feature");
  write(path.join(w.a, "staged.txt"), "staged\n");
  w.git(w.a, "add", "staged.txt");
  write(path.join(w.a, "committed.txt"), "working correction\n");
  write(path.join(w.a, "untracked.txt"), "untracked source\n");
  const info = review(w, ["feature/a"]);
  assert.equal(info.worktree.files, 3);
  assert.equal(info.worktree.layers.committed, 1);
  assert.equal(info.worktree.layers.staged, 1);
  assert.equal(info.worktree.layers.untracked, 1);
  const output = w.rl(["review", "feature/a", "--diff"], {
    cwd: w.repo,
  }).stdout;
  for (const name of ["committed.txt", "staged.txt", "untracked.txt"])
    assert.ok(output.includes(name));
  assert.match(output, /working correction/);
  w.git(w.repo, "commit", "-q", "--allow-empty", "-m", "Moving base");
  assert.equal(
    review(w, ["feature/a"]).worktree.baseline,
    info.worktree.baseline,
  );
});
test("checkpoints preserve uncommitted and staged versions and correction diffs compare exact snapshots", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, "feature.txt"), "first\n");
  w.git(w.a, "add", "feature.txt");
  write(path.join(w.a, "feature.txt"), "working first\n");
  const originalIndex = fs.readFileSync(
    w.git(w.a, "rev-parse", "--git-path", "index"),
  );
  const checkpoint = review(w, [
    "feature/a",
    "--checkpoint",
    "--label",
    "First pass",
  ]);
  assert.deepEqual(
    fs.readFileSync(w.git(w.a, "rev-parse", "--git-path", "index")),
    originalIndex,
  );
  write(path.join(w.a, "feature.txt"), "working corrected\n");
  write(path.join(w.a, "regression.test.ts"), "new regression\n");
  const current = review(w, ["feature/a", "--since-last-review"]);
  assert.equal(current.files.length, 2);
  const patch = w.rl(["review", "feature/a", "--since", checkpoint.id], {
    cwd: w.repo,
  }).stdout;
  assert.match(patch, /working first/);
  assert.match(patch, /working corrected/);
  assert.match(patch, /regression.test.ts/);
  const points = review(w, ["feature/a", "--checkpoints"]);
  assert.equal(points.length, 1);
  assert.equal(points[0].label, "First pass");
  w.git(w.repo, "gc", "--prune=now");
  const historical = review(w, [
    "feature/a",
    "--snapshot",
    checkpoint.snapshot,
  ]);
  assert.notEqual(
    historical.snapshot.worktreeTree,
    current.snapshot.worktreeTree,
  );
});
test("approval applies only to the inspected source and becomes changed-since-review after later edits", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, "feature.txt"), "implementation\n");
  review(w, ["feature/a"]);
  const approved = review(w, ["feature/a", "--approve"]);
  assert.equal(approved.approved, true);
  assert.equal(
    queue(w).find((row: { branch: string }) => row.branch === "feature/a")
      .status,
    "Reviewed",
  );
  write(path.join(w.a, "feature.txt"), "correction\n");
  assert.equal(
    queue(w).find((row: { branch: string }) => row.branch === "feature/a")
      .status,
    "Changed since review",
  );
  assert.match(
    w.rl(["review", "feature/a", "--approve"], { cwd: w.repo, ok: false })
      .stderr,
    /Source changed/,
  );
  review(w, ["feature/a"]);
  review(w, ["feature/a", "--approve"]);
  assert.equal(queue(w, "changed").length, 0);
});
test("omitted sensitive or oversized source prevents checkpoints and approvals while manual review remains available", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, ".env.local"), "secret\n");
  fs.writeFileSync(path.join(w.a, "large.dat"), Buffer.alloc(17 * 1024 * 1024));
  const info = review(w, ["feature/a"]);
  assert.equal(info.snapshot.complete, false);
  assert.deepEqual(
    new Set(info.snapshot.excluded),
    new Set([".env.local", "large.dat"]),
  );
  assert.match(
    w.rl(["review", "feature/a", "--checkpoint"], { cwd: w.repo, ok: false })
      .stderr,
    /incomplete/,
  );
  assert.match(
    w.rl(["review", "feature/a", "--approve"], { cwd: w.repo, ok: false })
      .stderr,
    /incomplete/,
  );
  const manual = w.rl(["review", "feature/a", "--summary", "--no-ai"], {
    cwd: w.repo,
  }).stdout;
  assert.match(manual, /Snapshot incomplete/);
  assert.match(manual, /not executed tests/);
});
test("queue activity uses observed hooks without treating stopped turns as completed implementations", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, "feature.ts"), "change\n");
  const sid = "11111111-1111-4111-8111-111111111111";
  w.hook("codex", sid, { event: "UserPromptSubmit" });
  let rows = queue(w, "active");
  assert.equal(rows.length, 1);
  assert.match(rows[0].agent, /working observed/);
  assert.equal(rows[0].ready, false);
  w.hook("codex", sid, { event: "Stop" });
  rows = queue(w);
  assert.match(
    rows.find((row: { branch: string }) => row.branch === "feature/a").agent,
    /last turn stopped/,
  );
  assert.equal(queue(w, "ready").length, 0);
  review(w, ["feature/a", "--ready"]);
  assert.equal(queue(w, "ready").length, 1);
  write(path.join(w.a, "feature.ts"), "changed again\n");
  assert.equal(queue(w, "ready").length, 0);
});
test("rebased history keeps its original baseline, and missing or detached worktrees do not break the queue", (t) => {
  const w = new Workspace(t);
  const baseline = base(w).worktree.baseline;
  write(path.join(w.a, "feature.ts"), "rewritten\n");
  w.git(w.a, "add", "feature.ts");
  const tree = w.git(w.a, "write-tree");
  const orphan = w.git(w.a, "commit-tree", tree, "-m", "Rewritten history");
  w.git(w.a, "reset", "--hard", orphan);
  let row = queue(w).find(
    (row: { branch: string }) => row.branch === "feature/a",
  );
  assert.equal(row.baseline, baseline);
  assert.equal(row.files, 1);
  assert.match(row.warnings.join(" "), /rewritten or rebased/);
  w.git(w.b, "checkout", "--detach");
  row = queue(w).find((row: { path: string }) => row.path === w.b);
  assert.equal(row.status, "Unavailable");
  fs.rmSync(w.b, { recursive: true });
  assert.ok(
    queue(w).some((row: { status: string }) => row.status === "Unavailable"),
  );
});
test("AI summaries and groups use immutable Git evidence and never create a human approval or checkpoint", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, "feature.ts"), "export const feature = true;\n");
  ai(w);
  const result = review(w, ["feature/a", "--summary", "--provider", "codex"]);
  assert.equal(result.analysis.overview, "Implemented the supplied feature");
  assert.equal(result.analysis.stale, false);
  assert.deepEqual(result.verifiedTestExecutions, []);
  const request = JSON.parse(read(w.env.REVIEW_AI_LOG!));
  assert.ok(request.args.includes("read-only"));
  assert.ok(request.args.includes("--ephemeral"));
  assert.equal(request.cwd, w.a);
  assert.ok(request.input.includes(result.snapshot.worktreeTree));
  const state = review(w, ["feature/a"]).review;
  assert.equal(state.checkpoints.length, 0);
  assert.equal(state.approval, undefined);
  assert.ok(
    result.analysis.groups[0].members.every((id: string) =>
      result.evidence.files.some((file: { id: string }) => file.id === id),
    ),
  );
});
test("provider errors, invalid group identifiers and changing source fall back honestly to manual review", (t) => {
  const w = new Workspace(t);
  base(w);
  const source = path.join(w.a, "feature.ts");
  write(source, "feature\n");
  ai(w);
  w.env.REVIEW_AI_FAIL = "1";
  let result = review(w, ["feature/a", "--summary"]);
  assert.equal(result.analysis, null);
  assert.match(result.error, /Authentication/);
  delete w.env.REVIEW_AI_FAIL;
  w.env.REVIEW_AI_INVALID = "1";
  result = review(w, ["feature/a", "--summary"]);
  assert.equal(result.analysis, null);
  assert.match(result.error, /unknown Git file\/hunk/);
  delete w.env.REVIEW_AI_INVALID;
  w.env.REVIEW_AI_MUTATE = source;
  result = review(w, ["feature/a", "--ai-review"]);
  assert.equal(result.analysis.stale, true);
  assert.match(
    w.rl(["review", "feature/a", "--approve"], { cwd: w.repo, ok: false })
      .stderr,
    /Source changed/,
  );
});
test("Claude can review independently with tools disabled, while no-ai and live Lazygit paths remain functional", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, "feature.ts"), "feature\n");
  ai(w, "claude");
  const result = review(w, [
    "feature/a",
    "--ai-review",
    "--provider",
    "claude",
  ]);
  assert.equal(result.analysis.provider, "claude");
  const request = JSON.parse(read(w.env.REVIEW_AI_LOG!));
  assert.ok(request.args.includes("--tools"));
  assert.ok(request.args.includes("--no-session-persistence"));
  fs.unlinkSync(w.env.REVIEW_AI_LOG!);
  review(w, ["feature/a", "--summary", "--no-ai"]);
  assert.ok(!fs.existsSync(w.env.REVIEW_AI_LOG!));
  w.stub("lazygit", "process.exit(0)");
  const live = w.rl(["review", "feature/a", "--lazygit"], { cwd: w.repo });
  assert.match(live.stderr, /live working-tree view/);
});
test("missing Lazygit falls back to the fixed-baseline Git diff without requiring a model", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, "feature.ts"), "committed feature in fallback viewer\n");
  w.git(w.a, "add", "feature.ts");
  w.git(w.a, "commit", "-qm", "Feature");
  const tools = path.join(w.root, "git-only-tools");
  fs.mkdirSync(tools);
  fs.symlinkSync(
    w.command(["which", "git"]).stdout.trim(),
    path.join(tools, "git"),
  );
  w.env.PATH = tools;
  const result = w.command(
    [
      process.execPath,
      path.join(ROOT, "dist/cli.js"),
      "review",
      "feature/a",
      "--lazygit",
      "--repo",
      w.repo,
      "--state-dir",
      w.state,
      "--base-dir",
      path.join(w.root, "worktrees/example"),
    ],
    { cwd: w.repo },
  );
  assert.match(result.stderr, /Lazygit is not installed/);
  assert.match(result.stdout, /Complete feature/);
  assert.match(result.stdout, /committed feature in fallback viewer/);
  assert.ok(!fs.existsSync(w.log));
});
test("AI evidence reads surrounding TypeScript imports from the immutable source tree", (t) => {
  const w = new Workspace(t);
  write(
    path.join(w.a, "helper.ts"),
    "export const existingHelper = () => 1;\n",
  );
  w.git(w.a, "add", "helper.ts");
  w.git(w.a, "commit", "-qm", "Existing helper");
  review(w, ["feature/a", "--base", "HEAD"]);
  write(
    path.join(w.a, "feature.ts"),
    "import { existingHelper } from './helper.js';\nexport const feature = existingHelper();\n",
  );
  const result = review(w, ["feature/a", "--summary", "--no-ai"]);
  const helper = result.evidence.context.find(
    (item: { path: string }) => item.path === "helper.ts",
  );
  assert.match(helper.content, /existingHelper/);
  assert.equal(result.evidence.files.length, 1);
});
test("terminal queue actions use keyboard selection and show Git diffs without advancing checkpoints", (t) => {
  const w = new Workspace(t);
  const target = w
    .rl(["switch", "ui-feature", "-c", "--base", "develop", "--no-fetch"])
    .stdout.trim();
  write(path.join(target, "feature.ts"), "visible patch\n");
  w.env.REVIEW_PICK_COUNT = path.join(w.root, "picker-count");
  w.env.REVIEW_PICK_ARGS = path.join(w.root, "picker-args.json");
  w.stub(
    "fzf",
    `const fs=require('node:fs');if(fs.existsSync(process.env.REVIEW_PICK_COUNT))process.exit(130);fs.writeFileSync(process.env.REVIEW_PICK_COUNT,'1');fs.writeFileSync(process.env.REVIEW_PICK_ARGS,JSON.stringify(process.argv.slice(2)));const lines=fs.readFileSync(0,'utf8').trimEnd().split('\\n');console.log('alt-d\\n'+lines.find(line=>line.includes('ui-feature')));`,
  );
  const output = w.rl(["review", "--interactive", "--no-ai"], {
    cwd: w.repo,
  }).stdout;
  assert.match(output, /visible patch/);
  assert.ok(
    JSON.parse(read(w.env.REVIEW_PICK_ARGS)).some((arg: string) =>
      arg.includes("--expect="),
    ),
  );
  assert.equal(review(w, ["ui-feature"]).review.checkpoints.length, 0);
});
test("the queue approval shortcut cannot approve a newer source revision than the last inspected snapshot", (t) => {
  const w = new Workspace(t);
  base(w);
  const source = path.join(w.a, "feature.ts");
  write(source, "inspected version\n");
  review(w, ["feature/a", "--summary", "--no-ai"]);
  write(source, "uninspected correction\n");
  w.env.REVIEW_PICK_COUNT = path.join(w.root, "approval-picker-count");
  w.stub(
    "fzf",
    `const fs=require('node:fs');if(fs.existsSync(process.env.REVIEW_PICK_COUNT))process.exit(130);fs.writeFileSync(process.env.REVIEW_PICK_COUNT,'1');const lines=fs.readFileSync(0,'utf8').trimEnd().split('\\n');console.log('alt-a\\n'+lines.find(line=>line.includes('feature/a')));`,
  );
  const output = w.rl(["review", "--interactive", "--no-ai"], {
    cwd: w.repo,
  }).stdout;
  assert.match(output, /Source changed since the review snapshot/);
  assert.equal(review(w, ["feature/a", "--checkpoints"]).length, 0);
});
test("historical summaries and checkpoint corrections keep counts and evidence tied to their selected scope", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, "first.ts"), "first version\n");
  const point = review(w, ["feature/a", "--checkpoint"]);
  write(path.join(w.a, "first.ts"), "corrected version\n");
  write(path.join(w.a, "second.ts"), "second file\n");
  const old = review(w, [
    "feature/a",
    "--snapshot",
    point.snapshot,
    "--summary",
    "--no-ai",
  ]);
  assert.equal(old.worktree.status, "Historical snapshot");
  assert.equal(old.worktree.files, 1);
  assert.equal(old.evidence.files.length, 1);
  assert.ok(
    !old.evidence.patches.some((item: { patch: string }) =>
      item.patch.includes("corrected version"),
    ),
  );
  const correction = review(w, [
    "feature/a",
    "--since-last-review",
    "--summary",
    "--no-ai",
  ]);
  assert.equal(correction.worktree.files, 2);
  assert.match(correction.worktree.scope, /since checkpoint/);
  assert.equal(correction.evidence.files.length, 2);
  w.git(w.repo, "gc", "--prune=now");
  assert.match(w.git(w.repo, "log", "--all", "--oneline"), /Initial/);
  assert.equal(
    review(w, ["feature/a", "--snapshot", point.snapshot]).snapshot
      .worktreeTree,
    old.snapshot.worktreeTree,
  );
});
test("a specific legacy worktree can choose its baseline and inspect a diff entirely through the terminal UI", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "feature.ts"), "feature from the chosen baseline\n");
  w.git(w.a, "add", "feature.ts");
  w.git(w.a, "commit", "-qm", "Feature");
  w.env.REVIEW_MENU_STEP = path.join(w.root, "review-menu-step");
  w.stub(
    "fzf",
    `const fs=require('node:fs');const count=fs.existsSync(process.env.REVIEW_MENU_STEP)?Number(fs.readFileSync(process.env.REVIEW_MENU_STEP,'utf8')):0;fs.writeFileSync(process.env.REVIEW_MENU_STEP,String(count+1));const action=['baseline','refs/heads/develop','diff'][count];if(!action)process.exit(130);const rows=fs.readFileSync(0,'utf8').trimEnd().split('\\n');const selected=rows.find(row=>row.startsWith(action+'\\t'));if(!selected)process.exit(9);console.log(selected);`,
  );
  const output = w.rl(["review", "feature/a", "--interactive", "--no-ai"], {
    cwd: w.repo,
  }).stdout;
  assert.match(output, /Pinned baseline/);
  assert.match(output, /feature from the chosen baseline/);
  assert.equal(review(w, ["feature/a", "--checkpoints"]).length, 0);
});
test("moving source is visibly unstable and cannot become a checkpoint", (t) => {
  const w = new Workspace(t);
  base(w);
  const source = path.join(w.a, "feature.ts");
  write(source, "first\n");
  w.env.REVIEW_REAL_GIT = w.command(["which", "git"]).stdout.trim();
  w.env.REVIEW_MOVING_SOURCE = source;
  w.stub(
    "git",
    `const fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);if(args.includes('write-tree'))fs.appendFileSync(process.env.REVIEW_MOVING_SOURCE,'changing\\n');const result=cp.spawnSync(process.env.REVIEW_REAL_GIT,args,{stdio:'inherit'});process.exit(result.status??1);`,
  );
  const info = review(w, ["feature/a"]);
  assert.equal(info.snapshot.stable, false);
  assert.equal(info.worktree.status, "Snapshot moving");
  assert.match(
    w.rl(["review", "feature/a", "--checkpoint"], { cwd: w.repo, ok: false })
      .stderr,
    /unstable/,
  );
  assert.equal(review(w, ["feature/a", "--checkpoints"]).length, 0);
});
test("new feedback revokes a prior approval and tracks subsequent corrections without advancing checkpoints", (t) => {
  const w = new Workspace(t);
  base(w);
  write(path.join(w.a, "feature.ts"), "implementation\n");
  review(w, ["feature/a"]);
  review(w, ["feature/a", "--approve"]);
  w.rl(["feedback", "feature/a", "--message", "Make the correction"], {
    cwd: w.repo,
  });
  let row = queue(w).find(
    (row: { branch: string }) => row.branch === "feature/a",
  );
  assert.equal(row.status, "Changes requested");
  write(path.join(w.a, "feature.ts"), "correction\n");
  row = queue(w).find((row: { branch: string }) => row.branch === "feature/a");
  assert.equal(row.status, "Changed since review");
  assert.equal(review(w, ["feature/a", "--checkpoints"]).length, 1);
});
test("editor arguments are tokenized without executing shell interpolation", (t) => {
  const w = new Workspace(t);
  const script = `import {commandWords} from ${JSON.stringify(path.join(ROOT, "dist/review-terminal.js"))};console.log(JSON.stringify(commandWords(process.argv[1])));`;
  const result = JSON.parse(
    w.command([
      process.execPath,
      "--input-type=module",
      "-e",
      script,
      '"/path with spaces/editor" --wait "$(touch injected)"',
    ]).stdout,
  );
  assert.deepEqual(result, [
    "/path with spaces/editor",
    "--wait",
    "$(touch injected)",
  ]);
  assert.ok(!fs.existsSync(path.join(w.root, "injected")));
});
