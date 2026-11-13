import fs from "node:fs";

const EMERGENCY_RESTORE_SEQUENCE =
  "\x1b[0m\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[?1049l";

/**
 * Registers a synchronous process-exit safety net while the live TUI owns the
 * terminal so uncaught timer/stream errors never strand raw/mouse/alt-screen modes
 * or leave detached Git workers orphaned.
 */
export function installTerminalCrashGuard(options: {
  restoreTerminalSettings: () => void;
  getWorkerPid: () => number | undefined;
}): () => void {
  let disarmed = false;

  const onProcessExit = () => {
    if (disarmed) {
      return;
    }
    disarmed = true;

    const pid = options.getWorkerPid();
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Worker process group has already exited.
      }
    }

    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    } catch {
      // Ignore if stdin was already closed.
    }

    try {
      options.restoreTerminalSettings();
    } catch {
      // Best-effort stty restore.
    }

    try {
      fs.writeSync(1, EMERGENCY_RESTORE_SEQUENCE);
    } catch {
      // Ignore if stdout fd is already closed.
    }
  };

  process.once("exit", onProcessExit);

  return () => {
    disarmed = true;
    process.off("exit", onProcessExit);
  };
}
