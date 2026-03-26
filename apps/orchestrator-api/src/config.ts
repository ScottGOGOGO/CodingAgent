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
