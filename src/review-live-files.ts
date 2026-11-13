import type { ReviewFile } from "./review-live-engine.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonical, object, readJson, writeJson } from "./common.js";

export type ReviewFileCategory = "test" | "style" | "boilerplate";
export type ReviewFileFilters = Record<ReviewFileCategory, boolean>;
export interface ReviewSettings {
  hidePaths: string[];
  showPaths: string[];
  lockfiles?: boolean;
  generated?: boolean;
  sidebarWidth?: number;
  wheelStep: number;
}
export const defaultReviewSettings: ReviewSettings = {
  hidePaths: [],
  showPaths: [],
  wheelStep: 3,
};
export const advancedReviewFilters = [
  {
    key: "lockfiles" as const,
    label: "Dependency lockfiles",
    description: "Override the boilerplate setting for dependency lockfiles",
  },
  {
    key: "generated" as const,
    label: "Generated files",
    description: "Override the boilerplate setting for generated artifacts",
  },
];
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
  {
    key: "test",
    label: "Tests",
    description: "Test/spec files, test folders and snapshots",
  },
  {
    key: "style",
    label: "Styles",
    description: "CSS, SCSS, Sass, Less, Stylus and CSS-in-TS",
  },
  {
    key: "boilerplate",
    label: "Boilerplate",
    description: "Lockfiles, generated artifacts, source maps and minified JS",
  },
];

export function reviewFilterFile(directory: string, root: string): string {
  const key = createHash("sha256").update(canonical(root)).digest("hex");
  const file = path.join(
    directory,
    "live-review",
    "preferences",
    `${key}.json`,
  );
  if (canonical(file) !== path.resolve(file))
    throw new Error("Review filter preferences must not traverse symlinks");
  return file;
}

export function loadReviewFilters(
  directory: string,
  root: string,
): ReviewFileFilters {
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

export function saveReviewFilters(
  directory: string,
  root: string,
  filters: ReviewFileFilters,
): void {
  const hidden = { ...filters };
  if (
    reviewFilterCategories.some(({ key }) => typeof hidden[key] !== "boolean")
  )
    throw new Error("Review filters must be boolean values");
  const file = reviewFilterFile(directory, root);
  const previous = fs.existsSync(file) ? readJson(file) : {};
  writeJson(file, { ...previous, version: 1, hidden });
}

export function loadReviewSettings(
  directory: string,
  root: string,
): ReviewSettings {
  const file = reviewFilterFile(directory, root);
  if (!fs.existsSync(file))
    return { ...defaultReviewSettings, hidePaths: [], showPaths: [] };
  const raw = readJson(file);
  const value = object(raw.settings) ? raw.settings : {};
  const result: ReviewSettings = {
    ...defaultReviewSettings,
    hidePaths: [],
    showPaths: [],
  };
  for (const key of ["hidePaths", "showPaths"] as const) {
    if (value[key] === undefined) continue;
    if (
      !Array.isArray(value[key]) ||
      value[key].length > 100 ||
      value[key].some(
        (item) =>
          typeof item !== "string" ||
          !item ||
          item.length > 500 ||
          /[\r\n\0]/.test(item),
      )
    )
      throw new Error(`Invalid review ${key}`);
    result[key] = value[key] as string[];
  }
  for (const key of ["lockfiles", "generated"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean")
      throw new Error(`Invalid review ${key}`);
    result[key] = value[key];
  }
  if (value.sidebarWidth !== undefined) {
    if (
      !Number.isInteger(value.sidebarWidth) ||
      Number(value.sidebarWidth) < 24 ||
      Number(value.sidebarWidth) > 4096
    )
      throw new Error("Invalid review sidebar width");
    result.sidebarWidth = Number(value.sidebarWidth);
  }
  if (value.wheelStep !== undefined) {
    if (
      !Number.isInteger(value.wheelStep) ||
      Number(value.wheelStep) < 1 ||
      Number(value.wheelStep) > 20
    )
      throw new Error("Review wheel speed must be between 1 and 20 lines");
    result.wheelStep = Number(value.wheelStep);
  }
  return result;
}
export function saveReviewSettings(
  directory: string,
  root: string,
  settings: ReviewSettings,
): void {
  const file = reviewFilterFile(directory, root);
  const previous = fs.existsSync(file)
    ? readJson(file)
    : { version: 1, hidden: { ...defaultReviewFilters } };
  writeJson(file, { ...previous, settings });
}
const globCache = new Map<string, RegExp>();
// Double-star paths can match zero directories; show rules override hide rules.
export function matchesReviewPath(file: string, glob: string): boolean {
  let expression = globCache.get(glob);
  if (!expression) {
    const pattern = glob.endsWith("/") ? glob + "**" : glob;
    let source = "^";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*" && pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          source += "(?:.*/)?";
          i++;
        } else source += ".*";
      } else if (c === "*") source += "[^/]*";
      else if (c === "?") source += "[^/]";
      else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    expression = new RegExp(source + "$");
    globCache.set(glob, expression);
    if (globCache.size > 300) globCache.delete(globCache.keys().next().value!);
  }
  return expression.test(file);
}
export function hiddenReviewReason(
  file: string,
  filters: Readonly<ReviewFileFilters>,
  settings: ReviewSettings = defaultReviewSettings,
): string | undefined {
  if (settings.showPaths.some((glob) => matchesReviewPath(file, glob)))
    return undefined;
  const custom = settings.hidePaths.find((glob) =>
    matchesReviewPath(file, glob),
  );
  if (custom) return `Path rule: ${custom}`;
  const category = reviewFileCategory(file);
  if (category === "boilerplate") {
    const override = isReviewLockfile(file)
      ? settings.lockfiles
      : isReviewGenerated(file)
        ? settings.generated
        : undefined;
    if (override !== undefined)
      return override
        ? isReviewLockfile(file)
          ? "Dependency lockfile"
          : "Generated file"
        : undefined;
  }
  return category && filters[category]
    ? reviewFilterCategories.find((item) => item.key === category)!.label
    : undefined;
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
  settings: ReviewSettings = defaultReviewSettings,
): ReviewFile[] {
  return hideNoise
    ? files.filter((file) => {
        return hiddenReviewReason(file.path, filters, settings) === undefined;
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
    isReviewLockfile(file) ||
    isReviewGenerated(file) ||
    /^(?:\.gitkeep|\.DS_Store)$/i.test(name)
  )
    return "boilerplate";
  return undefined;
}
export function isReviewLockfile(file: string): boolean {
  return /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|Pipfile\.lock)$/i.test(
    path.posix.basename(file),
  );
}
export function isReviewGenerated(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  const name = path.posix.basename(normalized);
  return (
    /(?:^|\/)(?:__generated__|generated|dist|coverage)(?:\/|$)/i.test(
      normalized,
    ) ||
    /\.(?:generated|gen)\./i.test(name) ||
    /\.(?:g|designer)\.cs$/i.test(name) ||
    /(?:\.min\.[cm]?js|\.map|\.tsbuildinfo)$/i.test(name)
  );
}
