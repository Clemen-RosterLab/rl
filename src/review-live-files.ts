import type { ReviewFile } from "./review-live-engine.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonical, object, readJson, writeJson } from "./common.js";

export type ReviewFileCategory = "test" | "style" | "boilerplate";
export type ReviewFileFilters = Record<ReviewFileCategory, boolean>;
export const defaultReviewFilters: Readonly<ReviewFileFilters> = {
  test: true,
  style: true,
  boilerplate: true,
};
export const reviewFilterCategories: {
  key: ReviewFileCategory;
  label: string;
  description: string;
}[] = [
  { key: "test", label: "Tests", description: "Test/spec files, test folders and snapshots" },
  { key: "style", label: "Styles", description: "CSS, SCSS, Sass, Less, Stylus and CSS-in-TS" },
  { key: "boilerplate", label: "Boilerplate", description: "Lockfiles, generated artifacts, source maps and minified JS" },
];

export function reviewFilterFile(directory: string, root: string): string {
  const key = createHash("sha256").update(canonical(root)).digest("hex");
  const file = path.join(directory, "live-review", "preferences", `${key}.json`);
  if (canonical(file) !== path.resolve(file))
    throw new Error("Review filter preferences must not traverse symlinks");
  return file;
}

export function loadReviewFilters(directory: string, root: string): ReviewFileFilters {
  const file = reviewFilterFile(directory, root);
  if (!fs.existsSync(file)) return { ...defaultReviewFilters };
  const data = readJson(file);
  if (!object(data) || data.version !== 1 || !object(data.hidden))
    throw new Error(`Invalid review filter preferences: ${file}`);
  const filters = { ...defaultReviewFilters };
  for (const { key } of reviewFilterCategories) {
    if (data.hidden[key] === undefined) continue;
    if (typeof data.hidden[key] !== "boolean")
      throw new Error(`Invalid review filter ${key}: ${file}`);
    filters[key] = data.hidden[key];
  }
  return filters;
}

export function saveReviewFilters(directory: string, root: string, filters: ReviewFileFilters): void {
  const hidden = { ...filters };
  if (reviewFilterCategories.some(({key}) => typeof hidden[key] !== "boolean"))
    throw new Error("Review filters must be boolean values");
  writeJson(reviewFilterFile(directory, root), { version: 1, hidden });
}

/** Conventional test paths only; production files with incidental matches stay visible. */
export function isReviewTestPath(file: string): boolean {
  const parts = file.replaceAll("\\", "/").split("/");
  if (
    parts
      .slice(0, -1)
      .some((part) =>
        /^(?:tests?|specs?|__tests__|__mocks__|__snapshots__|e2e|cypress)$/i.test(
          part,
        ),
      )
  )
    return true;
  const name = parts.at(-1) ?? "";
  return (
    /(?:^|[._-])(?:tests?|specs?)(?:[._-]|$)/i.test(name) ||
    /(?:Tests?|Specs?)\.(?:cs|java|kt|kts|scala|groovy|swift|php|rb)$/.test(
      name,
    ) ||
    /^Test[A-Z].*\.(?:java|kt|cs|php)$/.test(name) ||
    /\.snap$/i.test(name)
  );
}

export function visibleReviewFiles(
  files: ReviewFile[],
  hideNoise: boolean,
  filters: Readonly<ReviewFileFilters> = defaultReviewFilters,
): ReviewFile[] {
  return hideNoise
    ? files.filter((file) => {
        const category = reviewFileCategory(file.path);
        return category === undefined || !filters[category];
      })
    : files;
}

/** Naming conventions, not a judgment about a file's semantic importance. */
export function reviewFileCategory(
  file: string,
): ReviewFileCategory | undefined {
  if (isReviewTestPath(file)) return "test";
  const normalized = file.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) ?? "";
  if (
    /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/i.test(name) ||
    /\.(?:styles?|css)\.[cm]?[jt]sx?$/i.test(name)
  )
    return "style";
  if (
    /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|\.gitkeep|\.DS_Store)$/i.test(
      name,
    ) ||
    /(?:^|\/)(?:__generated__|generated|dist|coverage)(?:\/|$)/i.test(
      normalized,
    ) ||
    /\.(?:generated|gen)\./i.test(name) ||
    /\.(?:g|designer)\.cs$/i.test(name) ||
    /(?:\.min\.[cm]?js|\.map|\.tsbuildinfo)$/i.test(name)
  )
    return "boilerplate";
  return undefined;
}
