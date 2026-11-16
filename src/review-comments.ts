import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { canonical, isSymlink, object, readJson, writeJson } from "./common.js";
import { runGh } from "./github/client.js";
import { OID } from "./review-git.js";
import type { PullRequest } from "./review-github.js";

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export interface InlineDraft {
  id: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}
export interface ReviewDraft {
  version: 1;
  revision: string;
  url: string;
  head: string;
  base: string;
  body: string;
  comments: InlineDraft[];
  attempt?: { token: string; event: ReviewEvent };
}
export interface SubmittedReview {
  id: number;
  html_url: string;
  state: string;
}
export interface ReviewCommentService {
  validate(
    pr: PullRequest,
    comments: InlineDraft[],
    signal?: AbortSignal,
  ): Promise<void>;
  submit(
    pr: PullRequest,
    draft: ReviewDraft,
    event: ReviewEvent,
    token: string,
    signal?: AbortSignal,
    beforePost?: () => Promise<void>,
  ): Promise<SubmittedReview>;
  findSubmission(
    pr: PullRequest,
    token: string,
    signal?: AbortSignal,
  ): Promise<SubmittedReview | undefined>;
}

function identity(pr: Pick<PullRequest, "url" | "number">) {
  const url = new URL(pr.url);
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    Number(match[3]) !== pr.number ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    match.slice(1, 3).some((p) => p === "." || p === "..")
  )
    throw new Error("Invalid PR identity for GitHub review");
  return {
    url: `${url.origin}/${match[1]}/${match[2]}/pull/${pr.number}`.toLowerCase(),
    host: url.host,
    endpoint: `repos/${match[1]}/${match[2]}/pulls/${pr.number}`,
  };
}
export function emptyReviewDraft(pr: PullRequest): ReviewDraft {
  return {
    version: 1,
    revision: randomUUID(),
    url: identity(pr).url,
    head: pr.headRefOid,
    base: pr.baseRefOid,
    body: "",
    comments: [],
  };
}
function validComment(value: unknown): value is InlineDraft {
  return (
    object(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    !value.path.includes("\0") &&
    Number.isSafeInteger(value.line) &&
    Number(value.line) > 0 &&
    (value.side === "LEFT" || value.side === "RIGHT") &&
    typeof value.body === "string" &&
    value.body.trim().length > 0 &&
    value.body.length <= 60000
  );
}
function validateDraft(
  value: unknown,
  url: string,
): asserts value is ReviewDraft {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.revision !== "string" ||
    value.url !== url ||
    typeof value.head !== "string" ||
    !OID.test(value.head) ||
    typeof value.base !== "string" ||
    !OID.test(value.base) ||
    typeof value.body !== "string" ||
    value.body.length > 60000 ||
    !Array.isArray(value.comments) ||
    value.comments.length > 100 ||
    !value.comments.every(validComment) ||
    new Set(value.comments.map((c) => c.id)).size !== value.comments.length ||
    (value.attempt !== undefined &&
      (!object(value.attempt) ||
        typeof value.attempt.token !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value.attempt.token) ||
        !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(
          String(value.attempt.event),
        )))
  )
    throw new Error(
      "Invalid saved PR review draft; the draft file was left unchanged",
    );
}

/** Private, atomic local drafts. A revision check prevents two TUIs overwriting each other. */
export class ReviewDraftStore {
  readonly file: string;
  private readonly url: string;
  constructor(
    directory: string,
    private readonly pr: PullRequest,
  ) {
    this.url = identity(pr).url;
    this.file = path.resolve(
      directory,
      "live-review",
      "comments",
      `${createHash("sha256").update(this.url).digest("hex")}.json`,
    );
    this.assertPath();
  }
  private assertPath(): void {
    if (isSymlink(this.file) || canonical(this.file) !== this.file)
      throw new Error("PR review drafts must not traverse symlinks");
  }
  load(): ReviewDraft {
    this.assertPath();
    if (!fs.existsSync(this.file)) return emptyReviewDraft(this.pr);
    const value = readJson(this.file);
    validateDraft(value, this.url);
    return value;
  }
  async update(
    expected: ReviewDraft,
    action: (draft: ReviewDraft) => void,
  ): Promise<ReviewDraft> {
    this.assertPath();
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // Never keep the terminal alive retrying a lock held by another reviewer.
    const release = await lockfile.lock(path.dirname(this.file), {
      realpath: false,
      lockfilePath: `${this.file}.lock`,
      stale: 120000,
      retries: 0,
    });
    try {
      this.assertPath();
      const current = fs.existsSync(this.file) ? this.load() : expected;
      if (current.revision !== expected.revision)
        throw new Error(
          "Review draft changed in another session; press D to reload it",
        );
      const next = structuredClone(current);
      action(next);
      next.revision = randomUUID();
      validateDraft(next, this.url);
      writeJson(this.file, next);
      return next;
    } finally {
      await release();
    }
  }
}

/** Only actual hunk lines are commentable. Missing/truncated/binary patches fail closed. */
export function patchHasReviewLine(
  patch: string,
  line: number,
  side: "LEFT" | "RIGHT",
): boolean {
  let old = 0,
    next = 0,
    oldLeft = 0,
    nextLeft = 0;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[3]);
      oldLeft = Number(hunk[2] ?? 1);
      nextLeft = Number(hunk[4] ?? 1);
      continue;
    }
    if (text.startsWith("\\")) continue;
    if (text.startsWith("+") && nextLeft > 0) {
      if (side === "RIGHT" && next === line) return true;
      next++;
      nextLeft--;
    } else if (text.startsWith("-") && oldLeft > 0) {
      if (side === "LEFT" && old === line) return true;
      old++;
      oldLeft--;
    } else if (text.startsWith(" ") && oldLeft > 0 && nextLeft > 0) {
      if ((side === "LEFT" ? old : next) === line) return true;
      old++;
      next++;
      oldLeft--;
      nextLeft--;
    } else {
      oldLeft = nextLeft = 0;
    }
  }
  return false;
}

/** All writes are explicit review submissions; discovery and validation stay read-only. */
export class GhReviewComments implements ReviewCommentService {
  constructor(private readonly root: string) {}
  private async api(
    pr: PullRequest,
    suffix: string,
    signal?: AbortSignal,
    payload?: unknown,
  ): Promise<unknown> {
    const target = identity(pr);
    const result = await runGh(
      this.root,
      [
        "api",
        "--hostname",
        target.host,
        "--method",
        payload === undefined ? "GET" : "POST",
        "-H",
        "Accept: application/vnd.github+json",
        `${target.endpoint}${suffix}`,
        ...(payload === undefined ? [] : ["--input", "-"]),
      ],
      {
        input: payload === undefined ? undefined : JSON.stringify(payload),
        signal,
        timeoutMs: 15000,
        maxOutputBytes: 16 * 1024 * 1024,
        processGroup: true,
        abortGraceMs: 0,
        respectOffline: true,
      },
    );
    if (result.code)
      throw new Error(result.stderr.trim() || "GitHub review request failed");
    return JSON.parse(result.stdout);
  }
  private async current(pr: PullRequest, signal?: AbortSignal): Promise<void> {
    const value = await this.api(pr, "", signal);
    if (
      !object(value) ||
      value.number !== pr.number ||
      typeof value.html_url !== "string" ||
      identity({ url: value.html_url, number: pr.number }).url !==
        identity(pr).url ||
      !object(value.head) ||
      !object(value.base)
    )
      throw new Error("GitHub returned a different PR identity");
    if (value.head.sha !== pr.headRefOid || value.base.sha !== pr.baseRefOid)
      throw new Error(
        "PR revision changed; refresh with Ctrl-r and review the latest PR before commenting",
      );
    if (value.state !== "open")
      throw new Error("This PR is closed; review submission is unavailable");
  }
  async validate(
    pr: PullRequest,
    comments: InlineDraft[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (comments.length > 100 || !comments.every(validComment))
      throw new Error("Invalid inline review comments");
    await this.current(pr, signal);
    const pending = new Set(comments);
    for (let page = 1; pending.size && page <= 30; page++) {
      const files = await this.api(
        pr,
        `/files?per_page=100&page=${page}`,
        signal,
      );
      if (
        !Array.isArray(files) ||
        files.some((file) => !object(file) || typeof file.filename !== "string")
      )
        throw new Error("Invalid GitHub PR files response");
      for (const comment of pending) {
        const file = files.find((f) => f.filename === comment.path);
        if (!file) continue;
        if (
          typeof file.patch !== "string" ||
          !patchHasReviewLine(file.patch, comment.line, comment.side)
        )
          throw new Error(
            `${comment.path}:${comment.line} (${comment.side}) is outside GitHub's current review diff; binary or omitted patches cannot receive inline comments`,
          );
        pending.delete(comment);
      }
      if (files.length < 100) break;
    }
    if (pending.size)
      throw new Error(
        "A comment's file is missing from GitHub's PR diff (or exceeds its file limit)",
      );
    // Detect head/base changes while paginating, not just before it.
    await this.current(pr, signal);
  }
  async submit(
    pr: PullRequest,
    draft: ReviewDraft,
    event: ReviewEvent,
    token: string,
    signal?: AbortSignal,
    beforePost?: () => Promise<void>,
  ): Promise<SubmittedReview> {
    validateDraft(draft, identity(pr).url);
    if (draft.attempt)
      throw new Error(
        "Previous review submission needs verification before retrying",
      );
    if (
      !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(event) ||
      !/^[a-f0-9-]{36}$/.test(token)
    )
      throw new Error("Invalid review submission");
    if (draft.head !== pr.headRefOid || draft.base !== pr.baseRefOid)
      throw new Error(
        "Draft belongs to an older PR revision; inspect or discard it with D before starting a new draft",
      );
    if (event === "REQUEST_CHANGES" && !draft.body.trim())
      throw new Error("Request changes requires a review summary");
    if (event === "COMMENT" && !draft.body.trim() && !draft.comments.length)
      throw new Error("Write a comment or review summary first");
    await this.validate(pr, draft.comments, signal);
    await beforePost?.();
    const value = await this.api(pr, "/reviews", signal, {
      commit_id: draft.head,
      event,
      body: `${draft.body.trim()}\n\n<!-- rl-review:${token} -->`.trim(),
      comments: draft.comments.map(({ path: filename, line, side, body }) => ({
        path: filename,
        line,
        side,
        body,
      })),
    });
    return this.result(pr, value);
  }
  private result(pr: PullRequest, value: unknown): SubmittedReview {
    const expected = identity(pr).url;
    if (
      !object(value) ||
      !Number.isSafeInteger(value.id) ||
      Number(value.id) < 1 ||
      typeof value.html_url !== "string" ||
      !value.html_url
        .toLowerCase()
        .startsWith(`${expected}#pullrequestreview-`) ||
      !["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(
        String(value.state),
      )
    )
      throw new Error(
        "GitHub review response could not be verified; check GitHub before retrying",
      );
    return value as unknown as SubmittedReview;
  }
  async findSubmission(
    pr: PullRequest,
    token: string,
    signal?: AbortSignal,
  ): Promise<SubmittedReview | undefined> {
    for (let page = 1; page <= 100; page++) {
      const reviews = await this.api(
        pr,
        `/reviews?per_page=100&page=${page}`,
        signal,
      );
      if (!Array.isArray(reviews))
        throw new Error("Invalid GitHub review history");
      const found = reviews.find(
        (r) =>
          object(r) &&
          typeof r.body === "string" &&
          r.body.includes(`<!-- rl-review:${token} -->`),
      );
      if (found) return this.result(pr, found);
      if (reviews.length < 100) return undefined;
    }
    throw new Error(
      "Cannot verify previous submission: review history limit reached",
    );
  }
}
