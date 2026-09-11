export type GitHubOperationOutcome =
  | "success"
  | "rate_limited"
  | "retryable_error"
  | "permanent_error"
  | "unknown";

export type GitHubErrorCode =
  | "authentication"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "retryable"
  | "network"
  | "timeout"
  | "cancelled"
  | "malformed_response"
  | "invalid_request"
  | "invalid_filter"
  | "invalid_cursor"
  | "partial_page"
  | "graphql_error"
  | "queue_full"
  | "duplicate_conflict"
  | "shutdown"
  | "execution_failed"
  | "unknown";

export type GitHubRemoteOutcome = "accepted" | "not_accepted" | "unknown";

export interface GitHubRateLimitMetadata {
  readonly limit?: number;
  readonly remaining?: number;
  /** Unix epoch milliseconds, when GitHub supplied a reset timestamp. */
  readonly resetAt?: number;
  readonly used?: number;
  /** Delay in milliseconds parsed from Retry-After. */
  readonly retryAfterMs?: number;
  /** Header parsing problems are reported instead of silently becoming zero. */
  readonly warnings?: readonly ("malformed_reset" | "malformed_retry_after" | "malformed_counter")[];
}

export interface GitHubResponseMetadata {
  readonly status: number;
  readonly requestId?: string;
  readonly rateLimit: GitHubRateLimitMetadata;
  readonly pagination?: {
    readonly next?: string;
    readonly previous?: string;
  };
}

export interface GitHubOperationError {
  readonly code: GitHubErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number>>;
}

interface GitHubResultBase {
  readonly correlationId: string;
  readonly remoteOutcome: GitHubRemoteOutcome;
}

export interface GitHubSuccess<T> extends GitHubResultBase {
  readonly outcome: "success";
  readonly value: T;
  readonly response?: GitHubResponseMetadata;
}

export interface GitHubFailure extends GitHubResultBase {
  readonly outcome: Exclude<GitHubOperationOutcome, "success">;
  readonly error: GitHubOperationError;
  readonly response?: GitHubResponseMetadata;
}

export type GitHubOperationResult<T> = GitHubSuccess<T> | GitHubFailure;

export function success<T>(
  value: T,
  correlationId: string,
  response?: GitHubResponseMetadata,
): GitHubSuccess<T> {
  return {
    outcome: "success",
    value,
    correlationId,
    remoteOutcome: "accepted",
    ...(response === undefined ? {} : { response }),
  };
}

export function failure(
  outcome: Exclude<GitHubOperationOutcome, "success">,
  code: GitHubErrorCode,
  message: string,
  correlationId: string,
  remoteOutcome: GitHubRemoteOutcome,
  response?: GitHubResponseMetadata,
  details?: Readonly<Record<string, string | number>>,
): GitHubFailure {
  return {
    outcome,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    correlationId,
    remoteOutcome,
    ...(response === undefined ? {} : { response }),
  };
}
