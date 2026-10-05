import { discoverPrs, PrLookup } from "./pr-discovery.js";
import { accessLabel, lastAccessed } from "./access.js";
import path from "node:path";
import {
  args,
  arity,
  canonical,
  execute,
  git,
  inside,
  required,
  timestamp,
} from "./common.js";
import { Instance, Store } from "./store.js";
import { worktrees } from "./repos.js";
import { repositoryBase, resolveBase, pullRequestBase } from "./base.js";
const plain = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");
const color = (value: string, code: number): string =>
  process.env.NO_COLOR !== undefined ? value : `\x1b[${code}m${value}\x1b[0m`;
const stateColors: Record<string, number> = {
  merged: 35,
  open: 32,
  draft: 33,
  closed: 31,
  none: 90,
  unknown: 90,
};
export interface Candidate {
  name: string;
  path: string;
  branch: string;
  locked: boolean;
}
export function candidates(repo: string, base: string): Candidate[] {
  return worktrees(repo)
    .slice(1)
    .flatMap((record) => {
      const root = canonical(record.worktree);
      if (root === repo || !inside(root, base)) return [];
      return [
        {
          name: path.relative(base, root),
          path: root,
          branch: (record.branch ?? "").replace(/^refs\/heads\//, ""),
          locked: "locked" in record,
        },
      ];
    });
}
export function prState(data?: Pick<Instance, "pr">): string {
  if (!data?.pr) return "none";
  const state = String(data.pr.state ?? "").toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (state === "OPEN") return data.pr.isDraft ? "draft" : "open";
  return "unknown";
}
const visible = (value: string): string =>
  value
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\x1b", "");
export function pickerRows(
  store: Store,
  items: Candidate[],
  defaultBase: string,
  prs = new Map<string, PrLookup>(),
): { item: Candidate; line: string; header: string }[] {
  const records = new Map(
    store
      .records()
      .filter(([, data]) => data.status === "active")
      .map(([, data]) => [data.worktree, data]),
  );
  const fallback = repositoryBase(store.repo, defaultBase);
  const details = items.map((item) => {
    const data = records.get(item.path);
    const lookup = prs.get(item.branch);
    const pr = lookup ? lookup.pr : data?.pr;
    const prBase = pullRequestBase(store.repo, pr);
    const savedBase =
      typeof data?.baseBranch === "string" ? data.baseBranch : undefined;
    const explicit =
      savedBase && savedBase !== defaultBase ? savedBase : undefined;
    // An unresolved PR target never falls back to an unrelated repository base.
    const resolved = prBase
      ? prBase.resolved
      : explicit
        ? resolveBase(store.repo, explicit)
        : fallback;
    let diff = "—";
    if (resolved) {
      try {
        const [behind, ahead] = git(
          item.path,
          "rev-list",
          "--left-right",
          "--count",
          `${resolved.oid}...HEAD`,
          "--",
        ).split(/\s+/);
        diff = `+${ahead} / -${behind}`;
      } catch {
        /* Unavailable worktrees are not clean worktrees. */
      }
    }
    return {
      item,
      accessed: lastAccessed(data),
      state: pr
        ? prState({ pr }) + (lookup?.stale ? "*" : "")
        : lookup && !lookup.stale && lookup.checkedAt
          ? "none"
          : "unknown",
      diff,
      base: resolved?.ref ?? prBase?.target ?? explicit ?? "unknown",
    };
  });
  details.sort((a, b) => {
    const left = a.accessed ? timestamp(a.accessed) : -1n;
    const right = b.accessed ? timestamp(b.accessed) : -1n;
    return left === right
      ? a.item.name.localeCompare(b.item.name)
      : left > right
        ? -1
        : 1;
  });
  const columns = process.stderr.columns || 110;
  const baseWidth = Math.min(
    24,
    Math.max(8, ...details.map((row) => visible(row.base).length)),
  );
  const nameWidth = Math.min(
    Math.max(12, ...items.map((item) => visible(item.name).length)),
    Math.max(16, Math.min(48, columns - baseWidth - 47)),
  );
  const diffWidth = Math.max(11, ...details.map((row) => row.diff.length));
  const cell = (value: string, width: number) => {
    const text = visible(value);
    return (text.length > width ? text.slice(0, width - 1) + "…" : text).padEnd(
      width,
    );
  };
  const format = (name: string, state: string, diff: string, base: string) =>
    `${cell(name, nameWidth)}  ${cell(state, 7)}  ${cell(diff, diffWidth)}  ${cell(base, baseWidth)}  LAST ACCESSED`;
  const header = format("WORKSPACE", "PR", "+ / −", "BASE");
  return details.map(({ item, state, diff, base, accessed }) => ({
    item,
    header,
    // fzf hides the identity field; selection always uses the untruncated name.
    line: `${visible(item.name)}\t${cell((item.locked ? "[locked] " : "") + item.name, nameWidth)}  ${color(cell(state, 7), stateColors[state.replace(/\*$/, "")])}  ${cell(
      diff,
      diffWidth,
    )
      .replace(/\+\d+/g, (value) => color(value, 32))
      .replace(/-\d+/g, (value) =>
        color(value, 31),
      )}  ${color(cell(base, baseWidth), 90)}  ${color(accessLabel(accessed), 90)}`,
  }));
}

export async function select(
  store: Store,
  items: Candidate[],
  defaultBase: string,
  multiple: boolean,
): Promise<Candidate[]> {
  if (!items.length) {
    console.error(
      "No managed worktrees to " + (multiple ? "delete." : "open."),
    );
    return [];
  }
  const prs = await discoverPrs(
    store,
    items.map((item) => item.branch),
  );
  const rows = pickerRows(store, items, defaultBase, prs);
  const header =
    (multiple
      ? "Tab select · Ctrl-A all · Enter delete · Esc cancel\nDeletes uncommitted work and local branches."
      : "Enter open · Esc cancel") +
    "\nPR auto · * stale · commits ahead / behind base\n\n" +
    rows[0].header;
  const options = [
    "fzf",
    "--ansi",
    "--delimiter=\t",
    "--with-nth=2..",
    "--prompt=" + (multiple ? "Delete › " : "Workspace › "),
    "--height=70%",
    "--border=rounded",
    "--info=inline",
    "--reverse",
    "--no-sort",
    "--header=" + header,
  ];
  if (multiple)
    options.push("--multi", "--bind=ctrl-a:select-all,ctrl-d:deselect-all");
  const result = await execute(options, store.repo, {
    input: rows.map((row) => row.line).join("\n") + "\n",
    terminalError: true,
  });
  if ([1, 130].includes(result.code)) return [];
  if (result.code) throw new Error(`fzf failed (exit ${result.code})`);
  const selections = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const row = rows.find(
        (row) => plain(row.line) === plain(line) || row.item.name === line,
      );
      if (!row) throw new Error("Picker returned an unknown workspace");
      return row.item;
    });
  if (!multiple && selections.length > 1)
    throw new Error("Picker returned multiple workspaces");
  return [...new Map(selections.map((item) => [item.path, item])).values()];
}
export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, [
    "repo",
    "state-dir",
    "base-dir",
    "default-base",
  ]);
  arity(positionals, 0);
  const store = new Store(
    required(values, "repo"),
    required(values, "state-dir"),
  );
  const selected = await select(
    store,
    candidates(store.repo, canonical(required(values, "base-dir"))),
    required(values, "default-base"),
    false,
  );
  if (selected.length) process.stdout.write(selected[0].path + "\n");
  return 0;
}
