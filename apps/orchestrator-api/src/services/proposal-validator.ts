import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { AgentSessionState, ExecutionStep, FileOperation, ProjectRecord, RepairContext, RunRecord, WorkspaceFile } from "@vide/contracts";

import type { AgentClient } from "../agent-client.js";
import { CommandExecutionError, type RunnerService } from "../runner.js";
import type { WorkspaceService } from "../workspace.js";

const MAX_PREFLIGHT_REPAIR_ATTEMPTS = 3;
const TAILWIND_DIRECTIVE_RE = /@tailwind\b|@apply\b/;
const TAILWIND_UTILITY_RE =
  /(?:className|class)\s*=\s*["'`][^"'`]*(?:\b(?:bg|text|px|py|pt|pb|pl|pr|mt|mb|ml|mr|mx|my|w|h|min-h|max-w|grid-cols|gap|space-x|space-y|justify|items|rounded|shadow|font|tracking|leading|object|overflow|inset|top|bottom|left|right|z|col-span|row-span|from|to|via)-|(?:hover|focus|md|lg|xl):)/;

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultInstallStep(): ExecutionStep {
  return {
    type: "install_dependencies",
    description: "Install the app dependencies with npm.",
    packageManager: "npm",
  };
}

function defaultBuildStep(): ExecutionStep {
  return {
    type: "build_web_app",
    description: "Run a production build as a verification step.",
    packageManager: "npm",
  };
}

function parsePackageJson(files: WorkspaceFile[]): Record<string, unknown> | null {
  const packageJson = files.find((file) => file.path === "package.json");
  if (!packageJson) {
    return null;
  }

  try {
    return JSON.parse(packageJson.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function dependencyNames(pkg: Record<string, unknown> | null): Set<string> {
  if (!pkg) {
    return new Set();
  }

  const combined = {
    ...(typeof pkg.dependencies === "object" && pkg.dependencies ? (pkg.dependencies as Record<string, unknown>) : {}),
    ...(typeof pkg.devDependencies === "object" && pkg.devDependencies ? (pkg.devDependencies as Record<string, unknown>) : {}),
  };

  return new Set(Object.keys(combined));
}

function hasFile(files: WorkspaceFile[], filename: string): boolean {
  return files.some((file) => file.path === filename);
}

function isCodeLikeFile(path: string): boolean {
  return /\.(?:tsx|jsx|ts|js|css|html)$/i.test(path);
}

export function detectStaticValidationIssue(files: WorkspaceFile[]): string | null {
  const codeFiles = files.filter((file) => isCodeLikeFile(file.path));
  const combinedContent = codeFiles.map((file) => file.content).join("\n");
  const pkg = parsePackageJson(files);
  const deps = dependencyNames(pkg);
  const hasTailwindDeps =
    deps.has("tailwindcss") &&
    deps.has("postcss") &&
    deps.has("autoprefixer");
  const hasTailwindConfig =
    hasFile(files, "tailwind.config.js") ||
    hasFile(files, "tailwind.config.ts") ||
    hasFile(files, "postcss.config.js") ||
    hasFile(files, "postcss.config.cjs") ||
    hasFile(files, "postcss.config.mjs");

  if (TAILWIND_DIRECTIVE_RE.test(combinedContent) && (!hasTailwindDeps || !hasTailwindConfig)) {
    return (
      "Tailwind directives were generated without the full Tailwind toolchain. " +
      "Use plain CSS instead, or add tailwindcss, postcss, autoprefixer, and config files."
    );
  }

  if (TAILWIND_UTILITY_RE.test(combinedContent) && !hasTailwindDeps) {
    return (
      "Tailwind-style utility classes were generated without Tailwind dependencies. " +
      "Replace them with plain CSS classes or add a complete Tailwind setup."
    );
  }

  return null;
}

class PreflightValidationError extends Error {
  constructor(
    public readonly category: RepairContext["category"],
    public readonly failedCommand: string,
    public readonly output: string,
  ) {
    super(output);
    this.name = "PreflightValidationError";
  }
}

export class ProposalValidator {
  constructor(
    private readonly runner: RunnerService,
    private readonly workspace: WorkspaceService,
    private readonly agentClient: AgentClient,
  ) {}

  async validate(project: ProjectRecord, run: RunRecord): Promise<AgentSessionState> {
    const tempRoot = await mkdtemp(join(tmpdir(), "vide-preflight-"));
    const candidateState = cloneState(run.state);
    const preservedMessages = cloneState(run.state.messages);
    const validationProject = this.createValidationProject(project, tempRoot, candidateState);

    try {
      await this.workspace.ensureProjectWorkspace(validationProject);
      await this.workspace.resetPreviewLog(validationProject);
      await this.workspace.applyFileOperations(validationProject, candidateState.fileOperations);

      let currentState = candidateState;

      for (let attempt = 1; attempt <= MAX_PREFLIGHT_REPAIR_ATTEMPTS + 1; attempt += 1) {
        try {
          await this.runInstallAndBuild(validationProject, currentState.executionManifest);

          const fullFiles = await this.workspace.readWorkspaceFiles(validationProject);
          const staticIssue = detectStaticValidationIssue(fullFiles);
          if (staticIssue) {
            throw new PreflightValidationError("requirement_mismatch", "preflight static validation", staticIssue);
          }

          currentState.fileOperations = this.snapshotToWriteOperations(fullFiles);
          currentState.fileChangeSummary = currentState.fileOperations.map((operation) => operation.summary ?? operation.path);
          currentState.messages = preservedMessages;
          currentState.error = undefined;
          currentState.status = "awaiting_approval";
          currentState.runPhase = "report";
          return currentState;
        } catch (error) {
          if (await this.tryAutofix(validationProject, error)) {
            continue;
          }

          if (attempt > MAX_PREFLIGHT_REPAIR_ATTEMPTS) {
            throw error;
          }

          const repairContext = await this.buildRepairContext(error, validationProject, attempt);
          const repairProject = {
            ...project,
            session: currentState,
          };
          const repair = await this.agentClient.runRepair({
            project: repairProject,
            reasoningMode: run.reasoningMode,
            workspaceSnapshot: await this.workspace.readWorkspaceSnapshot(validationProject),
            repairContext,
          });

          if (repair.state.error) {
            throw new Error(repair.state.error);
          }

          if (!repair.state.fileOperations.length) {
            throw new Error("Preflight repair returned no file operations.");
          }

          currentState = {
            ...repair.state,
            messages: preservedMessages,
            clarificationDecision: currentState.clarificationDecision,
            workingSpec: repair.state.workingSpec ?? currentState.workingSpec,
            appSpec: repair.state.appSpec ?? currentState.appSpec,
          };
          validationProject.session = currentState;
          await this.workspace.applyFileOperations(validationProject, repair.state.fileOperations);
        }
      }

      throw new Error("Preflight validation exhausted its repair budget.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private createValidationProject(project: ProjectRecord, workspaceRoot: string, session: AgentSessionState): ProjectRecord {
    return {
      ...project,
      workspaceRoot,
      session,
      latestRun: undefined,
      versions: [],
      preview: {
        status: "idle",
        updatedAt: new Date().toISOString(),
      },
    };
  }

  private async runInstallAndBuild(project: ProjectRecord, manifest: ExecutionStep[]): Promise<void> {
    const emitLog = async (_message: string) => undefined;
    const installStep = manifest.find((step) => step.type === "install_dependencies") ?? defaultInstallStep();
    const buildStep = manifest.find((step) => step.type === "build_web_app") ?? defaultBuildStep();

    await this.runner.execute(installStep, project, emitLog);
    await this.runner.execute(buildStep, project, emitLog);
  }

  private snapshotToWriteOperations(files: WorkspaceFile[]): FileOperation[] {
    return files.map((file) => ({
      type: "write",
      path: file.path,
      summary: `Write ${file.path}.`,
      content: file.content,
    }));
  }

  private async buildRepairContext(
    error: unknown,
    project: ProjectRecord,
    attempt: number,
  ): Promise<RepairContext> {
    if (error instanceof PreflightValidationError) {
      return {
        attempt,
        category: error.category,
        failedCommand: error.failedCommand,
        buildError: error.output,
      };
    }

    if (error instanceof CommandExecutionError) {
      return {
        attempt,
        category: this.categorizeCommandFailure(error.output),
        failedCommand: error.command.join(" "),
        buildError: error.output || (await this.workspace.readPreviewLogTail(project)) || error.message,
      };
    }

    const message = error instanceof Error ? error.message : "Unknown preflight validation error";
    return {
      attempt,
      category: "requirement_mismatch",
      failedCommand: "preflight validation",
      buildError: message,
    };
  }

  private categorizeCommandFailure(output: string): RepairContext["category"] {
    const lowered = output.toLowerCase();
    if (
      lowered.includes("cannot find module") ||
      lowered.includes("cannot find package") ||
      lowered.includes("failed to resolve import") ||
      lowered.includes("unknown at rule @tailwind") ||
      lowered.includes("tailwindcss") ||
      lowered.includes("postcss") ||
      lowered.includes("npm err!") ||
      lowered.includes("no matching version found")
    ) {
      return "dependency";
    }

    return "type_build";
  }

  private async tryAutofix(project: ProjectRecord, error: unknown): Promise<boolean> {
    if (!(error instanceof CommandExecutionError)) {
      return false;
    }

    const fixedTsconfigNode = await this.ensureMissingTsconfigNode(project, error.output);
    const fixedUnusedImports = await this.removeUnusedImports(project, error.output);
    return fixedTsconfigNode || fixedUnusedImports;
  }

  private async ensureMissingTsconfigNode(project: ProjectRecord, output: string): Promise<boolean> {
    if (!output.includes("TS6053") || !output.includes("tsconfig.node.json")) {
      return false;
    }

    const targetPath = join(project.workspaceRoot, "tsconfig.node.json");
    try {
      await readFile(targetPath, "utf-8");
      return false;
    } catch {
      await writeFile(
        targetPath,
        JSON.stringify(
          {
            compilerOptions: {
              composite: true,
              skipLibCheck: true,
              module: "ESNext",
              moduleResolution: "bundler",
              allowSyntheticDefaultImports: true,
            },
            include: ["vite.config.ts"],
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );
      return true;
    }
  }

  private async removeUnusedImports(project: ProjectRecord, output: string): Promise<boolean> {
    const matches = Array.from(
      output.matchAll(/([^\s:(][^:(]*\.(?:ts|tsx|js|jsx))\(\d+,\d+\): error TS6133: '([^']+)' is declared but its value is never read\./g),
    );
    if (!matches.length) {
      return false;
    }

    let changed = false;
    for (const match of matches) {
      const [, filePath, identifier] = match;
      const absolutePath = isAbsolute(filePath) ? filePath : join(project.workspaceRoot, filePath);
      let content: string;
      try {
        content = await readFile(absolutePath, "utf-8");
      } catch {
        continue;
      }

      const next = this.removeUnusedIdentifierFromImports(content, identifier);
      if (next !== content) {
        await writeFile(absolutePath, next, "utf-8");
        changed = true;
      }
    }

    return changed;
  }

  private removeUnusedIdentifierFromImports(content: string, identifier: string): string {
    const lines = content.split("\n");
    const nextLines = lines.flatMap((line) => {
      if (!line.trim().startsWith("import")) {
        return [line];
      }

      const trimmed = line.trim();

      const namespaceImport = trimmed.match(/^import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+(['"].+['"]);?$/);
      if (namespaceImport?.[1] === identifier) {
        return [];
      }

      const defaultAndNamed = trimmed.match(/^import\s+([A-Za-z0-9_$]+)\s*,\s*\{([^}]+)\}\s+from\s+(['"].+['"]);?$/);
      if (defaultAndNamed) {
        const [, defaultImport, namedBlock, source] = defaultAndNamed;
        const namedImports = namedBlock
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .filter((item) => item !== identifier);

        if (defaultImport === identifier) {
          if (namedImports.length) {
            return [`import { ${namedImports.join(", ")} } from ${source};`];
          }
          return [];
        }

        if (namedImports.length !== namedBlock.split(",").map((item) => item.trim()).filter(Boolean).length) {
          return [`import ${defaultImport}, { ${namedImports.join(", ")} } from ${source};`];
        }
        return [line];
      }

      const namedOnly = trimmed.match(/^import\s+\{([^}]+)\}\s+from\s+(['"].+['"]);?$/);
      if (namedOnly) {
        const [, namedBlock, source] = namedOnly;
        const original = namedBlock.split(",").map((item) => item.trim()).filter(Boolean);
        const namedImports = original.filter((item) => item !== identifier);
        if (namedImports.length !== original.length) {
          if (!namedImports.length) {
            return [];
          }
          return [`import { ${namedImports.join(", ")} } from ${source};`];
        }
        return [line];
      }

      const defaultOnly = trimmed.match(/^import\s+([A-Za-z0-9_$]+)\s+from\s+(['"].+['"]);?$/);
      if (defaultOnly?.[1] === identifier) {
        return [];
      }

      return [line];
    });

    return nextLines.join("\n");
  }
}
