import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObsidianVault } from "../src/obsidian/vaults.js";

test("obsidian vault create/read/append/search", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-obsidian-"));
  const vault = new ObsidianVault(root);

  await vault.create("Notes/test.md", "# Pirx");

  assert.equal(
    await vault.read("Notes/test.md"),
    "# Pirx",
  );

  await vault.append("Notes/test.md", "\nHello");

  assert.equal(
    await vault.read("Notes/test.md"),
    "# Pirx\nHello",
  );

  assert.deepEqual(
    await vault.search("Pirx"),
    ["Notes/test.md"],
  );
});

test("obsidian vault blocks path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-obsidian-"));
  const vault = new ObsidianVault(root);

  await assert.rejects(
    () => vault.read("../../etc/passwd"),
    /Path outside Obsidian vault/,
  );
});
