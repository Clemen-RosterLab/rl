import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonical, git, inside, now, object, sessionId } from "./common.js";
import {
  evaluate,
  RESULT_SCHEMA,
  validateResult,
  type ReviewResult,
} from "./review-policy.js";
import type { JsonObject } from "./json.js";
import type { Stage, WorkflowRun } from "./agent-runner.js";

interface Consultation {
  id: string;
  from: string;
  to: string;
  event: string;
  subject: string;
  question: string;
  createdAt: string;
  answer?: { text: string; at: string };
}
interface Submission {
  id: string;
  writer: string;
  reviewer: string;
  files: string[];
  newFunctions: string[];
  summary: string;
  fingerprint: string;
  snapshot: string;
  createdAt: string;
  round: number;
  supersededBy?: string;
  review?: {
    rating: number;
    rationale: string;
    result: ReviewResult;
    duplicateSuspicions: string[];
    accepted: boolean;
    at: string;
  };
}
export interface CollaborationState {
  consultations: Consultation[];
  submissions: Submission[];
  baseline: Record<string, string>;
}
export interface WorkflowTool {
  name: string;
  description: string;
  properties: JsonObject;
  required: string[];
  readOnly: boolean;
}
const participant = {
  run: { type: "string" },
  step: { type: "string" },
  claim: { type: "string" },
};
const strings = { type: "array", items: { type: "string" }, maxItems: 256 };
export const COLLABORATION_TOOLS: WorkflowTool[] = [
  {
    name: "rl_workflow_bind",
    description:
      "Bind a claimed role to the native child your current session spawned. Spawn and bind all three peers before implementation; the peers are reused for the whole task.",
    properties: { ...participant, childId: { type: "string" } },
    required: ["run", "step", "claim", "childId"],
    readOnly: false,
  },
  {
    name: "rl_workflow_inbox",
    description:
      "Read this native peer's consultations, writer submissions, reviewer ratings and peer handles. Wait using native messaging/wait tools or the parent relay; avoid busy polling.",
    properties: participant,
    required: ["run", "step", "claim"],
    readOnly: true,
  },
  {
    name: "rl_workflow_consult",
    description:
      "Ask an existing peer for evidence through a configured route. Writer must consult DRY before a new function; reviewer must consult DRY on a suspected duplicate. Wait for the response.",
    properties: {
      ...participant,
      to: { type: "string" },
      event: { type: "string" },
      subject: { type: "string" },
      question: { type: "string" },
    },
    required: ["run", "step", "claim", "to", "event", "subject", "question"],
    readOnly: false,
  },
  {
    name: "rl_workflow_answer",
    description:
      "Answer a consultation addressed to this existing peer. Include concrete paths/symbols, reuse evidence and limitations; the requester receives the response in its inbox.",
    properties: {
      ...participant,
      requestId: { type: "string" },
      text: { type: "string" },
    },
    required: ["run", "step", "claim", "requestId", "text"],
    readOnly: false,
  },
  {
    name: "rl_workflow_submit",
    description:
      "Writer submits a stable file group to its existing reviewer. Declare all new functions as path#function subjects; required DRY answers are checked. Freeze these files until reviewed, while continuing on unrelated files.",
    properties: {
      ...participant,
      files: strings,
      newFunctions: strings,
      summary: { type: "string" },
      supersedes: strings,
    },
    required: ["run", "step", "claim", "files", "newFunctions", "summary"],
    readOnly: false,
  },
  {
    name: "rl_workflow_review",
    description:
      "Reviewer returns a rating, rationale and evidence for a writer checkpoint. Declare suspected duplicates; required DRY answers are checked before accepting the rating. Changed or superseded checkpoints are rejected.",
    properties: {
      ...participant,
      submissionId: { type: "string" },
      rating: { type: "number" },
      rationale: { type: "string" },
      result: RESULT_SCHEMA,
      duplicateSuspicions: strings,
    },
    required: [
      "run",
      "step",
      "claim",
      "submissionId",
      "rating",
      "rationale",
      "result",
      "duplicateSuspicions",
    ],
    readOnly: false,
  },
];

function prose(value: unknown, label: string, max = 16000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(value)
  )
    throw new Error(`Expected ${label}`);
  return value;
}
function list(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !item ||
        item.length > 512 ||
        /[\x00-\x1f]/.test(item),
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error(`Expected unique ${label}`);
  return value;
}
function sourcePath(value: string): string {
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new Error(
      "Checkpoint paths must be relative files inside this workspace",
    );
  return value;
}
function blob(workspace: string, ref: string): string | null {
  try {
    return git(workspace, "rev-parse", "--verify", "--end-of-options", ref);
  } catch {
    return null;
  }
}
function checkpoint(run: WorkflowRun, files: string[]) {
  let bytes = 0;
  const versions = files.map((file) => {
    sourcePath(file);
    const absolute = path.join(run.workspace, file);
    if (!inside(canonical(absolute), run.workspace))
      throw new Error("Checkpoint path escapes the workspace");
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stat && !stat.isFile() && !stat.isSymbolicLink())
      throw new Error("Checkpoints contain files, not directories");
    if (stat && (bytes += stat.size) > 4 * 1024 * 1024)
      throw new Error("Checkpoint exceeds 4 MiB");
    const content = stat
      ? stat.isSymbolicLink()
        ? fs.readlinkSync(absolute)
        : fs.readFileSync(absolute).toString("base64")
      : null;
    const baseOid = blob(run.workspace, `${run.scope.baseCommit}:${file}`),
      indexOid = blob(run.workspace, `:${file}`);
    if (
      !stat &&
      !baseOid &&
      !indexOid &&
      !Object.hasOwn(run.collaboration?.baseline ?? {}, file)
    )
      throw new Error(`Checkpoint file does not exist: ${file}`);
    return {
      file,
      kind: !stat ? "deleted" : stat.isSymbolicLink() ? "symlink" : "file",
      mode: stat ? stat.mode & 0o777 : null,
      content,
      baseOid,
      indexOid,
    };
  });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(versions))
    .digest("hex");
  return { workspace: run.workspace, files, versions, fingerprint };
}
function state(run: WorkflowRun): CollaborationState {
  if (!run.config.workflows[run.workflow].collaboration)
    throw new Error("This workflow does not configure collaborating peers");
  if (!run.collaboration)
    throw new Error("Collaborative workflow state is missing");
  return run.collaboration;
}
export function initializeCollaboration(run: WorkflowRun): void {
  if (!run.config.workflows[run.workflow].collaboration) return;
  run.collaboration = {
    consultations: [],
    submissions: [],
    baseline: Object.fromEntries(
      run.scope.files.map((file) => [
        file,
        checkpoint(run, [file]).fingerprint,
      ]),
    ),
  };
}
function peersReady(run: WorkflowRun): void {
  const roles = run.config.workflows[run.workflow].collaboration!;
  for (const id of [roles.writer, roles.reviewer, roles.dry])
    if (
      !run.stages.some(
        (stage) =>
          stage.id === id &&
          stage.childId &&
          ["running", "completed"].includes(stage.status),
      )
    )
      throw new Error(
        "Spawn and bind all writer, reviewer and DRY peers before starting work",
      );
}
function notify(run: WorkflowRun, to: string, text: string) {
  return {
    step: to,
    childId: run.stages.find((stage) => stage.id === to)?.childId ?? null,
    message: text,
    delivery:
      "Send with your native peer messaging tool; if unavailable, ask the parent to relay it. Queuing in RL alone does not wake a native agent.",
  };
}
function requirements(
  run: WorkflowRun,
  from: string,
  event: string,
  subjects: string[],
): void {
  const config = run.config.workflows[run.workflow].collaboration!;
  for (const rule of config.rules.filter(
    (rule) => rule.from === from && rule.event === event && rule.required,
  ))
    for (const subject of subjects) {
      const request = [...state(run).consultations]
        .reverse()
        .find(
          (item) =>
            item.from === from &&
            item.to === rule.to &&
            item.event === event &&
            item.subject === subject,
        );
      if (!request?.answer)
        throw new Error(
          `${from} must consult ${rule.to} and receive an answer for ${event}: ${subject}`,
        );
    }
}
function latestSubmissions(run: WorkflowRun) {
  return state(run).submissions.filter((item) => !item.supersededBy);
}
function current(run: WorkflowRun, submission: Submission): boolean {
  return (
    checkpoint(run, submission.files).fingerprint === submission.fingerprint
  );
}
function allReviewed(run: WorkflowRun): void {
  const submissions = latestSubmissions(run);
  if (!submissions.length)
    throw new Error(
      "Submit implementation work to the reviewer before completing the workflow",
    );
  for (const submission of submissions) {
    if (!submission.review?.accepted)
      throw new Error(
        `Submission ${submission.id} needs an accepted reviewer rating before completion`,
      );
    if (!current(run, submission))
      throw new Error(
        `Submission ${submission.id} changed after review; submit the current work again`,
      );
  }
}
function snapshotPath(directory: string, id: string): string {
  sessionId(id);
  const parent = path.join(directory, "checkpoints"),
    file = path.join(parent, `${id}.json`);
  if (
    fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink() ||
    fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()
  )
    throw new Error("Checkpoint state must not be a symlink");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return file;
}

export function collaborationTool(
  run: WorkflowRun,
  directory: string,
  name: string,
  input: Record<string, unknown>,
) {
  const data = state(run),
    config = run.config.workflows[run.workflow].collaboration!;
  const stage = run.stages.find((stage) => stage.id === input.step);
  if (!stage || stage.status !== "running" || stage.claim !== input.claim)
    throw new Error("A current native peer claim is required");
  const roster = () =>
    run.stages
      .filter((stage) =>
        [config.writer, config.reviewer, config.dry].includes(stage.id),
      )
      .map(({ id, childId, status }) => ({
        step: id,
        childId: childId ?? null,
        status,
      }));
  if (name === "rl_workflow_inbox")
    return {
      status: run.status,
      ready: roster().every(
        (peer) =>
          peer.childId && ["running", "completed"].includes(peer.status),
      ),
      peers: roster(),
      consultations: data.consultations.filter(
        (item) => item.from === stage.id || item.to === stage.id,
      ),
      submissions:
        stage.id === config.writer || stage.id === config.reviewer
          ? data.submissions
          : [],
    };
  if (
    run.status !== "running" &&
    !(
      run.status === "paused" &&
      ["rl_workflow_answer", "rl_workflow_review"].includes(name)
    )
  )
    throw new Error(`Workflow is ${run.status}`);
  if (name === "rl_workflow_bind") {
    const childId = prose(input.childId, "native child identifier", 200);
    if (
      (stage.childId && stage.childId !== childId) ||
      run.stages.some(
        (other) => other.id !== stage.id && other.childId === childId,
      )
    )
      throw new Error(
        "Each role must use its own native child; binding cannot be replaced during a claim",
      );
    stage.childId = childId;
    return {
      peers: roster(),
      ready: roster().every((peer) => peer.childId),
      instruction:
        "After all peers are bound, notify all three using native messaging so they can begin; relay their notifications when direct peer messaging is unavailable.",
    };
  }
  peersReady(run);
  if (name === "rl_workflow_consult") {
    const event = prose(input.event, "consultation event", 64),
      subject = prose(input.subject, "consultation subject", 512),
      question = prose(input.question, "consultation question");
    const rule = config.rules.find(
      (rule) =>
        rule.from === stage.id && rule.to === input.to && rule.event === event,
    );
    if (!rule)
      throw new Error(
        "This peer-to-peer route is not configured in the workflow",
      );
    if (
      !run.stages.some(
        (stage) => stage.id === rule.to && stage.status === "running",
      )
    )
      throw new Error("The requested peer is no longer running");
    if (data.consultations.length >= 256)
      throw new Error("Consultation limit reached; start a new workflow run");
    const request: Consultation = {
      id: randomUUID(),
      from: stage.id,
      to: rule.to,
      event,
      subject,
      question,
      createdAt: now(),
    };
    data.consultations.push(request);
    return {
      ...request,
      notify: notify(
        run,
        request.to,
        `Consultation ${request.id} from ${stage.id}: ${subject}. Read your RL inbox and answer.`,
      ),
    };
  }
  if (name === "rl_workflow_answer") {
    const request = data.consultations.find(
      (item) => item.id === input.requestId && item.to === stage.id,
    );
    if (!request) throw new Error("Consultation is not addressed to this peer");
    const text = prose(input.text, "consultation answer");
    if (request.answer && request.answer.text !== text)
      throw new Error("Consultation has already been answered");
    request.answer ??= { text, at: now() };
    return {
      ...request,
      notify: notify(
        run,
        request.from,
        `Your consultation ${request.id} has an answer. Read your RL inbox.`,
      ),
    };
  }
  if (name === "rl_workflow_submit") {
    if (stage.id !== config.writer)
      throw new Error(
        "Only the configured writer may submit implementation work",
      );
    const files = list(input.files, "checkpoint files").map(sourcePath),
      newFunctions = list(input.newFunctions, "new function subjects"),
      summary = prose(input.summary, "submission summary");
    if (!files.length) throw new Error("A submission requires files to review");
    for (const subject of newFunctions)
      if (
        !subject.includes("#") ||
        !files.includes(subject.slice(0, subject.indexOf("#")))
      )
        throw new Error(
          "New functions must use submitted path#function subjects",
        );
    requirements(run, stage.id, "new_function", newFunctions);
    const supersedes =
      input.supersedes === undefined
        ? []
        : list(input.supersedes, "superseded submissions");
    for (const id of supersedes)
      if (
        !data.submissions.some((item) => item.id === id && !item.supersededBy)
      )
        throw new Error("Unknown active submission to supersede");
    const overlapping = latestSubmissions(run).filter(
      (item) =>
        item.files.some((file) => files.includes(file)) ||
        supersedes.includes(item.id),
    );
    for (const item of overlapping) {
      if (!item.review && !supersedes.includes(item.id))
        throw new Error(
          "Submitted files are frozen until reviewed; explicitly supersede a checkpoint to replace it",
        );
      if (item.files.some((file) => !files.includes(file)))
        throw new Error(
          "A resubmission must include the complete previous file group",
        );
    }
    const round = Math.max(0, ...overlapping.map((item) => item.round)) + 1;
    if (round > config.maxRounds)
      throw new Error(
        "Maximum review rounds reached; report the blocker to the parent",
      );
    if (data.submissions.length >= 128)
      throw new Error("Submission limit reached; start a new workflow run");
    const id = randomUUID(),
      snapshot = checkpoint(run, files),
      file = snapshotPath(directory, id);
    fs.writeFileSync(file, JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    const submission: Submission = {
      id,
      writer: stage.id,
      reviewer: config.reviewer,
      files,
      newFunctions,
      summary,
      fingerprint: snapshot.fingerprint,
      snapshot: file,
      createdAt: now(),
      round,
    };
    overlapping.forEach((item) => {
      item.supersededBy = id;
    });
    data.submissions.push(submission);
    return {
      ...submission,
      notify: notify(
        run,
        config.reviewer,
        `Writer submission ${id} is ready for review. Read the saved checkpoint from your RL inbox and return a rating.`,
      ),
    };
  }
  if (name === "rl_workflow_review") {
    if (stage.id !== config.reviewer)
      throw new Error("Only the configured reviewer may rate submissions");
    const submission = data.submissions.find(
      (item) => item.id === input.submissionId && !item.supersededBy,
    );
    if (!submission || submission.review)
      throw new Error("A current unreviewed submission is required");
    if (!current(run, submission))
      throw new Error(
        "Submitted files or staged versions changed; the writer must resubmit this checkpoint",
      );
    const policy =
        run.config.policies[run.config.workflows[run.workflow].policy],
      rating = policy.rating!;
    if (
      typeof input.rating !== "number" ||
      !Number.isFinite(input.rating) ||
      input.rating < rating.min ||
      input.rating > rating.max
    )
      throw new Error(
        `Reviewer rating must be within ${rating.min}–${rating.max}`,
      );
    const duplicateSuspicions = list(
      input.duplicateSuspicions,
      "suspected duplicate subjects",
    );
    requirements(run, stage.id, "suspected_duplicate", duplicateSuspicions);
    validateResult(input.result);
    for (const finding of input.result.findings)
      if (
        !inside(
          canonical(path.join(run.workspace, finding.file)),
          run.workspace,
        ) ||
        (!fs.existsSync(path.join(run.workspace, finding.file)) &&
          !submission.files.includes(finding.file))
      )
        throw new Error(
          "Review evidence must reference a workspace file or a submitted deletion",
        );
    const assessment = evaluate(policy, [
      { owner: stage.id, result: input.result },
    ]);
    submission.review = {
      rating: input.rating,
      rationale: prose(input.rationale, "rating rationale"),
      result: input.result,
      duplicateSuspicions,
      accepted:
        input.rating >= rating.minimum &&
        assessment.verdict === "ready" &&
        !input.result.checkRequests.length &&
        !input.result.routingLeads.length,
      at: now(),
    };
    return {
      ...submission,
      notify: notify(
        run,
        config.writer,
        `Submission ${submission.id} was rated ${input.rating}/${rating.max}: ${submission.review.accepted ? "accepted" : "changes or validation required"}. Read the review evidence in your RL inbox.`,
      ),
    };
  }
  throw new Error("Unknown collaboration operation");
}

export function collaborationPrompt(run: WorkflowRun, stage: Stage): string {
  const config = run.config.workflows[run.workflow].collaboration;
  if (!config) return "";
  return [
    "This is a persistent collaborative team. The parent must claim, spawn and bind all three native peers in parallel before work begins. Keep your role alive for messages; use rl_workflow_inbox and native messaging/wait tools, or ask the parent to relay messages. Never spawn replacement peers or busy-poll.",
    "Every handoff tool returns a notify destination and native child handle. Send that notification with your host's native messaging tool or ask the parent to relay it. RL persists messages; it cannot wake native agents by itself. The parent announces team readiness after binding all three peers.",
    `You are step ${stage.id}. Use the parent agent=${run.owner!.agent}, sessionId=${run.owner!.sessionId}, run=${run.id}, step=${stage.id}, claim=${stage.claim} for your own workflow tools. The parent supplies your native child ID to rl_workflow_bind. Peer handles are returned by the inbox.`,
    `Writer=${config.writer}; reviewer=${config.reviewer}; DRY=${config.dry}. Rules: ${JSON.stringify(config.rules)}. Maximum review rounds: ${config.maxRounds}. Rating policy: ${JSON.stringify(run.config.policies[run.config.workflows[run.workflow].policy].rating)}.`,
    "Writer: before each new function, perform any required new_function consultation with rl_workflow_consult and wait for rl_workflow_answer, then implement. Configured optional routes may also be used. Use rl_workflow_submit with a stable file group and all newFunctions as path#function subjects. Freeze submitted files until a rating arrives, work on unrelated files meanwhile, and fix/resubmit rejected checkpoints. Reviewer: read submitted snapshot versions and current surrounding source; perform any required suspected_duplicate consultation for every suspected duplicate and wait for its answer, then use rl_workflow_review with rating, rationale, result and all duplicateSuspicions. DRY: answer both peers through rl_workflow_answer with evidence and limitations.",
    "The reviewer returns the configured human-readable rating; RL independently computes the policy score. Shared submissions and consultation answers are explicit handoffs you may read. Ratings apply only to the saved files and staged versions; never rate a moving or superseded checkpoint. Only the writer may edit. Close roles in order: writer after accepted current reviews, reviewer after writer, DRY after both peers and all consultations. Final closure uses rl_workflow_report with evidence in resultSchema.",
  ].join("\n\n");
}

export function assertCollaborationCompletion(
  run: WorkflowRun,
  stage: Stage,
  changedFiles?: string[],
): void {
  const config = run.config.workflows[run.workflow].collaboration;
  if (!config) return;
  peersReady(run);
  const data = state(run);
  if (data.consultations.some((item) => item.from === stage.id && !item.answer))
    throw new Error("Resolve this role's consultations before completing it");
  if (stage.id === config.writer) {
    allReviewed(run);
    const covered = new Set(
      latestSubmissions(run).flatMap((item) => item.files),
    );
    for (const file of new Set([
      ...(changedFiles ?? []),
      ...Object.keys(data.baseline),
    ]))
      if (
        (!Object.hasOwn(data.baseline, file) ||
          checkpoint(run, [file]).fingerprint !== data.baseline[file]) &&
        !covered.has(file)
      )
        throw new Error(
          `Changed file has not been submitted for review: ${file}`,
        );
  }
  if (stage.id === config.reviewer) {
    if (
      run.stages.find((stage) => stage.id === config.writer)?.status !==
      "completed"
    )
      throw new Error(
        "The reviewer must remain available until the writer finishes",
      );
    allReviewed(run);
  }
  if (
    stage.id === config.dry &&
    (data.consultations.some((item) => !item.answer) ||
      [config.writer, config.reviewer].some(
        (id) =>
          run.stages.find((stage) => stage.id === id)?.status !== "completed",
      ))
  )
    throw new Error(
      "DRY must remain available until both peers finish and all requests are answered",
    );
}

export function collaborationAssessment(run: WorkflowRun) {
  if (!run.config.workflows[run.workflow].collaboration)
    return { reports: [], limitations: [] as string[] };
  const submissions = latestSubmissions(run),
    limitations: string[] = [];
  if (!submissions.length)
    limitations.push("No implementation submissions were reviewed");
  const reports = submissions.flatMap((item) =>
    item.review ? [{ owner: item.reviewer, result: item.review.result }] : [],
  );
  for (const item of submissions) {
    if (!item.review?.accepted)
      limitations.push(`${item.id}: reviewer acceptance is missing`);
    try {
      if (!current(run, item))
        limitations.push(`${item.id}: checkpoint changed after submission`);
    } catch {
      limitations.push(`${item.id}: checkpoint cannot be verified`);
    }
  }
  for (const request of state(run).consultations)
    if (!request.answer)
      limitations.push(
        `${request.from}: awaiting ${request.to} for ${request.subject}`,
      );
  return { reports, limitations };
}

export function validateCollaborationState(
  value: unknown,
): asserts value is CollaborationState {
  if (
    !object(value) ||
    !Array.isArray(value.consultations) ||
    !Array.isArray(value.submissions) ||
    !object(value.baseline) ||
    Object.values(value.baseline).some((value) => typeof value !== "string") ||
    value.consultations.length > 256 ||
    value.submissions.length > 128
  )
    throw new Error("Invalid collaborative workflow state");
  const ids = new Set<string>();
  for (const item of [...value.consultations, ...value.submissions]) {
    if (!object(item) || typeof item.id !== "string" || ids.has(item.id))
      throw new Error("Invalid or duplicate collaboration record");
    sessionId(item.id);
    ids.add(item.id);
    prose(item.createdAt, "record timestamp", 100);
    if ("question" in item) {
      for (const key of ["from", "to", "event", "subject", "question"])
        prose(item[key], key);
      if (item.answer !== undefined) {
        if (!object(item.answer)) throw new Error("Invalid peer answer");
        prose(item.answer.text, "answer");
        prose(item.answer.at, "answer timestamp", 100);
      }
    } else {
      list(item.files, "files").forEach(sourcePath);
      list(item.newFunctions, "new functions");
      for (const key of [
        "writer",
        "reviewer",
        "summary",
        "fingerprint",
        "snapshot",
      ])
        prose(item[key], key);
      if (!Number.isSafeInteger(item.round) || Number(item.round) < 1)
        throw new Error("Invalid review round");
      if (item.supersededBy !== undefined) sessionId(item.supersededBy);
      if (item.review !== undefined) {
        if (
          !object(item.review) ||
          typeof item.review.rating !== "number" ||
          !Number.isFinite(item.review.rating) ||
          typeof item.review.accepted !== "boolean"
        )
          throw new Error("Invalid reviewer rating");
        prose(item.review.rationale, "rating rationale");
        validateResult(item.review.result);
        list(item.review.duplicateSuspicions, "duplicates");
      }
    }
  }
}
