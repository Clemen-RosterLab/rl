import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT, Workspace, read, readJson, write } from "./helpers.js";
function pack(w: Workspace): string {
  const result = w.command(
    [
      "npm",
      "pack",
      "--json",
      "--ignore-scripts",
      "--offline",
      "--cache",
      path.join(w.root, "cache"),
      "--pack-destination",
      w.root,
    ],
    { cwd: ROOT },
  );
  return path.join(w.root, JSON.parse(result.stdout)[0].filename);
}
test("npm tarball ships built JavaScript and bundled runtime dependencies, with no Python or compiler", (t) => {
  const w = new Workspace(t),
    archive = pack(w),
    names = w.command(["tar", "-tzf", archive]).stdout.trim().split("\n");
  const runtime = new Set([
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/bin/rl",
    "package/lib/rl.zsh",
    "package/shell/rl.zsh",
    "package/config.example.zsh",
  ]);
  for (const name of names)
    assert.ok(
      runtime.has(name) ||
        /^package\/dist\/[\w-]+\.js$/.test(name) ||
        /^package\/node_modules\/(proper-lockfile|graceful-fs|retry|signal-exit)\//.test(
          name,
        ),
      name,
    );
  assert.ok(names.includes("package/dist/cli.js"));
  assert.ok(names.includes("package/LICENSE"));
  assert.ok(
    !names.some((name) => name.endsWith(".py") || name.endsWith(".ts")),
  );
  const manifest = JSON.parse(
    w.command(["tar", "-xOf", archive, "package/package.json"]).stdout,
  );
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.bin, { rl: "bin/rl" });
  assert.equal(manifest.engines.node, ">=22");
  for (const script of ["install", "postinstall", "preinstall"])
    assert.ok(!(script in manifest.scripts));
});
test("offline npm install, relocation and reinstall preserve hooks, sessions and shell integration", (t) => {
  const w = new Workspace(t),
    archive = pack(w);
  let prefix = path.join(w.root, "npm prefix");
  const install = () =>
    w.command([
      "npm",
      "install",
      "--global",
      "--prefix",
      prefix,
      "--cache",
      path.join(w.root, "npm cache"),
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      archive,
    ]);
  install();
  let cli = path.join(prefix, "bin/rl");
  const setPath = () => {
    w.env.PATH = [path.join(prefix, "bin"), w.bin, process.env.PATH].join(
      path.delimiter,
    );
  };
  setPath();
  // Ensure runtime code never tries to invoke Python, even on a machine where it exists.
  for (const name of ["python", "python3"]) w.stub(name, "process.exit(99);");
  assert.equal(
    w.command([cli, "--version"]).stdout.trim(),
    readJson(path.join(ROOT, "package.json")).version,
  );
  assert.match(w.command([cli, "help"]).stdout, /rl resume codex\|claude/);
  w.command([cli, "adopt"], { cwd: w.a });
  w.command([cli, "progress", "append", "-"], {
    cwd: w.a,
    input: "Package install complete",
  });
  assert.match(
    w.command([cli, "summary", "--stdout"], { cwd: w.a }).stdout,
    /Package install complete/,
  );
  const config = path.join(w.a, ".codex/hooks.json"),
    before = read(config),
    command = readJson(config).hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /^rl __hook /);
  assert.ok(!command.includes(prefix) && !command.includes(ROOT));
  const relocated = path.join(w.root, "new npm prefix");
  fs.renameSync(prefix, relocated);
  prefix = relocated;
  cli = path.join(prefix, "bin/rl");
  setPath();
  w.env.RL_CONFIG = path.join(w.root, "missing-config");
  const sid = randomUUID();
  assert.match(w.hook("codex", sid).stdout, /Package install complete/);
  w.env.RL_CONFIG = w.config;
  const diagnosis = JSON.parse(
    w.command([cli, "doctor", "codex", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(diagnosis.agents[0].installed, true);
  assert.equal(diagnosis.agents[0].lastSuccess.event, "SessionStart");
  assert.equal(diagnosis.agents[0].activity[0].sessionId, sid);
  assert.equal(
    JSON.parse(w.command([cli, "status"], { cwd: w.a }).stdout).sessions
      .codex[0].id,
    sid,
  );
  w.command([cli, "adopt"], { cwd: w.a });
  assert.equal(read(config), before);
  const managed = w.managed("selected");
  w.env.RL_PACKAGE_CLI = cli;
  w.env.EXPECTED_WORKTREE = managed;
  w.stub(
    "fzf",
    `const rows=require('node:fs').readFileSync(0,'utf8').trim().split('\\n');console.log(rows.find(row=>row.startsWith('selected\\t')));`,
  );
  w.command([
    "zsh",
    "-f",
    "-c",
    'eval "$("$RL_PACKAGE_CLI" init zsh)"; rl; [[ "$PWD" == "$EXPECTED_WORKTREE" ]] || exit 90; rl --version',
  ]);
  w.command([cli, "resume", "codex"], { cwd: w.a });
  assert.deepEqual(w.calls().at(-1).argv.slice(1), ["resume", sid]);
  install();
  w.hook("claude", randomUUID());
  assert.equal(read(config), before);
});
