import { createHash } from "node:crypto";

import type { GitHubConfig } from "./config.js";
import { failure, type GitHubOperationResult } from "./outcome.js";
import { executeWithGitHubRetry, type GitHubRetryPolicyOptions } from "./retry-policy.js";
import type { GitHubRequestContext, GitHubRestReadRequest, GitHubRestWriteRequest } from "./transport-types.js";
import { GitHubWriteQueue } from "./write-queue.js";

export interface GitHubPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly title?: string;
  readonly body?: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly merged: boolean;
  readonly mergeable?: boolean;
  readonly mergeCommitSha?: string;
}
export interface GitHubBranchHead { readonly branch: string; readonly sha: string; }
export interface GitHubPullRequestCreateInput {
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly timeoutMs?: number;
}
export interface GitHubPullRequestGatewayPort {
  getBranchHead(branch: string, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubBranchHead>>;
  listPullRequests(headBranch: string, baseBranch: string, context: GitHubRequestContext): Promise<GitHubOperationResult<readonly GitHubPullRequest[]>>;
  getPullRequest(number: number, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubPullRequest>>;
  createPullRequest(input: GitHubPullRequestCreateInput): Promise<GitHubOperationResult<GitHubPullRequest>>;
  mergePullRequest?(number: number, expectedHeadSha: string, input: { readonly idempotencyKey: string; readonly correlationId: string; readonly timeoutMs?: number; readonly mergeMethod?: "squash" | "merge" | "rebase" }): Promise<GitHubOperationResult<GitHubPullRequestMergeResult>>;
  getApprovedReviewCount?(number: number, context: GitHubRequestContext): Promise<GitHubOperationResult<number>>;
}
export interface GitHubPullRequestMergeResult { readonly merged: boolean; readonly sha?: string; readonly message?: string; }
export interface GitHubPullRequestTransport {
  restRead<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
  restWrite<T>(request: GitHubRestWriteRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
}

interface RefPayload { readonly object?: unknown; }
interface PullPayload { readonly number?: unknown; readonly html_url?: unknown; readonly state?: unknown; readonly title?: unknown; readonly body?: unknown; readonly head?: unknown; readonly base?: unknown; readonly merged?: unknown; readonly mergeable?: unknown; readonly merge_commit_sha?: unknown; }
interface MergePayload { readonly merged?: unknown; readonly sha?: unknown; readonly message?: unknown; }
const DEFAULT_RETRY: GitHubRetryPolicyOptions = { maxAttempts: 2, maxTotalDelayMs: 5_000, baseDelayMs: 250, maxDelayMs: 2_000, jitterRatio: 0 };
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, max = 2_048): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= max && !(/[\u0000-\u001f\u007f]/u.test(value)) ? value : undefined; }
function markdown(value: unknown, max = 65_536): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= max && !(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) ? value : undefined; }
function positive(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function sha(value: unknown): string | undefined { const candidate = text(value, 128); return candidate !== undefined && /^[A-Za-z0-9._-]+$/u.test(candidate) ? candidate : undefined; }
function url(value: unknown): string | undefined { const candidate = text(value); return candidate !== undefined && /^https:\/\/github\.com\//u.test(candidate) ? candidate : undefined; }
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function repoPath(config: GitHubConfig): string { return "/repos/" + encodeURIComponent(config.owner) + "/" + encodeURIComponent(config.repository); }
function malformed(correlationId: string): GitHubOperationResult<never> { return failure("permanent_error", "malformed_response", "GitHub returned malformed pull request data.", correlationId, "not_accepted"); }
function mapPull(value: unknown): GitHubPullRequest | undefined {
  if (!isRecord(value)) return undefined;
  const number = positive(value.number); const pullUrl = url(value.html_url);
  const state = value.state === "open" || value.state === "closed" ? value.state : undefined;
  const head = isRecord(value.head) ? value.head : undefined; const base = isRecord(value.base) ? value.base : undefined;
  const headBranch = text(head?.ref, 512); const headSha = sha(head?.sha); const baseBranch = text(base?.ref, 512);
  if (number === undefined || pullUrl === undefined || state === undefined || headBranch === undefined || headSha === undefined || baseBranch === undefined) return undefined;
  const title = value.title === undefined || value.title === null ? undefined : text(value.title, 512);
  const body = value.body === undefined || value.body === null ? undefined : markdown(value.body);
  const mergeCommitSha = sha(value.merge_commit_sha);
  return { number, url: pullUrl, state, ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), headBranch, headSha, baseBranch, merged: value.merged === true, ...(typeof value.mergeable === "boolean" ? { mergeable: value.mergeable } : {}), ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }) };
}

export class GitHubPullRequestGateway implements GitHubPullRequestGatewayPort {
  readonly #transport: GitHubPullRequestTransport;
  readonly #config: GitHubConfig;
  readonly #queue: GitHubWriteQueue;
  readonly #retry: GitHubRetryPolicyOptions;
  public constructor(transport: GitHubPullRequestTransport, config: GitHubConfig, queue = new GitHubWriteQueue(), options: { readonly retryPolicy?: GitHubRetryPolicyOptions } = {}) { this.#transport = transport; this.#config = config; this.#queue = queue; this.#retry = { ...DEFAULT_RETRY, ...options.retryPolicy }; }
  public async getBranchHead(branch: string, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubBranchHead>> {
    const result = await this.#read<RefPayload>({ method: "GET", path: repoPath(this.#config) + "/git/ref/heads/" + encodeURIComponent(branch) }, context);
    if (result.outcome !== "success") return result;
    const object = isRecord(result.value.object) ? result.value.object : undefined; const revision = sha(object?.sha);
    return revision === undefined ? malformed(result.correlationId) : { ...result, value: { branch, sha: revision } };
  }
  public async listPullRequests(headBranch: string, baseBranch: string, context: GitHubRequestContext): Promise<GitHubOperationResult<readonly GitHubPullRequest[]>> {
    const result = await this.#read<unknown[]>({ method: "GET", path: repoPath(this.#config) + "/pulls", query: { head: this.#config.owner + ":" + headBranch, base: baseBranch, state: "open", per_page: 100 } }, context);
    if (result.outcome !== "success") return result;
    if (!Array.isArray(result.value)) return malformed(result.correlationId);
    const pulls = result.value.map(mapPull);
    return pulls.some((pull) => pull === undefined) ? malformed(result.correlationId) : { ...result, value: pulls as GitHubPullRequest[] };
  }
  public async getPullRequest(number: number, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubPullRequest>> {
    const result = await this.#read<PullPayload>({ method: "GET", path: repoPath(this.#config) + "/pulls/" + String(number) }, context);
    if (result.outcome !== "success") return result;
    const pull = mapPull(result.value);
    return pull === undefined ? malformed(result.correlationId) : { ...result, value: pull };
  }
  public async createPullRequest(input: GitHubPullRequestCreateInput): Promise<GitHubOperationResult<GitHubPullRequest>> {
    const payload = { title: input.title, head: input.headBranch, base: input.baseBranch, body: input.body };
    const result = await this.#queue.submit<PullPayload>({
      operationKind: "create_feature_pull_request", idempotencyKey: input.idempotencyKey, target: "repository:" + this.#config.owner + "/" + this.#config.repository,
      correlationId: input.correlationId, payloadIdentity: digest(JSON.stringify(payload)), timeoutMs: input.timeoutMs ?? this.#config.timeoutMs, idempotent: true,
      execute: (context) => this.#transport.restWrite<PullPayload>({ method: "POST", path: repoPath(this.#config) + "/pulls", body: payload }, context),
    });
    if (result.outcome !== "success") return result as GitHubOperationResult<GitHubPullRequest>;
    const pull = mapPull(result.value);
    return pull === undefined ? failure("unknown", "malformed_response", "GitHub accepted the pull request but returned no usable identity.", result.correlationId, "unknown") : { ...result, value: pull };
  }
  public async mergePullRequest(number: number, expectedHeadSha: string, input: { readonly idempotencyKey: string; readonly correlationId: string; readonly timeoutMs?: number; readonly mergeMethod?: "squash" | "merge" | "rebase" }): Promise<GitHubOperationResult<GitHubPullRequestMergeResult>> {
    const result = await this.#queue.submit<MergePayload>({
      operationKind: "merge_feature_pull_request", idempotencyKey: input.idempotencyKey, target: "pull:" + this.#config.owner + "/" + this.#config.repository + "#" + number,
      correlationId: input.correlationId, payloadIdentity: expectedHeadSha, timeoutMs: input.timeoutMs ?? this.#config.timeoutMs, idempotent: true,
      execute: (context) => this.#transport.restWrite<MergePayload>({ method: "PUT", path: repoPath(this.#config) + "/pulls/" + String(number) + "/merge", body: { sha: expectedHeadSha, merge_method: input.mergeMethod ?? "squash" } }, context),
    });
    if (result.outcome !== "success") return result;
    if (result.value.merged !== true) return failure("permanent_error", "conflict", text(result.value.message, 256) ?? "GitHub did not merge the feature pull request.", result.correlationId, "not_accepted", result.response);
    const mergedSha = sha(result.value.sha); const mergeMessage = text(result.value.message, 256);
    return { ...result, value: { merged: true, ...(mergedSha === undefined ? {} : { sha: mergedSha }), ...(mergeMessage === undefined ? {} : { message: mergeMessage }) } };
  }
  public async getApprovedReviewCount(number: number, context: GitHubRequestContext): Promise<GitHubOperationResult<number>> {
    const result = await this.#read<unknown[]>({ method: "GET", path: repoPath(this.#config) + "/pulls/" + String(number) + "/reviews", query: { per_page: 100 } }, context);
    if (result.outcome !== "success") return result;
    if (!Array.isArray(result.value)) return malformed(result.correlationId);
    const latest = new Map<string, string>();
    for (const item of result.value) {
      if (!isRecord(item) || typeof item.user !== "object" || item.user === null || typeof (item.user as Record<string, unknown>).id !== "number" || typeof item.state !== "string") return malformed(result.correlationId);
      latest.set(String((item.user as Record<string, unknown>).id), item.state);
    }
    return { ...result, value: [...latest.values()].filter((state) => state === "APPROVED").length };
  }
  public async close(): Promise<void> { await this.#queue.close({ drain: true }); }
  async #read<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    const decision = await executeWithGitHubRetry<T>({ operation: "read", correlationId: context.correlationId, ...(context.signal === undefined ? {} : { signal: context.signal }), execute: ({ signal }) => this.#transport.restRead<T>(request, { ...context, ...(signal === undefined ? {} : { signal }) }) }, this.#retry);
    return decision.finalOutcome;
  }
}
