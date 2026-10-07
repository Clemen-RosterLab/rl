import fs from "node:fs";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

/** Raw JSON enters the program through this validated boundary. */
export function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  if (!isJsonValue(value)) throw new Error("Invalid JSON value");
  return value;
}

export function parseJsonObject(text: string): JsonObject {
  const value = parseJson(text);
  if (!isJsonObject(value)) throw new Error("Expected a JSON object");
  return value;
}

export function readJsonObject(file: string): JsonObject {
  try {
    return parseJsonObject(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
