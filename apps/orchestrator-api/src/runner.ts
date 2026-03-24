import { execFile as execFileCb, spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExecutionStep, ProjectRecord } from "@vide/contracts";

const execFile = promisify(execFileCb);

export class CommandExecutionError extends Error {
  constructor(
    public readonly command: string[],
    public readonly output: string,
  ) {
    super(`Command failed: ${command.join(" ")}`);
    this.name = "CommandExecutionError";
  }
}

export function commandForStep(step: ExecutionStep, portOverride?: number): string[] | null {
  switch (step.type) {
    case "install_dependencies":
      return ["npm", "install"];
    case "build_web_app":
      return ["npm", "run", "build"];
    case "start_vite_preview":
      return ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", String(portOverride ?? step.port ?? 4173)];
    case "stop_preview":
    case "git_snapshot":
    case "health_check":
      return null;
    default:
      return null;
  }
}

async function writeLog(project: ProjectRecord, message: string): Promise<void> {
  await mkdir(project.workspaceRoot, { recursive: true });
  await appendFile(join(project.workspaceRoot, ".preview.log"), message, "utf-8");
}

async function waitForHealthy(url: string, timeoutMs = 60_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return url;
      }
    } catch {
      // keep polling until the timeout elapses
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Preview server did not become healthy at ${url}.`);
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFile("docker", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

interface RunnerContext {
  emitLog: (message: string) => Promise<void>;
  project: ProjectRecord;
}

class LocalProcessRunner {
  private readonly processes = new Map<string, ChildProcess>();

  async stop(project: ProjectRecord): Promise<void> {
    const child = this.processes.get(project.id);
    if (!child) {
      return;
    }

    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    this.processes.delete(project.id);
  }

  async stopAll(): Promise<void> {
    for (const [id, child] of this.processes) {
      child.kill("SIGTERM");
      this.processes.delete(id);
    }
  }

  async runForeground(step: ExecutionStep, context: RunnerContext): Promise<void> {
    const command = commandForStep(step);
    if (!command) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let output = "";
      const child = spawn(command[0], command.slice(1), {
        cwd: context.project.workspaceRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", async (chunk) => {
        const text = String(chunk);
        output += text;
        await context.emitLog(text);
      });
      child.stderr?.on("data", async (chunk) => {
        const text = String(chunk);
        output += text;
        await context.emitLog(text);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new CommandExecutionError(command, output));
      });
    });
  }

  async startPreview(step: ExecutionStep, context: RunnerContext): Promise<string> {
    await this.stop(context.project);

    const port = step.port ?? 4173;
    const command = commandForStep(step, port);
    if (!command) {
      throw new Error("No command available for preview start.");
    }

    const child = spawn(command[0], command.slice(1), {
      cwd: context.project.workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", async (chunk) => {
      await context.emitLog(String(chunk));
    });
    child.stderr?.on("data", async (chunk) => {
      await context.emitLog(String(chunk));
    });
    child.once("error", async (error) => {
      await context.emitLog(`Preview error: ${error.message}\n`);
    });

    this.processes.set(context.project.id, child);
    return waitForHealthy(`http://127.0.0.1:${port}`);
  }
}

class DockerRunner {
  private readonly containers = new Map<string, string>();

  private containerName(project: ProjectRecord): string {
    return `vide-preview-${project.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  async stop(project: ProjectRecord): Promise<void> {
    const name = this.containerName(project);
    try {
      await execFile("docker", ["rm", "-f", name]);
    } catch {
      // no-op
    }
    this.containers.delete(project.id);
  }

  async stopAll(): Promise<void> {
    for (const [id, name] of this.containers) {
      try {
        await execFile("docker", ["rm", "-f", name]);
      } catch {
        // no-op
      }
      this.containers.delete(id);
    }
  }

  async runForeground(step: ExecutionStep, context: RunnerContext): Promise<void> {
    const command = commandForStep(step);
    if (!command) {
      return;
    }

    const shellCommand = command.join(" ");
    try {
      const result = await execFile(
        "docker",
        [
          "run",
          "--rm",
          "-w",
          "/app",
          "-v",
          `${context.project.workspaceRoot}:/app`,
          "node:22-alpine",
          "sh",
          "-lc",
          shellCommand,
        ],
        { env: process.env },
      );
      if (result.stdout) {
        await context.emitLog(result.stdout);
      }
      if (result.stderr) {
        await context.emitLog(result.stderr);
      }
    } catch (error) {
      const output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
      if (output) {
        await context.emitLog(output);
      }
      throw new CommandExecutionError(command, output);
    }
  }

  async startPreview(step: ExecutionStep, context: RunnerContext): Promise<string> {
    await this.stop(context.project);

    const port = step.port ?? 4173;
    const name = this.containerName(context.project);
    await execFile(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name,
        "-w",
        "/app",
        "-v",
        `${context.project.workspaceRoot}:/app`,
        "-p",
        `${port}:4173`,
        "node:22-alpine",
        "sh",
        "-lc",
        "npm run dev -- --host 0.0.0.0 --port 4173",
      ],
      { env: process.env },
    );

    this.containers.set(context.project.id, name);
    return waitForHealthy(`http://127.0.0.1:${port}`);
  }
}

export class RunnerService {
  private readonly local = new LocalProcessRunner();
  private readonly docker = new DockerRunner();

  constructor(private readonly strategy: "auto" | "docker" | "local") {}

  private async selectRuntime() {
    if (this.strategy === "local") {
      return this.local;
    }

    if (this.strategy === "docker") {
      return this.docker;
    }

    return (await isDockerAvailable()) ? this.docker : this.local;
  }

  async stopAll(): Promise<void> {
    await this.local.stopAll();
    await this.docker.stopAll();
  }

  async stop(project: ProjectRecord, emitLog: (message: string) => Promise<void>): Promise<void> {
    const runner = await this.selectRuntime();
    await emitLog("Stopping previous preview if it exists.\n");
    await runner.stop(project);
  }

  async execute(step: ExecutionStep, project: ProjectRecord, emitLog: (message: string) => Promise<void>): Promise<string | undefined> {
    const runner = await this.selectRuntime();
    const context: RunnerContext = {
      project,
      emitLog: async (message) => {
        await writeLog(project, message);
        await emitLog(message);
      },
    };

    switch (step.type) {
      case "install_dependencies":
      case "build_web_app":
        await runner.runForeground(step, context);
        return undefined;
      case "start_vite_preview":
        return runner.startPreview(step, context);
      case "health_check":
        return waitForHealthy(step.url ?? `http://127.0.0.1:${step.port ?? 4173}`);
      case "stop_preview":
        await runner.stop(project);
        return undefined;
      default:
        return undefined;
    }
  }
}
