import { execFile as execFileCb } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { SandboxWorkspace } from "@vide/agent-runtime";
import type { ProjectRecord } from "@vide/contracts";

const execFile = promisify(execFileCb);
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", ".agent"]);
const IGNORED_FILES = new Set([".preview.log"]);

export class WorkspaceService {
  async ensureProjectWorkspace(project: ProjectRecord): Promise<void> {
    await mkdir(project.workspaceRoot, { recursive: true });
    await writeFile(join(project.workspaceRoot, ".gitignore"), "node_modules\ndist\n.agent\n.preview.log\n", "utf-8");

    try {
      await execFile("git", ["init"], { cwd: project.workspaceRoot });
      await execFile("git", ["config", "user.name", "vide-agent"], { cwd: project.workspaceRoot });
      await execFile("git", ["config", "user.email", "vide-agent@example.local"], { cwd: project.workspaceRoot });
    } catch (error) {
      console.warn(`Failed to initialize git for ${project.id}.`, error);
    }
  }

  async createSandbox(project: ProjectRecord, runId: string): Promise<SandboxWorkspace> {
    return SandboxWorkspace.create(project.workspaceRoot, runId);
  }

  async promoteSandbox(project: ProjectRecord, sandboxPath: string): Promise<void> {
    const sandbox = new SandboxWorkspace(project.workspaceRoot, sandboxPath);
    await sandbox.promoteToProject();
  }

  async listFiles(project: ProjectRecord): Promise<string[]> {
    const files: string[] = [];
    const walk = async (currentDir: string, prefix = "") => {
      let entries;
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name) || IGNORED_FILES.has(entry.name)) {
          continue;
        }
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolutePath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath, relativePath);
        } else {
          files.push(relativePath);
        }
      }
    };
    await walk(project.workspaceRoot);
    return files.sort();
  }

  async readPreviewLog(project: ProjectRecord): Promise<string | undefined> {
    try {
      const logPath = join(project.workspaceRoot, ".preview.log");
      const info = await stat(logPath);
      if (!info.isFile()) {
        return undefined;
      }
      return readFile(logPath, "utf-8");
    } catch {
      return undefined;
    }
  }

  async readPreviewLogTail(project: ProjectRecord, maxChars = 12_000): Promise<string | undefined> {
    const log = await this.readPreviewLog(project);
    if (!log) {
      return undefined;
    }
    return log.length > maxChars ? log.slice(-maxChars) : log;
  }

  async resetPreviewLog(project: ProjectRecord): Promise<void> {
    await mkdir(project.workspaceRoot, { recursive: true });
    await writeFile(join(project.workspaceRoot, ".preview.log"), "", "utf-8");
  }

  async appendPreviewLog(project: ProjectRecord, message: string): Promise<void> {
    await mkdir(project.workspaceRoot, { recursive: true });
    await appendFile(join(project.workspaceRoot, ".preview.log"), message, "utf-8");
  }

  async snapshot(project: ProjectRecord, message: string): Promise<string | undefined> {
    try {
      const status = await execFile("git", ["status", "--porcelain"], { cwd: project.workspaceRoot });
      if (!status.stdout.trim()) {
        return undefined;
      }
      await execFile("git", ["add", "-A"], { cwd: project.workspaceRoot });
      await execFile("git", ["commit", "-m", message], { cwd: project.workspaceRoot });
      const commit = await execFile("git", ["rev-parse", "HEAD"], { cwd: project.workspaceRoot });
      return commit.stdout.trim();
    } catch (error) {
      console.warn(`Git snapshot failed for ${project.id}.`, error);
      return undefined;
    }
  }

  async removeProjectWorkspace(project: ProjectRecord): Promise<void> {
    await rm(project.workspaceRoot, { recursive: true, force: true });
  }
}
