import os from "node:os";
import { execute } from "./common.js";

// Retry only this review process's private refs after terminal handoff. A busy
// disk must not force a choice between a stuck terminal and abandoned refs.
const [gitDir, id] = process.argv.slice(2);
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
