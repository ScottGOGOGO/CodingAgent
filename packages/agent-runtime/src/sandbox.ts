import { constants } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { ChangedFile } from "@vide/contracts";

const IGNORED_NAMES = new Set(["node_modules", "dist", ".next", "coverage", ".git", ".agent", ".preview.log"]);
const TEXT_FILE_RE = /\.(?:css|html|json|jsx|md|mjs|cjs|ts|tsx|js|txt|yml|yaml)$/i;

export interface WorkspaceFile {
  path: string;
  content: string;
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root: string, prefix = ""): Promise<string[]> {
  const output: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      output.push(...(await walkFiles(root, relativePath)));
    } else {
      output.push(relativePath);
    }
  }
  return output.sort();
}

export class SandboxWorkspace {
  constructor(
    public readonly projectRoot: string,
    public readonly sandboxRoot: string,
  ) {}

  static async create(projectRoot: string, runId: string): Promise<SandboxWorkspace> {
    const root = resolve(projectRoot);
    const sandboxRoot = join(root, ".agent", "sandboxes", runId);
    await rm(sandboxRoot, { recursive: true, force: true });
    await mkdir(dirname(sandboxRoot), { recursive: true });
    await mkdir(sandboxRoot, { recursive: true });

    const sourceFiles = await walkFiles(root);
    for (const file of sourceFiles) {
      const source = join(root, file);
      const target = join(sandboxRoot, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { force: true });
    }

    return new SandboxWorkspace(root, sandboxRoot);
  }

  resolveSandboxPath(relativePath: string): string {
    const target = resolve(this.sandboxRoot, relativePath);
    if (!isInside(this.sandboxRoot, target)) {
      throw new Error(`Path escapes sandbox: ${relativePath}`);
    }
    return target;
  }

  async listFiles(): Promise<string[]> {
    return walkFiles(this.sandboxRoot);
  }

  async readFile(relativePath: string): Promise<string> {
    return readFile(this.resolveSandboxPath(relativePath), "utf-8");
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const target = this.resolveSandboxPath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf-8");
  }

  async deleteFile(relativePath: string): Promise<void> {
    await rm(this.resolveSandboxPath(relativePath), { force: true });
  }

  async readSnapshot(maxFiles = 80, maxChars = 24_000): Promise<WorkspaceFile[]> {
    const files = await this.listFiles();
    const snapshot: WorkspaceFile[] = [];
    for (const path of files.slice(0, maxFiles)) {
      if (!TEXT_FILE_RE.test(path)) {
        continue;
      }
      try {
        const content = await this.readFile(path);
        snapshot.push({
          path,
          content: content.length > maxChars ? `${content.slice(0, maxChars)}\n/* truncated */` : content,
        });
      } catch {
        // Skip unreadable files.
      }
    }
    return snapshot;
  }

  async promoteToProject(): Promise<void> {
    const projectFiles = await walkFiles(this.projectRoot);
    for (const file of projectFiles) {
      await rm(join(this.projectRoot, file), { force: true });
    }

    const sandboxFiles = await walkFiles(this.sandboxRoot);
    for (const file of sandboxFiles) {
      const source = join(this.sandboxRoot, file);
      const target = join(this.projectRoot, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { force: true });
    }
  }

  async diffAgainstProject(): Promise<{ changedFiles: ChangedFile[]; summary: string }> {
    const projectFiles = await walkFiles(this.projectRoot);
    const sandboxFiles = await walkFiles(this.sandboxRoot);
    const allFiles = [...new Set([...projectFiles, ...sandboxFiles])].sort();
    const changedFiles: ChangedFile[] = [];

    for (const path of allFiles) {
      const projectPath = join(this.projectRoot, path);
      const sandboxPath = join(this.sandboxRoot, path);
      const projectExists = await exists(projectPath);
      const sandboxExists = await exists(sandboxPath);
      if (!sandboxExists && projectExists) {
        const previous = await readMaybeText(projectPath);
        changedFiles.push({
          path,
          changeType: "deleted",
          additions: 0,
          deletions: countLines(previous),
        });
        continue;
      }
      if (sandboxExists && !projectExists) {
        const next = await readMaybeText(sandboxPath);
        changedFiles.push({
          path,
          changeType: "created",
          additions: countLines(next),
          deletions: 0,
        });
        continue;
      }

      const [previous, next] = await Promise.all([readMaybeText(projectPath), readMaybeText(sandboxPath)]);
      if (previous !== next) {
        const previousLines = new Set(previous.split(/\r?\n/));
        const nextLines = new Set(next.split(/\r?\n/));
        changedFiles.push({
          path,
          changeType: "updated",
          additions: next.split(/\r?\n/).filter((line) => !previousLines.has(line)).length,
          deletions: previous.split(/\r?\n/).filter((line) => !nextLines.has(line)).length,
        });
      }
    }

    const summary = changedFiles.length
      ? changedFiles.map((file) => `${file.changeType}: ${file.path}`).join("\n")
      : "No file changes.";
    return { changedFiles, summary };
  }

  async sizeBytes(): Promise<number> {
    let total = 0;
    for (const path of await this.listFiles()) {
      try {
        total += (await stat(join(this.sandboxRoot, path))).size;
      } catch {
        // Ignore disappearing files.
      }
    }
    return total;
  }
}

async function readMaybeText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

function countLines(content: string): number {
  if (!content) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

export function summarizePath(root: string, target: string): string {
  const value = relative(root, target);
  return value || ".";
}
