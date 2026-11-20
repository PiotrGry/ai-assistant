import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CoordinationStore } from "../src/coordination/store.js";

/**
 * Edge cases of scripts/go-live.sh, the gate between a runtime and live coordination: live needs,
 * for that exact commit, a passed full eval run, passed tests and SHADOW_TICKS successful shadow ticks.
 * systemctl is a stub; the real unit file is never touched.
 */

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "go-live.sh");

interface Env { readonly root: string; readonly data: string; readonly unit: string; readonly sha: string; run(...args: string[]): { code: number; out: string } }

function environment(): Env {
  const root = mkdtempSync(join(tmpdir(), "pirx-golive-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q"); writeFileSync(join(repo, "f"), "x"); git("add", "f");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c");
  const sha = git("rev-parse", "--short=7", "HEAD").stdout.trim();
  const data = join(root, "share", "pirx");
  const unit = join(root, "config", "systemd", "user", "pirx-watch.service");
  mkdirSync(dirname(unit), { recursive: true });
  mkdirSync(join(data, "evals"), { recursive: true });
  writeFileSync(unit, `[Service]\nWorkingDirectory=${data}/runtime-0000000/Pirx\nExecStart=/usr/bin/node ${data}/runtime-0000000/Pirx/mcp-server/dist/coordination/watch-cli.js\n`);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> ${root}/systemctl.log\necho inactive\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  return {
    root, data, unit, sha,
    run: (...args) => {
      const result = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PIRX_REPO: repo, XDG_DATA_HOME: join(root, "share"), XDG_CONFIG_HOME: join(root, "config") } });
      return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
    },
  };
}

const runtime = (env: Env, sha = env.sha) => join(env.data, `runtime-${sha}`, "Pirx");
function testsPassed(env: Env, sha = env.sha): void { mkdirSync(runtime(env, sha), { recursive: true }); writeFileSync(join(runtime(env, sha), ".tests-passed"), ""); }
function evalRun(env: Env, name: string, fields: Record<string, unknown>): void {
  writeFileSync(join(env.data, "evals", `${name}.json`), JSON.stringify({ commit: env.sha, only: null, gate: true, ...fields }));
  // ls -t orders by mtime; the name is the order of writing here.
  const when = new Date(Date.parse("2026-11-20T10:00:00Z") + Number(name.replace(/\D/gu, "")) * 60_000);
  spawnSync("touch", ["-d", when.toISOString(), join(env.data, "evals", `${name}.json`)]);
}
function shadowTicks(env: Env, outcomes: readonly boolean[], sha = env.sha): void {
  const store = new CoordinationStore(join(env.data, "pirx-shadow.sqlite"));
  for (const ok of outcomes) store.append({ kind: "tick", name: "tick", ok, input: { runtime: runtime(env, sha) } });
  store.close();
}
const ready = (env: Env) => { testsPassed(env); evalRun(env, "e1", {}); shadowTicks(env, [true, true, true, true, true]); };

test("go-live: live is refused with nothing recorded, and the unit stays as it was", () => {
  const env = environment();
  try {
    const before = readFileSync(env.unit, "utf8");
    const result = env.run("live", env.sha);
    assert.equal(result.code, 1);
    assert.match(result.out, /tests: +MISSING/u);
    assert.match(result.out, /Not switching to live/u);
    assert.equal(readFileSync(env.unit, "utf8"), before);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test("go-live: all three conditions switch to live and remove the shadow settings", () => {
  const env = environment();
  try {
    testsPassed(env);
    assert.equal(env.run("shadow", env.sha).code, 0);
    assert.match(readFileSync(env.unit, "utf8"), /PIRX_COORDINATION_DRY_RUN=1/u);
    evalRun(env, "e1", {}); shadowTicks(env, [true, true, true, true, true]);
    const result = env.run("live", env.sha);
    assert.equal(result.code, 0, result.out);
    const unit = readFileSync(env.unit, "utf8");
    assert.doesNotMatch(unit, /DRY_RUN|pirx-shadow/u);
    assert.match(unit, new RegExp(`runtime-${env.sha}/Pirx`, "u"));
    assert.doesNotMatch(unit, /runtime-0000000/u);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test("go-live: the newest full eval run of the commit decides; an older pass does not outvote a newer fail", () => {
  const env = environment();
  try {
    ready(env);
    evalRun(env, "e2", { gate: false });
    assert.equal(env.run("live", env.sha).code, 1);
    evalRun(env, "e3", { gate: true });
    assert.equal(env.run("live", env.sha).code, 0);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test("go-live: a partial eval run (--only) or a run of another commit is not the gate", () => {
  const env = environment();
  try {
    testsPassed(env); shadowTicks(env, [true, true, true, true, true]);
    evalRun(env, "e1", { only: "pr-behind-base" });
    evalRun(env, "e2", { commit: "fffffff" });
    assert.equal(env.run("live", env.sha).code, 1);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test("go-live: shadow needs five successful ticks of this runtime, the newest five", () => {
  const env = environment();
  try {
    testsPassed(env); evalRun(env, "e1", {});
    shadowTicks(env, [true, true, true, true]);
    assert.equal(env.run("live", env.sha).code, 1, "four are not five");
    shadowTicks(env, [true, true, true, true, true], "1111111");
    assert.equal(env.run("live", env.sha).code, 1, "ticks of another runtime do not count");
    shadowTicks(env, [false]);
    shadowTicks(env, [true, true, true, true]);
    assert.equal(env.run("live", env.sha).code, 1, "a failure among the newest five blocks");
    shadowTicks(env, [true]);
    assert.equal(env.run("live", env.sha).code, 0, "the failure is now older than the newest five");
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test("go-live: shadow without tests is refused; an unknown commit is an error, not a switch", () => {
  const env = environment();
  try {
    assert.equal(env.run("shadow", env.sha).code, 1);
    assert.notEqual(env.run("live", "deadbee").code, 0);
    assert.notEqual(env.run("live").code, 0);
    assert.doesNotMatch(readFileSync(env.unit, "utf8"), /DRY_RUN/u);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test("go-live: every switch keeps a copy of the unit, so a bad switch can be undone by hand", () => {
  const env = environment();
  try {
    testsPassed(env);
    env.run("shadow", env.sha);
    const copies = spawnSync("sh", ["-c", `ls ${dirname(env.unit)} | grep -c before-`], { encoding: "utf8" }).stdout.trim();
    assert.equal(copies, "1");
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test("go-live: status reports the STOP switch and the mode", () => {
  const env = environment();
  try {
    mkdirSync(join(env.root, "config", "pirx"), { recursive: true });
    writeFileSync(join(env.root, "config", "pirx", "STOP"), "");
    const result = env.run("status");
    assert.match(result.out, /STOP switch is ON/u);
    assert.match(result.out, /live, runtime 0000000/u);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});
