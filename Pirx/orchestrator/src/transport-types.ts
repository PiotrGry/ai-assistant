export interface GitHubRequestContext {
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type GitHubRestMethod = "GET";
export type GitHubRestWriteMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export interface GitHubRestReadRequest {
  readonly method: GitHubRestMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export interface GitHubRestWriteRequest {
  readonly method: GitHubRestWriteMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
}

export interface GitHubGraphqlReadRequest {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

export interface GitHubGraphqlWriteRequest {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

export type GitHubFetch = (input: URL, init?: RequestInit) => Promise<Response>;
