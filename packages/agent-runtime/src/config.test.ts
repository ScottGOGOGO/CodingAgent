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
  assert.equal(config.roleModels.visual_critic, "deepseek-chat");
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
