import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonical,
  inside,
  now,
  object,
  readJson,
  sessionId,
  writeJson,
} from "./common.js";
import type { Store, Instance, RecordEntry } from "./store.js";
import {
  OID,
  captureSnapshot,
  pinSnapshot,
  reviewGit,
  revision,
  type Snapshot,
} from "./review-git.js";

export interface Checkpoint {
  id: string;
  snapshot: string;
  at: string;
  label: string;
  approved: boolean;
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
    if (file !== this.file || data.key !== this.data.key)
      throw new Error("RL instance changed during review");
  }
  path(relative: string): string {
    const target = path.join(this.directory, relative);
    if (
      !inside(target, this.directory) ||
      canonical(target) !== target ||
      canonical(this.directory) !== this.directory
    )
      throw new Error(
        "Review metadata must stay inside this RL instance without symlinks",
      );
    return target;
  }
  load(): ReviewState {
    const file = this.path("state.json");
    if (!fs.existsSync(file))
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
    const raw = readJson(file);
    if (
      raw.version !== 1 ||
      !Array.isArray(raw.checkpoints) ||
      !Array.isArray(raw.feedback) ||
      !Array.isArray(raw.analyses) ||
      !Array.isArray(raw.history)
    )
      throw new Error("Invalid review metadata");
    if (
      raw.baseline &&
      (!object(raw.baseline) ||
        typeof raw.baseline.commit !== "string" ||
        !OID.test(raw.baseline.commit))
    )
      throw new Error("Invalid review baseline");
    for (const item of raw.checkpoints) {
      if (
        !object(item) ||
        typeof item.snapshot !== "string" ||
        typeof item.at !== "string" ||
        typeof item.label !== "string" ||
        typeof item.approved !== "boolean"
      )
        throw new Error("Invalid review checkpoint");
      sessionId(item.id);
      sessionId(item.snapshot);
    }
    for (const item of raw.feedback) {
      if (
        !object(item) ||
        typeof item.text !== "string" ||
        !["saved", "opened", "delivered", "failed"].includes(
          String(item.status),
        )
      )
        throw new Error("Invalid review feedback");
      sessionId(item.id);
      sessionId(item.snapshot);
      if (
        typeof item.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.fingerprint)
      )
        throw new Error("Invalid feedback snapshot fingerprint");
      if (
        item.agent !== undefined &&
        !["codex", "claude", "agy"].includes(String(item.agent))
      )
        throw new Error("Invalid feedback agent");
      if (item.sessionId !== undefined) sessionId(item.sessionId);
    }
    for (const entry of raw.analyses) {
      if (
        !object(entry) ||
        !["summary", "review"].includes(String(entry.kind)) ||
        !["codex", "claude", "agy"].includes(String(entry.provider))
      )
        throw new Error("Invalid review analysis metadata");
      sessionId(entry.id);
      sessionId(entry.snapshot);
    }
    if (raw.viewing !== undefined) sessionId(raw.viewing);
    if (raw.approval !== undefined) {
      if (
        !object(raw.approval) ||
        typeof raw.approval.fingerprint !== "string" ||
        typeof raw.approval.at !== "string"
      )
        throw new Error("Invalid review approval");
      sessionId(raw.approval.snapshot);
    }
    return raw as unknown as ReviewState;
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
    const value = readJson(this.path(`snapshots/${id}.json`));
    if (
      value.id !== id ||
      typeof value.fingerprint !== "string" ||
      typeof value.stable !== "boolean" ||
      typeof value.complete !== "boolean"
    )
      throw new Error("Invalid review snapshot");
    for (const name of ["head", "headTree", "indexTree", "worktreeTree"])
      if (typeof value[name] !== "string" || !OID.test(value[name] as string))
        throw new Error("Invalid snapshot Git object");
    if (
      value.baseline !== undefined &&
      (typeof value.baseline !== "string" || !OID.test(value.baseline))
    )
      throw new Error("Invalid snapshot baseline");
    if (
      !Array.isArray(value.stages) ||
      value.stages.some((oid) => typeof oid !== "string" || !OID.test(oid)) ||
      !Array.isArray(value.excluded) ||
      !Array.isArray(value.conflicts)
    )
      throw new Error("Invalid snapshot contents");
    return value as unknown as Snapshot;
  }
  saveSnapshot(snapshot: Snapshot): void {
    this.assertCurrent();
    if (snapshot.branch !== this.data.branch)
      throw new Error("Branch changed during snapshot capture");
    sessionId(snapshot.id);
    snapshot.baseline ??= this.load().baseline?.commit;
    pinSnapshot(this.data.worktree, this.data.key, snapshot);
    writeJson(this.path(`snapshots/${snapshot.id}.json`), snapshot);
  }
  async view(snapshot: Snapshot): Promise<void> {
    this.saveSnapshot(snapshot);
    await this.update((state) => {
      state.viewing = snapshot.id;
      state.viewingFingerprint = snapshot.fingerprint;
    });
  }
  async setBaseline(ref: string): Promise<ReviewState> {
    this.assertCurrent();
    const root = this.data.worktree,
      selected = revision(root, ref),
      head = revision(root, "HEAD");
    const commit = reviewGit(root, ["merge-base", selected, head]).trim();
    return this.update((state) => {
      reviewGit(root, [
        "update-ref",
        `refs/rl/review-baselines/${this.data.key}`,
        commit,
      ]);
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
  }
  requireBaseline(): NonNullable<ReviewState["baseline"]> {
    const baseline = this.load().baseline;
    if (!baseline)
      throw new Error(
        "No recorded feature baseline. Choose one explicitly: rl review <worktree> --base <branch-or-commit>",
      );
    revision(this.data.worktree, baseline.commit);
    return baseline;
  }
  async checkpoint(
    snapshot: Snapshot,
    approved = false,
    label = "Review checkpoint",
  ): Promise<Checkpoint> {
    const baseline = this.requireBaseline();
    if (snapshot.baseline && snapshot.baseline !== baseline.commit)
      throw new Error(
        "The feature baseline changed after this snapshot; inspect the current feature scope before checkpointing or approving",
      );
    if (!snapshot.stable || !snapshot.complete || snapshot.conflicts.length)
      throw new Error(
        "Cannot checkpoint an unstable, incomplete or conflicted snapshot; resolve the reported limitations first",
      );
    this.saveSnapshot(snapshot);
    const current = captureSnapshot(this.data.worktree);
    if (
      current.fingerprint !== snapshot.fingerprint ||
      !current.stable ||
      !current.complete
    )
      throw new Error(
        "Source changed since the review snapshot; refresh before checkpointing or approving",
      );
    const checkpoint = {
      id: randomUUID(),
      snapshot: snapshot.id,
      at: now(),
      label,
      approved,
    };
    await this.update((state) => {
      if (state.baseline?.commit !== snapshot.baseline)
        throw new Error(
          "Feature baseline changed while saving the checkpoint; inspect the new scope first",
        );
      const observed = captureSnapshot(this.data.worktree);
      if (
        !observed.stable ||
        !observed.complete ||
        observed.fingerprint !== snapshot.fingerprint
      )
        throw new Error(
          "Source changed before the review checkpoint was saved; refresh and review it again",
        );
      state.checkpoints.push(checkpoint);
      state.viewing = snapshot.id;
      state.viewingFingerprint = snapshot.fingerprint;
      if (approved)
        state.approval = {
          snapshot: snapshot.id,
          fingerprint: snapshot.fingerprint,
          at: checkpoint.at,
        };
      state.history.push({
        at: checkpoint.at,
        action: approved ? "Approved" : "Checkpoint saved",
        snapshot: snapshot.id,
      });
    });
    return checkpoint;
  }
  lastCheckpoint(id?: string): Snapshot {
    const checkpoints = this.load().checkpoints;
    const checkpoint = id
      ? checkpoints.find((item) => item.id === id || item.snapshot === id)
      : checkpoints.at(-1);
    if (!checkpoint)
      throw new Error(
        "No matching review checkpoint. Save one with rl review <worktree> --checkpoint",
      );
    return this.snapshot(checkpoint.snapshot);
  }
}

/** Read-only hook context, scoped to the already validated instance directory. */
export function pendingReviewFeedback(
  instanceFile: string,
): string | undefined {
  const directory = path.dirname(instanceFile),
    file = path.join(directory, "reviews/state.json");
  if (
    canonical(file) !== file ||
    !inside(file, directory) ||
    !fs.existsSync(file)
  )
    return undefined;
  try {
    const state = readJson(file);
    if (!Array.isArray(state.feedback)) return undefined;
    const pending = state.feedback
      .filter(
        (item) =>
          object(item) &&
          ["saved", "failed"].includes(String(item.status)) &&
          typeof item.text === "string",
      )
      .slice(-3);
    if (!pending.length) return undefined;
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
  if (state.approval)
    return state.approval.fingerprint === snapshot.fingerprint
      ? "Reviewed"
      : "Changed since review";
  const feedback = state.feedback.at(-1);
  if (feedback)
    return feedback.fingerprint === snapshot.fingerprint
      ? "Changes requested"
      : "Changed since review";
  if (!changed) return "Clean";
  return state.viewingFingerprint === snapshot.fingerprint
    ? "Reviewing"
    : "Unreviewed";
}
