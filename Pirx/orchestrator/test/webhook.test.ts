import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  GitHubWebhookHandler,
  GitHubWebhookReconciliationService,
  RuntimeSqliteStore,
  type GitHubWebhookIssueTarget,
  type GitHubWebhookProjectTarget,
  type GitHubWebhookReconciliationAdapter,
  type GitHubWebhookReconciliationResult,
} from "../src/index.js";

const secret = "test-webhook-secret";
const receivedAt = "2026-09-14T15:00:00.000Z";

async function fixture(): Promise<{ readonly directory: string; readonly filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-webhook-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}
function signed(body: string, deliveryId: string, event = "issues"): Record<string, string> {
  return { "x-github-event": event, "x-github-delivery": deliveryId, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(new TextEncoder().encode(body)).digest("hex")}` };
}
function issueBody(action = "opened", number = 56): string {
  return JSON.stringify({ action, updated_at: receivedAt, issue: { number, node_id: `I_issue-${number}`, updated_at: receivedAt }, repository: { full_name: "PiotrGry/ai-assistant", updated_at: receivedAt } });
}
class FakeReconciler implements GitHubWebhookReconciliationAdapter {
  readonly issues: GitHubWebhookIssueTarget[] = [];
  readonly projects: GitHubWebhookProjectTarget[] = [];
  readonly repositories: Array<{ readonly owner?: string; readonly repository?: string }> = [];
  result: GitHubWebhookReconciliationResult = { outcome: "no_op", message: "Current state already matches." };
  async reconcileIssue(target: GitHubWebhookIssueTarget): Promise<GitHubWebhookReconciliationResult> { this.issues.push(target); return this.result; }
  async reconcileProject(target: GitHubWebhookProjectTarget): Promise<GitHubWebhookReconciliationResult> { this.projects.push(target); return this.result; }
  async reconcileRepository(target: { readonly owner?: string; readonly repository?: string }): Promise<GitHubWebhookReconciliationResult> { this.repositories.push(target); return this.result; }
}

test("authenticates raw bytes before parsing, bounds the body, and normalizes a durable Issue intent", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    const handler = new GitHubWebhookHandler(store, { secret, maxBodyBytes: 2_048, now: () => receivedAt });
    assert.equal(handler.handle("not json", signed("different", "bad")).outcome, "invalid_signature");
    assert.equal(handler.handle("x".repeat(2_049), signed("x".repeat(2_049), "large")).outcome, "body_too_large");
    const body = issueBody();
    const accepted = handler.handle(body, signed(body, "delivery-1"));
    assert.equal(accepted.outcome, "accepted");
    assert.equal(accepted.intents?.[0]?.kind, "issue");
    assert.equal(accepted.intents?.[0]?.issueNumber, 56);
    const duplicate = handler.handle(body, signed(body, "delivery-1"));
    assert.equal(duplicate.outcome, "duplicate");
    assert.equal(store.webhooks.listPendingIntents().outcome, "success");
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("acknowledges ignored events and distinguishes malformed supported payloads", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    const handler = new GitHubWebhookHandler(store, { secret, now: () => receivedAt });
    const ignoredBody = JSON.stringify({ action: "created" });
    assert.equal(handler.handle(ignoredBody, signed(ignoredBody, "ignored-1", "workflow_run")).outcome, "ignored");
    const invalidBody = JSON.stringify({ action: "opened", repository: { full_name: "PiotrGry/ai-assistant" } });
    assert.equal(handler.handle(invalidBody, signed(invalidBody, "invalid-1")).outcome, "invalid_payload");
    const malformed = "{";
    assert.equal(handler.handle(malformed, signed(malformed, "malformed-1")).outcome, "malformed_json");
    assert.equal(handler.handle(issueBody(), { "x-github-event": "issues", "x-github-delivery": "missing-signature" }).outcome, "missing_headers");
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("normalizes Project and installation events without retaining the raw payload", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    const handler = new GitHubWebhookHandler(store, { secret, now: () => receivedAt });
    const project = JSON.stringify({ action: "edited", updated_at: receivedAt, projects_v2_item: { node_id: "PVTI_item-1", project_node_id: "PVT_project-1", content_node_id: "I_issue-1" }, repository: { full_name: "PiotrGry/ai-assistant" } });
    const accepted = handler.handle(project, signed(project, "project-1", "projects_v2_item"));
    assert.equal(accepted.outcome, "accepted");
    assert.equal(accepted.intents?.[0]?.kind, "project");
    assert.equal(accepted.intents?.[0]?.projectItemId, "PVTI_item-1");
    const installation = JSON.stringify({ action: "created", updated_at: receivedAt });
    assert.equal(handler.handle(installation, signed(installation, "installation-1", "installation")).outcome, "accepted");
    const raw = store.database.prepare("SELECT COUNT(*) AS count FROM runtime_webhook_deliveries WHERE payload_digest LIKE ?").get(`%${project}%`) as { count: number };
    assert.equal(raw.count, 0);
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("reconciles pending intents after restart and supports targeted and unknown-write reconciliation", async () => {
  const value = await fixture();
  let store = RuntimeSqliteStore.open({ filename: value.filename });
  const adapter = new FakeReconciler();
  try {
    const handler = new GitHubWebhookHandler(store, { secret, now: () => receivedAt });
    const body = issueBody("edited");
    assert.equal(handler.handle(body, signed(body, "restart-1")).outcome, "accepted");
    store.close();
    store = RuntimeSqliteStore.open({ filename: value.filename });
    const service = new GitHubWebhookReconciliationService(store, adapter, { now: () => receivedAt });
    const startup = await service.startup();
    assert.equal(startup[0]?.outcome, "no_op");
    assert.equal(adapter.issues.length, 1);
    assert.equal(store.webhooks.listPendingIntents().outcome, "success");
    assert.equal((await service.reconcileIssue({ owner: "PiotrGry", repository: "ai-assistant", issueNumber: 56 })).outcome, "no_op");
    assert.equal((await service.reconcileProject({ projectId: "PVT_project-1", projectItemId: "PVTI_item-1" })).outcome, "no_op");
    assert.equal((await service.afterUnknownWrite({ projectId: "PVT_project-1", projectItemId: "PVTI_item-1" })).outcome, "no_op");
    assert.equal(adapter.projects.length, 2);
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("keeps unknown reconciliation outcomes pending for a later retry", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  const adapter = new FakeReconciler();
  adapter.result = { outcome: "unknown", message: "write outcome requires reconciliation", providerOutcome: "unknown" };
  try {
    const handler = new GitHubWebhookHandler(store, { secret, now: () => receivedAt });
    const body = issueBody("edited");
    const accepted = handler.handle(body, signed(body, "unknown-1"));
    const intentId = accepted.intents?.[0]?.intentId;
    assert.notEqual(intentId, undefined);
    const service = new GitHubWebhookReconciliationService(store, adapter, { now: () => receivedAt });
    const result = await service.reconcileIntent(intentId as string);
    assert.equal(result.outcome, "unknown");
    const pending = store.webhooks.listPendingIntents();
    assert.equal(pending.outcome, "success");
    if (pending.outcome === "success") assert.equal(pending.value.length, 1);
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
