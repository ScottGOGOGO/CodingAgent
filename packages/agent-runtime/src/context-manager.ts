import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ChatMessage } from "@vide/contracts";

import type { SandboxWorkspace, WorkspaceFile } from "./sandbox.js";

const execFileAsync = promisify(execFile);
const CORE_PATHS = [
  "package.json",
  "next.config.mjs",
  "tsconfig.json",
  "next-env.d.ts",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/globals.css",
  "src/app/actions.ts",
  "src/app/api/items/route.ts",
  "src/lib/db.ts",
  "prisma/schema.prisma",
];

export interface ContextBundle {
  summary: string;
  files: WorkspaceFile[];
  gitStatus: string;
}

export class ContextManager {
  constructor(private readonly maxChars = 48_000) {}

  async build(args: {
    workspace: SandboxWorkspace;
    messages: ChatMessage[];
    userMessage?: string;
  }): Promise<ContextBundle> {
    const snapshot = await args.workspace.readSnapshot(100, 18_000);
    const selected = this.selectFiles(snapshot, args.userMessage ?? this.latestUserMessage(args.messages));
    const gitStatus = await this.readGitStatus(args.workspace.projectRoot);
    const summary = [
      `Workspace files: ${snapshot.length}`,
      `Selected files: ${selected.map((file) => file.path).join(", ") || "none"}`,
      gitStatus ? `Git status:\n${gitStatus}` : "Git status: unavailable",
    ].join("\n");

    return { summary, files: this.trimFiles(selected), gitStatus };
  }

  selectFiles(files: WorkspaceFile[], userMessage: string): WorkspaceFile[] {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const selected: WorkspaceFile[] = [];
    for (const path of CORE_PATHS) {
      const file = byPath.get(path);
      if (file) {
        selected.push(file);
      }
    }

    const tokens = buildSearchTokens(userMessage);
    const scored = files
      .filter((file) => !selected.some((item) => item.path === file.path))
      .map((file) => {
        const haystack = `${file.path}\n${file.content.slice(0, 4000)}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (haystack.includes(token)) {
            score += 1;
          }
        }
        return { file, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));

    return [...selected, ...scored.map((item) => item.file)].slice(0, 16);
  }

  private trimFiles(files: WorkspaceFile[]): WorkspaceFile[] {
    let remaining = this.maxChars;
    const trimmed: WorkspaceFile[] = [];
    for (const file of files) {
      if (remaining <= 0) {
        break;
      }
      const content = file.content.length > remaining ? `${file.content.slice(0, remaining)}\n/* context truncated */` : file.content;
      remaining -= content.length;
      trimmed.push({ path: file.path, content });
    }
    return trimmed;
  }

  private latestUserMessage(messages: ChatMessage[]): string {
    return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  }

  private async readGitStatus(cwd: string): Promise<string> {
    try {
      const [branch, status, log] = await Promise.all([
        execFileAsync("git", ["branch", "--show-current"], { cwd }).then((result) => result.stdout.trim()),
        execFileAsync("git", ["--no-optional-locks", "status", "--short"], { cwd }).then((result) => result.stdout.trim()),
        execFileAsync("git", ["--no-optional-locks", "log", "--oneline", "-n", "3"], { cwd }).then((result) => result.stdout.trim()),
      ]);
      return [`branch=${branch || "unknown"}`, status ? `status:\n${status}` : "status: clean", log ? `recent commits:\n${log}` : ""]
        .filter(Boolean)
        .join("\n");
    } catch {
      return "";
    }
  }
}

function buildSearchTokens(value: string): Set<string> {
  const tokens = new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .filter((part) => part.length >= 2),
  );
  const cjk = value.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const chunk of cjk) {
    for (let index = 0; index < chunk.length - 1; index += 1) {
      tokens.add(chunk.slice(index, index + 2));
    }
  }
  return tokens;
}
