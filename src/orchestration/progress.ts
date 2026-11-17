import type { WorkflowRun } from "../agent-runner.js";
import { sanitizeTerminalText } from "../tui/ansi.js";
import { agentState } from "./status.js";

const clean = (value: string) =>
  sanitizeTerminalText(value).replace(/\s+/g, " ").slice(0, 600);

/** Observe recorded milestones without invoking Git or claiming process liveness. */
export class WorkflowProgress {
  private previous = new Map<string, string>();
  private lastOutput?: number;

  update(run: WorkflowRun, at = Date.now(), idleMs = 30000): string[] {
    const entries = new Map<string, string>();
    entries.set(
      "run",
      `Workflow ${run.id} · ${run.quality?.level ?? run.workflow} · ${run.status.toUpperCase()}`,
    );
    for (const stage of run.stages) {
      const view = agentState(run, stage, at);
      entries.set(
        `stage:${stage.id}:${stage.claim ?? stage.attempts}`,
        `${stage.id} · ${view.state.toUpperCase()} · ${stage.status !== "running" && stage.status !== "pending" ? stage.error || stage.result?.summary || view.detail || "No progress reported" : view.detail || "No progress reported"}`,
      );
    }
    const research = run.quality?.research;
    if (research) {
      for (const approach of research.brief.approaches) {
        entries.set(
          `research:${approach.id}`,
          `Research candidate ${approach.id} · ${approach.title} · ${approach.viability}`,
        );
      }
      entries.set(
        "recommendation",
        `Research recommends ${research.brief.recommendation}; ${research.brief.uncertainties.length} unresolved questions`,
      );
      entries.set(
        "decision",
        research.decision
          ? `Approach selected: ${research.decision.approach} · ${research.decision.rationale}`
          : "Research awaits the coordinator's approach decision",
      );
    }
    const capture = run.quality?.capture;
    if (capture)
      entries.set(
        `capture:${capture.id}`,
        `Validation ${capture.check} · RUNNING · ${capture.mode}`,
      );
    for (const receipt of run.quality?.receipts ?? []) {
      entries.set(
        `receipt:${receipt.id}`,
        `Validation ${receipt.check ?? receipt.criteria.join(", ")} · exit ${receipt.exitCode} · ${receipt.source} · ${receipt.mode}${receipt.invalidated ? " · INVALIDATED" : ""}`,
      );
    }
    if (run.evaluation)
      entries.set(
        "evaluation",
        `Recorded review verdict: ${run.evaluation.verdict}`,
      );
    const lines: string[] = [];
    for (const [key, message] of entries) {
      if (this.previous.get(key) !== message) lines.push(clean(message));
    }
    this.previous = entries;
    if (!lines.length && at - (this.lastOutput ?? at) >= idleMs) {
      const active = run.stages.filter((stage) => stage.status === "running");
      lines.push(
        active.length
          ? `Waiting for new reported progress · ${active.map((stage) => `${clean(stage.id)}: last heartbeat ${stage.heartbeatAt ? Math.max(0, Math.floor((at - Date.parse(stage.heartbeatAt)) / 1000)) + "s ago" : "not recorded"}`).join(", ")} · native process liveness unverified`
          : "Waiting for the native coordinator · no active claims; RL does not launch agents",
      );
    }
    if (lines.length) this.lastOutput = at;
    return lines.map((line) => `[${new Date(at).toISOString()}] ${line}`);
  }
}

/** Plain output works in a second terminal or a pipe; closing it never cancels a run. */
export async function followWorkflowProgress(
  load: () => WorkflowRun,
  options: {
    write?: (line: string) => void;
    signal?: AbortSignal;
    intervalMs?: number;
    idleMs?: number;
  } = {},
): Promise<void> {
  const reporter = new WorkflowProgress();
  const write =
    options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const finish = (error?: unknown) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      options.signal?.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve();
    };
    const stop = () => finish();
    const poll = () => {
      try {
        const run = load();
        for (const line of reporter.update(run, Date.now(), options.idleMs))
          write(line);
        if (run.status !== "running") finish();
      } catch (error) {
        finish(error);
      }
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) return finish();
    poll();
    if (!closed) timer = setInterval(poll, options.intervalMs ?? 1000);
  });
}
