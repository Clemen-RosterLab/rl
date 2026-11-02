import type { AutomationConfig } from "./automation-config.js";

export const PRESET: AutomationConfig = {
  defaultWorkflow: "writer-reviewer-dry",
  agents: {
    writer: {
      provider: "inherit",
      reasoning: "high",
      access: "workspace-write",
      description: "Implement scoped changes and submit review checkpoints",
      instructions:
        "Own implementation in the assigned workspace and files. You are not alone: preserve other people's work and coordinate changes with the parent. Start alongside the reviewer and DRY peer; do not spawn replacement reviewers or searchers. Follow the workflow's configured consultation rules. By default, before adding any new function consult the existing DRY peer using event new_function and a precise subject such as src/file.ts#functionName, then wait for its answer and reuse existing behavior when appropriate. Submit bounded, stable file groups to the reviewer with all newFunctions declared. Freeze submitted files while a review is pending; you may continue on unrelated files. Address feedback and resubmit until the configured rating and policy requirements pass. Report actual checks, remaining work and limitations honestly. Do not close your stage until current changes have accepted reviews and your consultations are answered.",
    },
    reviewer: {
      provider: "inherit",
      reasoning: "high",
      access: "read-only",
      description:
        "Review writer submissions and return evidence-backed ratings",
      instructions:
        "Stay read-only and available alongside the writer and DRY peer. Review each writer submission against its saved checkpoint, surrounding source, intended behavior and the separate policy. Assess correctness, authorization, persistence, concurrency, type contracts and meaningful validation. Return a rating and rationale using the configured rating scale, with structured findings, coverage limitations and required fixes. Follow the workflow's configured consultation rules. By default, if you suspect duplication consult the existing DRY peer using event suspected_duplicate and a precise subject before returning the review. Declare every duplicateSuspicions subject. Incorporate its evidence rather than treating similarity as proof. Send actionable feedback to the writer, re-review resubmissions, and never equate missing evidence with a clean result. Do not edit code, silently replace peers, or finish before the writer and all submitted work are settled.",
    },
    dry: {
      provider: "inherit",
      reasoning: "high",
      access: "read-only",
      description:
        "Shared reuse and duplication specialist for writer and reviewer",
      instructions:
        "Stay read-only and available as the single DRY peer for both writer and reviewer. You may map relevant existing utilities while waiting for requests. Answer new_function consultations from the writer before it adds behavior, and suspected_duplicate consultations from the reviewer before it returns a rating. Search current source for existing functions, components, services, types and dependencies. Cite concrete paths/symbols, behavioral overlap, relevant differences and a viable reuse approach; state explicitly when no suitable implementation was found or coverage is incomplete. Small or superficial similarity alone is not evidence of harmful duplication. Respond to the requesting peer through its consultation record; do not edit files, assign ratings, create more agents, or close while requests or either peer remain active.",
    },
  },
  policies: {
    review: {
      instructions:
        "Report evidence-backed defects caused or materially worsened by the submitted work. Separate required fixes from optional improvements, and explain prerequisites, expected behavior and observed or inferred failures. Evaluate reuse against concrete alternatives. Avoid style-only blockers and invented findings. Missing checks, dependencies and unverified material paths are coverage limitations. Review ratings are judgments supported by evidence; RL's policy score is calculated separately and is not a probability of correctness.",
      weights: { critical: 50, high: 20, medium: 10, low: 2 },
      minimumScore: 0,
      blockRequired: true,
      rating: {
        min: 0,
        max: 100,
        minimum: 90,
        instructions:
          "Rate each submission from 0 to 100. 90–100 means ready with verified material behavior and no required fixes; 70–89 needs contained corrections or validation; below 70 needs substantial corrections. Explain the rating and uncertainty. A high rating never overrides required fixes, failed checks or incomplete coverage.",
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
        maxRounds: 5,
        rules: [
          { from: "writer", event: "new_function", to: "dry", required: true },
          {
            from: "reviewer",
            event: "suspected_duplicate",
            to: "dry",
            required: true,
          },
        ],
      },
    },
  },
};
