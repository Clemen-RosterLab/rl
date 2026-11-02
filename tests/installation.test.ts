import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, CLI, Workspace, read, write } from "./helpers.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rl installation ' "));
  const bin = path.join(root, "bin"),
    home = path.join(root, "user home");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    PATH: bin,
    SHELL: "/bin/zsh",
    RL_INSTALL_TEST_BIN: bin,
    RL_INSTALL_TEST_LOG: path.join(root, "calls.json"),
    npm_lifecycle_event: "postinstall",
    npm_config_global: "true",
  };
  const tool = (
    name: string,
    code = `console.log(${JSON.stringify(name + " 1.0")});`,
  ) => {
    const file = path.join(bin, name);
    write(file, `#!${process.execPath}\n${code}\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  const manager = (name: string, fail = false) =>
    tool(
      name,
      `
const fs = require('node:fs'), path = require('node:path');
const log = process.env.RL_INSTALL_TEST_LOG;
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log,'utf8')) : [];
calls.push(process.argv.slice(2)); fs.writeFileSync(log,JSON.stringify(calls));
${
  fail
    ? "process.exit(1);"
    : `for (const name of process.argv.slice(2).filter(arg => ['git','zsh','fzf','gh','github-cli'].includes(arg))) {
 const tool = name === 'github-cli' ? 'gh' : name;
 fs.writeFileSync(path.join(process.env.RL_INSTALL_TEST_BIN,tool), '#!'+process.execPath+'\\nconsole.log('+JSON.stringify(tool+' 1.0')+');\\n', {mode:0o755});
}`
}
`,
    );
  const call = (
    method: "setupDependencies" | "installRl" | "configureShell",
    args: unknown[] = [],
    host: object = {},
    ok = true,
  ) => {
    const module = method === "setupDependencies" ? "dependencies" : "install";
    const invocation =
      method === "configureShell"
        ? `console.log(JSON.stringify(fn({...${JSON.stringify(host)}, env:process.env, home:${JSON.stringify(home)}, packageRoot:${JSON.stringify(ROOT)}})));`
        : `process.exitCode=await fn(${JSON.stringify(args)},{...${JSON.stringify(host)},env:process.env,home:${JSON.stringify(home)},packageRoot:${JSON.stringify(ROOT)}});`;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { ${method} as fn } from ${JSON.stringify(path.join(ROOT, "dist", module + ".js"))}; ${invocation}`,
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    if (result.error) throw result.error;
    assert.equal(result.status === 0, ok, result.stderr + result.stdout);
    return result;
  };
  return { root, bin, home, env, tool, manager, call };
}

test("dependency setup installs only missing tools, verifies the result, and does not run the package manager on repeat", (t) => {
  const f = fixture(t);
  f.tool("git");
  f.tool("zsh");
  f.manager("brew");
  const installed = JSON.parse(
    f.call("setupDependencies", ["--install", "--json"]).stdout,
  );
  assert.equal(installed.ready, true);
  assert.deepEqual(JSON.parse(read(f.env.RL_INSTALL_TEST_LOG)), [
    ["install", "fzf", "gh"],
  ]);
  f.call("setupDependencies", ["--install", "--json"]);
  assert.equal(JSON.parse(read(f.env.RL_INSTALL_TEST_LOG)).length, 1);
});

test("check and preview leave tools unchanged and failure gives an actionable installation command", (t) => {
  const f = fixture(t);
  f.tool("git");
  f.tool("zsh");
  f.manager("brew", true);
  assert.equal(
    JSON.parse(
      f.call("setupDependencies", ["--check", "--json"], {}, false).stdout,
    ).ready,
    false,
  );
  const preview = JSON.parse(
    f.call("setupDependencies", ["--dry-run", "--json"]).stdout,
  );
  assert.deepEqual(preview.commands[0].args, ["install", "fzf", "gh"]);
  assert.ok(!fs.existsSync(f.env.RL_INSTALL_TEST_LOG));
  const failed = JSON.parse(
    f.call("setupDependencies", ["--install", "--json"], {}, false).stdout,
  );
  assert.match(failed.error, /Could not install RL tools.*setup dependencies/);
  assert.equal(failed.ready, false);
});

test("fresh Linux toolchains use the available package manager and noninteractive sudo when needed", (t) => {
  const root = fixture(t);
  root.manager("apt-get");
  const installed = JSON.parse(
    root.call("setupDependencies", ["--install", "--json"], {
      platform: "linux",
      uid: 0,
    }).stdout,
  );
  assert.equal(installed.ready, true);
  assert.deepEqual(JSON.parse(read(root.env.RL_INSTALL_TEST_LOG)), [
    ["update"],
    ["install", "-y", "git", "zsh", "fzf", "gh"],
  ]);
  const user = fixture(t);
  user.manager("apt-get");
  user.tool("sudo", "process.exit(1)");
  const plan = JSON.parse(
    user.call("setupDependencies", ["--dry-run", "--json"], {
      platform: "linux",
      uid: 1000,
    }).stdout,
  );
  assert.equal(path.basename(plan.commands[0].executable), "sudo");
  assert.equal(plan.commands[0].args[0], "-n");
});

test("missing package managers report setup requirements without pretending installation succeeded", (t) => {
  const f = fixture(t);
  const result = JSON.parse(
    f.call(
      "setupDependencies",
      ["--install", "--json"],
      { platform: "darwin" },
      false,
    ).stdout,
  );
  assert.match(result.error, /Homebrew.*brew.sh.*setup dependencies/);
  assert.equal(result.ready, false);
  assert.ok(!fs.existsSync(path.join(f.bin, "git")));
});

test("global npm setup preserves shell settings, writes a user-owned CLI shim, and remains idempotent", (t) => {
  const f = fixture(t);
  for (const name of ["git", "zsh", "fzf", "gh"]) f.tool(name);
  const profile = path.join(f.home, ".zshrc");
  write(profile, '# Existing settings\nexport MY_SETTING="preserve this"\n');
  f.call("installRl");
  const content = read(profile);
  assert.match(content, /MY_SETTING="preserve this"/);
  assert.equal(content.split("# >>> rl shell integration >>>").length, 2);
  assert.ok(fs.existsSync(path.join(f.home, ".local/share/rl/bin/rl")));
  f.call("installRl");
  assert.equal(read(profile), content);
  assert.ok(!fs.existsSync(f.env.RL_INSTALL_TEST_LOG));
});

test("shell setup respects existing bash login files and refuses configuration escapes or malformed managed blocks", (t) => {
  const f = fixture(t);
  write(path.join(f.home, ".profile"), "# Existing login settings\n");
  f.env.SHELL = "/bin/bash";
  f.call("configureShell");
  assert.match(read(path.join(f.home, ".profile")), /Existing login settings/);
  assert.ok(fs.existsSync(path.join(f.home, ".bashrc")));
  assert.ok(!fs.existsSync(path.join(f.home, ".bash_profile")));
  const outside = path.join(f.root, "outside-profile");
  write(outside, "keep\n");
  fs.unlinkSync(path.join(f.home, ".bashrc"));
  fs.symlinkSync(outside, path.join(f.home, ".bashrc"));
  const failed = f.call("configureShell", [], {}, false);
  assert.ok(failed.stderr.length);
  assert.equal(read(outside), "keep\n");
  fs.unlinkSync(path.join(f.home, ".bashrc"));
  const malformed = "# >>> rl shell integration >>>\n# Keep my settings\n";
  write(path.join(f.home, ".bashrc"), malformed);
  f.call("configureShell", [], {}, false);
  assert.equal(read(path.join(f.home, ".bashrc")), malformed);
});

test("a fresh zsh startup loads the installed integration and bare rl changes directory without a manual eval", (t) => {
  const w = new Workspace(t);
  const home = path.join(w.root, "fresh home");
  fs.mkdirSync(home);
  const target = w.managed("first-task");
  w.stub(
    "fzf",
    "if(process.argv.includes('--version')) {console.log('fzf 1.0');process.exit(0);}const rows=require('node:fs').readFileSync(0,'utf8').split('\\n');console.log(rows.find(row=>row.startsWith('first-task\\t')));",
  );
  w.stub("gh", "console.log('gh 1.0');");
  const env = {
    ...w.env,
    SHELL: "/bin/zsh",
    npm_lifecycle_event: "postinstall",
    npm_config_global: "true",
  };
  const installed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {installRl} from ${JSON.stringify(path.join(ROOT, "dist/install.js"))};process.exitCode=await installRl([],{home:${JSON.stringify(home)},env:process.env,packageRoot:${JSON.stringify(ROOT)}});`,
    ],
    { env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  w.env.ZDOTDIR = home;
  w.env.EXPECTED_WORKTREE = target;
  w.command(
    [
      "/bin/zsh",
      "-i",
      "-c",
      '[[ $(whence -w rl) == "rl: function" ]] || exit 90; rl; [[ "$PWD" == "$EXPECTED_WORKTREE" ]] || exit 91',
    ],
    { cwd: w.repo },
  );
});

test("dependency repair and version commands can start before zsh is installed", (t) => {
  const f = fixture(t);
  const repaired = spawnSync(
    process.execPath,
    [CLI, "setup", "dependencies", "--check", "--json"],
    { env: f.env, encoding: "utf8" },
  );
  assert.equal(repaired.status, 1);
  assert.equal(JSON.parse(repaired.stdout).tools.length, 4);
  const version = spawnSync(process.execPath, [CLI, "--version"], {
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /\d+\.\d+\.\d+/);
});
