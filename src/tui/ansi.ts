import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Strip ANSI/VT escape sequences and replace C0/C1 control characters with spaces
 * so untrusted branch names, PR titles, or paths stay on one safe terminal line.
 */
export function sanitizeTerminalText(
  value: unknown,
  options: { trim?: boolean } = {},
): string {
  const cleaned = stripVTControlCharacters(String(value ?? "")).replace(
    CONTROL_CHARS,
    " ",
  );
  return options.trim ? cleaned.trim() : cleaned;
}

export function stripAnsiSgr(value: string): string {
  return value.replace(ANSI_SGR, "");
}

export function supportsAnsiColor(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined || env.FORCE_COLOR === "0") {
    return false;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  return Boolean(stream.isTTY || env.FORCE_COLOR);
}

export function detectColorDepth(
  stream: {
    isTTY?: boolean;
    getColorDepth?: (env?: NodeJS.ProcessEnv) => number;
  } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): 1 | 4 | 8 | 24 {
  if (!supportsAnsiColor(stream, env)) {
    return 1;
  }
  if (env.FORCE_COLOR === "3") return 24;
  if (env.FORCE_COLOR === "2") return 8;
  if (env.FORCE_COLOR === "1") return 4;

  const colorTerm = (env.COLORTERM ?? "").toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") {
    return 24;
  }
  if (env.TERM_PROGRAM === "Apple_Terminal") {
    return 8;
  }
  if (typeof stream.getColorDepth === "function") {
    const depth = stream.getColorDepth(env);
    if (depth >= 24) return 24;
    if (depth >= 8) return 8;
    if (depth >= 4) return 4;
  }
  // Modern ANSI terminals default to truecolor unless constrained above.
  return 24;
}

export function paintAnsi(
  value: string,
  code: number,
  enabled = process.env.NO_COLOR === undefined,
): string {
  return enabled ? `\x1b[${code}m${value}\x1b[0m` : value;
}

export function formatHomePath(
  targetPath: string,
  home = os.homedir(),
): string {
  if (targetPath === home) {
    return "~";
  }
  if (targetPath.startsWith(home + path.sep)) {
    return "~" + targetPath.slice(home.length);
  }
  return targetPath;
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      codePoint >= 0x1f300)
  );
}

export function graphemeWidth(cluster: string): number {
  if (!cluster) return 0;
  const first = cluster.codePointAt(0);
  if (first === undefined) return 0;
  if (/\p{Mark}/u.test(cluster) && cluster.length === 1) {
    return 0;
  }
  if (/\p{Extended_Pictographic}/u.test(cluster)) {
    return 2;
  }
  return isWideCodePoint(first) ? 2 : 1;
}

export function iterateGraphemes(text: string): string[] {
  const clusters: string[] = [];
  for (const part of segmenter.segment(text)) {
    clusters.push(part.segment);
  }
  return clusters;
}

export function displayWidth(value: string): number {
  let total = 0;
  for (const cluster of iterateGraphemes(sanitizeTerminalText(value))) {
    total += graphemeWidth(cluster);
  }
  return total;
}

export function padCell(value: string, width: number): string {
  const clean = sanitizeTerminalText(value);
  if (width <= 0) return "";
  const clusters = iterateGraphemes(clean);
  let total = 0;
  for (const cluster of clusters) {
    total += graphemeWidth(cluster);
  }
  if (total <= width) {
    return clean + " ".repeat(width - total);
  }
  let truncated = "";
  let used = 0;
  const limit = Math.max(0, width - 1);
  for (const cluster of clusters) {
    const w = graphemeWidth(cluster);
    if (used + w > limit) break;
    truncated += cluster;
    used += w;
  }
  return truncated + "…" + " ".repeat(Math.max(0, width - used - 1));
}
