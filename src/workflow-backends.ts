import fs from "node:fs";
import path from "node:path";
import { execute, object } from "./common.js";
import { parseJsonObject } from "./json.js";
import type { AgentProfile } from "./automation-config.js";
import {
  RESULT_SCHEMA,
  validateResult,
  type ReviewResult,
} from "./review-policy.js";

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
export async function runReviewer(
  profile: AgentProfile,
  prompt: string,
  cwd: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<{ result: ReviewResult; usage: Usage }> {
  const model = profile.model ? ["--model", profile.model] : [];
  const schema = JSON.stringify(RESULT_SCHEMA);
  let argv: string[];
  if (profile.provider === "codex") {
    const file = path.join(directory, "schema.json");
    fs.writeFileSync(file, schema, { mode: 0o600 });
    argv = [
      "codex",
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--json",
      "--output-schema",
      file,
      ...model,
      ...(profile.reasoning
        ? ["-c", `model_reasoning_effort=${JSON.stringify(profile.reasoning)}`]
        : []),
      "--",
      "-",
    ];
  } else {
    argv = [
      "claude",
      "--print",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      schema,
      "--tools",
      "Read,Glob,Grep",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      ...model,
      ...(profile.reasoning ? ["--effort", profile.reasoning] : []),
    ];
  }
  const output = await execute(argv, cwd, {
    input: prompt,
    env,
    signal,
    processGroup: true,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(directory, "stdout.txt"), output.stdout, {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(directory, "stderr.txt"), output.stderr, {
    mode: 0o600,
  });
  if (output.code)
    throw new Error(
      `${profile.provider} exited ${output.code}: ${output.stderr.trim().slice(-1500) || output.stdout.trim().slice(-1500)}`,
    );
  let raw: unknown;
  const usage: Usage = { inputTokens: null, outputTokens: null, costUsd: null };
  if (profile.provider === "claude") {
    const envelope = parseJsonObject(output.stdout);
    if (envelope.is_error === true)
      throw new Error(
        `Claude failed: ${String(envelope.result).slice(0, 1000)}`,
      );
    raw = envelope.structured_output;
    if (object(envelope.usage)) {
      usage.inputTokens = amount(envelope.usage.input_tokens);
      usage.outputTokens = amount(envelope.usage.output_tokens);
    }
    usage.costUsd = amount(envelope.total_cost_usd);
  } else {
    for (const line of output.stdout.split(/\r?\n/).filter(Boolean)) {
      const event = parseJsonObject(line);
      if (event.type === "turn.failed" || event.type === "error")
        throw new Error(
          `Codex failed: ${JSON.stringify(event).slice(0, 1000)}`,
        );
      if (
        event.type === "item.completed" &&
        object(event.item) &&
        event.item.type === "agent_message" &&
        typeof event.item.text === "string"
      )
        raw = parseJsonObject(event.item.text);
      if (event.type === "turn.completed" && object(event.usage)) {
        usage.inputTokens = amount(event.usage.input_tokens);
        usage.outputTokens = amount(event.usage.output_tokens);
      }
    }
  }
  validateResult(raw);
  return { result: raw, usage };
}
