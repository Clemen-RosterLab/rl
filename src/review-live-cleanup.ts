import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execute } from "./common.js";

// Retry only this review process's private refs after terminal handoff. A busy
// disk must not force a choice between a stuck terminal and abandoned refs.
const [gitDir, id, temporaryRoot] = process.argv.slice(2);
if (gitDir && /^[a-f0-9-]{36}$/.test(id ?? "")) {
  const prefix = `refs/rl/live-freeze/${id}/`;
  const command = [
    "git",
    `--git-dir=${gitDir}`,
    "-c",
    "core.hooksPath=/dev/null",
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const options = { timeoutMs: 5000, processGroup: true, abortGraceMs: 0 };
      const refs = await execute(
        [...command, "for-each-ref", "--format=%(refname)", prefix],
        os.tmpdir(),
        options,
      );
      if (refs.code) continue;
      const names = refs.stdout
        .split("\n")
        .filter((ref) => ref.startsWith(prefix));
      if (!names.length) break;
      const deleted = await execute(
        [...command, "update-ref", "--stdin"],
        os.tmpdir(),
        { ...options, input: names.map((ref) => `delete ${ref}\n`).join("") },
      );
      if (!deleted.code) break;
    } catch {
      /* Missing worktree metadata needs no remaining private cleanup. */
    }
  }
}

// This directory was created exclusively for this review. Validate the parent
// and refuse symlinks before removing it; never touch a worktree or saved review.
if (temporaryRoot && /^[a-f0-9-]{36}$/.test(id ?? "")) {
  try {
    if (
      path.basename(temporaryRoot).startsWith("rl-review-live-") &&
      fs.realpathSync(path.dirname(temporaryRoot)) ===
        fs.realpathSync(os.tmpdir()) &&
      !fs.lstatSync(temporaryRoot).isSymbolicLink()
    ) {
      await fs.promises.rm(temporaryRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  } catch {
    // The worker may already have removed its directory after finishing a save.
  }
}
