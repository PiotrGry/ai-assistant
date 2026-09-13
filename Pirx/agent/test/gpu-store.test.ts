import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { GpuStore } from "../src/gpu/gpu-store.js";
import type { GpuSample, NvidiaSmiReading } from "../src/gpu/nvidia-smi.js";

function sample(overrides: Partial<GpuSample> = {}): GpuSample {
  return {
    index: 0,
    utilizationPercent: 37,
    memoryUtilizationPercent: 12,
    vramUsedMb: 9125,
    vramTotalMb: 16376,
    temperatureC: 61,
    powerW: 212.4,
    powerLimitW: 320,
    fanPercent: 45,
    pstate: "P2",
    ...overrides,
  };
}

function reading(processes: NvidiaSmiReading["processes"] = []): NvidiaSmiReading {
  return { gpus: [sample()], processes };
}

async function withStore(run: (store: GpuStore, filename: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-gpu-store-test-"));
  const filename = join(directory, "gpu.sqlite");
  const store = GpuStore.open(filename);
  try {
    await run(store, filename);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("GPU store writes one reading with its processes", async () => {
  await withStore((store, filename) => {
    store.insertReading(1_000, reading([
      { pid: 4242, name: "ollama", vramMb: 7890 },
      { pid: 77, name: "python3", vramMb: null },
    ]));

    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual({ ...database.prepare("SELECT * FROM gpu_samples").get() }, {
        sampled_at: 1_000,
        gpu_index: 0,
        utilization_percent: 37,
        memory_utilization_percent: 12,
        vram_used_mb: 9125,
        vram_total_mb: 16376,
        temperature_c: 61,
        power_w: 212.4,
        power_limit_w: 320,
        fan_percent: 45,
        pstate: "P2",
      });
      assert.deepEqual(
        database.prepare("SELECT sampled_at, pid, name, vram_used_mb FROM gpu_processes ORDER BY pid").all().map((row) => ({ ...row })),
        [
          { sampled_at: 1_000, pid: 77, name: "python3", vram_used_mb: null },
          { sampled_at: 1_000, pid: 4242, name: "ollama", vram_used_mb: 7890 },
        ],
      );
      assert.deepEqual({ ...database.prepare("PRAGMA user_version").get() }, { user_version: 1 });
      assert.deepEqual({ ...database.prepare("PRAGMA journal_mode").get() }, { journal_mode: "wal" });
    } finally {
      database.close();
    }
  });
});

test("GPU store writes nothing from a reading that fails part way", async () => {
  await withStore((store, filename) => {
    assert.throws(() =>
      store.insertReading(1_000, reading([
        { pid: 4242, name: "ollama", vramMb: 7890 },
        { pid: 4242, name: "ollama", vramMb: 7890 },
      ])),
    );

    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual({ ...database.prepare("SELECT COUNT(*) AS n FROM gpu_samples").get() }, { n: 0 });
      assert.deepEqual({ ...database.prepare("SELECT COUNT(*) AS n FROM gpu_processes").get() }, { n: 0 });
    } finally {
      database.close();
    }
  });
});

test("GPU store prunes old samples together with their processes", async () => {
  await withStore((store, filename) => {
    for (const sampledAt of [1_000, 2_000, 3_000]) {
      store.insertReading(sampledAt, reading([{ pid: 4242, name: "ollama", vramMb: sampledAt }]));
    }

    assert.equal(store.pruneBefore(2_500), 2);

    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(database.prepare("SELECT sampled_at FROM gpu_samples").all().map((row) => ({ ...row })), [{ sampled_at: 3_000 }]);
      assert.deepEqual(database.prepare("SELECT sampled_at FROM gpu_processes").all().map((row) => ({ ...row })), [{ sampled_at: 3_000 }]);
    } finally {
      database.close();
    }
  });
});

test("GPU store reopens existing data and rejects an unknown version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-gpu-store-test-"));
  const filename = join(directory, "gpu.sqlite");
  try {
    const first = GpuStore.open(filename);
    first.insertReading(1_000, reading());
    first.close();

    const second = GpuStore.open(filename);
    assert.equal(second.pruneBefore(0), 0);
    second.close();

    const database = new DatabaseSync(filename);
    assert.deepEqual({ ...database.prepare("SELECT COUNT(*) AS n FROM gpu_samples").get() }, { n: 1 });
    database.exec("PRAGMA user_version = 99");
    database.close();

    assert.throws(() => GpuStore.open(filename), /Unsupported GPU store version: 99 \(expected 1\)/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
