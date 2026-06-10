import test from "node:test";
import assert from "node:assert/strict";

import { loadRuntimeConfig } from "./config.js";

test("loadRuntimeConfig accepts provider env vars case-insensitively", () => {
  const config = loadRuntimeConfig({
    MODEL_PROVIDER: "deepseek",
    Deepseek_API_KEY: "key",
    Deepseek_BASE_URL: "https://api.deepseek.example",
    Deepseek_MODEL: "deepseek-chat",
  });

  assert.equal(config.provider, "deepseek");
  assert.equal(config.apiKey, "key");
  assert.equal(config.baseUrl, "https://api.deepseek.example");
  assert.equal(config.modelName, "deepseek-chat");
  assert.equal(config.roleModels.clarifier, "deepseek-chat");
  assert.equal(config.roleModels.design_director, "deepseek-chat");
});

test("loadRuntimeConfig keeps a hard coder turn timeout even when global model timeout is disabled", () => {
  const config = loadRuntimeConfig({
    MODEL_PROVIDER: "deepseek",
    Deepseek_API_KEY: "key",
    Deepseek_BASE_URL: "https://api.deepseek.example",
    Deepseek_MODEL: "deepseek-chat",
    MODEL_TIMEOUT_SECONDS: "0",
    AGENT_MODEL_TURN_TIMEOUT_SECONDS: "0",
  });

  assert.equal(config.timeoutMs, 0);
  assert.equal(config.agentModelTurnTimeoutMs, 90_000);
});

test("loadRuntimeConfig can skip acceptance for local preview-first runs", () => {
  const config = loadRuntimeConfig({
    AGENT_SKIP_ACCEPTANCE: "true",
  });

  assert.equal(config.skipAcceptance, true);
});

test("loadRuntimeConfig strict generation disables acceptance skip", () => {
  const config = loadRuntimeConfig({
    AGENT_STRICT_GENERATION: "true",
    AGENT_SKIP_ACCEPTANCE: "true",
  });

  assert.equal(config.strictGeneration, true);
  assert.equal(config.skipAcceptance, false);
});
