import { randomUUID } from "node:crypto";

import type { GitHubConfig } from "./config.js";
import {
  failure,
  type GitHubFailure,
  type GitHubOperationResult,
  type GitHubResponseMetadata,
} from "./outcome.js";
import { executeWithGitHubRetry, type GitHubRetryPolicyOptions } from "./retry-policy.js";
import type {
  GitHubGraphqlReadRequest,
  GitHubRequestContext,
  GitHubRestReadRequest,
} from "./transport-types.js";

export type GitHubIssueState = "open" | "closed";
export type GitHubIssueStateFilter = GitHubIssueState | "all";
export type GitHubIssueSort = "created" | "updated" | "comments";
export type GitHubIssueDirection = "asc" | "desc";
export type GitHubIssueMilestone = number | "none";

export interface GitHubIssueRef {
  readonly owner: string;
  readonly repository: string;
  readonly nodeId: string;
  readonly number: number;
  readonly url: string;
}

export interface GitHubIssueUser {
  readonly login: string;
}

export interface GitHubIssueLabel {
  readonly name: string;
  readonly color?: string;
}

export interface GitHubIssueMilestoneSummary {
  readonly number: number;
  readonly title: string;
  readonly state?: GitHubIssueState;
}

export interface GitHubIssueSummary extends GitHubIssueRef {
  readonly title: string;
  readonly body?: string;
  readonly state: GitHubIssueState;
  readonly author?: GitHubIssueUser;
  readonly labels: readonly GitHubIssueLabel[];
  readonly assignees: readonly GitHubIssueUser[];
  readonly milestone?: GitHubIssueMilestoneSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
  readonly parentIssue?: GitHubIssueRef;
  readonly blockingIssueNumbers?: readonly number[];
}

export interface GitHubIssuePage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly complete: boolean;
}

export interface GitHubIssuePageOptions {
  readonly pageSize?: number;
  readonly maxItems?: number;
  readonly cursor?: string;
  readonly correlationId?: string;
  readonly signal?: AbortSignal;
}

export interface GitHubIssueListFilter {
  readonly state?: GitHubIssueStateFilter;
  readonly labels?: readonly string[];
  readonly milestone?: GitHubIssueMilestone;
  readonly sort?: GitHubIssueSort;
  readonly direction?: GitHubIssueDirection;
}

export interface GitHubIssueSearchFilter extends GitHubIssueListFilter {
  readonly text?: string;
}

export interface GitHubIssueReadTransport {
  restRead<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
  graphqlRead<T>(request: GitHubGraphqlReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
}

export interface GitHubIssueReaderOptions {
  readonly retryPolicy?: GitHubRetryPolicyOptions;
  readonly defaultPageSize?: number;
  readonly defaultMaxItems?: number;
  readonly maxItemsLimit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_ITEMS = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_ITEMS_LIMIT = 1_000;

const ISSUE_FIELDS = `
  id
  number
  url
  title
  body
  state
  author { login }
  labels(first: 100) { nodes { name color } }
  assignees(first: 100) { nodes { login } }
  milestone { number title state }
  createdAt
  updatedAt
  closedAt
`;

interface RestIssuePayload {
  readonly node_id?: unknown;
  readonly number?: unknown;
  readonly html_url?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly state?: unknown;
  readonly user?: unknown;
  readonly labels?: unknown;
  readonly assignees?: unknown;
  readonly milestone?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly closed_at?: unknown;
  readonly pull_request?: unknown;
  readonly parent_issue?: unknown;
  readonly blocking_issues?: unknown;
}

interface GraphqlSearchPayload {
  readonly search?: unknown;
}

interface GraphqlSearchConnection {
  readonly nodes?: unknown;
  readonly pageInfo?: unknown;
}

interface GraphqlPageInfo {
  readonly hasNextPage?: unknown;
  readonly endCursor?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function timestampValue(value: unknown): string | undefined {
  const timestamp = stringValue(value);
  return timestamp !== undefined && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stateValue(value: unknown): GitHubIssueState | undefined {
  return value === "OPEN" || value === "open" ? "open" : value === "CLOSED" || value === "closed" ? "closed" : undefined;
}

function mapUser(value: unknown): GitHubIssueUser | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const login = stringValue(value.login);
  return login === undefined ? undefined : { login };
}

function mapUsers(value: unknown): GitHubIssueUser[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const user = mapUser(item);
    return user === undefined ? [] : [user];
  });
}

function mapConnectionUsers(value: unknown): GitHubIssueUser[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return [];
  }
  return mapUsers(value.nodes);
}

function mapLabels(value: unknown): GitHubIssueLabel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item === "string" && item.length > 0) {
      return [{ name: item }];
    }
    if (!isRecord(item)) {
      return [];
    }
    const name = stringValue(item.name);
    if (name === undefined) {
      return [];
    }
    const color = stringValue(item.color);
    return [color === undefined ? { name } : { name, color }];
  });
}

function mapConnectionLabels(value: unknown): GitHubIssueLabel[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return [];
  }
  return mapLabels(value.nodes);
}

function mapMilestone(value: unknown): GitHubIssueMilestoneSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const number = positiveNumber(value.number);
  const title = stringValue(value.title);
  if (number === undefined || title === undefined) {
    return undefined;
  }
  const state = stateValue(value.state);
  return state === undefined ? { number, title } : { number, title, state };
}

function mapRef(value: unknown, owner: string, repository: string): GitHubIssueRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nodeId = stringValue(value.node_id) ?? stringValue(value.id);
  const number = positiveNumber(value.number);
  const url = stringValue(value.html_url) ?? stringValue(value.url);
  return nodeId === undefined || number === undefined || url === undefined
    ? undefined
    : { owner, repository, nodeId, number, url };
}

function mapIssue(value: unknown, owner: string, repository: string, graphql: boolean): GitHubIssueSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nodeId = stringValue(graphql ? value.id : value.node_id);
  const number = positiveNumber(value.number);
  const url = stringValue(graphql ? value.url : value.html_url);
  const title = stringValue(value.title);
  const state = stateValue(value.state);
  const createdAt = timestampValue(graphql ? value.createdAt : value.created_at);
  const updatedAt = timestampValue(graphql ? value.updatedAt : value.updated_at);
  if (nodeId === undefined || number === undefined || url === undefined || title === undefined || state === undefined || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const body = value.body === null ? undefined : textValue(value.body);
  const author = mapUser(value.author ?? value.user);
  const labels = graphql ? mapConnectionLabels(value.labels) : mapLabels(value.labels);
  const assignees = graphql ? mapConnectionUsers(value.assignees) : mapUsers(value.assignees);
  const milestone = mapMilestone(value.milestone);
  const closedAtValue = value[graphql ? "closedAt" : "closed_at"];
  const closedAt = closedAtValue === null ? undefined : timestampValue(closedAtValue);
  const parentIssue = mapRef(value.parent_issue ?? value.parent, owner, repository);
  const blocking = Array.isArray(value.blocking_issues)
    ? value.blocking_issues.flatMap((item) => {
        const numberValue = positiveNumber(isRecord(item) ? item.number : item);
        return numberValue === undefined ? [] : [numberValue];
      })
    : undefined;
  return {
    owner,
    repository,
    nodeId,
    number,
    url,
    title,
    ...(body === undefined ? {} : { body }),
    state,
    ...(author === undefined ? {} : { author }),
    labels,
    assignees,
    ...(milestone === undefined ? {} : { milestone }),
    createdAt,
    updatedAt,
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(parentIssue === undefined ? {} : { parentIssue }),
    ...(blocking === undefined ? {} : { blockingIssueNumbers: blocking }),
  };
}

function encodeCursor(kind: "rest" | "graphql", value: string): string {
  return `v1:${kind}:${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeCursor(cursor: string | undefined, expected: "rest" | "graphql"): string | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const match = /^v1:(rest|graphql):([A-Za-z0-9_-]+)$/u.exec(cursor);
  if (match === null || match[1] !== expected) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(match[2] ?? "", "base64url").toString("utf8");
    if (decoded.length === 0 || decoded.length > 2_000) {
      return undefined;
    }
    if (expected === "rest" && !/^\d+$/u.test(decoded)) {
      return undefined;
    }
    if (expected === "rest" && Number(decoded) <= 0) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

function validatePageOptions(options: GitHubIssuePageOptions, maxItemsLimit: number): { readonly pageSize: number; readonly maxItems: number } | string {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
    return `pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`;
  }
  if (!Number.isSafeInteger(maxItems) || maxItems <= 0 || maxItems > maxItemsLimit) {
    return `maxItems must be an integer between 1 and ${maxItemsLimit}.`;
  }
  return { pageSize, maxItems };
}

function validateLabels(labels: readonly string[] | undefined): string | undefined {
  if (labels === undefined) {
    return undefined;
  }
  if (labels.length > 100 || labels.some((label) => label.trim().length === 0 || label.length > 100)) {
    return "labels must contain at most 100 non-empty values of at most 100 characters.";
  }
  return undefined;
}

function validateFilter(filter: GitHubIssueListFilter | GitHubIssueSearchFilter): string | undefined {
  if (filter.state !== undefined && filter.state !== "open" && filter.state !== "closed" && filter.state !== "all") {
    return "state must be open, closed, or all.";
  }
  if (filter.sort !== undefined && filter.sort !== "created" && filter.sort !== "updated" && filter.sort !== "comments") {
    return "sort must be created, updated, or comments.";
  }
  if (filter.direction !== undefined && filter.direction !== "asc" && filter.direction !== "desc") {
    return "direction must be asc or desc.";
  }
  const labelError = validateLabels(filter.labels);
  if (labelError !== undefined) {
    return labelError;
  }
  if (filter.milestone !== undefined && filter.milestone !== "none" && (!Number.isSafeInteger(filter.milestone) || filter.milestone <= 0)) {
    return "milestone must be a positive integer or none.";
  }
  if ("text" in filter && filter.text !== undefined && (filter.text.trim().length === 0 || filter.text.length > 256)) {
    return "text must contain between 1 and 256 characters when supplied.";
  }
  return undefined;
}

function quoteSearch(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function searchExpression(owner: string, repository: string, filter: GitHubIssueSearchFilter): string {
  const parts = [`repo:${owner}/${repository}`, "is:issue"];
  if (filter.state === "open" || filter.state === "closed") {
    parts.push(`is:${filter.state}`);
  }
  for (const label of filter.labels ?? []) {
    parts.push(`label:${quoteSearch(label)}`);
  }
  if (filter.milestone === "none") {
    parts.push("no:milestone");
  } else if (filter.milestone !== undefined) {
    parts.push(`milestone:${filter.milestone}`);
  }
  if (filter.sort !== undefined) {
    parts.push(`sort:${filter.sort}-${filter.direction ?? "desc"}`);
  }
  if (filter.text !== undefined) {
    parts.push(quoteSearch(filter.text.trim()));
  }
  return parts.join(" ");
}

function pageFailure<T>(result: GitHubFailure, cursor: string | undefined, itemsRead: number): GitHubOperationResult<GitHubIssuePage<T>> {
  return {
    ...result,
    error: {
      ...result.error,
      details: { failedCursor: cursor ?? "initial", itemsRead },
    },
  };
}

export class GitHubIssueReader {
  readonly #transport: GitHubIssueReadTransport;
  readonly #owner: string;
  readonly #repository: string;
  readonly #retryPolicy: GitHubRetryPolicyOptions;
  readonly #defaultPageSize: number;
  readonly #defaultMaxItems: number;
  readonly #maxItemsLimit: number;

  constructor(transport: GitHubIssueReadTransport, config: Pick<GitHubConfig, "owner" | "repository">, options: GitHubIssueReaderOptions = {}) {
    this.#transport = transport;
    this.#owner = config.owner;
    this.#repository = config.repository;
    this.#retryPolicy = options.retryPolicy ?? {};
    this.#defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
    this.#defaultMaxItems = options.defaultMaxItems ?? DEFAULT_MAX_ITEMS;
    this.#maxItemsLimit = options.maxItemsLimit ?? DEFAULT_MAX_ITEMS_LIMIT;
    const pageValidation = validatePageOptions({ pageSize: this.#defaultPageSize, maxItems: this.#defaultMaxItems }, this.#maxItemsLimit);
    if (typeof pageValidation === "string") {
      throw new RangeError(pageValidation);
    }
  }

  async getIssue(number: number, options: Pick<GitHubIssuePageOptions, "correlationId" | "signal"> = {}): Promise<GitHubOperationResult<GitHubIssueSummary>> {
    const correlationId = options.correlationId ?? randomUUID();
    if (!Number.isSafeInteger(number) || number <= 0) {
      return failure("permanent_error", "invalid_filter", "Issue number must be a positive integer.", correlationId, "not_accepted");
    }
    const result = await this.#read<RestIssuePayload>(correlationId, options.signal, (context) => this.#transport.restRead<RestIssuePayload>({
      method: "GET",
      path: `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/issues/${number}`,
    }, context));
    if (result.outcome !== "success") {
      return result;
    }
    if (result.value.pull_request !== undefined) {
      return failure("permanent_error", "invalid_request", "GitHub returned a pull request where an Issue was required.", correlationId, "not_accepted", result.response);
    }
    const issue = mapIssue(result.value, this.#owner, this.#repository, false);
    return issue === undefined
      ? failure("permanent_error", "malformed_response", "GitHub returned a malformed Issue.", correlationId, "not_accepted", result.response)
      : { ...result, value: issue };
  }

  async listIssues(filter: GitHubIssueListFilter = {}, options: GitHubIssuePageOptions = {}): Promise<GitHubOperationResult<GitHubIssuePage<GitHubIssueSummary>>> {
    return this.#listOrSearch("list", filter, options);
  }

  async searchIssues(filter: GitHubIssueSearchFilter = {}, options: GitHubIssuePageOptions = {}): Promise<GitHubOperationResult<GitHubIssuePage<GitHubIssueSummary>>> {
    return this.#listOrSearch("search", filter, options);
  }

  async #listOrSearch(kind: "list" | "search", filter: GitHubIssueListFilter | GitHubIssueSearchFilter, options: GitHubIssuePageOptions): Promise<GitHubOperationResult<GitHubIssuePage<GitHubIssueSummary>>> {
    const correlationId = options.correlationId ?? randomUUID();
    const filterError = validateFilter(filter);
    if (filterError !== undefined) {
      return failure("permanent_error", "invalid_filter", filterError, correlationId, "not_accepted");
    }
    const pageOptions = validatePageOptions(options, this.#maxItemsLimit);
    if (typeof pageOptions === "string") {
      return failure("permanent_error", "invalid_filter", pageOptions, correlationId, "not_accepted");
    }
    const cursorValue = decodeCursor(options.cursor, kind === "list" ? "rest" : "graphql");
    if (options.cursor !== undefined && cursorValue === undefined) {
      return failure("permanent_error", "invalid_cursor", "Issue pagination cursor is malformed or belongs to another operation.", correlationId, "not_accepted");
    }
    return kind === "list"
      ? this.#listRest(filter, options, pageOptions, correlationId, cursorValue)
      : this.#searchGraphql(filter as GitHubIssueSearchFilter, options, pageOptions, correlationId, cursorValue);
  }

  async #listRest(filter: GitHubIssueListFilter, options: GitHubIssuePageOptions, pageOptions: { readonly pageSize: number; readonly maxItems: number }, correlationId: string, cursor: string | undefined): Promise<GitHubOperationResult<GitHubIssuePage<GitHubIssueSummary>>> {
    const firstPage = cursor === undefined ? 1 : Number(cursor);
    const items: GitHubIssueSummary[] = [];
    const seen = new Set<number>();
    let page = firstPage;
    let lastResponse: GitHubResponseMetadata | undefined;
    for (let requestCount = 0; requestCount < this.#maxItemsLimit && items.length < pageOptions.maxItems; requestCount += 1) {
      const failedCursor = cursor === undefined && page === 1 ? undefined : encodeCursor("rest", String(page));
      const remaining = pageOptions.maxItems - items.length;
      const requestSize = Math.min(pageOptions.pageSize, remaining);
      const query: Record<string, string | number> = {
        state: filter.state ?? "open",
        sort: filter.sort ?? "created",
        direction: filter.direction ?? "asc",
        page,
        per_page: requestSize,
      };
      if (filter.labels !== undefined && filter.labels.length > 0) {
        query.labels = filter.labels.join(",");
      }
      if (filter.milestone !== undefined) {
        query.milestone = filter.milestone;
      }
      const result = await this.#read<RestIssuePayload[]>(correlationId, options.signal, (context) => this.#transport.restRead<RestIssuePayload[]>({
        method: "GET",
        path: `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/issues`,
        query,
      }, context));
      if (result.outcome !== "success") {
        return pageFailure(result, failedCursor, items.length);
      }
      lastResponse = result.response;
      if (!Array.isArray(result.value)) {
        return failure("permanent_error", "malformed_response", "GitHub returned a malformed Issue page.", correlationId, "not_accepted", result.response, { failedCursor: failedCursor ?? "initial", itemsRead: items.length });
      }
      for (const rawIssue of result.value) {
        if (!isRecord(rawIssue) || rawIssue.pull_request !== undefined) {
          continue;
        }
        const issue = mapIssue(rawIssue, this.#owner, this.#repository, false);
        if (issue === undefined) {
          return failure("permanent_error", "malformed_response", "GitHub returned a malformed Issue in a page.", correlationId, "not_accepted", result.response, { failedCursor: failedCursor ?? "initial", itemsRead: items.length });
        }
        if (!seen.has(issue.number)) {
          seen.add(issue.number);
          items.push(issue);
        }
      }
      const linkedNext = result.response?.pagination?.next;
      const nextPage = linkedNext === undefined ? page + 1 : this.#pageFromUrl(linkedNext);
      const hasNext = nextPage !== undefined && (linkedNext !== undefined || result.value.length >= pageOptions.pageSize);
      if (!hasNext) {
        return { ...result, value: { items, complete: true } };
      }
      page = nextPage ?? page + 1;
    }
    const nextCursor = encodeCursor("rest", String(page));
    return {
      outcome: "success",
      value: { items, complete: false, nextCursor },
      correlationId,
      remoteOutcome: "accepted",
      ...(lastResponse === undefined ? {} : { response: lastResponse }),
    };
  }

  async #searchGraphql(filter: GitHubIssueSearchFilter, options: GitHubIssuePageOptions, pageOptions: { readonly pageSize: number; readonly maxItems: number }, correlationId: string, cursor: string | undefined): Promise<GitHubOperationResult<GitHubIssuePage<GitHubIssueSummary>>> {
    const searchQuery = searchExpression(this.#owner, this.#repository, filter);
    const items: GitHubIssueSummary[] = [];
    const seen = new Set<number>();
    let after = cursor;
    let lastResponse: GitHubResponseMetadata | undefined;
    for (let requestCount = 0; requestCount < this.#maxItemsLimit && items.length < pageOptions.maxItems; requestCount += 1) {
      const failedCursor = after === undefined ? undefined : encodeCursor("graphql", after);
      const remaining = pageOptions.maxItems - items.length;
      const first = Math.min(pageOptions.pageSize, remaining);
      const query = `query SearchIssues($query: String!, $first: Int!, $after: String) { search(query: $query, type: ISSUE, first: $first, after: $after) { nodes { ... on Issue { ${ISSUE_FIELDS} } } pageInfo { hasNextPage endCursor } } }`;
      const result = await this.#read<GraphqlSearchPayload>(correlationId, options.signal, (context) => this.#transport.graphqlRead<GraphqlSearchPayload>({
        query,
        variables: {
          query: searchQuery,
          first,
          ...(after === undefined ? {} : { after }),
        },
      }, context));
      if (result.outcome !== "success") {
        return pageFailure(result, failedCursor, items.length);
      }
      lastResponse = result.response;
      const connection = isRecord(result.value.search) ? result.value.search as GraphqlSearchConnection : undefined;
      if (connection === undefined || !Array.isArray(connection.nodes) || !isRecord(connection.pageInfo)) {
        return failure("permanent_error", "malformed_response", "GitHub returned a malformed Issue search page.", correlationId, "not_accepted", result.response, { failedCursor: failedCursor ?? "initial", itemsRead: items.length });
      }
      for (const rawIssue of connection.nodes) {
        const issue = mapIssue(rawIssue, this.#owner, this.#repository, true);
        if (issue === undefined) {
          return failure("permanent_error", "malformed_response", "GitHub returned a malformed Issue in search results.", correlationId, "not_accepted", result.response, { failedCursor: failedCursor ?? "initial", itemsRead: items.length });
        }
        if (!seen.has(issue.number)) {
          seen.add(issue.number);
          items.push(issue);
        }
      }
      const pageInfo = connection.pageInfo as GraphqlPageInfo;
      const hasNext = pageInfo.hasNextPage === true;
      const endCursor = stringValue(pageInfo.endCursor);
      if (!hasNext) {
        return { ...result, value: { items, complete: true } };
      }
      if (endCursor === undefined) {
        return failure("permanent_error", "malformed_response", "GitHub omitted the cursor for a paginated Issue search.", correlationId, "not_accepted", result.response, { failedCursor: failedCursor ?? "initial", itemsRead: items.length });
      }
      after = endCursor;
    }
    const nextCursor = after === undefined ? undefined : encodeCursor("graphql", after);
    return {
      outcome: "success",
      value: { items, complete: false, ...(nextCursor === undefined ? {} : { nextCursor }) },
      correlationId,
      remoteOutcome: "accepted",
      ...(lastResponse === undefined ? {} : { response: lastResponse }),
    };
  }

  async #read<T>(correlationId: string, signal: AbortSignal | undefined, operation: (context: GitHubRequestContext) => Promise<GitHubOperationResult<T>>): Promise<GitHubOperationResult<T>> {
    const decision = await executeWithGitHubRetry({
      operation: "read",
      correlationId,
      ...(signal === undefined ? {} : { signal }),
      execute: async ({ signal: retrySignal }) => operation({
        correlationId,
        ...(retrySignal === undefined ? {} : { signal: retrySignal }),
      }),
    }, this.#retryPolicy);
    return decision.finalOutcome;
  }

  #pageFromUrl(value: string): number | undefined {
    try {
      const url = new URL(value);
      const page = Number(url.searchParams.get("page"));
      return Number.isSafeInteger(page) && page > 0 ? page : undefined;
    } catch {
      return undefined;
    }
  }
}

export const githubIssueQueryFields = ISSUE_FIELDS;
