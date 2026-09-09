import assert from "node:assert/strict";
import test from "node:test";

import {
  ResourceSampler,
  type ResourceSampleRecord,
  type ResourceSnapshot,
} from "../src/resource-sampler.js";

class MemorySink {
  readonly records: ResourceSampleRecord[] = [];

  insertResourceSample(record: ResourceSampleRecord): void {
    this.records.push(record);
  }
}

function snapshot(): ResourceSnapshot {
  return {
    source: "test",
    host: "test-host",
    payload: {
      gpu: null,
      host: { free_memory_bytes: 123 },
    },
  };
}

test("resource sampler serializes reads and stores samples with turn context", async () => {
  const sink = new MemorySink();
  let active = 0;
  let maximumActive = 0;
  const sampler = new ResourceSampler(sink, {
    intervalMs: 1,
    sessionId: "session-1",
    read: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return snapshot();
    },
    now: () => new Date("2026-09-09T10:00:00.000Z"),
  });
  sampler.setTurnId("turn-1");
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await sampler.stop();

  assert.equal(maximumActive, 1);
  assert.ok(sink.records.length >= 2);
  assert.equal(sink.records[0]?.sessionId, "session-1");
  assert.equal(sink.records[0]?.turnId, "turn-1");
  assert.equal(sink.records[0]?.payload["gpu"], null);
});

test("resource sampler reports reader failures and remains stoppable", async () => {
  const sink = new MemorySink();
  const errors: unknown[] = [];
  const sampler = new ResourceSampler(sink, {
    read: async () => {
      throw new Error("telemetry unavailable");
    },
    onError: (error) => errors.push(error),
  });

  await sampler.sampleNow();
  await sampler.stop();
  assert.equal(sink.records.length, 0);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /telemetry unavailable/u);
});

test("resource sampler validates interval", () => {
  assert.throws(
    () => new ResourceSampler(new MemorySink(), { intervalMs: 0 }),
    /positive safe integer/u,
  );
});
