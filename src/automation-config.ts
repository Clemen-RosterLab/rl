import fs from "node:fs";
import path from "node:path";
import { object, writeJson } from "./common.js";
import { readJsonObject } from "./json.js";
import { PRESET } from "./agent-presets.js";
import type { Agent } from "./agents.js";

export const CONFIG_FILES = {
  agents: ".rl/agents.json",
  policies: ".rl/policies.json",
  workflows: ".rl/agent-workflows.json",
} as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export interface AgentProfile {
  provider: Agent;
  description: string;
  instructions: string;
  model?: string;
  reasoning?: string;
}
export interface ReviewPolicy {
  instructions: string;
  weights: Record<Severity, number>;
  minimumScore: number;
  blockRequired: boolean;
}
export interface WorkflowStep {
  id: string;
  after: string[];
  agent?: string;
  command?: string[];
}
export interface AgentWorkflow {
  description: string;
  policy: string;
  concurrency: number;
  retries: number;
  timeoutSeconds: number;
  steps: WorkflowStep[];
}
export interface AutomationConfig {
  agents: Record<string, AgentProfile>;
  policies: Record<string, ReviewPolicy>;
  workflows: Record<string, AgentWorkflow>;
}
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
export function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !ID.test(value) ||
    value === "constructor" ||
    value.startsWith("followup-")
  )
    throw new Error(
      "Expected an identifier using lowercase letters, numbers, hyphens or underscores",
    );
}
export function fields(
  value: unknown,
  allowed: string[],
  required = allowed,
): asserts value is Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in value))
  )
    throw new Error(`Expected fields: ${allowed.join(", ")}`);
}
function nonempty(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    value.length > 64000
  )
    throw new Error("Expected nonempty text (up to 64000 characters)");
}
function integer(value: unknown, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw new Error(`Expected an integer from ${min} to ${max}`);
}
export function validateAutomation(
  value: unknown,
): asserts value is AutomationConfig {
  fields(value, ["agents", "policies", "workflows"]);
  for (const kind of ["agents", "policies", "workflows"] as const) {
    const entries = value[kind];
    if (
      !object(entries) ||
      !Object.keys(entries).length ||
      Object.keys(entries).length > 64
    )
      throw new Error(`Expected 1–64 ${kind}`);
    for (const [name, item] of Object.entries(entries)) {
      identifier(name);
      if (kind === "agents") {
        fields(
          item,
          ["provider", "description", "instructions", "model", "reasoning"],
          ["provider", "description", "instructions"],
        );
        if (!["codex", "claude"].includes(String(item.provider)))
          throw new Error("Agent provider must be codex or claude");
        nonempty(item.description);
        nonempty(item.instructions);
        if (item.model !== undefined) {
          nonempty(item.model);
          if (item.model.startsWith("-")) throw new Error("Invalid model");
        }
        if (
          item.reasoning !== undefined &&
          !(
            item.provider === "codex"
              ? ["low", "medium", "high", "xhigh"]
              : ["low", "medium", "high", "max"]
          ).includes(String(item.reasoning))
        )
          throw new Error("Unsupported reasoning setting for this provider");
      } else if (kind === "policies") {
        fields(item, [
          "instructions",
          "weights",
          "minimumScore",
          "blockRequired",
        ]);
        nonempty(item.instructions);
        fields(item.weights, [...SEVERITIES]);
        for (const weight of Object.values(item.weights))
          integer(weight, 0, 100);
        integer(item.minimumScore, 0, 100);
        if (typeof item.blockRequired !== "boolean")
          throw new Error("blockRequired must be boolean");
      } else {
        fields(item, [
          "description",
          "policy",
          "concurrency",
          "retries",
          "timeoutSeconds",
          "steps",
        ]);
        nonempty(item.description);
        identifier(item.policy);
        if (
          !object(value.policies) ||
          !Object.hasOwn(value.policies, item.policy)
        )
          throw new Error(`Unknown policy: ${item.policy}`);
        integer(item.concurrency, 1, 8);
        integer(item.retries, 0, 3);
        integer(item.timeoutSeconds, 1, 3600);
        if (
          !Array.isArray(item.steps) ||
          !item.steps.length ||
          item.steps.length > 32
        )
          throw new Error("Expected 1–32 workflow steps");
        const ids = new Set<string>();
        for (const step of item.steps) {
          fields(step, ["id", "after", "agent", "command"], ["id", "after"]);
          identifier(step.id);
          if (ids.has(step.id)) throw new Error(`Duplicate step: ${step.id}`);
          ids.add(step.id);
          if (
            !Array.isArray(step.after) ||
            step.after.some((dep) => typeof dep !== "string") ||
            new Set(step.after).size !== step.after.length
          )
            throw new Error("Step after must contain unique step names");
          if ((step.agent !== undefined) === (step.command !== undefined))
            throw new Error("Each step requires exactly one agent or command");
          if (
            step.agent !== undefined &&
            (!object(value.agents) ||
              typeof step.agent !== "string" ||
              !Object.hasOwn(value.agents, step.agent))
          )
            throw new Error(`Unknown agent: ${step.agent}`);
          if (
            step.command !== undefined &&
            (!Array.isArray(step.command) ||
              !step.command.length ||
              step.command.some(
                (arg) => typeof arg !== "string" || arg.includes("\0"),
              ) ||
              !step.command[0])
          )
            throw new Error("Commands must be nonempty argv arrays");
        }
        const remaining = new Map(
          item.steps.map((step) => [String(step.id), step.after as string[]]),
        );
        const done = new Set<string>();
        while (remaining.size) {
          const ready = [...remaining].filter(([, deps]) =>
            deps.every((dep) => done.has(dep)),
          );
          if (!ready.length)
            throw new Error(
              "Workflow dependencies contain a cycle or unknown step",
            );
          for (const [id] of ready) {
            remaining.delete(id);
            done.add(id);
          }
        }
      }
    }
  }
}
function configPath(root: string, relative: string) {
  const directory = path.join(root, ".rl"),
    file = path.join(root, relative);
  if (
    fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink() ||
    fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()
  )
    throw new Error("Agent configuration must not be a symlink");
  return file;
}
export function readAutomation(root: string): AutomationConfig {
  const result: Record<string, unknown> = {};
  for (const [kind, relative] of Object.entries(CONFIG_FILES)) {
    const file = configPath(root, relative);
    if (!fs.existsSync(file))
      result[kind] = structuredClone(PRESET[kind as keyof AutomationConfig]);
    else {
      const data = readJsonObject(file);
      fields(data, ["version", kind]);
      if (data.version !== 1)
        throw new Error("Unsupported agent configuration version");
      result[kind] = data[kind];
    }
  }
  validateAutomation(result);
  return result;
}
export function initAutomation(root: string, provider: Agent): void {
  const paths = Object.values(CONFIG_FILES).map((file) =>
    configPath(root, file),
  );
  if (paths.some((file) => fs.existsSync(file)))
    throw new Error(
      "Agent configuration already exists; edit the existing files",
    );
  const preset = structuredClone(PRESET);
  for (const profile of Object.values(preset.agents)) {
    profile.provider = provider;
    if (provider === "claude") profile.reasoning = "high";
  }
  for (const [kind, relative] of Object.entries(CONFIG_FILES))
    writeJson(configPath(root, relative), {
      version: 1,
      [kind]: preset[kind as keyof AutomationConfig],
    });
}
