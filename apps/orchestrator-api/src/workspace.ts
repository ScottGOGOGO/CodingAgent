import { execFile as execFileCb } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { FileChange, ProjectRecord, WorkspaceFile } from "@vide/contracts";

const execFile = promisify(execFileCb);
const MAX_SNAPSHOT_FILES = 40;
const MAX_FILE_CHARS = 20_000;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist"]);
const IGNORED_FILES = new Set([".preview.log"]);

export class WorkspaceService {
  async ensureProjectWorkspace(project: ProjectRecord): Promise<void> {
    await mkdir(project.workspaceRoot, { recursive: true });
    await writeFile(join(project.workspaceRoot, ".gitignore"), "node_modules\ndist\n", "utf-8");

    try {
      await execFile("git", ["init"], { cwd: project.workspaceRoot });
      await execFile("git", ["config", "user.name", "vide-agent"], { cwd: project.workspaceRoot });
      await execFile("git", ["config", "user.email", "vide-agent@example.local"], {
        cwd: project.workspaceRoot,
      });
    } catch (error) {
      console.warn(`Failed to initialize git for ${project.id}.`, error);
    }
  }

  async applyFileChanges(project: ProjectRecord, changes: FileChange[]): Promise<void> {
    for (const change of changes) {
      const targetPath = join(project.workspaceRoot, change.path);
      if (change.action === "delete") {
        await rm(targetPath, { force: true, recursive: true });
        continue;
      }

      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, change.content ?? "", "utf-8");
    }
  }

  async listFiles(project: ProjectRecord): Promise<string[]> {
    const files: string[] = [];

    const walk = async (currentDir: string, prefix = ""): Promise<void> => {
      const entries = await readdir(currentDir, { withFileTypes: true });
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

    try {
      await walk(project.workspaceRoot);
    } catch {
      return [];
    }

    return files.sort();
  }

  async readWorkspaceSnapshot(project: ProjectRecord): Promise<WorkspaceFile[]> {
    const files = await this.listFiles(project);
    const snapshots: WorkspaceFile[] = [];

    for (const path of files.slice(0, MAX_SNAPSHOT_FILES)) {
      try {
        const absolutePath = join(project.workspaceRoot, path);
        const content = await readFile(absolutePath, "utf-8");
        snapshots.push({
          path,
          content: content.length > MAX_FILE_CHARS ? `${content.slice(0, MAX_FILE_CHARS)}\n/* truncated */` : content,
        });
      } catch {
        // Skip files that are not readable as UTF-8 text.
      }
    }

    return snapshots;
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

  async readPreviewLog(project: ProjectRecord): Promise<string | undefined> {
    try {
      const logPath = join(project.workspaceRoot, ".preview.log");
      const info = await stat(logPath);
      if (!info.isFile()) {
        return undefined;
      }
      return await readFile(logPath, "utf-8");
    } catch {
      return undefined;
    }
  }

  async readPreviewLogTail(project: ProjectRecord, maxChars = 12_000): Promise<string | undefined> {
    const content = await this.readPreviewLog(project);
    if (!content) {
      return undefined;
    }
    return content.length > maxChars ? content.slice(-maxChars) : content;
  }

  async resetPreviewLog(project: ProjectRecord): Promise<void> {
    await mkdir(project.workspaceRoot, { recursive: true });
    await writeFile(join(project.workspaceRoot, ".preview.log"), "", "utf-8");
  }
}
