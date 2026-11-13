import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agyResult, agyTurn } from "../agent-agy.js";
import { agentAdapter } from "../agent-registry.js";
import type { Agent, AgentAdapter } from "../agents.js";
import { execute, object, readJson, writeJson } from "../common.js";
import { parseJsonObject } from "../json.js";

export interface StructuredAnalysisOptions {
  cwd: string;
  provider: string;
  prompt: string;
  stdinFallbackInstruction: string;
  schema: Record<string, unknown>;
  model?: string;
  reasoning?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  processGroup?: boolean;
  abortGraceMs?: number;
  ephemeralRunId: string;
  ephemeralStep: string;
  stateDir?: string;
}

export interface StructuredAnalysisResponse {
  adapter: AgentAdapter;
  payload: Record<string, unknown>;
}

/**
 * Execute a read-only, tool-free headless analysis turn across Codex, Claude, or Antigravity
 * and return the parsed structured JSON payload.
 */
export async function runStructuredAgentTurn(
  options: StructuredAnalysisOptions,
): Promise<StructuredAnalysisResponse> {
  const adapter = agentAdapter(options.provider);
  const provider = adapter.name;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rl-structured-ai-"));

  try {
    const schemaFile = path.join(temporary, "schema.json");
    const outputFile = path.join(temporary, "output.json");
    writeJson(schemaFile, options.schema);

    let flags: string[];
    if (provider === "codex") {
      flags = [
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--output-schema",
        schemaFile,
        "--output-last-message",
        outputFile,
      ];
    } else if (provider === "agy") {
      flags = [
        "--mode",
        "plan",
        "--disable-slash-commands",
        "--json-schema",
        schemaFile,
      ];
    } else {
      flags = [
        "--tools",
        "",
        "--disallowedTools",
        "mcp__*",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(options.schema),
      ];
    }

    if (options.model) {
      flags.push("--model", options.model);
    }
    if (options.reasoning) {
      if (provider === "codex") {
        flags.push(
          "-c",
          `model_reasoning_effort=${JSON.stringify(options.reasoning)}`,
        );
      } else if (provider === "agy") {
        flags.push("--effort", options.reasoning);
      }
    }

    const turn =
      provider === "agy" ? agyTurn(options.prompt, flags) : undefined;
    const command =
      turn?.command ??
      adapter.runArgs(
        provider === "codex" ? "-" : options.stdinFallbackInstruction,
        flags,
      );

    const result = await execute(command, options.cwd, {
      input: turn?.input ?? options.prompt,
      timeoutMs: options.timeoutMs ?? 120000,
      maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
      signal: options.signal,
      processGroup: options.processGroup,
      abortGraceMs: options.abortGraceMs,
      env: {
        ...process.env,
        RL_WORKFLOW_RUN: options.ephemeralRunId,
        RL_WORKFLOW_STEP: options.ephemeralStep,
        ...(options.stateDir ? { RL_STATE_DIR: options.stateDir } : {}),
      },
    });

    if (result.code !== 0) {
      const detail =
        result.stderr.trim().slice(0, 3000) ||
        result.stdout.trim().slice(0, 3000);
      throw new Error(
        detail
          ? `${provider} analysis failed (${result.code}): ${detail}`
          : `${provider} analysis failed (${result.code})`,
      );
    }

    let response: Record<string, unknown>;
    if (provider === "agy") {
      response = agyResult(result.stdout);
    } else if (provider === "codex" && fs.existsSync(outputFile)) {
      response = readJson(outputFile);
    } else {
      response = parseJsonObject(result.stdout);
    }

    if (response.is_error === true) {
      throw new Error("Provider reported an analysis failure");
    }
    if (provider === "agy" && response.status !== "SUCCESS") {
      throw new Error(
        `Antigravity analysis did not succeed (${String(response.status ?? "unknown")})`,
      );
    }

    const payload =
      (provider === "claude" || provider === "agy") &&
      object(response.structured_output)
        ? response.structured_output
        : response;

    return { adapter, payload };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Execute one noninteractive correction turn in an existing saved coding session.
 */
export async function runHeadlessFeedbackTurn(options: {
  agent: Agent;
  sessionId: string;
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const { agent, sessionId, prompt, cwd, env } = options;

  const turn =
    agent === "agy"
      ? agyTurn(prompt, [
          "--conversation",
          sessionId,
          "--disable-slash-commands",
        ])
      : undefined;

  let command: string[];
  if (turn) {
    command = turn.command;
  } else if (agent === "codex") {
    command = ["codex", "exec", "resume", sessionId, "--", "-"];
  } else {
    command = [
      "claude",
      "--print",
      "--resume",
      sessionId,
      "--",
      "Apply the RL review feedback provided on stdin.",
    ];
  }

  const result = await execute(command, cwd, {
    input: turn?.input ?? prompt,
    timeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 4 * 1024 * 1024,
    env,
  });

  if (result.code !== 0) {
    throw new Error(
      `Feedback turn failed (${result.code}): ${result.stderr.trim().slice(0, 3000)}`,
    );
  }

  if (agent === "agy") {
    const response = agyResult(result.stdout);
    if (response.conversation_id !== sessionId) {
      throw new Error(
        "Antigravity did not confirm a successful turn in the selected conversation",
      );
    }
  }

  return result.stdout;
}
