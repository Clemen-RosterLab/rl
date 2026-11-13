import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeRelativeCleanupPath,
  isExcludedUntrackedPath,
  isIgnoredWatchDirectory,
  isProtectedCleanupSegment,
} from "../dist/core/protected-paths.js";
import {
  isUsageError,
  RlError,
  StateValidationError,
  UsageError,
  WorkspaceNotFoundError,
} from "../dist/errors.js";
import { ReviewInput } from "../dist/review-live-input.js";
import { reviewFrame } from "../dist/review-live-view.js";
import {
  AutomationConfigSchema,
  ReviewResultSchema,
} from "../dist/schemas/automation.js";
import { toCleanJsonSchema } from "../dist/schemas/common.js";
import { InstanceDiskSchema } from "../dist/schemas/instance.js";
import { matchGlob } from "../dist/session-workflows.js";
import {
  detectColorDepth,
  displayWidth,
  formatHomePath,
  padCell,
  sanitizeTerminalText,
  stripAnsiSgr,
} from "../dist/tui/ansi.js";
import { loadUserConfig } from "../dist/user-config.js";

test("typed error hierarchy preserves names, codes, and usage classification", () => {
  const usage = new UsageError("Non-legacy wording that is still usage");
  const missing = new WorkspaceNotFoundError("No workspace named demo");
  const corrupt = new StateValidationError("Expected a valid instance.json");
  const base = new RlError("Generic failure", { code: "ERR_RL" });

  assert.equal(usage.name, "UsageError");
  assert.equal(isUsageError(usage), true);
  assert.equal(missing.name, "WorkspaceNotFoundError");
  assert.equal(isUsageError(missing), false);
  assert.equal(corrupt.name, "StateValidationError");
  assert.equal(isUsageError(corrupt), false);
  assert.equal(base.code, "ERR_RL");
  assert.equal(isUsageError({ code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }), true);
});

test("declarative user config loads TOML, JSON, and safe legacy assignments while rejecting shell execution", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-unit-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const tomlPath = path.join(dir, "config.toml");
  fs.writeFileSync(
    tomlPath,
    'repoRoot = "~/src/app"\ndefaultBase = "origin/main"\n',
  );
  const fromToml = loadUserConfig({ RL_CONFIG: tomlPath }, "/Users/tester");
  assert.equal(fromToml.repoRoot, "/Users/tester/src/app");
  assert.equal(fromToml.defaultBase, "origin/main");

  const jsonPath = path.join(dir, "config.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ RL_WORKTREE_DIR: "$HOME/worktrees", repo: "backend" }),
  );
  const fromJson = loadUserConfig({ RL_CONFIG: jsonPath }, "/Users/tester");
  assert.equal(fromJson.worktreeDir, "/Users/tester/worktrees");
  assert.equal(fromJson.repo, "backend");

  const zshPath = path.join(dir, "config.zsh");
  fs.writeFileSync(zshPath, 'RL_REPO_ROOT="$(touch /tmp/pwned)"\n');
  assert.throws(
    () => loadUserConfig({ RL_CONFIG: zshPath }, "/Users/tester"),
    /command substitution|not supported/i,
  );
});

test("terminal ANSI utilities sanitize escape codes, respect NO_COLOR, and pad grapheme clusters", () => {
  assert.equal(
    sanitizeTerminalText("title\x1b[31m\nwith\x07controls\x1b[0m"),
    "title with controls",
  );
  assert.equal(stripAnsiSgr("\x1b[32m+4\x1b[0m"), "+4");
  assert.equal(detectColorDepth({ isTTY: true }, { NO_COLOR: "1" }), 1);
  assert.equal(
    detectColorDepth({ isTTY: true }, { TERM_PROGRAM: "Apple_Terminal" }),
    8,
  );
  assert.equal(
    detectColorDepth({ isTTY: true }, { COLORTERM: "truecolor" }),
    24,
  );
  assert.equal(displayWidth("界a"), 3);
  assert.equal(padCell("abcdef", 4), "abc…");
  assert.equal(formatHomePath("/Users/alice/code", "/Users/alice"), "~/code");
});

test("protected path policy blocks credentials and metadata while allowing generated build artifacts", () => {
  assert.equal(isProtectedCleanupSegment(".env.production"), true);
  assert.equal(isProtectedCleanupSegment("CLAUDE.md"), true);
  assert.equal(isProtectedCleanupSegment("dist"), false);
  assert.equal(isExcludedUntrackedPath("nested/.env.local"), true);
  assert.equal(isExcludedUntrackedPath("node_modules/pkg/index.js"), true);
  assert.equal(isExcludedUntrackedPath("src/index.ts"), false);
  assert.equal(isIgnoredWatchDirectory("node_modules"), true);
  assert.equal(isIgnoredWatchDirectory(".next"), true);
  assert.equal(isIgnoredWatchDirectory("src"), false);

  assertSafeRelativeCleanupPath("packages/web/dist");
  assert.throws(
    () => assertSafeRelativeCleanupPath("../escape"),
    /Unsafe cleanup path/,
  );
  assert.throws(
    () => assertSafeRelativeCleanupPath(".codex/hooks.json"),
    /Unsafe cleanup path/,
  );
});

test("Zod schemas preserve forward-compatible fields, clean JSON schemas, and validate reasoning/defaults", () => {
  const parsedInstance = InstanceDiskSchema.parse({
    schemaVersion: 2,
    id: "feature/demo",
    key: "demo-1234",
    repository: "/repo",
    worktree: "/worktrees/demo",
    branch: "feature/demo",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessions: { codex: [], claude: [] },
    pr: null,
    futureField: { nested: true },
  });
  assert.deepEqual((parsedInstance as Record<string, unknown>).futureField, {
    nested: true,
  });
  assert.equal(parsedInstance.sessions.agy, undefined);

  const cleanSchema = toCleanJsonSchema(ReviewResultSchema);
  assert.equal(cleanSchema.$schema, undefined);
  assert.equal(
    (cleanSchema.properties as Record<string, Record<string, unknown>>).summary
      .maxLength,
    undefined,
  );

  const invalidDefault = AutomationConfigSchema.safeParse({
    agents: {
      reviewer: { description: "Reviewer", instructions: "Review changes" },
    },
    policies: {
      review: {
        instructions: "Score findings",
        weights: { critical: 40, high: 20, medium: 10, low: 5 },
        minimumScore: 85,
        blockRequired: true,
      },
    },
    workflows: {
      check: {
        description: "Run review",
        policy: "review",
        concurrency: 1,
        retries: 0,
        timeoutSeconds: 60,
        steps: [{ id: "reviewer", agent: "reviewer", after: [] }],
      },
    },
    defaultWorkflow: null,
  });
  assert.equal(invalidDefault.success, false);
  assert.match(invalidDefault.error.issues[0].message, /Unknown default/);
});

test("matchGlob handles root-level double-star globs, directory prefixes, and wildcards", () => {
  assert.equal(matchGlob("**/*.ts", "app.ts"), true);
  assert.equal(matchGlob("**/*.ts", "src/deep/app.ts"), true);
  assert.equal(matchGlob("**/*.ts", "src/deep/app.js"), false);
  assert.equal(matchGlob("src/auth/**", "src/auth/login.ts"), true);
  assert.equal(matchGlob("src/auth/**", "src/authorize/login.ts"), false);
  assert.equal(matchGlob("src/**/auth/*.ts", "src/auth/token.ts"), true);
  assert.equal(matchGlob("src/**/auth/*.ts", "src/v1/v2/auth/token.ts"), true);
});

test("ReviewInput discards delayed SGR mouse release tails after a packet split timeout", async () => {
  const mouseEvents: unknown[] = [];
  let keysOut = "";
  const input = new ReviewInput((ev) => mouseEvents.push(ev));
  input.keys.setEncoding("utf8");
  input.keys.on("data", (chunk: string) => {
    keysOut += chunk;
  });

  input.feed(Buffer.from("\x1b[<0;12;"));
  await new Promise((resolve) => setTimeout(resolve, 130));
  input.feed(Buffer.from("8m"));
  input.feed(Buffer.from("j"));
  input.close();

  assert.equal(mouseEvents.length, 0);
  assert.equal(keysOut, "j");
});

test("reviewFrame keeps the footer authoritative on ultra-short terminals", () => {
  const frame = reviewFrame({
    width: 80,
    rows: 6,
    focus: 2,
    expanded: true,
    branch: "feature/short",
    head: "abcdef1234567890",
    frozen: false,
    newer: false,
    mode: { kind: "working" },
    commits: [],
    commitIndex: 0,
    commitScroll: 0,
    files: [],
    fileIndex: 0,
    hideNoise: false,
    hiddenFiles: 0,
    workingFiles: [],
    hiddenWorkingFiles: 0,
    lines: ["+line 1", "+line 2", "+line 3", "+line 4", "+line 5"],
    scroll: 0,
    horizontal: 0,
    search: "",
    status: "Updated · 0 file layers",
    remote: "Checking PR…",
    updates: 1,
  });

  const bottomPlain = stripAnsiSgr(frame.rows.at(-1)!);
  assert.match(bottomPlain, /Q Quit/);
  assert.match(bottomPlain, /1 Commits/);
});
