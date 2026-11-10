import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { Workspace, read, readJson, write } from "./helpers.js";

const files = (w: Workspace, workspace = w.a) => ({
  codex: path.join(workspace, ".codex/config.toml"),
  claude: path.join(workspace, ".mcp.json"),
});
const setup = (w: Workspace, args: string[] = [], cwd = w.a) =>
  JSON.parse(w.rl(["setup", "mcp", ...args, "--json"], { cwd }).stdout);

test("one project setup configures both clients, binds the workspace and state, and is idempotent", (t) => {
  const w = new Workspace(t),
    target = files(w);
  const installed = setup(w);
  assert.deepEqual(
    installed.files.map((file: { action: string }) => file.action),
    ["created", "created"],
  );
  const codex = parseToml(read(target.codex)) as any;
  const claude = readJson(target.claude).mcpServers.rl;
  for (const entry of [codex.mcp_servers.rl, claude]) {
    assert.equal(entry.command, process.execPath);
    assert.equal(entry.env.RL_MCP_MANAGED, "1");
    assert.ok(entry.args.includes(w.a));
    assert.equal(entry.args[entry.args.indexOf("--state-dir") + 1], w.state);
    assert.equal(entry.args[entry.args.indexOf("--repo") + 1], w.repo);
  }
  assert.equal(codex.mcp_servers.rl.cwd, w.a);
  assert.equal(claude.type, "stdio");
  const before = [read(target.codex), read(target.claude)];
  assert.ok(
    setup(w).files.every(
      (file: { action: string }) => file.action === "unchanged",
    ),
  );
  assert.deepEqual([read(target.codex), read(target.claude)], before);
  assert.ok(!fs.existsSync(files(w, w.b).codex));
  assert.ok(!fs.existsSync(files(w, w.b).claude));
});

test("MCP setup preserves unrelated JSON servers and exact TOML comments and settings", (t) => {
  const w = new Workspace(t),
    target = files(w);
  const original =
    '# personal settings\nmodel = "configured-model" # keep this comment\nlarge = 9223372036854775807\ninstructions = """\nKeep this exact multiline text.\n"""\n\n[mcp_servers.other]\ncommand = "other-server"\nargs = ["--example"]\n';
  write(target.codex, original);
  const json = {
    extra: { keep: true },
    mcpServers: { other: { type: "http", url: "https://example.invalid/mcp" } },
  };
  write(target.claude, JSON.stringify(json));
  setup(w);
  assert.ok(read(target.codex).startsWith(original));
  assert.deepEqual(
    readJson(target.claude).mcpServers.other,
    json.mcpServers.other,
  );
  assert.deepEqual(readJson(target.claude).extra, json.extra);
  assert.equal(
    (parseToml(read(target.codex), { integersAsBigInt: true }) as any).large,
    9223372036854775807n,
  );
});

test("dry run and client selection configure only the current workspace", (t) => {
  const w = new Workspace(t),
    target = files(w);
  const preview = setup(w, ["claude", "--dry-run"]);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(
    preview.files.map((file: { client: string }) => file.client),
    ["claude"],
  );
  assert.ok(!fs.existsSync(target.codex) && !fs.existsSync(target.claude));
  setup(w, ["claude"]);
  assert.ok(!fs.existsSync(target.codex) && fs.existsSync(target.claude));
  w.rl(["setup", "mcp", "claude", "--workspace", w.b], { cwd: w.a, ok: false });
  assert.ok(!fs.existsSync(files(w, w.b).claude));
  const bad = w.rl(["setup", "mcp", "unsupported"], { cwd: w.a, ok: false });
  assert.match(bad.stderr, /Expected codex, claude or agy/);
  assert.match(bad.stderr, /Usage: rl setup mcp/);
});

test("preflight preserves both files when JSON is malformed or an existing rl server is unmanaged", (t) => {
  const w = new Workspace(t),
    target = files(w);
  const original = '# existing project defaults\nmodel = "configured-model"\n';
  write(target.codex, original);
  for (const content of [
    '{"mcpServers":',
    JSON.stringify({
      mcpServers: { rl: { command: "someone-elses-server", args: [] } },
    }),
  ]) {
    write(target.claude, content);
    w.rl(["setup", "mcp"], { cwd: w.a, ok: false });
    assert.equal(read(target.codex), original);
    assert.equal(read(target.claude), content);
  }
  fs.unlinkSync(target.claude);
  const manual =
    '[mcp_servers."rl"]\ncommand = "rl"\nargs = ["agent", "mcp"]\n';
  write(target.codex, manual);
  w.rl(["setup", "mcp"], { cwd: w.a, ok: false });
  assert.equal(read(target.codex), manual);
  assert.ok(!fs.existsSync(target.claude));
});

test("TOML merge validation rejects sealed tables and corrupt managed blocks without modifying configuration", (t) => {
  const w = new Workspace(t),
    target = files(w);
  for (const content of [
    'mcp_servers = { other = { command = "other" } }\n',
    '# BEGIN RL MCP - managed by rl setup mcp\nmodel = "test"\n',
  ]) {
    write(target.codex, content);
    w.rl(["setup", "mcp"], { cwd: w.a, ok: false });
    assert.equal(read(target.codex), content);
    assert.ok(!fs.existsSync(target.claude));
  }
});

test("symlinked configuration files and directories cannot redirect setup outside the workspace", (t) => {
  const w = new Workspace(t),
    target = files(w);
  const outside = path.join(w.root, "outside.json");
  write(outside, "{}\n");
  fs.symlinkSync(outside, target.claude);
  w.rl(["setup", "mcp"], { cwd: w.a, ok: false });
  assert.equal(read(outside), "{}\n");
  assert.ok(!fs.existsSync(target.codex));
  fs.unlinkSync(target.claude);
  fs.renameSync(path.join(w.a, ".codex"), path.join(w.root, "codex-config"));
  fs.symlinkSync(path.join(w.root, "codex-config"), path.join(w.a, ".codex"));
  w.rl(["setup", "mcp", "codex"], { cwd: w.a, ok: false });
  assert.ok(!fs.existsSync(path.join(w.root, "codex-config/config.toml")));
});

test("copied RL-managed settings rebind to the current workspace while preserving custom server options", (t) => {
  const w = new Workspace(t),
    a = files(w),
    b = files(w, w.b);
  setup(w);
  const originalCodex = read(a.codex);
  const claude = readJson(a.claude);
  claude.mcpServers.rl.timeout = 60000;
  claude.mcpServers.rl.env.CUSTOM_OPTION = "keep";
  write(a.claude, JSON.stringify(claude));
  fs.copyFileSync(a.codex, b.codex);
  fs.copyFileSync(a.claude, b.claude);
  const result = setup(w, [], w.b);
  assert.ok(
    result.files.every((file: { action: string }) => file.action === "updated"),
  );
  const codex = parseToml(read(b.codex)) as any;
  const entry = readJson(b.claude).mcpServers.rl;
  assert.equal(codex.mcp_servers.rl.cwd, w.b);
  assert.equal(entry.args[entry.args.indexOf("--workspace") + 1], w.b);
  assert.equal(entry.timeout, 60000);
  assert.equal(entry.env.CUSTOM_OPTION, "keep");
  assert.equal(read(a.codex), originalCodex);
  assert.equal(readJson(a.claude).mcpServers.rl.args.at(-1), w.a);
});

test("unrelated settings inserted inside the managed TOML block are preserved through a clear conflict", (t) => {
  const w = new Workspace(t),
    target = files(w);
  setup(w);
  const modified = read(target.codex).replace(
    "# END RL MCP",
    '[mcp_servers.additional]\ncommand = "keep-this-server"\n# END RL MCP',
  );
  write(target.codex, modified);
  const claude = read(target.claude);
  const failed = w.rl(["setup", "mcp"], { cwd: w.a, ok: false });
  assert.match(failed.stderr, /contains unrelated settings/);
  assert.equal(read(target.codex), modified);
  assert.equal(read(target.claude), claude);
});

test("the generated MCP command initializes from an unrelated directory with no rl executable on PATH", (t) => {
  const w = new Workspace(t);
  setup(w);
  const entry = readJson(files(w).claude).mcpServers.rl;
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "mcp-setup-test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "rl_workflow_context", arguments: {} },
    },
  ];
  w.env.PATH = "/usr/bin:/bin";
  const replies = w
    .command([entry.command, ...entry.args], {
      cwd: w.root,
      input:
        messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
    })
    .stdout.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, "rl");
  assert.equal(replies[1].result.tools.length, 20);
  const context = JSON.parse(replies[2].result.content[0].text);
  assert.equal(context.defaultWorkflow, "writer-reviewer-dry");
  assert.ok(!fs.existsSync(w.log));
});
