import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findExecutable, setupDependencies } from "./dependencies.js";
import { installRl } from "./install.js";
import { explicitHelp } from "./help.js";

const argv = process.argv.slice(2);
const selected =
  argv[0] === "--repo"
    ? argv.slice(2)
    : argv[0]?.startsWith("--repo=")
      ? argv.slice(1)
      : argv;
if (
  selected[0] === "setup" &&
  ["dependencies", "install"].includes(selected[1])
) {
  try {
    if (selected.includes("--help") || selected.includes("-h"))
      console.log(explicitHelp(selected));
    else
      process.exitCode =
        selected[1] === "install"
          ? await installRl(selected.slice(2))
          : await setupDependencies(selected.slice(2));
  } catch (error) {
    console.error(
      `rl: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
} else if (argv[0] === "--version" || argv[0] === "-V") {
  console.log(
    JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version,
  );
} else {
  const zsh = findExecutable("zsh");
  if (!zsh) {
    console.error(
      "rl: zsh is required. Run 'rl setup dependencies' to install the RL toolchain.",
    );
    process.exitCode = 1;
  } else {
    const child = spawn(
      zsh,
      [
        "-f",
        fileURLToPath(new URL("../lib/entry.zsh", import.meta.url)),
        ...argv,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          PATH: `${process.env.PATH ? process.env.PATH + path.delimiter : ""}${path.dirname(process.execPath)}`,
        },
      },
    );
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      };
      child.on("error", (error) => {
        cleanup();
        console.error(`rl: ${error.message}`);
        process.exitCode = 1;
        resolve();
      });
      child.on("close", (code, signal) => {
        cleanup();
        process.exitCode =
          code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
        resolve();
      });
    });
  }
}
