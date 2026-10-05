import { pullRequestBase } from "./base.js";
import fs from "node:fs";
import path from "node:path";
import {
  args,
  arity,
  atomicWrite,
  canonical,
  expandHome,
  git,
  gitRaw,
  isSymlink,
  now,
  required,
} from "./common.js";
import { branchStatus, Instance, Store } from "./store.js";
import { NOTE_TEMPLATES } from "./templates.js";
const longest = (text: string): number =>
  Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
function fence(text: string): string {
  const delimiter = "`".repeat(Math.max(3, longest(text) + 1));
  return `${delimiter}text\n${text.trimEnd()}\n${delimiter}`;
}
function inline(text: string): string {
  text = text.replaceAll("\n", "\\n").replaceAll("\r", "\\r");
  const delimiter = "`".repeat(longest(text) + 1);
  return `${delimiter} ${text} ${delimiter}`;
}
function quote(text: string): string {
  return text.trimEnd()
    ? text
        .trimEnd()
        .split(/\r?\n/)
        .map((line) => (line ? "> " + line : ">"))
        .join("\n")
    : "> No notes recorded.";
}
function resolveBase(
  root: string,
  requested: string,
  explicit: boolean,
): [string | null, string | null] {
  const candidates = [requested];
  if (!requested.startsWith("origin/")) candidates.push("origin/" + requested);
  else if (!explicit) candidates.push(requested.slice(7));
  for (const candidate of candidates) {
    try {
      return [
        candidate,
        git(
          root,
          "rev-parse",
          "--verify",
          "--end-of-options",
          candidate + "^{commit}",
        ),
      ];
    } catch {
      /* Try local/remote fallback. */
    }
  }
  if (explicit) throw new Error(`Comparison base does not exist: ${requested}`);
  return [null, null];
}
function render(
  store: Store,
  data: Instance,
  context: string,
  progress: string,
  defaultBase: string,
  requested?: string,
): string {
  const root = data.worktree,
    status = branchStatus(store.repo, data);
  if (status.availability !== "ok")
    throw new Error(status.error || "Worktree is unavailable");
  if (status.branchChanged)
    throw new Error(
      "The checked-out branch changed while preparing the summary; retry on the instance branch",
    );
  const head = git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const prBase = requested ? null : pullRequestBase(store.repo, data.pr);
  const comparison =
    requested ||
    prBase?.target ||
    (typeof data.baseBranch === "string" ? data.baseBranch : defaultBase);
  if (prBase && !prBase.resolved)
    throw new Error(
      `PR target branch is unavailable locally: ${prBase.target}. Fetch its ref or refresh the snapshot with 'rl pr sync'.`,
    );
  const [base, baseOid] = prBase?.resolved
    ? [prBase.resolved.ref, prBase.resolved.oid]
    : resolveBase(root, comparison, !!requested);
  const parts = [
    "# RL worktree summary",
    `Generated: ${now()}`,
    `- Instance: ${inline(data.id)}\n- Repository: ${inline(store.repo)}\n- Worktree: ${inline(root)}\n- Branch: ${inline(data.branch)}\n- HEAD: ${inline(head)}`,
    "This report combines saved documentation with local Git evidence. Recorded progress is authored by you or your agents; commits and file changes do not establish completion or successful validation. No agent was called and no remote state was fetched. Git data is sampled while the command runs.",
    "## Recorded implementation progress",
    quote(progress),
    "## Feature and domain context",
    quote(context),
    "## Committed work",
  ];
  if (baseOid && base) {
    let mergeBase: string;
    try {
      mergeBase = git(root, "merge-base", baseOid, head);
    } catch {
      throw new Error(
        `No common ancestor between HEAD and ${base}; choose another --base`,
      );
    }
    parts.push(
      `Comparison reference: ${inline(base)} (${inline(baseOid)}). Changes are measured from its merge-base with HEAD: ${inline(mergeBase)}.`,
    );
    const commits = git(
      root,
      "log",
      "--no-decorate",
      "--format=%h %s",
      `${mergeBase}..${head}`,
      "--",
    );
    parts.push(
      "### Commits",
      commits ? fence(commits) : "No commits since the comparison merge-base.",
    );
    const changes = git(
      root,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--stat",
      mergeBase,
      head,
      "--",
    );
    parts.push(
      "### Committed file changes",
      changes ? fence(changes) : "No net committed file changes.",
    );
  } else
    parts.push(
      `The configured comparison base ${inline(comparison)} could not be resolved. Committed work was omitted; run \`rl summary --base <branch-or-commit>\` to include it.`,
    );
  parts.push(
    "## Uncommitted work",
    `Git status entries: ${status.staged} staged, ${status.unstaged} unstaged, ${status.untracked} untracked, ${status.conflicts} conflicts. An untracked directory counts as one status entry.`,
  );
  for (const [title, flags] of [
    ["Staged changes", ["--cached"]],
    ["Unstaged changes", []],
  ] as const) {
    const changes = git(
      root,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      ...flags,
      "--stat",
      "--",
    );
    parts.push("### " + title, changes ? fence(changes) : "None.");
  }
  const files = gitRaw(root, "ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean);
  parts.push(
    "### Untracked files",
    files.length
      ? fence(files.map((name) => JSON.stringify(name)).join("\n"))
      : "None.",
    "## Upstream status",
  );
  parts.push(
    status.upstream
      ? `Upstream: ${inline(status.upstream)}. ` +
          (status.ahead !== null
            ? `Ahead ${status.ahead}, behind ${status.behind} using locally cached refs.`
            : "Ahead/behind counts are unavailable.")
      : "No upstream is configured for this branch.",
  );
  parts.push(
    "## Pull request (cached)",
    data.pr
      ? fence(JSON.stringify(data.pr, null, 2))
      : "No PR snapshot saved. Use `rl pr sync` to associate or refresh one.",
  );
  return parts.join("\n\n") + "\n";
}
export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    ["repo", "state-dir", "default-base", "output", "base"],
    ["stdout", "force"],
    { output: "o" },
  );
  arity(positionals, 0);
  if (values.force && !values.output)
    throw new Error("--force is only needed with --output");
  if (values.stdout && values.output)
    throw new Error("Choose --stdout or --output");
  const store = new Store(
    required(values, "repo"),
    required(values, "state-dir"),
  );
  const { file, data, context, progress } = await store.locked(() => {
    const [file, data] = store.current();
    const note = (name: string) => {
      const text = fs.readFileSync(path.join(path.dirname(file), name), "utf8");
      return text === NOTE_TEMPLATES[name] ? "" : text;
    };
    return {
      file,
      data,
      context: note("context.md"),
      progress: note("progress.md"),
    };
  });
  const report = render(
    store,
    data,
    context,
    progress,
    required(values, "default-base"),
    typeof values.base === "string" ? values.base : undefined,
  );
  if (values.stdout) {
    process.stdout.write(report);
    return 0;
  }
  const target = values.output
    ? path.resolve(expandHome(String(values.output)))
    : path.join(path.dirname(file), "summary.md");
  if (path.extname(target).toLowerCase() !== ".md")
    throw new Error("Summary output must have a .md extension");
  if (isSymlink(target))
    throw new Error(`Refusing to overwrite a symlink: ${target}`);
  if (
    ["context.md", "progress.md"].some(
      (name) =>
        canonical(target) === canonical(path.join(path.dirname(file), name)),
    )
  )
    throw new Error(
      "Summary output cannot replace the instance's source documentation",
    );
  if (values.output && !values.force) {
    try {
      fs.writeFileSync(target, report, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          `Output already exists: ${target}. Use --force to replace it`,
        );
      throw error;
    }
  } else atomicWrite(target, report);
  console.log(target);
  return 0;
}
