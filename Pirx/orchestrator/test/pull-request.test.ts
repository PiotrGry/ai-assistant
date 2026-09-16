import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubPullRequestGateway,
  success,
  type GitHubOperationResult,
  type GitHubRequestContext,
  type GitHubRestReadRequest,
  type GitHubRestWriteRequest,
} from "../src/index.js";

const body = "<!-- pirx-feature-pr-provenance:v1 marker -->\n\nPirx Task task-197 / Attempt attempt-1.\nLinked GitHub Issue: https://github.com/PiotrGry/repo/issues/197.";
const payload = { number: 431, html_url: "https://github.com/PiotrGry/repo/pull/431", state: "open", title: "Pirx feature work", body, head: { ref: "pirx/poc-failure-197", sha: "a".repeat(40) }, base: { ref: "develop" }, merged: false };

test("preserves multiline PR provenance bodies returned by GitHub", async () => {
  const transport = {
    restRead: async <T>(_request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> => success([payload] as T, context.correlationId),
    restWrite: async <T>(_request: GitHubRestWriteRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> => success(payload as T, context.correlationId),
  };
  const gateway = new GitHubPullRequestGateway(transport, { token: "token", owner: "PiotrGry", repository: "repo", apiUrl: "https://api.github.com", timeoutMs: 1000 });
  try {
    const result = await gateway.listPullRequests("pirx/poc-failure-197", "develop", { correlationId: "read-pr" });
    assert.equal(result.outcome, "success");
    if (result.outcome === "success") assert.equal(result.value[0]?.body, body);
  } finally { await gateway.close(); }
});
