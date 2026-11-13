import fs from "node:fs";
import path from "node:path";
import { PRESET } from "./agent-presets.js";
import type { Agent } from "./agents.js";
import { object, writeJson } from "./common.js";
import { readJsonObject } from "./json.js";
import { AutomationConfigSchema } from "./schemas/automation.js";
import { IdentifierSchema, SEVERITIES } from "./schemas/common.js";

export const CONFIG_FILES = {
  agents: ".rl/agents.json",
  policies: ".rl/policies.json",
  workflows: ".rl/agent-workflows.json",
} as const;

export { SEVERITIES };
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

export interface WorkflowTrigger {
  event: string;
  tools?: string[];
  paths?: string[];
  changes?: boolean;
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

export interface AutomationConfig {
  agents: Record<string, AgentProfile>;
  policies: Record<string, ReviewPolicy>;
  workflows: Record<string, AgentWorkflow>;
  defaultWorkflow?: string;
}

export function identifier(value: unknown): asserts value is string {
  const result = IdentifierSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "Expected an identifier using lowercase letters, numbers, hyphens or underscores",
    );
  }
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
  ) {
    throw new Error(`Expected fields: ${allowed.join(", ")}`);
  }
}

export function validateAutomation(
  value: unknown,
): asserts value is AutomationConfig {
  const parsed = AutomationConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue?.message || "Invalid automation configuration");
  }
}

function configPath(root: string, relative: string): string {
  const directory = path.join(root, ".rl");
  const file = path.join(root, relative);
  if (
    fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink() ||
    fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()
  ) {
    throw new Error("Agent configuration must not be a symlink");
  }
  return file;
}

const LEGACY_REVIEW_PROFILES = {
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
} as const;

export function readAutomation(root: string): AutomationConfig {
  const result: Record<string, unknown> = {};

  for (const [kind, relative] of Object.entries(CONFIG_FILES)) {
    const file = configPath(root, relative);
    if (!fs.existsSync(file)) {
      result[kind] = structuredClone(PRESET[kind as keyof typeof CONFIG_FILES]);
      if (kind === "workflows") {
        result.defaultWorkflow = PRESET.defaultWorkflow;
      }
      continue;
    }

    const data = readJsonObject(file);
    fields(
      data,
      kind === "workflows" ? ["version", kind, "default"] : ["version", kind],
      ["version", kind],
    );
    if (data.version !== 1) {
      throw new Error("Unsupported agent configuration version");
    }
    result[kind] = data[kind];
    if (kind === "workflows") {
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
    if (object(result.agents)) {
      result.agents = { ...structuredClone(PRESET.agents), ...result.agents };
    }
    if (
      object(result.policies) &&
      object(result.policies.review) &&
      result.policies.review.rating === undefined
    ) {
      result.policies.review = {
        ...result.policies.review,
        rating: structuredClone(PRESET.policies.review.rating),
      };
    }
  } else if (
    !fs.existsSync(configPath(root, CONFIG_FILES.agents)) &&
    object(result.workflows) &&
    object(result.agents)
  ) {
    for (const workflow of Object.values(result.workflows)) {
      if (!object(workflow) || !Array.isArray(workflow.steps)) continue;
      for (const step of workflow.steps) {
        if (
          object(step) &&
          typeof step.agent === "string" &&
          Object.hasOwn(LEGACY_REVIEW_PROFILES, step.agent)
        ) {
          result.agents[step.agent] = structuredClone(
            LEGACY_REVIEW_PROFILES[
              step.agent as keyof typeof LEGACY_REVIEW_PROFILES
            ],
          );
        }
      }
    }
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
  if (paths.some((file) => fs.existsSync(file))) {
    throw new Error(
      "Agent configuration already exists; edit the existing files",
    );
  }
  const preset = structuredClone(PRESET);
  for (const profile of Object.values(preset.agents)) {
    profile.provider = provider;
    if (provider === "claude") {
      profile.reasoning = "high";
    }
  }
  for (const [kind, relative] of Object.entries(CONFIG_FILES)) {
    writeJson(configPath(root, relative), {
      version: 1,
      [kind]: preset[kind as keyof AutomationConfig],
      ...(kind === "workflows" ? { default: preset.defaultWorkflow } : {}),
    });
  }
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
  if (addOnly && Object.hasOwn(config[kind], name)) {
    throw new Error(`${name} already exists; use set to update it`);
  }
  Object.defineProperty(config[kind], name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  if (makeDefault) {
    config.defaultWorkflow = name;
  }
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
