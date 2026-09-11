import { createHash, randomUUID } from "node:crypto";

import type { GitHubConfig } from "./config.js";
import {
  failure,
  type GitHubOperationResult,
} from "./outcome.js";
import {
  GitHubIssueReader,
  type GitHubIssueRef,
  type GitHubIssueState,
  type GitHubIssueSummary,
} from "./issue-read.js";
import { executeWithGitHubRetry, type GitHubRetryPolicyOptions } from "./retry-policy.js";
import { GitHubWriteQueue } from "./write-queue.js";
import type {
  GitHubRequestContext,
  GitHubRestReadRequest,
  GitHubRestWriteRequest,
} from "./transport-types.js";

export type GitHubIssueMilestonePatch = number | "none";

/** Omitted fields are preserved. Empty strings/arrays and `none` explicitly remove values. */
export interface GitHubIssuePatch {
  readonly title?: string;
  readonly body?: string | null;
  readonly state?: GitHubIssueState;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestone?: GitHubIssueMilestonePatch;
}

export interface GitHubIssueExpectedState {
  readonly state?: GitHubIssueState;
  readonly updatedAt?: string;
}

export interface GitHubIssueCreateRequest {
  readonly title: string;
  readonly body?: string | null;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestone?: GitHubIssueMilestonePatch;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly timeoutMs?: number;
}

export interface GitHubIssueUpdateRequest {
  readonly issue: number | GitHubIssueRef;
  readonly patch: GitHubIssuePatch;
  readonly expected?: GitHubIssueExpectedState;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly timeoutMs?: number;
}

export interface GitHubIssueCloseRequest extends Omit<GitHubIssueUpdateRequest, "patch"> {
  readonly expected?: GitHubIssueExpectedState;
}

export interface GitHubIssueReopenRequest extends Omit<GitHubIssueUpdateRequest, "patch"> {
  readonly expected?: GitHubIssueExpectedState;
}

export interface GitHubLifecycleCommentEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly timestamp: string;
  readonly summary: string;
  readonly branch?: string;
  readonly commit?: string;
}

export interface GitHubLifecycleCommentRequest {
  readonly issue: number | GitHubIssueRef;
  readonly envelope: GitHubLifecycleCommentEnvelope;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly timeoutMs?: number;
}

export interface GitHubIssueMutationResult {
  readonly issue: GitHubIssueSummary;
  readonly operation: "created" | "updated";
  readonly changed: boolean;
  readonly noOp: boolean;
  readonly idempotencyKey: string;
}

export interface GitHubCommentRef {
  readonly id: number;
  readonly url: string;
}

export interface GitHubLifecycleCommentResult {
  readonly issue: GitHubIssueRef;
  readonly comment: GitHubCommentRef;
  readonly eventId: string;
  readonly changed: boolean;
  readonly noOp: boolean;
  readonly idempotencyKey: string;
}

export interface GitHubIssueMutationTransport {
  restRead<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
  restWrite<T>(request: GitHubRestWriteRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
}

export interface GitHubIssueMutatorOptions {
  readonly retryPolicy?: GitHubRetryPolicyOptions;
  readonly timeoutMs?: number;
}

interface RestIssueMutationPayload {
  readonly number?: unknown;
}

interface RestCommentPayload {
  readonly id?: unknown;
  readonly html_url?: unknown;
  readonly body?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function issueNumber(issue: number | GitHubIssueRef): number | undefined {
  if (typeof issue === "number") {
    return Number.isSafeInteger(issue) && issue > 0 ? issue : undefined;
  }
  return Number.isSafeInteger(issue.number) && issue.number > 0 ? issue.number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validPositiveInteger(value: number | undefined): boolean {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function safeText(value: string, maxLength: number): boolean {
  return value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateLabels(values: readonly string[] | undefined): string | undefined {
  if (values === undefined) return undefined;
  if (values.length > 100 || values.some((value) => value.length === 0 || value.length > 100 || !safeText(value, 100))) {
    return "labels must contain at most 100 printable values of at most 100 characters.";
  }
  if (new Set(values).size !== values.length) return "labels must not contain duplicates.";
  return undefined;
}

function validateAssignees(values: readonly string[] | undefined): string | undefined {
  if (values === undefined) return undefined;
  if (values.length > 100 || values.some((value) => value.length === 0 || value.length > 100 || !/^[A-Za-z0-9-]+$/u.test(value))) {
    return "assignees must contain at most 100 valid GitHub logins.";
  }
  if (new Set(values).size !== values.length) return "assignees must not contain duplicates.";
  return undefined;
}

function validatePatch(patch: GitHubIssuePatch, allowEmpty: boolean): string | undefined {
  const fields = Object.keys(patch);
  if (!allowEmpty && fields.length === 0) return "Issue patch must contain at least one allowed field.";
  const allowed = new Set(["title", "body", "state", "labels", "assignees", "milestone"]);
  if (fields.some((field) => !allowed.has(field))) return "Issue patch contains an unsupported field.";
  if (patch.title !== undefined && (patch.title.length === 0 || patch.title.length > 256 || !safeText(patch.title, 256))) return "Issue title must contain 1 to 256 printable characters.";
  if (patch.body !== undefined && patch.body !== null && !safeText(patch.body, 65_536)) return "Issue body contains unsupported control characters or is too long.";
  if (patch.state !== undefined && patch.state !== "open" && patch.state !== "closed") return "Issue state must be open or closed.";
  const labelsError = validateLabels(patch.labels);
  if (labelsError !== undefined) return labelsError;
  const assigneesError = validateAssignees(patch.assignees);
  if (assigneesError !== undefined) return assigneesError;
  if (patch.milestone !== undefined && patch.milestone !== "none" && !validPositiveInteger(patch.milestone)) return "Issue milestone must be a positive integer or none.";
  return undefined;
}

function validateCreate(request: GitHubIssueCreateRequest): string | undefined {
  return validatePatch({
    title: request.title,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.labels === undefined ? {} : { labels: request.labels }),
    ...(request.assignees === undefined ? {} : { assignees: request.assignees }),
    ...(request.milestone === undefined ? {} : { milestone: request.milestone }),
  }, true);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function operationMarker(kind: string, idempotencyKey: string): string {
  return `<!-- pirx-operation:v1 kind=${kind} id=${digest(idempotencyKey)} -->`;
}

function issueTarget(owner: string, repository: string, number: number): string {
  return `issue:${owner}/${repository}#${number}`;
}

function invalid(correlationId: string, message: string): GitHubOperationResult<never> {
  return failure("permanent_error", "invalid_request", message, correlationId, "not_accepted");
}

function conflict<T>(correlationId: string, message: string): GitHubOperationResult<T> {
  return failure("permanent_error", "conflict", message, correlationId, "not_accepted");
}

function unknownVerification<T>(correlationId: string, result: GitHubOperationResult<unknown>): GitHubOperationResult<T> {
  return failure("unknown", "unknown", "GitHub accepted the mutation but verification failed.", correlationId, "unknown", result.response);
}

function requestBodyFromPatch(patch: GitHubIssuePatch): Record<string, unknown> {
  return {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.body === undefined ? {} : { body: patch.body }),
    ...(patch.state === undefined ? {} : { state: patch.state }),
    ...(patch.labels === undefined ? {} : { labels: [...patch.labels] }),
    ...(patch.assignees === undefined ? {} : { assignees: [...patch.assignees] }),
    ...(patch.milestone === undefined ? {} : { milestone: patch.milestone === "none" ? null : patch.milestone }),
  };
}

function sameOptional(actual: string | undefined, expected: string | null | undefined): boolean {
  return expected === undefined ? true : actual === (expected === null ? undefined : expected);
}

function patchIsNoOp(issue: GitHubIssueSummary, patch: GitHubIssuePatch): boolean {
  if (patch.title !== undefined && issue.title !== patch.title) return false;
  if (patch.body !== undefined && !sameOptional(issue.body, patch.body)) return false;
  if (patch.state !== undefined && issue.state !== patch.state) return false;
  if (patch.labels !== undefined && canonical(issue.labels.map((label) => label.name).sort()) !== canonical([...patch.labels].sort())) return false;
  if (patch.assignees !== undefined && canonical(issue.assignees.map((user) => user.login).sort()) !== canonical([...patch.assignees].sort())) return false;
  if (patch.milestone !== undefined) {
    const expected = patch.milestone === "none" ? undefined : patch.milestone;
    if (issue.milestone?.number !== expected) return false;
  }
  return true;
}

function validateExpected(issue: GitHubIssueSummary, expected: GitHubIssueExpectedState | undefined): string | undefined {
  if (expected?.state !== undefined && expected.state !== issue.state) return `Expected Issue state ${expected.state}, observed ${issue.state}.`;
  if (expected?.updatedAt !== undefined && expected.updatedAt !== issue.updatedAt) return "Expected Issue version does not match the current GitHub Issue.";
  return undefined;
}

function parseComment(value: unknown): GitHubCommentRef | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const url = stringValue(value.html_url) ?? stringValue(value.url);
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 && url !== undefined ? { id, url } : undefined;
}

function sanitizeSummary(summary: string): string | undefined {
  if (summary.length > 1_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(summary)) return undefined;
  if (/bearer\s+|authorization\s*:|-----begin|(?:token|secret|password)\s*=/iu.test(summary)) return undefined;
  const normalized = summary.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, 500);
}

function safeEnvelopePart(value: string, maxLength: number): boolean {
  return value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/bearer\s+|authorization\s*:|-----begin|(?:token|secret|password)\s*=/iu.test(value);
}

export class GitHubIssueMutator {
  readonly #transport: GitHubIssueMutationTransport;
  readonly #reader: GitHubIssueReader;
  readonly #queue: GitHubWriteQueue;
  readonly #owner: string;
  readonly #repository: string;
  readonly #timeoutMs: number;
  readonly #retryPolicy: GitHubRetryPolicyOptions;

  constructor(
    transport: GitHubIssueMutationTransport,
    reader: GitHubIssueReader,
    queue: GitHubWriteQueue,
    config: Pick<GitHubConfig, "owner" | "repository" | "timeoutMs">,
    options: GitHubIssueMutatorOptions = {},
  ) {
    this.#transport = transport;
    this.#reader = reader;
    this.#queue = queue;
    this.#owner = config.owner;
    this.#repository = config.repository;
    this.#timeoutMs = options.timeoutMs ?? config.timeoutMs;
    this.#retryPolicy = options.retryPolicy ?? {};
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new RangeError("Mutation timeout must be a positive integer.");
  }

  async createIssue(request: GitHubIssueCreateRequest): Promise<GitHubOperationResult<GitHubIssueMutationResult>> {
    const correlationId = request.correlationId?.trim() || randomUUID();
    if (request.idempotencyKey.trim().length === 0) return invalid(correlationId, "Issue create idempotencyKey is required.");
    const validation = validateCreate(request);
    if (validation !== undefined) return invalid(correlationId, validation);
    const marker = operationMarker("create_issue", request.idempotencyKey);
    const existing = await this.#findIssueByMarker(marker, correlationId);
    if (existing.outcome !== "success") return existing as GitHubOperationResult<GitHubIssueMutationResult>;
    if (existing.value !== undefined) return this.#mutationResult(existing.value, "created", false, request.idempotencyKey, correlationId);
    const body = request.body === undefined || request.body === null ? marker : `${request.body}\n\n${marker}`;
    const payload = {
      title: request.title,
      body,
      ...(request.labels === undefined ? {} : { labels: [...request.labels] }),
      ...(request.assignees === undefined ? {} : { assignees: [...request.assignees] }),
      ...(request.milestone === undefined ? {} : { milestone: request.milestone === "none" ? null : request.milestone }),
    };
    const write = await this.#queue.submit<RestIssueMutationPayload>({
      operationKind: "create_issue",
      idempotencyKey: request.idempotencyKey,
      target: `repository:${this.#owner}/${this.#repository}`,
      correlationId,
      payloadIdentity: digest(payload),
      timeoutMs: request.timeoutMs ?? this.#timeoutMs,
      idempotent: true,
      retryPolicy: this.#retryPolicy,
      execute: (context) => this.#transport.restWrite<RestIssueMutationPayload>({ method: "POST", path: `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/issues`, body: payload }, context),
    });
    return this.#verifyMutation(write, "created", request.idempotencyKey);
  }

  async updateIssue(request: GitHubIssueUpdateRequest): Promise<GitHubOperationResult<GitHubIssueMutationResult>> {
    const correlationId = request.correlationId?.trim() || randomUUID();
    if (request.idempotencyKey.trim().length === 0) return invalid(correlationId, "Issue update idempotencyKey is required.");
    const number = issueNumber(request.issue);
    if (number === undefined) return invalid(correlationId, "Issue number must be a positive integer.");
    const validation = validatePatch(request.patch, false);
    if (validation !== undefined) return invalid(correlationId, validation);
    const current = await this.#reader.getIssue(number, { correlationId });
    if (current.outcome !== "success") return current as GitHubOperationResult<GitHubIssueMutationResult>;
    const expectedError = validateExpected(current.value, request.expected);
    if (expectedError !== undefined) return conflict(correlationId, expectedError);
    if (patchIsNoOp(current.value, request.patch)) return this.#mutationResult(current.value, "updated", false, request.idempotencyKey, correlationId);
    const payload = requestBodyFromPatch(request.patch);
    const write = await this.#queue.submit<RestIssueMutationPayload>({
      operationKind: "update_issue",
      idempotencyKey: request.idempotencyKey,
      target: issueTarget(this.#owner, this.#repository, number),
      correlationId,
      payloadIdentity: digest(payload),
      timeoutMs: request.timeoutMs ?? this.#timeoutMs,
      idempotent: true,
      retryPolicy: this.#retryPolicy,
      execute: (context) => this.#transport.restWrite<RestIssueMutationPayload>({ method: "PATCH", path: `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/issues/${number}`, body: payload }, context),
    });
    return this.#verifyMutation(write, "updated", request.idempotencyKey);
  }

  closeIssue(request: GitHubIssueCloseRequest): Promise<GitHubOperationResult<GitHubIssueMutationResult>> {
    return this.updateIssue({ ...request, patch: { state: "closed" } });
  }

  reopenIssue(request: GitHubIssueReopenRequest): Promise<GitHubOperationResult<GitHubIssueMutationResult>> {
    return this.updateIssue({ ...request, patch: { state: "open" } });
  }

  async publishLifecycleComment(request: GitHubLifecycleCommentRequest): Promise<GitHubOperationResult<GitHubLifecycleCommentResult>> {
    const correlationId = request.correlationId?.trim() || randomUUID();
    const number = issueNumber(request.issue);
    if (number === undefined) return invalid(correlationId, "Issue number must be a positive integer.");
    const envelope = request.envelope;
    const summary = sanitizeSummary(envelope.summary);
    if (!safeEnvelopePart(envelope.eventId, 256) || !safeEnvelopePart(envelope.eventType, 256) || !safeEnvelopePart(envelope.taskId, 256) || (envelope.attemptId !== undefined && !safeEnvelopePart(envelope.attemptId, 256)) || (envelope.branch !== undefined && !safeEnvelopePart(envelope.branch, 512)) || (envelope.commit !== undefined && !safeEnvelopePart(envelope.commit, 256)) || summary === undefined || !Number.isFinite(Date.parse(envelope.timestamp))) {
      return invalid(correlationId, "Lifecycle comment envelope is invalid or contains unsafe content.");
    }
    const idempotencyKey = request.idempotencyKey?.trim() || `lifecycle:${this.#owner}/${this.#repository}#${number}:${envelope.eventId}`;
    const marker = operationMarker("lifecycle_comment", idempotencyKey);
    const existing = await this.#findComment(number, marker, correlationId);
    if (existing.outcome !== "success") return existing as GitHubOperationResult<GitHubLifecycleCommentResult>;
    const issue = await this.#reader.getIssue(number, { correlationId });
    if (issue.outcome !== "success") return issue as GitHubOperationResult<GitHubLifecycleCommentResult>;
    if (existing.value !== undefined) return { ...existing, value: { issue: issue.value, comment: existing.value.comment, eventId: envelope.eventId, changed: false, noOp: true, idempotencyKey } };
    const commentBody = [
      marker,
      `### Pirx lifecycle: ${envelope.eventType}`,
      `- Task: ${envelope.taskId}`,
      ...(envelope.attemptId === undefined ? [] : [`- Attempt: ${envelope.attemptId}`]),
      `- Timestamp: ${envelope.timestamp}`,
      `- Summary: ${summary}`,
      ...(envelope.branch === undefined ? [] : [`- Branch: ${envelope.branch}`]),
      ...(envelope.commit === undefined ? [] : [`- Commit: ${envelope.commit}`]),
    ].join("\n");
    const write = await this.#queue.submit<RestCommentPayload>({
      operationKind: "publish_lifecycle_comment",
      idempotencyKey,
      target: issueTarget(this.#owner, this.#repository, number),
      correlationId,
      payloadIdentity: digest(commentBody),
      timeoutMs: request.timeoutMs ?? this.#timeoutMs,
      idempotent: true,
      retryPolicy: this.#retryPolicy,
      execute: (context) => this.#transport.restWrite<RestCommentPayload>({ method: "POST", path: `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/issues/${number}/comments`, body: { body: commentBody } }, context),
    });
    if (write.outcome !== "success") return write as GitHubOperationResult<GitHubLifecycleCommentResult>;
    const comment = parseComment(write.value);
    if (comment === undefined) return failure("unknown", "malformed_response", "GitHub accepted the comment but returned no usable comment identity.", correlationId, "unknown", write.response);
    return { ...write, value: { issue: issue.value, comment, eventId: envelope.eventId, changed: true, noOp: false, idempotencyKey } };
  }

  async #findIssueByMarker(marker: string, correlationId: string): Promise<GitHubOperationResult<GitHubIssueSummary | undefined>> {
    const result = await this.#reader.searchIssues({ text: marker }, { correlationId, maxItems: 10 });
    if (result.outcome !== "success") {
      if (result.error.code === "not_found") return { outcome: "success", value: undefined, correlationId, remoteOutcome: "accepted" };
      return result as GitHubOperationResult<GitHubIssueSummary | undefined>;
    }
    return { ...result, value: result.value.items[0] };
  }

  async #findComment(number: number, marker: string, correlationId: string): Promise<GitHubOperationResult<{ comment: GitHubCommentRef } | undefined>> {
    const result = await this.#read<RestCommentPayload[]>(correlationId, (context) => this.#transport.restRead<RestCommentPayload[]>({ method: "GET", path: `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/issues/${number}/comments`, query: { per_page: 100 } }, context));
    if (result.outcome !== "success") return result as GitHubOperationResult<{ comment: GitHubCommentRef } | undefined>;
    if (!Array.isArray(result.value)) return failure("permanent_error", "malformed_response", "GitHub returned malformed comment data.", correlationId, "not_accepted", result.response);
    for (const raw of result.value) {
      if (!isRecord(raw) || raw.body !== marker) {
        if (!isRecord(raw) || typeof raw.body !== "string" || !raw.body.includes(marker)) continue;
      }
      const comment = parseComment(raw);
      if (comment !== undefined) return { ...result, value: { comment } };
    }
    return { ...result, value: undefined };
  }

  async #read<T>(correlationId: string, operation: (context: GitHubRequestContext) => Promise<GitHubOperationResult<T>>): Promise<GitHubOperationResult<T>> {
    const decision = await executeWithGitHubRetry({
      operation: "read",
      correlationId,
      execute: async ({ signal }) => operation({ correlationId, ...(signal === undefined ? {} : { signal }) }),
    }, this.#retryPolicy);
    return decision.finalOutcome;
  }

  async #verifyMutation<T extends RestIssueMutationPayload>(write: GitHubOperationResult<T>, operation: "created" | "updated", idempotencyKey: string): Promise<GitHubOperationResult<GitHubIssueMutationResult>> {
    if (write.outcome !== "success") return write as GitHubOperationResult<GitHubIssueMutationResult>;
    const number = typeof write.value.number === "number" && Number.isSafeInteger(write.value.number) && write.value.number > 0 ? write.value.number : undefined;
    if (number === undefined) return failure("unknown", "malformed_response", "GitHub accepted the mutation but returned no Issue number.", write.correlationId, "unknown", write.response);
    const verified = await this.#reader.getIssue(number, { correlationId: write.correlationId });
    if (verified.outcome !== "success") return unknownVerification(write.correlationId, verified);
    return { ...write, value: { issue: verified.value, operation, changed: true, noOp: false, idempotencyKey } };
  }

  #mutationResult(issue: GitHubIssueSummary, operation: "created" | "updated", changed: boolean, idempotencyKey: string, correlationId: string): GitHubOperationResult<GitHubIssueMutationResult> {
    return { outcome: "success", value: { issue, operation, changed, noOp: !changed, idempotencyKey }, correlationId, remoteOutcome: "accepted" };
  }
}
