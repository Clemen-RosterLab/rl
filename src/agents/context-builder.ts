import fs from "node:fs";
import path from "node:path";
import { pendingReviewFeedback } from "../review-store.js";
import { automationContext } from "../session-workflows.js";
import type { Instance } from "../store.js";
import { handoffText } from "../task-state.js";
import {
  HUMAN_REVIEW_GUIDANCE,
  SHARED_DOCUMENTS_GUIDANCE,
  TASK_PAUSE_GUIDANCE,
} from "../orchestration/prompts.js";

const DOCUMENT_EXCERPT_LIMIT = 12000;

export function buildWorkspaceContextText(
  file: string,
  data: Instance,
): string {
  const sections: string[] = [
    `RL feature workspace: ${data.id}\nBranch: ${data.branch}`,
    SHARED_DOCUMENTS_GUIDANCE,
    TASK_PAUSE_GUIDANCE,
  ];

  const automation = automationContext(data.worktree);
  if (automation) {
    sections.push(automation);
  }

  sections.push(HUMAN_REVIEW_GUIDANCE);

  const reviewFeedback = pendingReviewFeedback(file);
  if (reviewFeedback) {
    sections.push(reviewFeedback);
  }

  const latestHandoff = data.task?.handoffs.at(-1);
  if (latestHandoff && data.task) {
    sections.push(
      `RL task state: ${data.task.state}\n\n${handoffText(latestHandoff)}`,
    );
  }

  const stateDirectory = path.dirname(file);
  for (const name of ["context.md", "progress.md"]) {
    const source = path.join(stateDirectory, name);
    if (!fs.existsSync(source)) {
      continue;
    }
    const text = fs.readFileSync(source, "utf8");
    sections.push(
      `${name} (${source}):\n${text.slice(0, DOCUMENT_EXCERPT_LIMIT)}`,
    );
    if (text.length > DOCUMENT_EXCERPT_LIMIT) {
      sections.push("[Excerpt truncated; read the file for the full context.]");
    }
  }

  sections.push("Cached GitHub PR state:\n" + JSON.stringify(data.pr));
  return sections.join("\n\n");
}
