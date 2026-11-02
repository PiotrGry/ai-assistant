import assert from "node:assert/strict";
import test from "node:test";

import { CpuReader, calculateCpuUtilization, type CpuCounterSnapshot } from "../src/gpu/cpu.js";

function snapshot(overrides: Partial<CpuCounterSnapshot> = {}): CpuCounterSnapshot {
  return { logicalCores: 8, idleMilliseconds: 400, totalMilliseconds: 1_000, loadAverage: [1, 0.8, 0.5], totalMemoryBytes: 16_000, freeMemoryBytes: 4_000, ...overrides };
}

test("CPU reader reports the first sample as unavailable and then calculates bounded utilization", () => {
  const values = [snapshot(), snapshot({ idleMilliseconds: 500, totalMilliseconds: 1_200, freeMemoryBytes: 3_000 })];
  const reader = new CpuReader(() => values.shift()!);
  assert.deepEqual(reader.read(), { utilizationPercent: null, logicalCores: 8, load1m: 1, load5m: 0.8, load15m: 0.5, totalMemoryBytes: 16_000, freeMemoryBytes: 4_000 });
  assert.deepEqual(reader.read(), { utilizationPercent: 50, logicalCores: 8, load1m: 1, load5m: 0.8, load15m: 0.5, totalMemoryBytes: 16_000, freeMemoryBytes: 3_000 });
});

test("CPU utilization stays unavailable for changed cores or invalid counter deltas", () => {
  const previous = snapshot();
  assert.equal(calculateCpuUtilization(previous, snapshot({ logicalCores: 4, totalMilliseconds: 1_200 })), null);
  assert.equal(calculateCpuUtilization(previous, snapshot({ idleMilliseconds: 300, totalMilliseconds: 1_200 })), null);
  assert.equal(calculateCpuUtilization(previous, snapshot({ idleMilliseconds: 700, totalMilliseconds: 1_200 })), null);
  assert.equal(calculateCpuUtilization(previous, snapshot({ idleMilliseconds: 450, totalMilliseconds: 1_200 })), 75);
});

test("CPU reader rejects malformed operating-system snapshots", () => {
  const reader = new CpuReader(() => snapshot({ freeMemoryBytes: 17_000 }));
  assert.throws(() => reader.read(), /CPU counter snapshot is invalid/u);
});
