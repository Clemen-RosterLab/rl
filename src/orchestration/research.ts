import { z } from "zod";
import path from "node:path";
import { canonical, inside, now } from "../common.js";
import {
  proseSchema,
  RelativeWorkspaceFileSchema,
  StrictLowerUuidSchema,
} from "../schemas/common.js";
import type { WorkflowRun } from "../agent-runner.js";

const text = (label: string) => proseSchema(8000, label);
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const texts = (label: string) => z.array(text(label)).min(1).max(12);
export const ResearchSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("repository"),
    path: RelativeWorkspaceFileSchema,
    line: z.number().int().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("documentation"),
    url: z
      .string()
      .max(4000)
      .url()
      .refine((value) => {
        const parsed = new URL(value);
        return (
          parsed.protocol === "https:" && !parsed.username && !parsed.password
        );
      }, "Documentation sources must be HTTPS URLs without credentials"),
  }),
]);
const ApproachSchema = z
  .strictObject({
    id,
    title: text("approach title"),
    mechanism: text("implementation mechanism"),
    distinction: text("how this approach differs from the other seeds"),
    files: z.array(RelativeWorkspaceFileSchema).max(64),
    advantages: texts("advantage"),
    tradeoffs: texts("tradeoff"),
    risks: texts("risk"),
    validation: texts("validation strategy"),
    assumptions: z.array(text("assumption")).max(16),
    sources: z.array(ResearchSourceSchema).min(1).max(24),
    viability: z.enum(["viable", "ruled-out"]),
    exclusionReason: text("exclusion reason").optional(),
  })
  .superRefine((approach, ctx) => {
    if (approach.viability === "ruled-out" && !approach.exclusionReason)
      ctx.addIssue({
        code: "custom",
        message: "Ruled-out approaches need a concrete exclusion reason",
      });
  });
const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export const ResearchBriefSchema = z
  .strictObject({
    question: text("research question"),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    facts: z
      .array(
        z.strictObject({
          statement: text("research finding"),
          confidence: z.enum(["observed", "inferred"]),
          sources: z.array(ResearchSourceSchema).min(1).max(24),
        }),
      )
      .min(1)
      .max(32),
    approaches: z.array(ApproachSchema).min(2).max(5),
    comparison: text(
      "comparison against the same acceptance criteria and constraints",
    ),
    recommendation: id,
    uncertainties: z.array(text("unresolved uncertainty")).max(24),
  })
  .superRefine((brief, ctx) => {
    if (JSON.stringify(brief).length > 128000)
      ctx.addIssue({
        code: "custom",
        message:
          "Keep the research brief under 128000 characters; attach concise evidence instead of transcripts",
      });
    if (
      new Set(brief.approaches.map((a) => a.id)).size !==
      brief.approaches.length
    )
      ctx.addIssue({ code: "custom", message: "Approach IDs must be unique" });
    for (const field of ["title", "mechanism", "distinction"] as const)
      if (
        new Set(brief.approaches.map((a) => normalize(a[field]))).size !==
        brief.approaches.length
      )
        ctx.addIssue({
          code: "custom",
          message: `Approaches need distinct ${field} values; cosmetic variants do not seed alternatives`,
        });
    if (
      !brief.approaches.some(
        (a) => a.id === brief.recommendation && a.viability === "viable",
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Research must recommend an existing viable approach",
      });
  });
export const ResearchStateSchema = z.strictObject({
  brief: ResearchBriefSchema,
  at: z.string(),
  step: z.string(),
  claim: StrictLowerUuidSchema,
  decision: z
    .strictObject({
      approach: id,
      rationale: text("coordinator decision rationale"),
      at: z.string(),
    })
    .optional(),
});
export const RESEARCH_SCHEMAS = {
  research: z.strictObject({
    run: z.string(),
    step: z.string(),
    claim: StrictLowerUuidSchema,
    brief: ResearchBriefSchema,
  }),
  decide: z.strictObject({
    run: z.string(),
    approach: id,
    rationale: text("coordinator decision rationale"),
  }),
};

export function researchAction(
  run: WorkflowRun,
  action: keyof typeof RESEARCH_SCHEMAS,
  input: Record<string, unknown>,
  current: string,
) {
  if (!run.quality)
    throw new Error("Research seeds require a leveled workflow run");
  const { agent: _agent, sessionId: _session, ...raw } = input;
  if (action === "research") {
    const parsed = RESEARCH_SCHEMAS.research.parse(raw);
    const stage = run.stages.find(
      (s) => s.id === parsed.step && s.agent === "researcher",
    );
    if (
      !stage ||
      stage.status !== "running" ||
      stage.claim !== parsed.claim ||
      !stage.childId
    )
      throw new Error(
        "A current researcher claim is required to seed approaches",
      );
    if (run.quality.research?.decision)
      throw new Error(
        "Research already has an implementation decision; start a new run for a changed direction",
      );
    if (
      parsed.brief.fingerprint !== current ||
      current !== run.scope.fingerprint
    )
      throw new Error(
        "Research source changed; start a new research run instead of seeding stale approaches",
      );
    const paths = [
      ...parsed.brief.approaches.flatMap((a) => a.files),
      ...parsed.brief.approaches.flatMap((a) =>
        a.sources.filter((s) => s.kind === "repository").map((s) => s.path),
      ),
      ...parsed.brief.facts.flatMap((f) =>
        f.sources.filter((s) => s.kind === "repository").map((s) => s.path),
      ),
    ];
    for (const filename of paths)
      if (!inside(canonical(path.join(run.workspace, filename)), run.workspace))
        throw new Error("Research evidence must remain inside this worktree");
    run.quality.research = {
      brief: parsed.brief,
      at: now(),
      step: stage.id,
      claim: parsed.claim,
    };
    return run.quality.research;
  }
  const parsed = RESEARCH_SCHEMAS.decide.parse(raw),
    research = run.quality.research;
  if (
    !research ||
    run.stages.find((s) => s.id === research.step)?.status !== "completed"
  )
    throw new Error(
      "Complete the multi-approach research stage before selecting implementation direction",
    );
  if (research.decision)
    throw new Error(
      "Implementation direction is already selected; start a new run to change it",
    );
  if (
    research.brief.fingerprint !== current ||
    current !== run.scope.fingerprint
  )
    throw new Error(
      "Research source changed; repeat research before selecting an approach",
    );
  if (
    !research.brief.approaches.some(
      (a) => a.id === parsed.approach && a.viability === "viable",
    )
  )
    throw new Error("Choose a viable approach from the saved research seeds");
  research.decision = {
    approach: parsed.approach,
    rationale: parsed.rationale,
    at: now(),
  };
  return research.decision;
}
