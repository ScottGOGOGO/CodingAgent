import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AppConfig {
  agentServiceUrl: string;
  agentServiceTimeoutMs: number;
  databaseUrl?: string;
  port: number;
  projectsRoot: string;
  repoRoot: string;
  runnerStrategy: "auto" | "docker" | "local";
}

export function loadConfig(): AppConfig {
  const repoRoot = resolve(process.cwd(), "../..");
  loadEnvFiles(repoRoot);

  return {
    agentServiceUrl: process.env.AGENT_SERVICE_URL ?? "http://127.0.0.1:8001",
    agentServiceTimeoutMs: Number(process.env.AGENT_SERVICE_TIMEOUT_MS ?? "420000"),
    databaseUrl: process.env.DATABASE_URL,
    port: Number(process.env.ORCHESTRATOR_PORT ?? "4000"),
    projectsRoot: resolve(repoRoot, process.env.PROJECTS_ROOT ?? "data/projects"),
    repoRoot,
    runnerStrategy: (process.env.RUNNER_STRATEGY as AppConfig["runnerStrategy"]) ?? "auto",
  };
}

function loadEnvFiles(repoRoot: string) {
  const envFromFiles = {
    ...parseEnvFile(resolve(repoRoot, ".env")),
    ...parseEnvFile(resolve(repoRoot, ".env.local")),
  };

  for (const [key, value] of Object.entries(envFromFiles)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const result: Record<string, string> = {};
  const content = readFileSync(filePath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
