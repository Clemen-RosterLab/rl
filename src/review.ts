import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { accessLabel } from "./access.js";
import { activityView } from "./activity.js";
import {
  commandContext,
  contextOptions,
  resolveWorkspace,
  type CommandContext,
} from "./command-context.js";
import { args, arity, execute, inside, json, now, readJson } from "./common.js";
import { findExecutable } from "./dependencies.js";
import { UsageError } from "./errors.js";
import { candidates } from "./picker.js";
import {
  analyse,
  collectEvidence,
  scopesFor,
  uncategorised,
  type Analysis,
  type Evidence,
  type Scope,
} from "./review-analysis.js";
import { feedback } from "./review-feedback.js";
import {
  captureSnapshot,
  changedFiles,
  reviewGit,
  type ChangedFile,
  type Snapshot,
} from "./review-git.js";
import { GhReviewService } from "./review-github.js";
import { LiveRepository, reviewRoot, type Mode } from "./review-live-engine.js";
import { liveReview } from "./review-live.js";
import { ReviewStore, reviewStatus } from "./review-store.js";
import { browseDiff, choose, page, visible } from "./review-terminal.js";
import { SavedAnalysisDiskSchema } from "./schemas/review.js";

interface Row {
  scope?: string;
  id: string;
  name: string;
  branch: string;
  path: string;
  status: string;
  files: number | null;
  additions: number;
  deletions: number;
  layers: {
    committed: number;
    staged: number;
    unstaged: number;
    untracked: number;
  } | null;
  sinceReview: number | null;
  lastReview: string | null;
  ready: boolean;
  agent: string;
  activeObserved: boolean;
  pr: string;
  warnings: string[];
  fingerprint?: string;
  baseline?: string;
}

interface Entry {
  row: Row;
  review?: ReviewStore;
  snapshot?: Snapshot;
  files?: ChangedFile[];
}

function filesFor(root: string, scopes: Scope[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const scope of scopes) {
    for (const file of changedFiles(root, scope.from, scope.to)) {
      if (!files.has(file.path)) {
        files.set(file.path, file);
      }
    }
  }
  return [...files.values()];
}

function scopedEntry(entry: Entry, scopes: Scope[]): Entry {
  const files = filesFor(entry.row.path, scopes);
  return {
    ...entry,
    files,
    row: {
      ...entry.row,
      scope: scopes[0]?.name,
      files: files.length,
      additions: files.reduce(
        (total, file) => total + (file.additions ?? 0),
        0,
      ),
      deletions: files.reduce(
        (total, file) => total + (file.deletions ?? 0),
        0,
      ),
    },
  };
}

function observed(review: ReviewStore) {
  const activity = (["codex", "claude", "agy"] as const)
    .flatMap((agent) =>
      activityView(review.data.activity?.[agent])
        .filter((item) => !item.childId)
        .map((item) => ({ ...item, agent })),
    )
    .toSorted((a, b) => b.observedAt.localeCompare(a.observedAt));

  const working = activity.find((item) => item.state === "working");
  const latest = working ?? activity[0];
  let label = "unknown";
  if (latest && latest.state !== "stale") {
    const stateDesc =
      latest.state === "working"
        ? "working observed"
        : latest.state === "ended"
          ? "session ended"
          : "last turn stopped";
    label = `${latest.agent}: ${stateDesc} ${accessLabel(latest.observedAt)}`;
  }

  return {
    active: Boolean(working),
    label,
  };
}

export function reviewEntry(
  context: Pick<CommandContext, "store">,
  item: { name: string; branch: string; path: string },
  supplied?: Snapshot,
): Entry {
  const row: Row = {
    id: createHash("sha256").update(item.path).digest("hex").slice(0, 16),
    ...item,
    status: "Unavailable",
    files: null,
    additions: 0,
    deletions: 0,
    layers: null,
    sinceReview: null,
    lastReview: null,
    ready: false,
    agent: "unknown",
    activeObserved: false,
    pr: "unknown",
    warnings: [],
  };

  let savedReview: ReviewStore | undefined;
  let savedSnapshot: Snapshot | undefined;

  try {
    const review = new ReviewStore(
      context.store,
      context.store.current(item.path),
    );
    savedReview = review;
    const state = review.load();
    const snapshot = supplied ?? captureSnapshot(item.path);
    savedSnapshot = snapshot;

    const agent = observed(review);
    row.agent = agent.label;
    row.activeObserved = agent.active;
    row.pr =
      typeof review.data.pr?.state === "string"
        ? review.data.pr.isDraft && review.data.pr.state === "OPEN"
          ? "draft"
          : review.data.pr.state.toLowerCase()
        : "unknown";
    row.fingerprint = snapshot.fingerprint;
    row.baseline = snapshot.baseline ?? state.baseline?.commit;

    if (!snapshot.stable) {
      row.warnings.push("Snapshot may be stale: files changed during capture");
    }
    if (!snapshot.complete) {
      row.warnings.push(
        `Snapshot incomplete; excluded: ${snapshot.excluded.join(", ")}`,
      );
    }
    if (snapshot.conflicts.length > 0) {
      row.warnings.push(`Conflicts: ${snapshot.conflicts.join(", ")}`);
    }
    if (row.baseline) {
      try {
        reviewGit(item.path, [
          "merge-base",
          "--is-ancestor",
          row.baseline,
          snapshot.head,
        ]);
      } catch {
        row.warnings.push(
          "HEAD no longer descends from the recorded baseline; history was rewritten or rebased. The fixed baseline is retained.",
        );
      }
    }

    const base = row.baseline ?? snapshot.headTree;
    const scopes = [
      { name: "source", from: base, to: snapshot.worktreeTree },
      { name: "index", from: base, to: snapshot.indexTree },
    ];
    const files = filesFor(item.path, scopes);
    row.files = files.length;
    row.additions = files.reduce(
      (total, file) => total + (file.additions ?? 0),
      0,
    );
    row.deletions = files.reduce(
      (total, file) => total + (file.deletions ?? 0),
      0,
    );
    row.layers = {
      committed: row.baseline
        ? changedFiles(item.path, base, snapshot.headTree).length
        : -1,
      staged: changedFiles(item.path, snapshot.headTree, snapshot.indexTree)
        .length,
      unstaged: changedFiles(
        item.path,
        snapshot.indexTree,
        snapshot.worktreeTree,
      ).filter((file) => !snapshot.untracked.includes(file.path)).length,
      untracked: snapshot.untracked.length + snapshot.excluded.length,
    };

    row.status = row.baseline
      ? reviewStatus(state, snapshot, files.length)
      : "Baseline required";
    if (row.baseline && !snapshot.complete) {
      row.status = "Incomplete snapshot";
    }
    if (!snapshot.stable) {
      row.status = "Snapshot moving";
    }
    if (snapshot.conflicts.length > 0) {
      row.status = "Conflicts";
    }

    if (state.checkpoints.length > 0) {
      const previous = review.lastCheckpoint();
      row.sinceReview = filesFor(item.path, [
        {
          name: "source",
          from: previous.worktreeTree,
          to: snapshot.worktreeTree,
        },
        { name: "index", from: previous.indexTree, to: snapshot.indexTree },
      ]).length;
      row.lastReview = state.checkpoints.at(-1)!.at;
    }

    row.ready =
      state.ready === snapshot.fingerprint &&
      snapshot.stable &&
      snapshot.complete &&
      snapshot.conflicts.length === 0;
    if (row.ready && row.status === "Unreviewed") {
      row.status = "Ready";
    }

    return { row, review, snapshot, files };
  } catch (error) {
    row.warnings.push(error instanceof Error ? error.message : String(error));
    return { row, review: savedReview, snapshot: savedSnapshot };
  }
}

function summaryText(
  entry: Entry,
  analysis?: Analysis,
  error?: string,
): string {
  const { row, snapshot, review } = entry;
  const lines = [
    `${row.name}\n${"─".repeat(60)}\n${row.scope ?? "Complete feature"}`,
    `Branch: ${row.branch}\nWorktree: ${row.path}\nStatus: ${row.status}${row.ready ? " · explicitly marked ready" : ""}`,
    `Files: ${row.files ?? "unknown"} · +${row.additions} / -${row.deletions}\nAgent: ${row.agent} (hook observations are not process-liveness or task-completion proof)\nPR: ${row.pr}`,
    `Baseline: ${row.baseline ?? "Unknown: select with --base <ref>"}\nSnapshot: ${snapshot?.id ?? "unavailable"}\nLast checkpoint: ${row.lastReview ?? "none"} · files since checkpoint: ${row.sinceReview ?? "unknown"}`,
  ];

  if (row.layers) {
    lines.push(
      `Layers (file counts): committed ${row.layers.committed < 0 ? "unknown" : row.layers.committed} · staged ${row.layers.staged} · unstaged ${row.layers.unstaged} · untracked ${row.layers.untracked}`,
    );
  }
  if (entry.files?.length) {
    lines.push(
      "Changed files:\n" +
        entry.files
          .map(
            (file) =>
              `  ${file.id} ${file.status} ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}${file.binary ? " [binary]" : ` +${file.additions}/-${file.deletions}`}`,
          )
          .join("\n"),
    );
  }

  lines.push(...row.warnings.map((warning) => `Warning: ${warning}`));
  if (error) {
    lines.push(
      `AI analysis unavailable: ${error}. Manual review remains available.`,
    );
  }
  if (analysis) {
    lines.push(
      `AI ${analysis.kind} · ${analysis.provider} · snapshot ${analysis.snapshot}${analysis.stale ? " · STALE: source changed after capture" : ""}`,
      `Implementation overview\n${analysis.overview}`,
      `Architectural decisions (AI analysis)\n${analysis.architecture.join("\n")}`,
      `Behavioural changes (AI analysis)\n${analysis.behavior.join("\n")}`,
      `Testing (AI-reported interpretation; not execution proof)\n${analysis.testing.join("\n")}`,
      "Potential concerns\n" +
        [
          ...analysis.concerns,
          ...analysis.review.findings.map(
            (finding) =>
              `${finding.severity}: ${finding.file}:${finding.line} ${finding.title}\n${finding.evidence}\n${finding.recommendation}`,
          ),
        ].join("\n"),
      "Coverage limitations\n" +
        [...analysis.limitations, ...analysis.review.limitations].join("\n"),
    );
  }

  lines.push(
    "Validation evidence: rl review has not executed tests. Saved agent progress and AI interpretations do not establish that tests passed.",
  );
  if (review) {
    for (const name of ["context.md", "progress.md"]) {
      const target = path.join(path.dirname(review.file), name);
      if (fs.existsSync(target)) {
        lines.push(
          `${name} (user/agent-authored context)\n${fs.readFileSync(target, "utf8").slice(0, 8000)}`,
        );
      }
    }
  }
  return `${lines.join("\n\n")}\n`;
}

async function openEditor(root: string): Promise<void> {
  if (!findExecutable("code")) {
    throw new Error(
      "VS Code's code command is unavailable; install its shell command or use the terminal diff view",
    );
  }
  const result = await execute(["code", root], root, { interactive: true });
  if (result.code !== 0) {
    throw new Error(`Editor failed (${result.code})`);
  }
}

async function lazygit(entry: Entry): Promise<void> {
  if (findExecutable("lazygit")) {
    console.error(
      "Opening Lazygit's live working-tree view. This is not the complete feature or checkpoint diff.",
    );
    const result = await execute(["lazygit"], entry.row.path, {
      interactive: true,
    });
    if (result.code !== 0) {
      throw new Error(`Lazygit failed (${result.code})`);
    }
    return;
  }

  console.error(
    "Lazygit is not installed (macOS: brew install lazygit). Falling back to Git's snapshot diff viewer.",
  );
  if (!entry.snapshot) {
    throw new Error(entry.row.warnings.join("; "));
  }
  await browseDiff(
    entry.row.path,
    entry.review?.load().baseline
      ? scopesFor(entry.review, entry.snapshot)
      : [
          {
            name: "Uncommitted changes only; feature baseline unknown",
            from: entry.snapshot.headTree,
            to: entry.snapshot.worktreeTree,
          },
        ],
  );
}

function latestAnalysis(
  review: ReviewStore,
  snapshot: Snapshot,
): Analysis | undefined {
  const metadata = review
    .load()
    .analyses.findLast((item) => item.snapshot === snapshot.id);
  if (!metadata) {
    return undefined;
  }
  try {
    const raw = readJson(review.path(`analyses/${metadata.id}.json`));
    const parsed = SavedAnalysisDiskSchema.safeParse(raw);
    return parsed.success ? (parsed.data as Analysis) : undefined;
  } catch {
    return undefined;
  }
}

async function groups(
  entry: Entry,
  evidence: Evidence,
  analysis?: Analysis,
): Promise<void> {
  const logical = analysis?.groups ?? uncategorised(evidence, []);
  while (true) {
    const picked = await choose(
      logical.map((group, index) => ({
        id: String(index),
        text: `${group.title} · ${group.members.length} file/hunk references · ${group.explanation}`,
      })),
      entry.row.path,
      "Implementation areas",
      `Snapshot ${evidence.snapshot}${analysis?.stale ? " · STALE: source changed after capture" : ""}\nGit-derived patches · Esc back · complete diff is always available`,
    );
    if (!picked) {
      return;
    }

    const group = logical[Number(picked.id)];
    const text = [
      group.title,
      group.explanation,
      ...group.concerns.map((item) => `Concern (AI): ${item}`),
    ];
    for (const member of group.members) {
      const hunk = evidence.hunks.find((item) => item.id === member);
      if (hunk) {
        text.push(hunk.patch);
      } else {
        for (const patch of evidence.patches.filter(
          (item) => item.fileId === member,
        )) {
          text.push(`${patch.layer}\n${patch.patch}`);
        }
      }
    }
    if (evidence.limitations.length > 0) {
      text.push(
        `This grouped excerpt is incomplete. Use the complete Git diff.\n${evidence.limitations.join("\n")}`,
      );
    }
    page(text.join("\n\n"), entry.row.path);
  }
}

interface ReviewActionOptions {
  provider?: string;
  profile?: string;
  noAI?: boolean;
}

async function action(
  entry: Entry,
  selected: string,
  options: ReviewActionOptions,
  scope?: Scope[],
): Promise<void> {
  if (selected === "editor") {
    return openEditor(entry.row.path);
  }
  if (selected === "lazygit") {
    return lazygit(entry);
  }

  const { review, snapshot } = entry;
  if (!review || !snapshot) {
    throw new Error(entry.row.warnings.join("; "));
  }

  if (selected === "feedback") {
    const saved = await feedback(review, snapshot, { resume: true });
    page(
      `Feedback ${saved.id}: ${saved.status}\n${saved.error ?? "Feedback retained for this workspace."}`,
      entry.row.path,
    );
    return;
  }

  if (selected === "baseline") {
    const refs = reviewGit(entry.row.path, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ])
      .trim()
      .split("\n")
      .filter(
        (ref) =>
          ref &&
          ref !== `refs/heads/${entry.row.branch}` &&
          !ref.endsWith("/HEAD"),
      );
    const picked = await choose(
      refs.map((ref) => ({ id: ref, text: ref })),
      entry.row.path,
      "Feature baseline",
      "Explicitly choose the branch this feature forked from · its merge-base with HEAD will be pinned\nNo automatic guess · Esc cancels · use --base <commit> for a specific commit",
    );
    if (!picked) {
      return;
    }
    const state = await review.setBaseline(picked.id);
    Object.assign(
      entry,
      reviewEntry(
        { store: review.store },
        {
          name: entry.row.name,
          branch: entry.row.branch,
          path: entry.row.path,
        },
      ),
    );
    if (entry.snapshot) {
      await review.view(entry.snapshot);
    }
    page(
      `Pinned baseline: ${state.baseline!.commit}\nReference: ${picked.id}\n${entry.files?.length ?? "unknown"} changed files. A fresh source snapshot was captured for this scope.`,
      entry.row.path,
    );
    return;
  }

  if (selected === "working") {
    await review.view(snapshot);
    return browseDiff(entry.row.path, [
      {
        name: "Uncommitted source changes only",
        from: snapshot.headTree,
        to: snapshot.worktreeTree,
      },
      {
        name: "Staged content",
        from: snapshot.headTree,
        to: snapshot.indexTree,
      },
    ]);
  }

  if (selected === "checkpoints") {
    const points = [...review.load().checkpoints].reverse();
    if (points.length === 0) {
      page(
        "No saved checkpoints. Inspect the source and save a checkpoint first.",
        entry.row.path,
      );
      return;
    }
    const picked = await choose(
      points.map((point) => ({
        id: point.id,
        text: `${point.at} ${point.approved ? "approved" : "checkpoint"} ${point.label}`,
      })),
      entry.row.path,
      "Compare checkpoint",
      "Compare current captured source with an explicitly selected checkpoint · Esc back",
    );
    if (picked) {
      await review.view(snapshot);
      await browseDiff(
        entry.row.path,
        scopesFor(review, snapshot, review.lastCheckpoint(picked.id)),
      );
    }
    return;
  }

  review.requireBaseline();

  if (selected === "checkpoint" || selected === "approve") {
    const inspected = review.load().viewing;
    if (selected === "approve" && !inspected) {
      throw new Error("Inspect a review snapshot before approving it");
    }
    const point = await review.checkpoint(
      selected === "approve" ? review.snapshot(inspected!) : snapshot,
      selected === "approve",
    );
    page(
      `${selected === "approve" ? "Approved" : "Checkpoint saved"}: ${point.id}\nSnapshot: ${point.snapshot}`,
      entry.row.path,
    );
    return;
  }

  if (selected === "ready") {
    if (
      !snapshot.stable ||
      !snapshot.complete ||
      snapshot.conflicts.length > 0
    ) {
      throw new Error(
        "Only a stable, complete, conflict-free snapshot can be marked ready",
      );
    }
    review.saveSnapshot(snapshot);
    await review.update((state) => {
      state.ready = snapshot.fingerprint;
      state.history.push({
        at: now(),
        action: "Marked ready",
        snapshot: snapshot.id,
      });
    });
    return;
  }

  await review.view(snapshot);
  const scopes = scope ?? scopesFor(review, snapshot);

  if (selected === "diff") {
    for (const warning of entry.row.warnings) {
      console.error(visible(warning));
    }
    return browseDiff(entry.row.path, scopes);
  }
  if (selected === "since") {
    return browseDiff(
      entry.row.path,
      scopesFor(review, snapshot, review.lastCheckpoint()),
    );
  }

  const evidence = collectEvidence(review, snapshot, scopes);
  let analysis = latestAnalysis(review, snapshot);
  let error: string | undefined;

  if (
    !options.noAI &&
    (selected === "summary" ||
      selected === "ai-review" ||
      selected === "groups")
  ) {
    try {
      analysis = await analyse(
        review,
        snapshot,
        evidence,
        selected === "ai-review" ? "review" : "summary",
        options,
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  if (selected === "groups") {
    if (error) {
      page(
        `AI grouping unavailable: ${error}\nShowing uncategorised Git changes.`,
        entry.row.path,
      );
    }
    return groups(entry, evidence, analysis);
  }

  page(
    summaryText(scopedEntry(entry, scopes), analysis, error),
    entry.row.path,
  );
}

async function detail(
  entry: Entry,
  options: ReviewActionOptions,
): Promise<void> {
  if (entry.review && entry.snapshot) {
    await entry.review.view(entry.snapshot);
  }
  while (true) {
    const picked = await choose(
      [
        { id: "baseline", text: "Choose or change the fixed feature baseline" },
        { id: "summary", text: "Implementation summary" },
        { id: "groups", text: "Review by logical implementation area" },
        { id: "diff", text: "Complete feature diff (fixed baseline)" },
        { id: "since", text: "Changes since last checkpoint" },
        {
          id: "checkpoints",
          text: "Browse checkpoints and compare a selected one",
        },
        { id: "working", text: "Uncommitted changes (snapshot)" },
        { id: "ai-review", text: "Run independent AI review" },
        {
          id: "feedback",
          text: "Write feedback and resume the coding session",
        },
        { id: "editor", text: "Open in VS Code" },
        { id: "lazygit", text: "Open Lazygit (live working-tree view)" },
        { id: "checkpoint", text: "Save inspected checkpoint" },
        { id: "approve", text: "Approve this exact snapshot" },
        { id: "ready", text: "Mark ready for human review" },
        {
          id: "refresh",
          text: "Refresh this review snapshot from current source",
        },
      ],
      entry.row.path,
      "Review",
      `${visible(entry.row.name)} · ${entry.row.status} · ${entry.row.files ?? "?"} files +${entry.row.additions}/-${entry.row.deletions}\nSnapshot ${entry.snapshot?.id ?? "unavailable"} · Esc back`,
    );
    if (!picked) {
      return;
    }
    if (picked.id === "refresh" && entry.review) {
      entry = reviewEntry(
        { store: entry.review.store },
        {
          name: entry.row.name,
          branch: entry.row.branch,
          path: entry.row.path,
        },
      );
      if (entry.review && entry.snapshot) {
        await entry.review.view(entry.snapshot);
      }
      continue;
    }
    try {
      await action(entry, picked.id, options);
    } catch (error) {
      page(
        `Review action failed: ${error instanceof Error ? error.message : String(error)}`,
        entry.row.path,
      );
    }
  }
}

const FILTERS = ["all", "needs-review", "changed", "clean", "active", "ready"];

function filterRows(entries: Entry[], filter: string): Entry[] {
  return entries.filter(({ row }) => {
    switch (filter) {
      case "all":
        return true;
      case "needs-review":
        return row.status !== "Clean" && row.status !== "Reviewed";
      case "changed":
        return (row.sinceReview ?? 0) > 0;
      case "clean":
        return (
          row.files === 0 &&
          Boolean(row.baseline) &&
          (row.status === "Clean" || row.status === "Reviewed")
        );
      case "active":
        return row.activeObserved;
      default:
        return row.ready;
    }
  });
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [
      ...contextOptions,
      "base",
      "since",
      "snapshot",
      "filter",
      "provider",
      "profile",
      "label",
      "pr",
      "remote-interval",
    ],
    [
      "json",
      "summary",
      "diff",
      "since-last-review",
      "checkpoint",
      "checkpoints",
      "approve",
      "ready",
      "ai-review",
      "groups",
      "worktree-diff",
      "lazygit",
      "open",
      "no-ai",
      "interactive",
      "all",
      "live",
    ],
  );
  arity(positionals, 0, 1);

  const context = commandContext(values);
  const filter = String(values.filter ?? "all");
  if (!FILTERS.includes(filter)) {
    throw new UsageError(`Expected --filter ${FILTERS.join("|")}`);
  }

  const selectors = [
    "summary",
    "diff",
    "checkpoint",
    "checkpoints",
    "approve",
    "ready",
    "ai-review",
    "groups",
    "worktree-diff",
    "lazygit",
    "open",
  ].filter((name) => values[name]);

  if (selectors.length > 1) {
    throw new UsageError("Expected one review action at a time");
  }
  if (values.pr && !/^[1-9]\d*$/.test(String(values.pr))) {
    throw new UsageError("Expected --pr <positive PR number>");
  }
  if (values.pr && values.since) {
    throw new UsageError("Expected either --pr or --since");
  }
  if (values.live && (values.json || values.all || selectors.length > 0)) {
    throw new UsageError(
      "Expected --live without --json, --all or legacy actions",
    );
  }
  if (values.all && positionals.length > 0) {
    throw new UsageError("Expected --all without a worktree selector");
  }

  const remoteInterval = Number(values["remote-interval"] ?? 60);
  if (!Number.isFinite(remoteInterval) || remoteInterval < 10) {
    throw new UsageError("Expected --remote-interval of at least 10 seconds");
  }

  const revisionSince =
    typeof values.since === "string" &&
    !/^[a-f\d]{8}-[a-f\d-]{27}$/i.test(values.since);
  const isTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const useLive =
    !values.all &&
    !values.filter &&
    !values.interactive &&
    !values.json &&
    selectors.length === 0 &&
    !values.base &&
    !values.snapshot &&
    !values["since-last-review"] &&
    (!values.since || revisionSince) &&
    (isTerminal || Boolean(values.live));

  if (useLive || values.pr || revisionSince) {
    if (
      values.all ||
      values.snapshot ||
      values.base ||
      values["since-last-review"] ||
      selectors.some((s) => s !== "diff")
    ) {
      throw new UsageError(
        "Expected live review options without legacy snapshot actions",
      );
    }
    const root = positionals[0]
      ? resolveWorkspace(context, positionals[0]).path
      : reviewRoot(process.cwd(), context.repo);

    const liveOptions = {
      root,
      repository: context.repo,
      directory: context.store.root,
      defaultBase: context.defaultBase,
      since: revisionSince ? String(values.since) : undefined,
      pr: values.pr ? Number(values.pr) : undefined,
      remoteInterval: remoteInterval * 1000,
    };

    if ((isTerminal && !values.json && !values.diff) || values.live) {
      await liveReview(liveOptions);
    } else {
      const repository = new LiveRepository(root, context.repo);
      const state = repository.refresh();
      let mode: Mode = revisionSince
        ? { kind: "range", from: String(values.since), to: "HEAD" }
        : { kind: "working" };
      let pr;
      let warning: string | undefined;

      if (values.pr) {
        try {
          const github = new GhReviewService();
          pr = await github.discover(root, Number(values.pr));
          await github.ensureObjects(root, pr);
          mode = { kind: "branch", base: pr.baseRefOid, head: pr.headRefOid };
        } catch (error) {
          warning = String(error);
        }
      }

      const comparison = repository.comparison(mode, state);
      const files = repository.files(comparison, state);
      if (values.json) {
        json({
          root,
          snapshot: state.snapshot,
          commits:
            mode.kind === "branch" && pr
              ? repository.history(pr.headRefOid, pr.baseRefOid)
              : state.commits,
          comparison,
          files,
          pr,
          warning,
        });
      } else {
        if (warning) {
          console.error(warning);
        }
        console.log(comparison.label);
        for (const file of files) {
          console.log(repository.patch(file));
        }
      }
    }
    return 0;
  }

  if (values.base && values.snapshot) {
    throw new UsageError(
      "Expected either a current baseline change or a historical snapshot, not both",
    );
  }

  const options: ReviewActionOptions = {
    provider: values.provider as string | undefined,
    profile: values.profile as string | undefined,
    noAI: Boolean(values["no-ai"]),
  };

  if (
    positionals.length === 0 &&
    selectors.length === 0 &&
    !values.base &&
    !values["since-last-review"] &&
    !values.since &&
    !values.snapshot
  ) {
    let entries: Entry[] = [];
    const refresh = () => {
      const known = new Map(
        candidates(context.repo, context.managedDir, context.store).map(
          (item) => [item.path, item],
        ),
      );
      for (const [, data] of context.store.records()) {
        if (
          data.status === "active" &&
          data.worktree !== context.repo &&
          !known.has(data.worktree)
        ) {
          known.set(data.worktree, {
            name: inside(data.worktree, context.managedDir)
              ? path.relative(context.managedDir, data.worktree)
              : path.basename(data.worktree),
            branch: data.branch,
            path: data.worktree,
            locked: false,
          });
        }
      }
      entries = [...known.values()].map((item) => reviewEntry(context, item));
      entries.sort(
        (a, b) =>
          Number(!["Clean", "Reviewed"].includes(b.row.status)) -
            Number(!["Clean", "Reviewed"].includes(a.row.status)) ||
          Number(b.row.ready) - Number(a.row.ready) ||
          a.row.name.localeCompare(b.row.name),
      );
    };

    refresh();
    if (values.json || (!values.interactive && !isTerminal)) {
      const rows = filterRows(entries, filter).map((entry) => entry.row);
      if (values.json) {
        json({ repository: context.repo, filter, worktrees: rows });
      } else {
        console.log(
          [
            "RL REVIEW",
            ...rows.map(
              (row) =>
                `${visible(row.name).padEnd(32)} ${row.files ?? "?"} files +${row.additions}/-${row.deletions}  ${row.status}${row.branch !== row.name ? ` · ${visible(row.branch)}` : ""}  ${row.agent}${row.warnings.length > 0 ? ` · ${row.warnings.map(visible).join("; ")}` : ""}`,
            ),
          ].join("\n"),
        );
      }
      return 0;
    }

    const shortcutMap: Record<string, string> = {
      "alt-s": "summary",
      "alt-d": "diff",
      "alt-f": "feedback",
      "alt-a": "approve",
      "alt-o": "editor",
    };

    while (true) {
      const shown = filterRows(entries, filter);
      const picked = await choose(
        shown.map(({ row }) => {
          const name = visible(row.name);
          const label =
            name.length > 30 ? `${name.slice(0, 29)}…` : name.padEnd(30);
          return {
            id: row.id,
            text: `${label} ${String(row.files ?? "?").padStart(3)} files +${row.additions}/-${row.deletions}  ${row.status}  Δ${row.sinceReview ?? "?"}${row.branch !== row.name ? ` · ${row.branch}` : ""}  ${row.agent}  PR:${row.pr}`,
          };
        }),
        context.repo,
        "RL REVIEW",
        "WORKTREE                         CHANGES           REVIEW STATE / SINCE CHECKPOINT / AGENT / PR\nEnter review · Alt-S summary · Alt-D diff · Alt-F feedback · Alt-A approve · Alt-O editor\nCtrl-R refresh · Esc quit · statuses are snapshots, not live process monitoring",
        ["alt-s", "alt-d", "alt-f", "alt-a", "alt-o", "ctrl-r"],
      );
      if (!picked) {
        return 0;
      }
      if (picked.key === "ctrl-r") {
        refresh();
        continue;
      }
      const entry = shown.find((candidate) => candidate.row.id === picked.id)!;
      try {
        if (picked.key === "enter") {
          if (isTerminal && !values.interactive) {
            await liveReview({
              root: entry.row.path,
              repository: context.repo,
              directory: context.store.root,
              defaultBase: context.defaultBase,
              remoteInterval: remoteInterval * 1000,
            });
          } else {
            await detail(entry, options);
          }
        } else {
          await action(entry, shortcutMap[picked.key], options);
        }
      } catch (error) {
        page(
          `Review unavailable: ${error instanceof Error ? error.message : String(error)}`,
          context.repo,
        );
      }
      refresh();
    }
  }

  const target = resolveWorkspace(context, positionals[0]);
  const item = { ...target, name: target.name };
  const selectedReview = new ReviewStore(
    context.store,
    context.store.current(target.path),
  );
  if (typeof values.base === "string") {
    await selectedReview.setBaseline(values.base);
  }

  let entry = reviewEntry(context, item);
  if (!entry.review || !entry.snapshot) {
    throw new Error(entry.row.warnings.join("; "));
  }
  const review = entry.review;

  const snapshot =
    typeof values.snapshot === "string"
      ? review.snapshot(values.snapshot)
      : entry.snapshot;

  if (values.snapshot) {
    const current = entry.snapshot;
    entry = reviewEntry(context, item, snapshot);
    entry.row.status = "Historical snapshot";
    if (current.fingerprint !== snapshot.fingerprint) {
      entry.row.warnings.push(
        "Viewing a historical snapshot; current source differs from this saved version",
      );
    }
  } else {
    entry = { ...entry, snapshot };
  }

  if (values.checkpoints) {
    const checkpoints = review.load().checkpoints;
    if (values.json) {
      json(checkpoints);
    } else {
      console.log(
        checkpoints
          .map(
            (point) =>
              `${point.id} ${point.at} ${point.approved ? "approved" : "checkpoint"} ${point.label} · snapshot ${point.snapshot}`,
          )
          .join("\n") || "No review checkpoints saved.",
      );
    }
    return 0;
  }

  if (values.open) {
    await openEditor(target.path);
    return 0;
  }
  if (values.lazygit) {
    await lazygit(entry);
    return 0;
  }
  if (values.checkpoint || values.approve) {
    const selected =
      values.approve && !values.snapshot ? review.load().viewing : snapshot.id;
    if (!selected) {
      throw new Error(
        "Inspect a review snapshot before approving, using rl review <worktree> --diff or --summary",
      );
    }
    const point = await review.checkpoint(
      values.approve ? review.snapshot(selected) : snapshot,
      Boolean(values.approve),
      String(
        values.label ??
          (values.approve ? "User approval" : "Review checkpoint"),
      ),
    );
    if (values.json) {
      json(point);
    } else {
      console.log(
        `${point.approved ? "Approved" : "Checkpoint saved"}: ${point.id}\nSnapshot: ${point.snapshot}`,
      );
    }
    return 0;
  }

  if (values.ready) {
    await action(entry, "ready", options);
    if (values.json) {
      json({
        ready: true,
        snapshot: snapshot.id,
        fingerprint: snapshot.fingerprint,
      });
    } else {
      console.log("Marked this snapshot ready for human review.");
    }
    return 0;
  }

  const since =
    typeof values.since === "string"
      ? review.lastCheckpoint(values.since)
      : values["since-last-review"]
        ? review.lastCheckpoint()
        : undefined;

  if (
    selectors.length === 0 &&
    !values.json &&
    !since &&
    (Boolean(values.interactive) || isTerminal)
  ) {
    await detail(entry, options);
    return 0;
  }

  const scopes = values["worktree-diff"]
    ? [
        {
          name: "Uncommitted source changes",
          from: snapshot.headTree,
          to: snapshot.worktreeTree,
        },
        {
          name: "Staged content",
          from: snapshot.headTree,
          to: snapshot.indexTree,
        },
      ]
    : scopesFor(review, snapshot, since);

  await review.view(snapshot);
  entry = scopedEntry(entry, scopes);

  if (
    values.diff ||
    values["worktree-diff"] ||
    (since &&
      !values.summary &&
      !values["ai-review"] &&
      !values.groups &&
      !values.json)
  ) {
    for (const warning of entry.row.warnings) {
      console.error(visible(warning));
    }
    await browseDiff(target.path, scopes);
    return 0;
  }

  if (values.summary || values["ai-review"] || values.groups) {
    const evidence = collectEvidence(review, snapshot, scopes);
    let analysis: Analysis | undefined;
    let error: string | undefined;
    if (!values["no-ai"]) {
      try {
        analysis = await analyse(
          review,
          snapshot,
          evidence,
          values["ai-review"] ? "review" : "summary",
          options,
        );
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    if (values.groups && !values.json) {
      if (error) {
        page(error, target.path);
      }
      await groups(entry, evidence, analysis);
    } else if (values.json) {
      json({
        worktree: entry.row,
        snapshot,
        evidence,
        analysis: analysis ?? null,
        error: error ?? null,
        verifiedTestExecutions: [],
      });
    } else {
      page(summaryText(entry, analysis, error), target.path);
    }
    return values["ai-review"] && error ? 1 : 0;
  }

  if (values.json) {
    json({
      worktree: entry.row,
      snapshot,
      scopes,
      files: filesFor(target.path, scopes),
      review: review.load(),
    });
  } else if (Boolean(values.interactive) || isTerminal) {
    await detail(entry, options);
  } else {
    page(summaryText(entry), target.path);
  }
  return 0;
}
