import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { execute } from "./common.js";
import { findExecutable } from "./dependencies.js";
import type { Scope } from "./review-analysis.js";
import { diffArgs } from "./review-git.js";
import { sanitizeTerminalText } from "./tui/ansi.js";
import { runFzf } from "./tui/fzf.js";

export const visible = (value: string): string => sanitizeTerminalText(value);

export async function choose(
  rows: { id: string; text: string }[],
  root: string,
  prompt: string,
  header: string,
  keys: string[] = [],
): Promise<{ id: string; key: string } | undefined> {
  if (rows.length === 0) {
    return undefined;
  }

  const picked = await runFzf(
    rows.map((row) => ({
      id: row.id,
      line: sanitizeTerminalText(row.text),
      value: row.id,
    })),
    {
      cwd: root,
      prompt: `${prompt} › `,
      header,
      expectKeys: keys,
      heightPercent: 80,
      missingHint:
        "fzf is unavailable. Run rl setup dependencies, or use rl review --json and explicit review options.",
      errorLabel: "Review selector",
      unknownNoun: "action",
    },
  );

  if (!picked) {
    return undefined;
  }
  return { id: picked.items[0], key: picked.key || "enter" };
}

export function page(text: string, root: string): void {
  const less = process.stdout.isTTY ? findExecutable("less") : null;
  if (!less) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  const result = spawnSync(less, ["-R"], {
    cwd: root,
    input: text,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
}

export async function browseDiff(root: string, scopes: Scope[]): Promise<void> {
  for (const scope of scopes) {
    console.log(`\n${scope.name}\n${scope.from} → ${scope.to}\n`);
    const result = await execute(
      [
        "git",
        process.stdout.isTTY ? "--paginate" : "--no-pager",
        ...diffArgs(scope.from, scope.to),
      ],
      root,
      { interactive: true },
    );
    if (result.code !== 0) {
      throw new Error(`Git diff viewer failed (${result.code})`);
    }
  }
}

/** Tokenizes a trusted editor setting without shell interpolation or expansion. */
export function commandWords(setting: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let escape = false;
  let started = false;

  for (const char of setting) {
    if (escape) {
      word += char;
      escape = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      escape = true;
    } else if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        word += char;
      }
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }

  if (quote || escape) {
    throw new Error("Unclosed quoting in editor setting");
  }
  if (started) {
    words.push(word);
  }
  if (words.length === 0) {
    throw new Error("No editor configured");
  }
  return words;
}

export async function editText(file: string, root: string): Promise<string> {
  const editor = commandWords(process.env.VISUAL ?? process.env.EDITOR ?? "vi");
  const result = await execute([...editor, file], root, { interactive: true });
  if (result.code !== 0) {
    throw new Error(
      `Editor failed (${result.code}); draft retained at ${file}`,
    );
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64000) {
    throw new Error("Feedback must be a regular UTF-8 text file up to 64 KiB");
  }
  return fs.readFileSync(file, "utf8");
}
