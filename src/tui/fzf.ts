import { execute, message } from "../common.js";
import { findExecutable } from "../dependencies.js";
import { RlError } from "../errors.js";
import { stripAnsiSgr } from "./ansi.js";

export interface FzfItem<T> {
  id: string;
  line: string;
  value: T;
}

export interface FzfOptions {
  cwd: string;
  prompt: string;
  header: string;
  multi?: boolean;
  ansi?: boolean;
  expectKeys?: readonly string[];
  heightPercent?: number;
  numericHeight?: boolean;
  missingHint?: string;
  errorLabel?: string;
  unknownNoun?: string;
}

export interface FzfResult<T> {
  key: string;
  items: T[];
}

export function computeNumericFzfHeight(
  rowCount: number,
  terminalRows = process.stderr.rows || 24,
): number {
  return Math.max(8, Math.min(rowCount + 7, Math.floor(terminalRows / 2)));
}

export async function runFzf<T>(
  rows: readonly FzfItem<T>[],
  options: FzfOptions,
): Promise<FzfResult<T> | null> {
  if (rows.length === 0) {
    return null;
  }

  if (options.missingHint && !findExecutable("fzf")) {
    throw new RlError(options.missingHint);
  }

  const heightArg = options.numericHeight
    ? `--height=${computeNumericFzfHeight(rows.length)}`
    : `--height=${options.heightPercent ?? 70}%`;

  const argv: string[] = ["fzf"];
  if (options.ansi) {
    argv.push("--ansi");
  }
  argv.push(
    "--delimiter=\t",
    "--with-nth=2..",
    `--prompt=${options.prompt}`,
    heightArg,
    "--border=rounded",
    "--info=inline",
    "--reverse",
    "--no-sort",
    `--header=${options.header}`,
  );

  if (options.multi) {
    argv.push("--multi", "--bind=ctrl-a:select-all,ctrl-d:deselect-all");
  } else {
    argv.push("--no-multi");
  }

  const expectKeys = options.expectKeys ?? [];
  if (expectKeys.length > 0) {
    argv.push(`--expect=${["enter", ...expectKeys].join(",")}`);
  }

  const formattedLines = rows.map((row) => `${row.id}\t${row.line}`);

  let result;
  try {
    result = await execute(argv, options.cwd, {
      input: formattedLines.join("\n") + "\n",
      terminalError: true,
    });
  } catch (error) {
    if (options.errorLabel) {
      throw new RlError(`${options.errorLabel}: ${message(error)}`, {
        cause: error,
      });
    }
    throw error;
  }

  if (result.code === 1 || result.code === 130) {
    return null;
  }
  if (result.code !== 0) {
    const label = options.errorLabel ?? "fzf";
    throw new RlError(`${label} failed (exit ${result.code})`);
  }

  const rawLines = result.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
  const key = expectKeys.length > 0 ? rawLines.shift() || "enter" : "enter";
  if (key !== "enter" && !expectKeys.includes(key)) {
    throw new RlError(
      `${options.errorLabel ?? "Picker"} returned an unknown action`,
    );
  }

  const selectedLines =
    expectKeys.length > 0 ? [rawLines.join("\n")] : rawLines.filter(Boolean);
  const matched: T[] = [];

  for (const selectedLine of selectedLines) {
    const plainSelected = stripAnsiSgr(selectedLine);
    const found = rows.find((row, index) => {
      const fullLine = formattedLines[index];
      return (
        fullLine === selectedLine ||
        stripAnsiSgr(fullLine) === plainSelected ||
        row.id === selectedLine ||
        fullLine.split("\t")[0] === selectedLine
      );
    });
    if (!found) {
      throw new RlError(
        `${options.errorLabel ?? "Picker"} returned an unknown ${options.unknownNoun ?? "selection"}`,
      );
    }
    matched.push(found.value);
  }

  if (!options.multi && matched.length > 1) {
    throw new RlError("Picker returned multiple selections");
  }

  return { key, items: matched };
}
