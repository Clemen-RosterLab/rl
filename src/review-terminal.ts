import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { execute } from "./common.js";
import { findExecutable } from "./dependencies.js";
import { diffArgs } from "./review-git.js";
import type { Scope } from "./review-analysis.js";

export const visible = (value: string) =>
  stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export async function choose(
  rows: { id: string; text: string }[],
  root: string,
  prompt: string,
  header: string,
  keys: string[] = [],
): Promise<{ id: string; key: string } | undefined> {
  if (!rows.length) return undefined;
  if (!findExecutable("fzf"))
    throw new Error(
      "fzf is unavailable. Run rl setup dependencies, or use rl review --json and explicit review options.",
    );
  const lines = rows.map((row) => `${row.id}\t${visible(row.text)}`);
  const result = await execute(
    [
      "fzf",
      "--delimiter=\t",
      "--with-nth=2..",
      "--no-multi",
      "--no-sort",
      "--height=80%",
      "--border=rounded",
      "--reverse",
      `--prompt=${prompt} › `,
      `--header=${header}`,
      ...(keys.length ? [`--expect=${["enter", ...keys].join(",")}`] : []),
    ],
    root,
    { input: lines.join("\n") + "\n", terminalError: true },
  );
  if ([1, 130].includes(result.code)) return undefined;
  if (result.code) throw new Error(`Review selector failed (${result.code})`);
  const output = result.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
  const key = keys.length ? (output.shift() ?? "enter") : "enter";
  const line = output.join("\n"),
    row = rows.find((row, index) => line === lines[index] || line === row.id);
  if (!row || (key && key !== "enter" && !keys.includes(key)))
    throw new Error("Review selector returned an unknown action");
  return { id: row.id, key: key || "enter" };
}
export function page(text: string, root: string): void {
  const less = process.stdout.isTTY ? findExecutable("less") : null;
  if (!less) {
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    return;
  }
  const result = spawnSync(less, ["-R"], {
    cwd: root,
    input: text,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
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
    if (result.code) throw new Error(`Git diff viewer failed (${result.code})`);
  }
}
/** Tokenizes a trusted editor setting without shell interpolation or expansion. */
export function commandWords(setting: string): string[] {
  const words: string[] = [];
  let word = "",
    quote = "",
    escape = false,
    started = false;
  for (const char of setting) {
    if (escape) {
      word += char;
      escape = false;
      started = true;
    } else if (char === "\\" && quote !== "'") escape = true;
    else if (quote) {
      if (char === quote) quote = "";
      else word += char;
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
  if (quote || escape) throw new Error("Unclosed quoting in editor setting");
  if (started) words.push(word);
  if (!words.length) throw new Error("No editor configured");
  return words;
}
export async function editText(file: string, root: string): Promise<string> {
  const editor = commandWords(process.env.VISUAL ?? process.env.EDITOR ?? "vi");
  const result = await execute([...editor, file], root, { interactive: true });
  if (result.code)
    throw new Error(
      `Editor failed (${result.code}); draft retained at ${file}`,
    );
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64000)
    throw new Error("Feedback must be a regular UTF-8 text file up to 64 KiB");
  return fs.readFileSync(file, "utf8");
}
