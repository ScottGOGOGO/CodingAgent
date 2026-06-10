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
  GenerationFailureKind,
  RunPhase,
  RunRecord,
  ToolCallTrace,
} from "@vide/contracts";

import { ContextManager } from "./context-manager.js";
import {
  ExpertRouter,
  buildCommercialRecordApp,
  createExperienceBlueprint,
  GenerationFailure,
  type ArchitecturePlanDraft,
  type CriticResult,
  type DesignBriefDraft,
  type DesignSeedDraft,
  type ExperienceBlueprint,
  type GeneratedApp,
} from "./expert-router.js";
import { normalizePackageJsonForImports, type PackageJsonShape } from "./package-dependencies.js";
import { SandboxWorkspace } from "./sandbox.js";
import {
  ObservableTaskStore,
  createDefaultToolRegistry,
  type McpToolAdapter,
  type PlanModeState,
  type SubAgentRunner,
  type TaskRecord,
  type TaskStore,
  type ToolExecutionContext,
  type ToolPolicy,
  type ToolRegistry,
  type WebToolAdapter,
} from "./tools.js";

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

function taskOwnerFromAgentType(agentType?: string): AgentTask["owner"] {
  if (agentType === "critic" || agentType === "repairer" || agentType === "coder" || agentType === "planner" || agentType === "architect") {
    return agentType;
  }
  if (agentType === "context_scout" || agentType === "design_director" || agentType === "design_seed_smith" || agentType === "runtime" || agentType === "clarifier") {
    return agentType;
  }
  return "runtime";
}

export interface QueryEngineHooks {
  onPhase?(phase: RunPhase): void;
  onToolTrace?(trace: ToolCallTrace): void;
  onTask?(task: AgentTask): void;
  onLog?(message: string): void;
}

export interface ToolRuntimeAdapters {
  subAgentRunner?: SubAgentRunner;
  webAdapter?: WebToolAdapter;
  mcpAdapter?: McpToolAdapter;
  taskStore?: TaskStore;
  planMode?: PlanModeState;
  policy?: ToolPolicy;
  capabilities?: ToolExecutionContext["capabilities"];
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
  /** Skip final candidate validation for preview-first local runs. Build and runtime prerequisites still run. */
  skipAcceptance?: boolean;
  /** Fail instead of replacing incomplete generations with generic/deterministic fallback candidates. */
  strictGeneration?: boolean;
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
    _previewer?: unknown,
    private readonly budgets: QueryEngineBudgets = DEFAULT_QUERY_ENGINE_BUDGETS,
    private readonly runtimeAdapters: ToolRuntimeAdapters = {},
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
    const syncToolTask = (record: TaskRecord) => {
      const existing = tasks.find((task) => task.id === record.id);
      const nextStatus: AgentTask["status"] = record.status;
      if (existing) {
        existing.title = record.title;
        existing.owner = taskOwnerFromAgentType(record.agentType);
        existing.status = nextStatus;
        existing.summary = record.outputSummary ?? existing.summary;
        existing.updatedAt = record.updatedAt;
        this.hooks.onTask?.(existing);
        return existing;
      }
      const task: AgentTask = {
        id: record.id,
        title: record.title,
        owner: taskOwnerFromAgentType(record.agentType),
        status: nextStatus,
        summary: record.outputSummary,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
      tasks.push(task);
      this.hooks.onTask?.(task);
      return task;
    };
    const toolTaskStore = new ObservableTaskStore(this.runtimeAdapters.taskStore, syncToolTask);
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

      const experienceTask = addTask("生成真实体验蓝图", "planner", "running");
      const experienceBlueprint = createExperienceBlueprint({
        message: effectiveMessage,
        clarificationText,
        designBrief,
      });
      updateTask(
        experienceTask,
        "completed",
        `${experienceBlueprint.domain}: ${experienceBlueprint.primaryFlow.action}; ${experienceBlueprint.contentSeed.length} 条内容种子`,
      );

      setPhase("design_seed");
      const designSeedTask = addTask("生成视觉身份种子", "design_seed_smith", "running");
      const designSeed = createDesignSeed(input.runId, await this.experts.createDesignSeed({
        message: effectiveMessage,
        clarificationText,
        context,
        designBrief,
      }));
      run.designSeed = designSeed;
      const seededAssetPaths = await this.writeDesignSeedAssets(input.runId, sandbox, designSeed, toolCalls, toolTaskStore);
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
        experienceBlueprint,
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
          experienceBlueprint,
          designSeed,
          preloadedAssetPaths: seededAssetPaths,
          message: effectiveMessage,
          clarificationText,
          maxTurns: this.budgets.maxTurns,
          maxToolCallsPerTurn: this.budgets.maxToolCallsPerTurn,
          maxToolCallsTotal: this.budgets.maxToolCallsTotal,
          modelTurnTimeoutMs: this.budgets.modelTurnTimeoutMs,
          runtime: this.buildToolRuntime(toolTaskStore),
          emitTrace: (trace) => recordToolTrace(toolCalls, trace, this.hooks),
          emitLog: (message) => this.hooks.onLog?.(message),
          onProgress: (message) => this.hooks.onLog?.(`coder-loop: ${message}`),
        });
        app = loopOutcome.app;
        // The agent loop writes via tools during execution, but when it fell back to
        // single-shot, the files only live in memory. writeGeneratedApp is idempotent
        // for already-written files and ensures the sandbox always matches `app`.
        await this.writeGeneratedApp(input.runId, sandbox, app, toolCalls, toolTaskStore);
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
          experienceBlueprint,
        });
        await this.writeGeneratedApp(input.runId, sandbox, app, toolCalls, toolTaskStore);
        updateTask(coderTask, "completed", app.summary);
      }

      if (this.budgets.skipAcceptance) {
        setPhase("sandbox_verify");
        const previewVerifyTask = addTask("预览前构建与数据库验证", "critic", "running");
        const previewSafetyResult = await this.verifyBuildWithSafetyRepairs(input.runId, sandbox, app, toolCalls, toolTaskStore);
        app = previewSafetyResult.app;
        updateTask(
          previewVerifyTask,
          previewSafetyResult.buildPassed ? "completed" : "failed",
          previewSafetyResult.buildPassed ? "Build and Prisma sandbox preparation passed." : previewSafetyResult.buildLog,
        );
        if (!previewSafetyResult.buildPassed) {
          throw new Error(previewSafetyResult.buildLog || "Preview preflight build failed.");
        }
        const candidate = await this.createAcceptanceSkippedCandidate({
          input,
          sandbox,
          app,
          toolCalls,
          buildLog: previewSafetyResult.buildLog,
        });
        await this.tools.execute("submit_candidate", {}, this.toolContext(input.runId, sandbox, toolCalls, toolTaskStore));
        setPhase("approval");
        run.status = "awaiting_approval";
        run.candidate = candidate;
        run.updatedAt = now();
        messages.push(assistant(`${app.title} 的候选版本已生成。当前已通过预览前构建与数据库检查，并暂停最终候选验收，可先在预览里查看效果。`));
        return { run, messages, candidate, designBrief, designSeed, architecturePlan, contextSummary: context.summary };
      }

      setPhase("sandbox_verify");
      const verifyTask = addTask("沙箱构建验证", "critic", "running");
      let safetyResult = await this.verifyBuildWithSafetyRepairs(input.runId, sandbox, app, toolCalls, toolTaskStore);
      app = safetyResult.app;
      let { buildPassed, buildLog } = safetyResult;

      let critique = await this.experts.critique({ app, buildPassed, buildLog });
      let reviewSummary = critique.summary;
      const previousRepairIssues: string[] = [];
      let usedCommercialRecordFallback = false;

      for (let repairAttempt = 0; repairAttempt <= MAX_CANDIDATE_REPAIR_ATTEMPTS; repairAttempt += 1) {
        updateTask(verifyTask, critique.passed ? "completed" : "failed", critique.summary);
        reviewSummary = critique.summary;

        if (critique.passed) {
          break;
        }

        const fallbackReason = this.budgets.strictGeneration || usedCommercialRecordFallback
          ? undefined
          : shouldUseCommercialRecordFallback({
              message: effectiveMessage,
              clarificationText,
              reviewSummary,
              critique,
              previousRepairIssues,
            });
        if (fallbackReason) {
          setPhase("repair");
          const fallbackTask = addTask("切换稳定商业记录体验", "repairer", "running", fallbackReason);
          usedCommercialRecordFallback = true;
          app = buildCommercialRecordApp(`${effectiveMessage}\n${clarificationText}`);
          await this.writeGeneratedApp(input.runId, sandbox, app, toolCalls, toolTaskStore);

          setPhase("sandbox_verify");
          safetyResult = await this.verifyBuildWithSafetyRepairs(input.runId, sandbox, app, toolCalls, toolTaskStore);
          app = safetyResult.app;
          ({ buildPassed, buildLog } = safetyResult);
          critique = await this.experts.critique({ app, buildPassed, buildLog });
          reviewSummary = critique.summary;
          updateTask(fallbackTask, critique.passed ? "completed" : "failed", critique.summary);
          if (critique.passed) {
            break;
          }
        }

        if (repairAttempt >= MAX_CANDIDATE_REPAIR_ATTEMPTS) {
          const finalFallbackReason = this.budgets.strictGeneration || usedCommercialRecordFallback
            ? undefined
            : shouldUseCommercialRecordFallback({
                message: effectiveMessage,
                clarificationText,
                reviewSummary,
                critique,
                previousRepairIssues,
              });
          if (finalFallbackReason) {
            setPhase("repair");
            const fallbackTask = addTask("切换稳定商业记录体验", "repairer", "running", finalFallbackReason);
            usedCommercialRecordFallback = true;
            app = buildCommercialRecordApp(`${effectiveMessage}\n${clarificationText}`);
            await this.writeGeneratedApp(input.runId, sandbox, app, toolCalls, toolTaskStore);

            setPhase("sandbox_verify");
            safetyResult = await this.verifyBuildWithSafetyRepairs(input.runId, sandbox, app, toolCalls, toolTaskStore);
            app = safetyResult.app;
            ({ buildPassed, buildLog } = safetyResult);
            critique = await this.experts.critique({ app, buildPassed, buildLog });
            reviewSummary = critique.summary;
            updateTask(fallbackTask, critique.passed ? "completed" : "failed", critique.summary);
            if (critique.passed) {
              break;
            }
          }
          throw new Error(reviewSummary);
        }

        setPhase("repair");
        const repairIssues = mergeIssues(critique);
        previousRepairIssues.push(...repairIssues);
        const repairTask = addTask(
          "修复候选体验",
          "repairer",
          "running",
          [`第 ${repairAttempt + 1} 次自动修复`, ...repairIssues].join("\n"),
        );
        try {
          app = await this.experts.repairApp({
            app,
            issues: previousRepairIssues,
            buildLog,
            message: effectiveMessage,
            clarificationText,
            context,
            designBrief,
            experienceBlueprint,
          });
        } catch (error) {
          if (
            error instanceof GenerationFailure &&
            this.budgets.strictGeneration &&
            error.kind === "generation_incomplete" &&
            repairAttempt < MAX_CANDIDATE_REPAIR_ATTEMPTS
          ) {
            const message = error.message || "strict repair did not return usable files";
            previousRepairIssues.push(`Previous strict repair attempt failed: ${message}`);
            reviewSummary = message;
            updateTask(repairTask, "failed", message);
            continue;
          }
          throw error;
        }
        await this.writeGeneratedApp(input.runId, sandbox, app, toolCalls, toolTaskStore);

        setPhase("sandbox_verify");
        safetyResult = await this.verifyBuildWithSafetyRepairs(input.runId, sandbox, app, toolCalls, toolTaskStore);
        app = safetyResult.app;
        ({ buildPassed, buildLog } = safetyResult);
        critique = await this.experts.critique({ app, buildPassed, buildLog });
        reviewSummary = critique.summary;
        updateTask(repairTask, critique.passed ? "completed" : "failed", critique.summary);
        if (critique.passed) {
          break;
        }
      }

      if (!critique.passed) {
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
          command: "npm install && npm run build",
          summary: critique.summary,
          logTail: buildLog.slice(-1200) || undefined,
        },
        sandboxPath: sandbox.sandboxRoot,
        artifactIds: [],
        createdAt: now(),
      };

      await this.tools.execute("submit_candidate", {}, this.toolContext(input.runId, sandbox, toolCalls, toolTaskStore));
      setPhase("approval");
      run.status = "awaiting_approval";
      run.candidate = candidate;
      run.updatedAt = now();
      messages.push(assistant(`${app.title} 的候选版本已按设计 brief 生成，并通过工程构建验证，等待审批发布。`));
      return { run, messages, candidate, designBrief, designSeed, architecturePlan, contextSummary: context.summary };
    } catch (error) {
      const failureKind = classifyGenerationFailure(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      for (const task of tasks.filter((task) => task.status === "running")) {
        updateTask(task, "failed", errorMessage);
      }
      run.status = "failed";
      run.phase = "report";
      run.error = errorMessage;
      run.failureKind = failureKind;
      run.updatedAt = now();
      messages.push(assistant(`生成失败：${run.error}`));
      return { run, messages };
    }
  }

  private buildToolRuntime(taskStore?: TaskStore) {
    return {
      taskStore,
      subAgentRunner: this.runtimeAdapters.subAgentRunner,
      webAdapter: this.runtimeAdapters.webAdapter,
      mcpAdapter: this.runtimeAdapters.mcpAdapter,
      planMode: this.runtimeAdapters.planMode,
      policy: this.runtimeAdapters.policy,
      capabilities: this.runtimeAdapters.capabilities,
    };
  }

  private toolContext(
    runId: string,
    workspace: SandboxWorkspace,
    traces: ToolCallTrace[],
    taskStore?: TaskStore,
  ): ToolExecutionContext {
    return {
      runId,
      workspace,
      registry: this.tools,
      ...this.buildToolRuntime(taskStore),
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
    taskStore?: TaskStore,
  ): Promise<{ buildPassed: boolean; buildLog: string }> {
    const context = this.toolContext(runId, sandbox, toolCalls, taskStore);
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
    taskStore?: TaskStore,
  ): Promise<{ app: GeneratedApp; buildPassed: boolean; buildLog: string }> {
    let currentApp = app;
    let result = await this.verifyBuild(runId, sandbox, toolCalls, taskStore);
    for (let attempt = 0; attempt < 4 && !result.buildPassed; attempt += 1) {
      const repair = applyBuildSafetyRepair(currentApp, result.buildLog);
      if (!repair.changed) {
        break;
      }
      currentApp = repair.app;
      await this.writeGeneratedApp(runId, sandbox, currentApp, toolCalls, taskStore);
      result = await this.verifyBuild(runId, sandbox, toolCalls, taskStore);
    }
    return { app: currentApp, ...result };
  }

  private async writeGeneratedApp(
    runId: string,
    workspace: SandboxWorkspace,
    app: GeneratedApp,
    traces: ToolCallTrace[],
    taskStore?: TaskStore,
  ): Promise<void> {
    const nextPaths = new Set(app.files.map((file) => file.path));
    const previousPaths = this.generatedAppPathsByRun.get(runId) ?? new Set<string>();
    for (const path of previousPaths) {
      if (!nextPaths.has(path)) {
        await workspace.deleteFile(path);
      }
    }

    for (const file of app.files) {
      await this.tools.execute("write_file", { path: file.path, content: file.content }, this.toolContext(runId, workspace, traces, taskStore));
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
    taskStore?: TaskStore,
  ): Promise<string[]> {
    const writtenPaths: string[] = [];
    for (const asset of seed.assets) {
      try {
        await this.tools.execute(
          "write_file",
          { path: asset.filename, content: asset.content },
          this.toolContext(runId, workspace, traces, taskStore),
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

  private async createAcceptanceSkippedCandidate(args: {
    input: QueryEngineInput;
    sandbox: SandboxWorkspace;
    app: GeneratedApp;
    toolCalls: ToolCallTrace[];
    buildLog: string;
  }): Promise<CandidateChangeSet> {
    const diff = await args.sandbox.diffAgainstProject();
  const buildTrace = [...args.toolCalls].reverse().find((trace) => trace.toolName === "run_command" && /npm run build|next build/.test(trace.inputSummary ?? ""));
  const warnings = [
      "已按本地调试要求暂停最终候选验收；构建与数据库预检仍会执行。",
      buildTrace?.status === "failed" ? `最近一次构建命令仍失败：${buildTrace.error ?? buildTrace.outputSummary ?? "unknown error"}` : "",
    ].filter(Boolean);

    return {
      id: randomUUID(),
      runId: args.input.runId,
      baseVersion: args.input.baseVersion,
      changedFiles: diff.changedFiles,
      diffSummary: diff.summary,
      validation: {
        status: "pending",
        command: "npm install && prisma db push && npm run build",
        summary: `${args.app.summary} 已生成并通过预览前构建与数据库检查；最终候选验收已暂停，先展示候选效果。`,
        warnings,
        logTail: args.buildLog.slice(-1200) || buildTrace?.error,
      },
      sandboxPath: args.sandbox.sandboxRoot,
      artifactIds: [],
      createdAt: now(),
    };
  }
}

function classifyGenerationFailure(error: unknown): GenerationFailureKind {
  if (error instanceof GenerationFailure) {
    return error.kind;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/模型调用失败|model.*(?:request|tool-use).*failed|api key|401|403|429|timeout|timed out|AbortError|ECONN|ENOTFOUND|fetch failed/i.test(message)) {
    return "model_call_failed";
  }
  if (/npm run build|next build|构建失败|build failed|failed to compile|typescript|module not found|can't resolve/i.test(message)) {
    return "build_failed";
  }
  if (/preview|health|server did not become healthy|returned 500/i.test(message)) {
    return "preview_failed";
  }
  return "generation_incomplete";
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

function mergeIssues(critique: CriticResult): string[] {
  return [
    ...critique.issues,
  ].filter(Boolean);
}

function shouldUseCommercialRecordFallback(args: {
  message: string;
  clarificationText: string;
  reviewSummary: string;
  critique: CriticResult;
  previousRepairIssues: string[];
}): string | undefined {
  const briefText = [args.message, args.clarificationText].filter(Boolean).join("\n");
  if (!isCommercialRecordFallbackBrief(briefText)) {
    return undefined;
  }

  const failureText = [
    args.reviewSummary,
    args.critique.summary,
    ...args.critique.issues,
    ...args.previousRepairIssues,
  ]
    .filter(Boolean)
    .join("\n");

  const hasRepeatedProductSurfaceFailure =
    /Route checks:[\s\S]*(?:controls=0|text=0)|controls=0|页面深度不足|组件系统不足|页面文案暴露内部实现|生成流程|内部实现|空路由|empty route|miss(?:ing|es|ed).*?(?:route|surface|screen|page)|incomplete.*?(?:product|app|flow|experience)|缺(?:少|失).*?(?:页面|视图|筛选|历史|详情|交互|时间线|统计|设置)|not meet|不符合|generic|通用/i.test(failureText);
  const hasBlockingLoadingFailure =
    /loading|加载|spinner|spinning|首屏.*空白|空白|blank|stuck|卡住|只显示|skeleton|🍚/i.test(failureText);
  const hasInteractionFailure =
    /interaction model|交互模型|filter|筛选|date|日期|history|历史|edit|编辑|delete|删除|save|保存|focus|聚焦|grouped|分组|long press|长按/i.test(failureText) &&
    /missing|misses|lacks?|incomplete|缺少|缺失|没有|不足|不完整|failed|失败/i.test(failureText);

  if (!hasRepeatedProductSurfaceFailure && !hasBlockingLoadingFailure && !hasInteractionFailure) {
    return undefined;
  }

  return "模型修复已多次落入空页面、加载阻塞或交互模型缺失；切换到带今日输入、历史筛选、详情编辑、统计和设置的稳定商业记录体验。";
}

function isCommercialRecordFallbackBrief(brief: string): boolean {
  const hasRestaurantDomain =
    /restaurant|dining|dish|cuisine|meal|food|bistro|餐厅|餐馆|饭店|用餐|菜品|菜系|美食|食记|食评|吃饭|晚餐|午餐|早餐/i.test(brief);
  const hasMediaDomain =
    /media|library|book|film|movie|podcast|archive|媒体|图书|书籍|电影|影片|播客|观影|片库|书库|馆藏|书影音/i.test(brief);
  const hasHabitDomain =
    /habit|mood|routine|check-?in|morning|bedtime|习惯|心情|情绪|晨间|夜间|睡前|作息|节律/i.test(brief);
  const hasPersonalJournalDomain = /diary|journal|手帐|日记/i.test(brief);
  const hasLearningOrSportsDomain =
    /学习|课程|训练|练习|教练|动作|发球|正手|反手|步伐|网球|篮球|足球|羽毛球|乒乓|健身|运动|考试|备考|错题|learn|course|study|training|practice|coach|tennis|workout|sport/i.test(brief);

  if (hasLearningOrSportsDomain && !hasRestaurantDomain && !hasMediaDomain && !hasHabitDomain) {
    return false;
  }

  return hasRestaurantDomain || hasMediaDomain || hasHabitDomain || hasPersonalJournalDomain;
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
    content = repairDuplicateImportedIdentifier(content, buildLog, file.path);
    content = repairInvalidLucideIconExport(content, buildLog);
    content = repairTripPlaceReferenceAccess(content, buildLog);
    content = repairOptionalImageSrc(content, buildLog);
    content = repairInvalidOptionalEnvComparison(content);
    content = repairDateStringTypeForPrismaDate(content, buildLog);
    content = repairImplicitAnyParameter(content, buildLog);
    content = repairVoidLogicalEventHandlers(content, buildLog);
    content = repairBooleanCallableFavoriteContext(content, buildLog);
    content = repairNullableJsxPropUndefined(content, buildLog);
    content = repairStringIdObjectMapAccess(content, buildLog);
    content = repairWeatherModeArrayArgument(content, buildLog, file.path);
    content = repairUndefinedNamedReExport(content, buildLog, file.path);
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

  const missingLocalTypeImportRepair = repairMissingLocalTypeImports(files, buildLog);
  if (missingLocalTypeImportRepair.changed) {
    files = missingLocalTypeImportRepair.files;
    changed = true;
  }

  const localTypeDefinitionRepair = repairConflictingLocalTypeDefinitions(files, buildLog);
  if (localTypeDefinitionRepair.changed) {
    files = localTypeDefinitionRepair.files;
    changed = true;
  }

  const missingObjectLiteralPropertyRepair = repairMissingRequiredObjectLiteralProperties(files, buildLog);
  if (missingObjectLiteralPropertyRepair.changed) {
    files = missingObjectLiteralPropertyRepair.files;
    changed = true;
  }

  const excessObjectLiteralPropertyRepair = repairExcessObjectLiteralProperties(files, buildLog);
  if (excessObjectLiteralPropertyRepair.changed) {
    files = excessObjectLiteralPropertyRepair.files;
    changed = true;
  }

  const missingLookupExportRepair = repairMissingLocalLookupExports(files, buildLog);
  if (missingLookupExportRepair.changed) {
    files = missingLookupExportRepair.files;
    changed = true;
  }

  const missingArrayAliasExportRepair = repairMissingLocalArrayAliasExports(files, buildLog);
  if (missingArrayAliasExportRepair.changed) {
    files = missingArrayAliasExportRepair.files;
    changed = true;
  }

  const missingLocalTypeExportRepair = repairMissingLocalTypeExports(files, buildLog);
  if (missingLocalTypeExportRepair.changed) {
    files = missingLocalTypeExportRepair.files;
    changed = true;
  }

  const timestampStringRepair = repairNumberTimestampAssignedToString(files, buildLog);
  if (timestampStringRepair.changed) {
    files = timestampStringRepair.files;
    changed = true;
  }

  const localExportRepair = repairLocallyDeclaredModuleExports(files, buildLog);
  if (localExportRepair.changed) {
    files = localExportRepair.files;
    changed = true;
  }

  const dateGroupingGenericRepair = repairDateGroupingGenericInference(files, buildLog);
  if (dateGroupingGenericRepair.changed) {
    files = dateGroupingGenericRepair.files;
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

  const duplicateKeyRepair = repairDuplicateObjectLiteralKeys(files, buildLog);
  if (duplicateKeyRepair.changed) {
    files = duplicateKeyRepair.files;
    changed = true;
  }

  const optionalCatchAllRepair = repairRootOptionalCatchAllConflict(files, buildLog);
  if (optionalCatchAllRepair.changed) {
    files = optionalCatchAllRepair.files;
    changed = true;
  }

  const contextualStringUnionRepair = repairContextualStringUnionTypes(files, buildLog);
  if (contextualStringUnionRepair.changed) {
    files = contextualStringUnionRepair.files;
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

function repairLocallyDeclaredModuleExports(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const missingExports = extractLocallyDeclaredMissingExports(buildLog);
  if (!missingExports.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = files.map((file) => {
    const symbols = missingExports
      .filter((item) => candidatePathsForMissingLocalExport(item).includes(file.path))
      .map((item) => item.symbolName);

    if (!symbols.length || !/\.(?:tsx|ts|jsx|js)$/i.test(file.path)) {
      return file;
    }

    let content = file.content;
    for (const symbolName of symbols) {
      content = exportLocalDeclaration(content, symbolName);
    }

    if (content !== file.content) {
      changed = true;
      return { ...file, content };
    }
    return file;
  });

  return { files: nextFiles, changed };
}

function repairMissingLocalLookupExports(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const missingExports = extractMissingLocalModuleExports(buildLog)
    .filter((item) => isRepairableGeneratedLookupName(item.symbolName));
  if (!missingExports.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = [...files];
  for (const item of missingExports) {
    const targetIndex = findFileIndexForCandidates(nextFiles, candidatePathsForMissingLocalExport(item));
    if (targetIndex < 0) {
      continue;
    }

    const target = nextFiles[targetIndex]!;
    if (!/\.(?:ts|tsx|js|jsx)$/i.test(target.path) || hasExportedBinding(target.content, item.symbolName)) {
      continue;
    }

    const arrayNames = collectTopLevelArrayNames(target.content);
    if (!arrayNames.length) {
      continue;
    }

    nextFiles[targetIndex] = {
      ...target,
      content: appendLookupExportFunction(target.content, item.symbolName, arrayNames),
    };
    changed = true;
  }

  return { files: nextFiles, changed };
}

function repairMissingLocalArrayAliasExports(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const missingExports = extractMissingLocalModuleExports(buildLog)
    .filter((item) => isRepairableGeneratedArrayAliasName(item.symbolName));
  if (!missingExports.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = [...files];
  for (const item of missingExports) {
    const targetIndex = findFileIndexForCandidates(nextFiles, candidatePathsForMissingLocalExport(item));
    if (targetIndex < 0) {
      continue;
    }

    const target = nextFiles[targetIndex]!;
    if (!/\.(?:ts|tsx|js|jsx)$/i.test(target.path) || hasExportedBinding(target.content, item.symbolName)) {
      continue;
    }

    const arrayNames = collectTopLevelArrayNames(target.content);
    const sourceName = chooseArrayAliasSource(item.symbolName, arrayNames);
    if (!sourceName) {
      continue;
    }

    nextFiles[targetIndex] = {
      ...target,
      content: `${target.content.trimEnd()}\n\nexport const ${item.symbolName} = ${sourceName};\n`,
    };
    changed = true;
  }

  return { files: nextFiles, changed };
}

function repairMissingLocalTypeExports(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const missingExports = extractMissingLocalModuleExports(buildLog)
    .filter((item) => isRepairableGeneratedTypeName(item.symbolName));
  if (!missingExports.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = [...files];
  for (const item of missingExports) {
    const targetIndex = findFileIndexForCandidates(nextFiles, candidatePathsForMissingLocalExport(item));
    if (targetIndex < 0) {
      continue;
    }

    const target = nextFiles[targetIndex]!;
    if (!/\.(?:ts|tsx)$/i.test(target.path) || hasExportedBinding(target.content, item.symbolName)) {
      continue;
    }

    const typeSource = generatedTypeExportSource(item.symbolName, target.content);
    if (!typeSource) {
      continue;
    }

    nextFiles[targetIndex] = {
      ...target,
      content: `${target.content.trimEnd()}\n\n${typeSource}\n`,
    };
    changed = true;
  }

  return { files: nextFiles, changed };
}

interface MissingLocalExport {
  moduleSpecifier: string;
  symbolName: string;
  importerPath?: string;
}

function extractMissingLocalModuleExports(buildLog: string): MissingLocalExport[] {
  const seen = new Set<string>();
  const items: MissingLocalExport[] = [];
  for (const match of buildLog.matchAll(
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):[\s\S]{0,600}?Module\s+'"?([^'"]+)"?'\s+has\s+no\s+exported\s+member\s+'?([A-Za-z_$][\w$]*)'?/g,
  )) {
    const importerPath = match[1]?.trim();
    const moduleSpecifier = match[2]?.trim();
    const symbolName = match[3]?.trim();
    if (!moduleSpecifier || !symbolName || !isLocalModuleSpecifier(moduleSpecifier)) {
      continue;
    }
    const key = `${importerPath ?? ""}:${moduleSpecifier}:${symbolName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ moduleSpecifier, symbolName, importerPath });
  }
  for (const match of buildLog.matchAll(
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):[\s\S]{0,600}?Type error:\s+['"]*([^'"\n]+)['"]*\s+has\s+no\s+exported\s+member\s+named\s+'?([A-Za-z_$][\w$]*)'?/g,
  )) {
    const importerPath = match[1]?.trim();
    const moduleSpecifier = match[2]?.trim();
    const symbolName = match[3]?.trim();
    if (!moduleSpecifier || !symbolName || !isLocalModuleSpecifier(moduleSpecifier)) {
      continue;
    }
    const key = `${importerPath ?? ""}:${moduleSpecifier}:${symbolName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ moduleSpecifier, symbolName, importerPath });
  }
  for (const match of buildLog.matchAll(
    /Module\s+'"?([^'"]+)"?'\s+has\s+no\s+exported\s+member\s+'?([A-Za-z_$][\w$]*)'?/g,
  )) {
    const moduleSpecifier = match[1]?.trim();
    const symbolName = match[2]?.trim();
    if (!moduleSpecifier || !symbolName || !isLocalModuleSpecifier(moduleSpecifier)) {
      continue;
    }
    const key = `:${moduleSpecifier}:${symbolName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ moduleSpecifier, symbolName });
  }
  for (const match of buildLog.matchAll(
    /Type error:\s+['"]*([^'"\n]+)['"]*\s+has\s+no\s+exported\s+member\s+named\s+'?([A-Za-z_$][\w$]*)'?/g,
  )) {
    const moduleSpecifier = match[1]?.trim();
    const symbolName = match[2]?.trim();
    if (!moduleSpecifier || !symbolName || !isLocalModuleSpecifier(moduleSpecifier)) {
      continue;
    }
    const key = `:${moduleSpecifier}:${symbolName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ moduleSpecifier, symbolName });
  }
  return items;
}

function candidatePathsForMissingLocalExport(item: MissingLocalExport): string[] {
  if (item.importerPath) {
    return candidatePathsForImportSpecifier(item.moduleSpecifier, item.importerPath);
  }
  return candidatePathsForModuleSpecifier(item.moduleSpecifier);
}

function isLocalModuleSpecifier(moduleSpecifier: string): boolean {
  return moduleSpecifier.startsWith("@/") || moduleSpecifier.startsWith("src/") || moduleSpecifier.startsWith(".");
}

function isRepairableGeneratedLookupName(symbolName: string): boolean {
  return /^(?:find|get)[A-Z][A-Za-z0-9_]*By(?:Id|Ids|Type|Category|Kind|Day)$/.test(symbolName) || /^getAll[A-Z][A-Za-z0-9_]*$/.test(symbolName);
}

function isRepairableGeneratedArrayAliasName(symbolName: string): boolean {
  return /(?:days|places|items|entries|records|routes|plans|itineraries|locations|destinations)$/i.test(symbolName);
}

function chooseArrayAliasSource(symbolName: string, arrayNames: string[]): string | undefined {
  if (!arrayNames.length) {
    return undefined;
  }
  const normalizedSymbol = symbolName.toLowerCase();
  const exact = arrayNames.find((name) => name.toLowerCase() === normalizedSymbol);
  if (exact) {
    return exact;
  }

  const aliasGroups: Array<{ pattern: RegExp; candidates: RegExp[] }> = [
    { pattern: /days|itineraries|plans|routes/i, candidates: [/days/i, /itinerar/i, /plans/i, /routes/i] },
    { pattern: /places|locations|destinations/i, candidates: [/places/i, /locations/i, /destinations/i] },
    { pattern: /items|entries|records/i, candidates: [/items/i, /entries/i, /records/i] },
  ];
  const group = aliasGroups.find((item) => item.pattern.test(symbolName));
  if (group) {
    const match = arrayNames.find((name) => group.candidates.some((candidate) => candidate.test(name)));
    if (match) {
      return match;
    }
  }

  return arrayNames[0];
}

function isRepairableGeneratedTypeName(symbolName: string): boolean {
  return /^(?:Favorite|FavoriteItem|FavoriteEntry|FavoriteRecord|Budget|BudgetItem|BudgetEntry|CostItem|Location|Place|Destination|Stop|Activity|Trip|TripDay|Itinerary|ItineraryItem|RouteItem|DayPlan|DomainItem)$/.test(symbolName);
}

function generatedTypeExportSource(symbolName: string, moduleContent: string): string | undefined {
  if (/^Favorite(?:Item|Entry|Record)?$/.test(symbolName)) {
    return [
      `export interface ${symbolName} {`,
      "  id?: string;",
      "  locationId: string;",
      "  isMustGo?: boolean;",
      "  mustVisit?: boolean;",
      "  addedAt?: string;",
      "  [key: string]: unknown;",
      "}",
    ].join("\n");
  }

  if (/^(?:Budget|BudgetItem|BudgetEntry|CostItem)$/.test(symbolName)) {
    return [
      `export interface ${symbolName} {`,
      "  id: string;",
      "  category?: string;",
      "  name: string;",
      "  amount?: number;",
      "  price?: number;",
      "  quantity?: number;",
      "  note?: string;",
      "  [key: string]: unknown;",
      "}",
    ].join("\n");
  }

  if (/^(?:Location|Place|Destination|Stop|Activity)$/.test(symbolName)) {
    const categoryType = /export\s+type\s+LocationCategory\b/.test(moduleContent) ? "LocationCategory" : "string";
    return [
      `export interface ${symbolName} {`,
      "  id: string;",
      "  name: string;",
      `  category?: ${categoryType};`,
      "  description?: string;",
      "  imageUrl?: string;",
      "  image?: string;",
      "  openingHours?: string;",
      "  duration?: string;",
      "  costPerPerson?: number;",
      "  address?: string;",
      "  tips?: string;",
      "  [key: string]: unknown;",
      "}",
    ].join("\n");
  }

  return [
    `export interface ${symbolName} {`,
    "  id: string;",
    "  name?: string;",
    "  title?: string;",
    "  [key: string]: unknown;",
    "}",
  ].join("\n");
}

function hasExportedBinding(content: string, symbolName: string): boolean {
  const escaped = escapeRegExp(symbolName);
  return new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var|class|type|interface|enum)\\s+${escaped}\\b`).test(content);
}

function collectTopLevelArrayNames(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(
    /(?:^|\n)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\[/g,
  )) {
    const name = match[1];
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function appendLookupExportFunction(content: string, symbolName: string, arrayNames: string[]): string {
  const helperSource = content.includes("collectGeneratedLookupRecords")
    ? ""
    : [
        "",
        "function collectGeneratedLookupRecords(value: unknown): any[] {",
        "  if (!Array.isArray(value)) return [];",
        "  const records: any[] = [];",
        "  for (const item of value) {",
        "    if (!item || typeof item !== 'object') continue;",
        "    records.push(item);",
        "    const record = item as Record<string, unknown>;",
        "    for (const key of ['locations', 'places', 'items', 'activities', 'stops', 'schedule', 'alternatives']) {",
        "      records.push(...collectGeneratedLookupRecords(record[key]));",
        "    }",
        "  }",
        "  return records;",
        "}",
      ].join("\n");
  const pools = arrayNames.map((name) => `...collectGeneratedLookupRecords(${name})`).join(", ");
  const functionSource = generatedLookupFunctionSource(symbolName, pools);
  return `${content.trimEnd()}${helperSource}\n${functionSource}\n`;
}

function generatedLookupFunctionSource(symbolName: string, pools: string): string {
  const recordsLine = `  const records = [${pools}];`;
  if (/^getAll[A-Z]/.test(symbolName)) {
    return [
      "",
      `export function ${symbolName}(): any[] {`,
      recordsLine,
      "  return records;",
      "}",
    ].join("\n");
  }
  if (/ByIds$/.test(symbolName)) {
    return [
      "",
      `export function ${symbolName}(ids: string[]): any[] {`,
      recordsLine,
      "  const wanted = new Set(ids.map((id) => String(id)));",
      "  return records.filter((item) => wanted.has(String(item?.id ?? '')));",
      "}",
    ].join("\n");
  }
  if (/ByDay$/.test(symbolName)) {
    return [
      "",
      `export function ${symbolName}(dayId: string | number): any[] {`,
      recordsLine,
      "  const wanted = String(dayId);",
      "  const dayRecords = records.filter((item) => String(item?.dayId ?? item?.day ?? item?.dayNumber ?? item?.id ?? '') === wanted);",
      "  const nested = dayRecords.flatMap((item) => [",
      "    ...collectGeneratedLookupRecords(item?.places),",
      "    ...collectGeneratedLookupRecords(item?.locations),",
      "    ...collectGeneratedLookupRecords(item?.activities),",
      "    ...collectGeneratedLookupRecords(item?.stops),",
      "    ...collectGeneratedLookupRecords(item?.schedule),",
      "    ...collectGeneratedLookupRecords(item?.items),",
      "  ]);",
      "  if (nested.length) return nested;",
      "  return records.filter((item) => String(item?.dayId ?? item?.day ?? item?.dayNumber ?? '') === wanted);",
      "}",
    ].join("\n");
  }
  if (/By(?:Type|Category|Kind)$/.test(symbolName)) {
    const property = symbolName.endsWith("ByCategory") ? "category" : symbolName.endsWith("ByKind") ? "kind" : "type";
    return [
      "",
      `export function ${symbolName}(${property}: string): any[] {`,
      recordsLine,
      `  return records.filter((item) => String(item?.${property} ?? item?.category ?? item?.kind ?? '') === String(${property}));`,
      "}",
    ].join("\n");
  }
  return [
    "",
    `export function ${symbolName}(id: string): any {`,
    recordsLine,
    "  return records.find((item) => String(item?.id ?? '') === String(id)) ?? null;",
    "}",
  ].join("\n");
}

function repairNumberTimestampAssignedToString(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const errors = extractNumberAssignedToStringErrors(buildLog);
  if (!errors.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = files.map((file) => {
    const errorsForFile = errors.filter((error) => error.path === file.path);
    if (!errorsForFile.length || !/\.(?:tsx|ts|jsx|js)$/i.test(file.path)) {
      return file;
    }

    let content = file.content;
    for (const error of errorsForFile) {
      content = replaceDateNowOnLine(content, error.line);
    }
    if (content === file.content) {
      return file;
    }
    changed = true;
    return { ...file, content };
  });

  return { files: nextFiles, changed };
}

function extractNumberAssignedToStringErrors(buildLog: string): Array<{ path: string; line: number }> {
  const seen = new Set<string>();
  const items: Array<{ path: string; line: number }> = [];
  for (const match of buildLog.matchAll(
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):(\d+):\d+\s*\nType error:\s*Type 'number' is not assignable to type 'string'\./g,
  )) {
    const path = match[1]?.trim();
    const line = Number(match[2]);
    if (!path || !Number.isFinite(line) || line < 1) {
      continue;
    }
    const key = `${path}:${line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ path, line });
  }
  return items;
}

function replaceDateNowOnLine(content: string, oneBasedLine: number): string {
  const lineCount = content.split("\n").length;
  for (let line = Math.max(1, oneBasedLine - 10); line <= Math.min(lineCount, oneBasedLine + 10); line += 1) {
    const replaced = replaceDateNowOnExactLine(content, line);
    if (replaced !== content) {
      return replaced;
    }
  }
  return content.replace(
    /\b(addedAt|createdAt|updatedAt|timestamp|time|date)(\s*:\s*)Date\.now\(\)/gi,
    "$1$2new Date().toISOString()",
  );
}

function replaceDateNowOnExactLine(content: string, oneBasedLine: number): string {
  const lineStart = offsetForLine(content, oneBasedLine);
  if (lineStart < 0) {
    return content;
  }
  const lineEnd = content.indexOf("\n", lineStart);
  const effectiveLineEnd = lineEnd >= 0 ? lineEnd : content.length;
  const line = content.slice(lineStart, effectiveLineEnd);
  if (!/\b(?:addedAt|createdAt|updatedAt|timestamp|time|date)\b/i.test(line) || !/\bDate\.now\(\)/.test(line)) {
    return content;
  }
  const nextLine = line.replace(/\bDate\.now\(\)/g, "new Date().toISOString()");
  return `${content.slice(0, lineStart)}${nextLine}${content.slice(effectiveLineEnd)}`;
}

function repairDateGroupingGenericInference(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  if (
    !/Property '[A-Za-z_$][\w$]*' does not exist on type '\{\s*date:\s*string;\s*\}'/.test(buildLog) ||
    !/groupByMonth\s*\(/.test(files.map((file) => file.content).join("\n"))
  ) {
    return { files, changed: false };
  }

  const candidates = collectDateEntryTypeCandidates(files);
  if (!candidates.length) {
    return { files, changed: false };
  }

  const buildPaths = extractBuildLogSourcePaths(buildLog);
  let changed = false;
  const nextFiles = files.map((file) => {
    if (
      !/\.(?:tsx|ts|jsx|js)$/i.test(file.path) ||
      /function\s+groupByMonth\b/.test(file.content) ||
      !/\bgroupByMonth\s*(?!<)\(/.test(file.content) ||
      (buildPaths.size > 0 && !buildPaths.has(file.path))
    ) {
      return file;
    }

    const candidate = chooseDateEntryTypeCandidate(file.content, candidates);
    if (!candidate) {
      return file;
    }

    let content = file.content.replace(/\bgroupByMonth\s*(?!<)\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\)/g, (_match, arg: string) => {
      return `groupByMonth<${candidate.name}>(${arg})`;
    });
    if (content === file.content) {
      return file;
    }

    content = ensureNamedImportFromModule(content, candidate.name, candidate.moduleSpecifier);
    changed = true;
    return { ...file, content };
  });

  return { files: nextFiles, changed };
}

function collectDateEntryTypeCandidates(files: GeneratedApp["files"]): Array<{ name: string; moduleSpecifier: string; score: number }> {
  const candidates: Array<{ name: string; moduleSpecifier: string; score: number }> = [];
  for (const file of files) {
    if (!/^src\/.+\.(?:ts|tsx)$/.test(file.path)) {
      continue;
    }
    for (const match of file.content.matchAll(/\bexport\s+(?:interface|type)\s+([A-Z][A-Za-z0-9_]*)\b/g)) {
      const name = match[1];
      if (!name) {
        continue;
      }
      const typeStart = findNamedObjectTypeStart(file.content, name);
      if (!typeStart) {
        continue;
      }
      const closeBrace = findMatchingBrace(file.content, typeStart.openBraceIndex);
      if (closeBrace < 0) {
        continue;
      }
      const body = file.content.slice(typeStart.openBraceIndex + 1, closeBrace);
      if (!/\bid\??\s*:/.test(body) || !/\bdate\??\s*:/.test(body)) {
        continue;
      }
      const moduleSpecifier = moduleSpecifierForSourcePath(file.path);
      if (!moduleSpecifier) {
        continue;
      }
      candidates.push({ name, moduleSpecifier, score: scoreDateEntryTypeCandidate(name, file.path) });
    }
  }
  return candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

function chooseDateEntryTypeCandidate(
  content: string,
  candidates: Array<{ name: string; moduleSpecifier: string; score: number }>,
): { name: string; moduleSpecifier: string; score: number } | undefined {
  const importedNames = extractImportedNamesByModule(content);
  return (
    candidates.find((candidate) => importedNames.get(candidate.moduleSpecifier)?.has(candidate.name)) ??
    candidates.find((candidate) => new RegExp(`\\b${escapeRegExp(candidate.name)}\\b`).test(content)) ??
    candidates[0]
  );
}

function extractImportedNamesByModule(content: string): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();
  for (const match of content.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["'];?/g)) {
    const names = match[1]?.split(",").map((name) => name.trim().replace(/\s+as\s+.+$/, "")).filter(Boolean) ?? [];
    const moduleSpecifier = match[2];
    if (!moduleSpecifier) {
      continue;
    }
    const existing = imports.get(moduleSpecifier) ?? new Set<string>();
    for (const name of names) {
      existing.add(name);
    }
    imports.set(moduleSpecifier, existing);
  }
  return imports;
}

function ensureNamedImportFromModule(content: string, symbolName: string, moduleSpecifier: string): string {
  const importPattern = new RegExp(
    `(import\\s+(?:type\\s+)?\\{)([^}]+)(\\}\\s+from\\s+["']${escapeRegExp(moduleSpecifier)}["'];?)`,
  );
  const existing = importPattern.exec(content);
  if (existing?.[2]) {
    const imported = new Set(existing[2].split(",").map((name) => name.trim()).filter(Boolean));
    if (imported.has(symbolName)) {
      return content;
    }
    imported.add(symbolName);
    return content.replace(importPattern, `$1 ${[...imported].sort().join(", ")} $3`);
  }

  const lines = content.split("\n");
  const lastImportIndex = lines.reduce((last, line, index) => /^\s*import\b/.test(line) ? index : last, -1);
  const importLine = `import type { ${symbolName} } from '${moduleSpecifier}';`;
  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, importLine);
    return lines.join("\n");
  }
  return `${importLine}\n${content}`;
}

function scoreDateEntryTypeCandidate(name: string, path: string): number {
  let score = 0;
  if (/RestaurantEntry/i.test(name)) score += 100;
  if (/DiaryEntry|JournalEntry|RecordEntry/i.test(name)) score += 90;
  if (/Entry$/i.test(name)) score += 70;
  if (/Record$/i.test(name)) score += 55;
  if (/Item$/i.test(name)) score += 35;
  if (/\/types\.(?:ts|tsx)$/.test(path)) score += 15;
  return score;
}

function moduleSpecifierForSourcePath(path: string): string | null {
  const match = /^src\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (!match?.[1]) {
    return null;
  }
  return `@/${match[1].replace(/\/index$/, "")}`;
}

function extractBuildLogSourcePaths(buildLog: string): Set<string> {
  const paths = new Set<string>();
  for (const match of buildLog.matchAll(/(?:^|\n)\.\/(src\/[^\n]+\.(?:tsx|ts|jsx|js))/g)) {
    if (match[1]) {
      paths.add(match[1].trim());
    }
  }
  for (const match of buildLog.matchAll(/(?:^|\n)(src\/[^\n]+\.(?:tsx|ts|jsx|js))/g)) {
    if (match[1]) {
      paths.add(match[1].trim());
    }
  }
  return paths;
}

function extractLocallyDeclaredMissingExports(buildLog: string): Array<{ moduleSpecifier: string; symbolName: string }> {
  const seen = new Set<string>();
  const items: Array<{ moduleSpecifier: string; symbolName: string }> = [];
  for (const match of buildLog.matchAll(
    /Module\s+'"?([^'"]+)"?'\s+declares\s+'([A-Za-z_$][\w$]*)'\s+locally,\s+but\s+it\s+is\s+not\s+exported\./g,
  )) {
    const moduleSpecifier = match[1]?.trim();
    const symbolName = match[2]?.trim();
    if (!moduleSpecifier || !symbolName) {
      continue;
    }
    const key = `${moduleSpecifier}:${symbolName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ moduleSpecifier, symbolName });
  }
  return items;
}

function candidatePathsForModuleSpecifier(moduleSpecifier: string): string[] {
  const base =
    moduleSpecifier.startsWith("@/")
      ? `src/${moduleSpecifier.slice(2)}`
      : moduleSpecifier.startsWith("src/")
        ? moduleSpecifier
        : "";
  if (!base) {
    return [];
  }
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
}

function exportLocalDeclaration(content: string, symbolName: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbolName)) {
    return content;
  }
  const escaped = escapeRegExp(symbolName);
  const declarationPattern = new RegExp(
    `(^|\\n)(\\s*)(?!(?:export|declare)\\b)((?:type|interface|const|let|var|function|class|enum)\\s+${escaped}\\b)`,
    "m",
  );
  const exportedDeclaration = content.replace(declarationPattern, "$1$2export $3");
  if (exportedDeclaration !== content) {
    return exportedDeclaration;
  }

  const importPattern = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]+)\\}\\s+from\\s+["']([^"']+)["'];?`);
  for (const match of content.matchAll(new RegExp(importPattern, "g"))) {
    const imported = match[1]?.split(",").map((name) => name.trim().replace(/\s+as\s+.+$/, "")).filter(Boolean) ?? [];
    const from = match[2]?.trim();
    if (!from || !imported.includes(symbolName)) {
      continue;
    }
    const exportLine = `export type { ${symbolName} } from '${from}';`;
    if (content.includes(exportLine)) {
      return content;
    }
    return `${exportLine}\n${content}`;
  }

  return content;
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

function repairRootOptionalCatchAllConflict(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const hasRootConflict =
    /same specificity as a optional catch-all route|same specificity as an optional catch-all route/i.test(buildLog);
  const hasRootPage = files.some((file) => file.path === "src/app/page.tsx" || file.path === "src/app/page.jsx");
  if (!hasRootConflict || !hasRootPage) {
    return { files, changed: false };
  }

  const nextFiles = files.filter((file) => !/^src\/app\/\[\[\.\.\.[A-Za-z_$][\w$]*\]\]\/page\.(?:tsx|jsx|ts|js)$/.test(file.path));
  return { files: nextFiles, changed: nextFiles.length !== files.length };
}

function repairContextualStringUnionTypes(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const repairs = extractContextualStringUnionRepairs(files, buildLog);
  if (!repairs.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = files.map((file) => {
    if (!/\.(?:tsx|ts|jsx|js)$/i.test(file.path)) {
      return file;
    }

    let content = file.content;
    const before = content;
    for (const repair of repairs) {
      for (const typeName of repair.typeNames) {
        content = extendStringUnionType(content, typeName, repair.literal);
      }
    }

    if (content === before) {
      return file;
    }
    changed = true;
    return { ...file, content };
  });

  return { files: nextFiles, changed };
}

function extractContextualStringUnionRepairs(
  files: GeneratedApp["files"],
  buildLog: string,
): Array<{ literal: string; typeNames: string[] }> {
  const repairs: Array<{ literal: string; typeNames: string[] }> = [];
  const seen = new Set<string>();
  const pattern =
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):(\d+):\d+\s*\nType error:\s*Type '(["'])(.*?)\3' is not assignable to type '((?:(?:["'][^"']+["'])\s*\|\s*)+(?:["'][^"']+["']))'/g;

  for (const match of buildLog.matchAll(pattern)) {
    const path = match[1];
    const lineNumber = Number(match[2]);
    const literal = match[4];
    const unionBody = match[5];
    if (!path || !Number.isFinite(lineNumber) || !literal || !unionBody) {
      continue;
    }

    const sourceFile = files.find((file) => file.path === path);
    if (!sourceFile) {
      continue;
    }

    const propertyName = inferAssignedPropertyName(sourceFile.content, lineNumber, literal);
    if (!propertyName) {
      continue;
    }

    const typeNames = findStringUnionTypeNamesForProperty(files, propertyName, unionBody);
    if (!typeNames.length) {
      continue;
    }

    const key = `${literal}:${typeNames.join(",")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    repairs.push({ literal, typeNames });
  }

  return repairs;
}

function inferAssignedPropertyName(content: string, lineNumber: number, literal: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, lineNumber - 4);
  const end = Math.min(lines.length, lineNumber + 3);
  const windowText = lines.slice(start, end).join("\n");
  const quotedLiteral = escapeRegExp(literal);
  const propertyMatch = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*:\\s*['"]${quotedLiteral}['"]`).exec(windowText);
  return propertyMatch?.[1] ?? null;
}

function findStringUnionTypeNamesForProperty(
  files: GeneratedApp["files"],
  propertyName: string,
  unionBody: string,
): string[] {
  const normalizedUnion = normalizeStringUnionBody(unionBody);
  const typeNames = new Set<string>();

  for (const file of files) {
    if (!/\.(?:tsx|ts|jsx|js)$/i.test(file.path)) {
      continue;
    }

    for (const match of file.content.matchAll(/\b(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)\b/g)) {
      const typeName = match[1];
      if (!typeName) {
        continue;
      }

      const propertyType = findPropertyTypeInNamedObject(file.content, typeName, propertyName);
      if (!propertyType) {
        continue;
      }

      if (normalizeStringUnionBody(propertyType) === normalizedUnion) {
        typeNames.add(typeName);
        continue;
      }

      const aliasName = /^[A-Za-z_$][\w$]*$/.exec(propertyType)?.[0];
      const aliasBody = aliasName ? findStringUnionAliasBody(files, aliasName) : null;
      if (aliasName && aliasBody && normalizeStringUnionBody(aliasBody) === normalizedUnion) {
        typeNames.add(aliasName);
      }
    }
  }

  return [...typeNames];
}

function findStringUnionAliasBody(files: GeneratedApp["files"], aliasName: string): string | null {
  const pattern = new RegExp(`\\b(?:export\\s+)?type\\s+${escapeRegExp(aliasName)}\\s*=\\s*([^;]+);`, "m");
  for (const file of files) {
    if (!/\.(?:tsx|ts|jsx|js)$/i.test(file.path)) {
      continue;
    }

    const match = pattern.exec(file.content);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function findPropertyTypeInNamedObject(content: string, typeName: string, propertyName: string): string | null {
  const typeStart = findNamedObjectTypeStart(content, typeName);
  if (!typeStart) {
    return null;
  }

  const closeBrace = findMatchingBrace(content, typeStart.openBraceIndex);
  if (closeBrace < 0) {
    return null;
  }

  const body = content.slice(typeStart.openBraceIndex + 1, closeBrace);
  const match = new RegExp(`\\b${escapeRegExp(propertyName)}\\??\\s*:\\s*([^;\\n]+)`).exec(body);
  return match?.[1]?.trim() ?? null;
}

function normalizeStringUnionBody(body: string): string {
  return body
    .split("|")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .sort()
    .join("|");
}

function repairDuplicateObjectLiteralKeys(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const duplicateKeys = extractDuplicateObjectLiteralKeyErrors(buildLog);
  if (!duplicateKeys.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = files.map((file) => {
    const keysForFile = duplicateKeys.filter((item) => item.path === file.path);
    if (!keysForFile.length || !/\.(?:tsx|ts|jsx|js)$/.test(file.path)) {
      return file;
    }

    let content = file.content;
    for (const item of keysForFile) {
      content = mergeDuplicateObjectLiteralKeyAtLine(content, item.line, item.column);
    }
    if (content === file.content) {
      return file;
    }
    changed = true;
    return { ...file, content };
  });

  return { files: nextFiles, changed };
}

function extractDuplicateObjectLiteralKeyErrors(buildLog: string): Array<{ path: string; line: number; column: number }> {
  const items: Array<{ path: string; line: number; column: number }> = [];
  const seen = new Set<string>();
  for (const match of buildLog.matchAll(
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):(\d+):(\d+)\s*\nType error: An object literal cannot have multiple properties with the same name\./g,
  )) {
    const path = match[1]?.trim();
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (!path || !Number.isFinite(line) || !Number.isFinite(column)) {
      continue;
    }
    const dedupeKey = `${path}:${line}:${column}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    items.push({ path, line, column });
  }
  return items;
}

function mergeDuplicateObjectLiteralKeyAtLine(content: string, oneBasedLine: number, oneBasedColumn: number): string {
  const lineOffset = offsetForLine(content, oneBasedLine);
  if (lineOffset < 0) {
    return content;
  }
  const lineEnd = content.indexOf("\n", lineOffset);
  const lineSource = content.slice(lineOffset, lineEnd < 0 ? content.length : lineEnd);
  const columnOffset = Math.max(0, Math.min(lineSource.length, oneBasedColumn - 1));
  const keyMatch = /[A-Za-z_$][\w$]*/.exec(lineSource.slice(columnOffset));
  const key = keyMatch?.[0];
  if (!key) {
    return content;
  }
  const keyOffset = lineOffset + columnOffset + (keyMatch?.index ?? 0);
  const objectStart = findEnclosingObjectStart(content, keyOffset);
  if (objectStart < 0) {
    return content;
  }
  const objectEnd = findMatchingBrace(content, objectStart);
  if (objectEnd < 0) {
    return content;
  }
  const objectSource = content.slice(objectStart, objectEnd + 1);
  const mergedObject = mergeDuplicateKeyInObjectSource(objectSource, key);
  if (mergedObject === objectSource) {
    return content;
  }
  return `${content.slice(0, objectStart)}${mergedObject}${content.slice(objectEnd + 1)}`;
}

function mergeDuplicateKeyInObjectSource(objectSource: string, key: string): string {
  const entries = findTopLevelObjectPropertyEntries(objectSource, key);
  if (entries.length < 2) {
    return objectSource;
  }

  const values = entries.map((entry) => objectSource.slice(entry.valueStart, entry.valueEnd).trim()).filter(Boolean);
  if (values.length < 2) {
    return objectSource;
  }

  const first = entries[0]!;
  const last = entries.at(-1)!;
  const indent = indentationAt(objectSource, first.start);
  const innerIndent = `${indent}  `;
  const merged = `AND: [\n${innerIndent}${values.map((value) => `{ ${key}: ${value} }`).join(`,\n${innerIndent}`)},\n${indent}]`;
  return `${objectSource.slice(0, first.start)}${merged}${objectSource.slice(last.end)}`;
}

function findTopLevelObjectPropertyEntries(
  objectSource: string,
  key: string,
): Array<{ start: number; end: number; valueStart: number; valueEnd: number }> {
  const entries: Array<{ start: number; end: number; valueStart: number; valueEnd: number }> = [];
  const keyPattern = new RegExp(`\\b${escapeRegExp(key)}\\s*:`, "g");
  let match: RegExpExecArray | null;
  while ((match = keyPattern.exec(objectSource))) {
    const keyStart = match.index;
    if (!isTopLevelObjectPropertyAt(objectSource, keyStart)) {
      continue;
    }
    const colon = objectSource.indexOf(":", keyStart);
    if (colon < 0) {
      continue;
    }
    const valueStart = colon + 1;
    const valueEnd = findPropertyValueEnd(objectSource, valueStart);
    entries.push({
      start: keyStart,
      end: consumePropertySeparator(objectSource, valueEnd),
      valueStart,
      valueEnd,
    });
  }
  return entries;
}

function isTopLevelObjectPropertyAt(objectSource: string, keyStart: number): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < keyStart; index += 1) {
    const char = objectSource[index]!;
    const previous = objectSource[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
    }
  }
  return depth === 1;
}

function findPropertyValueEnd(objectSource: string, valueStart: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = valueStart; index < objectSource.length; index += 1) {
    const char = objectSource[index]!;
    const previous = objectSource[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      return index;
    }
  }
  return objectSource.length - 1;
}

function consumePropertySeparator(objectSource: string, valueEnd: number): number {
  let end = valueEnd;
  while (end < objectSource.length && /\s/.test(objectSource[end] ?? "")) {
    end += 1;
  }
  if (objectSource[end] === ",") {
    end += 1;
  }
  return end;
}

function indentationAt(content: string, offset: number): string {
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  return /^\s*/.exec(content.slice(lineStart, offset))?.[0] ?? "";
}

function offsetForLine(content: string, oneBasedLine: number): number {
  if (oneBasedLine <= 1) {
    return 0;
  }
  let offset = 0;
  for (let line = 1; line < oneBasedLine; line += 1) {
    const next = content.indexOf("\n", offset);
    if (next < 0) {
      return -1;
    }
    offset = next + 1;
  }
  return offset;
}

function findEnclosingObjectStart(content: string, offset: number): number {
  const stack: number[] = [];
  let quote: string | null = null;
  for (let index = 0; index <= offset && index < content.length; index += 1) {
    const char = content[index]!;
    const previous = content[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      stack.push(index);
    } else if (char === "}") {
      stack.pop();
    }
  }
  return stack.at(-1) ?? -1;
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

function repairMissingLocalTypeImports(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const missingNames = extractCannotFindNameErrors(buildLog);
  if (!missingNames.length) {
    return { files, changed: false };
  }

  const exportedTypes = collectExportedLocalTypeSymbols(files);
  let changed = false;
  const nextFiles = files.map((file) => {
    const namesForFile = missingNames.filter((item) => item.path === file.path).map((item) => item.name);
    if (!namesForFile.length || !/\.(?:tsx|ts|jsx|js)$/.test(file.path)) {
      return file;
    }

    let content = file.content;
    for (const name of new Set(namesForFile)) {
      if (hasImportedBinding(content, name)) {
        continue;
      }
      const candidate = chooseLocalTypeExportCandidate(file.path, content, exportedTypes.get(name) ?? []);
      if (!candidate) {
        continue;
      }
      const moduleSpecifier = findExistingImportSpecifierForSourcePath(content, file.path, candidate.path) ?? moduleSpecifierForSourcePath(candidate.path);
      if (!moduleSpecifier) {
        continue;
      }
      content = ensureNamedImportFromModule(content, name, moduleSpecifier);
    }

    if (content === file.content) {
      return file;
    }
    changed = true;
    return { ...file, content };
  });

  return { files: nextFiles, changed };
}

function repairConflictingLocalTypeDefinitions(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const conflicts = extractConflictingLocalTypeReferences(buildLog);
  if (!conflicts.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = [...files];

  for (const conflict of conflicts) {
    const leftIndex = findFileIndexForCandidates(nextFiles, conflict.leftCandidates);
    const rightIndex = findFileIndexForCandidates(nextFiles, conflict.rightCandidates);
    if (leftIndex < 0 || rightIndex < 0 || leftIndex === rightIndex) {
      continue;
    }

    const leftFile = nextFiles[leftIndex]!;
    const rightFile = nextFiles[rightIndex]!;
    const leftType = namedObjectTypeDescriptor(leftFile.content, conflict.typeName);
    const rightType = namedObjectTypeDescriptor(rightFile.content, conflict.typeName);
    if (!leftType || !rightType || normalizeWhitespace(leftType.body) === normalizeWhitespace(rightType.body)) {
      continue;
    }

    const source = leftType.score >= rightType.score
      ? { descriptor: leftType, file: leftFile }
      : { descriptor: rightType, file: rightFile };
    const targetIndex = source.file.path === leftFile.path ? rightIndex : leftIndex;
    const targetFile = nextFiles[targetIndex]!;
    const targetType = source.file.path === leftFile.path ? rightType : leftType;
    const content = replaceNamedObjectTypeBody(targetFile.content, targetType, source.descriptor.body);
    if (content === targetFile.content) {
      continue;
    }

    nextFiles[targetIndex] = { ...targetFile, content };
    changed = true;
  }

  return { files: nextFiles, changed };
}

function extractConflictingLocalTypeReferences(
  buildLog: string,
): Array<{ typeName: string; leftCandidates: string[]; rightCandidates: string[] }> {
  if (!/not assignable|incompatible|Types of property/i.test(buildLog)) {
    return [];
  }

  const referencesByType = new Map<string, string[][]>();
  for (const match of buildLog.matchAll(/import\("([^"]+)"\)\.([A-Za-z_$][\w$]*)/g)) {
    const importReference = match[1];
    const typeName = match[2];
    if (!importReference || !typeName) {
      continue;
    }
    const candidates = sourceFileCandidatesForImportReference(importReference);
    if (!candidates.length) {
      continue;
    }
    const items = referencesByType.get(typeName) ?? [];
    if (!items.some((existing) => existing.join("\0") === candidates.join("\0"))) {
      items.push(candidates);
    }
    referencesByType.set(typeName, items);
  }

  const conflicts: Array<{ typeName: string; leftCandidates: string[]; rightCandidates: string[] }> = [];
  for (const [typeName, references] of referencesByType) {
    if (references.length < 2) {
      continue;
    }
    for (let index = 1; index < references.length; index += 1) {
      conflicts.push({
        typeName,
        leftCandidates: references[0]!,
        rightCandidates: references[index]!,
      });
    }
  }
  return conflicts;
}

function sourceFileCandidatesForImportReference(importReference: string): string[] {
  const srcIndex = importReference.lastIndexOf("/src/");
  const rawPath = srcIndex >= 0
    ? importReference.slice(srcIndex + 1)
    : importReference.startsWith("src/")
      ? importReference
      : "";
  if (!rawPath) {
    return [];
  }

  const normalized = normalizeSourcePath(rawPath);
  const withoutExtension = normalized.replace(/\.(?:tsx|ts|jsx|js)$/, "");
  if (/\.(?:tsx|ts|jsx|js)$/.test(normalized)) {
    return [normalized];
  }
  return [
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}.js`,
    `${withoutExtension}.jsx`,
    `${withoutExtension}/index.ts`,
    `${withoutExtension}/index.tsx`,
    `${withoutExtension}/index.js`,
    `${withoutExtension}/index.jsx`,
  ];
}

function findFileIndexForCandidates(files: GeneratedApp["files"], candidates: string[]): number {
  const candidateSet = new Set(candidates);
  return files.findIndex((file) => candidateSet.has(file.path));
}

function namedObjectTypeDescriptor(
  content: string,
  typeName: string,
): { matchIndex: number; openBraceIndex: number; closeBraceIndex: number; body: string; score: number } | null {
  const start = findNamedObjectTypeStart(content, typeName);
  if (!start) {
    return null;
  }
  const closeBraceIndex = findMatchingBrace(content, start.openBraceIndex);
  if (closeBraceIndex < 0) {
    return null;
  }
  const body = content.slice(start.openBraceIndex + 1, closeBraceIndex);
  return {
    ...start,
    closeBraceIndex,
    body,
    score: scoreNamedObjectTypeBody(body),
  };
}

function scoreNamedObjectTypeBody(body: string): number {
  const propertyCount = body.match(/[A-Za-z_$\u4e00-\u9fff][A-Za-z0-9_$\u4e00-\u9fff]*\??\s*:/g)?.length ?? 0;
  let score = propertyCount * 8 + Math.min(body.length, 400) / 20;
  if (/\bRecord\s*</.test(body)) {
    score -= 35;
  }
  if (/[A-Za-z_$\u4e00-\u9fff][A-Za-z0-9_$\u4e00-\u9fff]*\??\s*:\s*\{/.test(body)) {
    score += 20;
  }
  return score;
}

function replaceNamedObjectTypeBody(
  content: string,
  descriptor: { openBraceIndex: number; closeBraceIndex: number },
  body: string,
): string {
  return `${content.slice(0, descriptor.openBraceIndex + 1)}${body}${content.slice(descriptor.closeBraceIndex)}`;
}

function repairMissingRequiredObjectLiteralProperties(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const errors = extractMissingObjectLiteralPropertyErrors(buildLog);
  if (!errors.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = files.map((file) => {
    const errorsForFile = errors.filter((error) => error.path === file.path);
    if (!errorsForFile.length || !/\.(?:tsx|ts|jsx|js)$/.test(file.path)) {
      return file;
    }

    let content = file.content;
    for (const error of errorsForFile) {
      content = addMissingPropertyToObjectLiteralNearLine(content, error.line, error.propertyName);
    }

    if (content === file.content) {
      return file;
    }
    changed = true;
    return { ...file, content };
  });

  return { files: nextFiles, changed };
}

function repairExcessObjectLiteralProperties(
  files: GeneratedApp["files"],
  buildLog: string,
): { files: GeneratedApp["files"]; changed: boolean } {
  const errors = extractExcessObjectLiteralPropertyErrors(buildLog);
  if (!errors.length) {
    return { files, changed: false };
  }

  let changed = false;
  const nextFiles = [...files];
  for (const error of errors) {
    const sourceIndex = nextFiles.findIndex((file) => file.path === error.path);
    if (sourceIndex < 0) {
      continue;
    }
    const sourceFile = nextFiles[sourceIndex]!;
    if (!/\.(?:ts|tsx|js|jsx)$/i.test(sourceFile.path)) {
      continue;
    }
    const typeIndex = findBestFileIndexForNamedObjectType(nextFiles, error.typeName, sourceFile.path);
    if (typeIndex < 0) {
      continue;
    }
    const targetFile = nextFiles[typeIndex]!;
    const nextContent = addOptionalPropertyToNamedObjectType(
      targetFile.content,
      error.typeName,
      error.propertyName,
      inferPropertyTypeFromObjectLiteral(sourceFile.content, error.line, error.propertyName),
    );
    if (nextContent === targetFile.content) {
      continue;
    }
    nextFiles[typeIndex] = { ...targetFile, content: nextContent };
    changed = true;
  }

  return { files: nextFiles, changed };
}

function extractExcessObjectLiteralPropertyErrors(
  buildLog: string,
): Array<{ path: string; line: number; propertyName: string; typeName: string }> {
  const seen = new Set<string>();
  const items: Array<{ path: string; line: number; propertyName: string; typeName: string }> = [];
  const pattern =
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):(\d+):\d+\s*\nType error:\s*Object literal may only specify known properties, and '([A-Za-z_$][\w$]*)' does not exist in type '([A-Za-z_$][\w$]*)'/g;

  for (const match of buildLog.matchAll(pattern)) {
    const path = match[1]?.trim();
    const line = Number(match[2]);
    const propertyName = match[3]?.trim();
    const typeName = match[4]?.trim();
    if (!path || !Number.isFinite(line) || line < 1 || !propertyName || !typeName) {
      continue;
    }
    const key = `${path}:${line}:${typeName}.${propertyName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ path, line, propertyName, typeName });
  }
  return items;
}

function findBestFileIndexForNamedObjectType(files: GeneratedApp["files"], typeName: string, sourcePath: string): number {
  const sourceDirectory = sourcePath.replace(/\/[^/]+$/, "");
  const candidates = files
    .map((file, index) => ({ file, index, descriptor: namedObjectTypeDescriptor(file.content, typeName) }))
    .filter((item): item is { file: GeneratedApp["files"][number]; index: number; descriptor: NonNullable<ReturnType<typeof namedObjectTypeDescriptor>> } =>
      Boolean(item.descriptor) && /\.(?:ts|tsx)$/i.test(item.file.path),
    )
    .sort((left, right) => {
      const leftSameDir = left.file.path.startsWith(`${sourceDirectory}/`) ? 0 : 1;
      const rightSameDir = right.file.path.startsWith(`${sourceDirectory}/`) ? 0 : 1;
      return leftSameDir - rightSameDir || right.descriptor.score - left.descriptor.score || left.file.path.localeCompare(right.file.path);
    });
  return candidates[0]?.index ?? -1;
}

function inferPropertyTypeFromObjectLiteral(content: string, line: number, propertyName: string): string {
  const value = extractObjectLiteralPropertyValueNearLine(content, line, propertyName);
  if (!value) {
    return inferMissingPropertyType(propertyName);
  }
  const trimmed = value.trim();
  if (/^['"`]/.test(trimmed)) {
    return "string";
  }
  if (/^(?:true|false)\b/.test(trimmed)) {
    return "boolean";
  }
  if (/^-?\d+(?:\.\d+)?\b/.test(trimmed)) {
    return "number";
  }
  if (/^\[/.test(trimmed)) {
    return trimmed.includes("{") ? "Array<Record<string, unknown>>" : "string[]";
  }
  if (/^\{/.test(trimmed)) {
    return "Record<string, unknown>";
  }
  return inferMissingPropertyType(propertyName);
}

function extractObjectLiteralPropertyValueNearLine(content: string, line: number, propertyName: string): string | undefined {
  const lineStart = offsetForLine(content, line);
  if (lineStart < 0) {
    return undefined;
  }
  const searchStart = Math.max(0, lineStart - 240);
  const openBraceIndex = content.lastIndexOf("{", lineStart);
  if (openBraceIndex < searchStart || openBraceIndex < 0) {
    return undefined;
  }
  const closeBraceIndex = findMatchingBrace(content, openBraceIndex);
  if (closeBraceIndex < lineStart) {
    return undefined;
  }
  const body = content.slice(openBraceIndex + 1, closeBraceIndex);
  const propertyPattern = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*`, "m");
  const match = propertyPattern.exec(body);
  if (!match) {
    return undefined;
  }
  const valueStart = match.index + match[0].length;
  const valueEnd = findObjectPropertyValueEnd(body, valueStart);
  return body.slice(valueStart, valueEnd);
}

function findObjectPropertyValueEnd(body: string, start: number): number {
  let curlyDepth = 0;
  let squareDepth = 0;
  let parenDepth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }
    if (char === "{") curlyDepth += 1;
    if (char === "}") curlyDepth = Math.max(0, curlyDepth - 1);
    if (char === "[") squareDepth += 1;
    if (char === "]") squareDepth = Math.max(0, squareDepth - 1);
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (char === "," && curlyDepth === 0 && squareDepth === 0 && parenDepth === 0) {
      return index;
    }
  }
  return body.length;
}

function extractMissingObjectLiteralPropertyErrors(
  buildLog: string,
): Array<{ path: string; line: number; propertyName: string }> {
  const seen = new Set<string>();
  const items: Array<{ path: string; line: number; propertyName: string }> = [];
  const pattern =
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):(\d+):\d+\s*\nType error:\s*Property '([A-Za-z_$][\w$]*)' is missing in type '[^']*' but required in type '[^']*'/g;

  for (const match of buildLog.matchAll(pattern)) {
    const path = match[1]?.trim();
    const line = Number(match[2]);
    const propertyName = match[3]?.trim();
    if (!path || !Number.isFinite(line) || line < 1 || !propertyName) {
      continue;
    }
    const key = `${path}:${line}:${propertyName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ path, line, propertyName });
  }
  return items;
}

function addMissingPropertyToObjectLiteralNearLine(content: string, line: number, propertyName: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(propertyName)) {
    return content;
  }

  const lineStart = offsetForLine(content, line);
  if (lineStart < 0) {
    return content;
  }

  const lineEnd = content.indexOf("\n", lineStart);
  const effectiveLineEnd = lineEnd >= 0 ? lineEnd : content.length;
  const inlineObjectIndex = content.indexOf("{", lineStart);
  const searchStart = Math.max(0, lineStart - 220);
  const openBraceIndex = inlineObjectIndex >= 0 && inlineObjectIndex < effectiveLineEnd
    ? inlineObjectIndex
    : content.lastIndexOf("{", lineStart);
  if (openBraceIndex < searchStart || openBraceIndex < 0) {
    return content;
  }

  const closeBraceIndex = findMatchingBrace(content, openBraceIndex);
  if (closeBraceIndex < lineStart) {
    return content;
  }

  const body = content.slice(openBraceIndex + 1, closeBraceIndex);
  if (new RegExp(`(^|[,{;])\\s*${escapeRegExp(propertyName)}\\s*:`, "m").test(body)) {
    return content;
  }

  const value = inferMissingObjectLiteralPropertyValue(body, propertyName);
  if (!value) {
    return content;
  }

  let insertionIndex = closeBraceIndex;
  while (insertionIndex > openBraceIndex + 1 && /\s/.test(content[insertionIndex - 1] ?? "")) {
    insertionIndex -= 1;
  }

  const currentBody = content.slice(openBraceIndex + 1, insertionIndex);
  const insertion = currentBody.trim().length > 0 && !currentBody.trimEnd().endsWith(",")
    ? `, ${propertyName}: ${value}`
    : `${currentBody.trim().length > 0 ? " " : ""}${propertyName}: ${value}`;
  return `${content.slice(0, insertionIndex)}${insertion}${content.slice(insertionIndex)}`;
}

function inferMissingObjectLiteralPropertyValue(body: string, propertyName: string): string | null {
  if (/(?:^|[,{;])\s*min\s*:\s*(-?\d+(?:\.\d+)?)/m.test(body) && propertyName === "max") {
    const min = Number(body.match(/(?:^|[,{;])\s*min\s*:\s*(-?\d+(?:\.\d+)?)/m)?.[1] ?? "0");
    return Number.isFinite(min) ? String(Math.max(min, min + 20)) : "0";
  }
  if (/(?:^|[,{;])\s*max\s*:\s*(-?\d+(?:\.\d+)?)/m.test(body) && propertyName === "min") {
    const max = Number(body.match(/(?:^|[,{;])\s*max\s*:\s*(-?\d+(?:\.\d+)?)/m)?.[1] ?? "0");
    return Number.isFinite(max) ? String(Math.min(max, Math.max(0, max - 20))) : "0";
  }
  if (/(budget|cost|price|amount|total|count|score|rating|progress|percent|quantity|min|max)$/i.test(propertyName)) {
    return "0";
  }
  return null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractCannotFindNameErrors(buildLog: string): Array<{ path?: string; name: string }> {
  const items: Array<{ path?: string; name: string }> = [];
  const seen = new Set<string>();
  const withPathPattern =
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):\d+:\d+\s*\nType error:\s*Cannot find name '([A-Za-z_$][\w$]*)'\./g;
  for (const match of buildLog.matchAll(withPathPattern)) {
    const path = match[1]?.trim();
    const name = match[2]?.trim();
    if (!name) {
      continue;
    }
    const key = `${path ?? ""}:${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ path, name });
  }

  for (const match of buildLog.matchAll(/Cannot find name '([A-Za-z_$][\w$]*)'\./g)) {
    const name = match[1]?.trim();
    if (!name) {
      continue;
    }
    const key = `:${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ name });
  }
  return items;
}

function collectExportedLocalTypeSymbols(files: GeneratedApp["files"]): Map<string, Array<{ path: string; score: number }>> {
  const exports = new Map<string, Array<{ path: string; score: number }>>();
  for (const file of files) {
    if (!/^src\/.+\.(?:ts|tsx)$/.test(file.path)) {
      continue;
    }
    for (const match of file.content.matchAll(/\bexport\s+(?:interface|type)\s+([A-Z][A-Za-z0-9_]*)\b/g)) {
      const name = match[1];
      if (!name) {
        continue;
      }
      const items = exports.get(name) ?? [];
      items.push({ path: file.path, score: scoreLocalTypeExport(file.path) });
      exports.set(name, items);
    }
  }
  return exports;
}

function scoreLocalTypeExport(path: string): number {
  let score = 0;
  if (/\/types\.(?:ts|tsx)$/.test(path)) score += 100;
  if (/^src\/lib\//.test(path)) score += 30;
  if (/\/index\.(?:ts|tsx)$/.test(path)) score += 10;
  return score;
}

function chooseLocalTypeExportCandidate(
  importerPath: string,
  content: string,
  candidates: Array<{ path: string; score: number }>,
): { path: string; score: number } | undefined {
  if (!candidates.length) {
    return undefined;
  }

  const existing = candidates.find((candidate) => findExistingImportSpecifierForSourcePath(content, importerPath, candidate.path));
  if (existing) {
    return existing;
  }

  const importerDirectory = importerPath.split("/").slice(0, -1).join("/");
  return [...candidates].sort((left, right) => {
    const leftSameDirectory = left.path.startsWith(`${importerDirectory}/`) ? 1 : 0;
    const rightSameDirectory = right.path.startsWith(`${importerDirectory}/`) ? 1 : 0;
    return rightSameDirectory - leftSameDirectory || right.score - left.score || left.path.localeCompare(right.path);
  })[0];
}

function hasImportedBinding(content: string, symbolName: string): boolean {
  const escaped = escapeRegExp(symbolName);
  return new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s+from\\s+["'][^"']+["'];?`).test(content);
}

function findExistingImportSpecifierForSourcePath(content: string, importerPath: string, sourcePath: string): string | undefined {
  for (const match of content.matchAll(/import\s+(?:type\s+)?\{[^}]+\}\s+from\s+["']([^"']+)["'];?/g)) {
    const moduleSpecifier = match[1]?.trim();
    if (!moduleSpecifier) {
      continue;
    }
    if (candidatePathsForImportSpecifier(moduleSpecifier, importerPath).includes(sourcePath)) {
      return moduleSpecifier;
    }
  }
  return undefined;
}

function candidatePathsForImportSpecifier(moduleSpecifier: string, importerPath: string): string[] {
  if (moduleSpecifier.startsWith("@/") || moduleSpecifier.startsWith("src/")) {
    return candidatePathsForModuleSpecifier(moduleSpecifier);
  }
  if (!moduleSpecifier.startsWith(".")) {
    return [];
  }

  const importerDirectory = importerPath.split("/").slice(0, -1).join("/");
  const base = normalizeSourcePath(`${importerDirectory}/${moduleSpecifier}`);
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
}

function normalizeSourcePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function shouldRepairStyledJsxBoundary(path: string, content: string, buildLog: string): boolean {
  const buildLogMentionsFile = new RegExp(`(?:\\./)?${escapeRegExp(path)}`).test(buildLog);
  return (
    (/^src\/app\/.+\.(?:tsx|jsx)$/.test(path) || buildLogMentionsFile) &&
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
  return content
    .replace(
      /(\b(?:React\.)?useState\s*)<\s*((?:(?:'[^']+'|"[^"]+")\s*\|\s*)+(?:'[^']+'|"[^"]+"))\s*>/g,
      "$1<string>",
    )
    .replace(
      /(\b(?:React\.)?useState\s*)\(\s*('[^']*'|"[^"]*"|`[^`]*`|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\[\s*[\dA-Za-z_$][\w$]*\s*\])\s*\)/g,
      (_match, prefix: string, initializer: string) => `${prefix}<string>(${initializer})`,
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

function repairDuplicateImportedIdentifier(content: string, buildLog: string, path: string): string {
  const duplicateNames = extractDuplicateIdentifierErrors(buildLog)
    .filter((item) => !item.path || item.path === path)
    .map((item) => item.name);
  if (!duplicateNames.length) {
    return content;
  }

  let next = content;
  for (const name of new Set(duplicateNames)) {
    if (countImportedBindings(next, name) < 2) {
      continue;
    }

    const withoutUnusedLucideIcon = hasJsxComponentUsage(next, name)
      ? next
      : removeNamedImportFromModule(next, "lucide-react", name);
    if (withoutUnusedLucideIcon !== next) {
      next = withoutUnusedLucideIcon;
      continue;
    }

    const lucideAlias = `${name}Icon`;
    const withAliasedLucideIcon = aliasNamedImportFromModule(next, "lucide-react", name, lucideAlias);
    if (withAliasedLucideIcon !== next) {
      next = renameJsxComponentUsages(withAliasedLucideIcon, name, lucideAlias);
    }
  }
  return next;
}

function extractDuplicateIdentifierErrors(buildLog: string): Array<{ path?: string; name: string }> {
  const items: Array<{ path?: string; name: string }> = [];
  const seen = new Set<string>();
  const withPathPattern =
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):\d+:\d+\s*\nType error:\s*Duplicate identifier '([A-Za-z_$][\w$]*)'\./g;
  for (const match of buildLog.matchAll(withPathPattern)) {
    const path = match[1]?.trim();
    const name = match[2]?.trim();
    if (!name) {
      continue;
    }
    const key = `${path ?? ""}:${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ path, name });
  }

  for (const match of buildLog.matchAll(/Duplicate identifier '([A-Za-z_$][\w$]*)'\./g)) {
    const name = match[1]?.trim();
    if (!name) {
      continue;
    }
    const key = `:${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ name });
  }
  return items;
}

function countImportedBindings(content: string, symbolName: string): number {
  let count = 0;
  const escaped = escapeRegExp(symbolName);
  for (const match of content.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'][^"']+["'];?/g)) {
    const names = match[1]?.split(",").map((name) => name.trim().replace(/\s+as\s+.+$/, "")).filter(Boolean) ?? [];
    count += names.filter((name) => new RegExp(`^${escaped}$`).test(name)).length;
  }
  return count;
}

function removeNamedImportFromModule(content: string, moduleSpecifier: string, symbolName: string): string {
  return updateNamedImportFromModule(content, moduleSpecifier, (bindings) =>
    bindings.filter((binding) => importedBindingName(binding) !== symbolName),
  );
}

function aliasNamedImportFromModule(content: string, moduleSpecifier: string, symbolName: string, aliasName: string): string {
  return updateNamedImportFromModule(content, moduleSpecifier, (bindings) =>
    bindings.map((binding) => importedBindingName(binding) === symbolName ? `${symbolName} as ${aliasName}` : binding),
  );
}

function updateNamedImportFromModule(
  content: string,
  moduleSpecifier: string,
  update: (bindings: string[]) => string[],
): string {
  const pattern = new RegExp(
    `^import\\s+(type\\s+)?\\{([^}]+)\\}\\s+from\\s+["']${escapeRegExp(moduleSpecifier)}["'];?\\s*\\n?`,
    "m",
  );
  const match = pattern.exec(content);
  if (!match?.[2]) {
    return content;
  }

  const before = match[0];
  const isTypeOnly = Boolean(match[1]);
  const updatedBindings = update(splitImportBindings(match[2]));
  const after = updatedBindings.length
    ? `import ${isTypeOnly ? "type " : ""}{ ${updatedBindings.join(", ")} } from '${moduleSpecifier}';\n`
    : "";
  if (after === before) {
    return content;
  }
  return `${content.slice(0, match.index)}${after}${content.slice(match.index + before.length)}`;
}

function splitImportBindings(bindings: string): string[] {
  return bindings.split(",").map((binding) => binding.trim()).filter(Boolean);
}

function importedBindingName(binding: string): string {
  return binding.replace(/\s+as\s+.+$/, "").trim();
}

function hasJsxComponentUsage(content: string, symbolName: string): boolean {
  return new RegExp(`<${escapeRegExp(symbolName)}(?=[\\s>/])`).test(content);
}

function renameJsxComponentUsages(content: string, fromName: string, toName: string): string {
  const escaped = escapeRegExp(fromName);
  return content
    .replace(new RegExp(`<${escaped}(?=[\\s>/])`, "g"), `<${toName}`)
    .replace(new RegExp(`</${escaped}>`, "g"), `</${toName}>`);
}

const LUCIDE_ICON_ALIASES: Record<string, string> = {
  Ball: "CircleDot",
  ForkKnife: "Utensils",
  ForkAndKnife: "Utensils",
  Food: "Utensils",
  Restaurant: "Utensils",
};

function repairInvalidLucideIconExport(content: string, buildLog: string): string {
  const invalidIcons = [...buildLog.matchAll(/(?:no exported member|not exported)[\s\S]{0,120}['"]([A-Z][A-Za-z0-9]+)['"]/gi)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
  if (!invalidIcons.length || !/from\s+["']lucide-react["']/.test(content)) {
    return content;
  }

  let next = content;
  for (const invalidIcon of invalidIcons) {
    const replacement = LUCIDE_ICON_ALIASES[invalidIcon];
    if (!replacement) {
      continue;
    }
    next = next.replace(new RegExp(`\\b${invalidIcon}\\b`, "g"), replacement);
  }
  return next;
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

function repairInvalidOptionalEnvComparison(content: string): string {
  const hasMalformedEnvComparison = /\bprocess\.env\.[A-Za-z_$][\w$]*\?\.\s*(?:={2,3}|!={1,2}|[<>]=?)/.test(content);
  if (!hasMalformedEnvComparison) {
    return content;
  }

  return content.replace(
    /\bprocess\.env\.([A-Za-z_$][\w$]*)\?\.(\s*(?:={2,3}|!={1,2}|[<>]=?))/g,
    "process.env.$1$2",
  );
}

function repairDateStringTypeForPrismaDate(content: string, buildLog: string): string {
  if (!/Type 'Date' is not assignable to type 'string'/.test(buildLog)) {
    return content;
  }

  return content.replace(/\b(date|createdAt|updatedAt)\??:\s*string\b/g, (match, fieldName: string) => {
    const optionalMarker = match.includes("?:") ? "?" : "";
    return `${fieldName}${optionalMarker}: string | Date`;
  });
}

function repairImplicitAnyParameter(content: string, buildLog: string): string {
  const names = [...buildLog.matchAll(/Parameter '([A-Za-z_$][\w$]*)' implicitly has an 'any' type\./g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
  if (!names.length) {
    return content;
  }

  let next = content;
  for (const name of new Set(names)) {
    const escaped = escapeRegExp(name);
    next = next.replace(new RegExp(`\\b${escaped}\\s*=>`, "g"), `(${name}: any) =>`);
    next = next.replace(new RegExp(`([,(]\\s*)${escaped}(\\s*[,)]\\s*=>)`, "g"), `$1${name}: any$2`);
  }
  return next;
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

function repairBooleanCallableFavoriteContext(content: string, buildLog: string): string {
  if (
    !/This expression is not callable[\s\S]*Type 'Boolean' has no call signatures/i.test(buildLog) ||
    !/useFavorites\s*\(\s*\)/.test(content) ||
    !/\bisFavorited\s*\(/.test(content)
  ) {
    return content;
  }

  let next = content
    .replace(
      /const\s+\{\s*isFavorited\s*,\s*addFavorite\s*,\s*removeFavorite\s*\}\s*=\s*useFavorites\(\s*\)\s*;/,
      "const { isFavorite, toggleFavorite, removeFavorite } = useFavorites();",
    )
    .replace(/\bisFavorited\s*\(/g, "isFavorite(");

  if (/\baddFavorite\s*\(\s*locationId\s*\)\s*;/.test(next)) {
    next = next.replace(
      /\baddFavorite\s*\(\s*locationId\s*\)\s*;/g,
      [
        "toggleFavorite({",
        "      locationId,",
        "      name: locationId,",
        "      type: 'attraction',",
        "      area: '未分类',",
        "      budget: 0,",
        "      budgetCategory: 'ticket',",
        "    });",
      ].join("\n"),
    );
  }

  return next;
}

function repairNullableJsxPropUndefined(content: string, buildLog: string): string {
  const fallback = /Type error:[\s\S]*undefined[\s\S]*is not assignable to type[\s\S]*\bnull\b/i.test(buildLog)
    ? "null"
    : /Type error:[\s\S]*undefined[\s\S]*is not assignable to type[\s\S]*\bstring\b/i.test(buildLog)
      ? '""'
      : undefined;
  if (!fallback) {
    return content;
  }

  let propEntries = buildLog
    .split(/\r?\n/)
    .filter((line) => />\s*\d+\s*\|/.test(line))
    .flatMap((line) =>
      [...line.matchAll(/\b([A-Za-z_$][\w$:-]*)=\{([^}\n]+)\}/g)].map((match) => ({
        propName: match[1],
        expression: match[2]?.trim(),
      })),
    )
    .filter((entry): entry is { propName: string; expression: string } => {
      if (!entry.propName || !entry.expression || entry.expression.includes("??") || entry.expression.includes("||")) {
        return false;
      }
      return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(entry.expression);
    });

  if (!propEntries.length && fallback === '""') {
    propEntries = [...content.matchAll(/\b(value)=\{([^}\n]+)\}/g)]
      .map((match) => ({ propName: match[1], expression: match[2]?.trim() }))
      .filter((entry): entry is { propName: string; expression: string } => {
        if (!entry.propName || !entry.expression || entry.expression.includes("??") || entry.expression.includes("||")) {
          return false;
        }
        return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(entry.expression);
      });
  }

  let next = content;
  for (const { propName, expression } of propEntries) {
    const attributePattern = new RegExp(
      `(${escapeRegExp(propName)}\\s*=\\{)\\s*${escapeRegExp(expression)}\\s*(\\})`,
      "g",
    );
    next = next.replace(attributePattern, `$1${expression} ?? ${fallback}$2`);
  }
  return next;
}

function repairStringIdObjectMapAccess(content: string, buildLog: string): string {
  if (!/Property 'id' does not exist on type 'string'/i.test(buildLog)) {
    return content;
  }

  const variableName = extractStringIdAccessVariable(buildLog);
  if (!variableName || !content.includes(`${variableName}.id`)) {
    return content;
  }

  const escaped = escapeRegExp(variableName);
  const mapPattern = new RegExp(`\\.map\\(\\s*(?:\\(\\s*)?${escaped}(?:\\s*\\))?\\s*=>\\s*\\{`, "g");
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = mapPattern.exec(content))) {
    const openingBraceIndex = content.indexOf("{", match.index);
    if (openingBraceIndex < 0) {
      continue;
    }
    const closingBraceIndex = findMatchingBrace(content, openingBraceIndex);
    if (closingBraceIndex < 0) {
      continue;
    }

    const body = content.slice(openingBraceIndex + 1, closingBraceIndex);
    if (!body.includes(`${variableName}.id`) || new RegExp(`\\bconst\\s+${escaped}\\s*=`).test(body)) {
      continue;
    }

    const lookupFunction = findIdLookupFunction(body) ?? findIdLookupFunction(content);
    if (!lookupFunction) {
      continue;
    }

    const idName = chooseStringIdName(variableName, body);
    const innerIndent = `${indentationBefore(content, match.index)}  `;
    const repairedHeader = `.map((${idName}) => {`;
    const repairedBody = body.replace(new RegExp(`\\b${escaped}\\.id\\b`, "g"), idName);
    const text = `${repairedHeader}\n${innerIndent}const ${variableName} = ${lookupFunction}(${idName})!;${repairedBody}`;
    replacements.push({ start: match.index, end: closingBraceIndex, text });
  }

  if (!replacements.length) {
    return content;
  }

  let next = content;
  for (const replacement of replacements.reverse()) {
    next = `${next.slice(0, replacement.start)}${replacement.text}${next.slice(replacement.end)}`;
  }
  return next;
}

function repairWeatherModeArrayArgument(content: string, buildLog: string, path: string): string {
  const errors = extractWeatherModeArrayArgumentErrors(buildLog).filter((error) => error.path === path);
  if (!errors.length || !/\b(?:weather|WeatherMode)\b/.test(content)) {
    return content;
  }

  const weatherVariable = chooseWeatherModeVariable(content);
  if (!weatherVariable) {
    return content;
  }

  let next = content;
  for (const error of errors) {
    next = replaceArrayArgumentOnLineWithWeather(next, error.line, error.column, weatherVariable);
  }
  return next;
}

function extractWeatherModeArrayArgumentErrors(buildLog: string): Array<{ path: string; line: number; column: number }> {
  const seen = new Set<string>();
  const items: Array<{ path: string; line: number; column: number }> = [];
  for (const match of buildLog.matchAll(
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):(\d+):(\d+)\s*\nType error:\s*Argument of type '[^']*\[\]' is not assignable to parameter of type '["']?sunny["']?\s*\|\s*["']?rainy["']?'\./g,
  )) {
    const path = match[1]?.trim();
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (!path || !Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) {
      continue;
    }
    const key = `${path}:${line}:${column}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ path, line, column });
  }
  return items;
}

function chooseWeatherModeVariable(content: string): string | undefined {
  for (const match of content.matchAll(/\b(?:const|let)\s+(?:\[\s*)?([A-Za-z_$][\w$]*)[^\n=]*=\s*(?:useState<[^>]*(?:sunny|rainy)[^>]*>|["'](?:sunny|rainy)["'])/g)) {
    const name = match[1]?.trim();
    if (name) {
      return name;
    }
  }
  return /\bweather\b/.test(content) ? "weather" : undefined;
}

function replaceArrayArgumentOnLineWithWeather(content: string, oneBasedLine: number, oneBasedColumn: number, weatherVariable: string): string {
  const lineStart = offsetForLine(content, oneBasedLine);
  if (lineStart < 0) {
    return content;
  }
  const lineEnd = content.indexOf("\n", lineStart);
  const effectiveLineEnd = lineEnd >= 0 ? lineEnd : content.length;
  const line = content.slice(lineStart, effectiveLineEnd);
  const columnIndex = Math.max(0, oneBasedColumn - 1);
  const target = /^[A-Za-z_$][\w$]*/.exec(line.slice(columnIndex))?.[0];
  if (!target || target === weatherVariable) {
    return content;
  }

  const beforeTarget = line.slice(0, columnIndex);
  const callStart = beforeTarget.lastIndexOf("(");
  const commaBeforeTarget = beforeTarget.lastIndexOf(",");
  if (callStart < 0 || commaBeforeTarget < callStart) {
    return content;
  }

  const nextLine = `${line.slice(0, columnIndex)}${weatherVariable}${line.slice(columnIndex + target.length)}`;
  return `${content.slice(0, lineStart)}${nextLine}${content.slice(effectiveLineEnd)}`;
}

function repairUndefinedNamedReExport(content: string, buildLog: string, path: string): string {
  const undefinedExports = extractUndefinedNamedExports(buildLog)
    .filter((item) => !item.path || item.path === path)
    .map((item) => item.name);
  if (!undefinedExports.length || !/\bexport\s*\{/.test(content)) {
    return content;
  }

  let next = content;
  for (const name of new Set(undefinedExports)) {
    next = removeNamedExport(next, name);
  }
  return next;
}

function extractUndefinedNamedExports(buildLog: string): Array<{ path?: string; name: string }> {
  const items: Array<{ path?: string; name: string }> = [];
  const seen = new Set<string>();
  const pathPattern =
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js))[\s\S]{0,800}?Export '([A-Za-z_$][\w$]*)' is not defined/g;
  for (const match of buildLog.matchAll(pathPattern)) {
    const path = match[1]?.trim();
    const name = match[2]?.trim();
    if (!name) {
      continue;
    }
    const key = `${path ?? ""}:${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ path, name });
  }

  for (const match of buildLog.matchAll(/Export '([A-Za-z_$][\w$]*)' is not defined/g)) {
    const name = match[1]?.trim();
    if (!name) {
      continue;
    }
    const key = `:${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ name });
  }
  return items;
}

function removeNamedExport(content: string, symbolName: string): string {
  const escaped = escapeRegExp(symbolName);
  return content.replace(
    /^(\s*)export\s*\{([^}]+)\}\s*;?\s*$/gm,
    (match, indent: string, bindings: string) => {
      const remaining = splitImportBindings(bindings)
        .filter((binding) => importedBindingName(binding) !== symbolName && !new RegExp(`^${escaped}\\s+as\\s+`).test(binding))
        .join(", ");
      return remaining ? `${indent}export { ${remaining} };` : "";
    },
  );
}

function extractStringIdAccessVariable(buildLog: string): string | null {
  for (const match of buildLog.matchAll(/>\s*\d+\s*\|\s*([^\n]+)/g)) {
    const line = match[1] ?? "";
    const accessMatch = line.match(/\b([A-Za-z_$][\w$]*)\.id\b/);
    if (accessMatch?.[1]) {
      return accessMatch[1];
    }
  }
  return null;
}

function findIdLookupFunction(content: string): string | null {
  return content.match(/\b(get[A-Za-z0-9_]*ById)\s*\(/)?.[1] ?? null;
}

function chooseStringIdName(variableName: string, body: string): string {
  const candidates = [
    variableName.endsWith("Id") ? `${variableName}Value` : `${variableName}Id`,
    `${variableName}Key`,
    `${variableName}Value`,
  ];
  return candidates.find((candidate) => !new RegExp(`\\b${escapeRegExp(candidate)}\\b`).test(body)) ?? `${variableName}IdValue`;
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
  return [...buildLog.matchAll(/Property '([A-Za-z_$][\w$]*)' does not exist on type '(?:[^']*&\s*)?([A-Za-z_$][\w$]*)/g)]
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
  if (/^on[A-Z]/.test(propertyName)) {
    return "() => void";
  }
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
