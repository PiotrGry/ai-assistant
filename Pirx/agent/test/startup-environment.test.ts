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
    await writeFile(join(root, "pirx", "chat.json"), JSON.stringify({ PIRX_TOOL_PROFILE: "operations", PIRX_OBSIDIAN_VAULT: "/data/explicit-vault", OLLAMA_NUM_CTX: "32768", PIRX_ORCHESTRATOR_DATABASE: "/data/runtime.sqlite", PIRX_ORCHESTRATOR_SERVICE_ENABLED: "true", PIRX_GITHUB_OWNER: "PiotrGry", PIRX_GITHUB_REPOSITORY: "zdrovena-reconciliation" }));
    const environment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root, PIRX_GITHUB_REPOSITORY: "explicit-repository" };
    initializeHostEnvironment(environment);
    assert.equal(loadConfig(environment).numCtx, 32768);
    assert.equal(environment.PIRX_OBSIDIAN_VAULT, "/data/explicit-vault");
    assert.equal(loadConfig(environment).toolProfile, "operations");
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


test("shared profile respects HOME and model configuration is consistent with explicit overrides", async () => {
  const { MCP_CHILD_ENVIRONMENT_KEYS, PROFILE_SETTING_DEFINITIONS, resolveProfileEnvironment, resolveModelSettings } = await import("@pirx/config");
  const root = await mkdtemp(join(tmpdir(), "pirx-shared-home-"));
  try {
    await mkdir(join(root, ".config", "pirx"), { recursive: true });
    await writeFile(join(root, ".config", "pirx", "chat.json"), JSON.stringify({ OLLAMA_MODEL: "profile-model", OLLAMA_BASE_URL: "http://127.0.0.1:12345", OLLAMA_NUM_CTX: "32768", PIRX_STORAGE_FILE: "/data/chat.sqlite" }));
    const input = { HOME: root, OLLAMA_MODEL: "explicit-model" };
    const resolved = resolveProfileEnvironment(input);
    const model = resolveModelSettings(resolved);
    assert.equal(model.model, "explicit-model");
    assert.equal(model.numCtx, 32768);
    assert.equal(model.baseUrl, "http://127.0.0.1:12345");
    assert.equal(resolved.PIRX_STORAGE_FILE, "/data/chat.sqlite");
    assert.deepEqual(input, { HOME: root, OLLAMA_MODEL: "explicit-model" });
    assert.throws(() => resolveModelSettings({ ...resolved, OLLAMA_MODEL: "" }), /OLLAMA_MODEL/);
    assert.throws(() => resolveModelSettings({ ...resolved, OLLAMA_BASE_URL: "file:///tmp/model" }), /OLLAMA_BASE_URL/);
    assert.throws(() => resolveModelSettings({ ...resolved, OLLAMA_NUM_CTX: "0" }), /OLLAMA_NUM_CTX/);
    assert.equal(PROFILE_SETTING_DEFINITIONS.PIRX_OBSIDIAN_VAULT.sensitive, true);
    assert.equal(PROFILE_SETTING_DEFINITIONS.PIRX_STORAGE_FILE.forwardToMcp, true);
    assert.ok(MCP_CHILD_ENVIRONMENT_KEYS.includes("PIRX_OBSIDIAN_VAULT"));
    assert.ok(!MCP_CHILD_ENVIRONMENT_KEYS.includes("OLLAMA_MODEL"));
    assert.ok(MCP_CHILD_ENVIRONMENT_KEYS.includes("PIRX_STORAGE_FILE"));
    assert.ok(MCP_CHILD_ENVIRONMENT_KEYS.includes("PIRX_TOOL_PROFILE"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
