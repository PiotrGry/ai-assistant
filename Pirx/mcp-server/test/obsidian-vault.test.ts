import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObsidianError, ObsidianVault } from "../src/obsidian/vaults.js";

async function withVault(
  run: (vault: ObsidianVault, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pirx-obsidian-"));
  try {
    await run(new ObsidianVault(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hasCode(code: ObsidianError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ObsidianError && error.code === code;
}

test("create, read, write, list and search nested Markdown notes", async () => {
  await withVault(async (vault) => {
    await vault.create("Notes/Nested/test.md", "# Pirx\ninitial");
    await vault.create("Other.md", "unrelated");

    assert.equal(await vault.read("Notes/Nested/test.md"), "# Pirx\ninitial");
    await vault.write("Notes/Nested/test.md", "# Replaced\nPirx");
    assert.equal(await vault.read("Notes/Nested/test.md"), "# Replaced\nPirx");
    assert.deepEqual(await vault.list(), ["Notes/Nested/test.md", "Other.md"]);
    assert.deepEqual(await vault.list("Notes"), ["Notes/Nested/test.md"]);
    assert.deepEqual(await vault.search("pirx"), ["Notes/Nested/test.md"]);
    assert.deepEqual(await vault.search("other"), ["Other.md"]);
  });
});

test("create never overwrites and write requires an existing note", async () => {
  await withVault(async (vault) => {
    await vault.create("note.md", "original");

    await assert.rejects(() => vault.create("note.md", "replacement"), hasCode("already_exists"));
    assert.equal(await vault.read("note.md"), "original");
    await assert.rejects(() => vault.write("missing.md", "content"), hasCode("not_found"));
  });
});

test("append inserts a newline when the existing note has no final newline", async () => {
  await withVault(async (vault) => {
    await vault.create("shopping.md", "- pepper");
    await vault.append("shopping.md", "- marjoram");
    assert.equal(await vault.read("shopping.md"), "- pepper\n- marjoram");
  });
});

test("append does not add an extra newline after an existing final newline", async () => {
  await withVault(async (vault) => {
    await vault.create("shopping.md", "- pepper\n");
    await vault.append("shopping.md", "- marjoram");
    assert.equal(await vault.read("shopping.md"), "- pepper\n- marjoram");
  });
});

test("append writes directly to an empty note", async () => {
  await withVault(async (vault) => {
    await vault.create("shopping.md", "");
    await vault.append("shopping.md", "- marjoram");
    assert.equal(await vault.read("shopping.md"), "- marjoram");
  });
});

test("concurrent appends do not lose content or merge line items", async () => {
  await withVault(async (vault) => {
    await vault.create("shopping.md", "");
    await Promise.all([
      vault.append("shopping.md", "- pepper"),
      vault.append("shopping.md", "- marjoram"),
    ]);
    assert.equal(await vault.read("shopping.md"), "- pepper\n- marjoram");
  });
});

test("move is exclusive and delete removes exactly one note", async () => {
  await withVault(async (vault) => {
    await vault.create("source.md", "source");
    await vault.create("occupied.md", "occupied");

    await assert.rejects(
      () => vault.move("source.md", "occupied.md"),
      hasCode("already_exists"),
    );
    assert.equal(await vault.read("source.md"), "source");
    assert.equal(await vault.read("occupied.md"), "occupied");

    await vault.move("source.md", "Archive/moved.md");
    await assert.rejects(() => vault.read("source.md"), hasCode("not_found"));
    assert.equal(await vault.read("Archive/moved.md"), "source");

    await vault.delete("Archive/moved.md");
    await assert.rejects(() => vault.read("Archive/moved.md"), hasCode("not_found"));
    await assert.rejects(() => vault.delete("Archive/moved.md"), hasCode("not_found"));
  });
});

test("vault rejects traversal, absolute, hidden, non-Markdown and symlink paths", async () => {
  const outside = await mkdtemp(join(tmpdir(), "pirx-obsidian-outside-"));
  try {
    await writeFile(join(outside, "secret.md"), "secret", "utf8");
    await withVault(async (vault, root) => {
      await symlink(outside, join(root, "linked"));

      for (const unsafe of [
        "../outside.md",
        "Notes/../../outside.md",
        "/tmp/outside.md",
        "C:\\outside.md",
        ".obsidian/config.md",
        "Notes/.hidden.md",
        "secret.txt",
      ]) {
        await assert.rejects(() => vault.read(unsafe), (error: unknown) => {
          return (
            error instanceof ObsidianError &&
            (error.code === "invalid_path" || error.code === "not_a_note")
          );
        });
      }

      await assert.rejects(() => vault.read("linked/secret.md"), hasCode("invalid_path"));
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("list and search ignore hidden directories and arbitrary files", async () => {
  await withVault(async (vault, root) => {
    await vault.create("Visible.md", "visible");
    await mkdir(join(root, ".obsidian"), { recursive: true });
    await writeFile(join(root, ".obsidian", "private.md"), "private", "utf8");
    await writeFile(join(root, "secret.json"), "secret", "utf8");

    assert.deepEqual(await vault.list(), ["Visible.md"]);
    assert.deepEqual(await vault.search("private"), []);
    assert.deepEqual(await vault.search("secret"), []);
  });
});
