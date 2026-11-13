import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonical, object, readJson, writeJson, now } from "./common.js";
import type { ReviewFile } from "./review-live-engine.js";

export interface ViewedFile {
  fingerprint: string;
  tree: string;
  path: string;
  at: string;
}
export interface ReviewProgress {
  version: 1;
  reviewed: Record<string, { fingerprint: string; at: string }>;
  viewed: Record<string, ViewedFile>;
}
export function reviewFileFingerprint(file: ReviewFile): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        file.path,
        file.oldPath,
        file.beforeBlob ?? file.from,
        file.afterBlob ?? file.to,
        file.beforeMode,
        file.afterMode,
      ]),
    )
    .digest("hex");
}
export function progressFile(directory: string, key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid review progress key");
  const file = path.resolve(
    directory,
    "live-review",
    "progress",
    `${key}.json`,
  );
  if (canonical(file) !== file)
    throw new Error("Review progress must not traverse symlinks");
  return file;
}
export function loadReviewProgress(
  directory: string,
  key: string,
): ReviewProgress {
  const file = progressFile(directory, key);
  if (!fs.existsSync(file)) return { version: 1, reviewed: {}, viewed: {} };
  const raw = readJson(file);
  if (raw.version !== 1 || !object(raw.reviewed) || !object(raw.viewed))
    throw new Error("Invalid file review progress");
  for (const item of [
    ...Object.values(raw.reviewed),
    ...Object.values(raw.viewed),
  ])
    if (
      !object(item) ||
      typeof item.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
      typeof item.at !== "string"
    )
      throw new Error("Invalid reviewed file identity");
  for (const item of Object.values(raw.viewed))
    if (
      !object(item) ||
      typeof item.tree !== "string" ||
      !/^[a-f0-9]{40,64}$/.test(item.tree) ||
      typeof item.path !== "string"
    )
      throw new Error("Invalid previously viewed file");
  return raw as unknown as ReviewProgress;
}
export function isFileReviewed(
  progress: ReviewProgress,
  file: ReviewFile,
): boolean {
  return (
    progress.reviewed[file.key]?.fingerprint === reviewFileFingerprint(file)
  );
}
export function toggleFileReviewed(
  directory: string,
  key: string,
  file: ReviewFile,
): ReviewProgress {
  const progress = loadReviewProgress(directory, key);
  if (isFileReviewed(progress, file)) delete progress.reviewed[file.key];
  else
    progress.reviewed[file.key] = {
      fingerprint: reviewFileFingerprint(file),
      at: now(),
    };
  writeJson(progressFile(directory, key), progress);
  return progress;
}
export function recordFileViewed(
  directory: string,
  key: string,
  file: ReviewFile,
): ReviewProgress {
  const progress = loadReviewProgress(directory, key);
  progress.viewed[file.key] = {
    fingerprint: reviewFileFingerprint(file),
    tree: file.to,
    path: file.path,
    at: now(),
  };
  const entries = Object.entries(progress.viewed).sort((a, b) =>
    b[1].at.localeCompare(a[1].at),
  );
  progress.viewed = Object.fromEntries(entries.slice(0, 200));
  writeJson(progressFile(directory, key), progress);
  return progress;
}
