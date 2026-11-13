import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const staging = path.join(root, `.rl-dist-${randomUUID()}`);
const target = path.join(root, "dist");
const backup = `${staging}-previous`;
try {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      path.join(root, "tsconfig.json"),
      "--outDir",
      staging,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
