import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  backupDatabase,
  exportDatabaseJsonl,
  pruneResourceSamples,
  restoreDatabase,
  retentionDryRun,
} from "../src/storage/maintenance.js";
import { SqliteStore } from "../src/storage/sqlite.js";

test("SQLite maintenance exports, backs up, restores and prunes only samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-maintenance-test-"));
  const source = join(directory, "data", "pirx.sqlite");
  const backup = join(directory, "backup", "pirx.sqlite");
  const restored = join(directory, "restored", "pirx.sqlite");
  const exported = join(directory, "export", "records.jsonl");
  await mkdir(join(directory, "data"), { recursive: true });
  const store = SqliteStore.open({ filename: source });
  store.insertResourceSample({
    id: "sample-old",
    sampledAt: "2026-09-01T00:00:00.000Z",
    source: "test",
    payload: { vram_used_mb: 1 },
  });
  store.insertResourceSample({
    id: "sample-new",
    sampledAt: "2026-09-09T00:00:00.000Z",
    source: "test",
    payload: { vram_used_mb: 2 },
  });
  store.close();

  try {
    assert.deepEqual(
      retentionDryRun(source, "2026-09-05T00:00:00.000Z"),
      { cutoff: "2026-09-05T00:00:00.000Z", resourceSamples: 1 },
    );
    assert.ok((await backupDatabase(source, backup)) > 0);
    assert.equal(await exportDatabaseJsonl(source, exported), 2);
    assert.match(await readFile(exported, "utf8"), /resource_samples/u);

    assert.equal(pruneResourceSamples(source, "2026-09-05T00:00:00.000Z"), 1);
    assert.equal(retentionDryRun(source, "2026-09-05T00:00:00.000Z").resourceSamples, 0);

    await restoreDatabase(backup, restored);
    assert.equal(
      retentionDryRun(restored, "2026-09-05T00:00:00.000Z").resourceSamples,
      1,
    );
    await assert.rejects(
      restoreDatabase(backup, restored),
      /EEXIST|already exists/u,
    );
    await restoreDatabase(backup, restored, { overwrite: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
