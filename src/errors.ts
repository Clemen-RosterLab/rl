export class RlError extends Error {
  readonly code?: string;

  constructor(detail: string, options?: { code?: string; cause?: unknown }) {
    super(
      detail,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = new.target.name;
    this.code = options?.code;
  }
}

/** Thrown when CLI arguments, options, or subcommand syntax are invalid. */
export class UsageError extends RlError {}

/** Thrown when a requested workspace selector does not match an existing checkout. */
export class WorkspaceNotFoundError extends RlError {}

/** Thrown when persisted RL state or configuration fails schema validation. */
export class StateValidationError extends RlError {}

const LEGACY_USAGE_PATTERN =
  /^(?:Usage:|Invalid command arguments|Unknown option|Missing --|Expected|Unsupported .*option|--.*(?:require|supported|accept))/;

export function isUsageError(error: unknown): boolean {
  if (error instanceof StateValidationError) {
    return false;
  }
  if (error instanceof UsageError) {
    return true;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String(error.code).startsWith("ERR_PARSE_ARGS_")
  ) {
    return true;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return LEGACY_USAGE_PATTERN.test(detail);
}
