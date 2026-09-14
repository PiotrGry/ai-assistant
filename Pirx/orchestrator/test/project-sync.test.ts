import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubProjectSchemaResolver,
  GitHubProjectSynchronizer,
  failure,
  success,
  type GitHubIssueRef,
  type GitHubProjectTransport,
  type GitHubOperationResult,
  type GitHubRequestContext,
} from "../src/index.js";

const owner = "PiotrGry";
const projectId = "PVT_project-1";
const issue: GitHubIssueRef = { owner, repository: "ai-assistant", nodeId: "I_issue-1", number: 56, url: "https://github.com/PiotrGry/ai-assistant/issues/56" };

const selectOptions: Readonly<Record<string, readonly string[]>> = {
  Status: ["Todo", "Open", "In Progress", "Done"],
  Priority: ["P0", "P1", "P2", "P3"],
  Worker: ["Pirx", "Claude", "Codex", "Scout", "Human"],
  Area: ["Pirx Core", "GitHub", "Orchestrator", "Scheduler", "Checkpoint", "Agent Adapter", "Security", "Architecture Lab", "Research"],
  Risk: ["Low", "Medium", "High", "Prod-sensitive"],
  "Work Type": ["Epic", "Feature", "Task", "Bug", "Experiment", "Research"],
};

function schemaPayload(options: { readonly missingField?: string; readonly duplicateField?: string; readonly missingOption?: string } = {}) {
  const names = ["Status", "Priority", "Worker", "Area", "Risk", "Work Type", "Queue Order"];
  const nodes: unknown[] = [];
  for (const name of names) {
    if (name === options.missingField) continue;
    if (name === "Queue Order") {
      nodes.push({ __typename: "ProjectV2Field", id: "field-queue", name, dataType: "NUMBER" });
      continue;
    }
    const optionsForField = (selectOptions[name] ?? []).filter((option) => `${name}:${option}` !== options.missingOption).map((option) => ({ id: `${name}:${option}`, name: option }));
    const node = { __typename: "ProjectV2SingleSelectField", id: `field-${name}`, name, options: optionsForField };
    nodes.push(node);
    if (name === options.duplicateField) nodes.push({ ...node, id: `${node.id}-duplicate` });
  }
  return { id: projectId, fields: { nodes, pageInfo: { hasNextPage: false } } };
}

function itemPayload(item: { readonly id: string; readonly values: Readonly<Record<string, string | number>> } | undefined) {
  const nodes = item === undefined ? [] : [{
    id: item.id,
    content: { __typename: "Issue", id: issue.nodeId },
    fieldValues: {
      nodes: Object.entries(item.values).map(([name, value]) => typeof value === "number"
        ? { __typename: "ProjectV2ItemFieldNumberValue", number: value, field: { __typename: "ProjectV2Field", name } }
        : { __typename: "ProjectV2ItemFieldSingleSelectValue", name: value, optionId: `${name}:${value}`, field: { __typename: "ProjectV2SingleSelectField", name } }),
    },
  }];
  return { node: { items: { nodes, pageInfo: { hasNextPage: false } } } };
}

class FakeProjectTransport implements GitHubProjectTransport {
  schema: unknown = schemaPayload();
  item: { id: string; values: Record<string, string | number> } | undefined = { id: "PVTI_item-1", values: { Status: "Open", Priority: "P1" } };
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  failUpdateField?: string;
  failureMode: "none" | "rate_limited" | "unknown" = "none";

  async graphqlRead<T>(request: { readonly query: string; readonly variables?: Readonly<Record<string, unknown>> }, _context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    this.reads.push(request.query);
    if (request.query.includes("PirxProjectSchemaForUser")) return success({ user: { projectV2: this.schema } }, "fake") as GitHubOperationResult<T>;
    if (request.query.includes("PirxProjectSchemaForOrganization")) return success({ organization: { projectV2: null } }, "fake") as GitHubOperationResult<T>;
    return success(itemPayload(this.item), "fake") as GitHubOperationResult<T>;
  }

  async graphqlWrite<T>(request: { readonly query: string; readonly variables?: Readonly<Record<string, unknown>> }, _context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    this.writes.push(request.query);
    if (this.failureMode === "rate_limited") return failure("rate_limited", "rate_limited", "rate limited", "fake", "not_accepted") as GitHubOperationResult<T>;
    if (this.failureMode === "unknown") return failure("unknown", "unknown", "unknown result", "fake", "unknown") as GitHubOperationResult<T>;
    if (request.query.includes("PirxAddProjectItem")) {
      this.item = { id: "PVTI_item-added", values: {} };
      return success({ addProjectV2ItemById: { item: { id: this.item.id } } }, "fake") as GitHubOperationResult<T>;
    }
    const input = request.variables?.input as { fieldId?: string; itemId?: string; value?: { singleSelectOptionId?: string; number?: number } } | undefined;
    const fieldId = input?.fieldId;
    const name = fieldId === "field-queue" ? "Queue Order" : fieldId?.replace(/^field-/u, "");
    if (name === this.failUpdateField) return failure("rate_limited", "rate_limited", "partial failure", "fake", "not_accepted") as GitHubOperationResult<T>;
    if (name !== undefined && input?.value !== undefined && this.item !== undefined) {
      this.item.values[name] = input.value.number ?? input.value.singleSelectOptionId?.split(":").slice(1).join(":") ?? "";
    }
    return success({ updateProjectV2ItemFieldValue: { projectV2Item: { id: input?.itemId } } }, "fake") as GitHubOperationResult<T>;
  }
}

const config = { projectOwner: owner, projectNumber: 3, timeoutMs: 1_000 } as const;

test("resolves the named Project schema, caches it, and refreshes explicitly", async () => {
  const transport = new FakeProjectTransport();
  const resolver = new GitHubProjectSchemaResolver(transport, config, { retryPolicy: { maxAttempts: 1 } });
  const first = await resolver.resolve({ correlationId: "schema-1" });
  assert.equal(first.outcome, "synchronized");
  assert.equal(transport.reads.length, 1);
  assert.equal((await resolver.resolve({ correlationId: "schema-2" })).message, "Project schema cache hit.");
  assert.equal(transport.reads.length, 1);
  resolver.invalidate();
  assert.equal((await resolver.refresh("schema-3")).outcome, "synchronized");
  assert.equal(transport.reads.length, 2);
});

test("synchronizes only changed fields and replays as a no-op", async () => {
  const transport = new FakeProjectTransport();
  const synchronizer = new GitHubProjectSynchronizer(transport, config, { retryPolicy: { maxAttempts: 1 } });
  const desired = { status: "In Progress", priority: "P1", queueOrder: 60 };
  const first = await synchronizer.synchronize(issue, desired, { correlationId: "sync-1" });
  assert.equal(first.outcome, "synchronized");
  assert.deepEqual(first.changedFields, ["Status", "Queue Order"]);
  assert.equal(transport.writes.length, 2);
  const replay = await synchronizer.synchronize(issue, desired, { correlationId: "sync-2" });
  assert.equal(replay.outcome, "no_op");
  assert.equal(transport.writes.length, 2);
});

test("adds a missing Issue item and updates every requested supported mapping", async () => {
  const transport = new FakeProjectTransport();
  transport.item = undefined;
  const synchronizer = new GitHubProjectSynchronizer(transport, config, { retryPolicy: { maxAttempts: 1 } });
  const result = await synchronizer.synchronize(issue, { status: "Open", priority: "P2", worker: "Pirx", area: "Orchestrator", risk: "Low", workType: "Task", queueOrder: 60 }, { correlationId: "add-1" });
  assert.equal(result.outcome, "synchronized");
  assert.equal(transport.writes.length, 8);
  assert.equal((transport.item as { readonly values: Readonly<Record<string, string | number>> } | undefined)?.values["Work Type"], "Task");
});

test("reports schema drift, mapping errors, partial writes, rate limits, and unknown results", async () => {
  const driftTransport = new FakeProjectTransport();
  driftTransport.schema = schemaPayload({ missingOption: "Status:Done" });
  const drift = await new GitHubProjectSynchronizer(driftTransport, config, { retryPolicy: { maxAttempts: 1 } }).synchronize(issue, { status: "Open" });
  assert.equal(drift.outcome, "schema_drift");

  const mapping = await new GitHubProjectSynchronizer(new FakeProjectTransport(), config, { retryPolicy: { maxAttempts: 1 } }).synchronize(issue, { status: "Unsupported" });
  assert.equal(mapping.outcome, "mapping_error");

  const partialTransport = new FakeProjectTransport();
  partialTransport.failUpdateField = "Priority";
  const partial = await new GitHubProjectSynchronizer(partialTransport, config, { retryPolicy: { maxAttempts: 1 } }).synchronize(issue, { status: "In Progress", priority: "P2" });
  assert.equal(partial.outcome, "partial");
  assert.deepEqual(partial.changedFields, ["Status"]);
  assert.deepEqual(partial.pendingFields, ["Priority"]);

  const rateTransport = new FakeProjectTransport();
  rateTransport.failureMode = "rate_limited";
  const rate = await new GitHubProjectSynchronizer(rateTransport, config, { retryPolicy: { maxAttempts: 1 } }).synchronize(issue, { status: "In Progress" });
  assert.equal(rate.outcome, "rate_limited");

  const unknownTransport = new FakeProjectTransport();
  unknownTransport.failureMode = "unknown";
  const unknown = await new GitHubProjectSynchronizer(unknownTransport, config, { retryPolicy: { maxAttempts: 1 } }).synchronize(issue, { status: "In Progress" });
  assert.equal(unknown.outcome, "unknown");
});

test("detects missing, duplicate, and wrongly typed Project fields", async () => {
  const validSchema = schemaPayload();
  const wrongType = { ...validSchema, fields: { ...validSchema.fields, nodes: (validSchema.fields.nodes as Array<Record<string, unknown>>).map((field) => field.name === "Queue Order" ? { ...field, dataType: "TEXT" } : field) } };
  for (const schema of [schemaPayload({ missingField: "Risk" }), schemaPayload({ duplicateField: "Risk" }), wrongType]) {
    const transport = new FakeProjectTransport();
    transport.schema = schema;
    const result = await new GitHubProjectSchemaResolver(transport, config, { retryPolicy: { maxAttempts: 1 } }).resolve();
    assert.equal(result.outcome, "schema_drift");
  }
});
