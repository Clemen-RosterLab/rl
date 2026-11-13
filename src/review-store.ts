import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonical,
  inside,
  now,
  object,
  readJson,
  sessionId,
  writeJson,
} from "./common.js";
import {
  captureSnapshot,
  pinSnapshot,
  reviewGit,
  revision,
  type Snapshot,
} from "./review-git.js";
import {
  checkpointKey,
  saveCheckpoint as saveLiveCheckpoint,
} from "./review-live-engine.js";
import { pruneOrphanedSnapshot } from "./review/ref-gc.js";
import { ReviewStateSchema, SnapshotSchema } from "./schemas/review.js";
import type { Instance, RecordEntry, Store } from "./store.js";

export interface Checkpoint {
  id: string;
  snapshot: string;
  at: string;
  label: string;
  approved: boolean;
  pr?: number;
}

export interface Feedback {
  id: string;
  at: string;
  snapshot: string;
  fingerprint: string;
  text: string;
  agent?: "codex" | "claude" | "agy";
  sessionId?: string;
  status: "saved" | "opened" | "delivered" | "failed";
  error?: string;
  output?: string;
}

export interface ReviewState {
  version: 1;
  baseline?: {
    commit: string;
    ref: string;
    at: string;
    source: "creation" | "explicit";
  };
  viewing?: string;
  viewingFingerprint?: string;
  ready?: string;
  reviewedFingerprint?: string;
  approval?: { snapshot: string; fingerprint: string; at: string };
  checkpoints: Checkpoint[];
  feedback: Feedback[];
  analyses: {
    id: string;
    snapshot: string;
    at: string;
    kind: "summary" | "review";
    provider: string;
  }[];
  history: { at: string; action: string; snapshot?: string }[];
}

export type ReviewStatus =
  | "Clean"
  | "Unreviewed"
  | "Reviewing"
  | "Changes requested"
  | "Reviewed"
  | "Changed since review";

export class ReviewStore {
  readonly file: string;
  readonly data: Instance;
  readonly directory: string;

  constructor(
    readonly store: Store,
    entry: RecordEntry,
  ) {
    [this.file, this.data] = entry;
    this.directory = path.join(path.dirname(this.file), "reviews");
    this.path("state.json");
  }

  assertCurrent(): void {
    const [file, data] = this.store.current(this.data.worktree);
    if (file !== this.file || data.key !== this.data.key) {
      throw new Error("RL instance changed during review");
    }
  }

  path(relative: string): string {
    const target = path.join(this.directory, relative);
    if (
      !inside(target, this.directory) ||
      canonical(target) !== target ||
      canonical(this.directory) !== this.directory
    ) {
      throw new Error(
        "Review metadata must stay inside this RL instance without symlinks",
      );
    }
    return target;
  }

  load(): ReviewState {
    const file = this.path("state.json");
    if (!fs.existsSync(file)) {
      return {
        version: 1,
        ...(this.data.reviewBaseCommit
          ? {
              baseline: {
                commit: this.data.reviewBaseCommit,
                ref: String(this.data.baseBranch ?? this.data.reviewBaseCommit),
                at: this.data.createdAt,
                source: "creation" as const,
              },
            }
          : {}),
        checkpoints: [],
        feedback: [],
        analyses: [],
        history: [],
      };
    }

    const raw = readJson(file);
    const parsed = ReviewStateSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(issue?.message || "Invalid review metadata");
    }
    return parsed.data as ReviewState;
  }

  async update(change: (state: ReviewState) => void): Promise<ReviewState> {
    return this.store.locked(() => {
      this.assertCurrent();
      const state = this.load();
      change(state);
      writeJson(this.path("state.json"), state);
      return state;
    });
  }

  snapshot(id: string): Snapshot {
    sessionId(id);
    const raw = readJson(this.path(`snapshots/${id}.json`));
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id) {
      throw new Error("Invalid review snapshot");
    }
    return parsed.data as Snapshot;
  }

  saveSnapshot(snapshot: Snapshot): void {
    this.assertCurrent();
    if (snapshot.branch !== this.data.branch) {
      throw new Error("Branch changed during snapshot capture");
    }
    sessionId(snapshot.id);
    snapshot.baseline ??= this.load().baseline?.commit;
    pinSnapshot(this.data.worktree, this.data.key, snapshot);
    writeJson(this.path(`snapshots/${snapshot.id}.json`), snapshot);
  }

  async view(snapshot: Snapshot): Promise<void> {
    this.saveSnapshot(snapshot);
    let previousViewing: string | undefined;
    const nextState = await this.update((state) => {
      previousViewing = state.viewing;
      state.viewing = snapshot.id;
      state.viewingFingerprint = snapshot.fingerprint;
    });
    if (previousViewing && previousViewing !== snapshot.id) {
      pruneOrphanedSnapshot(
        this.directory,
        this.data.worktree,
        this.data.key,
        nextState,
        previousViewing,
      );
    }
  }

  async setBaseline(ref: string): Promise<ReviewState> {
    this.assertCurrent();
    const root = this.data.worktree;
    const selected = revision(root, ref);
    const head = revision(root, "HEAD");
    const commit = reviewGit(root, ["merge-base", selected, head]).trim();

    let previousViewing: string | undefined;
    const nextState = await this.update((state) => {
      reviewGit(root, [
        "update-ref",
        `refs/rl/review-baselines/${this.data.key}`,
        commit,
      ]);
      previousViewing = state.viewing;
      state.baseline = { commit, ref, at: now(), source: "explicit" };
      delete state.approval;
      delete state.viewing;
      delete state.viewingFingerprint;
      delete state.ready;
      state.history.push({
        at: now(),
        action: `Baseline explicitly set to ${commit} from ${ref}`,
      });
    });

    if (previousViewing) {
      pruneOrphanedSnapshot(
        this.directory,
        this.data.worktree,
        this.data.key,
        nextState,
        previousViewing,
      );
    }
    return nextState;
  }

  requireBaseline(): NonNullable<ReviewState["baseline"]> {
    const baseline = this.load().baseline;
    if (!baseline) {
      throw new Error(
        "No recorded feature baseline. Choose one explicitly: rl review <worktree> --base <branch-or-commit>",
      );
    }
    revision(this.data.worktree, baseline.commit);
    return baseline;
  }

  async checkpoint(
    snapshot: Snapshot,
    approved = false,
    label = "Review checkpoint",
  ): Promise<Checkpoint> {
    const baseline = this.requireBaseline();
    if (snapshot.baseline && snapshot.baseline !== baseline.commit) {
      throw new Error(
        "The feature baseline changed after this snapshot; inspect the current feature scope before checkpointing or approving",
      );
    }
    if (
      !snapshot.stable ||
      !snapshot.complete ||
      snapshot.conflicts.length > 0
    ) {
      throw new Error(
        "Cannot checkpoint an unstable, incomplete or conflicted snapshot; resolve the reported limitations first",
      );
    }

    this.saveSnapshot(snapshot);
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      snapshot: snapshot.id,
      at: now(),
      label,
      approved,
    };

    await this.update((state) => {
      if (state.baseline?.commit !== snapshot.baseline) {
        throw new Error(
          "Feature baseline changed while saving the checkpoint; inspect the new scope first",
        );
      }
      // Validate once under the metadata lock, including changes made while waiting for it.
      const observed = captureSnapshot(this.data.worktree);
      if (
        !observed.stable ||
        !observed.complete ||
        observed.fingerprint !== snapshot.fingerprint
      ) {
        throw new Error(
          "Source changed since the review snapshot; refresh before checkpointing or approving",
        );
      }
      state.checkpoints.push(checkpoint);
      state.viewing = snapshot.id;
      state.viewingFingerprint = snapshot.fingerprint;
      if (approved) {
        state.approval = {
          snapshot: snapshot.id,
          fingerprint: snapshot.fingerprint,
          at: checkpoint.at,
        };
      }
      state.history.push({
        at: checkpoint.at,
        action: approved ? "Approved" : "Checkpoint saved",
        snapshot: snapshot.id,
      });
    });

    saveLiveCheckpoint(
      this.data.worktree,
      this.store.root,
      checkpointKey(this.data.worktree, snapshot.branch),
      {
        branch: snapshot.branch,
        head: snapshot.head,
        tree: snapshot.worktreeTree,
        index: snapshot.indexTree,
        label,
      },
    );
    return checkpoint;
  }

  async recordLiveCheckpoint(
    snapshot: Snapshot,
    label: string,
    pr?: number,
  ): Promise<void> {
    this.saveSnapshot(snapshot);
    await this.update((state) => {
      state.checkpoints.push({
        id: randomUUID(),
        snapshot: snapshot.id,
        at: now(),
        label,
        approved: false,
        ...(pr ? { pr } : {}),
      });
      state.viewing = snapshot.id;
      state.viewingFingerprint = snapshot.fingerprint;
      state.reviewedFingerprint = snapshot.fingerprint;
      if (state.approval?.fingerprint !== snapshot.fingerprint) {
        delete state.approval;
      }
      state.history.push({
        at: now(),
        action: "Live checkpoint saved",
        snapshot: snapshot.id,
      });
    });
  }

  lastCheckpoint(id?: string): Snapshot {
    const checkpoints = this.load().checkpoints;
    const checkpoint = id
      ? checkpoints.find((item) => item.id === id || item.snapshot === id)
      : checkpoints.filter((item) => item.pr === undefined).at(-1);
    if (!checkpoint) {
      throw new Error(
        "No matching review checkpoint. Save one with rl review <worktree> --checkpoint",
      );
    }
    return this.snapshot(checkpoint.snapshot);
  }
}

/** Read-only hook context, scoped to the already validated instance directory. */
export function pendingReviewFeedback(
  instanceFile: string,
): string | undefined {
  const directory = path.dirname(instanceFile);
  const file = path.join(directory, "reviews/state.json");
  if (
    canonical(file) !== file ||
    !inside(file, directory) ||
    !fs.existsSync(file)
  ) {
    return undefined;
  }
  try {
    const state = readJson(file);
    if (!Array.isArray(state.feedback)) {
      return undefined;
    }
    const pending = state.feedback
      .filter(
        (item) =>
          object(item) &&
          ["saved", "failed"].includes(String(item.status)) &&
          typeof item.text === "string",
      )
      .slice(-3);
    if (pending.length === 0) {
      return undefined;
    }
    return (
      "Pending human review feedback (saved locally; do not treat it as an approval):\n" +
      pending
        .map(
          (item) =>
            `${item.id} · snapshot ${item.snapshot}\n${String(item.text).slice(0, 8000)}`,
        )
        .join("\n\n")
    );
  } catch {
    return undefined;
  }
}

export function reviewStatus(
  state: ReviewState,
  snapshot: Snapshot,
  changed: number,
): ReviewStatus {
  if (state.approval) {
    return state.approval.fingerprint === snapshot.fingerprint
      ? "Reviewed"
      : "Changed since review";
  }
  const latestFeedback = state.feedback.at(-1);
  if (latestFeedback) {
    return latestFeedback.fingerprint === snapshot.fingerprint
      ? "Changes requested"
      : "Changed since review";
  }
  if (state.reviewedFingerprint) {
    return state.reviewedFingerprint === snapshot.fingerprint
      ? "Reviewed"
      : "Changed since review";
  }
  if (!changed) {
    return "Clean";
  }
  return state.viewingFingerprint === snapshot.fingerprint
    ? "Reviewing"
    : "Unreviewed";
}
