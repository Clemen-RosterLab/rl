import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, read, readJson, write } from "./helpers.js";

function hook(
  w: Workspace,
  event: string,
  sid: string,
  extra = {},
  cwd = w.a,
  owner = cwd,
  ok = true,
) {
  const groups = readJson(path.join(owner, ".agents/hooks.json"))[
    "rl-session-hooks"
  ][event];
  const command = groups.at(-1).command ?? groups.at(-1).hooks[0].command;
  return w.command(["/bin/sh", "-c", command], {
    cwd,
    ok,
    input: JSON.stringify({
      conversationId: sid,
      workspacePaths: [cwd],
      ...extra,
    }),
  });
}
function rpc(
  w: Workspace,
  name: string,
  input = {},
  server?: { command: string; args: string[] },
) {
  const result = w.command(
    server
      ? [server.command, ...server.args]
      : [path.join(import.meta.dirname, "../bin/rl"), "agent", "mcp"],
    {
      cwd: server ? w.b : w.a,
      input:
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "agy-test", version: "1" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name, arguments: input },
          },
        ]
          .map((value) => JSON.stringify(value))
          .join("\n") + "\n",
    },
  );
  const response = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  assert.equal(response.result.isError, undefined, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}
function stub(w: Workspace) {
  w.env.AGY_CAPTURE = path.join(w.root, "agy-invocation.json");
  w.stub(
    "agy",
    `
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--help')){console.log('Usage of agy: --print --conversation --prompt-interactive');process.exit(0);}
const input=fs.readFileSync(0,'utf8');fs.writeFileSync(process.env.AGY_CAPTURE,JSON.stringify({args,input,cwd:process.cwd(),ephemeral:process.env.RL_WORKFLOW_RUN}));
if(!args.includes('--input-format'))process.exit(Number(process.env.AGY_EXIT||0));
const sid=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const result={conversation_id:process.env.AGY_WRONG_SESSION||sid,status:process.env.AGY_FAILURE?'ERROR':'SUCCESS',error:process.env.AGY_FAILURE?'Provider unavailable':undefined,response:'Completed'};
if(args.includes('--json-schema')){
const data=JSON.parse(JSON.parse(input).message.content.split('\\n\\n').at(-1));
result.structured_output={overview:'Summary grounded in supplied source',architecture:[],behavior:['Changed feature source'],testing:['No tests executed'],concerns:[],groups:[{title:'Feature',explanation:'Source changes',members:data.evidence.files.map(file=>file.id),concerns:[]}],review:{summary:'Independent review',complete:true,findings:[],limitations:[],checkRequests:[],routingLeads:[]}};
}
console.log(JSON.stringify({event:'init',conversation_id:sid}));console.log(JSON.stringify({event:'result',result}));
`,
  );
}

test("Antigravity hooks use native configuration and responses, preserve user hooks, and track only observed activity", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  const file = path.join(w.a, ".agents/hooks.json"),
    config = readJson(file);
  assert.equal(config.hooks, undefined);
  assert.equal(config["rl-session-hooks"].SessionStart[0].type, "command");
  assert.ok(Array.isArray(config["rl-session-hooks"].PreToolUse[0].hooks));
  config.custom = { Stop: [{ command: "custom-stop", timeout: 5 }] };
  write(file, JSON.stringify(config));
  w.rl(["setup", "adopt"], { cwd: w.a });
  const before = read(file);
  w.rl(["setup", "adopt"], { cwd: w.a });
  assert.equal(read(file), before);
  assert.deepEqual(readJson(file).custom, config.custom);
  const started = JSON.parse(hook(w, "SessionStart", sid).stdout);
  assert.match(started.injectSteps[0].ephemeralMessage, /agent=agy/);
  assert.equal(w.status().sessions.agy[0].id, sid);
  assert.match(
    w.rl(["status", "--workspace"], { cwd: w.a }).stdout,
    /Antigravity\s+1 saved/,
  );
  assert.equal(
    JSON.parse(w.rl(["status", "--json"], { cwd: w.a }).stdout).sessions.agy,
    1,
  );
  hook(w, "PreInvocation", sid);
  assert.equal(w.status().activity.agy[0].state, "working");
  hook(w, "Stop", sid, { fullyIdle: false });
  assert.equal(w.status().activity.agy[0].state, "working");
  assert.deepEqual(
    JSON.parse(hook(w, "Stop", sid, { fullyIdle: true }).stdout),
    { decision: "allow" },
  );
  assert.equal(w.status().activity.agy[0].state, "idle");
  stub(w);
  const doctor = JSON.parse(
    w.rl(["doctor", "agy", "--json"], { cwd: w.a }).stdout,
  ).agents[0];
  assert.equal(doctor.installed, true);
  assert.equal(doctor.launchVerified, true);
  assert.equal(doctor.delivery, "observed");
});

test("Antigravity rejects copied hooks, ambiguous mounted workspaces and sessions owned by another worktree", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  hook(w, "SessionStart", sid, {}, w.b);
  assert.match(
    hook(w, "SessionStart", randomUUID(), {}, w.b, w.a, false).stderr,
    /different RL instance/,
  );
  assert.match(
    hook(
      w,
      "SessionStart",
      randomUUID(),
      { workspacePaths: [w.a, w.b] },
      w.a,
      w.a,
      false,
    ).stderr,
    /exactly one absolute workspace/,
  );
  assert.match(
    hook(w, "SessionStart", sid, {}, w.a, w.a, false).stderr,
    /already belongs/,
  );
  assert.equal(w.status().sessions.agy, undefined);
  assert.equal(w.status(w.b).sessions.agy[0].id, sid);
  assert.ok(!fs.existsSync(w.log));
});

test("Antigravity remains optional in the default doctor report for existing Codex and Claude users", (t) => {
  const w = new Workspace(t);
  const git = w.command(["which", "git"]).stdout.trim();
  fs.unlinkSync(path.join(w.bin, "agy"));
  fs.symlinkSync(git, path.join(w.bin, "git"));
  fs.symlinkSync(process.execPath, path.join(w.bin, "node"));
  w.env.PATH = w.bin;
  const result = JSON.parse(
    w.command(
      [
        process.execPath,
        path.join(import.meta.dirname, "../dist/cli.js"),
        "state",
        "--repo",
        w.repo,
        "--state-dir",
        w.state,
        "doctor",
        "--json",
      ],
      { cwd: w.a },
    ).stdout,
  );
  assert.deepEqual(
    result.agents.map((entry: { agent: string }) => entry.agent),
    ["codex", "claude"],
  );
});

test("Antigravity starts, runs, switches and resumes through the existing worktree/session commands", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  stub(w);
  w.rl(["agent", "start", "agy", "--", "--model", "test-model"], { cwd: w.a });
  assert.deepEqual(readJson(w.env.AGY_CAPTURE!).args, [
    "--model",
    "test-model",
  ]);
  w.rl(
    [
      "agent",
      "run",
      "agy",
      "--prompt",
      "A literal $(touch unexpected) prompt",
      "--",
      "--effort",
      "max",
    ],
    { cwd: w.a },
  );
  assert.deepEqual(readJson(w.env.AGY_CAPTURE!).args, [
    "--effort",
    "max",
    "--print",
    "A literal $(touch unexpected) prompt",
  ]);
  w.rl(["agent", "save", "agy", sid], { cwd: w.a });
  w.rl(["resume", "agy", "--latest"], { cwd: w.a });
  assert.deepEqual(readJson(w.env.AGY_CAPTURE!).args, ["--conversation", sid]);
  w.rl(["resume", "--latest"], { cwd: w.a });
  assert.deepEqual(readJson(w.env.AGY_CAPTURE!).args, ["--conversation", sid]);
  w.rl(["switch", "feature/a", "--agent", "agy"], { cwd: w.repo });
  assert.equal(readJson(w.env.AGY_CAPTURE!).cwd, w.a);
  assert.ok(!fs.existsSync(path.join(w.a, "unexpected")));
});

test("Antigravity MCP setup is workspace-local, idempotent and uniquely named, including after copying configuration", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  const a = path.join(w.a, ".agents/mcp_config.json"),
    b = path.join(w.b, ".agents/mcp_config.json");
  write(
    a,
    JSON.stringify({
      mcpServers: { other: { command: "unchanged" } },
      theme: "keep",
    }),
  );
  w.rl(["setup", "mcp", "agy"], { cwd: w.a });
  const before = read(a),
    config = readJson(a),
    name = `rl-${w.status().key}`;
  assert.equal(config.theme, "keep");
  assert.deepEqual(config.mcpServers.other, { command: "unchanged" });
  assert.equal(config.mcpServers[name].args.at(-1), w.a);
  w.rl(["setup", "mcp", "agy"], { cwd: w.a });
  assert.equal(read(a), before);
  assert.ok(!fs.existsSync(path.join(w.a, ".mcp.json")));
  const saved = rpc(
    w,
    "rl_session_save",
    { agent: "agy", sessionId: sid },
    config.mcpServers[name],
  );
  assert.equal(saved.agent, "agy");
  assert.equal(w.status().sessions.agy[0].id, sid);
  fs.copyFileSync(a, b);
  w.rl(["setup", "mcp", "agy"], { cwd: w.b });
  const copied = readJson(b);
  assert.equal(copied.mcpServers[name], undefined);
  const server = copied.mcpServers[`rl-${w.status(w.b).key}`];
  assert.equal(server.args.at(-1), w.b);
  assert.deepEqual(copied.mcpServers.other, { command: "unchanged" });
  assert.equal(read(a), before);
  const snapshot = JSON.parse(
    w.rl(["review", "feature/a", "--base", "develop", "--json"], {
      cwd: w.repo,
    }).stdout,
  ).snapshot;
  assert.equal(
    snapshot.complete,
    true,
    "Generated Antigravity MCP files must not prevent source review",
  );
});

test("Antigravity receives native workflow gates and can own configurable writer/reviewer/DRY workflows", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  w.rl(["workflow", "init", "--provider", "agy"], { cwd: w.a });
  const workflowFile = path.join(w.a, ".rl/agent-workflows.json");
  const workflows = readJson(workflowFile);
  for (const workflow of Object.values(workflows.workflows) as {
    triggers: { event: string; changes?: boolean }[];
  }[])
    workflow.triggers.push({ event: "before_finish", changes: true });
  write(workflowFile, JSON.stringify(workflows));
  write(path.join(w.a, "feature.ts"), "export const feature = 1;\n");
  hook(w, "SessionStart", sid);
  const gate = JSON.parse(
    hook(w, "PreToolUse", sid, {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: path.join(w.a, "feature.ts") },
      },
    }).stdout,
  );
  assert.equal(gate.decision, "deny");
  assert.match(gate.reason, /RL workflow requests/);
  const context = rpc(w, "rl_workflow_context", {
    agent: "agy",
    sessionId: sid,
  });
  assert.equal(context.agents.writer.provider, "agy");
  const started = rpc(w, "rl_workflow_start", {
    agent: "agy",
    sessionId: sid,
    base: "develop",
  });
  assert.equal(started.owner.agent, "agy");
  assert.equal(started.stages.length, 3);
  const stop = JSON.parse(hook(w, "Stop", sid, { fullyIdle: true }).stdout);
  assert.equal(stop.decision, "continue");
  const children = [randomUUID(), randomUUID(), randomUUID()];
  // Antigravity emits SessionStart before its parent can bind the returned UUID.
  hook(w, "SessionStart", children[0]);
  const roles = ["writer", "reviewer", "dry"];
  const claims = roles.map((step) =>
    rpc(w, "rl_workflow_claim", {
      agent: "agy",
      sessionId: sid,
      run: started.id,
      step,
    }),
  );
  for (let i = 0; i < claims.length; i++)
    rpc(w, "rl_workflow_bind", {
      agent: "agy",
      sessionId: sid,
      run: started.id,
      step: roles[i],
      claim: claims[i].claim,
      childId: children[i],
    });
  const peer = JSON.parse(hook(w, "PreInvocation", children[0]).stdout);
  assert.match(
    peer.injectSteps[0].ephemeralMessage,
    /bound native RL peer writer/,
  );
  assert.ok(peer.injectSteps[0].ephemeralMessage.includes(`sessionId=${sid}`));
  const peerEdit = JSON.parse(
    hook(w, "PreToolUse", children[0], {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: path.join(w.a, "feature.ts") },
      },
    }).stdout,
  );
  assert.equal(
    peerEdit.decision,
    "allow",
    "A bound writer must not recursively create another workflow",
  );
  assert.equal(
    JSON.parse(hook(w, "Stop", children[0], { fullyIdle: true }).stdout)
      .decision,
    "allow",
  );
  const status = w.status();
  assert.deepEqual(
    status.sessions.agy.map((session: { id: string }) => session.id),
    [sid],
  );
  assert.equal(
    status.activity.agy.find(
      (item: { sessionId: string }) => item.sessionId === children[0],
    ).childId,
    children[0],
  );
  assert.ok(
    !fs.existsSync(w.log),
    "Native workflow coordination must not launch provider processes",
  );
});

test("Antigravity feedback uses the exact saved conversation, validates native completion, and retains failed requests", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  stub(w);
  w.rl(["agent", "save", "agy", sid], { cwd: w.a });
  const body = "Reuse the helper. Literal $(touch unexpected) stays text.";
  const send = (extra: string[] = [], ok = true) =>
    JSON.parse(
      w.rl(
        [
          "feedback",
          "feature/a",
          "--message",
          body,
          "--agent",
          "agy",
          "--session",
          sid,
          "--send",
          "--json",
          ...extra,
        ],
        { cwd: w.repo, ok },
      ).stdout,
    );
  const delivered = send();
  assert.equal(delivered.status, "delivered");
  const capture = readJson(w.env.AGY_CAPTURE!);
  assert.equal(capture.cwd, w.a);
  assert.equal(capture.args[capture.args.indexOf("--conversation") + 1], sid);
  assert.equal(capture.args.includes("--continue"), false);
  assert.equal(capture.args.includes("--print"), false);
  assert.match(
    JSON.parse(capture.input).message.content,
    /Literal \$\(touch unexpected\)/,
  );
  w.env.AGY_FAILURE = "1";
  const failed = send([], false);
  assert.equal(failed.status, "failed");
  assert.equal(failed.text, body);
  delete w.env.AGY_FAILURE;
  w.env.AGY_WRONG_SESSION = randomUUID();
  assert.match(send([], false).error, /selected conversation/);
  delete w.env.AGY_WRONG_SESSION;
  const retry = JSON.parse(
    w.rl(
      [
        "feedback",
        "feature/a",
        "--retry",
        failed.id,
        "--resume",
        "--agent",
        "agy",
        "--session",
        sid,
        "--json",
      ],
      { cwd: w.repo },
    ).stdout,
  );
  assert.equal(retry.status, "opened");
  const resumed = readJson(w.env.AGY_CAPTURE!);
  assert.ok(resumed.args.includes("--prompt-interactive"));
  assert.ok(resumed.args.at(-1).includes(body));
  assert.ok(!fs.existsSync(path.join(w.a, "unexpected")));
});

test("Antigravity independent reviews use immutable evidence, plan mode and validated structured streaming output", (t) => {
  const w = new Workspace(t);
  stub(w);
  write(path.join(w.a, "feature.ts"), "export const feature = 1;\n");
  const command = [
    "review",
    "feature/a",
    "--base",
    "develop",
    "--summary",
    "--provider",
    "agy",
    "--json",
  ];
  const result = JSON.parse(w.rl(command, { cwd: w.repo }).stdout);
  assert.equal(result.analysis.provider, "agy");
  assert.equal(result.analysis.snapshot, result.snapshot.id);
  const invocation = readJson(w.env.AGY_CAPTURE!);
  assert.equal(invocation.args[invocation.args.indexOf("--mode") + 1], "plan");
  assert.equal(
    invocation.args.includes("--dangerously-skip-permissions"),
    false,
  );
  assert.equal(invocation.ephemeral, result.snapshot.id);
  assert.match(
    JSON.parse(invocation.input).message.content,
    /export const feature/,
  );
  const current = JSON.parse(
    w.rl(["review", "feature/a", "--json"], { cwd: w.repo }).stdout,
  );
  assert.equal(current.review.approval, undefined);
  assert.equal(current.review.checkpoints.length, 0);
  assert.equal(w.status().sessions.agy, undefined);
  w.env.AGY_FAILURE = "1";
  const failure = JSON.parse(w.rl(command, { cwd: w.repo }).stdout);
  assert.equal(failure.analysis, null);
  assert.match(failure.error, /Provider unavailable/);
});
