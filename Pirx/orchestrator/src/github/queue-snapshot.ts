import { randomUUID } from "node:crypto";

import type { GitHubConfig } from "./config.js";
import type { GitHubOperationOutcome, GitHubOperationResult } from "./outcome.js";
import { GitHubProjectSchemaResolver, type GitHubProjectFieldName, type GitHubProjectTransport } from "./project-sync.js";
import { executeWithGitHubRetry, type GitHubRetryPolicyOptions } from "./retry-policy.js";

export const GITHUB_QUEUE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const GITHUB_QUEUE_LIMITS = Object.freeze({ pageSize: 100, maximumPages: 10, maximumItems: 1_000, maximumBlockers: 100, bodyCharacters: 64_000 } as const);

export interface GitHubQueueBlocker {
  readonly nodeId: string;
  readonly owner: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly state: "OPEN" | "CLOSED";
}

export interface GitHubQueueIssue {
  readonly itemId: string;
  readonly nodeId: string;
  readonly owner: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: "OPEN" | "CLOSED";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status?: string;
  readonly priority?: string;
  readonly worker?: string;
  readonly risk?: string;
  readonly workType?: string;
  readonly queueOrder?: number;
  readonly blockers: readonly GitHubQueueBlocker[];
}

export interface GitHubQueueSnapshot {
  readonly schemaVersion: typeof GITHUB_QUEUE_SNAPSHOT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly synchronizedAt: string;
  readonly items: readonly GitHubQueueIssue[];
}

export type GitHubQueueSnapshotOutcome = "success" | "rate_limited" | "provider_error" | "schema_drift" | "invalid_request";
export type GitHubQueueSnapshotResult =
  | { readonly outcome: "success"; readonly correlationId: string; readonly snapshot: GitHubQueueSnapshot }
  | { readonly outcome: Exclude<GitHubQueueSnapshotOutcome, "success">; readonly correlationId: string; readonly message: string; readonly providerOutcome?: GitHubOperationOutcome };

export interface GitHubQueueSnapshotReaderOptions {
  readonly retryPolicy?: GitHubRetryPolicyOptions;
  readonly timeoutMs?: number;
  readonly clock?: { now(): string };
}

interface RawPayload { readonly node?: { readonly items?: unknown } | null; }

const QUEUE_QUERY = `query PirxQueueSnapshot($projectId: ID!, $after: String, $pageSize: Int!, $blockerCount: Int!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: $pageSize, after: $after) {
        nodes {
          id
          content {
            __typename
            ... on Issue {
              id number title body state url createdAt updatedAt
              repository { name owner { login } }
              blockedBy(first: $blockerCount) {
                nodes { id number state repository { name owner { login } } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { ... on ProjectV2Field { name } }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, maximum = 2_048): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value); }
function timestamp(value: unknown): string | undefined { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined; return new Date(value).toISOString(); }
function issueState(value: unknown): value is "OPEN" | "CLOSED" { return value === "OPEN" || value === "CLOSED"; }
function failure(outcome: Exclude<GitHubQueueSnapshotOutcome, "success">, correlationId: string, message: string, providerOutcome?: GitHubOperationOutcome): GitHubQueueSnapshotResult { return { outcome, correlationId, message: message.slice(0, 256), ...(providerOutcome === undefined ? {} : { providerOutcome }) }; }
function providerFailure(result: Exclude<GitHubOperationResult<unknown>, { readonly outcome: "success" }>, correlationId: string): GitHubQueueSnapshotResult { return failure(result.outcome === "rate_limited" ? "rate_limited" : "provider_error", correlationId, "GitHub Queue snapshot read failed.", result.outcome); }
function pageInfo(value: unknown): { readonly hasNextPage: boolean; readonly endCursor?: string } | undefined {
  if (!isRecord(value) || typeof value.hasNextPage !== "boolean") return undefined;
  if (value.hasNextPage && !text(value.endCursor, 1_000)) return undefined;
  return { hasNextPage: value.hasNextPage, ...(typeof value.endCursor === "string" ? { endCursor: value.endCursor } : {}) };
}
function metadata(values: unknown): Partial<Record<GitHubProjectFieldName, string | number>> | undefined {
  if (!isRecord(values) || !Array.isArray(values.nodes)) return undefined;
  const result: Partial<Record<GitHubProjectFieldName, string | number>> = {};
  for (const raw of values.nodes) {
    if (!isRecord(raw) || !isRecord(raw.field) || typeof raw.field.name !== "string") continue;
    const name = raw.field.name as GitHubProjectFieldName;
    if (raw.__typename === "ProjectV2ItemFieldSingleSelectValue" && typeof raw.name === "string") result[name] = raw.name;
    if (raw.__typename === "ProjectV2ItemFieldNumberValue" && typeof raw.number === "number" && Number.isFinite(raw.number)) result[name] = raw.number;
  }
  return result;
}
function blocker(value: unknown): GitHubQueueBlocker | undefined {
  if (!isRecord(value) || !text(value.id, 256) || !Number.isSafeInteger(value.number) || (value.number as number) <= 0 || !issueState(value.state) || !isRecord(value.repository) || !text(value.repository.name, 100) || !isRecord(value.repository.owner) || !text(value.repository.owner.login, 100)) return undefined;
  return { nodeId: value.id, owner: value.repository.owner.login, repository: value.repository.name, issueNumber: value.number as number, state: value.state };
}
function item(value: unknown): GitHubQueueIssue | undefined | "ignored" {
  if (!isRecord(value) || !text(value.id, 256) || !isRecord(value.content)) return undefined;
  if (value.content.__typename !== "Issue") return "ignored";
  const content = value.content;
  const createdAt = timestamp(content.createdAt); const updatedAt = timestamp(content.updatedAt);
  if (!text(content.id, 256) || !Number.isSafeInteger(content.number) || (content.number as number) <= 0 || !text(content.title, 2_000) || typeof content.body !== "string" || content.body.length > GITHUB_QUEUE_LIMITS.bodyCharacters || !issueState(content.state) || !text(content.url) || createdAt === undefined || updatedAt === undefined || !isRecord(content.repository) || !text(content.repository.name, 100) || !isRecord(content.repository.owner) || !text(content.repository.owner.login, 100) || !isRecord(content.blockedBy) || !Array.isArray(content.blockedBy.nodes)) return undefined;
  const blockerPage = pageInfo(content.blockedBy.pageInfo);
  if (blockerPage === undefined || blockerPage.hasNextPage) return undefined;
  const blockers: GitHubQueueBlocker[] = [];
  for (const raw of content.blockedBy.nodes) { const parsed = blocker(raw); if (parsed === undefined) return undefined; blockers.push(parsed); }
  const fields = metadata(value.fieldValues);
  if (fields === undefined) return undefined;
  const queueOrder = fields["Queue Order"];
  return Object.freeze({
    itemId: value.id, nodeId: content.id, owner: content.repository.owner.login, repository: content.repository.name,
    issueNumber: content.number as number, url: content.url, title: content.title.trim(), body: content.body,
    state: content.state, createdAt, updatedAt,
    ...(typeof fields.Status === "string" ? { status: fields.Status } : {}), ...(typeof fields.Priority === "string" ? { priority: fields.Priority } : {}),
    ...(typeof fields.Worker === "string" ? { worker: fields.Worker } : {}), ...(typeof fields.Risk === "string" ? { risk: fields.Risk } : {}),
    ...(typeof fields["Work Type"] === "string" ? { workType: fields["Work Type"] } : {}), ...(typeof queueOrder === "number" ? { queueOrder } : {}),
    blockers: Object.freeze(blockers),
  });
}

export class GitHubQueueSnapshotReader {
  readonly #transport: GitHubProjectTransport;
  readonly #schema: GitHubProjectSchemaResolver;
  readonly #timeoutMs: number;
  readonly #retry: GitHubRetryPolicyOptions;
  readonly #clock: { now(): string };

  public constructor(transport: GitHubProjectTransport, config: Pick<GitHubConfig, "projectOwner" | "projectNumber" | "timeoutMs">, options: GitHubQueueSnapshotReaderOptions = {}) {
    this.#transport = transport;
    this.#schema = new GitHubProjectSchemaResolver(transport, config, options);
    this.#timeoutMs = options.timeoutMs ?? config.timeoutMs;
    this.#retry = options.retryPolicy ?? {};
    this.#clock = options.clock ?? { now: () => new Date().toISOString() };
  }

  public async read(options: { readonly correlationId?: string } = {}): Promise<GitHubQueueSnapshotResult> {
    const correlationId = options.correlationId?.trim() || randomUUID();
    const schema = await this.#schema.resolve({ correlationId });
    if (schema.outcome !== "synchronized" || schema.value === undefined) return failure(schema.outcome === "rate_limited" ? "rate_limited" : schema.outcome === "schema_drift" ? "schema_drift" : "provider_error", correlationId, schema.message, schema.providerOutcome);
    const items: GitHubQueueIssue[] = [];
    const identities = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < GITHUB_QUEUE_LIMITS.maximumPages; page += 1) {
      const result = await executeWithGitHubRetry<RawPayload>({ operation: "read", correlationId, execute: ({ signal }) => this.#transport.graphqlRead<RawPayload>({ query: QUEUE_QUERY, variables: { projectId: schema.value!.id, after, pageSize: GITHUB_QUEUE_LIMITS.pageSize, blockerCount: GITHUB_QUEUE_LIMITS.maximumBlockers } }, { correlationId, timeoutMs: this.#timeoutMs, ...(signal === undefined ? {} : { signal }) }) }, this.#retry);
      if (result.finalOutcome.outcome !== "success") return providerFailure(result.finalOutcome, correlationId);
      const connection = isRecord(result.finalOutcome.value.node) && isRecord(result.finalOutcome.value.node.items) ? result.finalOutcome.value.node.items : undefined;
      if (!isRecord(connection) || !Array.isArray(connection.nodes)) return failure("schema_drift", correlationId, "GitHub Queue snapshot response is incomplete.");
      for (const raw of connection.nodes) {
        const parsed = item(raw);
        if (parsed === "ignored") continue;
        if (parsed === undefined) return failure("schema_drift", correlationId, "GitHub Queue item or dependency data is incomplete.");
        const identity = `${parsed.owner}/${parsed.repository}#${parsed.issueNumber}`;
        if (identities.has(identity)) return failure("schema_drift", correlationId, "GitHub Queue contains a duplicate Issue identity.");
        identities.add(identity); items.push(parsed);
      }
      const info = pageInfo(connection.pageInfo);
      if (info === undefined) return failure("schema_drift", correlationId, "GitHub Queue pagination data is incomplete.");
      if (!info.hasNextPage) return { outcome: "success", correlationId, snapshot: Object.freeze({ schemaVersion: GITHUB_QUEUE_SNAPSHOT_SCHEMA_VERSION, projectId: schema.value.id, synchronizedAt: this.#clock.now(), items: Object.freeze(items) }) };
      after = info.endCursor;
    }
    return failure("schema_drift", correlationId, "GitHub Queue exceeds the bounded snapshot size.");
  }
}
