import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, ROOT } from "./helpers.js";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

test("MCP saves a session visible in CLI status and resume and rejects invalid ownership", (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  const call = (arguments_: Record<string, unknown>, cwd = w.a) => {
    const result = w.rl(["mcp"], {
      cwd,
      input:
        [
          initialize,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "rl_session_save",
              arguments: arguments_,
            },
          },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "rl_status" },
          },
          { jsonrpc: "2.0", id: 4, method: "tools/list" },
        ]
          .map((request) => JSON.stringify(request))
          .join("\n") + "\n",
    });
    return result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const replies = call({ agent: "codex", sessionId: id });
  assert.deepEqual(JSON.parse(replies[1].result.content[0].text), {
    agent: "codex",
    sessionId: id,
    instance: "feature/a",
  });
  assert.equal(
    JSON.parse(replies[2].result.content[0].text).sessions.codex[0].id,
    id,
  );
  const tool = replies[3].result.tools.find(
    (tool: { name: string }) => tool.name === "rl_session_save",
  );
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  w.rl(["resume", "codex"], { cwd: w.a });
  assert.deepEqual(w.calls()[0].argv.slice(1), ["resume", id]);
  assert.equal(call({ sessionId: id }, w.b)[1].result.isError, true);
  for (const input of [
    {},
    { sessionId: "--last" },
    { sessionId: null },
    { agent: "unknown", sessionId: id },
    { agent: "claude" },
    { sessionId: id, cwd: w.b },
  ])
    assert.equal(call(input)[1].result.isError, true);
  w.env.CODEX_THREAD_ID = id;
  assert.equal(call({})[1].result.isError, undefined);
  assert.equal(w.status().sessions.codex.length, 1);
  assert.deepEqual(w.status(w.b).sessions.codex, []);
});
test("MCP negotiates, lists tools and shares locked append/read with CLI", (t) => {
  const w = new Workspace(t);
  const requests = [
    initialize,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "rl_progress_append",
        arguments: { text: "MCP milestone" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "rl_progress" },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "rl_status" },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "rl_progress_append",
        arguments: { text: "bad", path: "elsewhere" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "rl_delete" },
    },
  ];
  const result = w.command(
    [
      process.execPath,
      "--input-type=module",
      "-e",
      `import { main } from ${JSON.stringify(path.join(ROOT, "dist/mcp.js"))}; process.exitCode = await main(process.argv.slice(1));`,
      "--",
      "--repo",
      w.repo,
      "--state-dir",
      w.state,
    ],
    {
      cwd: w.a,
      input:
        requests.map((request) => JSON.stringify(request)).join("\n") +
        "\n{bad\n",
    },
  );
  const replies = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(replies.length, 8);
  assert.equal(replies[0].result.protocolVersion, "2025-11-25");
  assert.equal(replies[1].result.tools.length, 7);
  assert.match(replies[3].result.content[0].text, /MCP milestone/);
  assert.equal(
    JSON.parse(replies[4].result.content[0].text).branch,
    "feature/a",
  );
  assert.equal(replies[5].result.isError, true);
  assert.equal(replies[6].error.code, -32602);
  assert.equal(replies[7].error.code, -32700);
  assert.match(
    w.rl(["progress", "show"], { cwd: w.a }).stdout,
    /MCP milestone/,
  );
});

test("MCP rejects malformed envelopes and use before initialization without mutation", (t) => {
  const w = new Workspace(t);
  const result = w.command(
    [
      process.execPath,
      "--input-type=module",
      "-e",
      `import { main } from ${JSON.stringify(path.join(ROOT, "dist/mcp.js"))}; process.exitCode = await main(process.argv.slice(1));`,
      "--",
      "--repo",
      w.repo,
      "--state-dir",
      w.state,
    ],
    {
      cwd: w.a,
      input:
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "rl_progress_append",
              arguments: { text: "must not write" },
            },
          },
          { jsonrpc: "2.0", id: {}, method: "ping" },
          { jsonrpc: "2.0", id: 2, method: "ping", params: [] },
        ]
          .map((request) => JSON.stringify(request))
          .join("\n") + "\n",
    },
  );
  const replies = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    replies.map((reply) => reply.error.code),
    [-32602, -32600, -32602],
  );
  assert.doesNotMatch(
    w.rl(["progress", "show"], { cwd: w.a }).stdout,
    /must not write/,
  );
});

test("MCP rejects oversized unterminated lines and recovers at the next newline", (t) => {
  const w = new Workspace(t);
  const argv = [
    process.execPath,
    "--input-type=module",
    "-e",
    `import { main } from ${JSON.stringify(path.join(ROOT, "dist/mcp.js"))}; process.exitCode = await main(process.argv.slice(1));`,
    "--",
    "--repo",
    w.repo,
    "--state-dir",
    w.state,
  ];
  const oversized = "x".repeat(1024 * 1024 + 1);
  const unterminated = w.command(argv, { cwd: w.a, input: oversized });
  assert.match(JSON.parse(unterminated.stdout).error.message, /too large/);
  const recovered = w.command(argv, {
    cwd: w.a,
    input:
      oversized +
      "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: "after", method: "ping" }) +
      "\n",
  });
  const replies = recovered.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].error.code, -32700);
  assert.deepEqual(replies[1], { jsonrpc: "2.0", id: "after", result: {} });
});
