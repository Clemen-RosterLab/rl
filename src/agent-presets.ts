import {
  CLAUDE_WRITER_INSTRUCTIONS,
  CLAUDE_REVIEWER_INSTRUCTIONS,
  CLAUDE_DRY_INSTRUCTIONS,
  CLAUDE_QA_INSTRUCTIONS,
} from "./orchestration/host-instructions.js";
import type { AutomationConfig } from "./automation-config.js";
import {
  WRITER_INSTRUCTIONS,
  REVIEWER_INSTRUCTIONS,
  DRY_INSTRUCTIONS,
  QA_INSTRUCTIONS,
  REVIEW_POLICY_INSTRUCTIONS,
} from "./orchestration/role-instructions.js";

export const PRESET: AutomationConfig = {
  defaultWorkflow: "writer-reviewer-dry",
  agents: {
    writer: {
      provider: "inherit",
      hosts: {
        codex: { model: "gpt-6-astra", reasoning: "medium" },
        claude: { instructions: CLAUDE_WRITER_INSTRUCTIONS },
      },
      access: "workspace-write",
      description:
        "Implementation writer that publishes bounded block-level checkpoints to a concurrent reviewer.",
      instructions: WRITER_INSTRUCTIONS,
    },
    reviewer: {
      provider: "inherit",
      hosts: {
        codex: { model: "gpt-6-astra", reasoning: "high" },
        claude: { model: "opus", instructions: CLAUDE_REVIEWER_INSTRUCTIONS },
      },
      access: "read-only",
      description:
        "Persistent read-only reviewer that performs concurrent reconnaissance, targets writer-owned blocks, and rates the stable final diff.",
      instructions: REVIEWER_INSTRUCTIONS,
    },
    dry: {
      provider: "inherit",
      hosts: {
        codex: { model: "gpt-6-astra", reasoning: "low" },
        claude: { model: "sonnet", instructions: CLAUDE_DRY_INSTRUCTIONS },
      },
      access: "read-only",
      description:
        "Persistent read-only semantic-similarity searcher that returns objective DRY evidence without reviewing or implementing.",
      instructions: DRY_INSTRUCTIONS,
    },
    "regression-qa": {
      provider: "inherit",
      hosts: {
        codex: { model: "gpt-6-astra", reasoning: "low" },
        claude: { model: "sonnet", instructions: CLAUDE_QA_INSTRUCTIONS },
      },
      access: "read-only",
      description:
        "Browser QA for specified acceptance and regression flows when requested by the coordinator",
      instructions: QA_INSTRUCTIONS,
    },
  },
  policies: {
    review: {
      instructions: REVIEW_POLICY_INSTRUCTIONS,
      weights: { critical: 50, high: 20, medium: 10, low: 2 },
      minimumScore: 0,
      blockRequired: false,
      rating: {
        min: 0,
        max: 10,
        minimum: 6,
        instructions:
          "Use the final 0–10 weighted score after N/A normalization and the single strict 0.5 multiplier. Exactly 6.0 meets the rewrite gate; below 6.0 requires rewrite. Preserve the full arithmetic and terminal decision in the rationale. Missing or incomplete review cannot receive a rating.",
      },
    },
  },
  workflows: {
    "writer-reviewer-dry": {
      description:
        "Parallel writer, reviewer and DRY peers with rated review checkpoints",
      policy: "review",
      concurrency: 3,
      retries: 1,
      timeoutSeconds: 3600,
      triggers: [{ event: "task_planned" }, { event: "before_edit" }],
      steps: [
        { id: "writer", agent: "writer", after: [] },
        { id: "reviewer", agent: "reviewer", after: [] },
        { id: "dry", agent: "dry", after: [] },
      ],
      collaboration: {
        writer: "writer",
        reviewer: "reviewer",
        dry: "dry",
        maxRounds: 4,
        rules: [
          { from: "writer", event: "new_function", to: "dry", required: false },
          {
            from: "reviewer",
            event: "suspected_duplicate",
            to: "dry",
            required: false,
          },
        ],
      },
    },
  },
};
