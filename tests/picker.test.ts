import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Workspace, read, readJson, write, ROOT } from "./helpers.js";
function capture(w: Workspace): string {
  const file = path.join(w.root, "picker.json");
  w.env.PICKER_CAPTURE = file;
  delete w.env.NO_COLOR;
  w.stub(
    "fzf",
    `const fs=require('node:fs');const rows=fs.readFileSync(0,'utf8').trim().split('\\n');fs.writeFileSync(process.env.PICKER_CAPTURE,JSON.stringify({rows:rows.map(row=>row.replace(/\\x1b\\[[0-9;]*m/g,'')),rawRows:rows,args:process.argv.slice(2)}));if(process.env.SELECT_NAME) {const row=rows.find(row=>row.startsWith(process.env.SELECT_NAME+'\\t'));if(row) console.log(row.replace(/\\x1b\\[[0-9;]*m/g,''));} else process.exit(130);`,
  );
  return file;
}
test("offline pickers mark cached PR snapshots stale and do not invent absence", (t) => {
  const w = new Workspace(t),
    names = ["merged", "open", "draft", "none", "closed"];
  for (const name of names) {
    const root = w.managed(name);
    w.git(root, "commit", "-q", "--allow-empty", "-m", name);
    const file = path.join(w.status(root).stateDirectory, "instance.json"),
      data = readJson(file);
    if (name !== "none")
      data.pr = {
        url: "https://github.com/example/repo/pull/1",
        state:
          name === "merged" ? "MERGED" : name === "closed" ? "CLOSED" : "OPEN",
        isDraft: name === "draft",
        baseRefName: "develop",
      };
    write(file, JSON.stringify(data));
  }
  w.git(w.repo, "commit", "-q", "--allow-empty", "-m", "New base commit");
  const file = capture(w);
  w.stub("gh", 'throw new Error("Picker must not call GitHub");');
  for (const command of [[], ["delete"]]) {
    w.rl(command);
    const captured = readJson(file);
    assert.equal(captured.rows.length, 5);
    assert.ok(captured.args.includes("--ansi"));
    for (const [state, code] of Object.entries({
      merged: 35,
      open: 32,
      draft: 33,
      closed: 31,
      none: 90,
    })) {
      const raw = captured.rawRows.find((row: string) =>
        row.startsWith(state + "\t"),
      );
      assert.ok(
        raw.includes(`\x1b[${code}m${state === "none" ? "unknown" : state}`),
      );
      assert.ok(raw.includes("\x1b[32m+1\x1b[0m"));
      assert.ok(raw.includes("\x1b[31m-1\x1b[0m"));
      assert.ok(!raw.includes("PR:") && !raw.includes("commits:"));
    }
    for (const name of names)
      assert.ok(
        captured.rows.some(
          (row: string) =>
            row.startsWith(name + "\t") &&
            new RegExp(
              `\\s${name === "none" ? "unknown" : name + "\\*"}\\s+\\+1 / -1\\s+develop\\s+`,
            ).test(row),
        ),
        name,
      );
    assert.ok(captured.args.some((arg: string) => arg.includes("PR auto")));
  }
  for (const name of names)
    assert.ok(fs.existsSync(path.join(w.root, "worktrees/example", name)));
});
test("picker decorated selection opens the exact nested workspace and deletion selects only that row", (t) => {
  const w = new Workspace(t),
    nested = w.managed("feature/nested"),
    other = w.managed("other");
  capture(w);
  w.env.SELECT_NAME = "feature/nested";
  w.env.RL_SHELL_FILE = path.join(ROOT, "shell/rl.zsh");
  w.env.EXPECTED_WORKTREE = nested;
  w.command([
    "zsh",
    "-f",
    "-c",
    'source "$RL_SHELL_FILE"; rl; [[ "$PWD" == "$EXPECTED_WORKTREE" ]] || exit 90',
  ]);
  w.rl(["delete"]);
  assert.ok(!fs.existsSync(nested));
  assert.ok(fs.existsSync(other));
});
test("picker uses recorded custom base, PR base preference and explicit unavailable counts", (t) => {
  const w = new Workspace(t),
    root = w.managed("custom");
  w.git(root, "commit", "-q", "--allow-empty", "-m", "Before custom base");
  w.git(root, "branch", "custom-base");
  w.git(root, "commit", "-q", "--allow-empty", "-m", "After base");
  const file = path.join(w.status(root).stateDirectory, "instance.json"),
    data = readJson(file);
  data.baseBranch = "custom-base";
  write(file, JSON.stringify(data));
  const captured = capture(w);
  w.rl([]);
  assert.match(readJson(captured).rows[0], /\+1 \/ -0\s+custom-base/);
  data.pr = {
    url: "https://github.com/example/repo/pull/1",
    state: "OPEN",
    baseRefName: "develop",
  };
  write(file, JSON.stringify(data));
  w.rl([]);
  assert.match(readJson(captured).rows[0], /\+2 \/ -0\s+develop/);
  data.pr.baseRefName = "missing";
  write(file, JSON.stringify(data));
  w.rl([]);
  assert.match(readJson(captured).rows[0], /—\s+missing/);
});
test("new --base persists comparison reference for future picker invocations", (t) => {
  const w = new Workspace(t),
    remote = path.join(w.root, "origin.git");
  w.command(["git", "init", "--bare", "-q", remote]);
  w.git(w.repo, "remote", "add", "origin", remote);
  w.git(w.repo, "push", "-q", "origin", "develop");
  w.rl(["new", "custom-created", "--base", "develop"]);
  assert.equal(
    w.status(path.join(w.root, "worktrees/example/custom-created")).baseBranch,
    "develop",
  );
});

test("picker replaces a missing legacy develop default with main and aligns columns", (t) => {
  const w = new Workspace(t);
  w.git(w.repo, "branch", "-m", "develop", "main");
  const short = w.managed("short");
  const longName =
    "a-very-long-feature-name-that-is-longer-than-the-display-column-12345";
  const long = w.managed(longName);
  const file = path.join(w.status(short).stateDirectory, "instance.json");
  const data = readJson(file);
  data.baseBranch = "origin/develop";
  write(file, JSON.stringify(data));
  w.git(short, "commit", "-q", "--allow-empty", "-m", "Feature change");
  const captureFile = capture(w);
  w.rl([]);
  const { rows, args } = readJson(captureFile);
  const displayed = rows.map((row: string) => row.split("\t")[1]);
  assert.ok(displayed.every((row: string) => /main\s+/.test(row)));
  assert.ok(rows.some((row: string) => /\+1 \/ -0\s+main\s+/.test(row)));
  assert.equal(
    displayed[0].indexOf("unknown"),
    displayed[1].indexOf("unknown"),
  );
  assert.equal(displayed[0].indexOf("+"), displayed[1].indexOf("+"));
  assert.ok(displayed.some((row: string) => row.includes("…")));
  assert.ok(args.includes("--with-nth=2.."));
  assert.ok(args.includes("--border=rounded"));
  // Identical/truncated visible names never become deletion identifiers.
  w.env.SELECT_NAME = longName;
  w.rl(["delete"]);
  assert.ok(!fs.existsSync(long));
  assert.ok(fs.existsSync(short));
});

test("picker prefers the cached remote default over conventional branch guesses", (t) => {
  const w = new Workspace(t);
  w.git(w.repo, "branch", "-m", "develop", "main");
  w.git(w.repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  w.git(
    w.repo,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/trunk",
  );
  const root = w.managed("default-branch-check");
  w.git(root, "commit", "-q", "--allow-empty", "-m", "Feature change");
  const file = capture(w);
  for (const command of [[], ["delete"]]) {
    w.rl(command);
    assert.match(readJson(file).rows[0], /\+1 \/ -0\s+origin\/trunk\s+/);
    assert.doesNotMatch(readJson(file).rows[0], /develop/);
  }
  w.env.NO_COLOR = "1";
  w.rl([]);
  assert.ok(
    readJson(file).rawRows.every((row: string) => !row.includes("\x1b")),
  );
});

test("pickers sort by last access, retain order when filtering, and do not count metadata reads", (t) => {
  const w = new Workspace(t),
    older = w.managed("a-older"),
    recent = w.managed("z-recent");
  for (const [root, stamp] of [
    [older, "2020-01-01T00:00:00Z"],
    [recent, "2020-02-01T00:00:00Z"],
  ]) {
    const file = path.join(w.status(root).stateDirectory, "instance.json"),
      data = readJson(file);
    data.createdAt = stamp;
    data.lastAccessedAt = stamp;
    write(file, JSON.stringify(data));
  }
  const unknown = path.join(w.root, "worktrees/example/unregistered");
  w.git(w.repo, "worktree", "add", "-q", "-b", "unregistered", unknown);
  const captured = capture(w);
  const names = () =>
    readJson(captured).rows.map((row: string) => row.split("\t")[0]);
  for (const args of [[], ["delete"]]) {
    w.rl(args);
    assert.deepEqual(names(), ["z-recent", "a-older", "unregistered"]);
    assert.ok(readJson(captured).args.includes("--no-sort"));
    assert.ok(
      readJson(captured).args.some((arg: string) => /LAST ACCESSED$/.test(arg)),
    );
    assert.match(readJson(captured).rows[0], /\d+d ago$/);
    assert.match(readJson(captured).rows[2], /—$/);
  }
  const before = w.status(older).lastAccessedAt;
  w.rl(["context", "append", "-"], { cwd: older, input: "metadata edit" });
  w.rl([]);
  assert.equal(w.status(older).lastAccessedAt, before);
  assert.deepEqual(names(), ["z-recent", "a-older", "unregistered"]);
  w.env.SELECT_NAME = "a-older";
  w.rl([]);
  delete w.env.SELECT_NAME;
  w.rl([]);
  assert.equal(names()[0], "a-older");
  assert.match(readJson(captured).rows[0], /just now$/);
  w.hook("codex", "11111111-1111-1111-1111-111111111111", { cwd: recent });
  w.rl([]);
  assert.equal(names()[0], "z-recent");
});

test("legacy instances use session history then creation time, not metadata edit time", (t) => {
  const w = new Workspace(t),
    old = w.managed("old"),
    active = w.managed("active");
  for (const root of [old, active]) {
    const file = path.join(w.status(root).stateDirectory, "instance.json"),
      data = readJson(file);
    delete data.lastAccessedAt;
    data.createdAt = "2020-01-01T00:00:00Z";
    data.updatedAt =
      root === old ? "2030-01-01T00:00:00Z" : "2020-01-01T00:00:00Z";
    if (root === active)
      data.sessions.claude = [
        {
          id: "22222222-2222-2222-2222-222222222222",
          createdAt: "2021-01-01T00:00:00Z",
          lastUsedAt: "2021-01-01T00:00:00Z",
        },
      ];
    write(file, JSON.stringify(data));
  }
  const file = capture(w);
  w.rl([]);
  assert.ok(readJson(file).rows[0].startsWith("active\t"));
  assert.equal(w.status(active).lastAccessedAt, undefined);
});
