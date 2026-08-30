import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backlinks, outgoingLinks } from "../src/obsidian/graph.js";
import { ObsidianVault } from "../src/obsidian/vaults.js";
import { parseWikilinks } from "../src/obsidian/wikilinks.js";

test("wikilink parser handles notes, folders, aliases and headings", () => {
  assert.deepEqual(parseWikilinks("[[Note]]"), [{ target: "Note" }]);
  assert.deepEqual(parseWikilinks("[[Folder/Note]]"), [{ target: "Folder/Note" }]);
  assert.deepEqual(parseWikilinks("[[Note|Alias]]"), [
    { target: "Note", alias: "Alias" },
  ]);
  assert.deepEqual(parseWikilinks("[[Note#Heading]]"), [
    { target: "Note", heading: "Heading" },
  ]);
});

test("wikilink parser returns multiple unique targets and ignores absent links", () => {
  assert.deepEqual(
    parseWikilinks("[[A]] text [[Folder/B|Bee]] and [[A#Again]]"),
    [{ target: "A" }, { target: "Folder/B", alias: "Bee" }],
  );
  assert.deepEqual(parseWikilinks("plain Markdown"), []);
});

test("addLink avoids duplicates and graph reports outgoing links and backlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-wikilinks-"));
  try {
    const vault = new ObsidianVault(root);
    await vault.create("A.md", "Links to [[B]] and [[Folder/C|C alias]].");
    await vault.create("B.md", "Target");
    await vault.create("Folder/C.md", "Also [[B#Details]]");

    assert.deepEqual(await outgoingLinks(vault, "A.md"), ["B", "Folder/C"]);
    assert.deepEqual(await backlinks(vault, "B.md"), ["A.md", "Folder/C.md"]);

    const duplicate = await vault.addLink("A.md", "B.md");
    assert.deepEqual(duplicate, { added: false, link: "[[B]]" });

    const added = await vault.addLink("A.md", "Folder/New.md", { alias: "New note" });
    assert.deepEqual(added, { added: true, link: "[[Folder/New|New note]]" });
    assert.match(await vault.read("A.md"), /\n\[\[Folder\/New\|New note\]\]$/u);

    const secondAttempt = await vault.addLink("A.md", "Folder/New.md");
    assert.equal(secondAttempt.added, false);
    assert.equal((await vault.read("A.md")).match(/\[\[Folder\/New/u)?.length, 1);

    const concurrent = await Promise.all([
      vault.addLink("A.md", "Concurrent.md"),
      vault.addLink("A.md", "Concurrent.md"),
    ]);
    assert.deepEqual(concurrent.map((result) => result.added), [true, false]);
    assert.equal((await vault.read("A.md")).match(/\[\[Concurrent\]\]/gu)?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
