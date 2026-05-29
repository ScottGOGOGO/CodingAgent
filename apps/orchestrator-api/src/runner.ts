import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type PreviewTarget = {
  id: string;
  workspaceRoot: string;
  logRoot: string;
};

export class CommandExecutionError extends Error {
  constructor(
    public readonly command: string[],
    public readonly output: string,
  ) {
    super(`Command failed: ${command.join(" ")}`);
    this.name = "CommandExecutionError";
  }
}

export function commandForStep(type: "install" | "build" | "preview", port?: number): string[] {
  if (type === "install") {
    return ["npm", "install"];
  }
  if (type === "build") {
    return ["npm", "run", "build"];
  }
  return ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", String(port ?? 4173)];
}

async function writeLog(target: PreviewTarget, message: string): Promise<void> {
  await mkdir(target.logRoot, { recursive: true });
  await appendFile(join(target.logRoot, ".preview.log"), message, "utf-8");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
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
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Preview server did not become healthy at ${url}.`);
}

export class RunnerService {
  private readonly processes = new Map<string, ChildProcess>();

  constructor(private readonly _strategy: "auto" | "docker" | "local") {}

  async stopAll(): Promise<void> {
    for (const [id, child] of this.processes) {
      child.kill("SIGTERM");
      this.processes.delete(id);
    }
  }

  async stop(id: string): Promise<void> {
    const child = this.processes.get(id);
    if (!child) {
      return;
    }
    child.kill("SIGTERM");
    this.processes.delete(id);
  }

  async startPreview(target: PreviewTarget, port: number, emitLog: (message: string) => void): Promise<string> {
    await this.stop(target.id);
    const command = commandForStep("preview", port);
    const child = spawn(command[0], command.slice(1), {
      cwd: target.workspaceRoot,
      env: { ...process.env, DATABASE_URL: "file:./dev.db" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", async (chunk) => {
      const text = stripAnsi(String(chunk));
      emitLog(text);
      await writeLog(target, text);
    });
    child.stderr?.on("data", async (chunk) => {
      const text = stripAnsi(String(chunk));
      emitLog(text);
      await writeLog(target, text);
    });
    child.once("error", async (error) => {
      const text = stripAnsi(`Preview error: ${error.message}\n`);
      emitLog(text);
      await writeLog(target, text);
    });

    this.processes.set(target.id, child);
    return waitForHealthy(`http://127.0.0.1:${port}`);
  }

  async runCommand(target: PreviewTarget, command: string[], emitLog: (message: string) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const child = spawn(command[0], command.slice(1), {
        cwd: target.workspaceRoot,
        env: { ...process.env, DATABASE_URL: "file:./dev.db" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", async (chunk) => {
        const text = stripAnsi(String(chunk));
        output += text;
        emitLog(text);
        await writeLog(target, text);
      });
      child.stderr?.on("data", async (chunk) => {
        const text = stripAnsi(String(chunk));
        output += text;
        emitLog(text);
        await writeLog(target, text);
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
}
