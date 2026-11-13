import type { LiveRepository, ReviewFile } from "./review-live-engine.js";

export type ReviewSearchScope = "diff" | "paths" | "changes" | "files";
export interface ReviewSearchHit {
  fileKey: string;
  path: string;
  line: number;
  preview: string;
  fullFile: boolean;
}
export interface ReviewSearchResult {
  hits: ReviewSearchHit[];
  scanned: number;
  total: number;
  limited: boolean;
}
export function searchReviewFiles(
  repository: LiveRepository,
  files: ReviewFile[],
  query: string,
  scope: "changes" | "files",
  context = 3,
): ReviewSearchResult {
  const result: ReviewSearchResult = {
    hits: [],
    scanned: 0,
    total: files.length,
    limited: false,
  };
  const needle = query.toLocaleLowerCase();
  if (!needle) return result;
  let bytes = 0;
  for (const file of files) {
    if (
      result.scanned >= 200 ||
      result.hits.length >= 100 ||
      bytes >= 16 * 1024 * 1024
    ) {
      result.limited = true;
      break;
    }
    if (file.binary) continue;
    const content =
      scope === "files"
        ? repository.content(
            file,
            file.status.startsWith("D") ? "before" : "after",
            1024 * 1024,
          )
        : {
            text: repository.patch(file, context),
            binary: false,
            truncated: false,
          };
    result.scanned++;
    const remaining = 16 * 1024 * 1024 - bytes;
    const size = Buffer.byteLength(content.text);
    if (size > remaining) {
      result.limited = true;
      break;
    }
    bytes += size;
    if (
      scope === "changes" &&
      content.text.includes("[Diff truncated at 8 MiB;")
    )
      result.limited = true;
    result.limited ||= content.truncated;
    if (content.binary || content.truncated) continue;
    const lines = content.text.split("\n");
    let inHunk = false;
    for (const [index, text] of lines.entries()) {
      if (text.startsWith("@@ ")) inHunk = true;
      if (text.startsWith("diff --git ")) inHunk = false;
      if (scope === "changes" && (!inHunk || !/^[+-]/.test(text))) continue;
      if (text.toLocaleLowerCase().includes(needle)) {
        result.hits.push({
          fileKey: file.key,
          path: file.path,
          line: index,
          preview: text.slice(0, 200),
          fullFile: scope === "files",
        });
        if (result.hits.length >= 100) {
          result.limited = true;
          break;
        }
      }
    }
  }
  return result;
}
