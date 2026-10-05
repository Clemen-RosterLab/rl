import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const CLI = path.join(ROOT, "bin/rl");
export const read = (file: string): string => fs.readFileSync(file, "utf8");
export const write = (file: string, text: string): void =>
  fs.writeFileSync(file, text);
// Test fixtures deliberately inspect extensible persisted JSON without casting away runtime fields.
export const readJson = (file: string) => JSON.parse(read(file));
export interface Options {
  cwd?: string;
  input?: string;
  ok?: boolean;
}
export class Workspace {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "rl state ' test ")),
  );
  repo = path.join(this.root, "repo");
  state = path.join(this.root, "state");
  config = path.join(this.root, "config.zsh");
  a = path.join(this.root, "workspace A");
  b = path.join(this.root, "workspace B");
  bin = path.join(this.root, "bin");
  log = path.join(this.root, "calls.jsonl");
  env: NodeJS.ProcessEnv = {
    ...process.env,
    RL_REPO_ROOT: this.repo,
    RL_WORKTREE_DIR: path.join(this.root, "worktrees"),
    RL_REPO_NAME: "example",
    RL_STATE_DIR: this.state,
    RL_CONFIG: this.config,
    RL_DEFAULT_BASE: "origin/develop",
    RL_PR_OFFLINE: "1",
    PATH: path.join(ROOT, "bin") + path.delimiter + process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  constructor(t: TestContext) {
    t.after(() => fs.rmSync(this.root, { recursive: true, force: true }));
    for (const key of [
      "RL_REPO",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
    ])
      delete this.env[key];
    write(this.config, "# test\n");
    this.command(["git", "init", "-q", "-b", "develop", this.repo]);
    this.git(this.repo, "commit", "-q", "--allow-empty", "-m", "Initial");
    for (const [root, branch] of [
      [this.a, "feature/a"],
      [this.b, "feature/b"],
    ]) {
      this.git(this.repo, "worktree", "add", "-q", "-b", branch, root);
      this.rl(["adopt"], { cwd: root });
    }
    fs.mkdirSync(this.bin);
    this.env.PATH = this.bin + path.delimiter + this.env.PATH;
    this.env.AGENT_LOG = this.log;
    for (const agent of ["codex", "claude"])
      this.stub(
        agent,
        `const fs = require('node:fs'); fs.appendFileSync(process.env.AGENT_LOG, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }) + '\\n'); process.exit(Number(process.env.AGENT_EXIT || 0));`,
      );
  }
  stub(name: string, code: string): void {
    const file = path.join(this.bin, name);
    write(file, "#!/usr/bin/env node\n" + code + "\n");
    fs.chmodSync(file, 0o755);
  }
  command(argv: string[], options: Options = {}) {
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: options.cwd ?? this.root,
      env: this.env,
      input: options.input,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
    });
    if (result.error) throw result.error;
    if (options.ok === false)
      assert.notEqual(result.status, 0, result.stderr + result.stdout);
    else assert.equal(result.status, 0, result.stderr + result.stdout);
    return result;
  }
  async commandAsync(argv: string[], options: Options = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd ?? this.root,
        env: this.env,
        stdio: "pipe",
      });
      let out = "",
        err = "";
      child.stdout.on("data", (c) => {
        out += c;
      });
      child.stderr.on("data", (c) => {
        err += c;
      });
      child.stdin.end(options.input);
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(err + out)),
      );
    });
  }
  git(cwd: string, ...args: string[]) {
    return this.command(["git", "-C", cwd, ...args], { cwd }).stdout.trim();
  }
  rl(args: string[], options: Options = {}) {
    return this.command([CLI, ...args], options);
  }
  status(cwd = this.a) {
    return JSON.parse(this.rl(["status"], { cwd }).stdout);
  }
  hookCommand(agent: string, event = "SessionStart", root = this.a): string {
    const file = path.join(
      root,
      agent === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json",
    );
    return readJson(file).hooks[event].at(-1).hooks[0].command;
  }
  hook(
    agent: string,
    sid: string,
    options: Options & {
      event?: string;
      hookRoot?: string;
      extra?: Record<string, unknown>;
    } = {},
  ) {
    const cwd = options.cwd ?? this.a,
      event = options.event ?? "SessionStart";
    return this.command(
      [
        "/bin/sh",
        "-c",
        this.hookCommand(agent, event, options.hookRoot ?? cwd),
      ],
      {
        ...options,
        cwd,
        input: JSON.stringify({
          session_id: sid,
          cwd,
          hook_event_name: event,
          source: "startup",
          ...options.extra,
        }),
      },
    );
  }
  managed(name: string): string {
    const root = path.join(this.root, "worktrees/example", name);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    this.git(this.repo, "worktree", "add", "-q", "-b", name, root);
    this.rl(["adopt"], { cwd: root });
    return root;
  }
  calls() {
    return read(this.log)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }
}
