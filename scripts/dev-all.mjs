import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const result = {};
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

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function loadEnv() {
  const envFromFile = {
    ...parseEnvFile(resolve(repoRoot, ".env")),
    ...parseEnvFile(resolve(repoRoot, ".env.local")),
  };

  return {
    ...envFromFile,
    ...process.env,
  };
}

function resolvePythonExecutable() {
  const candidates = [
    resolve(repoRoot, ".venv", "bin", "python"),
    resolve(repoRoot, ".venv", "Scripts", "python.exe"),
    "python3",
    "python",
  ];

  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }

    return candidate;
  }

  return "python3";
}

function resolveNpmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function prefixStream(stream, prefix, target) {
  if (!stream) {
    return;
  }

  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      target.write(`[${prefix}] ${line}\n`);
    }
  });

  stream.on("end", () => {
    if (buffer) {
      target.write(`[${prefix}] ${buffer}\n`);
    }
  });
}

const env = loadEnv();
const npmExecutable = resolveNpmExecutable();
const pythonExecutable = resolvePythonExecutable();

let agentUrl;
try {
  agentUrl = new URL(env.AGENT_SERVICE_URL ?? "http://127.0.0.1:8001");
} catch {
  agentUrl = new URL("http://127.0.0.1:8001");
}

const agentHost = agentUrl.hostname || "127.0.0.1";
const agentPort = Number(agentUrl.port || "8001");
const orchestratorPort = Number(env.ORCHESTRATOR_PORT ?? "4000");
const playgroundPort = Number(env.PLAYGROUND_PORT ?? "5173");
const enableReload = env.DEV_ALL_RELOAD === "1";
const apiBase = env.VITE_API_BASE ?? `http://127.0.0.1:${orchestratorPort}`;

const services = [
  {
    name: "agent",
    color: "\x1b[36m",
    cwd: resolve(repoRoot, "services", "agent-service"),
    command: pythonExecutable,
    args: [
      "-m",
      "uvicorn",
      "app.main:app",
      ...(enableReload ? ["--reload"] : []),
      "--host",
      agentHost,
      "--port",
      String(agentPort),
    ],
  },
  {
    name: "api",
    color: "\x1b[33m",
    cwd: repoRoot,
    command: npmExecutable,
    args: ["--workspace", "@vide/orchestrator-api", "run", "dev"],
  },
  {
    name: "playground",
    color: "\x1b[35m",
    cwd: repoRoot,
    command: npmExecutable,
    args: ["--workspace", "@vide/playground", "run", "dev"],
  },
];

const resetColor = "\x1b[0m";
const children = [];
let shuttingDown = false;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function spawnService(service) {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    env: {
      ...env,
      AGENT_SERVICE_URL: env.AGENT_SERVICE_URL ?? `http://${agentHost}:${agentPort}`,
      ORCHESTRATOR_PORT: String(orchestratorPort),
      PLAYGROUND_PORT: String(playgroundPort),
      VITE_API_BASE: apiBase,
      FORCE_COLOR: env.FORCE_COLOR ?? "1",
    },
    stdio: ["inherit", "pipe", "pipe"],
  });

  prefixStream(child.stdout, `${service.color}${service.name}${resetColor}`, process.stdout);
  prefixStream(child.stderr, `${service.color}${service.name}${resetColor}`, process.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    log(`\n${service.name} exited with ${reason}. Stopping the other services...`);
    shutdown(code ?? 0);
  });

  child.on("error", (error) => {
    if (shuttingDown) {
      return;
    }

    log(`\nFailed to start ${service.name}: ${error.message}`);
    shutdown(1);
  });

  children.push(child);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
  }, 3000).unref();

  setTimeout(() => {
    process.exit(exitCode);
  }, 3500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

log("Starting Vibe Coding Agent local stack...");
log(`- agent: http://${agentHost}:${agentPort}`);
log(`- api: http://127.0.0.1:${orchestratorPort}`);
log(`- playground: http://127.0.0.1:${playgroundPort}`);
log(`- playground api base: ${apiBase}`);
log(`- agent reload: ${enableReload ? "on" : "off"}`);
log("Press Ctrl+C to stop all services.\n");

for (const service of services) {
  spawnService(service);
}
