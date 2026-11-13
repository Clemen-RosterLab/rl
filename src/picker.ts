import path from "node:path";
import { accessLabel, lastAccessed } from "./access.js";
import { pullRequestBase, repositoryBase, resolveBase } from "./base.js";
import {
  args,
  arity,
  canonical,
  git,
  inside,
  required,
  timestamp,
} from "./common.js";
import { discoverPrs, type PrLookup } from "./pr-discovery.js";
import { worktrees } from "./repos.js";
import { type Instance, Store } from "./store.js";
import { paintAnsi, sanitizeTerminalText } from "./tui/ansi.js";
import { runFzf } from "./tui/fzf.js";

const STATE_COLORS: Readonly<Record<string, number>> = {
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

const escapePickerToken = (value: string): string =>
  sanitizeTerminalText(
    value
      .replaceAll("\t", "\\t")
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r"),
  );

function cell(value: string, width: number): string {
  const text = escapePickerToken(value);
  const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return clipped.padEnd(width);
}

export function candidates(
  repo: string,
  base: string,
  store?: Store,
): Candidate[] {
  const adopted = new Map(
    store
      ?.records()
      .filter(([, data]) => data.status === "active")
      .map(([, data]) => [data.worktree, data.branch]),
  );

  const found = worktrees(repo)
    .slice(1)
    .flatMap((record) => {
      const root = canonical(record.worktree);
      const managed = inside(root, base);
      const branch = (record.branch ?? "").replace(/^refs\/heads\//, "");
      if (root === repo || (!managed && adopted.get(root) !== branch)) {
        return [];
      }
      return [
        {
          name: managed ? path.relative(base, root) : path.basename(root),
          path: root,
          branch,
          locked: "locked" in record,
        },
      ];
    });

  // Preserve managed names; outside checkouts fall back to their full path on collisions.
  const used = new Set(
    found.filter((item) => inside(item.path, base)).map((item) => item.name),
  );
  for (const outside of found.filter((item) => !inside(item.path, base))) {
    if (used.has(outside.name)) {
      outside.name = outside.path;
    }
    used.add(outside.name);
  }
  return found;
}

export function prState(data?: Pick<Instance, "pr">): string {
  if (!data?.pr) return "none";
  const state = String(data.pr.state ?? "").toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (state === "OPEN") return data.pr.isDraft ? "draft" : "open";
  return "unknown";
}

export function pickerRows(
  store: Store,
  items: Candidate[],
  defaultBase: string,
  prs = new Map<string, PrLookup>(),
): { item: Candidate; line: string; header: string }[] {
  const activeRecords = new Map(
    store
      .records()
      .filter(([, data]) => data.status === "active")
      .map(([, data]) => [data.worktree, data]),
  );

  const fallback = repositoryBase(store.repo, defaultBase);

  const details = items.map((item) => {
    const data = activeRecords.get(item.path);
    const lookup = prs.get(item.branch);
    const pr = lookup ? lookup.pr : data?.pr;
    const prBase = pullRequestBase(store.repo, pr);
    const savedBase =
      typeof data?.baseBranch === "string" ? data.baseBranch : undefined;
    const explicit =
      savedBase && savedBase !== defaultBase ? savedBase : undefined;

    let resolved = fallback;
    if (prBase) {
      resolved = prBase.resolved;
    } else if (explicit) {
      resolved = resolveBase(store.repo, explicit);
    }

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
        // Unavailable worktrees remain distinguishable from clean worktrees.
      }
    }

    let state = "unknown";
    if (pr) {
      state = prState({ pr }) + (lookup?.stale ? "*" : "");
    } else if (lookup && !lookup.stale && lookup.checkedAt) {
      state = "none";
    }

    return {
      item,
      accessed: lastAccessed(data),
      state,
      diff,
      base: resolved?.ref ?? prBase?.target ?? explicit ?? "unknown",
    };
  });

  details.sort((a, b) => {
    const left = a.accessed ? timestamp(a.accessed) : -1n;
    const right = b.accessed ? timestamp(b.accessed) : -1n;
    if (left === right) {
      return a.item.name.localeCompare(b.item.name);
    }
    return left > right ? -1 : 1;
  });

  const columns = process.stderr.columns || 110;
  const baseWidth = Math.min(
    24,
    Math.max(8, ...details.map((row) => escapePickerToken(row.base).length)),
  );
  const nameWidth = Math.min(
    Math.max(12, ...items.map((item) => escapePickerToken(item.name).length)),
    Math.max(16, Math.min(48, columns - baseWidth - 47)),
  );
  const diffWidth = Math.max(13, ...details.map((row) => row.diff.length));

  const formatRow = (name: string, state: string, diff: string, base: string) =>
    `${cell(name, nameWidth)}  ${cell(state, 7)}  ${cell(diff, diffWidth)}  ${cell(base, baseWidth)}  LAST ACCESSED`;

  const header = formatRow("WORKSPACE", "PR", "COMMITS + / −", "BASE");
  const color = (value: string, code: number) =>
    paintAnsi(value, code, process.env.NO_COLOR === undefined);

  return details.map(({ item, state, diff, base, accessed }) => {
    const displayCol = `${cell((item.locked ? "[locked] " : "") + item.name, nameWidth)}  ${color(cell(state, 7), STATE_COLORS[state.replace(/\*$/, "")])}  ${cell(
      diff,
      diffWidth,
    )
      .replace(/\+\d+/g, (val) => color(val, 32))
      .replace(/-\d+/g, (val) =>
        color(val, 31),
      )}  ${color(cell(base, baseWidth), 90)}  ${color(accessLabel(accessed), 90)}`;

    return {
      item,
      header,
      line: `${escapePickerToken(item.name)}\t${displayCol}`,
    };
  });
}

export type SelectionMode = boolean | "clean";

export async function select(
  store: Store,
  items: Candidate[],
  defaultBase: string,
  mode: SelectionMode,
): Promise<Candidate[]> {
  if (items.length === 0) {
    if (mode === "clean") {
      console.error("No RL worktrees to clean.");
    } else if (mode) {
      console.error("No managed worktrees to delete.");
    } else {
      console.error(
        "No RL workspaces yet. Create one with rl switch <name> --create.",
      );
    }
    return [];
  }

  const prs = await discoverPrs(
    store,
    items.map((item) => item.branch),
  );
  const rows = pickerRows(store, items, defaultBase, prs);

  let modeBanner: string;
  let prompt: string;
  if (mode === "clean") {
    modeBanner =
      "Tab select · Ctrl-A all · Enter clean · Esc cancel\nRemoves generated files; keeps worktrees, source, notes and sessions.";
    prompt = "Clean › ";
  } else if (mode) {
    modeBanner =
      "Tab select · Ctrl-A all · Enter delete · Esc cancel\nDeletes uncommitted work and local branches.";
    prompt = "Delete › ";
  } else {
    modeBanner = "Enter open · Esc cancel";
    prompt = "Workspace › ";
  }

  const header = `${modeBanner}\nPR auto · * stale · commits ahead / behind base\n\n${rows[0].header}`;

  const fzfItems = rows.map((row) => {
    const tabIndex = row.line.indexOf("\t");
    return {
      id: row.line.slice(0, tabIndex),
      line: row.line.slice(tabIndex + 1),
      value: row.item,
    };
  });

  const picked = await runFzf(fzfItems, {
    cwd: store.repo,
    prompt,
    header,
    multi: Boolean(mode),
    ansi: true,
    heightPercent: 70,
  });

  if (!picked) {
    return [];
  }

  return [...new Map(picked.items.map((item) => [item.path, item])).values()];
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
    candidates(store.repo, canonical(required(values, "base-dir")), store),
    required(values, "default-base"),
    false,
  );
  if (selected.length > 0) {
    process.stdout.write(`${selected[0].path}\n`);
  }
  return 0;
}
