import {
  sanitizeTerminalText,
  iterateGraphemes,
  graphemeWidth,
} from "../tui/ansi.js";
import { installTerminalCrashGuard } from "../review/terminal-guard.js";
import { oriented, reviewerStage } from "./governance.js";
import type { WorkflowRun, Stage } from "../agent-runner.js";

export function agentState(run: WorkflowRun, stage: Stage, at = Date.now()) {
  const waitingOn: string[] = [];
  let state: string = stage.status,
    detail = stage.progress ?? stage.error ?? "";
  const config = run.config.workflows[run.workflow].collaboration;
  const started = stage.startedAt ? Date.parse(stage.startedAt) : undefined;
  const idle = stage.heartbeatAt
    ? Math.max(0, at - Date.parse(stage.heartbeatAt))
    : undefined;
  const elapsed =
    stage.status === "running" && started
      ? Math.max(0, at - started)
      : stage.durationMs;
  if (stage.status === "pending") {
    waitingOn.push(
      ...stage.after.filter(
        (dep) => run.stages.find((s) => s.id === dep)?.status !== "completed",
      ),
    );
    if (
      !waitingOn.length &&
      !run.quality?.governance?.assessment &&
      run.quality?.governance
    )
      waitingOn.push("effort assessment");
    if (!waitingOn.length && run.quality && !run.quality.capabilities)
      waitingOn.push("host preflight");
    if (
      !waitingOn.length &&
      stage.agent &&
      run.config.agents[stage.agent].access === "workspace-write" &&
      run.quality?.research &&
      !run.quality.research.decision
    )
      waitingOn.push("approach decision");
    if (!waitingOn.length && run.status !== "running")
      waitingOn.push(`run ${run.status}`);
    state = waitingOn.length ? "waiting" : "ready";
    detail = waitingOn.length
      ? `Waiting for ${waitingOn.join(", ")}`
      : "Ready for coordinator claim";
  } else if (stage.status === "running") {
    if (
      (idle ?? 0) >
        Math.min(
          run.config.workflows[run.workflow].timeoutSeconds * 1000,
          300000,
        ) ||
      elapsed > run.config.workflows[run.workflow].timeoutSeconds * 1000
    ) {
      state = "stalled";
      detail =
        "No current progress / deadline exceeded; host must confirm whether child is alive";
    } else if (!stage.childId && (config || stage.agent === "researcher")) {
      state = "starting";
      waitingOn.push("native binding");
    } else if (reviewerStage(run, stage) && !oriented(run, stage)) {
      state = "first pass";
      detail = detail || "Inspecting requirements and source independently";
    } else if (config && stage.id === config.reviewer) {
      const pending =
        run.collaboration?.submissions.filter(
          (s) => !s.supersededBy && !s.review,
        ) ?? [];
      state = pending.length ? "reviewing" : "waiting";
      if (!pending.length) waitingOn.push("writer checkpoint");
      detail = detail || `${pending.length} checkpoints awaiting review`;
    } else if (
      config &&
      stage.id === config.writer &&
      run.collaboration?.submissions.some((s) => !s.supersededBy && !s.review)
    ) {
      state = "awaiting review";
      waitingOn.push("reviewer");
      detail =
        detail || "Submitted files are frozen; unrelated work may continue";
    } else if (config && stage.id === config.dry) {
      const pending =
        run.collaboration?.consultations.filter(
          (c) => c.to === stage.id && !c.answer,
        ) ?? [];
      state = pending.length ? "researching" : "waiting";
      if (!pending.length) waitingOn.push("consultation");
    } else state = stage.agent === "researcher" ? "researching" : "working";
    if (run.status !== "running")
      detail = `Run ${run.status}; claim still open. ${detail}`;
  }
  return {
    state,
    detail,
    waitingOn,
    elapsedMs: elapsed,
    idleMs: idle ?? null,
    childId: stage.childId ?? null,
    stateSource:
      "RL claims and host-reported progress; native process liveness is unverified",
  };
}

export async function watchWorkflowStatus(
  load: () => WorkflowRun,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Live agent status requires a terminal; use rl workflow status --json for a snapshot",
    );
  const stdin = process.stdin,
    stdout = process.stdout,
    wasRaw = stdin.isRaw,
    wasFlowing = stdin.readableFlowing;
  const clean = (s: unknown) => sanitizeTerminalText(String(s ?? ""));
  const fit = (s: string, width: number) => {
    let used = 0,
      out = "";
    for (const cluster of iterateGraphemes(clean(s))) {
      used += graphemeWidth(cluster);
      if (used > width) break;
      out += cluster;
    }
    return out;
  };
  await new Promise<void>((resolve) => {
    let closed = false,
      offset = 0;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      stdin.off("data", onData);
      stdout.off("resize", draw);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      stdin.setRawMode(Boolean(wasRaw));
      if (wasFlowing !== true) stdin.pause();
      stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
      disarm();
      resolve();
    };
    const onData = (data: Buffer) => {
      const key = data.toString();
      if (["q", "Q", "\x03", "\x1b"].includes(key)) finish();
      else if (["j", "\x1b[B", "\x1b[6~"].includes(key)) {
        offset += 2;
        draw();
      } else if (["k", "\x1b[A", "\x1b[5~"].includes(key)) {
        offset = Math.max(0, offset - 2);
        draw();
      }
    };
    const draw = () => {
      if (closed) return;
      const width = Math.max(20, stdout.columns ?? 80),
        height = Math.max(6, stdout.rows ?? 24);
      let lines: string[];
      try {
        const run = load();
        lines = [
          `RL AGENTS · ${run.quality?.level ?? "legacy"} · ${run.status}`,
          `${run.workspace} · ${run.id}`,
          "",
          ...run.stages.flatMap((stage) => {
            const view = agentState(run, stage);
            return [
              `${stage.id.padEnd(14)} ${view.state.toUpperCase().padEnd(16)} ${Math.floor(view.elapsedMs / 1000)}s · idle ${view.idleMs === null ? "—" : Math.floor(view.idleMs / 1000) + "s"}`,
              `  ${view.detail || view.waitingOn.join(", ") || "No progress reported"}${view.childId ? ` · child ${view.childId}` : ""}`,
            ];
          }),
        ];
        if (run.quality?.capture)
          lines.push(
            `validation · RUNNING · ${run.quality.capture.check} · ${run.quality.capture.command.join(" ")}`,
          );
      } catch (cause) {
        lines = [
          "RL AGENTS · REFRESH UNAVAILABLE",
          cause instanceof Error ? cause.message : String(cause),
        ];
      }
      const header = lines.slice(0, 3),
        body = lines.slice(3);
      offset = Math.min(offset, Math.max(0, body.length - (height - 6)));
      lines = [...header, ...body.slice(offset, offset + height - 6)];
      lines.push(
        "",
        "Claims / heartbeats are recorded state; host liveness is unverified.",
        "j/k Scroll · q / Esc / Ctrl-C Close · refreshes every second",
      );
      stdout.write(
        "\x1b[H\x1b[2J" + lines.map((line) => fit(line, width)).join("\r\n"),
      );
    };
    const disarm = installTerminalCrashGuard({
      restoreTerminalSettings: () => stdin.setRawMode(Boolean(wasRaw)),
      getWorkerPid: () => undefined,
    });
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdout.on("resize", draw);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    stdout.write("\x1b[?1049h\x1b[?25l");
    draw();
    const timer = setInterval(draw, 1000);
  });
}
