import { z } from "zod";
import {
  IdentifierSchema,
  nonNullTextSchema,
  proseSchema,
  RelativeWorkspaceFileSchema,
  SEVERITIES,
  SeveritySchema,
} from "./common.js";

const REASONING_BY_PROVIDER: Record<string, readonly string[]> = {
  codex: ["low", "medium", "high", "xhigh"],
  claude: ["low", "medium", "high", "max"],
  agy: ["low", "medium", "high", "xhigh", "max"],
  inherit: ["low", "medium", "high", "xhigh", "max"],
};

export const AgentProfileSchema = z
  .strictObject({
    provider: z.enum(["inherit", "codex", "claude", "agy"]).optional(),
    description: nonNullTextSchema(64000, "description"),
    instructions: nonNullTextSchema(64000, "instructions"),
    model: nonNullTextSchema(64000, "model")
      .refine((val) => !val.startsWith("-"), "Invalid model")
      .optional(),
    reasoning: z.string().optional(),
    access: z.enum(["read-only", "workspace-write"]).optional(),
  })
  .superRefine((profile, ctx) => {
    if (profile.reasoning !== undefined) {
      const allowed = REASONING_BY_PROVIDER[profile.provider ?? "inherit"];
      if (!allowed?.includes(profile.reasoning)) {
        ctx.addIssue({
          code: "custom",
          message: "Unsupported reasoning setting for this provider",
        });
      }
    }
  });

const boundedInt = (min: number, max: number) =>
  z.number().int().min(min).max(max);

export const ReviewRatingSchema = z
  .strictObject({
    min: boundedInt(0, 1000),
    max: boundedInt(0, 1000),
    minimum: boundedInt(0, 1000),
    instructions: nonNullTextSchema(64000, "rating instructions"),
  })
  .refine(
    (r) => r.max > r.min && r.minimum >= r.min && r.minimum <= r.max,
    "Invalid reviewer rating range",
  );

export const ReviewPolicySchema = z.strictObject({
  instructions: nonNullTextSchema(64000, "policy instructions"),
  weights: z.strictObject({
    critical: boundedInt(0, 100),
    high: boundedInt(0, 100),
    medium: boundedInt(0, 100),
    low: boundedInt(0, 100),
  }),
  minimumScore: boundedInt(0, 100),
  blockRequired: z.boolean(),
  rating: ReviewRatingSchema.optional(),
});

const TriggerTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((val) => !/[\x00-\x1f]/.test(val), "Invalid trigger filter");

export const WorkflowTriggerSchema = z.strictObject({
  event: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/, "Invalid trigger event"),
  tools: z.array(TriggerTokenSchema).min(1).max(64).optional(),
  paths: z.array(TriggerTokenSchema).min(1).max(64).optional(),
  changes: z.boolean().optional(),
});

export const WorkflowStepSchema = z
  .strictObject({
    id: IdentifierSchema,
    after: z
      .array(z.string())
      .refine(
        (deps) => new Set(deps).size === deps.length,
        "Step after must contain unique step names",
      ),
    agent: z.string().optional(),
    command: z
      .array(z.string().refine((arg) => !arg.includes("\0")))
      .min(1)
      .refine((cmd) => Boolean(cmd[0]), "Commands must be nonempty argv arrays")
      .optional(),
  })
  .refine(
    (step) => (step.agent !== undefined) !== (step.command !== undefined),
    "Each step requires exactly one agent or command",
  );

export const CollaborationRuleSchema = z.strictObject({
  from: IdentifierSchema,
  event: IdentifierSchema,
  to: IdentifierSchema,
  required: z.boolean(),
});

export const CollaborationConfigSchema = z.strictObject({
  writer: IdentifierSchema,
  reviewer: IdentifierSchema,
  dry: IdentifierSchema,
  maxRounds: boundedInt(1, 20),
  rules: z.array(CollaborationRuleSchema).max(32),
});

export const AgentWorkflowSchema = z.strictObject({
  description: nonNullTextSchema(64000, "workflow description"),
  policy: IdentifierSchema,
  concurrency: boundedInt(1, 8),
  retries: boundedInt(0, 3),
  timeoutSeconds: boundedInt(1, 3600),
  steps: z.array(WorkflowStepSchema).min(1).max(32),
  triggers: z.array(WorkflowTriggerSchema).max(32).optional(),
  collaboration: CollaborationConfigSchema.optional(),
});

function verifyTopologicalSteps(
  steps: readonly { id: string; after: string[] }[],
): string | null {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      return `Duplicate step: ${step.id}`;
    }
    seen.add(step.id);
  }
  const remaining = new Map(steps.map((step) => [step.id, step.after]));
  const done = new Set<string>();
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) =>
      deps.every((dep) => done.has(dep)),
    );
    if (ready.length === 0) {
      return "Workflow dependencies contain a cycle or unknown step";
    }
    for (const [id] of ready) {
      remaining.delete(id);
      done.add(id);
    }
  }
  return null;
}

export const AutomationConfigSchema = z
  .strictObject({
    agents: z
      .record(IdentifierSchema, AgentProfileSchema)
      .refine(
        (m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 64,
        "Expected 1–64 agents",
      ),
    policies: z
      .record(IdentifierSchema, ReviewPolicySchema)
      .refine(
        (m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 64,
        "Expected 1–64 policies",
      ),
    workflows: z
      .record(IdentifierSchema, AgentWorkflowSchema)
      .refine(
        (m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 64,
        "Expected 1–64 workflows",
      ),
    defaultWorkflow: z.unknown().optional(),
  })
  .superRefine((config, ctx) => {
    for (const workflow of Object.values(config.workflows)) {
      if (!Object.hasOwn(config.policies, workflow.policy)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown policy: ${workflow.policy}`,
        });
        return;
      }
      for (const step of workflow.steps) {
        if (
          step.agent !== undefined &&
          !Object.hasOwn(config.agents, step.agent)
        ) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown agent: ${step.agent}`,
          });
          return;
        }
      }
      const topoError = verifyTopologicalSteps(workflow.steps);
      if (topoError) {
        ctx.addIssue({ code: "custom", message: topoError });
        return;
      }

      if (workflow.collaboration) {
        const collab = workflow.collaboration;
        const roles = [collab.writer, collab.reviewer, collab.dry];
        if (new Set(roles).size !== 3 || workflow.concurrency < 3) {
          ctx.addIssue({
            code: "custom",
            message:
              "Collaborative roles require three distinct steps and concurrency of at least three",
          });
          return;
        }
        for (const role of roles) {
          const step = workflow.steps.find(
            (candidate) => candidate.id === role,
          );
          if (!step?.agent || step.after.length > 0) {
            ctx.addIssue({
              code: "custom",
              message:
                "Collaborative roles must be agent steps ready together at startup",
            });
            return;
          }
          const profile = config.agents[step.agent];
          if (role === collab.writer && profile.access !== "workspace-write") {
            ctx.addIssue({
              code: "custom",
              message: "Collaborative writer must have workspace-write access",
            });
            return;
          }
          if (role !== collab.writer && profile.access === "workspace-write") {
            ctx.addIssue({
              code: "custom",
              message: "Reviewer and DRY roles must be read-only",
            });
            return;
          }
        }
        if (!config.policies[workflow.policy]?.rating) {
          ctx.addIssue({
            code: "custom",
            message: "Collaborative workflows require a reviewer rating policy",
          });
          return;
        }
        const seenRoutes = new Set<string>();
        for (const rule of collab.rules) {
          if (
            !roles.includes(rule.from) ||
            !roles.includes(rule.to) ||
            rule.from === rule.to
          ) {
            ctx.addIssue({
              code: "custom",
              message: "Invalid collaboration route",
            });
            return;
          }
          if (
            rule.required &&
            !(
              (rule.from === collab.writer && rule.event === "new_function") ||
              (rule.from === collab.reviewer &&
                rule.event === "suspected_duplicate")
            )
          ) {
            ctx.addIssue({
              code: "custom",
              message:
                "Required consultations support writer new_function and reviewer suspected_duplicate; use required: false for additional message routes",
            });
            return;
          }
          const routeKey = `${rule.from}:${rule.event}:${rule.to}`;
          if (seenRoutes.has(routeKey)) {
            ctx.addIssue({
              code: "custom",
              message: "Duplicate collaboration rule",
            });
            return;
          }
          seenRoutes.add(routeKey);
        }
      }
    }

    if (
      config.defaultWorkflow !== undefined &&
      (typeof config.defaultWorkflow !== "string" ||
        !Object.hasOwn(config.workflows, config.defaultWorkflow))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Unknown default workflow",
      });
    }
  });

const EvidencePathSchema = proseSchema(1024, "evidence path").refine(
  (val) =>
    !val.startsWith("/") &&
    !val.includes("\\") &&
    !/[\r\n]/.test(val) &&
    !val.split("/").some((part) => !part || part === "." || part === ".."),
  "Evidence paths must be relative to the reviewed workspace",
);

export const FindingSchema = z.strictObject({
  title: proseSchema(16000, "finding title"),
  severity: SeveritySchema,
  required: z.boolean(),
  rootCause: proseSchema(16000, "finding rootCause"),
  file: EvidencePathSchema,
  line: z.number().int().safe().min(1),
  evidence: proseSchema(16000, "finding evidence"),
  recommendation: proseSchema(16000, "finding recommendation"),
  confidence: z.enum(["observed", "inferred"]),
});

export const RoutingLeadSchema = z.strictObject({
  owner: proseSchema(16000, "routing owner"),
  file: EvidencePathSchema,
  reason: proseSchema(16000, "routing reason"),
});

export const ReviewResultSchema = z.strictObject({
  summary: proseSchema(16000, "review summary"),
  complete: z.boolean(),
  findings: z.array(FindingSchema).max(100),
  limitations: z.array(proseSchema(16000, "limitation")).max(100),
  checkRequests: z.array(proseSchema(16000, "checkRequest")).max(100),
  routingLeads: z.array(RoutingLeadSchema).max(32),
});

export { SEVERITIES, RelativeWorkspaceFileSchema };
