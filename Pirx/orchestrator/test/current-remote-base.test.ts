import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { currentRemoteBase } from "../src/runtime/production-runtime.js";

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } }).trim();

test("the current base is the remote branch head, not the stale local checkout or a pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-current-base-"));
  try {
    const remote = join(root, "remote.git"); const checkout = join(root, "checkout"); const other = join(root, "other");
    git(root, "init", "-q", "--bare", "-b", "develop", remote); git(root, "init", "-q", "-b", "develop", checkout); git(checkout, "remote", "add", "origin", remote);
    await writeFile(join(checkout, "a.txt"), "a\n"); git(checkout, "add", "."); git(checkout, "commit", "-q", "-m", "a"); git(checkout, "push", "-q", "origin", "develop");
    git(root, "clone", "-q", "-b", "develop", remote, other);
    await writeFile(join(other, "b.txt"), "b\n"); git(other, "add", "."); git(other, "commit", "-q", "-m", "b"); git(other, "push", "-q", "origin", "develop");
    const head = git(other, "rev-parse", "HEAD");
    const signal = new AbortController().signal;
    assert.deepEqual(await currentRemoteBase({ repository: "o/r", repositoryRoot: checkout, baseBranch: "develop", remoteName: "origin" }, signal), { revision: head, message: `origin/develop at ${head}` });
    assert.equal((await currentRemoteBase({ repository: "o/r", repositoryRoot: checkout, baseBranch: "develop", baseRevision: "a".repeat(40) }, signal)).revision, "a".repeat(40));
    assert.equal((await currentRemoteBase({ repository: "o/r", repositoryRoot: checkout, baseBranch: "missing" }, signal)).revision, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
