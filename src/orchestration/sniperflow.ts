import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { args, locked, message, readJson, writeJson } from "../common.js";
import { Store } from "../store.js";
import {
  RelativeWorkspaceFileSchema,
  toCleanJsonSchema,
} from "../schemas/common.js";
import { sanitizeTerminalText } from "../tui/ansi.js";
import { AssignmentExpired, sniperTurn } from "./sniper-agent.js";
import { draftWorkspace, workloadLines } from "./sniper-diff.js";

const positiveSeconds = z.number().int().positive().max(2147483);
const text = z.string().trim().min(1);
const finding = z.strictObject({
  confidence: z.number().min(0).max(1),
  claim: text,
  evidence: text,
});
const deadlines = z.array(
  z.strictObject({
    role: z.enum([
      "specialist",
      "product-owner",
      "regression",
      "quality",
      "minimality",
    ]),
    seconds: positiveSeconds,
  }),
);
const reportFields = {
  summary: text,
  extensionSeconds: positiveSeconds.nullable(),
  specialistQuestion: text.nullable(),
};
const report = z.strictObject({ ...reportFields, result: z.unknown() });
const assignment = z.strictObject({
  instructions: text.describe(
    "Identify the affected symbol, its current behavior, the required change, and behavior to preserve.",
  ),
  acceptanceCheck: text.describe(
    "Give a focused check with an observable expected result.",
  ),
  files: z.array(RelativeWorkspaceFileSchema).min(1),
  seconds: positiveSeconds.nullable(),
});
type Assignment = z.infer<typeof assignment>;
const plan = z.strictObject({
  action: z.enum(["write", "review", "accept"]),
  rationale: text,
  assignments: z.array(assignment),
  deadlines,
});
const verdict = z.strictObject({ approved: z.boolean(), reasons: text });
const reviewers = {
  regression:
    "Aggressively find unintended behavior changes against the initial tree. Trace callers and existing tests.",
  quality:
    "Aggressively check correctness, readability and maintainability. Demand concrete, reproducible evidence.",
  minimality:
    "Aggressively challenge every unnecessary addition. Check shared libraries, duplication and simpler implementations.",
};
const specialist =
  "Read broadly across callers, dependencies and affected behavior. Verify every claim against the checkout. Give a confidence from 0 to 1 and file/symbol evidence for each claim. Omit unverified claims and explicitly identify unknowns.";
const owner =
  "Act as a persistent product owner. Infer intent, customer-visible behavior, blast radius and measurable acceptance criteria. Push for missing requirements. Explain justified compromises.";
const coordinator =
  "You are the orchestrator. Own the ticket, gather requirements and negotiate tradeoffs. Delegate code investigation to the specialist. Set exact writer instructions and file ownership. Use the default writer allowance for routine changes and give larger assignments more time. Shorten a writer deadline only when observed timings for comparable work support it. Account for reading the files, composing the patch and checking it. After a timeout, use the last report to narrow the assignment or increase its allowance. Accept only when satisfied with the reviewed result.";
const leaseDecision = z.strictObject({
  seconds: z.number().int().min(0).max(2147483),
  rationale: text,
});
const asTime = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString();

// Wait for the complete batch, even when one agent fails. No assignment
// can still be using the previous tree when the next batch begins.
async function collective<T>(tasks: Promise<T>[]) {
  const results = await Promise.allSettled(tasks);
  return results.map((item) => {
    if (item.status === "rejected") throw item.reason;
    return item.value;
  });
}

export async function sniperflow(store: Store, argv: string[]) {
  const { values, positionals } = args(
    argv,
    ["lines", "seconds", "agent-seconds", "writer-seconds", "extend"],
    ["status"],
  );
  const [record, data] = store.current();
  const home = path.join(path.dirname(record), "sniperflow");
  const latest = path.join(home, "latest.json");
  const control = path.join(home, "control");
  const lineBudget = z.number().int().nonnegative().safe();
  const requestedLimit =
    values.lines === undefined
      ? undefined
      : lineBudget.parse(Number(values.lines));
  if (
    values.extend !== undefined ||
    values.status ||
    (!positionals.length && requestedLimit !== undefined)
  ) {
    if (
      positionals.length ||
      values.seconds !== undefined ||
      values["agent-seconds"] !== undefined ||
      values["writer-seconds"] !== undefined ||
      (values.status &&
        (values.extend !== undefined || requestedLimit !== undefined))
    )
      throw new Error("Choose one sniperflow operation");
    return locked(control, ".control.lock", () => {
      if (!fs.existsSync(latest))
        throw new Error("No sniperflow run in this workspace");
      const state = readJson(latest);
      if (values.extend !== undefined || requestedLimit !== undefined) {
        const deadline = Date.parse(String(state.deadline));
        if (state.status !== "running" || deadline <= Date.now())
          throw new Error("No live sniperflow to update");
        if (values.extend !== undefined) {
          const extra = positiveSeconds.parse(Number(values.extend));
          state.deadline = new Date(deadline + extra * 1000).toISOString();
        }
        if (requestedLimit !== undefined) state.limit = requestedLimit;
        writeJson(latest, state);
      }
      console.log(JSON.stringify(state, null, 2));
      return 0;
    });
  }
  if (positionals.length !== 1 || !positionals[0].trim())
    throw new Error("Expected rl workflow sniperflow '<ticket objective>'");
  const objective = positionals[0];
  const seconds = positiveSeconds.parse(Number(values.seconds ?? 10800));
  const lease = positiveSeconds.parse(Number(values["agent-seconds"] ?? 300));
  const writerLease = positiveSeconds.parse(
    Number(values["writer-seconds"] ?? values["agent-seconds"] ?? 900),
  );
  return locked(home, ".run.lock", async () => {
    const id = randomUUID(),
      directory = path.join(home, id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const journal = path.join(directory, "events.jsonl");
    const log = (role: string, summary: string, details?: unknown) => {
      fs.appendFileSync(
        journal,
        JSON.stringify({
          at: new Date().toISOString(),
          role,
          summary,
          details,
        }) + "\n",
        { mode: 0o600 },
      );
      console.error(sanitizeTerminalText(role + ": " + summary));
    };
    await locked(control, ".control.lock", () =>
      writeJson(latest, {
        id,
        objective,
        limit: requestedLimit ?? 500,
        deadline: asTime(seconds),
        agentSeconds: lease,
        writerSeconds: writerLease,
        status: "running",
        directory,
      }),
    );
    log(
      "supervisor",
      "Run " + id + " started; draft and reports: " + directory,
    );
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error("Sniperflow interrupted"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const check = () => {
      const state = readJson(latest);
      if (Date.parse(String(state.deadline)) <= Date.now())
        abort.abort(new Error("Sniperflow reached its overall deadline"));
      abort.signal.throwIfAborted();
      return lineBudget.parse(state.limit);
    };
    const timer = setInterval(() => {
      try {
        check();
      } catch (error) {
        abort.abort(error);
      }
    }, 200);
    const finish = (status: string, summary: string) =>
      writeJson(latest, {
        ...readJson(latest),
        status,
        summary,
        endedAt: new Date().toISOString(),
      });
    try {
      check();
      const draft = draftWorkspace(data.worktree, directory);
      const context = {
        objective,
        baselineTree: draft.base,
        defaultAgentSeconds: lease,
        defaultWriterSeconds: writerLease,
      };
      let requirements = "",
        facts: unknown = [],
        lastDecision = "",
        lastReview: unknown = null;
      let writerReports: unknown[] = [];
      let acceptedTree = "";
      const roleBudgets = new Map<string, number>();
      let coordinatorQueue: Promise<unknown> = Promise.resolve();

      async function turn<T extends z.ZodType>(
        role: string,
        task: string,
        schema: T,
        budget = roleBudgets.get(role) ?? lease,
        arbitration = false,
      ): Promise<z.output<T>> {
        let followup = "";
        const orchestrating = role === "orchestrator";
        let remaining = orchestrating ? null : budget;

        const response = z.strictObject({
          ...reportFields,
          extensionSeconds: orchestrating
            ? z.null()
            : reportFields.extensionSeconds,
          result: schema.nullable(),
        });
        for (;;) {
          const currentLimit = check();
          const request = JSON.stringify({
            context: { ...context, logicAdditionLimit: currentLimit },
            requirements,
            facts,
            lastDecision,
            lastReview,
            writerReports,
            task,
            followup,
            seconds: remaining,
          });
          const prompt =
            request +
            (orchestrating
              ? "\nYou have the duration of the workflow to coordinate. Choose deadlines for your agents. Return null for extensionSeconds."
              : "\nReturn a final summary before your deadline. To request more time return your progress, justification and extensionSeconds.") +
            " For a specialist consultation supply specialistQuestion. Otherwise return the required result. Use null for unused fields.";
          const invoke = () => {
            check();
            log(
              role,
              orchestrating
                ? "Coordinating"
                : "Assigned " + remaining + " seconds",
              task,
            );
            return sniperTurn(
              draft.cwd,
              role,
              prompt,
              toCleanJsonSchema(response),
              remaining,
              abort.signal,
            );
          };
          const start = Date.now();
          const pending =
            role === "orchestrator" ? coordinatorQueue.then(invoke) : invoke();
          if (role === "orchestrator")
            coordinatorQueue = pending.catch(() => {});
          const raw = await pending;
          if (remaining !== null) remaining -= (Date.now() - start) / 1000;
          const answer = report.parse(raw);
          log(role, answer.summary, answer.result);
          if (answer.extensionSeconds !== null) {
            if (orchestrating)
              throw new Error(
                "Only delegated agents can request an assignment extension",
              );
            const decision = await turn(
              "orchestrator",
              coordinator +
                " Decide this extension. Zero denies. " +
                JSON.stringify({
                  role,
                  task,
                  progress: answer.summary,
                  requested: answer.extensionSeconds,
                }),
              leaseDecision,
              undefined,
              true,
            );
            if (!decision.seconds)
              throw new AssignmentExpired(
                role + " extension denied: " + decision.rationale,
              );
            remaining = decision.seconds;
            followup = "Extension granted. Continue from: " + answer.summary;
          } else if (answer.specialistQuestion !== null) {
            if (arbitration || role === "specialist")
              throw new Error("Invalid nested consultation");
            if (remaining !== null && remaining <= 0)
              throw new AssignmentExpired(role + " exhausted its assignment");
            const advice = await turn(
              "specialist",
              specialist + " Answer: " + answer.specialistQuestion,
              z.array(finding),
            );
            followup = JSON.stringify({
              progress: answer.summary,
              question: answer.specialistQuestion,
              advice,
            });
          } else {
            if (answer.result === null)
              throw new Error(role + " returned no result: " + answer.summary);
            return schema.parse(answer.result);
          }
        }
      }

      async function retryExpired<T>(work: () => Promise<T>) {
        for (;;) {
          check();
          try {
            return await work();
          } catch (error) {
            if (!(error instanceof AssignmentExpired)) throw error;
            log("supervisor", error.message);
            lastReview = { interruptedAssignment: error.message };
          }
        }
      }
      const brief = await retryExpired(() =>
        turn(
          "orchestrator",
          coordinator +
            " Frame the objective and gather initial questions for product and engineering. Set role deadlines in seconds, or use an empty list for defaults.",
          z.strictObject({ brief: text, deadlines }),
        ),
      );
      for (const entry of brief.deadlines)
        roleBudgets.set(entry.role, entry.seconds);
      const [technical, product] = await Promise.allSettled([
        retryExpired(() =>
          turn(
            "specialist",
            specialist + " Investigate the ticket. " + brief.brief,
            z.array(finding),
          ),
        ),
        retryExpired(() =>
          turn(
            "product-owner",
            owner + " Define completion. " + brief.brief,
            text,
          ),
        ),
      ]);
      if (technical.status === "rejected") throw technical.reason;
      if (product.status === "rejected") throw product.reason;
      facts = technical.value;
      requirements = product.value;

      for (;;) {
        check();
        const tree = draft.tree();
        const additions = workloadLines(draft.cwd, draft.base, tree);
        const next = await retryExpired(() =>
          turn(
            "orchestrator",
            coordinator +
              " Choose write, review, or accept. Give each writer exact relative file paths, verified symbols or search anchors from the specialist, the intended before/after behavior, and a focused acceptance check. Set seconds to null to use defaultWriterSeconds; choose a different deadline when the work warrants it. Overlapping assignments wait. Review again to argue a finding with new evidence. " +
              JSON.stringify({
                tree,
                additions,
                allApproved: acceptedTree === tree,
              }),
            plan,
          ),
        );
        for (const entry of next.deadlines)
          roleBudgets.set(entry.role, entry.seconds);
        lastDecision = next.rationale;
        if (next.action === "accept") {
          const outcome = await locked(control, ".control.lock", () => {
            const limit = check();
            if (additions > limit) {
              lastReview = {
                blocker:
                  "Reduce the draft to the configured logic line budget before acceptance.",
              };
              log(
                "supervisor",
                "Acceptance blocked: " +
                  additions +
                  " added logic lines exceed " +
                  limit,
              );
              return "revise";
            }
            if (acceptedTree !== tree) return "review";
            draft.deliver(check);
            finish("accepted", next.rationale);
            console.log(
              "Sniperflow accepted · " +
                additions +
                "/" +
                limit +
                " added logic lines",
            );
            return "accepted";
          });
          if (outcome === "accepted") return 0;
          if (outcome === "revise") continue;
        }
        try {
          if (next.action === "write") {
            if (!next.assignments.length)
              throw new Error(
                "Write decision requires at least one assignment",
              );
            acceptedTree = "";
            writerReports = [];
            const pending = [...next.assignments];
            while (pending.length) {
              const batch: Assignment[] = [];
              const claimed = new Set<string>();
              for (let i = 0; i < pending.length && batch.length < 3;) {
                const job = pending[i];
                // Reserve overlapping paths in queue order, including ancestors.
                const overlaps = job.files.some((file) =>
                  [...claimed].some(
                    (other) =>
                      file === other ||
                      file.startsWith(other + "/") ||
                      other.startsWith(file + "/"),
                  ),
                );
                for (const file of job.files) claimed.add(file);
                if (overlaps) {
                  i++;
                  continue;
                }
                batch.push(...pending.splice(i, 1));
              }
              const patches = await Promise.allSettled(
                batch.map((job, i) =>
                  turn(
                    "writer-" + (i + 1),
                    "Read the assigned files and use the specialist evidence in facts. Implement the requested behavior within those files. Your deliverable is a git-compatible unified diff against their current contents. RL applies your returned patch. Use git apply --check to validate it if feasible. Report the acceptance check you performed or what remains for review after application. Use an empty patch only when the current code already satisfies the assignment. " +
                      JSON.stringify(job),
                    z.strictObject({ patch: z.string(), summary: text }),
                    job.seconds ?? writerLease,
                  ),
                ),
              );
              for (const [i, result] of patches.entries()) {
                check();
                const before = draft.tree();
                if (result.status === "rejected") {
                  writerReports.push({
                    assignment: batch[i],
                    error: message(result.reason),
                  });
                  continue;
                }
                draft.applyWriter(result.value.patch, batch[i].files);
                writerReports.push({
                  assignment: batch[i],
                  summary: result.value.summary,
                  from: before,
                  to: draft.tree(),
                });
              }
              if (patches.some((result) => result.status === "rejected")) {
                throw new Error(
                  "A writer assignment did not finish. Inspect writerReports and replan unfinished work against the current draft.",
                );
              }
            }
          }
          check();
          const candidate = draft.tree();
          const scope =
            " Inspect git diff " +
            draft.base +
            " " +
            candidate +
            " and each writer's from/to diff. Consider the orchestrator's rationale and counterarguments. Return your verdict with specific evidence.";
          const reviews = await collective([
            ...Object.entries(reviewers).map(([role, instructions]) =>
              turn(role, instructions + scope, verdict),
            ),
            turn("product-owner", owner + scope, verdict),
          ]);
          lastReview = Object.fromEntries(
            [...Object.keys(reviewers), "product-owner"].map((r, i) => [
              r,
              reviews[i],
            ]),
          );
          acceptedTree = reviews.every((r) => r.approved) ? candidate : "";
        } catch (error) {
          check();
          acceptedTree = "";
          lastReview = { blocker: message(error) };
          log("supervisor", message(error));
        }
      }
    } catch (error) {
      await locked(control, ".control.lock", () =>
        finish(abort.signal.aborted ? "stopped" : "failed", message(error)),
      );
      throw error;
    } finally {
      clearInterval(timer);
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
      abort.abort();
    }
  });
}
