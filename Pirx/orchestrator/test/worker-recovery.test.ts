import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkerFailureDiagnostic,
  extractProviderRecoveryMetadata,
  quotaCooldownFromDiagnostic,
  validateWorkerFailureDiagnostic,
  type UtcTimestamp,
} from "../src/index.js";

const observedAt = "2026-10-30T10:00:00.000Z" as UtcTimestamp;

test("extracts only explicit bounded provider retry and reset metadata", () => {
  assert.deepEqual(extractProviderRecoveryMetadata({ error_code: "quota_exhausted", retry_after_ms: 120_000, quota_bucket: "five-hour", status_code: "429" }), { source: "provider_retry_after", retryAfterMs: 120_000, quotaBucket: "five-hour", providerStatusCode: "429" });
  assert.deepEqual(extractProviderRecoveryMetadata({ reset_at: "2026-10-30T12:00:00.000Z" }), { source: "provider_reset", resetAt: "2026-10-30T12:00:00.000Z" });
  assert.equal(extractProviderRecoveryMetadata({ message: "limit reached, resets at 5pm" }), undefined);
  assert.equal(extractProviderRecoveryMetadata({ retry_after_ms: -1 }), undefined);
  assert.equal(extractProviderRecoveryMetadata({ reset_at: "today at 5pm" }), undefined);
});

test("uses trustworthy reset metadata and carries it through the safe diagnostic contract", () => {
  const providerRecovery = extractProviderRecoveryMetadata({ reset_at: "2026-10-30T12:00:00.000Z", quota_bucket: "five-hour" });
  assert.notEqual(providerRecovery, undefined);
  if (providerRecovery === undefined) return;
  const diagnostic = createWorkerFailureDiagnostic("quota_exhausted", { providerRecovery });
  assert.deepEqual(validateWorkerFailureDiagnostic(diagnostic), diagnostic);
  const cooldown = quotaCooldownFromDiagnostic({ workerId: "pirx", provider: "claude-code", observedAt, diagnostic });
  assert.equal(cooldown?.state, "cooldown");
  assert.equal(cooldown?.expiresAt, "2026-10-30T12:00:00.000Z");
  assert.equal(cooldown?.providerMetadata?.source, "provider_reset");
  assert.equal(cooldown?.providerMetadata?.quotaBucket, "five-hour");
});

test("uses retry-after and bounded defaults without trusting stale or excessive provider times", () => {
  const retry = createWorkerFailureDiagnostic("quota_exhausted", { providerRecovery: { source: "provider_retry_after", retryAfterMs: 90_000, providerStatusCode: "quota_exhausted" } });
  const exact = quotaCooldownFromDiagnostic({ workerId: "pirx", provider: "claude-code", observedAt, diagnostic: retry });
  assert.equal(exact?.expiresAt, "2026-10-30T10:01:30.000Z");
  assert.equal(exact?.providerMetadata?.source, "provider_retry_after");

  const excessive = createWorkerFailureDiagnostic("quota_exhausted", { providerRecovery: { source: "provider_reset", resetAt: "2026-11-02T10:00:00.000Z" as UtcTimestamp } });
  const fallback = quotaCooldownFromDiagnostic({ workerId: "pirx", provider: "claude-code", observedAt, diagnostic: excessive });
  assert.equal(fallback?.expiresAt, "2026-10-30T11:00:00.000Z");
  assert.equal(fallback?.providerMetadata?.source, "bounded_default");

  const absent = quotaCooldownFromDiagnostic({ workerId: "pirx", provider: "claude-code", observedAt, diagnostic: createWorkerFailureDiagnostic("quota_exhausted") });
  assert.equal(absent?.expiresAt, "2026-10-30T11:00:00.000Z");
  assert.equal(absent?.providerMetadata?.source, "bounded_default");
  assert.equal(quotaCooldownFromDiagnostic({ workerId: "pirx", provider: "claude-code", observedAt, diagnostic: createWorkerFailureDiagnostic("timeout") }), undefined);
});

test("rejects unsafe recovery contracts and invalid cooldown policy", () => {
  const quota = createWorkerFailureDiagnostic("quota_exhausted");
  assert.equal(validateWorkerFailureDiagnostic({ ...quota, providerRecovery: { source: "provider_retry_after", retryAfterMs: -1 } }), undefined);
  const timeout = createWorkerFailureDiagnostic("timeout");
  assert.equal(validateWorkerFailureDiagnostic({ ...timeout, providerRecovery: { source: "bounded_default" } }), undefined);
  assert.throws(() => quotaCooldownFromDiagnostic({ workerId: "pirx", provider: "claude-code", observedAt, diagnostic: quota, policy: { defaultCooldownMs: 0, maximumCooldownMs: 1 } }), /policy/u);
});
