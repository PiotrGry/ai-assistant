import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkerFailureDiagnostic,
  extractProviderRecoveryMetadata,
  quotaCooldownFromDiagnostic,
  resetAtFromLimitText,
  validateWorkerFailureDiagnostic,
  type UtcTimestamp,
} from "../src/index.js";
import { REAL_ALLOWED_RATE_LIMIT_EVENT, REAL_FIVE_HOUR_LIMIT_OBSERVED_AT, REAL_FIVE_HOUR_LIMIT_RECORD } from "./fixtures/claude-usage-limit.js";

const observedAt = "2026-10-30T10:00:00.000Z" as UtcTimestamp;

test("extracts only explicit bounded provider retry and reset metadata", () => {
  assert.deepEqual(extractProviderRecoveryMetadata({ error_code: "quota_exhausted", retry_after_ms: 120_000, quota_bucket: "five-hour", status_code: "429" }), { source: "provider_retry_after", retryAfterMs: 120_000, quotaBucket: "five-hour", providerStatusCode: "429" });
  assert.deepEqual(extractProviderRecoveryMetadata({ reset_at: "2026-10-30T12:00:00.000Z" }), { source: "provider_reset", resetAt: "2026-10-30T12:00:00.000Z" });
  assert.equal(extractProviderRecoveryMetadata({ message: "limit reached, resets at 5pm" }), undefined);
  assert.equal(extractProviderRecoveryMetadata(REAL_ALLOWED_RATE_LIMIT_EVENT), undefined, "an allowed window is not a limit");
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

test("reads the reset time from a real Claude 5-hour limit record", () => {
  assert.deepEqual(extractProviderRecoveryMetadata(REAL_FIVE_HOUR_LIMIT_RECORD), { source: "provider_reset", resetAt: "2026-11-10T15:10:00.000Z", quotaBucket: "five_hour", providerStatusCode: "429" });
  const event = { type: "rate_limit_event", rate_limit_info: REAL_FIVE_HOUR_LIMIT_RECORD.apiErrorParams.rate_limit_info };
  assert.equal(extractProviderRecoveryMetadata(event)?.resetAt, "2026-11-10T15:10:00.000Z");
  const providerRecovery = extractProviderRecoveryMetadata(REAL_FIVE_HOUR_LIMIT_RECORD);
  const cooldown = quotaCooldownFromDiagnostic({ workerId: "pirx", provider: "claude-code", observedAt: REAL_FIVE_HOUR_LIMIT_OBSERVED_AT as UtcTimestamp, diagnostic: createWorkerFailureDiagnostic("quota_exhausted", providerRecovery === undefined ? {} : { providerRecovery }) });
  assert.equal(cooldown?.expiresAt, "2026-11-10T15:10:00.000Z");
  assert.equal(cooldown?.providerMetadata?.source, "provider_reset");
});

test("reads the reset time from the real limit text in the time zone it names", () => {
  const observed = Date.parse(REAL_FIVE_HOUR_LIMIT_OBSERVED_AT);
  const text = REAL_FIVE_HOUR_LIMIT_RECORD.message.content[0].text;
  assert.deepEqual(resetAtFromLimitText(text, observed, "UTC"), { source: "provider_reset", resetAt: "2026-11-10T15:10:00.000Z", quotaBucket: "five_hour" });
  // Real variants: past midnight, the older "session limit" label, and the API error wrapper.
  assert.equal(resetAtFromLimitText("You've hit your 5-hour limit · resets 1:20am (Europe/Warsaw)", Date.parse("2026-11-08T21:36:55.314Z"))?.resetAt, "2026-11-09T00:20:00.000Z");
  assert.equal(resetAtFromLimitText("You've hit your session limit · resets 2:20pm (Europe/Warsaw)", Date.parse("2026-11-03T12:32:38.688Z"))?.resetAt, "2026-11-03T13:20:00.000Z");
  assert.equal(resetAtFromLimitText("Agent terminated early due to an API error: You've hit your 5-hour limit · resets 12:10am (Europe/Warsaw) (error type rate_limit, HTTP 429)", Date.parse("2026-11-12T21:00:00.000Z"))?.resetAt, "2026-11-12T23:10:00.000Z");
  // Summer time: Warsaw is UTC+2 in July.
  assert.equal(resetAtFromLimitText("You've hit your 5-hour limit · resets 2pm (Europe/Warsaw)", Date.parse("2026-07-01T10:00:00.000Z"))?.resetAt, "2026-07-01T12:00:00.000Z");
  // No zone in the text: the operator zone applies.
  assert.equal(resetAtFromLimitText("You've hit your 5-hour limit · resets 4:10pm", observed, "Europe/Warsaw")?.resetAt, "2026-11-10T15:10:00.000Z");
});

test("does not guess a reset from text it cannot place inside the 5-hour window", () => {
  const observed = Date.parse("2026-11-12T14:37:57.824Z");
  assert.equal(resetAtFromLimitText("You've hit your weekly limit · resets 9pm (Europe/Warsaw)", observed), undefined, "a weekly reset may be days away");
  assert.equal(resetAtFromLimitText("You've hit your 5-hour limit · resets 9am (Europe/Warsaw)", observed), undefined, "more than 5 hours ahead");
  assert.equal(resetAtFromLimitText("You've hit your 5-hour limit · resets 4pm (Not/AZone)", observed), undefined);
  assert.equal(resetAtFromLimitText("rate limited, HTTP 429", observed), undefined);
});
