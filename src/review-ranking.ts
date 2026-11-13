import { reviewFileFingerprint } from "./review-progress.js";
import { reviewFileCategory } from "./review-live-files.js";
import type { LiveRepository, ReviewFile } from "./review-live-engine.js";

export interface ReviewRank {
  score: number;
  reason: string;
  kind: "syntax" | "heuristic" | "agent";
}
export type ReviewRanks = Record<string, ReviewRank>;
// TypeScript's optional compiler API is absent in production installs and in
// newer native compiler packages. Never make ranking depend on it.
interface SyntaxNode {
  kind: number;
  getText(source: SyntaxNode): string;
}
interface CompilerAPI {
  createScanner(
    target: number,
    skipTrivia: boolean,
    variant: number,
    text: string,
  ): { scan(): number; getTokenText(): string };
  createSourceFile(
    name: string,
    text: string,
    target: number,
    parents: boolean,
  ): SyntaxNode;
  forEachChild(node: SyntaxNode, visit: (child: SyntaxNode) => void): void;
  SyntaxKind: Record<string, number>;
  ScriptTarget: { Latest: number };
  LanguageVariant: { JSX: number };
}
let compiler: Promise<CompilerAPI | undefined> | undefined;
const ranks = new Map<string, ReviewRank>();
function tokenIdentity(ts: CompilerAPI, text: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.JSX,
    text,
  );
  const tokens: string[] = [];
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  )
    tokens.push(`${token}:${scanner.getTokenText()}`);
  return tokens.join("\0");
}
function syntaxRank(
  ts: CompilerAPI,
  before: string,
  after: string,
  name: string,
): ReviewRank {
  const control = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.SwitchStatement,
    ts.SyntaxKind.ConditionalExpression,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.ThrowStatement,
    ts.SyntaxKind.ReturnStatement,
    ts.SyntaxKind.AwaitExpression,
  ]);
  const declarations = new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.ClassDeclaration,
  ]);
  const collect = (text: string) => {
    const nodes = new Map<string, number>();
    const source = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: SyntaxNode) => {
      if (control.has(node.kind))
        nodes.set(
          `${node.kind}:${tokenIdentity(ts, node.getText(source))}`,
          18,
        );
      else if (declarations.has(node.kind))
        nodes.set(
          `${node.kind}:${tokenIdentity(ts, node.getText(source))}`,
          12,
        );
      else if (
        node.kind === ts.SyntaxKind.CallExpression ||
        node.kind === ts.SyntaxKind.BinaryExpression
      )
        nodes.set(`${node.kind}:${tokenIdentity(ts, node.getText(source))}`, 4);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return nodes;
  };
  const old = collect(before),
    next = collect(after);
  let score = 0,
    changes = 0;
  for (const [key, weight] of [...old, ...next])
    if (!old.has(key) || !next.has(key)) {
      score += weight;
      changes++;
    }
  const onlyLayout =
    !changes && tokenIdentity(ts, before) === tokenIdentity(ts, after);
  return {
    score: onlyLayout ? 0 : Math.max(2, score),
    reason: changes
      ? `${changes} changed control-flow, declaration or expression nodes`
      : onlyLayout
        ? "Formatting/comments only; reviewed syntax nodes unchanged"
        : "Imports or supporting syntax changes",
    kind: "syntax",
  };
}
export function heuristicReviewRank(patch: string): ReviewRank {
  const changed = patch
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^---|^\+\+\+/.test(line));
  const meaningful = changed
    .map((line) => line.slice(1))
    .filter((line) => line.trim() && !/^\s*(?:\/\/|\/\*|\*|#)/.test(line));
  const logic = meaningful.filter((line) =>
    /\b(?:if|else|switch|case|return|throw|await|for|while|validate|assert|transaction|update|delete|insert)\b|===|!==|=>/.test(
      line,
    ),
  ).length;
  return {
    score: logic * 10 + Math.min(20, meaningful.length),
    reason: `${logic} behavior-related lines; text heuristic, not semantic analysis`,
    kind: "heuristic",
  };
}
export async function rankReviewFiles(
  repository: LiveRepository,
  files: ReviewFile[],
): Promise<ReviewRanks> {
  compiler ??= import("typescript")
    .then((module) => {
      const api = module as unknown as CompilerAPI;
      return typeof api.createScanner === "function" &&
        typeof api.createSourceFile === "function"
        ? api
        : undefined;
    })
    .catch(() => undefined);
  const ts = await compiler;
  const result: ReviewRanks = {};
  for (const [index, file] of files.entries()) {
    const identity = reviewFileFingerprint(file);
    let rank = ranks.get(identity);
    if (!rank) {
      if (index >= 200 || file.binary)
        rank = {
          score: -1,
          reason: file.binary
            ? "Binary file"
            : "Outside the 200-file ranking budget",
          kind: "heuristic",
        };
      else {
        const patch = repository.patch(file).slice(0, 256000);
        if (ts && /\.[cm]?[jt]sx?$/i.test(file.path)) {
          const before = repository.content(file, "before", 256000),
            after = repository.content(file, "after", 256000);
          rank =
            !before.truncated && !after.truncated
              ? syntaxRank(ts, before.text, after.text, file.path)
              : heuristicReviewRank(patch);
        } else rank = heuristicReviewRank(patch);
        const category = reviewFileCategory(file.path);
        if (category)
          rank = {
            ...rank,
            score: rank.score * 0.1,
            reason: `${category}: ${rank.reason}`,
          };
        ranks.set(identity, rank);
        if (ranks.size > 500) ranks.delete(ranks.keys().next().value!);
      }
    }
    result[file.key] = rank;
  }
  return result;
}

export function sortReviewFiles(
  files: ReviewFile[],
  scores: ReviewRanks,
): ReviewFile[] {
  return files
    .map((file, index) => ({ file, index }))
    .sort(
      (a, b) =>
        (scores[b.file.key]?.score ?? -1) - (scores[a.file.key]?.score ?? -1) ||
        a.index - b.index,
    )
    .map(({ file }) => file);
}
