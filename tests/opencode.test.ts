import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Workspace, readJson, write, sessionPicker } from "./helpers.js";

function directHook(
  w: Workspace,
  event: string,
  sid: string,
  extra: Record<string, unknown> = {},
  cwd = w.a,
  owner = cwd,
  ok = true,
) {
  const instance = w.status(owner);
  return w.command(
    [
      path.join(import.meta.dirname, "../bin/rl"),
      "__hook",
      "--repo",
      w.repo,
      "--state-dir",
      w.state,
      "hook",
      instance.key,
      "opencode",
      event,
    ],
    {
      cwd,
      ok,
      input: JSON.stringify({
        cwd,
        sessionId: sid,
        ...extra,
      }),
    },
  );
}

function runPluginScenario(w: Workspace, script: string, cwd = w.a) {
  return JSON.parse(
    w.command([process.execPath, "--input-type=module", "-e", script], { cwd })
      .stdout,
  );
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
              clientInfo: { name: "opencode-test", version: "1" },
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
  w.env.OPENCODE_CAPTURE = path.join(w.root, "opencode-invocation.json");
  w.stub(
    "opencode",
    `
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('1.2.0');process.exit(0);}
if(args.includes('--help')){console.log('Commands:\\n  opencode run [message..]\\nOptions:\\n  --session  --prompt  --model  --variant');process.exit(0);}
const input=fs.readFileSync(0,'utf8');
fs.writeFileSync(process.env.OPENCODE_CAPTURE,JSON.stringify({args,input,cwd:process.cwd(),ephemeral:process.env.RL_WORKFLOW_RUN}));
if(args[0]!=='run'||!args.includes('--format'))process.exit(Number(process.env.OPENCODE_EXIT||0));
const sid=args.includes('--session')?args[args.indexOf('--session')+1]:'ses_analysisTurn1234';
const outSid=process.env.OPENCODE_WRONG_SESSION||sid;
if(process.env.OPENCODE_FAILURE){
  console.log(JSON.stringify({type:'error',sessionID:outSid,error:{name:'ProviderError',data:{message:'Provider unavailable'}}}));
  process.exit(0);
}
let text='Applied feedback';
if(args.includes('--agent')&&args[args.indexOf('--agent')+1]==='plan'){
  const data=JSON.parse(input.split('\\n').at(-1));
  const payload={overview:'Summary grounded in supplied source',architecture:[],behavior:['Changed feature source'],testing:['No tests executed'],concerns:[],groups:[{title:'Feature',explanation:'Source changes',members:data.evidence.files.map(file=>file.id),concerns:[]}],review:{summary:'Independent review',complete:true,findings:[],limitations:[],checkRequests:[],routingLeads:[]}};
  text='\`\`\`json\\n'+JSON.stringify(payload)+'\\n\`\`\`';
}
console.log(JSON.stringify({type:'step_start',sessionID:outSid,timestamp:Date.now()}));
console.log(JSON.stringify({type:'text',sessionID:outSid,part:{type:'text',text}}));
console.log(JSON.stringify({type:'step_finish',sessionID:outSid,part:{type:'step-finish',reason:'stop'}}));
`,
  );
}

test("OpenCode managed plugin exports only functions, tracks ses_ lifecycle, injects context, blocks pending workflow edits, and isolates subagents", (t) => {
  const w = new Workspace(t);
  stub(w);
  const pluginFile = path.join(w.a, ".opencode/plugins/rl.js");
  assert.ok(fs.existsSync(pluginFile));
  assert.equal(w.git(w.a, "status", "--porcelain"), "");

  w.rl(["notes", "set", "context", "-"], {
    cwd: w.a,
    input: "# Context\n\nOpenCode workspace context.\n",
  });

  const sid = "ses_MainSessionAbCd1234";
  const childSid = "ses_ChildWorkerXyZ9876";
  const pluginUrl = pathToFileURL(pluginFile).href;

  const observed = runPluginScenario(
    w,
    `
import * as mod from ${JSON.stringify(pluginUrl)};
const entries = Object.entries(mod);
const nonFunctions = entries.filter(([, v]) => typeof v !== "function").map(([k]) => k);
const uniqueCount = new Set(Object.values(mod)).size;
const hooks = await mod.default({ directory: ${JSON.stringify(w.a)} });

const systemFirst = [];
await hooks["chat.message"]({ sessionID: ${JSON.stringify(sid)} }, {});
await hooks["experimental.chat.system.transform"]({ sessionID: ${JSON.stringify(sid)} }, { system: systemFirst });

await hooks.event({
  event: {
    type: "session.created",
    properties: { info: { id: ${JSON.stringify(childSid)}, parentID: ${JSON.stringify(sid)} } },
  },
});

const childSystem = [];
await hooks["chat.message"]({ sessionID: ${JSON.stringify(childSid)} }, {});
await hooks["experimental.chat.system.transform"]({ sessionID: ${JSON.stringify(childSid)} }, { system: childSystem });
await hooks["tool.execute.before"](
  { sessionID: ${JSON.stringify(childSid)}, tool: "edit" },
  { args: { filePath: "child-edit.ts" } },
);

let blockedMessage = null;
try {
  await hooks["tool.execute.before"](
    { sessionID: ${JSON.stringify(sid)}, tool: "edit" },
    { args: { filePath: "parent-edit.ts" } },
  );
} catch (err) {
  blockedMessage = err.message;
}

await hooks.event({ event: { type: "session.idle", properties: { sessionID: ${JSON.stringify(sid)} } } });
await hooks.event({ event: { type: "session.deleted", properties: { info: { id: ${JSON.stringify(childSid)} } } } });

console.log(JSON.stringify({ nonFunctions, uniqueCount, systemFirst, childSystem, blockedMessage }));
`,
  );

  assert.deepEqual(observed.nonFunctions, []);
  assert.equal(observed.uniqueCount, 1);
  assert.equal(observed.systemFirst.length, 1);
  assert.match(observed.systemFirst[0], /OpenCode workspace context/);
  assert.match(
    observed.systemFirst[0],
    new RegExp(`agent=opencode, sessionId=${sid}`),
  );
  assert.equal(observed.childSystem.length, 1);
  assert.match(observed.childSystem[0], /You are a native child/);
  assert.match(observed.blockedMessage, /RL workflow requests/);

  const status = w.status();
  assert.deepEqual(
    status.sessions.opencode.map((entry: { id: string }) => entry.id),
    [sid],
  );
  const parentActivity = status.activity.opencode.find(
    (entry: { sessionId: string; childId?: string }) =>
      entry.sessionId === sid && !entry.childId,
  );
  assert.equal(parentActivity.state, "idle");

  const doctor = JSON.parse(
    w.rl(["doctor", "opencode", "--json"], { cwd: w.a }).stdout,
  ).agents[0];
  assert.equal(doctor.installed, true);
  assert.equal(doctor.launchVerified, true);
  assert.equal(doctor.version, "1.2.0");
  assert.equal(doctor.delivery, "observed");
});

test("OpenCode refuses unmanaged plugin files, rejects cross-worktree hook calls, and stays optional in default doctor", (t) => {
  const w = new Workspace(t);
  const sid = "ses_TamperCheck1234";

  directHook(w, "SessionStart", sid, {}, w.a, w.b, false);
  assert.equal(w.status().sessions.opencode, undefined);

  const pluginFile = path.join(w.a, ".opencode/plugins/rl.js");
  write(pluginFile, "export default async () => ({});\n");
  const badAdopt = w.rl(["setup", "adopt"], { cwd: w.a, ok: false });
  assert.match(badAdopt.stderr, /OpenCode plugin .* is not managed by RL/);
  const brokenDoctor = JSON.parse(
    w.rl(["doctor", "opencode", "--json"], { cwd: w.a, ok: false }).stdout,
  ).agents[0];
  assert.equal(brokenDoctor.installed, false);
  assert.match(brokenDoctor.configError, /not managed by RL/);

  const w2 = new Workspace(t);
  const git = w2.command(["which", "git"]).stdout.trim();
  fs.unlinkSync(path.join(w2.bin, "agy"));
  fs.unlinkSync(path.join(w2.bin, "opencode"));
  fs.symlinkSync(git, path.join(w2.bin, "git"));
  fs.symlinkSync(process.execPath, path.join(w2.bin, "node"));
  w2.env.PATH = w2.bin;
  const defaultDoctor = JSON.parse(
    w2.command(
      [
        process.execPath,
        path.join(import.meta.dirname, "../dist/cli.js"),
        "state",
        "--repo",
        w2.repo,
        "--state-dir",
        w2.state,
        "doctor",
        "--json",
      ],
      { cwd: w2.a },
    ).stdout,
  );
  assert.deepEqual(
    defaultDoctor.agents.map((entry: { agent: string }) => entry.agent),
    ["codex", "claude"],
  );
});

test("OpenCode starts, runs, switches, saves, pauses, continues and resumes ses_ and UUID sessions", (t) => {
  const w = new Workspace(t);
  stub(w);
  const sid = "ses_494719016ffe85dkDMj0FPRbHK";
  const uuidSid = randomUUID();

  w.rl(
    ["agent", "start", "opencode", "--", "--model", "anthropic/claude-sonnet"],
    { cwd: w.a },
  );
  assert.deepEqual(readJson(w.env.OPENCODE_CAPTURE!).args, [
    "--model",
    "anthropic/claude-sonnet",
  ]);

  w.rl(
    [
      "agent",
      "run",
      "opencode",
      "--prompt",
      "Summarize changes",
      "--",
      "--agent",
      "plan",
    ],
    { cwd: w.a },
  );
  assert.deepEqual(readJson(w.env.OPENCODE_CAPTURE!).args, [
    "run",
    "--agent",
    "plan",
    "--",
    "Summarize changes",
  ]);

  w.rl(["agent", "save", "opencode", uuidSid.toUpperCase()], { cwd: w.a });
  w.rl(["agent", "save", "opencode", sid], { cwd: w.a });
  w.rl(["agent", "save", "opencode"], { cwd: w.a, ok: false });
  w.rl(["agent", "save", "opencode", "ses_x"], { cwd: w.a, ok: false });
  w.rl(["agent", "save", "claude", sid], { cwd: w.a, ok: false });

  sessionPicker(w);
  w.env.RESUME_PICKER_AGENT = "opencode";
  w.env.RESUME_PICKER_ID = sid;
  w.rl(["resume"], { cwd: w.a });
  assert.deepEqual(readJson(w.env.OPENCODE_CAPTURE!).args, ["--session", sid]);

  w.rl(["resume", "opencode", "--latest"], { cwd: w.a });
  assert.deepEqual(readJson(w.env.OPENCODE_CAPTURE!).args, ["--session", sid]);

  w.rl(["switch", "feature/a", "--agent", "opencode"], { cwd: w.repo });
  assert.equal(readJson(w.env.OPENCODE_CAPTURE!).cwd, w.a);

  w.rl(
    [
      "pause",
      "--agent",
      "opencode",
      "--session",
      sid,
      "--summary",
      "Implemented OpenCode support",
      "--changes",
      "Added src/agent-opencode.ts",
      "--validation",
      "Not run",
      "--next",
      "Add review tests",
    ],
    { cwd: w.a },
  );
  w.rl(["continue"], { cwd: w.a });
  const continued = readJson(w.env.OPENCODE_CAPTURE!);
  assert.equal(continued.args[0], "--session");
  assert.equal(continued.args[1], sid);
  assert.equal(continued.args[2], "--prompt");
  assert.match(continued.args[3], /Implemented OpenCode support/);
});

test("rl setup mcp opencode configures opencode.json, preserves unrelated entries, and serves ses_ tools", (t) => {
  const w = new Workspace(t);
  const configFile = path.join(w.a, "opencode.json");
  write(
    configFile,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude-sonnet-4-5",
        mcp: {
          existing: {
            type: "remote",
            url: "https://example.invalid/mcp",
            enabled: true,
          },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const first = JSON.parse(
    w.rl(["setup", "mcp", "opencode", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(first.files[0].action, "updated");
  const parsed = readJson(configFile);
  assert.equal(parsed.model, "anthropic/claude-sonnet-4-5");
  assert.equal(parsed.mcp.existing.url, "https://example.invalid/mcp");
  assert.equal(parsed.mcp.rl.type, "local");
  assert.equal(parsed.mcp.rl.enabled, true);
  assert.equal(parsed.mcp.rl.environment.RL_MCP_MANAGED, "1");
  assert.equal(parsed.mcp.rl.command[0], process.execPath);

  const second = JSON.parse(
    w.rl(["setup", "mcp", "opencode", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(second.files[0].action, "unchanged");

  const sid = "ses_mcpSavedSession99";
  const saved = rpc(
    w,
    "rl_session_save",
    { agent: "opencode", sessionId: sid },
    { command: parsed.mcp.rl.command[0], args: parsed.mcp.rl.command.slice(1) },
  );
  assert.equal(saved.agent, "opencode");
  assert.equal(saved.sessionId, sid);
  assert.equal(w.status().sessions.opencode[0].id, sid);

  write(
    configFile,
    JSON.stringify({
      mcp: { rl: { type: "local", command: ["custom-mcp"] } },
    }),
  );
  const conflict = w.rl(["setup", "mcp", "opencode"], {
    cwd: w.a,
    ok: false,
  });
  assert.match(conflict.stderr, /not managed by RL/);
});

test("OpenCode coordinates native workflows with ses_ IDs and excludes bound subagent sessions from resume", (t) => {
  const w = new Workspace(t);
  stub(w);
  w.rl(["workflow", "init", "--provider", "opencode"], { cwd: w.a });

  const parent = "ses_parentCoord1234";
  const writer = "ses_peerWriter1234";
  const reviewer = "ses_peerReview1234";
  const dry = "ses_peerDrySearch12";

  const call = (action: string, input: Record<string, unknown> = {}) => {
    const usesStdin = !["context", "start", "claim", "inbox"].includes(action);
    const argv = [
      "workflow",
      action === "start" ? "run" : action,
      ...(action === "start" ? ["writer-reviewer-dry"] : []),
      ...(action === "claim" ? [String(input.run)] : []),
      ...(usesStdin ? ["--file", "-"] : []),
      "--json",
    ];
    if (!usesStdin) {
      if (input.base) argv.push("--base", String(input.base));
      if (input.step) argv.push("--step", String(input.step));
      argv.push("--agent", "opencode", "--session", parent);
    }
    return JSON.parse(
      w.rl(argv, {
        cwd: w.a,
        input: usesStdin
          ? JSON.stringify({ agent: "opencode", sessionId: parent, ...input })
          : undefined,
      }).stdout,
    );
  };

  const context = call("context");
  assert.equal(context.agents.writer.provider, "opencode");

  directHook(w, "SessionStart", writer);
  assert.deepEqual(
    w.status().sessions.opencode.map((s: { id: string }) => s.id),
    [writer],
  );

  const started = call("start", { base: "HEAD" });
  assert.equal(started.owner.agent, "opencode");
  assert.equal(started.owner.sessionId, parent);

  const claims: Record<string, string> = {};
  for (const [step, peer] of [
    ["writer", writer],
    ["reviewer", reviewer],
    ["dry", dry],
  ] as const) {
    claims[step] = call("claim", { run: started.id, step }).claim;
    call("bind", {
      run: started.id,
      step,
      claim: claims[step],
      childId: peer,
    });
  }

  const peerHook = JSON.parse(directHook(w, "SessionStart", writer).stdout);
  assert.match(peerHook.additionalContext, /bound native RL peer writer/);
  assert.match(
    peerHook.additionalContext,
    new RegExp(`agent=opencode, sessionId=${parent}`),
  );

  assert.deepEqual(
    w.status().sessions.opencode.map((s: { id: string }) => s.id),
    [parent],
  );
  w.rl(["agent", "save", "opencode", writer], { cwd: w.a, ok: false });
  w.rl(["resume", "opencode"], { cwd: w.a });
  assert.deepEqual(readJson(w.env.OPENCODE_CAPTURE!).args, [
    "--session",
    parent,
  ]);
});

test("OpenCode headless reviews and feedback delivery validate JSON stream completion and session identity", (t) => {
  const w = new Workspace(t);
  stub(w);
  const sid = "ses_feedbackTarget123";
  w.rl(["agent", "save", "opencode", sid], { cwd: w.a });

  write(path.join(w.a, "feature.ts"), "export const feature = 42;\n");
  const reviewCmd = [
    "review",
    "feature/a",
    "--base",
    "develop",
    "--summary",
    "--provider",
    "opencode",
    "--json",
  ];
  const summary = JSON.parse(w.rl(reviewCmd, { cwd: w.repo }).stdout);
  assert.equal(summary.analysis.provider, "opencode");
  const reviewCapture = readJson(w.env.OPENCODE_CAPTURE!);
  assert.equal(reviewCapture.args[0], "run");
  assert.equal(
    reviewCapture.args[reviewCapture.args.indexOf("--agent") + 1],
    "plan",
  );
  assert.equal(
    reviewCapture.args[reviewCapture.args.indexOf("--format") + 1],
    "json",
  );
  assert.match(reviewCapture.input, /export const feature = 42/);

  const sendFeedback = (ok = true) =>
    JSON.parse(
      w.rl(
        [
          "feedback",
          "feature/a",
          "--message",
          "Extract constant and keep $(touch nope) literal.",
          "--agent",
          "opencode",
          "--session",
          sid,
          "--send",
          "--json",
        ],
        { cwd: w.repo, ok },
      ).stdout,
    );

  const delivered = sendFeedback();
  assert.equal(delivered.status, "delivered");
  const fbCapture = readJson(w.env.OPENCODE_CAPTURE!);
  assert.equal(fbCapture.args[fbCapture.args.indexOf("--session") + 1], sid);
  assert.match(fbCapture.input, /keep \$\(touch nope\) literal/);

  w.env.OPENCODE_FAILURE = "1";
  const failed = sendFeedback(false);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Provider unavailable/);
  delete w.env.OPENCODE_FAILURE;

  w.env.OPENCODE_WRONG_SESSION = "ses_wrongSession9999";
  const mismatch = sendFeedback(false);
  assert.match(mismatch.error, /selected session/);
  delete w.env.OPENCODE_WRONG_SESSION;

  const reopened = JSON.parse(
    w.rl(
      [
        "feedback",
        "feature/a",
        "--retry",
        failed.id,
        "--resume",
        "--agent",
        "opencode",
        "--session",
        sid,
        "--json",
      ],
      { cwd: w.repo },
    ).stdout,
  );
  assert.equal(reopened.status, "opened");
  const resumed = readJson(w.env.OPENCODE_CAPTURE!);
  assert.equal(resumed.args[0], "--session");
  assert.equal(resumed.args[1], sid);
  assert.equal(resumed.args[2], "--prompt");
  assert.ok(!fs.existsSync(path.join(w.a, "nope")));
});

test("non-interactive PreToolUse hooks survive Node 18 PATH environments via nvm fallback and emit zero ES2023 array methods in dist", (t) => {
  const distDir = path.join(import.meta.dirname, "../dist");
  const scanJs = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory()
        ? scanJs(full)
        : entry.name.endsWith(".js")
          ? [full]
          : [];
    });
  for (const file of scanJs(distDir)) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /\.(toSorted|toReversed|toSpliced)\(/,
      `ES2023 array method leaked into ${path.relative(distDir, file)}`,
    );
  }

  const w = new Workspace(t);
  const agySession = randomUUID();
  w.rl(["workflow", "init", "--provider", "agy"], { cwd: w.a });
  w.rl(
    [
      "workflow",
      "run",
      "writer-reviewer-dry",
      "--base",
      "HEAD",
      "--agent",
      "agy",
      "--session",
      agySession,
      "--json",
    ],
    { cwd: w.a },
  );

  const groups = readJson(path.join(w.a, ".agents/hooks.json"))[
    "rl-session-hooks"
  ].PreToolUse;
  const hookCmd = groups.at(-1).command ?? groups.at(-1).hooks[0].command;

  const nonInteractiveBin = path.join(w.root, "noninteractive-bin");
  fs.mkdirSync(nonInteractiveBin, { recursive: true });
  fs.symlinkSync(
    path.join(import.meta.dirname, "../bin/rl"),
    path.join(nonInteractiveBin, "rl"),
  );
  const fakeNode18 = path.join(nonInteractiveBin, "node");
  write(
    fakeNode18,
    '#!/bin/sh\nif [ "$1" = "-v" ]; then echo "v18.19.1"; exit 0; fi\necho "unexpected Node 18 execution" >&2\nexit 1\n',
  );
  fs.chmodSync(fakeNode18, 0o755);

  const isolatedHome = path.join(w.root, "isolated-home");
  const nvmBin = path.join(isolatedHome, ".nvm/versions/node/v22.99.0/bin");
  const nvmMarker = path.join(w.root, "nvm-node-used.txt");
  fs.mkdirSync(nvmBin, { recursive: true });
  const nvmNode = path.join(nvmBin, "node");
  write(
    nvmNode,
    `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "v22.99.0"; exit 0; fi\necho "used" > "${nvmMarker}"\nexec "${process.execPath}" "$@"\n`,
  );
  fs.chmodSync(nvmNode, 0o755);

  const prevPath = w.env.PATH;
  const prevHome = w.env.HOME;
  w.env.HOME = isolatedHome;
  w.env.PATH = `${nonInteractiveBin}:/usr/bin:/bin`;
  try {
    const out = w.command(["/bin/sh", "-c", hookCmd], {
      cwd: w.a,
      input: JSON.stringify({
        conversationId: agySession,
        workspacePaths: [w.a],
        tool_name: "read_file",
      }),
    });
    assert.deepEqual(JSON.parse(out.stdout), { decision: "allow" });
    assert.equal(fs.readFileSync(nvmMarker, "utf8").trim(), "used");
  } finally {
    w.env.HOME = prevHome;
    w.env.PATH = prevPath;
  }
});
