import path from "node:path";
import { visible } from "./review-terminal.js";
import { isReviewTestPath } from "./review-live-files.js";

export interface RepoGrepHit {
  path: string;
  line: number; // 1-based line number
  text: string;
}

export type DefinitionKind =
  | "exported"
  | "declaration"
  | "method"
  | "destructuring"
  | "property"
  | "param"
  | "assignment"
  | "reference";

export interface DefinitionCandidate {
  path: string;
  line: number; // 1-based line number
  preview: string;
  kind: DefinitionKind;
  score: number;
}

export interface DefinitionSearchResult {
  symbol: string;
  definitions: DefinitionCandidate[];
  references: DefinitionCandidate[];
  autoJump: boolean;
}

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "chan",
  "class",
  "const",
  "continue",
  "default",
  "def",
  "defer",
  "delete",
  "do",
  "elif",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "False",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "go",
  "if",
  "impl",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "match",
  "mod",
  "new",
  "None",
  "null",
  "of",
  "package",
  "pass",
  "private",
  "protected",
  "pub",
  "public",
  "readonly",
  "return",
  "select",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "trait",
  "true",
  "True",
  "try",
  "type",
  "typeof",
  "undefined",
  "use",
  "var",
  "void",
  "while",
  "yield",
]);

function charWidth(c: string): number {
  const n = c.codePointAt(0)!;
  return /\p{Mark}/u.test(c)
    ? 0
    : n >= 0x1100 &&
        (n <= 0x115f ||
          (n >= 0x2e80 && n <= 0xa4cf) ||
          (n >= 0xac00 && n <= 0xd7a3) ||
          (n >= 0xf900 && n <= 0xfaff) ||
          (n >= 0xfe10 && n <= 0xfe6f) ||
          (n >= 0xff00 && n <= 0xff60) ||
          n >= 0x1f300)
      ? 2
      : 1;
}

function isIdentChar(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z0-9_$]/.test(ch));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the identifier under a display column (tabs expanded to 4 spaces,
 * matching `reviewTextColumn`). Returns undefined on whitespace, punctuation,
 * numbers, diff headers, or reserved keywords.
 */
export function symbolAtColumn(
  lineText: string,
  column: number,
  stripDiffPrefix = false,
): string | undefined {
  if (!lineText) return undefined;
  if (
    stripDiffPrefix &&
    /^(?:diff --git |@@ |--- |\+\+\+ |index |new file|deleted file)/.test(
      lineText,
    )
  ) {
    return undefined;
  }
  const expanded = visible(lineText.replaceAll("\t", "    "));
  const chars = Array.from(expanded);
  const minIndex =
    stripDiffPrefix &&
    (chars[0] === "+" || chars[0] === "-" || chars[0] === " ")
      ? 1
      : 0;

  let col = 0;
  let targetIndex = -1;
  for (let i = 0; i < chars.length; i++) {
    const w = charWidth(chars[i]);
    if (w > 0 && column >= col && column < col + w) {
      targetIndex = i;
      break;
    }
    col += w;
  }
  if (targetIndex < minIndex) return undefined;
  if (!isIdentChar(chars[targetIndex])) {
    // Allow clicking immediately after the last character of an identifier.
    if (targetIndex > minIndex && isIdentChar(chars[targetIndex - 1])) {
      targetIndex -= 1;
    } else {
      return undefined;
    }
  }

  let left = targetIndex;
  while (left > minIndex && isIdentChar(chars[left - 1])) left--;
  let right = targetIndex + 1;
  while (right < chars.length && isIdentChar(chars[right])) right++;

  const word = chars.slice(left, right).join("");
  if (!word || /^\d+$/.test(word) || KEYWORDS.has(word)) return undefined;
  return word;
}

export function extractIdentifier(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(trimmed);
  if (!match) return undefined;
  const word = match[0];
  return KEYWORDS.has(word) ? undefined : word;
}

/** Parse `git grep -z -n ... <target>` output (`<target>:<path>\0<line>\0<text>\n`). */
export function parseGitGrep(raw: string, target: string): RepoGrepHit[] {
  if (!raw) return [];
  const prefix = `${target}:`;
  const hits: RepoGrepHit[] = [];
  for (const record of raw.split("\n")) {
    if (!record) continue;
    const firstNul = record.indexOf("\0");
    if (firstNul < 0) continue;
    const secondNul = record.indexOf("\0", firstNul + 1);
    if (secondNul < 0) continue;
    const rawPath = record.slice(0, firstNul);
    const filePath = rawPath.startsWith(prefix)
      ? rawPath.slice(prefix.length)
      : rawPath;
    const line = Number(record.slice(firstNul + 1, secondNul));
    if (!filePath || !Number.isInteger(line) || line < 1) continue;
    hits.push({
      path: filePath,
      line,
      text: record.slice(secondNul + 1),
    });
  }
  return hits;
}

export function extractImportSpecifiers(
  sourceText: string,
  symbol: string,
): { all: string[]; matched: string[] } {
  const all = new Set<string>();
  const matched = new Set<string>();
  const symPattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`);

  // JS/TS import/export ... from "..." (including multi-line import blocks)
  const jsFrom =
    /(?:import|export)\s+([\s\S]{0,600}?)\s+from\s+["']([^"']+)["']/g;
  for (const match of sourceText.matchAll(jsFrom)) {
    const clause = match[1];
    const spec = match[2];
    all.add(spec);
    if (symPattern.test(clause)) matched.add(spec);
  }

  // CommonJS require("...")
  const cjsRequire = /([^\n;]{0,200})require\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of sourceText.matchAll(cjsRequire)) {
    const lhs = match[1];
    const spec = match[2];
    all.add(spec);
    if (symPattern.test(lhs)) matched.add(spec);
  }

  // Python `from foo.bar import baz`
  const pyFrom = /^\s*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm;
  for (const match of sourceText.matchAll(pyFrom)) {
    const spec = match[1];
    const names = match[2];
    all.add(spec);
    if (symPattern.test(names)) matched.add(spec);
  }

  return { all: [...all], matched: [...matched] };
}

export function matchesImportSpecifier(
  candidatePath: string,
  currentPath: string,
  specifier: string,
): boolean {
  const normalizedCandidate = candidatePath.replaceAll("\\", "/");
  const withoutExt = normalizedCandidate.replace(
    /\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kt|cs|c|cc|cpp|h|hpp)$/,
    "",
  );
  const withoutIndex = withoutExt.replace(/\/index$/, "");

  if (specifier.startsWith(".")) {
    // Handle TS/ESM relative paths like `./review-tree.js` -> `src/review-tree.ts`
    const currentDir = path.posix.dirname(currentPath.replaceAll("\\", "/"));
    const cleanSpec = specifier.replace(/\.(?:[cm]?[jt]sx?)$/, "");
    const resolved = path.posix.normalize(
      currentDir === "." ? cleanSpec : `${currentDir}/${cleanSpec}`,
    );
    return (
      normalizedCandidate === resolved ||
      withoutExt === resolved ||
      withoutIndex === resolved
    );
  }

  // Non-relative module paths (Python `pkg.mod`, TS path alias `@/foo/bar`, etc.)
  const cleanSpec = specifier
    .replace(/^[@~]\//, "")
    .replace(/\.(?:[cm]?[jt]sx?)$/, "")
    .replaceAll(".", "/");
  if (!cleanSpec || cleanSpec.length < 2) return false;
  return (
    withoutExt === cleanSpec ||
    withoutExt.endsWith(`/${cleanSpec}`) ||
    withoutIndex === cleanSpec ||
    withoutIndex.endsWith(`/${cleanSpec}`)
  );
}

function isCommentOnlyLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("--")
  );
}

export function classifyDefinition(
  lineText: string,
  symbol: string,
  options: { isSameFile: boolean; line: number; originLine?: number },
): { kind: DefinitionKind; score: number } | undefined {
  const trimmed = lineText.trim();
  if (!trimmed || isCommentOnlyLine(trimmed)) return undefined;
  const sym = escapeRegex(symbol);

  // Skip import lines from being treated as definitions.
  if (
    /^(?:import\b|from\s+[.\w]+\s+import\b|use\s+|#include\b)/.test(trimmed) ||
    new RegExp(`^export\\s+\\{[^}]*\\b${sym}\\b[^}]*\\}\\s+from\\b`).test(
      trimmed,
    )
  ) {
    return undefined;
  }

  // 1. Exported / public primary declaration (TS/JS/Rust)
  if (
    new RegExp(
      `^(?:export\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|interface|type|enum|namespace|module|const|let|var)|pub(?:\\([^)]*\\))?\\s+(?:async\\s+)?(?:fn|struct|enum|trait|type|const|static|mod))\\s+${sym}\\b`,
    ).test(trimmed)
  ) {
    return { kind: "exported", score: 100 };
  }

  // 2. Standard keyword declaration (TS/JS/Python/Rust/Go/Kotlin/Swift/etc.)
  if (
    new RegExp(
      `^(?:(?:declare|abstract|async|static|override|final|local|my|our)\\s+)*(?:function\\s*\\*?|class|interface|type|enum|namespace|module|const|let|var|def|fn|struct|trait|func|val|fun|protocol|record|macro|sub|proc)\\s+${sym}\\b`,
    ).test(trimmed) ||
    // Go receiver method: `func (r *Repo) Symbol(`
    new RegExp(`^func\\s*\\([^)]*\\)\\s*${sym}\\s*\\(`).test(trimmed) ||
    // Go short variable declaration: `symbol :=`
    new RegExp(`(?:^|[,\\s])${sym}\\s*:=`).test(trimmed)
  ) {
    return { kind: "declaration", score: 90 };
  }

  // 3. Class / object method definition: `async symbol(args) {`
  if (
    new RegExp(
      `^(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\\s+)*\\*?${sym}\\s*(?:<[^>{;]*>)?\\s*\\([^)]*\\)\\s*(?::[^{;]+)?\\{`,
    ).test(trimmed)
  ) {
    return { kind: "method", score: 85 };
  }

  // 4. Destructuring / multi-var declaration on const/let/var line
  if (
    new RegExp(
      `^(?:export\\s+)?(?:const|let|var)\\s+[^;=]*\\b${sym}\\b[^;=]*(?:=|:|;|,)`,
    ).test(trimmed)
  ) {
    return { kind: "destructuring", score: 80 };
  }

  // 5. Class field / interface property / object literal property
  if (
    !trimmed.startsWith("case ") &&
    new RegExp(
      `^(?:(?:public|private|protected|static|readonly|override|abstract)\\s+)*${sym}\\s*\\??\\s*:\\s*[^:]`,
    ).test(trimmed)
  ) {
    return { kind: "property", score: 75 };
  }

  // 6. Parameter in the same file (above or at origin)
  if (
    options.isSameFile &&
    (options.originLine === undefined || options.line <= options.originLine) &&
    (new RegExp(
      `(?:^|[(,])\\s*(?:(?:readonly|public|private|protected)\\s+)*(?:\\.\\.\\.)?${sym}\\s*\\??\\s*:`,
    ).test(trimmed) ||
      new RegExp(
        `(?:function\\b|=>|\\)\\s*\\{)[^\\n]*[(,]\\s*(?:\\.\\.\\.)?${sym}\\b`,
      ).test(trimmed) ||
      new RegExp(
        `[(,]\\s*(?:(?:readonly|public|private|protected)\\s+)*(?:\\.\\.\\.)?${sym}\\s*=`,
      ).test(trimmed))
  ) {
    return { kind: "param", score: 70 };
  }

  // 7. Standalone assignment / multi-line let/var item (`symbol = value`, `symbol: Type = value`)
  if (
    new RegExp(`^${sym}\\s*(?::\\s*[^=]+)?=\\s*[^=>]`).test(trimmed) &&
    !/^(?:return|if|while|for|assert|expect)\b/.test(trimmed)
  ) {
    return { kind: "assignment", score: 65 };
  }

  // 8. C/Java/C# typed declaration: `public static Foo symbol(` or `int symbol =`
  if (
    new RegExp(
      `^(?:(?:public|private|protected|static|final|const|virtual|inline|extern|override|async|readonly)\\s+)+[\\w<>\\[\\]*&:,\\.\\s]+\\b${sym}\\s*(?:\\(|=|;|\\{)`,
    ).test(trimmed)
  ) {
    return { kind: "declaration", score: 85 };
  }

  return { kind: "reference", score: 10 };
}

export function rankDefinitions(
  repoHits: readonly RepoGrepHit[],
  symbol: string,
  options: {
    currentPath?: string;
    currentLine?: number;
    currentFileText?: string;
  } = {},
): DefinitionSearchResult {
  const { currentPath, currentLine, currentFileText } = options;
  const imports = currentFileText
    ? extractImportSpecifiers(currentFileText, symbol)
    : { all: [], matched: [] };

  const dedup = new Map<string, RepoGrepHit>();
  for (const hit of repoHits) {
    dedup.set(`${hit.path}\0${hit.line}`, hit);
  }

  // Always scan the current file in full so local definitions are never missed.
  if (currentPath && currentFileText) {
    const wordRe = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
    const lines = currentFileText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (wordRe.test(lines[i])) {
        const lineNo = i + 1;
        dedup.set(`${currentPath}\0${lineNo}`, {
          path: currentPath,
          line: lineNo,
          text: lines[i],
        });
      }
    }
  }

  const definitions: DefinitionCandidate[] = [];
  const references: DefinitionCandidate[] = [];

  for (const hit of dedup.values()) {
    const isSameFile = Boolean(currentPath && hit.path === currentPath);
    const isOriginLine = Boolean(
      isSameFile && currentLine !== undefined && hit.line === currentLine,
    );
    const classified = classifyDefinition(hit.text, symbol, {
      isSameFile,
      line: hit.line,
      originLine: currentLine,
    });
    const preview = hit.text.trim().slice(0, 200);
    if (!classified) {
      if (!isOriginLine) {
        references.push({
          path: hit.path,
          line: hit.line,
          preview,
          kind: "reference",
          score: 5,
        });
      }
      continue;
    }

    let score = classified.score;
    if (currentPath && !isSameFile) {
      if (
        imports.matched.some((spec) =>
          matchesImportSpecifier(hit.path, currentPath, spec),
        )
      ) {
        score += 45;
      } else if (
        imports.all.some((spec) =>
          matchesImportSpecifier(hit.path, currentPath, spec),
        )
      ) {
        score += 25;
      }
    }
    if (isSameFile) {
      if (currentLine !== undefined && hit.line < currentLine) score += 35;
      else if (currentLine !== undefined && hit.line > currentLine) score += 20;
      else score += 25;
    }
    if (!isReviewTestPath(hit.path)) score += 10;

    const candidate: DefinitionCandidate = {
      path: hit.path,
      line: hit.line,
      preview,
      kind: classified.kind,
      score,
    };

    if (classified.score >= 60) {
      // If user Ctrl-clicked right on a definition, still keep other definitions
      // and demote/omit the exact same line unless it's the only match.
      if (!isOriginLine) definitions.push(candidate);
    } else if (!isOriginLine) {
      references.push(candidate);
    }
  }

  const sortCandidates = (a: DefinitionCandidate, b: DefinitionCandidate) =>
    b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line;

  const sortedDefs = definitions.toSorted(sortCandidates).slice(0, 60);
  const sortedRefs = references.toSorted(sortCandidates).slice(0, 100);

  const autoJump =
    sortedDefs.length === 1 ||
    (sortedDefs.length > 1 && sortedDefs[0].score >= sortedDefs[1].score + 20);

  return {
    symbol,
    definitions: sortedDefs,
    references: sortedRefs,
    autoJump,
  };
}
