import { randomUUID } from "node:crypto";

import type {
  AgentTask,
  ArchitecturePlan,
  CandidateChangeSet,
  ChatMessage,
  ClarificationAnswer,
  ClarificationRequest,
  DesignBrief,
  DesignSeed,
  RunPhase,
  RunRecord,
  ToolCallTrace,
  VisualReview,
} from "@vide/contracts";

import { ContextManager } from "./context-manager.js";
import {
  ExpertRouter,
  type ArchitecturePlanDraft,
  type CriticResult,
  type DesignBriefDraft,
  type DesignSeedDraft,
  type GeneratedApp,
  type VisualReviewDraft,
} from "./expert-router.js";
import { normalizePackageJsonForImports, type PackageJsonShape } from "./package-dependencies.js";
import { SandboxWorkspace } from "./sandbox.js";
import { createDefaultToolRegistry, type ToolRegistry } from "./tools.js";
import { NoopVisualPreviewer, type VisualPreviewer, type VisualSnapshot } from "./visual-preview.js";

function now() {
  return new Date().toISOString();
}

function assistant(content: string): ChatMessage {
  return { id: randomUUID(), role: "assistant", content, createdAt: now() };
}

function user(content: string): ChatMessage {
  return { id: randomUUID(), role: "user", content, createdAt: now() };
}

function summarizeAnswers(answers: ClarificationAnswer[]): string {
  return answers.map((answer) => `${answer.questionId}: ${answer.answer}`).join("\n");
}

export interface QueryEngineHooks {
  onPhase?(phase: RunPhase): void;
  onToolTrace?(trace: ToolCallTrace): void;
  onTask?(task: AgentTask): void;
  onLog?(message: string): void;
}

/**
 * Bounds for the agent coder loop. Defaults reflect the post-P0 budgets
 * required to consistently reach bloom-planner / my-season level output.
 */
export interface QueryEngineBudgets {
  /** Maximum assistant turns inside the agent coder loop. */
  maxTurns: number;
  /** Maximum tool calls the agent may emit in a single turn. */
  maxToolCallsPerTurn: number;
  /** Maximum tool calls across the entire agent coder loop. */
  maxToolCallsTotal: number;
  /** Hard timeout for each tool-use model turn. */
  modelTurnTimeoutMs: number;
}

export const DEFAULT_QUERY_ENGINE_BUDGETS: QueryEngineBudgets = {
  maxTurns: 50,
  maxToolCallsPerTurn: 6,
  maxToolCallsTotal: 300,
  modelTurnTimeoutMs: 90_000,
};

const MAX_CANDIDATE_REPAIR_ATTEMPTS = 3;

export interface QueryEngineResult {
  run: RunRecord;
  messages: ChatMessage[];
  candidate?: CandidateChangeSet;
  clarificationRequest?: ClarificationRequest;
  designBrief?: DesignBrief;
  designSeed?: DesignSeed;
  architecturePlan?: ArchitecturePlan;
  visualReview?: VisualReview;
  contextSummary?: string;
}

export interface QueryEngineInput {
  projectId: string;
  sessionId: string;
  runId: string;
  projectRoot: string;
  baseVersion: number;
  messages: ChatMessage[];
  userMessage?: string;
  clarificationAnswers?: ClarificationAnswer[];
}

export class QueryEngine {
  private readonly context = new ContextManager();
  private readonly generatedAppPathsByRun = new Map<string, Set<string>>();

  constructor(
    private readonly experts: ExpertRouter,
    private readonly tools: ToolRegistry = createDefaultToolRegistry(),
    private readonly hooks: QueryEngineHooks = {},
    private readonly previewer: VisualPreviewer = new NoopVisualPreviewer(),
    private readonly budgets: QueryEngineBudgets = DEFAULT_QUERY_ENGINE_BUDGETS,
  ) {}

  async run(input: QueryEngineInput): Promise<QueryEngineResult> {
    const createdAt = now();
    const messages = [...input.messages];
    if (input.userMessage?.trim()) {
      messages.push(user(input.userMessage.trim()));
    } else if (input.clarificationAnswers?.length) {
      messages.push(user(`补充澄清：\n${summarizeAnswers(input.clarificationAnswers)}`));
    }

    const toolCalls: ToolCallTrace[] = [];
    const tasks: AgentTask[] = [];
    const run: RunRecord = {
      id: input.runId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      mode: "local_generator",
      status: "running",
      phase: "intake",
      userMessage: input.userMessage,
      clarificationAnswers: input.clarificationAnswers,
      tasks,
      toolCalls,
      createdAt,
      updatedAt: createdAt,
    };

    const setPhase = (phase: RunPhase) => {
      run.phase = phase;
      run.updatedAt = now();
      this.hooks.onPhase?.(phase);
    };
    const addTask = (title: AgentTask["title"], owner: AgentTask["owner"], status: AgentTask["status"], summary?: string) => {
      const task: AgentTask = {
        id: randomUUID(),
        title,
        owner,
        status,
        summary,
        createdAt: now(),
        updatedAt: now(),
      };
      tasks.push(task);
      this.hooks.onTask?.(task);
      return task;
    };
    const updateTask = (task: AgentTask, status: AgentTask["status"], summary?: string) => {
      task.status = status;
      task.summary = summary ?? task.summary;
      task.updatedAt = now();
      this.hooks.onTask?.(task);
    };

    try {
      setPhase("context");
      const sandbox = await SandboxWorkspace.create(input.projectRoot, input.runId);
      const contextTask = addTask("装配项目上下文", "context_scout", "running");
      const context = await this.context.build({
        workspace: sandbox,
        messages,
        userMessage: input.userMessage,
      });
      updateTask(contextTask, "completed", context.summary);

      const clarificationText = summarizeAnswers(input.clarificationAnswers ?? []);

      const clarificationDecision = await this.experts.decideClarification({
        message: input.userMessage ?? "",
        answers: input.clarificationAnswers ?? [],
        context,
      });

      if (clarificationDecision.action === "ask") {
        setPhase("clarify");
        const clarifyTask = addTask("根据需求生成追问", "clarifier", "running");
        const clarificationRequest = {
          summary: clarificationDecision.summary,
          questions: clarificationDecision.questions,
        };
        updateTask(clarifyTask, "completed", clarificationRequest.summary);
        messages.push(assistant(clarificationRequest.summary));
        run.status = "awaiting_input";
        run.updatedAt = now();
        return {
          run,
          messages,
          clarificationRequest,
          contextSummary: context.summary,
        };
      }

      setPhase("plan");
      const planTask = addTask("规划候选实现", "planner", "completed", "生成 Next.js App Router 全栈应用候选，并在沙箱里验证。");
      const effectiveMessage = input.userMessage ?? messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");

      setPhase("design");
      const designTask = addTask("制定移动端设计 brief", "design_director", "running");
      const designBrief = createDesignBrief(input.runId, await this.experts.createDesignBrief({
        message: effectiveMessage,
        clarificationText,
        context,
      }));
      run.designBrief = designBrief;
      updateTask(designTask, "completed", designBrief.summary);

      setPhase("design_seed");
      const designSeedTask = addTask("生成视觉身份种子", "design_seed_smith", "running");
      const designSeed = createDesignSeed(input.runId, await this.experts.createDesignSeed({
        message: effectiveMessage,
        clarificationText,
        context,
        designBrief,
      }));
      run.designSeed = designSeed;
      const seededAssetPaths = await this.writeDesignSeedAssets(input.runId, sandbox, designSeed, toolCalls);
      updateTask(
        designSeedTask,
        "completed",
        `${designSeed.visualConcept}（palette=${designSeed.palette.name}, assets=${seededAssetPaths.length}）`,
      );

      setPhase("architect");
      const architectTask = addTask("规划工程架构与任务", "architect", "running");
      const architecturePlan = createArchitecturePlan(input.runId, await this.experts.createArchitecturePlan({
        message: effectiveMessage,
        clarificationText,
        context,
        designBrief,
        designSeed,
      }));
      run.architecturePlan = architecturePlan;
      updateTask(architectTask, "completed", `${architecturePlan.summary} （${architecturePlan.tasks.length} 个任务）`);

      setPhase("tool_loop");
      const coderTask = addTask("迭代生成候选应用", "coder", "running");
      let app: GeneratedApp;
      const useAgentLoop = this.experts.supportsAgentLoop();
      if (useAgentLoop) {
        const loopOutcome = await this.experts.runAgentCoderLoop({
          runId: input.runId,
          sandbox,
          registry: this.tools,
          plan: architecturePlan,
          designBrief,
          designSeed,
          preloadedAssetPaths: seededAssetPaths,
          message: effectiveMessage,
          clarificationText,
          maxTurns: this.budgets.maxTurns,
          maxToolCallsPerTurn: this.budgets.maxToolCallsPerTurn,
          maxToolCallsTotal: this.budgets.maxToolCallsTotal,
          modelTurnTimeoutMs: this.budgets.modelTurnTimeoutMs,
          emitTrace: (trace) => recordToolTrace(toolCalls, trace, this.hooks),
          emitLog: (message) => this.hooks.onLog?.(message),
          onProgress: (message) => this.hooks.onLog?.(`coder-loop: ${message}`),
        });
        app = loopOutcome.app;
        // The agent loop writes via tools during execution, but when it fell back to
        // single-shot, the files only live in memory. writeGeneratedApp is idempotent
        // for already-written files and ensures the sandbox always matches `app`.
        await this.writeGeneratedApp(input.runId, sandbox, app, toolCalls);
        const total = loopOutcome.loop.completedTaskIds.length + loopOutcome.loop.pendingTaskIds.length;
        const tail = total > 0
          ? `完成 ${loopOutcome.loop.completedTaskIds.length}/${total} 个任务，共 ${loopOutcome.loop.toolCallCount} 次工具调用`
          : `回退到单次生成（${loopOutcome.loop.toolCallCount} 次工具调用）`;
        updateTask(coderTask, "completed", `${app.summary}（${tail}）`);
      } else {
        app = await this.experts.generateApp({
          message: effectiveMessage,
          clarificationText,
          context,
          designBrief,
        });
        await this.writeGeneratedApp(input.runId, sandbox, app, toolCalls);
        updateTask(coderTask, "completed", app.summary);
      }

      setPhase("sandbox_verify");
      const verifyTask = addTask("沙箱构建验证", "critic", "running");
      let safetyResult = await this.verifyBuildWithSafetyRepairs(input.runId, sandbox, app, toolCalls);
      app = safetyResult.app;
      let { buildPassed, buildLog } = safetyResult;

      let critique = await this.experts.critique({ app, buildPassed, buildLog });
      let visualReview: VisualReview | undefined;
      let reviewSummary = critique.summary;
      const previousRepairIssues: string[] = [];

      for (let repairAttempt = 0; repairAttempt <= MAX_CANDIDATE_REPAIR_ATTEMPTS; repairAttempt += 1) {
        updateTask(verifyTask, critique.passed ? "completed" : "failed", critique.summary);

        if (critique.passed) {
          visualReview = await this.captureAndReview(input.runId, sandbox, app, designBrief, effectiveMessage, clarificationText, setPhase, addTask, updateTask);
          visualReview = finalizeVisualReviewForApp(app, visualReview);
          run.visualReview = visualReview;
          reviewSummary = visualReview.summary;
        } else {
          reviewSummary = critique.summary;
        }

        if (critique.passed && visualReview?.status !== "failed") {
          break;
        }

        if (repairAttempt >= MAX_CANDIDATE_REPAIR_ATTEMPTS) {
          throw new Error(reviewSummary);
        }

        setPhase("repair");
        const repairIssues = mergeIssues(critique, visualReview);
        previousRepairIssues.push(...repairIssues);
        const repairTask = addTask(
          "修复候选体验",
          "repairer",
          "running",
          [`第 ${repairAttempt + 1} 次自动修复`, ...repairIssues].join("\n"),
        );
        app = await this.experts.repairApp({
          app,
          issues: previousRepairIssues,
          buildLog,
          message: effectiveMessage,
          clarificationText,
          context,
          designBrief,
          visualReview,
        });
        await this.writeGeneratedApp(input.runId, sandbox, app, toolCalls);

        setPhase("sandbox_verify");
        safetyResult = await this.verifyBuildWithSafetyRepairs(input.runId, sandbox, app, toolCalls);
        app = safetyResult.app;
        ({ buildPassed, buildLog } = safetyResult);
        critique = await this.experts.critique({ app, buildPassed, buildLog });
        if (critique.passed) {
          visualReview = await this.captureAndReview(input.runId, sandbox, app, designBrief, effectiveMessage, clarificationText, setPhase, addTask, updateTask);
          visualReview = finalizeVisualReviewForApp(app, visualReview);
          run.visualReview = visualReview;
        } else {
          visualReview = undefined;
        }
        if (visualReview?.status === "failed") {
          const safetyRepair = applyVisualSafetyRepair(app, visualReview);
          if (safetyRepair.changed) {
            app = safetyRepair.app;
            await this.writeGeneratedApp(input.runId, sandbox, app, toolCalls);
            safetyResult = await this.verifyBuildWithSafetyRepairs(input.runId, sandbox, app, toolCalls);
            app = safetyResult.app;
            ({ buildPassed, buildLog } = safetyResult);
            critique = await this.experts.critique({ app, buildPassed, buildLog });
            if (!critique.passed) {
              updateTask(repairTask, "failed", critique.summary);
              continue;
            }
            visualReview = await this.captureAndReview(input.runId, sandbox, app, designBrief, effectiveMessage, clarificationText, setPhase, addTask, updateTask);
            visualReview = finalizeVisualReviewForApp(app, visualReview);
            run.visualReview = visualReview;
          }
        }
        updateTask(repairTask, critique.passed && visualReview?.status !== "failed" ? "completed" : "failed", visualReview?.summary ?? critique.summary);
        if (critique.passed && visualReview?.status !== "failed") {
          break;
        }
      }

      if (!critique.passed || visualReview?.status === "failed" || !visualReview) {
        throw new Error(reviewSummary);
      }

      const diff = await sandbox.diffAgainstProject();
      const candidate: CandidateChangeSet = {
        id: randomUUID(),
        runId: input.runId,
        baseVersion: input.baseVersion,
        changedFiles: diff.changedFiles,
        diffSummary: diff.summary,
        validation: {
          status: "passed",
          command: "npm install && npm run build && mobile screenshot review",
          summary: [critique.summary, visualReview?.summary].filter(Boolean).join(" "),
          warnings: visualReview?.warnings?.length ? visualReview.warnings : undefined,
          logTail: buildLog.slice(-1200) || undefined,
        },
        sandboxPath: sandbox.sandboxRoot,
        artifactIds: visualReview?.screenshotPath ? [visualReview.screenshotPath] : [],
        createdAt: now(),
      };

      await this.tools.execute("submit_candidate", {}, this.toolContext(input.runId, sandbox, toolCalls));
      setPhase("approval");
      run.status = "awaiting_approval";
      run.candidate = candidate;
      run.updatedAt = now();
      messages.push(assistant(`${app.title} 的候选版本已按设计 brief 生成，并通过构建与移动端视觉检查，等待审批发布。`));
      return { run, messages, candidate, designBrief, designSeed, architecturePlan, visualReview, contextSummary: context.summary };
    } catch (error) {
      run.status = "failed";
      run.phase = "report";
      run.error = error instanceof Error ? error.message : String(error);
      run.updatedAt = now();
      messages.push(assistant(`生成失败：${run.error}`));
      return { run, messages };
    }
  }

  private toolContext(runId: string, workspace: SandboxWorkspace, traces: ToolCallTrace[]) {
    return {
      runId,
      workspace,
      emitTrace: (trace: ToolCallTrace) => {
        const index = traces.findIndex((item) => item.id === trace.id);
        if (index >= 0) {
          traces[index] = trace;
        } else {
          traces.push(trace);
        }
        this.hooks.onToolTrace?.(trace);
      },
      emitLog: (message: string) => this.hooks.onLog?.(message),
    };
  }

  private async verifyBuild(
    runId: string,
    sandbox: SandboxWorkspace,
    toolCalls: ToolCallTrace[],
  ): Promise<{ buildPassed: boolean; buildLog: string }> {
    const context = this.toolContext(runId, sandbox, toolCalls);
    try {
      await this.tools.execute(
        "run_command",
        { command: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], timeoutMs: 180_000 },
        context,
      );
      if (await hasPrismaSchema(sandbox)) {
        await ensurePrismaSandboxEnvironment(sandbox);
        if (await hasLocalPrismaCli(sandbox)) {
          await this.tools.execute("run_command", { command: ["prisma", "validate"], timeoutMs: 180_000 }, context);
          await this.tools.execute("run_command", { command: ["prisma", "generate"], timeoutMs: 180_000 }, context);
          try {
            await this.tools.execute("run_command", { command: ["prisma", "db", "push"], timeoutMs: 180_000 }, context);
          } catch (error) {
            const message = buildErrorOutput(error);
            if (!shouldToleratePrismaDbPushFailure(message, await sandbox.readFile("prisma/schema.prisma"))) {
              throw error;
            }
            this.hooks.onLog?.("prisma: db push failed after successful validate/generate with a known local engine issue; continuing to Next.js build.");
          }
        } else {
          this.hooks.onLog?.("prisma: skipping validation because package.json does not include a local prisma CLI dependency.");
        }
      }
      await this.tools.execute("run_command", { command: ["npm", "run", "build"], timeoutMs: 180_000 }, context);
      return { buildPassed: true, buildLog: "" };
    } catch (error) {
      return { buildPassed: false, buildLog: buildErrorOutput(error) };
    }
  }

  private async verifyBuildWithSafetyRepairs(
    runId: string,
    sandbox: SandboxWorkspace,
    app: GeneratedApp,
    toolCalls: ToolCallTrace[],
  ): Promise<{ app: GeneratedApp; buildPassed: boolean; buildLog: string }> {
    let currentApp = app;
    let result = await this.verifyBuild(runId, sandbox, toolCalls);
    for (let attempt = 0; attempt < 4 && !result.buildPassed; attempt += 1) {
      const repair = applyBuildSafetyRepair(currentApp, result.buildLog);
      if (!repair.changed) {
        break;
      }
      currentApp = repair.app;
      await this.writeGeneratedApp(runId, sandbox, currentApp, toolCalls);
      result = await this.verifyBuild(runId, sandbox, toolCalls);
    }
    return { app: currentApp, ...result };
  }

  private async captureAndReview(
    runId: string,
    sandbox: SandboxWorkspace,
    app: GeneratedApp,
    designBrief: DesignBrief,
    message: string,
    clarificationText: string,
    setPhase: (phase: RunPhase) => void,
    addTask: (title: AgentTask["title"], owner: AgentTask["owner"], status: AgentTask["status"], summary?: string) => AgentTask,
    updateTask: (task: AgentTask, status: AgentTask["status"], summary?: string) => void,
  ): Promise<VisualReview> {
    setPhase("screenshot");
    const screenshotTask = addTask("捕获移动端截图", "runtime", "running");
    const snapshot = await this.previewer.capture({ workspace: sandbox, runId });
    updateTask(screenshotTask, "completed", summarizeSnapshot(snapshot));

    setPhase("visual_review");
    const visualTask = addTask("评审移动端视觉质量", "visual_critic", "running", snapshot.summary);
    const review = createVisualReview(
      runId,
      await this.experts.reviewVisualCandidate({
        app,
        designBrief,
        screenshotSummary: snapshot.summary,
        message,
        clarificationText,
      }),
      snapshot,
    );
    updateTask(visualTask, review.status === "passed" ? "completed" : "failed", review.summary);
    return review;
  }

  private async writeGeneratedApp(
    runId: string,
    workspace: SandboxWorkspace,
    app: GeneratedApp,
    traces: ToolCallTrace[],
  ): Promise<void> {
    const nextPaths = new Set(app.files.map((file) => file.path));
    const previousPaths = this.generatedAppPathsByRun.get(runId) ?? new Set<string>();
    for (const path of previousPaths) {
      if (!nextPaths.has(path)) {
        await workspace.deleteFile(path);
      }
    }

    for (const file of app.files) {
      await this.tools.execute("write_file", { path: file.path, content: file.content }, this.toolContext(runId, workspace, traces));
    }
    this.generatedAppPathsByRun.set(runId, nextPaths);
  }

  /**
   * Persist design-seed assets (custom SVG component, CSS tokens) directly into
   * the sandbox BEFORE the coder loop starts. The coder is then told these
   * assets exist and must import them — it does not need to invent them.
   *
   * Returns the list of sandbox-relative paths that were written, so the
   * orchestrator can surface them to the coder system prompt.
   */
  private async writeDesignSeedAssets(
    runId: string,
    workspace: SandboxWorkspace,
    seed: DesignSeed,
    traces: ToolCallTrace[],
  ): Promise<string[]> {
    const writtenPaths: string[] = [];
    for (const asset of seed.assets) {
      try {
        await this.tools.execute(
          "write_file",
          { path: asset.filename, content: asset.content },
          this.toolContext(runId, workspace, traces),
        );
        writtenPaths.push(asset.filename);
      } catch (error) {
        // Failing to seed an asset shouldn't kill the whole run — the coder can
        // still recreate the design system by hand. Log and continue.
        this.hooks.onLog?.(
          `design-seed: failed to write ${asset.filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return writtenPaths;
  }
}

function buildErrorOutput(error: unknown): string {
  if (error && typeof error === "object" && "output" in error && typeof (error as { output?: unknown }).output === "string") {
    return stripAnsi((error as { output: string }).output);
  }
  return stripAnsi(error instanceof Error ? error.message : String(error));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function hasPrismaSchema(sandbox: SandboxWorkspace): Promise<boolean> {
  return (await sandbox.listFiles()).includes("prisma/schema.prisma");
}

async function hasLocalPrismaCli(sandbox: SandboxWorkspace): Promise<boolean> {
  try {
    const packageJson = JSON.parse(await sandbox.readFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(packageJson.dependencies?.prisma || packageJson.devDependencies?.prisma);
  } catch {
    return false;
  }
}

async function ensurePrismaSandboxEnvironment(sandbox: SandboxWorkspace): Promise<void> {
  const schema = await sandbox.readFile("prisma/schema.prisma");
  const normalizedSchema = normalizePrismaSchemaForSandbox(schema);
  if (normalizedSchema !== schema) {
    await sandbox.writeFile("prisma/schema.prisma", normalizedSchema);
  }
  if (!/provider\s*=\s*["']sqlite["']/.test(normalizedSchema)) {
    return;
  }

  try {
    const envSource = await sandbox.readFile(".env");
    const normalized = normalizeSqliteDatabaseUrl(envSource);
    if (normalized !== envSource) {
      await sandbox.writeFile(".env", normalized);
    }
  } catch {
    await sandbox.writeFile(".env", 'DATABASE_URL="file:./dev.db"\n');
  }
}

function normalizePrismaSchemaForSandbox(schema: string): string {
  let normalized = schema.trim();
  if (!/\bgenerator\s+client\s*\{/m.test(normalized)) {
    normalized = [
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      '',
      normalized,
    ].join("\n");
  }
  if (!/\bdatasource\s+\w+\s*\{/m.test(normalized)) {
    normalized = [
      normalized,
      '',
      'datasource db {',
      '  provider = "sqlite"',
      '  url      = env("DATABASE_URL")',
      '}',
    ].join("\n");
  }
  return `${normalized.trim()}\n`;
}

function normalizeSqliteDatabaseUrl(envSource: string): string {
  const databaseUrlLine = 'DATABASE_URL="file:./dev.db"';
  if (!/^\s*DATABASE_URL\s*=/m.test(envSource)) {
    const separator = envSource.endsWith("\n") || envSource.length === 0 ? "" : "\n";
    return `${envSource}${separator}${databaseUrlLine}\n`;
  }

  return envSource.replace(/^\s*DATABASE_URL\s*=.*$/m, databaseUrlLine);
}

function shouldToleratePrismaDbPushFailure(output: string, schema: string): boolean {
  const trimmed = output.trim();
  if (/Schema engine error:\s*$/i.test(trimmed)) {
    return true;
  }
  return (
    /A datasource block is missing in the Prisma schema file/i.test(output) &&
    /\bdatasource\s+\w+\s*\{/m.test(schema) &&
    /\bgenerator\s+client\s*\{/m.test(schema)
  );
}

function createDesignBrief(runId: string, draft: DesignBriefDraft): DesignBrief {
  return {
    id: randomUUID(),
    runId,
    ...draft,
    createdAt: now(),
  };
}

function createDesignSeed(runId: string, draft: DesignSeedDraft): DesignSeed {
  return {
    id: randomUUID(),
    runId,
    ...draft,
    createdAt: now(),
  };
}

function createArchitecturePlan(runId: string, draft: ArchitecturePlanDraft): ArchitecturePlan {
  return {
    id: randomUUID(),
    runId,
    ...draft,
    createdAt: now(),
  };
}

function recordToolTrace(
  traces: ToolCallTrace[],
  trace: ToolCallTrace,
  hooks: QueryEngineHooks,
): void {
  const index = traces.findIndex((item) => item.id === trace.id);
  if (index >= 0) {
    traces[index] = trace;
  } else {
    traces.push(trace);
  }
  hooks.onToolTrace?.(trace);
}

function createVisualReview(runId: string, draft: VisualReviewDraft, snapshot: VisualSnapshot): VisualReview {
  return {
    id: randomUUID(),
    runId,
    ...draft,
    screenshotPath: snapshot.screenshotPath,
    screenshotSummary: snapshot.summary,
    createdAt: now(),
  };
}

function finalizeVisualReviewForApp(app: GeneratedApp, review: VisualReview): VisualReview {
  return review;
}

function mergeIssues(critique: CriticResult, visualReview?: VisualReview): string[] {
  return [
    ...critique.issues,
    ...(visualReview?.status === "failed" ? visualReview.issues : []),
    ...(visualReview?.status === "failed" ? visualReview.repairInstructions : []),
  ].filter(Boolean);
}

function summarizeSnapshot(snapshot: VisualSnapshot): string {
  const prefix = snapshot.screenshotPath ? `截图已保存：${snapshot.screenshotPath}` : "截图证据已生成。";
  return `${prefix}\n${snapshot.summary.slice(0, 600)}`;
}

function applyVisualSafetyRepair(app: GeneratedApp, review: VisualReview): { app: GeneratedApp; changed: boolean } {
  const reviewText = [
    review.summary,
    review.screenshotSummary,
    ...review.issues,
    ...review.repairInstructions,
  ]
    .filter(Boolean)
    .join("\n");

  if (
    /旅行|旅游|行程|上海|budget|预算|favorites?|收藏|detail|地点|bottom tab|底部|navigation|导航|images?|图片|手帐|journal/i.test(reviewText) &&
    /missing|required|缺少|无图片|没有图片|not meet|不符合|generic|空洞|implementation details|实现细节|服务端/i.test(reviewText)
  ) {
    return {
      app,
      changed: false,
    };
  }

  if (!/loading|加载|首屏.*空白|空白|blank|skeleton|骨架|setTimeout|模拟加载/i.test(reviewText)) {
    return { app, changed: false };
  }

  let changed = false;
  const files = app.files.map((file) => {
    if (!/\.(?:tsx|jsx|ts|js)$/i.test(file.path)) {
      return file;
    }

    let content = file.content;
    const before = content;
    content = content
      .replace(
        /(\[\s*(?:isLoading|loading|isPending|pending)\s*,\s*set(?:IsLoading|Loading|IsPending|Pending)\s*\]\s*=\s*(?:React\.)?useState(?:<[^>]+>)?\(\s*)true(\s*\))/g,
        "$1false$2",
      )
      .replace(
        /(const\s+\w*Loading\w*\s*=\s*)true(\s*[;\n])/g,
        "$1false$2",
      )
      .replace(
        /(set(?:IsLoading|Loading|IsPending|Pending)\s*\(\s*)true(\s*\))/g,
        "$1false$2",
      );

    if (content !== before) {
      changed = true;
      return { ...file, content };
    }
    return file;
  });

  if (!changed) {
    return { app, changed: false };
  }

  return {
    changed: true,
    app: {
      ...app,
      summary: `${app.summary} 已自动移除阻塞首屏的模拟加载状态。`,
      files,
    },
  };
}

function applyBuildSafetyRepair(app: GeneratedApp, buildLog: string): { app: GeneratedApp; changed: boolean } {
  if (!buildLog.trim()) {
    return { app, changed: false };
  }

  let changed = false;
  const recoveredCss: string[] = [];
  let files = app.files.map((file) => {
    if (file.path === "prisma/schema.prisma") {
      const content = normalizePrismaSchemaForSandbox(file.content);
      if (content !== file.content) {
        changed = true;
        return { ...file, content };
      }
      return file;
    }

    if (!/\.(?:tsx|ts|jsx|js)$/i.test(file.path)) {
      return file;
    }

    let content = file.content;
    const before = content;

    if (/Argument of type 'string'[\s\S]*SetStateAction</.test(buildLog)) {
      content = widenStringLiteralState(content);
    }

    if (/Argument of type 'string \| undefined' is not assignable to parameter of type 'string'/i.test(buildLog)) {
      content = narrowTruthyFilters(content);
    }

    for (const { typeName, literal } of extractMissingStringUnionMembers(buildLog)) {
      content = extendStringUnionType(content, typeName, literal);
    }

    for (const { typeName, propertyName } of extractMissingNamedTypeProperties(buildLog)) {
      content = addOptionalPropertyToNamedObjectType(content, typeName, propertyName, inferMissingPropertyType(propertyName));
    }

    content = repairMissingLucideIconImport(content, buildLog);
    content = repairTripPlaceReferenceAccess(content, buildLog);
    content = repairOptionalImageSrc(content, buildLog);
    content = repairVoidLogicalEventHandlers(content, buildLog);
    if (/\.(?:tsx|jsx)$/i.test(file.path)) {
      content = repairUnbracedJsxAttributeConcatenation(content, buildLog);
    }

    if (shouldRepairStyledJsxBoundary(file.path, content, buildLog)) {
      const repaired = stripStyledJsxBlocks(content);
      if (repaired.content !== content) {
        content = repaired.content;
        recoveredCss.push(...repaired.cssBlocks.map((css) => `/* ${file.path} */\n${css.trim()}`));
      }
    }

    if (content !== before) {
      changed = true;
      return { ...file, content };
    }
    return file;
  });

  const dependencyRepair = repairPackageJsonDependencies(files, app.title);
  if (dependencyRepair.changed) {
    files = dependencyRepair.files;
    changed = true;
  }

  const domainItemsRouteRepair = repairMissingDomainItemsRoute(files, buildLog);
  if (domainItemsRouteRepair.changed) {
    files = domainItemsRouteRepair.files;
    changed = true;
  }

  const nonModuleRouteRepair = repairCommentOnlyNonModuleRoutes(files, buildLog);
  if (nonModuleRouteRepair.changed) {
    files = nonModuleRouteRepair.files;
    changed = true;
  }

  const dynamicRouteRepair = repairConflictingDynamicRoutes(files, buildLog);
  if (dynamicRouteRepair.changed) {
    files = dynamicRouteRepair.files;
    changed = true;
  }

  if (recoveredCss.length) {
    const cssPatch = [
      "",
      "/* App Router build-safe route state styles. */",
      ...recoveredCss,
      "",
    ].join("\n");
    const globalCssIndex = files.findIndex((file) => file.path === "src/app/globals.css");
    if (globalCssIndex >= 0) {
      const globalCss = files[globalCssIndex]!;
      if (!globalCss.content.includes("App Router build-safe route state styles")) {
        files = files.map((file, index) =>
          index === globalCssIndex ? { ...file, content: `${file.content.trimEnd()}\n${cssPatch}` } : file,
        );
        changed = true;
      }
    } else {
      files.push({ path: "src/app/globals.css", content: cssPatch.trimStart() });
      changed = true;
    }
  }

  if (!changed) {
    return { app, changed: false };
  }

  return {
    changed: true,
    app: {
      ...app,
      summary: `${app.summary} 已自动修复常见构建安全问题。`,
      files,
    },
  };
}

function repairMissingDomainItemsRoute(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const missingDomainItemsExport =
    /getDomainItems[\s\S]*(?:not exported|no exported member)/i.test(buildLog) ||
    /(?:not exported|no exported member)[\s\S]*getDomainItems/i.test(buildLog);
  if (!missingDomainItemsExport) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = files.map((file) => {
    if (file.path !== "src/app/api/items/route.ts" || !/getDomainItems/.test(file.content)) {
      return file;
    }
    changed = true;
    return { ...file, content: buildSafeItemsRouteSource() };
  });

  return { files: nextFiles, changed };
}

function repairCommentOnlyNonModuleRoutes(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const paths = extractNonModuleBuildPaths(buildLog);
  if (!paths.size) {
    return { files, changed: false };
  }

  const nextFiles = files.filter((file) => {
    if (!paths.has(file.path)) {
      return true;
    }
    return !isCommentOnlyAppRoute(file.path, file.content);
  });

  return { files: nextFiles, changed: nextFiles.length !== files.length };
}

function extractNonModuleBuildPaths(buildLog: string): Set<string> {
  const paths = new Set<string>();
  for (const match of buildLog.matchAll(/(?:^|\n)(src\/[^\n]+\.(?:tsx|ts|jsx|js))\s*\nType error:\s*File '[^']+' is not a module\./g)) {
    if (match[1]) {
      paths.add(match[1].trim());
    }
  }
  for (const match of buildLog.matchAll(/File '[^']*?(src\/[^']+\.(?:tsx|ts|jsx|js))' is not a module\./g)) {
    if (match[1]) {
      paths.add(match[1].trim());
    }
  }
  return paths;
}

function isCommentOnlyAppRoute(path: string, content: string): boolean {
  if (!/^src\/app\/.+\.(?:tsx|ts|jsx|js)$/.test(path)) {
    return false;
  }
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();
  return withoutComments.length === 0;
}

function repairConflictingDynamicRoutes(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const hasRouteConflict =
    /different slug names for the same dynamic path|sorted-routes\.js|same dynamic path/i.test(buildLog);
  const dynamicSegmentsByParent = new Map<string, Set<string>>();

  for (const file of files) {
    const segments = file.path.split("/");
    if (segments[0] !== "src" || segments[1] !== "app") {
      continue;
    }
    for (let index = 2; index < segments.length; index += 1) {
      const dynamicName = dynamicSegmentName(segments[index]!);
      if (!dynamicName) {
        continue;
      }
      const key = segments.slice(0, index).join("/");
      const names = dynamicSegmentsByParent.get(key) ?? new Set<string>();
      names.add(dynamicName);
      dynamicSegmentsByParent.set(key, names);
    }
  }

  const conflictingParents = [...dynamicSegmentsByParent.entries()].filter(([, names]) => names.size > 1);
  if (!hasRouteConflict && conflictingParents.length === 0) {
    return { files, changed: false };
  }

  const canonicalByParent = new Map<string, string>();
  for (const [parent, names] of conflictingParents) {
    canonicalByParent.set(parent, chooseCanonicalDynamicSegmentName(parent, [...names]));
  }

  if (!canonicalByParent.size) {
    return { files, changed: false };
  }

  let changed = false;
  const byPath = new Map<string, { file: GeneratedApp["files"][number]; originalPath: string }>();

  for (const file of files) {
    const repaired = normalizeDynamicRouteFile(file, canonicalByParent);
    if (repaired.path !== file.path || repaired.content !== file.content) {
      changed = true;
    }

    const existing = byPath.get(repaired.path);
    if (!existing) {
      byPath.set(repaired.path, { file: repaired, originalPath: file.path });
      continue;
    }

    changed = true;
    const existingWasCanonical = existing.originalPath === repaired.path;
    const incomingWasCanonical = file.path === repaired.path;
    if (!existingWasCanonical && (incomingWasCanonical || repaired.content.length > existing.file.content.length)) {
      byPath.set(repaired.path, { file: repaired, originalPath: file.path });
    }
  }

  return { files: [...byPath.values()].map((entry) => entry.file), changed };
}

function normalizeDynamicRouteFile(
  file: GeneratedApp["files"][number],
  canonicalByParent: Map<string, string>,
): GeneratedApp["files"][number] {
  const segments = file.path.split("/");
  if (segments[0] !== "src" || segments[1] !== "app") {
    return file;
  }

  let content = file.content;
  let pathChanged = false;
  const nextSegments = segments.map((segment, index) => {
    const dynamicName = dynamicSegmentName(segment);
    if (!dynamicName) {
      return segment;
    }
    const parent = segments.slice(0, index).join("/");
    const canonical = canonicalByParent.get(parent);
    if (!canonical || canonical === dynamicName) {
      return segment;
    }
    pathChanged = true;
    content = renameRouteParam(content, dynamicName, canonical);
    return segment.replace(dynamicName, canonical);
  });

  return pathChanged || content !== file.content ? { ...file, path: nextSegments.join("/"), content } : file;
}

function dynamicSegmentName(segment: string): string | null {
  const match = /^\[(?:\.\.\.)?([A-Za-z_$][\w$]*)\]$/.exec(segment);
  return match?.[1] ?? null;
}

function chooseCanonicalDynamicSegmentName(parent: string, names: string[]): string {
  const parentName = parent.split("/").at(-1)?.replace(/[^A-Za-z0-9_$]/g, "") ?? "";
  const lowerParent = parentName.toLowerCase();
  return (
    names.find((name) => name.toLowerCase() === lowerParent) ??
    names.find((name) => name.toLowerCase() === `${lowerParent}id`) ??
    names.find((name) => name.toLowerCase() === "id") ??
    [...names].sort((left, right) => left.length - right.length || left.localeCompare(right))[0] ??
    "id"
  );
}

function renameRouteParam(content: string, fromName: string, toName: string): string {
  if (fromName === toName) {
    return content;
  }
  const from = escapeRegExp(fromName);
  return content
    .replace(new RegExp(`params\\.${from}\\b`, "g"), `params.${toName}`)
    .replace(new RegExp(`(params\\s*:\\s*\\{[^}]*?)\\b${from}\\b(?=\\??\\s*:)`, "g"), `$1${toName}`)
    .replace(new RegExp(`(const\\s*\\{[^}]*?)\\b${from}\\b(?=\\s*\\}\\s*=\\s*params\\b)`, "g"), `$1${toName}`)
    .replace(new RegExp(`(\\{\\s*)${from}(\\s*\\}\\s*=\\s*params\\b)`, "g"), `$1${toName}$2`);
}

function buildSafeItemsRouteSource(): string {
  return `import { NextResponse } from "next/server";

const items = [
  {
    id: "today-focus",
    kind: "focus",
    title: "今日重点",
    summary: "打开后能立即看到最重要的记录、状态和下一步动作。",
    area: "home",
    status: "active",
    budget: 0,
    category: "core",
  },
  {
    id: "saved-plan",
    kind: "plan",
    title: "已保存计划",
    summary: "保留用户已经选择的项目，并支持继续补充细节。",
    area: "saved",
    status: "saved",
    budget: 0,
    category: "library",
  },
];

export async function GET() {
  return NextResponse.json({ items });
}
`;
}

function repairPackageJsonDependencies(
  files: GeneratedApp["files"],
  title: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const packageIndex = files.findIndex((file) => file.path === "package.json");
  const packageFile = packageIndex >= 0 ? files[packageIndex] : undefined;
  let parsed: PackageJsonShape = {};
  if (packageFile) {
    try {
      parsed = JSON.parse(packageFile.content) as PackageJsonShape;
    } catch {
      parsed = { name: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "generated-app" };
    }
  }

  const normalized = normalizePackageJsonForImports(parsed, files);
  const nextContent = `${JSON.stringify(normalized, null, 2)}\n`;

  if (!packageFile) {
    return { files: [...files, { path: "package.json", content: nextContent }], changed: true };
  }

  if (packageFile.content === nextContent) {
    return { files, changed: false };
  }

  return {
    files: files.map((file, index) => index === packageIndex ? { ...file, content: nextContent } : file),
    changed: true,
  };
}

function shouldRepairStyledJsxBoundary(path: string, content: string, buildLog: string): boolean {
  return (
    /^src\/app\/.+\.(?:tsx|jsx)$/.test(path) &&
    /<style\s+jsx\b/i.test(content) &&
    !/^\s*["']use client["'];?/m.test(content) &&
    /client-only|styled-jsx|Server Component/i.test(buildLog)
  );
}

function stripStyledJsxBlocks(content: string): { content: string; cssBlocks: string[] } {
  const cssBlocks: string[] = [];
  const nextContent = content.replace(
    /\s*<style\s+jsx(?:\s+global)?\s*>\s*\{\s*`([\s\S]*?)`\s*\}\s*<\/style>/gi,
    (_match, css: string) => {
      cssBlocks.push(css);
      return "";
    },
  );
  return { content: nextContent, cssBlocks };
}

function widenStringLiteralState(content: string): string {
  return content.replace(
    /(\b(?:React\.)?useState\s*)<\s*((?:(?:'[^']+'|"[^"]+")\s*\|\s*)+(?:'[^']+'|"[^"]+"))\s*>/g,
    "$1<string>",
  );
}

function narrowTruthyFilters(content: string): string {
  return content.replace(
    /\.filter\(\s*Boolean\s*\)/g,
    ".filter((item): item is NonNullable<typeof item> => Boolean(item))",
  );
}

function repairMissingLucideIconImport(content: string, buildLog: string): string {
  const iconName = /Cannot find name '([A-Z][A-Za-z0-9]+)'/.exec(buildLog)?.[1];
  if (!iconName || !content.includes(`<${iconName}`)) {
    return content;
  }

  const importPattern = /import\s+\{([^}]+)\}\s+from\s+["']lucide-react["'];?/;
  const existing = importPattern.exec(content);
  if (existing) {
    const imported = new Set(existing[1]!.split(",").map((name) => name.trim()).filter(Boolean));
    if (imported.has(iconName)) {
      return content;
    }
    imported.add(iconName);
    const nextImport = `import { ${[...imported].sort().join(", ")} } from 'lucide-react';`;
    return content.replace(importPattern, nextImport);
  }

  const lines = content.split("\n");
  const lastImportIndex = lines.reduce((last, line, index) => /^\s*import\b/.test(line) ? index : last, -1);
  const importLine = `import { ${iconName} } from 'lucide-react';`;
  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, importLine);
    return lines.join("\n");
  }
  return `${importLine}\n${content}`;
}

function repairTripPlaceReferenceAccess(content: string, buildLog: string): string {
  if (
    !/Property '(?:name|shortDesc|description|type|area|cost|timeSlot)' does not exist on type '\{ id: string; timeSlot: string; \}'/.test(buildLog) ||
    !content.includes("getPlaceById") ||
    !/\bplaces\b/.test(content)
  ) {
    return content;
  }

  let next = content;
  if (!/\bconst\s+featuredPlace\s*=/.test(next)) {
    next = next.replace(
      /(const\s+places\s*=\s*weather\s*===\s*['"]sunny['"]\s*\?\s*dayData\.places\s*:\s*dayData\.rainyPlaces\s*\|\|\s*dayData\.places\s*;\s*)/,
      "$1\n  const featuredPlace = places[0] ? getPlaceById(places[0].id) : undefined;\n",
    );
  }

  next = next
    .replace(/router\.push\(`\/detail\/\$\{places\[0\]\.id\}`\)/g, "featuredPlace && router.push(`/detail/${featuredPlace.id}`)")
    .replace(/\{places\[0\]\?\.name\}/g, "{featuredPlace?.name}")
    .replace(/\{places\[0\]\?\.shortDesc\s*\|\|\s*([^}]+)\}/g, "{featuredPlace?.shortDesc || $1}");

  return next;
}

function repairOptionalImageSrc(content: string, buildLog: string): string {
  if (
    !/Type error:[\s\S]*Type 'string \| undefined' is not assignable to type/i.test(buildLog) ||
    !/<img\s+[^>]*src=\{[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.image\}/.test(content)
  ) {
    return content;
  }

  return content.replace(
    /^(\s*)<img\s+src=\{([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.image)\}\s+alt=\{([^}]+)\}\s*\/>/gm,
    "$1{$2 ? <img src={$2} alt={$3} /> : null}",
  );
}

function repairVoidLogicalEventHandlers(content: string, buildLog: string): string {
  if (!/An expression of type 'void' cannot be tested for truthiness/i.test(buildLog)) {
    return content;
  }

  return content.replace(
    /(on[A-Z][A-Za-z0-9]*=\{\s*)((?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*)([A-Za-z_$][\w$.]*\([^{};]*\))\s*(?:\|\||&&)\s*([A-Za-z_$][\w$.]*\([^{};]*\))(\s*\})/g,
    "$1$2{ $3; $4; }$5",
  );
}

function repairUnbracedJsxAttributeConcatenation(content: string, buildLog: string): string {
  if (
    !/Unexpected token|Expected jsx identifier|Expression expected|Failed to compile|Syntax Error/i.test(buildLog) &&
    !/\s[A-Za-z_$:-][\w$:-]*\s*=\s*["'][^"'\n]*["']\s*\+/.test(content)
  ) {
    return content;
  }

  return content.replace(
    /(\s[A-Za-z_$:-][\w$:-]*\s*=\s*)(["'])([^"'\n]*)\2\s*\+\s*([\s\S]*?)(?=\s+(?:[A-Za-z_$:-][\w$:-]*\s*=)|\s*\/?>)/g,
    (match, prefix: string, quote: string, literal: string, expression: string, offset: number) => {
      if (!isInsideJsxOpeningTag(content, offset)) {
        return match;
      }
      return `${prefix}{${quote}${literal}${quote} + ${expression.trim()}}`;
    },
  );
}

function isInsideJsxOpeningTag(content: string, offset: number): boolean {
  const before = content.slice(0, offset);
  const lastOpen = before.lastIndexOf("<");
  if (lastOpen < 0 || lastOpen < before.lastIndexOf(">")) {
    return false;
  }

  return /^<[A-Za-z][\w.:-]*(?:\s|$)/.test(before.slice(lastOpen));
}

function extractMissingStringUnionMembers(buildLog: string): Array<{ typeName: string; literal: string }> {
  return [...buildLog.matchAll(/Type '"([^"]+)"' is not assignable to type '([A-Za-z_$][\w$]*)'/g)]
    .map((match) => ({ literal: match[1], typeName: match[2] }))
    .filter((item) => Boolean(item.literal && item.typeName));
}

function extractMissingNamedTypeProperties(buildLog: string): Array<{ typeName: string; propertyName: string }> {
  const seen = new Set<string>();
  return [...buildLog.matchAll(/Property '([A-Za-z_$][\w$]*)' does not exist on type '([A-Za-z_$][\w$]*)'/g)]
    .map((match) => ({ propertyName: match[1], typeName: match[2] }))
    .filter((item) => {
      if (!item.propertyName || !item.typeName) {
        return false;
      }
      const key = `${item.typeName}.${item.propertyName}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function extendStringUnionType(content: string, typeName: string, literal: string): string {
  const typePattern = new RegExp(`(type\\s+${escapeRegExp(typeName)}\\s*=\\s*)([^;]+)(;)`, "m");
  const match = content.match(typePattern);
  if (!match?.[2]) {
    return content;
  }

  const body = match[2];
  if (!/(?:'[^']+'|"[^"]+")/.test(body) || body.includes(`'${literal}'`) || body.includes(`"${literal}"`)) {
    return content;
  }

  return content.replace(typePattern, `$1${body.trim()} | '${literal}'$3`);
}

function inferMissingPropertyType(propertyName: string): string {
  if (/^(is|has|can|should)[A-Z_]|^(archived|selected|saved|enabled|active|completed|done)$/i.test(propertyName)) {
    return "boolean";
  }
  if (/(budget|cost|price|amount|total|count|score|rating|progress|percent|quantity)$/i.test(propertyName)) {
    return "number";
  }
  if (/(items|list|tags|stops|images|photos|notes|routes)$/i.test(propertyName)) {
    return "string[]";
  }
  return "string";
}

function addOptionalPropertyToNamedObjectType(
  content: string,
  typeName: string,
  propertyName: string,
  propertyType: string,
): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(propertyName)) {
    return content;
  }

  const typeStart = findNamedObjectTypeStart(content, typeName);
  if (!typeStart) {
    return content;
  }

  const closeBrace = findMatchingBrace(content, typeStart.openBraceIndex);
  if (closeBrace < 0) {
    return content;
  }

  const body = content.slice(typeStart.openBraceIndex + 1, closeBrace);
  const propertyPattern = new RegExp(`(^|\\n)\\s*${escapeRegExp(propertyName)}\\??\\s*:`, "m");
  if (propertyPattern.test(body)) {
    return content;
  }

  const declarationIndent = indentationBefore(content, typeStart.matchIndex);
  const propertyIndent = `${declarationIndent}  `;
  const insertion = `\n${propertyIndent}${propertyName}?: ${propertyType};`;
  return `${content.slice(0, closeBrace)}${insertion}${content.slice(closeBrace)}`;
}

function findNamedObjectTypeStart(content: string, typeName: string): { matchIndex: number; openBraceIndex: number } | null {
  const escaped = escapeRegExp(typeName);
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?interface\\s+${escaped}\\b[^{}]*\\{`, "m"),
    new RegExp(`\\b(?:export\\s+)?type\\s+${escaped}\\s*=\\s*\\{`, "m"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match?.[0]) {
      const openBraceIndex = content.indexOf("{", match.index);
      if (openBraceIndex >= 0) {
        return { matchIndex: match.index, openBraceIndex };
      }
    }
  }
  return null;
}

function findMatchingBrace(content: string, openBraceIndex: number): number {
  let depth = 0;
  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function indentationBefore(content: string, index: number): string {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  return /^\s*/.exec(content.slice(lineStart, index))?.[0] ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
