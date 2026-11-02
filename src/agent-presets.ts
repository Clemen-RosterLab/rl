import type { AutomationConfig } from "./automation-config.js";

export const PRESET: AutomationConfig = {
  agents: {
    behavior: {
      provider: "inherit",
      reasoning: "high",
      description:
        "Runtime correctness, user journeys, persistence and security",
      instructions:
        "Investigate supported end-to-end user journeys: input, validation, serialization, persistence, queries, subscriptions, caches, rendering and downstream consumers. Own runtime bugs, regressions, concurrency, error behavior, tenant isolation and demonstrable runtime performance failures. Check current code and intended behavior; history and old comments are leads, not proof. Distinguish current defects from fixed regressions, intentional boundaries and unverified hypotheses. Findings need prerequisites, reproducible steps, expected versus actual behavior, and evidence; label code-inferred reproductions. Do not review type hygiene without runtime impact, test design, debug cleanup, duplication or structural simplification. Attach regression advice to the corresponding bug rather than filing duplicate missing-test findings.",
    },
    reuse: {
      provider: "inherit",
      reasoning: "high",
      description: "Reuse, duplicated behavior and avoidable complexity",
      instructions:
        "Search the repository for existing components, hooks, services, utilities, dependencies and alternate implementations before judging a new capability. Own duplicated business behavior, unnecessary abstractions/features, redundant state and misplaced responsibilities with concrete maintenance cost. Prefer reuse, extension, composition, then a small focused implementation. Cite both the reviewed implementation and existing counterpart, the behavioral overlap and a viable smaller solution. For pure simplification, name removable machinery and explain how requirements are preserved. Small duplication and different presentations can be justified. Do not investigate runtime/security bugs, type-only duplication, logging cleanup or test quality. Labels such as DRY, YAGNI and code smell are not evidence.",
    },
    quality: {
      provider: "inherit",
      reasoning: "high",
      description:
        "Type contracts, static checks, debug leftovers and test quality",
      instructions:
        "Own unjustified any, casts and suppressions, overly broad contracts, failure to reuse applicable types, accidental debug leftovers, attributable static-check failures, and tests that cannot protect their claimed behavior. Distinguish safe unknown narrowing and justified dependency escape hatches from weakened checking. Preserve intentional operational logging. For test findings name a specific material contract and a useful assertion, not a coverage percentage. Do not review runtime correctness/security, architecture or duplicated business behavior. A test failure is not automatically a product bug. Request configured checks from the coordinator instead of running duplicate commands. Omit style preferences and broad cleanup of existing code.",
    },
  },
  policies: {
    review: {
      instructions:
        "Report only evidence-backed problems caused or materially worsened by the reviewed changes. Separate required fixes from optional quick wins with reasons. Critical means security exposure, destructive data loss or outage; high means broken core behavior or substantial structural cost; medium means a contained defect or worthwhile required quality fix; low means an optional quick win. Do not block on stylistic preference, tiny duplication, justified type escape hatches, intentional operational logging, speculative flexibility or generic demands for tests. Missing dependencies, unverified critical paths and unresolved material questions are coverage limitations. Do not invent findings or treat a score as a probability of correctness.",
      weights: { critical: 50, high: 20, medium: 10, low: 2 },
      minimumScore: 0,
      blockRequired: true,
    },
  },
  workflows: {
    "triple-review": {
      description:
        "Three independent reviewers, owner follow-ups and a policy-based verdict",
      policy: "review",
      concurrency: 3,
      retries: 1,
      timeoutSeconds: 600,
      triggers: [{ event: "before_finish", changes: true }],
      steps: [
        { id: "behavior", agent: "behavior", after: [] },
        { id: "reuse", agent: "reuse", after: [] },
        { id: "quality", agent: "quality", after: [] },
      ],
    },
  },
};
