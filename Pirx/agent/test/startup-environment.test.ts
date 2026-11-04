import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { initializeHostEnvironment } from "../src/startup-environment.js";
import { loadConfig } from "../src/config.js";

test("shared host defaults configure a direct chat launch while explicit environment wins", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-startup-"));
  try {
    await mkdir(join(root, "pirx"));
    await writeFile(join(root, "pirx", "chat.json"), JSON.stringify({ PIRX_OBSIDIAN_VAULT: "/data/explicit-vault", OLLAMA_NUM_CTX: "32768", PIRX_ORCHESTRATOR_DATABASE: "/data/runtime.sqlite", PIRX_ORCHESTRATOR_SERVICE_ENABLED: "true", PIRX_GITHUB_OWNER: "PiotrGry", PIRX_GITHUB_REPOSITORY: "zdrovena-reconciliation" }));
    const environment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root, PIRX_GITHUB_REPOSITORY: "explicit-repository" };
    initializeHostEnvironment(environment);
    assert.equal(loadConfig(environment).numCtx, 32768);
    assert.equal(environment.PIRX_OBSIDIAN_VAULT, "/data/explicit-vault");
    assert.equal(environment.PIRX_ORCHESTRATOR_DATABASE, "/data/runtime.sqlite");
    assert.equal(environment.PIRX_ORCHESTRATOR_SERVICE_ENABLED, "true");
    assert.equal(environment.PIRX_GITHUB_REPOSITORY, "explicit-repository");
    initializeHostEnvironment(environment);
    assert.equal(environment.PIRX_GITHUB_REPOSITORY, "explicit-repository");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing optional config is harmless but invalid or missing explicit config fails without partial application", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-startup-invalid-"));
  try {
    const environment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root };
    initializeHostEnvironment(environment);
    const filename = join(root, "custom.json");
    environment.PIRX_CHAT_CONFIG = filename;
    assert.throws(() => initializeHostEnvironment(environment), /Nie można odczytać/u);
    await writeFile(filename, "{");
    assert.throws(() => initializeHostEnvironment(environment), /Niepoprawny JSON/u);
    await writeFile(filename, JSON.stringify({ OLLAMA_NUM_CTX: "32768", PATH: "/untrusted/bin" }));
    assert.throws(() => initializeHostEnvironment(environment), /PATH/u);
    assert.equal(environment.OLLAMA_NUM_CTX, undefined);
    await writeFile(filename, JSON.stringify({ PIRX_ORCHESTRATOR_SERVICE_ENABLED: true }));
    assert.throws(() => initializeHostEnvironment(environment), /PIRX_ORCHESTRATOR_SERVICE_ENABLED/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
