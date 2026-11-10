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
  provider?: Agent | "inherit";
  description: string;
  instructions: string;
  model?: string;
  reasoning?: string;
  access?: "read-only" | "workspace-write";
}
export interface ReviewPolicy {
  instructions: string;
  weights: Record<Severity, number>;
  minimumScore: number;
  blockRequired: boolean;
  rating?: { min: number; max: number; minimum: number; instructions: string };
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
  triggers?: WorkflowTrigger[];
  collaboration?: {
    writer: string;
    reviewer: string;
    dry: string;
    maxRounds: number;
    rules: { from: string; event: string; to: string; required: boolean }[];
  };
}
export interface WorkflowTrigger {
  event: string;
  tools?: string[];
  paths?: string[];
  changes?: boolean;
}
export interface AutomationConfig {
  agents: Record<string, AgentProfile>;
  policies: Record<string, ReviewPolicy>;
  workflows: Record<string, AgentWorkflow>;
  defaultWorkflow?: string;
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
  fields(
    value,
    ["agents", "policies", "workflows", "defaultWorkflow"],
    ["agents", "policies", "workflows"],
  );
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
          [
            "provider",
            "description",
            "instructions",
            "model",
            "reasoning",
            "access",
          ],
          ["description", "instructions"],
        );
        if (
          item.provider !== undefined &&
          !["inherit", "codex", "claude", "agy"].includes(String(item.provider))
        )
          throw new Error(
            "Agent provider must be inherit, codex, claude or agy",
          );
        nonempty(item.description);
        nonempty(item.instructions);
        if (
          item.access !== undefined &&
          item.access !== "read-only" &&
          item.access !== "workspace-write"
        )
          throw new Error("Agent access must be read-only or workspace-write");
        if (item.model !== undefined) {
          nonempty(item.model);
          if (item.model.startsWith("-")) throw new Error("Invalid model");
        }
        if (
          item.reasoning !== undefined &&
          !(
            item.provider === "agy"
              ? ["low", "medium", "high", "xhigh", "max"]
              : item.provider !== "claude"
                ? ["low", "medium", "high", "xhigh"]
                : ["low", "medium", "high", "max"]
          ).includes(String(item.reasoning))
        )
          throw new Error("Unsupported reasoning setting for this provider");
      } else if (kind === "policies") {
        fields(
          item,
          [
            "instructions",
            "weights",
            "minimumScore",
            "blockRequired",
            "rating",
          ],
          ["instructions", "weights", "minimumScore", "blockRequired"],
        );
        nonempty(item.instructions);
        fields(item.weights, [...SEVERITIES]);
        for (const weight of Object.values(item.weights))
          integer(weight, 0, 100);
        integer(item.minimumScore, 0, 100);
        if (typeof item.blockRequired !== "boolean")
          throw new Error("blockRequired must be boolean");
        if (item.rating !== undefined) {
          fields(item.rating, ["min", "max", "minimum", "instructions"]);
          for (const key of ["min", "max", "minimum"])
            integer(item.rating[key], 0, 1000);
          if (
            Number(item.rating.max) <= Number(item.rating.min) ||
            Number(item.rating.minimum) < Number(item.rating.min) ||
            Number(item.rating.minimum) > Number(item.rating.max)
          )
            throw new Error("Invalid reviewer rating range");
          nonempty(item.rating.instructions);
        }
      } else {
        fields(
          item,
          [
            "description",
            "policy",
            "concurrency",
            "retries",
            "timeoutSeconds",
            "steps",
            "triggers",
            "collaboration",
          ],
          [
            "description",
            "policy",
            "concurrency",
            "retries",
            "timeoutSeconds",
            "steps",
          ],
        );
        if (item.triggers !== undefined) {
          if (!Array.isArray(item.triggers) || item.triggers.length > 32)
            throw new Error("Expected up to 32 workflow triggers");
          for (const trigger of item.triggers) {
            fields(trigger, ["event", "tools", "paths", "changes"], ["event"]);
            nonempty(trigger.event);
            if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(trigger.event))
              throw new Error("Invalid trigger event");
            for (const key of ["tools", "paths"])
              if (
                trigger[key] !== undefined &&
                (!Array.isArray(trigger[key]) ||
                  !trigger[key].length ||
                  trigger[key].length > 64 ||
                  trigger[key].some(
                    (text: unknown) =>
                      typeof text !== "string" ||
                      !text ||
                      text.length > 512 ||
                      /[\x00-\x1f]/.test(text),
                  ))
              )
                throw new Error(`Invalid trigger ${key}`);
            if (
              trigger.changes !== undefined &&
              typeof trigger.changes !== "boolean"
            )
              throw new Error("Trigger changes must be boolean");
          }
        }
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
        if (item.collaboration !== undefined) {
          const collaboration = item.collaboration;
          fields(collaboration, [
            "writer",
            "reviewer",
            "dry",
            "maxRounds",
            "rules",
          ]);
          const roles = [
            collaboration.writer,
            collaboration.reviewer,
            collaboration.dry,
          ];
          if (new Set(roles).size !== 3 || Number(item.concurrency) < 3)
            throw new Error(
              "Collaborative roles require three distinct steps and concurrency of at least three",
            );
          for (const role of roles) {
            identifier(role);
            const step = item.steps.find((step) => step.id === role);
            if (!step?.agent || step.after.length)
              throw new Error(
                "Collaborative roles must be agent steps ready together at startup",
              );
            const profile = object(value.agents)
              ? value.agents[step.agent]
              : undefined;
            if (
              role === collaboration.writer &&
              object(profile) &&
              profile.access !== "workspace-write"
            )
              throw new Error(
                "Collaborative writer must have workspace-write access",
              );
            if (
              role !== collaboration.writer &&
              object(profile) &&
              profile.access === "workspace-write"
            )
              throw new Error("Reviewer and DRY roles must be read-only");
          }
          integer(collaboration.maxRounds, 1, 20);
          const policy = object(value.policies)
            ? value.policies[item.policy]
            : undefined;
          if (!object(policy) || !object(policy.rating))
            throw new Error(
              "Collaborative workflows require a reviewer rating policy",
            );
          if (
            !Array.isArray(collaboration.rules) ||
            collaboration.rules.length > 32
          )
            throw new Error("Expected up to 32 collaboration rules");
          const routes = new Set<string>();
          for (const rule of collaboration.rules) {
            fields(rule, ["from", "event", "to", "required"]);
            if (
              !roles.includes(rule.from) ||
              !roles.includes(rule.to) ||
              rule.from === rule.to ||
              typeof rule.required !== "boolean"
            )
              throw new Error("Invalid collaboration route");
            identifier(rule.event);
            if (
              rule.required &&
              !(
                (rule.from === collaboration.writer &&
                  rule.event === "new_function") ||
                (rule.from === collaboration.reviewer &&
                  rule.event === "suspected_duplicate")
              )
            )
              throw new Error(
                "Required consultations support writer new_function and reviewer suspected_duplicate; use required: false for additional message routes",
              );
            const key = `${rule.from}:${rule.event}:${rule.to}`;
            if (routes.has(key))
              throw new Error("Duplicate collaboration rule");
            routes.add(key);
          }
        }
      }
    }
  }
  if (
    value.defaultWorkflow !== undefined &&
    (!object(value.workflows) ||
      typeof value.defaultWorkflow !== "string" ||
      !Object.hasOwn(value.workflows, value.defaultWorkflow))
  )
    throw new Error("Unknown default workflow");
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
    if (!fs.existsSync(file)) {
      result[kind] = structuredClone(PRESET[kind as keyof typeof CONFIG_FILES]);
      if (kind === "workflows") result.defaultWorkflow = PRESET.defaultWorkflow;
    } else {
      const data = readJsonObject(file);
      fields(
        data,
        kind === "workflows" ? ["version", kind, "default"] : ["version", kind],
        ["version", kind],
      );
      if (data.version !== 1)
        throw new Error("Unsupported agent configuration version");
      result[kind] = data[kind];
      if (kind === "workflows")
        result.defaultWorkflow =
          data.default === undefined
            ? object(data.workflows)
              ? Object.keys(data.workflows)[0]
              : undefined
            : data.default;
    }
  }
  // Older add/set commands could write just one configuration file. Supply
  // the roles/rating needed by the inherited workflow without replacing any
  // explicit profile or changing the user's files.
  if (!fs.existsSync(configPath(root, CONFIG_FILES.workflows))) {
    if (object(result.agents))
      result.agents = { ...structuredClone(PRESET.agents), ...result.agents };
    if (
      object(result.policies) &&
      object(result.policies.review) &&
      result.policies.review.rating === undefined
    )
      result.policies.review = {
        ...result.policies.review,
        rating: structuredClone(PRESET.policies.review.rating),
      };
  } else if (
    !fs.existsSync(configPath(root, CONFIG_FILES.agents)) &&
    object(result.workflows) &&
    object(result.agents)
  ) {
    const legacy = {
      behavior: {
        ...PRESET.agents.reviewer,
        description: "Review runtime correctness and security",
        instructions:
          "Independently review the supplied scope for runtime correctness, authorization, persistence and concurrency defects. Stay read-only; report concrete evidence and coverage limitations using the supplied result schema.",
      },
      reuse: {
        ...PRESET.agents.dry,
        description: "Review reuse and complexity",
        instructions:
          "Independently search existing source and dependencies for concrete reuse opportunities in the supplied scope. Stay read-only; distinguish behavioral overlap from superficial similarity and report paths, symbols, findings and coverage limitations using the supplied result schema.",
      },
      quality: {
        ...PRESET.agents.reviewer,
        description: "Review implementation quality and validation",
        instructions:
          "Independently review the supplied scope for type contracts, maintainability, failure handling and meaningful validation. Stay read-only; report evidence-backed findings and coverage limitations using the supplied result schema.",
      },
    };
    for (const workflow of Object.values(result.workflows))
      if (object(workflow) && Array.isArray(workflow.steps))
        for (const step of workflow.steps)
          if (
            object(step) &&
            typeof step.agent === "string" &&
            Object.hasOwn(legacy, step.agent)
          )
            result.agents[step.agent] = structuredClone(
              legacy[step.agent as keyof typeof legacy],
            );
  }
  validateAutomation(result);
  return result;
}
export function initAutomation(
  root: string,
  provider: Agent | "inherit",
): void {
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
      ...(kind === "workflows" ? { default: preset.defaultWorkflow } : {}),
    });
}
export function hasAutomation(root: string): boolean {
  return Object.values(CONFIG_FILES).some((relative) =>
    fs.existsSync(configPath(root, relative)),
  );
}
export function setAutomation(
  root: string,
  kind: "agents" | "workflows",
  name: string,
  value: unknown,
  addOnly = false,
  makeDefault = false,
): void {
  identifier(name);
  const config = readAutomation(root);
  if (addOnly && Object.hasOwn(config[kind], name))
    throw new Error(`${name} already exists; use set to update it`);
  Object.defineProperty(config[kind], name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  if (makeDefault) config.defaultWorkflow = name;
  validateAutomation(config);
  writeJson(configPath(root, CONFIG_FILES[kind]), {
    version: 1,
    [kind]: config[kind],
    ...(kind === "workflows" ? { default: config.defaultWorkflow } : {}),
  });
}
export function defaultWorkflow(config: AutomationConfig): string {
  return config.defaultWorkflow ?? Object.keys(config.workflows)[0];
}
