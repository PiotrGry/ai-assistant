import assert from "node:assert/strict";
import test from "node:test";

import { GpuSampler, type GpuReadingSink } from "../src/gpu/gpu-sampler.js";
import type { NvidiaSmiReading } from "../src/gpu/nvidia-smi.js";

const READING: NvidiaSmiReading = {
  gpus: [
    {
      index: 0,
      utilizationPercent: 5,
      memoryUtilizationPercent: 1,
      vramUsedMb: 300,
      vramTotalMb: 16376,
      temperatureC: 50,
      powerW: 30,
      powerLimitW: 320,
      fanPercent: 0,
      pstate: "P8",
    },
  ],
  processes: [{ pid: 4242, name: "ollama", vramMb: 7890 }],
};

class FakeSink implements GpuReadingSink {
  readonly inserts: Array<readonly [number, NvidiaSmiReading]> = [];
  readonly prunes: number[] = [];
  insertError: Error | undefined;

  insertReading(sampledAtMs: number, reading: NvidiaSmiReading): void {
    if (this.insertError !== undefined) throw this.insertError;
    this.inserts.push([sampledAtMs, reading]);
  }

  pruneBefore(cutoffMs: number): number {
    this.prunes.push(cutoffMs);
    return 0;
  }
}

test("writes each reading with its sampling time", async () => {
  const sink = new FakeSink();
  const sampler = new GpuSampler(sink, { read: async () => READING, now: () => 5_000 });

  await sampler.sampleNow();

  assert.deepEqual(sink.inserts, [[5_000, READING]]);
});

test("skips a sample while the previous one is still running", async () => {
  const sink = new FakeSink();
  let reads = 0;
  let release: (reading: NvidiaSmiReading) => void = () => undefined;
  const sampler = new GpuSampler(sink, {
    now: () => 5_000,
    read: () => {
      reads += 1;
      return new Promise<NvidiaSmiReading>((resolve) => {
        release = resolve;
      });
    },
  });

  const first = sampler.sampleNow();
  const second = sampler.sampleNow();
  assert.equal(first, second);
  release(READING);
  await first;

  assert.equal(reads, 1);
  assert.equal(sink.inserts.length, 1);
});

test("reports read and write errors without stopping later samples", async () => {
  const sink = new FakeSink();
  const errors: string[] = [];
  const samples: number[] = [];
  let failRead = true;
  const sampler = new GpuSampler(sink, {
    now: () => 5_000,
    read: async () => {
      if (failRead) throw new Error("nvidia-smi: command not found");
      return READING;
    },
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    onSample: () => samples.push(1),
  });

  await sampler.sampleNow();
  failRead = false;
  sink.insertError = new Error("database is locked");
  await sampler.sampleNow();
  sink.insertError = undefined;
  await sampler.sampleNow();

  assert.deepEqual(errors, ["nvidia-smi: command not found", "database is locked"]);
  assert.equal(sink.inserts.length, 1);
  assert.deepEqual(samples, [1]);
});

test("prunes old samples on start and then at most once per prune interval", async () => {
  const sink = new FakeSink();
  let now = 10_000;
  const sampler = new GpuSampler(sink, {
    intervalMs: 60_000,
    retentionMs: 1_000,
    pruneEveryMs: 3_600,
    now: () => now,
    read: async () => READING,
  });

  sampler.start();
  await sampler.sampleNow();
  assert.deepEqual(sink.prunes, [9_000]);

  now = 11_000;
  await sampler.sampleNow();
  assert.deepEqual(sink.prunes, [9_000]);

  now = 13_600;
  await sampler.sampleNow();
  assert.deepEqual(sink.prunes, [9_000, 12_600]);

  await sampler.stop();
});

test("rejects an unsafe sampling interval", () => {
  assert.throws(() => new GpuSampler(new FakeSink(), { intervalMs: 0 }), /GPU sampling interval must be a positive safe integer/u);
});
