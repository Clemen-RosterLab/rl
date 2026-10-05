import { timestamp } from "./common.js";
import type { Instance } from "./store.js";

/** Historical sessions/creation provide a fallback without mistaking metadata edits for use. */
export function lastAccessed(data?: Instance): string | undefined {
  if (!data) return undefined;
  const candidates = [
    data.lastAccessedAt,
    data.createdAt,
    ...Object.values(data.sessions)
      .flat()
      .map((session) => session.lastUsedAt),
  ];
  let latest: string | undefined;
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    try {
      if (!latest || timestamp(value) > timestamp(latest)) {
        timestamp(value);
        latest = value;
      }
    } catch {
      /* Legacy records may not have an access timestamp. */
    }
  }
  return latest;
}
export function accessLabel(
  value: string | undefined,
  now = Date.now(),
): string {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
