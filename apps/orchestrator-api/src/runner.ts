import { spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
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

const STATIC_EXPORT_PREVIEW_SERVER = String.raw`
const { createReadStream, promises: fs } = require("node:fs");
const { createServer } = require("node:http");
const path = require("node:path");

const port = Number(process.argv[1] || 4173);
const root = path.resolve(process.cwd(), "out");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

async function findFile(relativePath) {
  const resolved = path.resolve(root, relativePath.replace(/^\/+/, ""));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  try {
    const stat = await fs.stat(resolved);
    return stat.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

async function resolveRequestPath(pathname) {
  const relative = pathname.replace(/^\/+/, "");
  const candidates = relative
    ? pathname.endsWith("/")
      ? [path.join(relative, "index.html")]
      : [relative, relative + ".html", path.join(relative, "index.html")]
    : ["index.html"];
  for (const candidate of candidates) {
    const file = await findFile(candidate);
    if (file) return file;
  }
  return null;
}

async function sendFile(response, filePath, statusCode) {
  const ext = path.extname(filePath).toLowerCase();
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": mimeTypes[ext] || "application/octet-stream"
  });
  createReadStream(filePath).pipe(response);
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const file = await resolveRequestPath(decodeURIComponent(url.pathname));
    if (file) {
      if (request.method === "HEAD") {
        response.writeHead(200, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      await sendFile(response, file, 200);
      return;
    }
    const notFound = (await findFile("404.html")) || (await findFile("404/index.html"));
    if (notFound) {
      await sendFile(response, notFound, 404);
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
}).listen(port, "0.0.0.0", () => {
  console.log("Static export preview ready at http://127.0.0.1:" + port);
});
`;

export function commandForStep(type: "install" | "build" | "preview" | "devPreview" | "staticPreview", port?: number): string[] {
  if (type === "install") {
    return ["npm", "install"];
  }
  if (type === "build") {
    return ["npm", "run", "build"];
  }
  if (type === "devPreview") {
    return ["npm", "run", "dev", "--", "--hostname", "0.0.0.0", "--port", String(port ?? 4173)];
  }
  if (type === "staticPreview") {
    return ["node", "-e", STATIC_EXPORT_PREVIEW_SERVER, String(port ?? 4173)];
  }
  return ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", String(port ?? 4173)];
}

export async function previewBuildCommandForWorkspace(workspaceRoot: string): Promise<string[] | null> {
  let packageJson: { scripts?: Record<string, string> };
  try {
    packageJson = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
  } catch {
    return null;
  }

  if (!/\bnext\s+start\b/.test(packageJson.scripts?.start ?? "")) {
    return null;
  }

  if (await isNextStaticExportWorkspace(workspaceRoot)) {
    return (await hasStaticExportBundle(workspaceRoot)) ? null : commandForStep("build");
  }

  try {
    await access(join(workspaceRoot, ".next", "BUILD_ID"));
    return null;
  } catch {
    return commandForStep("build");
  }
}

export async function previewStartCommandForWorkspace(workspaceRoot: string, port: number): Promise<string[]> {
  if (await isNextStaticExportWorkspace(workspaceRoot)) {
    return commandForStep("staticPreview", port);
  }
  return commandForStep("preview", port);
}

async function isNextStaticExportWorkspace(workspaceRoot: string): Promise<boolean> {
  for (const configName of ["next.config.mjs", "next.config.js", "next.config.ts"]) {
    try {
      const content = await readFile(join(workspaceRoot, configName), "utf-8");
      if (/\boutput\s*:\s*["']export["']/.test(content)) {
        return true;
      }
    } catch {
      // Keep looking for a supported Next config file.
    }
  }
  return false;
}

async function hasStaticExportBundle(workspaceRoot: string): Promise<boolean> {
  try {
    await access(join(workspaceRoot, "out", "index.html"));
    return true;
  } catch {
    return false;
  }
}

async function writeLog(target: PreviewTarget, message: string): Promise<void> {
  await mkdir(target.logRoot, { recursive: true });
  await appendFile(join(target.logRoot, ".preview.log"), message, "utf-8");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function cleanChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  if (next.FORCE_COLOR !== undefined) {
    delete next.NO_COLOR;
  }
  return next;
}

async function readPreviewLogTail(target: PreviewTarget, maxChars = 4000): Promise<string> {
  try {
    const content = await readFile(join(target.logRoot, ".preview.log"), "utf-8");
    return content.slice(-maxChars).trim();
  } catch {
    return "";
  }
}

export async function waitForHealthy(target: PreviewTarget, url: string, timeoutMs = 60_000): Promise<string> {
  const started = Date.now();
  let lastFailure = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return url;
      }
      const body = await response.text().catch(() => "");
      lastFailure = `HTTP ${response.status} at ${url}${body ? `\n${stripAnsi(body).slice(-1200)}` : ""}`;
      if (response.status >= 500) {
        const logTail = await readPreviewLogTail(target);
        throw new Error(`Preview server returned ${response.status}.\n${logTail || lastFailure}`);
      }
    } catch (error) {
      if (error instanceof Error && /Preview server returned/.test(error.message)) {
        throw error;
      }
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const logTail = await readPreviewLogTail(target);
  throw new Error(`Preview server did not become healthy at ${url}.${logTail ? `\n${logTail}` : lastFailure ? `\n${lastFailure}` : ""}`);
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
    const buildCommand = await previewBuildCommandForWorkspace(target.workspaceRoot);
    if (buildCommand) {
      const message = "Production preview bundle missing; rebuilding before starting preview.\n";
      emitLog(message);
      await writeLog(target, message);
      await this.runCommand(target, buildCommand, emitLog);
    }
    const command = await previewStartCommandForWorkspace(target.workspaceRoot, port);
    const child = this.spawnPreviewProcess(target, command, emitLog);
    return waitForHealthy(target, `http://127.0.0.1:${port}`);
  }

  async startDevPreview(target: PreviewTarget, port: number, emitLog: (message: string) => void): Promise<string> {
    await this.stop(target.id);
    const message = "Acceptance is paused; starting candidate with the dev server.\n";
    emitLog(message);
    await writeLog(target, message);
    await this.runCommand(target, commandForStep("install"), emitLog);
    const child = this.spawnPreviewProcess(target, commandForStep("devPreview", port), emitLog);
    return waitForHealthy(target, `http://127.0.0.1:${port}`);
  }

  private spawnPreviewProcess(target: PreviewTarget, command: string[], emitLog: (message: string) => void): ChildProcess {
    const child = spawn(command[0], command.slice(1), {
      cwd: target.workspaceRoot,
      env: cleanChildEnv({ ...process.env, DATABASE_URL: "file:./dev.db" }),
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
    return child;
  }

  async runCommand(target: PreviewTarget, command: string[], emitLog: (message: string) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const child = spawn(command[0], command.slice(1), {
        cwd: target.workspaceRoot,
        env: cleanChildEnv({ ...process.env, DATABASE_URL: "file:./dev.db" }),
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
