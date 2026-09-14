import { randomUUID } from "node:crypto";

import type { GitHubConfig } from "./config.js";
import { executeWithGitHubRetry, type GitHubRetryPolicyOptions } from "./retry-policy.js";
import { type GitHubOperationOutcome, type GitHubOperationResult } from "./outcome.js";
import { GitHubWriteQueue } from "./write-queue.js";
import type { GitHubIssueRef } from "./issue-read.js";
import type { GitHubRequestContext } from "./transport-types.js";

export const GITHUB_PROJECT_FIELD_NAMES = ["Status", "Priority", "Worker", "Area", "Risk", "Work Type", "Queue Order"] as const;
export type GitHubProjectFieldName = (typeof GITHUB_PROJECT_FIELD_NAMES)[number];
export type GitHubProjectSelectFieldName = Exclude<GitHubProjectFieldName, "Queue Order">;

const SELECT_OPTIONS: Readonly<Record<GitHubProjectSelectFieldName, readonly string[]>> = {
  Status: ["Todo", "Open", "In Progress", "Done"],
  Priority: ["P0", "P1", "P2", "P3"],
  Worker: ["Pirx", "Claude", "Codex", "Scout", "Human"],
  Area: ["Pirx Core", "GitHub", "Orchestrator", "Scheduler", "Checkpoint", "Agent Adapter", "Security", "Architecture Lab", "Research"],
  Risk: ["Low", "Medium", "High", "Prod-sensitive"],
  "Work Type": ["Epic", "Feature", "Task", "Bug", "Experiment", "Research"],
};

export type GitHubProjectMetadata = {
  readonly status?: string;
  readonly priority?: string;
  readonly worker?: string;
  readonly area?: string;
  readonly risk?: string;
  readonly workType?: string;
  readonly queueOrder?: number;
};

export interface GitHubProjectField {
  readonly id: string;
  readonly name: GitHubProjectFieldName;
  readonly kind: "single_select" | "number";
  readonly options?: Readonly<Record<string, string>>;
}

export interface GitHubProjectSchema {
  readonly id: string;
  readonly owner: string;
  readonly number: number;
  readonly fields: Readonly<Record<GitHubProjectFieldName, GitHubProjectField>>;
}

export interface GitHubProjectItem {
  readonly id: string;
  readonly issueNodeId: string;
  readonly values: Readonly<Partial<Record<GitHubProjectFieldName, string | number>>>;
}

export type GitHubProjectSyncOutcome =
  | "synchronized"
  | "no_op"
  | "schema_drift"
  | "mapping_error"
  | "not_found"
  | "partial"
  | "provider_error"
  | "rate_limited"
  | "unknown"
  | "invalid_request";

export interface GitHubProjectResult<T> {
  readonly outcome: GitHubProjectSyncOutcome;
  readonly correlationId: string;
  readonly message: string;
  readonly value?: T;
  readonly providerOutcome?: GitHubOperationOutcome;
  readonly changedFields?: readonly GitHubProjectFieldName[];
  readonly pendingFields?: readonly GitHubProjectFieldName[];
}

export interface GitHubProjectTransport {
  graphqlRead<T>(request: { readonly query: string; readonly variables?: Readonly<Record<string, unknown>> }, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
  graphqlWrite<T>(request: { readonly query: string; readonly variables?: Readonly<Record<string, unknown>> }, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
}

export interface GitHubProjectSchemaResolverOptions {
  readonly retryPolicy?: GitHubRetryPolicyOptions;
  readonly timeoutMs?: number;
}

interface RawProjectField {
  readonly __typename?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly dataType?: unknown;
  readonly options?: unknown;
}

interface RawProjectSchemaPayload {
  readonly user?: { readonly projectV2?: unknown } | null;
  readonly organization?: { readonly projectV2?: unknown } | null;
}

interface RawProjectItem {
  readonly id?: unknown;
  readonly content?: unknown;
  readonly fieldValues?: unknown;
}

interface RawProjectItemsPayload {
  readonly node?: { readonly items?: unknown } | null;
}

interface RawAddItemPayload {
  readonly addProjectV2ItemById?: { readonly item?: { readonly id?: unknown } | null } | null;
}

interface RawUpdateFieldPayload {
  readonly updateProjectV2ItemFieldValue?: { readonly projectV2Item?: { readonly id?: unknown } | null } | null;
}

const USER_SCHEMA_QUERY = `query PirxProjectSchemaForUser($owner: String!, $number: Int!) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 100) {
        nodes {
          __typename
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

const ORGANIZATION_SCHEMA_QUERY = `query PirxProjectSchemaForOrganization($owner: String!, $number: Int!) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 100) {
        nodes {
          __typename
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

const ITEMS_QUERY = `query PirxProjectItems($projectId: ID!, $after: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        nodes {
          id
          content { __typename ... on Issue { id } }
          fieldValues(first: 100) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                optionId
                field { __typename ... on ProjectV2Field { name } ... on ProjectV2SingleSelectField { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { __typename ... on ProjectV2Field { name } }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const ADD_ITEM_MUTATION = `mutation PirxAddProjectItem($input: AddProjectV2ItemByIdInput!) {
  addProjectV2ItemById(input: $input) { item { id } }
}`;

const UPDATE_FIELD_MUTATION = `mutation PirxUpdateProjectField($input: UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function success<T>(value: T, correlationId: string, message: string, extra: Partial<GitHubProjectResult<T>> = {}): GitHubProjectResult<T> {
  return { outcome: "synchronized", correlationId, message, value, ...extra };
}
function projectFailure<T>(outcome: GitHubProjectSyncOutcome, correlationId: string, message: string, extra: Partial<GitHubProjectResult<T>> = {}): GitHubProjectResult<T> {
  return { outcome, correlationId, message, ...extra };
}
function providerFailure<T>(result: GitHubOperationResult<unknown>, correlationId: string, operation: string): GitHubProjectResult<T> {
  if (result.outcome === "success") return projectFailure("unknown", correlationId, `${operation} returned an unexpected success shape.`);
  const outcome = result.outcome === "rate_limited" ? "rate_limited" : result.outcome === "unknown" ? "unknown" : "provider_error";
  return projectFailure(outcome, correlationId, `${operation} failed: ${result.error.message}`, { providerOutcome: result.outcome });
}
function valueMap(metadata: GitHubProjectMetadata, correlationId: string): GitHubProjectResult<Readonly<Partial<Record<GitHubProjectFieldName, string | number>>>> {
  const values: Partial<Record<GitHubProjectFieldName, string | number>> = {};
  const pairs: readonly [GitHubProjectFieldName, string | number | undefined][] = [
    ["Status", metadata.status], ["Priority", metadata.priority], ["Worker", metadata.worker], ["Area", metadata.area], ["Risk", metadata.risk], ["Work Type", metadata.workType], ["Queue Order", metadata.queueOrder],
  ];
  for (const [name, value] of pairs) {
    if (value === undefined) continue;
    if (name === "Queue Order") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return projectFailure("mapping_error", correlationId, "Queue Order must be a positive integer.");
    } else if (typeof value !== "string" || !SELECT_OPTIONS[name].includes(value)) {
      return projectFailure("mapping_error", correlationId, `Unsupported Project mapping for ${name}.`);
    }
    values[name] = value;
  }
  return success(Object.freeze(values), correlationId, "Project metadata mapping is valid.");
}
function parsePageInfo(value: unknown): { readonly hasNextPage: boolean; readonly endCursor?: string } | undefined {
  if (!isRecord(value) || typeof value.hasNextPage !== "boolean") return undefined;
  const endCursor = stringValue(value.endCursor);
  return { hasNextPage: value.hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) };
}
function parseSchema(owner: string, number: number, value: unknown): GitHubProjectResult<GitHubProjectSchema> {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.fields) || !Array.isArray(value.fields.nodes)) return projectFailure("schema_drift", "schema", "GitHub Project schema response is incomplete.");
  const pageInfo = parsePageInfo(value.fields.pageInfo);
  if (pageInfo?.hasNextPage === true) return projectFailure("schema_drift", "schema", "GitHub Project has more than 100 fields; schema resolution is bounded.");
  const fields = new Map<string, RawProjectField>();
  const duplicates = new Set<string>();
  for (const raw of value.fields.nodes) {
    if (!isRecord(raw)) continue;
    const field = raw as RawProjectField;
    const name = stringValue(field.name);
    if (name === undefined) continue;
    if (fields.has(name)) duplicates.add(name); else fields.set(name, field);
  }
  if (duplicates.size > 0) return projectFailure("schema_drift", "schema", `Duplicate Project fields: ${[...duplicates].sort().join(", ")}.`);
  const parsed: Partial<Record<GitHubProjectFieldName, GitHubProjectField>> = {};
  for (const name of GITHUB_PROJECT_FIELD_NAMES) {
    const raw = fields.get(name);
    const id = raw === undefined ? undefined : stringValue(raw.id);
    if (raw === undefined || id === undefined) return projectFailure("schema_drift", "schema", `Missing Project field: ${name}.`);
    if (name === "Queue Order") {
      if (raw.__typename !== "ProjectV2Field" || raw.dataType !== "NUMBER") return projectFailure("schema_drift", "schema", `Project field ${name} is not a numeric field.`);
      parsed[name] = { id, name, kind: "number" };
      continue;
    }
    if (raw.__typename !== "ProjectV2SingleSelectField" || !Array.isArray(raw.options)) return projectFailure("schema_drift", "schema", `Project field ${name} is not a single-select field.`);
    const options: Record<string, string> = {};
    for (const option of raw.options) {
      if (!isRecord(option)) continue;
      const optionId = stringValue(option.id);
      const optionName = stringValue(option.name);
      if (optionId !== undefined && optionName !== undefined) options[optionName] = optionId;
    }
    const missing = SELECT_OPTIONS[name].filter((option) => options[option] === undefined);
    if (missing.length > 0) return projectFailure("schema_drift", "schema", `Project field ${name} is missing options: ${missing.join(", ")}.`);
    parsed[name] = { id, name, kind: "single_select", options: Object.freeze(options) };
  }
  return success(Object.freeze({ id: value.id, owner, number, fields: Object.freeze(parsed as Record<GitHubProjectFieldName, GitHubProjectField>) }), "schema", "Project schema resolved.");
}
function parseProject(payload: RawProjectSchemaPayload): unknown {
  const user = isRecord(payload.user) ? payload.user.projectV2 : undefined;
  if (user !== undefined && user !== null) return user;
  const organization = isRecord(payload.organization) ? payload.organization.projectV2 : undefined;
  return organization;
}

export class GitHubProjectSchemaResolver {
  readonly #transport: GitHubProjectTransport;
  readonly #owner: string;
  readonly #number: number;
  readonly #timeoutMs: number;
  readonly #retryPolicy: GitHubRetryPolicyOptions;
  #cached: GitHubProjectSchema | undefined;

  public constructor(transport: GitHubProjectTransport, config: Pick<GitHubConfig, "projectOwner" | "projectNumber" | "timeoutMs">, options: GitHubProjectSchemaResolverOptions = {}) {
    if (config.projectOwner === undefined || config.projectNumber === undefined) throw new Error("GitHub Project owner and number are required.");
    if (!Number.isSafeInteger(options.timeoutMs ?? config.timeoutMs) || (options.timeoutMs ?? config.timeoutMs) <= 0) throw new RangeError("GitHub Project timeout must be positive.");
    this.#transport = transport;
    this.#owner = config.projectOwner;
    this.#number = config.projectNumber;
    this.#timeoutMs = options.timeoutMs ?? config.timeoutMs;
    this.#retryPolicy = options.retryPolicy ?? {};
  }

  public invalidate(): void { this.#cached = undefined; }
  public get cached(): GitHubProjectSchema | undefined { return this.#cached; }
  public async resolve(options: { readonly correlationId?: string; readonly forceRefresh?: boolean } = {}): Promise<GitHubProjectResult<GitHubProjectSchema>> {
    const correlationId = options.correlationId?.trim() || randomUUID();
    if (this.#cached !== undefined && options.forceRefresh !== true) return success(this.#cached, correlationId, "Project schema cache hit.");
    const user = await this.#read(USER_SCHEMA_QUERY, { owner: this.#owner, number: this.#number }, correlationId);
    let response = user;
    if (user.outcome === "success") {
      const parsed = parseProject(user.value as RawProjectSchemaPayload);
      if (parsed === undefined || parsed === null) response = await this.#read(ORGANIZATION_SCHEMA_QUERY, { owner: this.#owner, number: this.#number }, correlationId);
      else {
        const schema = parseSchema(this.#owner, this.#number, parsed);
        if (schema.outcome === "synchronized" && schema.value !== undefined) this.#cached = schema.value;
        else this.invalidate();
        return { ...schema, correlationId };
      }
    } else {
      response = await this.#read(ORGANIZATION_SCHEMA_QUERY, { owner: this.#owner, number: this.#number }, correlationId);
    }
    if (response.outcome !== "success") return providerFailure(response, correlationId, "Project schema read");
    const parsed = parseProject(response.value as RawProjectSchemaPayload);
    if (parsed === undefined || parsed === null) return projectFailure("not_found", correlationId, `GitHub Project ${this.#owner}/${this.#number} was not found.`);
    const schema = parseSchema(this.#owner, this.#number, parsed);
    if (schema.outcome === "synchronized" && schema.value !== undefined) this.#cached = schema.value;
    else this.invalidate();
    return { ...schema, correlationId };
  }

  public async refresh(correlationId?: string): Promise<GitHubProjectResult<GitHubProjectSchema>> {
    this.invalidate();
    return this.resolve({ ...(correlationId === undefined ? {} : { correlationId }), forceRefresh: true });
  }

  async #read<T>(query: string, variables: Readonly<Record<string, unknown>>, correlationId: string): Promise<GitHubOperationResult<T>> {
    const decision = await executeWithGitHubRetry({ operation: "read", correlationId, execute: ({ signal }) => this.#transport.graphqlRead<T>({ query, variables }, { correlationId, ...(signal === undefined ? {} : { signal }), timeoutMs: this.#timeoutMs }) }, this.#retryPolicy);
    return decision.finalOutcome;
  }
}

export interface GitHubProjectSynchronizerOptions extends GitHubProjectSchemaResolverOptions {
  readonly writeQueue?: GitHubWriteQueue;
}

function fieldValueName(value: unknown): GitHubProjectFieldName | undefined {
  return GITHUB_PROJECT_FIELD_NAMES.includes(value as GitHubProjectFieldName) ? value as GitHubProjectFieldName : undefined;
}
function parseItem(raw: unknown): GitHubProjectItem | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.content) || typeof raw.content.id !== "string" || !isRecord(raw.fieldValues) || !Array.isArray(raw.fieldValues.nodes)) return undefined;
  const values: Partial<Record<GitHubProjectFieldName, string | number>> = {};
  for (const rawValue of raw.fieldValues.nodes) {
    if (!isRecord(rawValue) || !isRecord(rawValue.field)) continue;
    const name = fieldValueName(rawValue.field.name);
    if (name === undefined) continue;
    if (rawValue.__typename === "ProjectV2ItemFieldSingleSelectValue" && typeof rawValue.name === "string") values[name] = rawValue.name;
    if (rawValue.__typename === "ProjectV2ItemFieldNumberValue" && typeof rawValue.number === "number" && Number.isFinite(rawValue.number)) values[name] = rawValue.number;
  }
  return { id: raw.id, issueNodeId: raw.content.id, values: Object.freeze(values) };
}
function diff(schema: GitHubProjectSchema, item: GitHubProjectItem, desired: Readonly<Partial<Record<GitHubProjectFieldName, string | number>>>): readonly GitHubProjectFieldName[] {
  return GITHUB_PROJECT_FIELD_NAMES.filter((name) => desired[name] !== undefined && item.values[name] !== desired[name] && schema.fields[name] !== undefined);
}
function fieldInput(schema: GitHubProjectSchema, name: GitHubProjectFieldName, value: string | number): Readonly<Record<string, unknown>> {
  const field = schema.fields[name];
  return { projectId: schema.id, fieldId: field.id, value: field.kind === "number" ? { number: value } : { singleSelectOptionId: field.options?.[String(value)] } };
}

export class GitHubProjectSynchronizer {
  readonly #transport: GitHubProjectTransport;
  readonly #schema: GitHubProjectSchemaResolver;
  readonly #queue: GitHubWriteQueue;
  readonly #timeoutMs: number;
  readonly #retryPolicy: GitHubRetryPolicyOptions;

  public constructor(transport: GitHubProjectTransport, config: Pick<GitHubConfig, "projectOwner" | "projectNumber" | "timeoutMs">, options: GitHubProjectSynchronizerOptions = {}) {
    this.#transport = transport;
    this.#schema = new GitHubProjectSchemaResolver(transport, config, options);
    this.#queue = options.writeQueue ?? new GitHubWriteQueue();
    this.#timeoutMs = options.timeoutMs ?? config.timeoutMs;
    this.#retryPolicy = options.retryPolicy ?? {};
  }

  public get schema(): GitHubProjectSchemaResolver { return this.#schema; }

  public async synchronize(issue: GitHubIssueRef, metadata: GitHubProjectMetadata, options: { readonly correlationId?: string } = {}): Promise<GitHubProjectResult<GitHubProjectItem>> {
    const correlationId = options.correlationId?.trim() || randomUUID();
    if (issue.nodeId.trim().length === 0 || !Number.isSafeInteger(issue.number) || issue.number <= 0) return projectFailure("invalid_request", correlationId, "A canonical Issue reference is required.");
    const mapped = valueMap(metadata, correlationId);
    if (mapped.outcome !== "synchronized" || mapped.value === undefined) return mapped as GitHubProjectResult<GitHubProjectItem>;
    const schema = await this.#schema.resolve({ correlationId });
    if (schema.outcome !== "synchronized" || schema.value === undefined) return projectFailure(schema.outcome, correlationId, schema.message, { ...(schema.providerOutcome === undefined ? {} : { providerOutcome: schema.providerOutcome }) });
    let item = await this.#findItem(schema.value, issue.nodeId, correlationId);
    let added = false;
    if (item.outcome === "not_found") {
      const addedItem = await this.#addItem(schema.value, issue.nodeId, correlationId);
      if (addedItem.outcome !== "synchronized" || addedItem.value === undefined) return addedItem as GitHubProjectResult<GitHubProjectItem>;
      item = success({ id: addedItem.value.id, issueNodeId: issue.nodeId, values: Object.freeze({}) }, correlationId, "Issue was added to the Project.");
      added = true;
    }
    if (item.outcome !== "synchronized" || item.value === undefined) return item;
    const pending = diff(schema.value, item.value, mapped.value);
    if (pending.length === 0) return projectFailure(added ? "synchronized" : "no_op", correlationId, added ? "Issue was added; no metadata changes were required." : "Project metadata already matches the desired state.", { value: item.value, changedFields: [] });
    const changed: GitHubProjectFieldName[] = [];
    for (const name of pending) {
      const value = mapped.value[name];
      if (value === undefined) continue;
      const update = await this.#updateField(schema.value, item.value.id, name, value, correlationId);
      if (update.outcome !== "synchronized") {
        this.#schema.invalidate();
        const reread = await this.#findItem(schema.value, issue.nodeId, correlationId);
        const observed = reread.outcome === "synchronized" && reread.value !== undefined ? diff(schema.value, reread.value, mapped.value) : pending.filter((field) => !changed.includes(field));
        return projectFailure(changed.length > 0 || added ? "partial" : update.outcome, correlationId, `Project synchronization stopped after ${changed.length} field updates.`, { ...(update.providerOutcome === undefined ? {} : { providerOutcome: update.providerOutcome }), changedFields: changed, pendingFields: observed });
      }
      changed.push(name);
    }
    const finalItem = await this.#findItem(schema.value, issue.nodeId, correlationId);
    return success(finalItem.outcome === "synchronized" && finalItem.value !== undefined ? finalItem.value : { ...item.value, values: mapped.value }, correlationId, added ? "Issue was added and Project metadata synchronized." : "Project metadata synchronized.", { changedFields: changed, pendingFields: [] });
  }

  async #findItem(schema: GitHubProjectSchema, issueNodeId: string, correlationId: string): Promise<GitHubProjectResult<GitHubProjectItem>> {
    let after: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.#read<RawProjectItemsPayload>(ITEMS_QUERY, { projectId: schema.id, after }, correlationId);
      if (result.outcome !== "success") return providerFailure(result, correlationId, "Project item read");
      const items = isRecord(result.value.node) && isRecord(result.value.node.items) ? result.value.node.items : undefined;
      if (!isRecord(items) || !Array.isArray(items.nodes)) return projectFailure("schema_drift", correlationId, "Project item response is incomplete.");
      for (const raw of items.nodes) {
        const parsed = parseItem(raw);
        if (parsed?.issueNodeId === issueNodeId) return success(parsed, correlationId, "Project item found.");
      }
      const pageInfo = parsePageInfo(items.pageInfo);
      if (pageInfo?.hasNextPage !== true) return projectFailure("not_found", correlationId, "Issue is not present in the configured Project.");
      if (pageInfo.endCursor === undefined) return projectFailure("schema_drift", correlationId, "Project item pagination did not provide a cursor.");
      after = pageInfo.endCursor;
    }
    return projectFailure("schema_drift", correlationId, "Project contains more than 1,000 items; item lookup is bounded.");
  }

  async #addItem(schema: GitHubProjectSchema, issueNodeId: string, correlationId: string): Promise<GitHubProjectResult<{ readonly id: string }>> {
    const result = await this.#queue.submit<RawAddItemPayload>({ operationKind: "add_project_item", idempotencyKey: `project-item:${schema.id}:${issueNodeId}`, target: `project:${schema.id}`, payloadIdentity: issueNodeId, timeoutMs: this.#timeoutMs, idempotent: true, retryPolicy: this.#retryPolicy, correlationId, execute: (context) => this.#transport.graphqlWrite<RawAddItemPayload>({ query: ADD_ITEM_MUTATION, variables: { input: { projectId: schema.id, contentId: issueNodeId } } }, context) });
    if (result.outcome !== "success") return providerFailure(result, correlationId, "Project item add");
    const id = isRecord(result.value.addProjectV2ItemById?.item) ? stringValue(result.value.addProjectV2ItemById.item.id) : undefined;
    return id === undefined ? projectFailure("unknown", correlationId, "Project accepted the item add but returned no item ID.", { providerOutcome: result.outcome }) : success({ id }, correlationId, "Issue was added to the Project.");
  }

  async #updateField(schema: GitHubProjectSchema, itemId: string, name: GitHubProjectFieldName, value: string | number, correlationId: string): Promise<GitHubProjectResult<{ readonly id: string }>> {
    const field = schema.fields[name];
    const input = fieldInput(schema, name, value);
    const result = await this.#queue.submit<RawUpdateFieldPayload>({ operationKind: "update_project_field", idempotencyKey: `project-field:${schema.id}:${itemId}:${name}:${String(value)}`, target: `project-item:${itemId}`, payloadIdentity: JSON.stringify(input), timeoutMs: this.#timeoutMs, idempotent: true, retryPolicy: this.#retryPolicy, correlationId, execute: (context) => this.#transport.graphqlWrite<RawUpdateFieldPayload>({ query: UPDATE_FIELD_MUTATION, variables: { input: { ...input, itemId } } }, context) });
    if (result.outcome !== "success") return providerFailure(result, correlationId, `Project field ${name} update`);
    const id = isRecord(result.value.updateProjectV2ItemFieldValue?.projectV2Item) ? stringValue(result.value.updateProjectV2ItemFieldValue.projectV2Item.id) : undefined;
    return id === undefined ? projectFailure("unknown", correlationId, `Project field ${name} update returned no item ID.`, { providerOutcome: result.outcome }) : success({ id }, correlationId, `Project field ${name} updated.`);
  }

  async #read<T>(query: string, variables: Readonly<Record<string, unknown>>, correlationId: string): Promise<GitHubOperationResult<T>> {
    const decision = await executeWithGitHubRetry({ operation: "read", correlationId, execute: ({ signal }) => this.#transport.graphqlRead<T>({ query, variables }, { correlationId, ...(signal === undefined ? {} : { signal }), timeoutMs: this.#timeoutMs }) }, this.#retryPolicy);
    return decision.finalOutcome;
  }
}

export function projectFailureFromGitHub<T>(result: GitHubOperationResult<unknown>, correlationId: string, operation: string): GitHubProjectResult<T> {
  return providerFailure(result, correlationId, operation);
}
