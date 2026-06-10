export type ModelRole =
  | "clarifier"
  | "planner"
  | "design_director"
  | "design_seed_smith"
  | "architect"
  | "coder"
  | "critic"
  | "visual_critic"
  | "repairer";

export interface RuntimeConfig {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  roleModels: Partial<Record<ModelRole, string>>;
  wireApi?: "chat_completions" | "responses";
  timeoutMs: number;
  /** Maximum assistant turns inside the agent coder loop. */
  maxTurns: number;
  /** Maximum tool calls the agent may emit in a single turn. */
  agentMaxToolCallsPerTurn: number;
  /** Maximum tool calls across the entire agent coder loop. */
  agentMaxToolCallsTotal: number;
  /** Hard timeout for each tool-use model turn. */
  agentModelTurnTimeoutMs: number;
  /** Skip final candidate validation so local runs can surface a candidate quickly. */
  skipAcceptance: boolean;
  /** Fail instead of swapping in generic/deterministic fallback candidates. */
  strictGeneration: boolean;
  buildAttempts: number;
  previewPortBase: number;
}

function firstPresent(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim();
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = env[key];
  if (exact !== undefined) {
    return exact;
  }
  const normalizedKey = key.toLowerCase();
  const foundKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === normalizedKey);
  return foundKey ? env[foundKey] : undefined;
}

function normalizeProvider(value?: string): string {
  return (value ?? "openai_compatible").trim().toLowerCase().replace(/-/g, "_");
}

function booleanEnvValue(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const value = envValue(env, key);
  if (value === undefined) {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const provider = normalizeProvider(envValue(env, "MODEL_PROVIDER"));
  const providerKey = provider.toUpperCase();
  const apiKey = firstPresent(
    envValue(env, "MODEL_API_KEY"),
    envValue(env, `${providerKey}_API_KEY`),
    envValue(env, "OPENAI_API_KEY"),
    envValue(env, "QWEN_API_KEY"),
    envValue(env, "DEEPSEEK_API_KEY"),
  );
  const baseUrl = firstPresent(
    envValue(env, "MODEL_BASE_URL"),
    envValue(env, `${providerKey}_BASE_URL`),
    envValue(env, "OPENAI_BASE_URL"),
    envValue(env, "QWEN_BASE_URL"),
    envValue(env, "DEEPSEEK_BASE_URL"),
  );
  const modelName = firstPresent(
    envValue(env, "MODEL_NAME"),
    envValue(env, `${providerKey}_MODEL`),
    envValue(env, "OPENAI_MODEL"),
    envValue(env, "QWEN_MODEL"),
    envValue(env, "DEEPSEEK_MODEL"),
  );

  const modelTimeoutSeconds = Number(envValue(env, "MODEL_TIMEOUT_SECONDS") ?? "90");
  const modelTimeoutMs = modelTimeoutSeconds > 0 ? modelTimeoutSeconds * 1000 : 0;
  const rawTurnTimeoutSeconds = Number(envValue(env, "AGENT_MODEL_TURN_TIMEOUT_SECONDS") ?? "90");
  const agentModelTurnTimeoutMs = rawTurnTimeoutSeconds > 0 ? rawTurnTimeoutSeconds * 1000 : 90_000;
  const strictGeneration = booleanEnvValue(env, "AGENT_STRICT_GENERATION");

  return {
    provider,
    apiKey,
    baseUrl,
    modelName,
    roleModels: {
      clarifier: firstPresent(envValue(env, "CLARIFIER_MODEL"), modelName),
      planner: firstPresent(envValue(env, "PLANNER_MODEL"), modelName),
      design_director: firstPresent(envValue(env, "DESIGN_DIRECTOR_MODEL"), envValue(env, "PLANNER_MODEL"), modelName),
      design_seed_smith: firstPresent(envValue(env, "DESIGN_SEED_MODEL"), envValue(env, "DESIGN_DIRECTOR_MODEL"), modelName),
      architect: firstPresent(envValue(env, "ARCHITECT_MODEL"), envValue(env, "PLANNER_MODEL"), modelName),
      coder: firstPresent(envValue(env, "CODER_MODEL"), modelName),
      critic: firstPresent(envValue(env, "CRITIC_MODEL"), modelName),
      repairer: firstPresent(envValue(env, "REPAIRER_MODEL"), envValue(env, "CODER_MODEL"), modelName),
    },
    wireApi: envValue(env, "MODEL_WIRE_API") === "responses" ? "responses" : "chat_completions",
    timeoutMs: modelTimeoutMs,
    maxTurns: Number(envValue(env, "AGENT_MAX_TURNS") ?? "50"),
    agentMaxToolCallsPerTurn: Number(envValue(env, "AGENT_MAX_TOOL_CALLS_PER_TURN") ?? "6"),
    agentMaxToolCallsTotal: Number(envValue(env, "AGENT_MAX_TOOL_CALLS_TOTAL") ?? "300"),
    agentModelTurnTimeoutMs,
    skipAcceptance: strictGeneration ? false : booleanEnvValue(env, "AGENT_SKIP_ACCEPTANCE"),
    strictGeneration,
    buildAttempts: Number(envValue(env, "AGENT_BUILD_ATTEMPTS") ?? "2"),
    previewPortBase: Number(envValue(env, "PREVIEW_PORT_BASE") ?? "4173"),
  };
}
