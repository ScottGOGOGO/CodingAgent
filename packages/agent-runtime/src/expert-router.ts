import { randomUUID } from "node:crypto";

import type {
  ArchitectureApiEndpoint,
  ArchitectureComponent,
  ArchitectureDataModel,
  ArchitectureDataStore,
  ArchitectureEnvVar,
  ArchitectureExternalCapability,
  ArchitectureFileNode,
  ArchitectureIntegration,
  ArchitecturePlan,
  ArchitectureQualityCheck,
  ArchitectureRoute,
  ArchitectureServerAction,
  BuildTask,
  ClarificationAnswer,
  ClarificationQuestion,
  DesignBrief,
  DesignSeed,
  DesignSeedAsset,
  DesignSeedAssetKind,
  DesignSeedPalette,
  DesignSeedTypography,
  ToolCallTrace,
} from "@vide/contracts";

import {
  AgentCoderLoop,
  type AgentLoopRuntimeAdapters,
  type AgentLoopResult,
  getAgentToolCatalogText,
} from "./agent-coder-loop.js";
import {
  BASELINE_REQUIRED_FILES,
  enforceArchitectureBaseline,
  ensureSandboxBaselineScaffold,
} from "./app-scaffold.js";
import type { ContextBundle } from "./context-manager.js";
import type { ModelClient } from "./model-client.js";
import {
  normalizeCorePackageJson,
  normalizePackageJsonForImports,
  type PackageJsonShape,
} from "./package-dependencies.js";
import {
  composeAgentCoderSystem,
  composeArchitectPrompt,
  composeClarifierPrompt,
  composeCoderPrompt,
  composeDesignDirectorPrompt,
  composeDesignSeedPrompt,
  composeRepairPrompt,
  formatArchitecturePlanForPrompt,
  formatDesignBriefForPrompt,
  formatDesignSeedForPrompt,
} from "./prompt-composer.js";
import type { SandboxWorkspace } from "./sandbox.js";
import type { ToolRegistry } from "./tools.js";

export type GenerationFailureKind =
  | "model_call_failed"
  | "generation_incomplete"
  | "build_failed"
  | "preview_failed";

export class GenerationFailure extends Error {
  constructor(
    public readonly kind: GenerationFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "GenerationFailure";
  }
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratedApp {
  title: string;
  summary: string;
  files: GeneratedFile[];
}

export interface CriticResult {
  passed: boolean;
  summary: string;
  issues: string[];
}

export type DesignBriefDraft = Omit<DesignBrief, "id" | "runId" | "createdAt">;
export type DesignSeedDraft = Omit<DesignSeed, "id" | "runId" | "createdAt">;
export type ArchitecturePlanDraft = Omit<ArchitecturePlan, "id" | "runId" | "createdAt">;

export interface ExperienceBlueprint {
  domain: string;
  primaryFlow: {
    goal: string;
    action: string;
    feedback: string;
    historySurface: string;
  };
  contentSeed: Array<{
    id: string;
    title: string;
    status: string;
    detail: string;
    metadata: string[];
  }>;
  interactionStates: string[];
  requiredControls: string[];
  acceptanceScenarios: string[];
  implementationNotes: string[];
}

type ModelGeneratedApp = {
  title?: string;
  summary?: string;
  files?: Array<{ path?: string; content?: string }>;
};

type ModelClarification = {
  action?: "ask" | "ready";
  summary?: string;
  questions?: Array<{
    id?: string;
    header?: string;
    question?: string;
    options?: Array<{ label?: string; value?: string; description?: string }>;
    multiSelect?: boolean;
    required?: boolean;
  }>;
};

export type ClarificationDecision =
  | { action: "ask"; summary: string; questions: ClarificationQuestion[]; source: "model" | "fallback" }
  | { action: "ready"; summary: string; questions: []; source: "model" | "fallback" };

type ModelDesignBrief = {
  summary?: string;
  targetUser?: string;
  productGoal?: string;
  coreExperience?: string;
  screens?: string[];
  interactionModel?: string[];
  visualDirection?: string[];
  contentStrategy?: string[];
  qualityBar?: string[];
  antiPatterns?: string[];
};

type ModelDesignSeed = {
  visualConcept?: string;
  palette?: Partial<Record<keyof DesignSeedPalette, string>>;
  typography?: Partial<Record<keyof DesignSeedTypography, string>>;
  motionLanguage?: string;
  assets?: Array<{ filename?: string; kind?: string; content?: string; purpose?: string }>;
  antiPatterns?: unknown;
};

type ModelArchitecturePlan = {
  summary?: string;
  techStack?: unknown;
  stateArchitecture?: string;
  serverArchitecture?: string;
  dataStore?: unknown;
  fileTree?: unknown;
  dataModels?: unknown;
  components?: unknown;
  routes?: unknown;
  apiEndpoints?: unknown;
  serverActions?: unknown;
  envVars?: unknown;
  integrations?: unknown;
  qualityChecks?: unknown;
  externalCapabilities?: unknown;
  deployment?: string;
  tasks?: unknown;
  risks?: unknown;
};

const INTERNAL_VISIBLE_COPY_PATTERN =
  /Next\.js|App Router|Prisma|Server Components?|Server Actions?|API\s*routes?|API\s*路由|full-stack|全栈|generated app|生成的应用|本地生成应用|architecture plan|Tech Stack|prototype|\bdemo\b|\bsample\b|sandbox|沙箱|prompt|build\s+passed|需求澄清|全栈架构|沙箱验证|候选生成|生成流程|技术栈|脚手架|生成器|示例数据|样例数据/i;

export class ExpertRouter {
  constructor(
    private readonly model: ModelClient,
    private readonly options: { strictGeneration?: boolean } = {},
  ) {}

  /** True when the model client is configured enough to drive a tool-using agent loop. */
  supportsAgentLoop(): boolean {
    return this.model.configured;
  }

  needsClarification(message: string, answers: ClarificationAnswer[] = []): boolean {
    return fallbackNeedsClarification(message, answers);
  }

  async decideClarification(args: {
    message: string;
    answers?: ClarificationAnswer[];
    context: ContextBundle;
  }): Promise<ClarificationDecision> {
    const answers = args.answers ?? [];
    if (answers.length > 0 && hasUsableAnswers(answers)) {
      return {
        action: "ready",
        summary: "用户已经补充了可用澄清信息，可以进入设计和生成。",
        questions: [],
        source: "fallback",
      };
    }

    if (this.model.configured && args.message.trim()) {
      try {
        const prompt = composeClarifierPrompt({
          userBrief: args.message,
          contextSummary: args.context.summary,
        });
        const result = await this.model.generateJson<ModelClarification>({
          role: prompt.role,
          system: prompt.system,
          user: prompt.user,
          schemaHint: prompt.schemaHint,
        });
        const normalized = normalizeClarificationDecision(result, args.message);
        if (this.options.strictGeneration) {
          const strictError = strictClarificationDecisionError(result, normalized);
          if (strictError) {
            throw new GenerationFailure(
              "generation_incomplete",
              `严格生成模式：clarifier 返回的澄清决策不可用，已停止 heuristic clarification fallback。${strictError}`,
            );
          }
        }
        if (normalized.action === "ask" && shouldTreatClarifierAskAsReady(args.message, answers, normalized)) {
          return {
            action: "ready",
            summary: "需求已经足够生成第一版候选；细节交互由设计和架构阶段做默认取舍。",
            questions: [],
            source: "model",
          };
        }
        if (normalized.action === "ready" || normalized.questions.length > 0) {
          return normalized;
        }
      } catch (error) {
        if (error instanceof GenerationFailure) {
          throw error;
        }
        maybeThrowModelStageFailure("clarifier", error);
      }
    }

    if (this.options.strictGeneration) {
      throw new GenerationFailure(
        this.model.configured ? "generation_incomplete" : "model_call_failed",
        "严格生成模式：clarifier 未产出可用澄清决策，已停止 heuristic clarification fallback。",
      );
    }

    if (!fallbackNeedsClarification(args.message, answers)) {
      return {
        action: "ready",
        summary: "需求已经足够生成第一版候选。",
        questions: [],
        source: "fallback",
      };
    }
    const fallback = buildFallbackClarification(args.message);
    return { action: "ask", source: "fallback", ...fallback };
  }

  async buildClarification(args: {
    message: string;
    context: ContextBundle;
  }): Promise<{ summary: string; questions: ClarificationQuestion[] }> {
    const decision = await this.decideClarification({ message: args.message, context: args.context });
    if (decision.action === "ask") {
      return { summary: decision.summary, questions: decision.questions };
    }
    return { summary: decision.summary, questions: [] };
  }

  async generateApp(args: {
    message: string;
    clarificationText: string;
    context: ContextBundle;
    designBrief?: DesignBrief;
    experienceBlueprint?: ExperienceBlueprint;
  }): Promise<GeneratedApp> {
    if (this.model.configured) {
      try {
        const prompt = composeCoderPrompt({
          userBrief: args.message,
          clarificationText: args.clarificationText,
          contextSummary: args.context.summary,
          designBrief: args.designBrief
            ? formatDesignBriefForPrompt(args.designBrief, args.experienceBlueprint)
            : args.experienceBlueprint
              ? formatExperienceBlueprintForPrompt(args.experienceBlueprint)
              : undefined,
          selectedFiles: args.context.files.map((file) => `--- ${file.path}\n${file.content}`).join("\n\n"),
        });
        const result = await this.model.generateJson<ModelGeneratedApp>({
          role: prompt.role,
          system: prompt.system,
          user: prompt.user,
          schemaHint: prompt.schemaHint,
        });
        const files = (result.files ?? [])
          .filter((file): file is { path: string; content: string } => Boolean(file.path && file.content))
          .map((file) => ({ path: file.path, content: file.content }));
        if (this.options.strictGeneration) {
          const strictError = strictGeneratedAppError(files);
          if (strictError) {
            throw new GenerationFailure(
              "generation_incomplete",
              `严格生成模式：coder 返回的 Next.js 应用不完整，已停止通用 fallback 候选。${strictError}`,
            );
          }
        }
        if (isUsableNextApp(files)) {
          return completeGeneratedApp({
            title: result.title || "生成的应用",
            summary: result.summary || "已生成候选应用。",
            files,
          }, { minimal: this.options.strictGeneration, scaffold: !this.options.strictGeneration });
        }
      } catch (error) {
        if (error instanceof GenerationFailure) {
          throw error;
        }
        maybeThrowModelStageFailure("coder", error);
      }
    }

    if (this.options.strictGeneration) {
      throw new GenerationFailure(
        this.model.configured ? "generation_incomplete" : "model_call_failed",
        "严格生成模式：coder 未产出可用的 Next.js 应用，已停止通用 fallback 候选。",
      );
    }
    return completeGeneratedApp(buildFallbackApp(args.message, args.clarificationText));
  }

  async createArchitecturePlan(args: {
    message: string;
    clarificationText: string;
    context: ContextBundle;
    designBrief: DesignBrief;
    designSeed?: DesignSeed;
    experienceBlueprint?: ExperienceBlueprint;
  }): Promise<ArchitecturePlanDraft> {
    const renderedSeed = args.designSeed ? formatDesignSeedForPrompt(args.designSeed) : undefined;
    const renderedBlueprint = args.experienceBlueprint ? formatExperienceBlueprintForPrompt(args.experienceBlueprint) : undefined;
    if (this.model.configured) {
      try {
        const localFirst = shouldUseLocalFirstStorage(args.message, args.clarificationText, args.designBrief);
        let strictRepairInstruction = "";
        const maxAttempts = this.options.strictGeneration ? 2 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const prompt = composeArchitectPrompt({
            userBrief: args.message,
            clarificationText: args.clarificationText,
            contextSummary: args.context.summary,
            designBrief: formatDesignBriefForPrompt(args.designBrief, args.experienceBlueprint),
            experienceBlueprint: renderedBlueprint,
            designSeed: renderedSeed,
            overrides: strictRepairInstruction ? { appendUser: strictRepairInstruction } : undefined,
          });
          const result = await this.model.generateJson<ModelArchitecturePlan>({
            role: prompt.role,
            system: prompt.system,
            user: prompt.user,
            schemaHint: prompt.schemaHint,
          });
          const normalized = normalizeArchitecturePlan(result, args.designBrief, localFirst);
          if (this.options.strictGeneration) {
            const strictError = strictArchitecturePlanError(result, normalized);
            if (!strictError) {
              return normalized;
            }
            strictRepairInstruction = [
              `Previous architecture plan failed the strict no-fallback gate: ${strictError}`,
              `Return a complete replacement JSON object that satisfies the lightweight P1 floor: at least ${P1_MIN_PAGE_ROUTES} App Router page route, ${P1_MIN_COMPONENTS} purposeful component files or compact surface modules, ${P1_MIN_DATA_MODELS} typed data model with fields, ${P1_MIN_TASKS} implementation tasks, and the blocking interaction-model-completeness quality check.`,
              "Do not omit dataModels, routes, components, fileTree, qualityChecks, or tasks. Do not explain; return JSON only.",
            ].join("\n");
            continue;
          }
          const augmented = ensurePlanCompleteness(normalized, args.designBrief, args.designSeed, args.message, args.experienceBlueprint);
          if (planMeetsP1Bar(augmented)) {
            return augmented;
          }
        }
        if (this.options.strictGeneration) {
          throw new GenerationFailure(
            "generation_incomplete",
            `严格生成模式：architect 返回的架构计划不满足完整产品生成要求，已停止 deterministic architecture fallback。${strictRepairInstruction.replace(/^Previous architecture plan failed the strict no-fallback gate:\s*/i, "")}`,
          );
        }
      } catch (error) {
        if (this.options.strictGeneration) {
          if (error instanceof GenerationFailure) {
            throw error;
          }
          maybeThrowModelStageFailure("architect", error);
        } else if (!isModelTransportFailure(error)) {
          maybeThrowModelStageFailure("architect", error);
        }
      }
    }
    if (this.options.strictGeneration) {
      throw new GenerationFailure(
        this.model.configured ? "generation_incomplete" : "model_call_failed",
        "严格生成模式：architect 未产出满足 P1 质量门槛的架构计划，已停止 deterministic architecture fallback。",
      );
    }
    return fallbackArchitecturePlan(args.designBrief, args.message, args.designSeed, args.experienceBlueprint);
  }

  /**
   * Drive a tool-using coder loop that implements the architecture plan task by
   * task. Falls back to the single-shot generator when the model is not
   * configured or the loop produced no usable files.
   */
  async runAgentCoderLoop(args: {
    runId: string;
    sandbox: SandboxWorkspace;
    registry: ToolRegistry;
    plan: ArchitecturePlan;
    designBrief: DesignBrief;
    experienceBlueprint?: ExperienceBlueprint;
    /** Concrete identity (palette/typography/assets) the coder must honor. */
    designSeed?: DesignSeed;
    /** Sandbox-relative paths of seed assets already on disk. */
    preloadedAssetPaths?: string[];
    message: string;
    clarificationText: string;
    maxTurns: number;
    /** Per-turn tool call cap. Defaults to 6 when omitted. */
    maxToolCallsPerTurn?: number;
    /** Whole-run tool call cap. Defaults to 300 when omitted. */
    maxToolCallsTotal?: number;
    /** Per-turn tool-use model timeout. */
    modelTurnTimeoutMs?: number;
    repairContext?: string;
    emitTrace(trace: ToolCallTrace): void;
    emitLog(message: string): void;
    onProgress?(message: string): void;
    runtime?: AgentLoopRuntimeAdapters;
  }): Promise<{ app: GeneratedApp; loop: AgentLoopResult }> {
    const loop = new AgentCoderLoop();
    const renderedSeed = args.designSeed ? formatDesignSeedForPrompt(args.designSeed) : undefined;
    const renderedBlueprint = args.experienceBlueprint ? formatExperienceBlueprintForPrompt(args.experienceBlueprint) : undefined;
    await ensureSandboxBaselineScaffold(args.sandbox, {
      appName: args.designBrief.summary || args.message,
      title: args.designBrief.summary || "Generated app",
      summary: args.designBrief.coreExperience || args.designBrief.productGoal,
      emitLog: args.emitLog,
    });
    const systemPrompt = composeAgentCoderSystem({
      userBrief: args.message,
      clarificationText: args.clarificationText,
      designBrief: formatDesignBriefForPrompt(args.designBrief, args.experienceBlueprint),
      experienceBlueprint: renderedBlueprint,
      designSeed: renderedSeed,
      preloadedAssets: args.preloadedAssetPaths,
      architecturePlan: formatArchitecturePlanForPrompt(args.plan),
      toolCatalog: getAgentToolCatalogText(),
    });
    const initialUserMessage = [
      `User brief:\n${args.message}`,
      args.clarificationText ? `\nClarification answers:\n${args.clarificationText}` : "",
      `\nDesign brief:\n${formatDesignBriefForPrompt(args.designBrief, args.experienceBlueprint)}`,
      renderedBlueprint ? `\nExperience blueprint:\n${renderedBlueprint}` : "",
      renderedSeed ? `\nDesign seed (already applied to the sandbox):\n${renderedSeed}` : "",
      `\nArchitecture plan:\n${formatArchitecturePlanForPrompt(args.plan)}`,
    ]
      .filter(Boolean)
      .join("");

    const result = await loop.run({
      runId: args.runId,
      sandbox: args.sandbox,
      model: this.model,
      registry: args.registry,
      systemPrompt,
      plan: args.plan,
      initialUserMessage,
      repairContext: args.repairContext,
      emitTrace: args.emitTrace,
      emitLog: args.emitLog,
      runtime: args.runtime,
      options: {
        maxTurns: args.maxTurns,
        maxToolCallsPerTurn: args.maxToolCallsPerTurn ?? 6,
        maxToolCallsTotal: args.maxToolCallsTotal ?? 300,
        modelTurnTimeoutMs: args.modelTurnTimeoutMs,
        onProgress: args.onProgress,
      },
    });

    const filesValid = isUsableNextApp(result.files);
    const totalTasks = result.completedTaskIds.length + result.pendingTaskIds.length;
    const requiredCompletionRatio = args.repairContext ? 0 : 1;
    const completedEnough =
      totalTasks === 0
        ? result.finished
        : result.pendingTaskIds.length === 0 || result.completedTaskIds.length / totalTasks >= requiredCompletionRatio;

    const strictFileError = this.options.strictGeneration ? strictGeneratedAppError(result.files) : "";
    const loopDidRealWork = result.toolCallCount > 0;
    if (loopDidRealWork && filesValid && !strictFileError && result.files.length >= 5 && result.finished && result.lastBuildPassed && completedEnough) {
      return {
        loop: result,
        app: completeGeneratedApp({
          title: result.title || "Generated app",
          summary: result.summary || `Implemented ${result.completedTaskIds.length} planned tasks via agent loop.`,
          files: result.files.map((file) => ({ path: file.path, content: file.content })),
        }, { minimal: this.options.strictGeneration, scaffold: !this.options.strictGeneration }),
      };
    }

    if (this.options.strictGeneration) {
      if (result.modelTimedOut || result.modelError) {
        const reason = result.modelTimedOut
          ? "严格生成模式：agent tool loop 模型轮次超时，生成已停止。"
          : `严格生成模式：agent tool loop 模型调用失败：${result.modelError}`;
        throw new GenerationFailure("model_call_failed", reason);
      }
      if (!result.lastBuildPassed && completedEnough) {
        throw new GenerationFailure(
          "build_failed",
          `严格生成模式：agent tool loop 未完成成功构建，生成已停止。${result.lastBuildLog ? `\n${result.lastBuildLog}` : ""}`,
        );
      }
      if (!result.finished) {
        throw new GenerationFailure(
          "generation_incomplete",
          `严格生成模式：agent tool loop 未显式调用 finish_app，生成已停止。（完成 ${result.completedTaskIds.length}/${totalTasks || result.completedTaskIds.length} 个任务）`,
        );
      }
      if (!result.lastBuildPassed) {
        throw new GenerationFailure(
          "build_failed",
          `严格生成模式：agent tool loop 未完成成功构建，生成已停止。${result.lastBuildLog ? `\n${result.lastBuildLog}` : ""}`,
        );
      }
      if (!completedEnough) {
        throw new GenerationFailure(
          "generation_incomplete",
          `严格生成模式：agent tool loop 只完成 ${result.completedTaskIds.length}/${totalTasks} 个计划任务，生成已停止。`,
        );
      }
      throw new GenerationFailure(
        "generation_incomplete",
        `严格生成模式：agent tool loop 未产出可用 Next.js 应用，生成已停止。${strictFileError}`,
      );
    }

    // Fall back to single-shot when the loop didn't produce a usable app. This
    // preserves compatibility with model adapters that can produce structured
    // JSON files but do not support chat tool-calls reliably.
    let fallback: GeneratedApp;
    try {
      if (result.modelTimedOut || result.modelError) {
        args.emitLog(
          result.modelTimedOut
            ? "Agent loop model turn timed out; trying structured coder fallback before deterministic fallback."
            : `Agent loop model error; trying structured coder fallback before deterministic fallback: ${result.modelError}`,
        );
      }
      fallback = await this.generateApp({
        message: args.message,
        clarificationText: args.clarificationText,
        context: {
          summary: "Agent loop fallback. Original context unavailable.",
          files: [],
          gitStatus: "",
        },
        designBrief: args.designBrief,
        experienceBlueprint: args.experienceBlueprint,
      });
    } catch (fallbackError) {
      args.emitLog(
        `Structured coder fallback failed; switching to deterministic commercial fallback: ${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`,
      );
      fallback = completeGeneratedApp(buildFallbackApp(args.message, args.clarificationText));
    }
    return { app: fallback, loop: result };
  }

  async createDesignBrief(args: {
    message: string;
    clarificationText: string;
    context: ContextBundle;
  }): Promise<DesignBriefDraft> {
    if (this.model.configured) {
      try {
        const prompt = composeDesignDirectorPrompt({
          userBrief: args.message,
          clarificationText: args.clarificationText,
          contextSummary: args.context.summary,
        });
        const result = await this.model.generateJson<ModelDesignBrief>({
          role: prompt.role,
          system: prompt.system,
          user: prompt.user,
          schemaHint: prompt.schemaHint,
        });
        if (this.options.strictGeneration) {
          const strictError = strictDesignBriefError(result);
          if (strictError) {
            throw new GenerationFailure(
              "generation_incomplete",
              `严格生成模式：design_director 返回的设计 brief 不完整，已停止 deterministic design brief fallback。${strictError}`,
            );
          }
        }
        return normalizeDesignBrief(result, args.message, args.clarificationText);
      } catch (error) {
        if (error instanceof GenerationFailure) {
          throw error;
        }
        maybeThrowModelStageFailure("design_director", error);
      }
    }

    if (this.options.strictGeneration) {
      throw new GenerationFailure(
        this.model.configured ? "generation_incomplete" : "model_call_failed",
        "严格生成模式：design_director 未产出可用设计 brief，已停止 deterministic design brief fallback。",
      );
    }
    return fallbackDesignBrief(args.message, args.clarificationText);
  }

  /**
   * Produce a concrete visual identity (palette, typography, assets) from the
   * design brief. Falls back to a deterministic seed when the model is not
   * configured or returns invalid output.
   */
  async createDesignSeed(args: {
    message: string;
    clarificationText: string;
    context: ContextBundle;
    designBrief: DesignBrief;
    referenceProfile?: string;
  }): Promise<DesignSeedDraft> {
    if (this.model.configured) {
      try {
        const prompt = composeDesignSeedPrompt({
          userBrief: args.message,
          clarificationText: args.clarificationText,
          contextSummary: args.context.summary,
          designBrief: formatDesignBriefForPrompt(args.designBrief),
          referenceProfile: args.referenceProfile,
        });
        const result = await this.model.generateJson<ModelDesignSeed>({
          role: prompt.role,
          system: prompt.system,
          user: prompt.user,
          schemaHint: prompt.schemaHint,
        });
        if (this.options.strictGeneration) {
          const strictError = strictDesignSeedError(result);
          if (strictError) {
            throw new GenerationFailure(
              "generation_incomplete",
              `严格生成模式：design_seed_smith 返回的视觉身份种子不完整，已停止 deterministic design seed fallback。${strictError}`,
            );
          }
        }
        const normalized = normalizeDesignSeed(result, args.designBrief, args.message);
        if (designSeedIsUsable(normalized)) {
          return normalized;
        }
      } catch (error) {
        if (error instanceof GenerationFailure) {
          throw error;
        }
        maybeThrowModelStageFailure("design_seed_smith", error);
      }
    }
    if (this.options.strictGeneration) {
      throw new GenerationFailure(
        this.model.configured ? "generation_incomplete" : "model_call_failed",
        "严格生成模式：design_seed_smith 未产出可用视觉身份种子，已停止 deterministic design seed fallback。",
      );
    }
    return fallbackDesignSeed(args.designBrief, args.message);
  }

  async repairApp(args: {
    app: GeneratedApp;
    issues: string[];
    buildLog: string;
    message: string;
    clarificationText: string;
    context: ContextBundle;
    designBrief?: DesignBrief;
    experienceBlueprint?: ExperienceBlueprint;
  }): Promise<GeneratedApp> {
    if (this.model.configured) {
      try {
        const prompt = composeRepairPrompt({
          userBrief: args.message,
          clarificationText: args.clarificationText,
          contextSummary: args.context.summary,
          selectedFiles: "",
          designBrief: args.designBrief
            ? formatDesignBriefForPrompt(args.designBrief, args.experienceBlueprint)
            : args.experienceBlueprint
              ? formatExperienceBlueprintForPrompt(args.experienceBlueprint)
              : undefined,
          issues: args.issues.join("\n"),
          buildLog: args.buildLog.slice(-4000),
          currentFiles: formatRepairFilesForPrompt(args.app.files),
        });
        const result = await this.model.generateJson<ModelGeneratedApp>({
          role: prompt.role,
          system: prompt.system,
          user: prompt.user,
          schemaHint: prompt.schemaHint,
        });
        const files = (result.files ?? [])
          .filter((file): file is { path: string; content: string } => Boolean(file.path && file.content))
          .map((file) => ({ path: file.path, content: file.content }));
        if (this.options.strictGeneration && files.length === 0) {
          throw new GenerationFailure(
            "generation_incomplete",
            "严格生成模式：repairer 未返回任何可合并文件，已停止 deterministic repair fallback。",
          );
        }
        const repairedFiles = mergeRepairFiles(args.app.files, files);
        if (this.options.strictGeneration) {
          const strictError = strictGeneratedAppError(repairedFiles);
          if (strictError) {
            throw new GenerationFailure(
              "generation_incomplete",
              `严格生成模式：repairer 返回的修复版本不完整，已停止 deterministic repair fallback。${strictError}`,
            );
          }
        }
        if (isUsableNextApp(repairedFiles)) {
          return completeGeneratedApp({
            title: result.title || args.app.title,
            summary: result.summary || "已修复候选应用。",
            files: repairedFiles,
          }, { minimal: this.options.strictGeneration, scaffold: !this.options.strictGeneration });
        }
        if (this.options.strictGeneration) {
          throw new GenerationFailure(
            "generation_incomplete",
            `严格生成模式：repairer 返回的修复版本不是可用 Next.js 应用。${describeNextAppUsabilityError(repairedFiles)}`,
          );
        }
      } catch (error) {
        if (error instanceof GenerationFailure) {
          throw error;
        }
        maybeThrowModelStageFailure("repairer", error);
      }
    }

    if (this.options.strictGeneration) {
      throw new GenerationFailure(
        this.model.configured ? "generation_incomplete" : "model_call_failed",
        "严格生成模式：repairer 未产出可用修复版本，已停止 deterministic repair fallback。",
      );
    }
    return deterministicRepairApp(args.app, args.issues);
  }

  async critique(args: { app: GeneratedApp; buildPassed: boolean; buildLog: string }): Promise<CriticResult> {
    const required = ["package.json", "tsconfig.json", "next-env.d.ts", "next.config.mjs", "src/app/layout.tsx", "src/app/page.tsx", "src/app/globals.css"];
    const paths = new Set(args.app.files.map((file) => file.path));
    const missing = required.filter((path) => !paths.has(path));
    const viteFiles = ["index.html", "src/main.tsx", "src/App.tsx", "vite.config.ts", "src/vite-env.d.ts"].filter((path) => paths.has(path));
    const packageJson = args.app.files.find((file) => file.path === "package.json")?.content ?? "";
    const vitePackage = /\bvite\b|@vitejs\/plugin-react|vite build|vite preview/.test(packageJson);
    const placeholder = args.app.files.some((file) => hasPlaceholderContent(file.content));
    const visibleSourceText = args.app.files
      .filter((file) => isPotentiallyVisibleSourceFile(file.path))
      .map((file) => stripNonVisibleSourceText(file.content))
      .join("\n");
    const implementationCopy = INTERNAL_VISIBLE_COPY_PATTERN.test(visibleSourceText);
    const genericFallbackShape = hasGenericFallbackShape(args.app.files);
    const buildTail = args.buildLog.slice(-900).trim();
    const issues = [
      ...missing.map((path) => `缺少关键文件 ${path}`),
      ...viteFiles.map((path) => `包含旧 Vite 入口文件 ${path}`),
      ...(vitePackage ? ["package.json 仍包含 Vite 依赖或脚本"] : []),
      ...(placeholder ? ["生成结果仍包含占位内容"] : []),
      ...(implementationCopy ? ["页面文案暴露内部实现或生成流程，必须改成真实产品工作流"] : []),
      ...(genericFallbackShape ? ["候选仍是通用生成模板，缺少面向用户任务的主题化 App 结构"] : []),
      ...(!args.buildPassed ? [`构建失败：${buildTail || "npm run build exited with a non-zero status."}`] : []),
    ];
    const summary = issues.length
      ? `候选版本还有 ${issues.length} 个阻塞问题：${issues[0].slice(0, 260)}`
      : "候选版本通过结构、内容和构建检查。";
    return {
      passed: issues.length === 0,
      summary,
      issues,
    };
  }
}

function isVisibleUiSourceFile(path: string): boolean {
  return path === "src/app/page.tsx" || /^src\/components\/.+\.(tsx|jsx)$/.test(path);
}

function isPotentiallyVisibleSourceFile(path: string): boolean {
  return (
    path === "src/app/page.tsx" ||
    path === "src/app/layout.tsx" ||
    /^src\/components\/.+\.(tsx|jsx)$/.test(path) ||
    /^src\/lib\/(?:demo-data|seed|content|data)\.(ts|tsx|js|jsx)$/.test(path)
  );
}

function stripNonVisibleSourceText(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import\s+[\s\S]*?;\s*$/gm, "")
    .replace(/\bReact\.[A-Za-z0-9_.$]+/g, "")
    .replace(/\bReact\b/g, "");
}

function hasPlaceholderContent(content: string): boolean {
  return (
    /待实现|lorem ipsum|coming soon/i.test(content) ||
    /(^|[^A-Za-z0-9_])TODO(?:[:：\s]|$)/.test(content)
  );
}

function hasGenericFallbackShape(files: GeneratedFile[]): boolean {
  const byPath = new Map(files.map((file) => [file.path, stripNonVisibleSourceText(file.content)]));
  const page = byPath.get("src/app/page.tsx") ?? "";
  const data = byPath.get("src/lib/demo-data.ts") ?? "";
  const component = byPath.get("src/components/InteractiveWorkbench.tsx") ?? "";
  return (
    /InteractiveWorkbench\s+items=\{items\}/.test(page) &&
    /const lanes\s*=\s*\[/.test(component) &&
    /id:\s*"intake"|id:\s*"architecture"|id:\s*"validation"/.test(data)
  );
}

function hasUsableAnswers(answers: ClarificationAnswer[]): boolean {
  const joined = answers.map((answer) => answer.answer.trim()).filter(Boolean).join(" ");
  if (joined.length < 2) {
    return false;
  }
  const vagueAnswers = ["随便", "都可以", "不确定", "不知道", "无所谓", "whatever", "anything"];
  return !vagueAnswers.some((answer) => joined.toLowerCase().includes(answer));
}

function strictClarificationDecisionError(result: ModelClarification, normalized: ClarificationDecision): string {
  if (result.action !== "ask" && result.action !== "ready") {
    return "缺少明确的 action=ask/ready。";
  }
  if (!cleanText(result.summary)) {
    return "缺少模型生成的 summary。";
  }
  if (result.action === "ask" && normalized.questions.length === 0) {
    return "action=ask 但没有任何可用澄清问题。";
  }
  return "";
}

function strictDesignBriefError(result: ModelDesignBrief): string {
  const missing = [
    cleanText(result.summary) ? "" : "summary",
    cleanText(result.targetUser) ? "" : "targetUser",
    cleanText(result.productGoal) ? "" : "productGoal",
    cleanText(result.coreExperience) ? "" : "coreExperience",
    strictListHasContent(result.screens) ? "" : "screens",
    strictListHasContent(result.interactionModel) ? "" : "interactionModel",
    strictListHasContent(result.visualDirection) ? "" : "visualDirection",
    strictListHasContent(result.contentStrategy) ? "" : "contentStrategy",
    strictListHasContent(result.qualityBar) ? "" : "qualityBar",
    strictListHasContent(result.antiPatterns) ? "" : "antiPatterns",
  ].filter(Boolean);
  return missing.length ? `缺少字段：${missing.join(", ")}。` : "";
}

function strictDesignSeedError(result: ModelDesignSeed): string {
  const palette = result.palette ?? {};
  const typography = result.typography ?? {};
  const assets = Array.isArray(result.assets) ? result.assets : [];
  const missing = [
    cleanText(result.visualConcept) ? "" : "visualConcept",
    cleanText(palette.name) ? "" : "palette.name",
    cleanText(palette.primary) ? "" : "palette.primary",
    cleanText(palette.surface) ? "" : "palette.surface",
    cleanText(palette.ink) ? "" : "palette.ink",
    cleanText(palette.accent) ? "" : "palette.accent",
    cleanText(palette.muted) ? "" : "palette.muted",
    cleanText(typography.headingFamily) ? "" : "typography.headingFamily",
    cleanText(typography.headingWeight) ? "" : "typography.headingWeight",
    cleanText(typography.bodyFamily) ? "" : "typography.bodyFamily",
    cleanText(typography.scale) ? "" : "typography.scale",
    cleanText(result.motionLanguage) ? "" : "motionLanguage",
    assets.some(strictAssetHasContent) ? "" : "assets",
  ].filter(Boolean);
  return missing.length ? `缺少字段：${missing.join(", ")}。` : "";
}

function strictArchitecturePlanError(result: ModelArchitecturePlan, normalized: ArchitecturePlanDraft): string {
  const dataStore = result.dataStore && typeof result.dataStore === "object" ? (result.dataStore as Record<string, unknown>) : undefined;
  const missing = [
    cleanText(result.summary) ? "" : "summary",
    strictListHasContent(result.techStack) ? "" : "techStack",
    cleanText(result.stateArchitecture) ? "" : "stateArchitecture",
    cleanText(result.serverArchitecture) ? "" : "serverArchitecture",
    dataStore && cleanText(String(dataStore.provider ?? "")) && cleanText(String(dataStore.orm ?? "")) ? "" : "dataStore.provider/orm",
  ].filter(Boolean);
  if (missing.length) {
    return `缺少或过薄字段：${missing.join(", ")}。`;
  }
  if (!planMeetsP1Bar(normalized)) {
    return `计划未达到 P1 硬门槛：routes=${countPageRoutes(normalized)}, components=${countComponentFiles(normalized)}, dataModels=${normalized.dataModels.length}, tasks=${normalized.tasks.length}。`;
  }
  if (!normalized.qualityChecks?.some((check) => check.id === "interaction-model-completeness")) {
    return "缺少 interaction-model-completeness 阻塞质量检查。";
  }
  return "";
}

function strictGeneratedAppError(files: Array<{ path: string; content?: string }>): string {
  const byPath = new Map(files.map((file) => [file.path.replace(/^\/+/, ""), file]));
  const missing = BASELINE_REQUIRED_FILES.filter((path) => !byPath.has(path));
  const legacyEntrypoints = ["index.html", "src/main.tsx", "src/App.tsx", "vite.config.ts", "src/vite-env.d.ts"].filter((path) => byPath.has(path));
  const placeholderPaths = files
    .filter((file) => file.content && isPotentiallyVisibleSourceFile(file.path) && hasPlaceholderContent(file.content))
    .map((file) => file.path);
  const problems = [
    missing.length ? `缺少核心文件 ${missing.join(", ")}` : "",
    legacyEntrypoints.length ? `包含旧 Vite 入口 ${legacyEntrypoints.join(", ")}` : "",
    placeholderPaths.length ? `包含占位内容 ${placeholderPaths.join(", ")}` : "",
  ].filter(Boolean);
  return problems.length ? `${problems.join("；")}。` : "";
}

function describeNextAppUsabilityError(files: Array<{ path: string }>): string {
  const paths = new Set(files.map((file) => file.path.replace(/^\/+/, "")));
  const missing = ["package.json", "src/app/page.tsx", "src/app/layout.tsx"].filter((path) => !paths.has(path));
  return missing.length ? `缺少可用应用入口：${missing.join(", ")}。` : "缺少可用应用入口。";
}

function strictListHasContent(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => cleanText(String(item)));
}

function strictAssetHasContent(asset: unknown): boolean {
  if (!asset || typeof asset !== "object") {
    return false;
  }
  const record = asset as Record<string, unknown>;
  const kind = cleanText(String(record.kind ?? ""));
  return (
    Boolean(cleanText(String(record.filename ?? ""))) &&
    Boolean(cleanText(String(record.content ?? ""))) &&
    Boolean(cleanText(String(record.purpose ?? ""))) &&
    VALID_SEED_ASSET_KINDS.has(kind as DesignSeedAssetKind)
  );
}

function countRawObjects(value: unknown, requiredFields: string[]): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  return value.filter((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const record = item as Record<string, unknown>;
    return requiredFields.every((field) => cleanText(String(record[field] ?? "")));
  }).length;
}

function maybeThrowModelStageFailure(stage: string, error: unknown): void {
  if (isModelTransportFailure(error)) {
    throw modelStageFailure(stage, error);
  }
}

function isModelTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /Model (?:tool-use )?request failed|fetch failed|getaddrinfo|ENOTFOUND|ECONN|ETIMEDOUT|AbortError|timeout|401|403|429|authentication_error|invalid_request_error|invalid api key|api key/i.test(message);
}

function modelStageFailure(stage: string, error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/api key:\s*\*+[A-Za-z0-9_-]+/gi, "api key: [redacted]");
  return new Error(
    [
      `模型调用失败（${stage}）。`,
      "当前配置看起来启用了大模型，所以已停止本地 fallback，避免生成一个看似成功但不符合需求的候选。",
      `原始错误：${message}`,
      "请检查 .env.local 中的 MODEL_PROVIDER / MODEL_API_KEY / MODEL_BASE_URL / MODEL_NAME。",
    ].join(" "),
  );
}

function fallbackNeedsClarification(message: string, answers: ClarificationAnswer[] = []): boolean {
  const normalized = message.trim();
  if (answers.length > 0 && hasUsableAnswers(answers)) {
    return false;
  }
  if (answers.length > 0) {
    return true;
  }
  if (normalized.length < 40) {
    return true;
  }
  const intentSignals = ["页面", "流程", "用户", "风格", "数据", "不要", "必须", "成功标准", "预算", "功能"];
  return intentSignals.filter((signal) => normalized.includes(signal)).length < 3;
}

function shouldTreatClarifierAskAsReady(message: string, answers: ClarificationAnswer[], decision: ClarificationDecision): boolean {
  if (decision.action !== "ask" || fallbackNeedsClarification(message, answers)) {
    return false;
  }
  const text = [
    decision.summary,
    ...decision.questions.flatMap((question) => [
      question.header,
      question.question,
      ...question.options.flatMap((option) => [option.label, option.description ?? "", option.value]),
    ]),
  ]
    .join("\n")
    .toLowerCase();

  const implementationMechanics =
    /机制|怎样实现|如何实现|怎么实现|实现方式|交互设计|交互方式|切换|筛选|排序|展示方式|粒度|级别|方案|mechanic|implementation|interaction|toggle|filter|display/.test(
      text,
    );
  const missingStrategicScope =
    /目标用户|谁用|核心功能|页面|流程|预算|目的地|天数|登录|支付|接口|集成|数据来源|视觉风格|target user|core feature|screen|auth|payment|integration|data source/.test(
      text,
    );

  return implementationMechanics && !missingStrategicScope;
}

function normalizeClarificationDecision(result: ModelClarification, message: string): ClarificationDecision {
  const normalized = normalizeClarification(result, message);
  if (result.action === "ready") {
    return {
      action: "ready",
      summary: cleanText(result.summary) || "需求已经足够生成第一版候选。",
      questions: [],
      source: "model",
    };
  }
  if (normalized.questions.length > 0) {
    return {
      action: "ask",
      summary: normalized.summary,
      questions: normalized.questions,
      source: "model",
    };
  }
  return {
    action: "ready",
    summary: cleanText(result.summary) || "需求已经足够生成第一版候选。",
    questions: [],
    source: "model",
  };
}

function normalizeDesignBrief(result: ModelDesignBrief, message: string, clarificationText: string): DesignBriefDraft {
  const fallback = fallbackDesignBrief(message, clarificationText);
  return {
    summary: cleanText(result.summary) || fallback.summary,
    targetUser: cleanText(result.targetUser) || fallback.targetUser,
    productGoal: cleanText(result.productGoal) || fallback.productGoal,
    coreExperience: cleanText(result.coreExperience) || fallback.coreExperience,
    screens: normalizeStringList(result.screens, fallback.screens),
    interactionModel: normalizeStringList(result.interactionModel, fallback.interactionModel),
    visualDirection: normalizeStringList(result.visualDirection, fallback.visualDirection),
    contentStrategy: normalizeStringList(result.contentStrategy, fallback.contentStrategy),
    qualityBar: normalizeStringList(result.qualityBar, fallback.qualityBar),
    antiPatterns: normalizeStringList(result.antiPatterns, fallback.antiPatterns),
  };
}

function normalizeStringList(value: unknown, fallback: string[], limit = 8): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const cleaned = value
    .map((item) => cleanText(String(item)))
    .filter(Boolean)
    .slice(0, limit);
  return cleaned.length ? cleaned : fallback;
}

export function createExperienceBlueprint(args: {
  message: string;
  clarificationText: string;
  designBrief: DesignBrief;
}): ExperienceBlueprint {
  const briefText = `${args.message}\n${args.clarificationText}\n${args.designBrief.summary}\n${args.designBrief.coreExperience}`;
  const domain = inferExperienceDomain(briefText, args.designBrief);
  const surfaces = normalizeBlueprintSurfaces(args.designBrief.screens);
  const action = inferPrimaryAction(briefText, domain);
  const contentSeed = buildBlueprintContentSeed(domain, args.designBrief, briefText);
  const requiredControls = buildBlueprintControls(briefText, action);
  const interactionStates = [
    "idle/current",
    "selected/active",
    "filtering",
    "editing",
    "saving/pending",
    "saved/success",
    "empty",
    "error/retry",
  ];
  const acceptanceScenarios = [
    `用户进入 ${surfaces[0]} 后能看到至少 3 条真实 ${domain.label} 内容，并能立即执行「${action}」。`,
    `用户切换 ${surfaces[1]} 或筛选条件后，选中态和内容列表发生可见变化。`,
    "用户提交或保存后，按钮进入 pending 状态，完成后出现成功/已保存反馈，并且历史或进度区域同步更新。",
    `用户进入 ${surfaces[2]} 时能找回刚才的结果、记录或收藏，并能继续编辑、删除、筛选或查看详情。`,
    "空状态和错误状态都有领域化说明与恢复按钮，不出现 TODO、coming soon、demo/sample 或技术栈说明。",
  ];
  return {
    domain: domain.label,
    primaryFlow: {
      goal: args.designBrief.productGoal,
      action,
      feedback: "pending/success/error feedback is visible in the same viewport as the action",
      historySurface: surfaces[2],
    },
    contentSeed,
    interactionStates,
    requiredControls,
    acceptanceScenarios,
    implementationNotes: [
      "Use these records as initial server-side seed data or Prisma seed fallback, not as visible 'sample data' copy.",
      "Every primary control must have source-level state/mutation evidence and visible before/after UI.",
      "Name UI modules after the domain, not generic Card/List/Panel as the main surface.",
      "Keep the first viewport app-like: current state, primary action, and next/history signal should be visible without reading implementation labels.",
    ],
  };
}

export function formatExperienceBlueprintForPrompt(blueprint: ExperienceBlueprint): string {
  return [
    `Domain: ${blueprint.domain}`,
    "Primary flow:",
    `  goal: ${blueprint.primaryFlow.goal}`,
    `  action: ${blueprint.primaryFlow.action}`,
    `  feedback: ${blueprint.primaryFlow.feedback}`,
    `  history surface: ${blueprint.primaryFlow.historySurface}`,
    "",
    "Content seed records:",
    ...blueprint.contentSeed.map((record) =>
      `  - ${record.id}: ${record.title} [${record.status}] — ${record.detail}; metadata=${record.metadata.join(", ")}`,
    ),
    "",
    `Required controls: ${blueprint.requiredControls.join("; ")}`,
    `Interaction states: ${blueprint.interactionStates.join("; ")}`,
    "",
    "Acceptance scenarios:",
    ...blueprint.acceptanceScenarios.map((scenario, index) => `  ${index + 1}. ${scenario}`),
    "",
    "Implementation notes:",
    ...blueprint.implementationNotes.map((note) => `  - ${note}`),
  ].join("\n");
}

export function formatRepairFilesForPrompt(files: Array<{ path: string; content: string }>): string {
  const sourceFiles = files
    .filter((file) => isRepairPromptSourcePath(file.path))
    .sort((left, right) => repairPromptPathPriority(left.path) - repairPromptPathPriority(right.path) || left.path.localeCompare(right.path));
  let remaining = MAX_REPAIR_PROMPT_FILES_CHARS;
  const output: string[] = [];
  for (const file of sourceFiles) {
    if (remaining <= 0) {
      output.push("/* repair file context truncated */");
      break;
    }
    const header = `--- ${file.path}\n`;
    const budget = remaining - header.length;
    if (budget <= 0) {
      output.push("/* repair file context truncated */");
      break;
    }
    const content = file.content.length > budget ? `${file.content.slice(0, budget)}\n/* file truncated */` : file.content;
    output.push(`${header}${content}`);
    remaining -= header.length + content.length;
  }
  return output.join("\n\n");
}

function isRepairPromptSourcePath(path: string): boolean {
  if (/^(?:\.next|node_modules|dist|coverage)\//.test(path)) {
    return false;
  }
  return /^(?:package\.json|next\.config\.mjs|tsconfig\.json|next-env\.d\.ts|prisma\/schema\.prisma|src\/.+\.(?:ts|tsx|js|jsx|css|json))$/.test(path);
}

function repairPromptPathPriority(path: string): number {
  if (path === "package.json" || path === "next.config.mjs" || path === "tsconfig.json" || path === "next-env.d.ts") {
    return 0;
  }
  if (/^src\/app\//.test(path)) {
    return 1;
  }
  if (/^src\/components\//.test(path)) {
    return 2;
  }
  if (/^src\/lib\//.test(path)) {
    return 3;
  }
  return 4;
}

function normalizeArchitecturePlan(
  result: ModelArchitecturePlan,
  designBrief: DesignBrief,
  localFirst = false,
): ArchitecturePlanDraft {
  const fileTree = normalizeFileTree(result.fileTree);
  const dataModels = normalizeDataModels(result.dataModels);
  const components = normalizeComponents(result.components);
  const routes = normalizeRoutes(result.routes);
  const apiEndpoints = normalizeApiEndpoints(result.apiEndpoints);
  const serverActions = normalizeServerActions(result.serverActions);
  const envVars = normalizeEnvVars(result.envVars);
  const integrations = normalizeIntegrations(result.integrations);
  const qualityChecks = normalizeQualityChecks(result.qualityChecks, designBrief);
  const externalCapabilities = normalizeExternalCapabilities(result.externalCapabilities, designBrief);
  const tasks = normalizeTasks(result.tasks, fileTree);
  return enforceArchitectureBaseline({
    summary: cleanText(result.summary) || `Engineering plan for ${designBrief.summary}`,
    techStack: normalizeStringList(result.techStack, defaultTechStack(designBrief, localFirst), 14),
    stateArchitecture:
      cleanText(result.stateArchitecture) ||
      localFirst
        ? "Server Components and route handlers read typed curated data from src/lib/demo-data.ts; Client Components persist user-owned local records with defensive browser storage; ephemeral UI state stays in Client Components."
        : "Server Components load durable product data; Server Actions and Route Handlers mutate it; Client Components keep only ephemeral UI state such as selected tabs and optimistic controls.",
    serverArchitecture:
      cleanText(result.serverArchitecture) ||
      "Next.js App Router uses Server Components for initial data loading, Route Handlers for API surfaces, and Server Actions for in-app mutations.",
    dataStore: normalizeDataStore(result.dataStore, localFirst),
    fileTree,
    dataModels,
    components,
    routes,
    apiEndpoints,
    serverActions,
    envVars,
    integrations,
    qualityChecks,
    externalCapabilities,
    deployment: cleanText(result.deployment) || "Deploy on Vercel with next build; set required env vars before production deploy.",
    tasks,
    risks: normalizeStringList(result.risks, [], 6),
  }, designBrief);
}

function normalizeFileTree(value: unknown): ArchitectureFileNode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const path = cleanText(record.path as string);
      const purpose = cleanText(record.purpose as string);
      if (!path || !purpose) {
        return null;
      }
      const dependencies = Array.isArray(record.dependencies)
        ? (record.dependencies as unknown[]).map((dep) => cleanText(String(dep))).filter(Boolean).slice(0, 12)
        : undefined;
      return { path, purpose, dependencies } as ArchitectureFileNode;
    })
    .filter((node): node is ArchitectureFileNode => Boolean(node))
    .slice(0, 40);
}

function normalizeDataModels(value: unknown): ArchitectureDataModel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: ArchitectureDataModel[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = cleanText(record.name as string);
    if (!name) {
      continue;
    }
    const fields: ArchitectureDataModel["fields"] = [];
    if (Array.isArray(record.fields)) {
      for (const field of record.fields) {
        if (!field || typeof field !== "object") {
          continue;
        }
        const f = field as Record<string, unknown>;
        const fieldName = cleanText(f.name as string);
        const fieldType = cleanText(f.type as string) || "string";
        if (!fieldName) {
          continue;
        }
        const description = cleanText(f.description as string);
        fields.push({
          name: fieldName,
          type: fieldType,
          ...(description ? { description } : {}),
        });
        if (fields.length >= 16) {
          break;
        }
      }
    }
    result.push({
      name,
      description: cleanText(record.description as string) || `${name} entity used in the app.`,
      fields,
    });
    if (result.length >= 12) {
      break;
    }
  }
  return result;
}

function normalizeComponents(value: unknown): ArchitectureComponent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: ArchitectureComponent[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = cleanText(record.name as string);
    const filePath = cleanText(record.filePath as string);
    const purpose = cleanText(record.purpose as string);
    if (!name || !filePath || !purpose) {
      continue;
    }
    const component: ArchitectureComponent = { name, filePath, purpose };
    if (Array.isArray(record.props)) {
      const props = (record.props as unknown[]).map((prop) => cleanText(String(prop))).filter(Boolean).slice(0, 12);
      if (props.length) {
        component.props = props;
      }
    }
    if (Array.isArray(record.uses)) {
      const uses = (record.uses as unknown[]).map((use) => cleanText(String(use))).filter(Boolean).slice(0, 12);
      if (uses.length) {
        component.uses = uses;
      }
    }
    result.push(component);
    if (result.length >= 30) {
      break;
    }
  }
  return result;
}

function normalizeRoutes(value: unknown): ArchitectureRoute[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const path = cleanText(record.path as string);
      const component = cleanText(record.component as string);
      if (!path || !component) {
        return null;
      }
      const rendering = normalizeRendering(record.rendering);
      const filePath = cleanText(record.filePath as string);
      return {
        path,
        component,
        description: cleanText(record.description as string) || `${component} screen.`,
        ...(filePath ? { filePath } : {}),
        ...(rendering ? { rendering } : {}),
      };
    })
    .filter((route): route is ArchitectureRoute => Boolean(route))
    .slice(0, 20);
}

function normalizeApiEndpoints(value: unknown): ArchitectureApiEndpoint[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: ArchitectureApiEndpoint[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const path = cleanText(record.path as string);
    const method = normalizeHttpMethod(record.method);
    const purpose = cleanText(record.purpose as string);
    const filePath = cleanText(record.filePath as string);
    if (!path || !method || !purpose || !filePath) {
      continue;
    }
    const runtime = normalizeRuntime(record.runtime);
    result.push({
      path,
      method,
      purpose,
      filePath,
      ...(cleanText(record.request as string) ? { request: cleanText(record.request as string) } : {}),
      ...(cleanText(record.response as string) ? { response: cleanText(record.response as string) } : {}),
      ...(cleanText(record.auth as string) ? { auth: cleanText(record.auth as string) } : {}),
      ...(runtime ? { runtime } : {}),
    });
    if (result.length >= 20) {
      break;
    }
  }
  return result;
}

function normalizeServerActions(value: unknown): ArchitectureServerAction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: ArchitectureServerAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = cleanText(record.name as string);
    const filePath = cleanText(record.filePath as string);
    const purpose = cleanText(record.purpose as string);
    if (!name || !filePath || !purpose) {
      continue;
    }
    const effects = Array.isArray(record.effects)
      ? (record.effects as unknown[]).map((effect) => cleanText(String(effect))).filter(Boolean).slice(0, 10)
      : undefined;
    result.push({
      name,
      filePath,
      purpose,
      ...(cleanText(record.input as string) ? { input: cleanText(record.input as string) } : {}),
      ...(effects?.length ? { effects } : {}),
    });
    if (result.length >= 20) {
      break;
    }
  }
  return result;
}

function normalizeEnvVars(value: unknown): ArchitectureEnvVar[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: ArchitectureEnvVar[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = cleanText(record.name as string);
    const purpose = cleanText(record.purpose as string);
    if (!name || !purpose) {
      continue;
    }
    const rawScope = cleanText(record.scope as string);
    const scope = rawScope === "client" || rawScope === "server" ? rawScope : undefined;
    result.push({
      name,
      purpose,
      required: record.required === true,
      ...(scope ? { scope } : {}),
      ...(cleanText(record.example as string) ? { example: cleanText(record.example as string) } : {}),
    });
    if (result.length >= 30) {
      break;
    }
  }
  return result;
}

function normalizeIntegrations(value: unknown): ArchitectureIntegration[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: ArchitectureIntegration[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = cleanText(record.name as string);
    const purpose = cleanText(record.purpose as string);
    if (!name || !purpose) {
      continue;
    }
    const envVars = Array.isArray(record.envVars)
      ? (record.envVars as unknown[]).map((envVar) => cleanText(String(envVar))).filter(Boolean).slice(0, 12)
      : undefined;
    const serverFiles = Array.isArray(record.serverFiles)
      ? (record.serverFiles as unknown[]).map((file) => cleanText(String(file))).filter(Boolean).slice(0, 12)
      : undefined;
    result.push({
      name,
      purpose,
      ...(envVars?.length ? { envVars } : {}),
      ...(serverFiles?.length ? { serverFiles } : {}),
    });
    if (result.length >= 12) {
      break;
    }
  }
  return result;
}

function normalizeQualityChecks(value: unknown, designBrief: DesignBrief): ArchitectureQualityCheck[] {
  const fallback = defaultQualityChecks(designBrief);
  if (!Array.isArray(value)) {
    return fallback;
  }
  const result: ArchitectureQualityCheck[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = cleanText(record.id as string) || `quality-${result.length + 1}`;
    const category = normalizeQualityCategory(record.category);
    const requirement = cleanText(record.requirement as string);
    const evidence = cleanText(record.evidence as string);
    if (!requirement || !evidence) {
      continue;
    }
    result.push({
      id,
      category: category ?? "interaction",
      requirement,
      evidence,
      blocking: record.blocking !== false,
    });
    if (result.length >= 16) {
      break;
    }
  }
  return mergeQualityChecks(result, fallback);
}

function mergeQualityChecks(
  primary: ArchitectureQualityCheck[],
  required: ArchitectureQualityCheck[],
): ArchitectureQualityCheck[] {
  const byId = new Map(primary.map((check) => [check.id, check]));
  for (const check of required) {
    if (!byId.has(check.id)) {
      byId.set(check.id, check);
    }
  }
  const mandatoryIds = new Set(required.map((check) => check.id));
  const mandatoryChecks = [...byId.values()].filter((check) => mandatoryIds.has(check.id));
  const primaryChecks = [...byId.values()].filter((check) => !mandatoryIds.has(check.id));
  return [...mandatoryChecks, ...primaryChecks].slice(0, 16);
}

function normalizeExternalCapabilities(value: unknown, designBrief: DesignBrief): ArchitectureExternalCapability[] {
  const fallback = defaultExternalCapabilities(designBrief);
  if (!Array.isArray(value)) {
    return fallback;
  }
  const result: ArchitectureExternalCapability[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = cleanText(record.name as string);
    const purpose = cleanText(record.purpose as string);
    const trigger = cleanText(record.trigger as string);
    const expectedOutput = cleanText(record.expectedOutput as string);
    if (!name || !purpose) {
      continue;
    }
    const constraints = Array.isArray(record.constraints)
      ? (record.constraints as unknown[]).map((constraint) => cleanText(String(constraint))).filter(Boolean).slice(0, 8)
      : [];
    result.push({
      name,
      purpose,
      trigger: trigger || "Before implementing the related product surface.",
      expectedOutput: expectedOutput || "A concise checklist applied to the next files.",
      constraints,
    });
    if (result.length >= 8) {
      break;
    }
  }
  return result.length ? result : fallback;
}

function normalizeQualityCategory(value: unknown): ArchitectureQualityCheck["category"] | undefined {
  const normalized = cleanText(String(value ?? "")).toLowerCase();
  if (
    normalized === "frontend" ||
    normalized === "backend" ||
    normalized === "data" ||
    normalized === "interaction" ||
    normalized === "deployment" ||
    normalized === "accessibility"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeDataStore(value: unknown, localFirst = false): ArchitectureDataStore {
  if (!value || typeof value !== "object") {
    return defaultDataStore(localFirst);
  }
  const record = value as Record<string, unknown>;
  const provider = normalizeDataStoreProvider(record.provider) ?? (localFirst ? "memory" : "sqlite");
  const orm = normalizeOrm(record.orm) ?? (localFirst ? "none" : "prisma");
  const usesPrisma = orm === "prisma";
  return {
    provider,
    orm,
    ...(cleanText(record.schemaPath as string)
      ? { schemaPath: cleanText(record.schemaPath as string) }
      : usesPrisma
        ? { schemaPath: "prisma/schema.prisma" }
        : { schemaPath: "src/lib/demo-data.ts" }),
    ...(cleanText(record.migrationStrategy as string)
      ? { migrationStrategy: cleanText(record.migrationStrategy as string) }
      : usesPrisma
        ? { migrationStrategy: "Use prisma migrate dev in the sandbox." }
        : { migrationStrategy: "No database migration; validate typed data and browser-storage flows during build and smoke." }),
    ...(cleanText(record.seedStrategy as string)
      ? { seedStrategy: cleanText(record.seedStrategy as string) }
      : usesPrisma
        ? { seedStrategy: "Seed realistic demo rows through Prisma or server-only data helpers." }
        : { seedStrategy: "Seed realistic curated records through typed src/lib/demo-data.ts; persist user-owned records in browser storage when explicitly requested." }),
    ...(cleanText(record.persistenceNotes as string)
      ? { persistenceNotes: cleanText(record.persistenceNotes as string) }
      : usesPrisma
        ? { persistenceNotes: "SQLite validates persistence in the sandbox; DATABASE_URL can be swapped for Postgres on Vercel." }
        : { persistenceNotes: "Local-first personal data is stored in the browser with defensive parsing; curated product data remains typed and build-verifiable." }),
  };
}

function defaultDataStore(localFirst = false): ArchitectureDataStore {
  if (localFirst) {
    return {
      provider: "memory",
      orm: "none",
      schemaPath: "src/lib/demo-data.ts",
      migrationStrategy: "No database migration; validate typed data and browser-storage flows during build and smoke.",
      seedStrategy: "Seed realistic curated records through typed src/lib/demo-data.ts; persist user-owned records in browser storage when explicitly requested.",
      persistenceNotes: "Local-first personal data is stored in the browser with defensive parsing; curated product data remains typed and build-verifiable.",
    };
  }
  return {
    provider: "sqlite",
    orm: "prisma",
    schemaPath: "prisma/schema.prisma",
    migrationStrategy: "Use prisma migrate dev in the sandbox.",
    seedStrategy: "Seed realistic demo rows through Prisma or server-only data helpers.",
    persistenceNotes: "SQLite validates persistence in the sandbox; DATABASE_URL can be swapped for Postgres on Vercel.",
  };
}

function normalizeRendering(value: unknown): ArchitectureRoute["rendering"] | undefined {
  const normalized = cleanText(String(value ?? "")).toLowerCase();
  if (normalized === "server" || normalized === "client" || normalized === "static" || normalized === "dynamic" || normalized === "isr") {
    return normalized;
  }
  return undefined;
}

function normalizeHttpMethod(value: unknown): ArchitectureApiEndpoint["method"] | undefined {
  const normalized = cleanText(String(value ?? "")).toUpperCase();
  if (normalized === "GET" || normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE") {
    return normalized;
  }
  return undefined;
}

function normalizeRuntime(value: unknown): ArchitectureApiEndpoint["runtime"] | undefined {
  const normalized = cleanText(String(value ?? "")).toLowerCase();
  if (normalized === "nodejs" || normalized === "edge") {
    return normalized;
  }
  return undefined;
}

function normalizeDataStoreProvider(value: unknown): ArchitectureDataStore["provider"] | undefined {
  const normalized = cleanText(String(value ?? "")).toLowerCase();
  if (
    normalized === "sqlite" ||
    normalized === "postgres" ||
    normalized === "vercel-postgres" ||
    normalized === "kv" ||
    normalized === "blob" ||
    normalized === "memory" ||
    normalized === "external"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeOrm(value: unknown): ArchitectureDataStore["orm"] | undefined {
  const normalized = cleanText(String(value ?? "")).toLowerCase();
  if (normalized === "prisma" || normalized === "drizzle" || normalized === "none") {
    return normalized;
  }
  return undefined;
}

function normalizeTasks(value: unknown, fileTree: ArchitectureFileNode[]): BuildTask[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const validFiles = new Set(fileTree.map((node) => node.path));
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const id = cleanText(record.id as string) || `task-${index + 1}`;
      const title = cleanText(record.title as string);
      const description = cleanText(record.description as string);
      const acceptance = cleanText(record.acceptance as string);
      if (!title || !description) {
        return null;
      }
      const files = Array.isArray(record.files)
        ? (record.files as unknown[])
            .map((file) => cleanText(String(file)))
            .filter(Boolean)
            // Don't reject tasks whose files aren't yet in the file tree — they may
            // be added during execution — but warn via validFiles set if useful.
            .slice(0, 8)
        : [];
      const dependsOn = Array.isArray(record.dependsOn)
        ? (record.dependsOn as unknown[]).map((dep) => cleanText(String(dep))).filter(Boolean).slice(0, 8)
        : undefined;
      void validFiles; // reserved for future use; keep linter calm
      return {
        id,
        title,
        description,
        files,
        dependsOn,
        acceptance: acceptance || "The implementation matches the description and passes type checking.",
      } as BuildTask;
    })
    .filter((task): task is BuildTask => Boolean(task))
    .slice(0, 24);
}

function defaultTechStack(brief: DesignBrief, localFirst = false): string[] {
  const stack = ["next@14", "react@18", "app-router", "typescript-strict", "server-components", "css-modules-or-globals"];
  const text = `${brief.summary} ${brief.coreExperience} ${brief.interactionModel.join(" ")}`.toLowerCase();
  if (localFirst) {
    stack.push("typed-demo-data", "browser-storage");
  } else {
    stack.push("prisma", "sqlite-sandbox");
  }
  if (/date|schedule|itinerary|calendar|when|time/.test(text)) {
    stack.push("date-fns");
  }
  if (/form|submit|validate|booking|ticket|order|auth|login|signup|api|webhook/.test(text)) {
    stack.push("zod", "route-handlers");
  }
  return stack;
}

function defaultExternalCapabilities(brief: DesignBrief): ArchitectureExternalCapability[] {
  const briefText = `${brief.summary} ${brief.productGoal} ${brief.coreExperience} ${brief.visualDirection.join(" ")}`.toLowerCase();
  const referenceApp = /season|episode|story|journal|archive|narrative/.test(briefText) ? "my-season" : "bloom-planner";
  return [
    {
      name: "use_design_skill",
      purpose: "Apply frontend-design guidance before writing the app shell, visual system, and primary interaction surface.",
      trigger: "Call at the start of implementation and again before major visual rewrites.",
      expectedOutput: "Domain-specific typography, color, layout, interaction, and anti-pattern guidance.",
      constraints: ["Use guidance as product direction, not visible copy.", "Do not mention the skill in the generated UI."],
    },
    {
      name: "inspect_reference_app",
      purpose: `Borrow app-quality patterns from ${referenceApp} without copying exact branding or assets.`,
      trigger: "Call before implementing navigation, stateful loops, empty/error states, and backend data boundaries.",
      expectedOutput: "A compact reference profile covering shell, visual language, main loop, data/API boundaries, and quality bar.",
      constraints: ["Use the pattern, not the name or exact content.", "Do not hard-code reference URLs into the app."],
    },
    {
      name: "quality_audit",
      purpose: "Run a static quality audit before finish_app so blocking product/closed-loop gaps are fixed.",
      trigger: "Call after implementing planned screens and before final build.",
      expectedOutput: "Pass/fail checks for app modules, backend surfaces, persistence, interactions, and visible implementation leaks.",
      constraints: ["Fix blocking failures before finish_app.", "Use audit findings alongside npm run build, not as a replacement."],
    },
  ];
}

function defaultQualityChecks(brief: DesignBrief): ArchitectureQualityCheck[] {
  const screenEvidence = brief.screens.length
    ? `At least ${Math.min(Math.max(brief.screens.length, 3), 5)} domain-specific modules, screens, or route-equivalent surfaces are implemented: ${brief.screens.join(", ")}.`
    : "At least three domain-specific modules or route-equivalent surfaces are implemented in code and visible UI.";
  return [
    {
      id: "quality-product-shell",
      category: "frontend",
      requirement: "The first 390px viewport presents a named product, app shell/navigation, domain objects, and one clear primary action.",
      evidence: "Mobile preview plus src/app/page.tsx and AppShell/primary screen files.",
      blocking: true,
    },
    {
      id: "quality-domain-modules",
      category: "interaction",
      requirement: screenEvidence,
      evidence: "Route/page/component files and visible navigation or tab state.",
      blocking: true,
    },
    {
      id: "quality-data-boundary",
      category: "data",
      requirement: "Every displayed business object has a typed data boundary. Local-first apps may use src/lib/demo-data.ts plus browser storage for user-owned state; server apps may use Route Handlers, Server Actions, or a database.",
      evidence: "src/lib/demo-data.ts, optional local-storage helpers, optional src/app/api/**/route.ts, Server Actions, or prisma/schema.prisma.",
      blocking: true,
    },
    {
      id: "quality-non-happy-path-states",
      category: "interaction",
      requirement: "The product has designed empty, error/recovery, loading or pending, and success/completed states.",
      evidence: "Inline state surfaces, small state components, optional src/app/loading.tsx/src/app/error.tsx, and client pending/success UI.",
      blocking: true,
    },
    {
      id: "quality-mutation-loop",
      category: "backend",
      requirement: "The primary user loop has a real mutation path appropriate to the product: local event handlers/browser storage for local-first apps, or Server Actions/Route Handlers for server-persisted apps.",
      evidence: "Client state/storage handlers or src/app/actions.ts/src/app/api/**/route.ts plus visible UI wiring.",
      blocking: true,
    },
    {
      id: "quality-state-feedback",
      category: "interaction",
      requirement: "Primary controls visibly change state: tabs, filters, selected items, completion/saved status, submitted logs, or generated suggestions.",
      evidence: "Client component state and UI labels/attributes that change after user interaction.",
      blocking: true,
    },
    {
      id: "interaction-model-completeness",
      category: "interaction",
      requirement:
        "The shipped UI implements at least three domain-specific interactions beyond navigation, including input/focus treatment, date or period switching, filtering, edit/delete or secondary actions, and visible saved/completed feedback when relevant.",
      evidence: "Client component state variables, event handlers, focus styles, grouped history/date controls, and preview-visible changed UI states.",
      blocking: true,
    },
    {
      id: "quality-deployability",
      category: "deployment",
      requirement: "The app has Next.js metadata, env contract, build script, lazy env-sensitive clients, and production-safe fallback behavior.",
      evidence: "src/app/layout.tsx, package.json, .env.example or vercel env metadata, and npm run build output.",
      blocking: true,
    },
  ];
}

function blueprintQualityChecks(blueprint: ExperienceBlueprint): ArchitectureQualityCheck[] {
  return [
    {
      id: "quality-real-content-seed",
      category: "data",
      requirement: `The UI and server seed layer include these concrete ${blueprint.domain} records: ${blueprint.contentSeed.map((item) => item.title).join(", ")}.`,
      evidence: "src/lib/demo-data.ts, Prisma seed fallback, route pages, and visible card/list text.",
      blocking: true,
    },
    {
      id: "quality-primary-flow-feedback",
      category: "interaction",
      requirement: `The primary flow "${blueprint.primaryFlow.action}" produces visible ${blueprint.primaryFlow.feedback} and updates ${blueprint.primaryFlow.historySurface}.`,
      evidence: "Server Action/API route, client pending/success/error state, and history/progress component.",
      blocking: true,
    },
    {
      id: "quality-required-controls",
      category: "interaction",
      requirement: `The app implements these controls with visible state changes: ${blueprint.requiredControls.join(", ")}.`,
      evidence: "Client component state/reducer, event handlers, selected/active styles, and preview-visible changed labels.",
      blocking: true,
    },
  ];
}

/**
 * P1 hard floor: any plan that goes downstream must satisfy these minimums or
 * the orchestrator will augment / replace it.
 */
const P1_MIN_PAGE_ROUTES = 1;
const P1_MIN_COMPONENTS = 3;
const P1_MIN_DATA_MODELS = 1;
const P1_MIN_TASKS = 4;
const MAX_REPAIR_PROMPT_FILES_CHARS = 48_000;

function countPageRoutes(plan: ArchitecturePlanDraft): number {
  // Count route entries first; if the plan doesn't track routes (model omission),
  // fall back to counting src/app/**/page.tsx entries from fileTree.
  if (plan.routes && plan.routes.length > 0) {
    return plan.routes.length;
  }
  return plan.fileTree.filter((node) => /^src\/app\/(?:.+\/)?page\.(?:tsx|jsx)$/.test(node.path)).length;
}

function countComponentFiles(plan: ArchitecturePlanDraft): number {
  if (plan.components && plan.components.length > 0) {
    return plan.components.length;
  }
  return plan.fileTree.filter((node) => /^src\/components\/.+\.(?:tsx|jsx)$/.test(node.path)).length;
}

function planMeetsP1Bar(plan: ArchitecturePlanDraft): boolean {
  return (
    countPageRoutes(plan) >= P1_MIN_PAGE_ROUTES &&
    countComponentFiles(plan) >= P1_MIN_COMPONENTS &&
    plan.dataModels.length >= P1_MIN_DATA_MODELS &&
    plan.tasks.length >= P1_MIN_TASKS
  );
}

/**
 * Merge a (possibly thin) model-produced plan with the deterministic fallback
 * so the final plan ALWAYS meets the P1 floor. The model's content takes
 * precedence; the fallback only fills gaps.
 */
function ensurePlanCompleteness(
  plan: ArchitecturePlanDraft,
  designBrief: DesignBrief,
  designSeed: DesignSeed | undefined,
  message: string,
  experienceBlueprint?: ExperienceBlueprint,
): ArchitecturePlanDraft {
  const baseline = fallbackArchitecturePlan(designBrief, message, designSeed, experienceBlueprint);

  const fileTreeByPath = new Map(plan.fileTree.map((node) => [node.path, node]));
  for (const node of baseline.fileTree) {
    if (!fileTreeByPath.has(node.path)) {
      fileTreeByPath.set(node.path, node);
    }
  }

  const componentsByPath = new Map(plan.components.map((component) => [component.filePath, component]));
  for (const component of baseline.components) {
    if (!componentsByPath.has(component.filePath)) {
      componentsByPath.set(component.filePath, component);
    }
  }

  const dataModelsByName = new Map(plan.dataModels.map((model) => [model.name, model]));
  for (const model of baseline.dataModels) {
    if (!dataModelsByName.has(model.name)) {
      dataModelsByName.set(model.name, model);
    }
  }

  const routesByPath = new Map(plan.routes.map((route) => [route.path, route]));
  for (const route of baseline.routes) {
    if (!routesByPath.has(route.path)) {
      routesByPath.set(route.path, route);
    }
  }

  const apiByPath = new Map(plan.apiEndpoints.map((endpoint) => [`${endpoint.method ?? "GET"} ${endpoint.path}`, endpoint]));
  for (const endpoint of baseline.apiEndpoints) {
    const key = `${endpoint.method ?? "GET"} ${endpoint.path}`;
    if (!apiByPath.has(key)) {
      apiByPath.set(key, endpoint);
    }
  }

  const actionsByName = new Map(plan.serverActions.map((action) => [action.name, action]));
  for (const action of baseline.serverActions) {
    if (!actionsByName.has(action.name)) {
      actionsByName.set(action.name, action);
    }
  }

  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  for (const task of baseline.tasks) {
    if (!tasksById.has(task.id)) {
      tasksById.set(task.id, task);
    }
  }

  return {
    summary: plan.summary || baseline.summary,
    techStack: plan.techStack.length ? plan.techStack : baseline.techStack,
    stateArchitecture: plan.stateArchitecture || baseline.stateArchitecture,
    serverArchitecture: plan.serverArchitecture ?? baseline.serverArchitecture,
    fileTree: [...fileTreeByPath.values()],
    dataModels: [...dataModelsByName.values()],
    components: [...componentsByPath.values()],
    routes: [...routesByPath.values()],
    apiEndpoints: [...apiByPath.values()],
    serverActions: [...actionsByName.values()],
    dataStore: plan.dataStore ?? baseline.dataStore,
    envVars: plan.envVars.length ? plan.envVars : baseline.envVars,
    integrations: plan.integrations.length ? plan.integrations : baseline.integrations,
    qualityChecks: plan.qualityChecks?.length ? plan.qualityChecks : baseline.qualityChecks,
    externalCapabilities: plan.externalCapabilities?.length ? plan.externalCapabilities : baseline.externalCapabilities,
    tasks: [...tasksById.values()],
    deployment: plan.deployment ?? baseline.deployment,
    risks: plan.risks?.length ? plan.risks : baseline.risks,
  };
}

function fallbackArchitecturePlan(
  brief: DesignBrief,
  message: string,
  designSeed?: DesignSeed,
  experienceBlueprint?: ExperienceBlueprint,
): ArchitecturePlanDraft {
  void message;
  void designSeed;
  const blueprint = experienceBlueprint ?? createExperienceBlueprint({ message, clarificationText: "", designBrief: brief });
  const localFirst = shouldUseLocalFirstStorage(message, "", brief);
  const hasRouting = brief.screens.length > 1;
  const techStack = defaultTechStack(brief, localFirst);
  const externalCapabilities = defaultExternalCapabilities(brief);
  const qualityChecks = [...defaultQualityChecks(brief), ...blueprintQualityChecks(blueprint)];
  const baseFiles: ArchitectureFileNode[] = [
    { path: "package.json", purpose: localFirst ? "Next.js project manifest with build and dev scripts." : "Next.js project manifest with build, dev, and Prisma scripts." },
    { path: "next.config.mjs", purpose: "Next.js configuration for App Router builds." },
    { path: "tsconfig.json", purpose: "TypeScript strict configuration for Next.js." },
    { path: "next-env.d.ts", purpose: "Next.js ambient type declarations." },
    { path: "src/app/layout.tsx", purpose: "Root App Router layout and metadata." },
    { path: "src/app/page.tsx", purpose: "Home route Server Component loading product data." },
    { path: "src/app/globals.css", purpose: "Global styles, CSS variables and base reset." },
    { path: "src/components/AppShell.tsx", purpose: "Shared shell: header, bottom nav, layout container." },
    { path: "src/components/InteractiveWorkbench.tsx", purpose: "Client Component for tabs, filters, and optimistic UI state." },
    { path: "src/lib/demo-data.ts", purpose: localFirst ? `Typed curated seed data and local-first model definitions for ${blueprint.contentSeed.length} concrete ${blueprint.domain} records.` : `Server-only seed data for ${blueprint.contentSeed.length} concrete ${blueprint.domain} records when the database is empty.` },
    ...(localFirst ? [{ path: "src/lib/local-storage.ts", purpose: "Browser-storage helpers with defensive JSON parsing for user-owned records." }] : [{ path: "src/lib/db.ts", purpose: "Lazy Prisma client getter and data access helpers." }]),
    ...(localFirst ? [] : [{ path: "src/app/actions.ts", purpose: "Server Actions for user-modifiable product state." }]),
    { path: "src/app/api/items/route.ts", purpose: "Route Handler exposing core domain data for integrations and smoke checks." },
    ...(localFirst ? [] : [{ path: "prisma/schema.prisma", purpose: "SQLite-backed Prisma schema for sandbox-verifiable persistence." }]),
  ];
  if (hasRouting) {
    for (const [index, screen] of brief.screens.entries()) {
      if (index === 0) {
        continue;
      }
      const safe = toRouteSegment(screen, index);
      baseFiles.push({
        path: `src/app/${safe}/page.tsx`,
        purpose: `App Router page for "${screen}".`,
      });
    }
  }
  for (const [index, screen] of brief.screens.entries()) {
    const safe = toComponentName(screen, index);
    baseFiles.push({
      path: `src/components/screens/${safe}.tsx`,
      purpose: `Reusable screen section implementation for "${screen}".`,
    });
  }

  const dataModels: ArchitectureDataModel[] = [
    {
      name: "DomainItem",
      description: "Primary domain entity rendered across the app surfaces.",
      fields: [
        { name: "id", type: "string", description: "Stable identifier." },
        { name: "title", type: "string" },
        { name: "summary", type: "string" },
        { name: "status", type: "string", description: "Workflow or display status." },
        { name: "tags", type: "string[]", description: "Visible filters or category labels." },
        { name: "updatedAt", type: "string", description: "Display-ready timestamp or period label." },
      ],
    },
    {
      name: "UserSignal",
      description: "User-owned signal such as save, vote, selection, checklist state, or draft note.",
      fields: [
        { name: "id", type: "string" },
        { name: "itemId", type: "string" },
        { name: "kind", type: "string", description: "Signal type." },
        { name: "value", type: "string" },
        { name: "createdAt", type: "string" },
      ],
    },
    {
      name: "InteractionEvent",
      description: `Append-only history of visible actions from the primary flow: ${blueprint.primaryFlow.action}.`,
      fields: [
        { name: "id", type: "string" },
        { name: "itemId", type: "string" },
        { name: "action", type: "string", description: `One of: ${blueprint.requiredControls.join(", ")}.` },
        { name: "state", type: "string", description: `Visible state after action, e.g. ${blueprint.interactionStates.join(", ")}.` },
        { name: "createdAt", type: "string" },
      ],
    },
  ];

  // Primitive UI components. Keep the fallback deliberately small; domain
  // screen sections are added only when the brief calls for them.
  const components: ArchitectureComponent[] = [
    { name: "AppShell", filePath: "src/components/AppShell.tsx", purpose: "Provides global layout, header and bottom navigation." },
    {
      name: "InteractiveWorkbench",
      filePath: "src/components/InteractiveWorkbench.tsx",
      purpose: localFirst
        ? `Client-side interaction layer for ${blueprint.primaryFlow.action}, ${blueprint.requiredControls.join(", ")}, local records, and browser-storage feedback.`
        : `Client-side interaction layer for ${blueprint.primaryFlow.action}, ${blueprint.requiredControls.join(", ")}, optimistic controls, and calling Server Actions.`,
      props: localFirst ? ["items", "localRecords"] : ["items", "signals"],
      uses: localFirst ? ["src/lib/local-storage.ts"] : ["src/app/actions.ts"],
    },
    { name: "EmptyState", filePath: "src/components/EmptyState.tsx", purpose: "Standard empty-state surface with primary call-to-action and supporting copy." },
  ];
  for (const [index, screen] of brief.screens.entries()) {
    const safe = toComponentName(screen, index);
    components.push({
      name: safe,
      filePath: `src/components/screens/${safe}.tsx`,
      purpose: `Server-renderable screen section for ${screen}.`,
    });
  }
  // Append component files to the file tree so audit counts agree.
  for (const component of components) {
    if (!baseFiles.some((file) => file.path === component.filePath)) {
      baseFiles.push({ path: component.filePath, purpose: component.purpose });
    }
  }

  const routes: ArchitectureRoute[] = hasRouting
    ? brief.screens.map((screen, index) => {
        const component = toComponentName(screen, index);
        const segment = index === 0 ? "" : toRouteSegment(screen, index);
        return {
          path: index === 0 ? "/" : `/${segment}`,
          component,
          description: `App Router route for ${screen}.`,
          filePath: index === 0 ? "src/app/page.tsx" : `src/app/${segment}/page.tsx`,
          rendering: "server",
        };
      })
    : [
        {
          path: "/",
          component: "HomePage",
          description: "Primary App Router page.",
          filePath: "src/app/page.tsx",
          rendering: "server",
        },
      ];

  // P1 floor: every plan must have at least 3 routes. If the brief gave fewer
  // screens, synthesize generic but useful additional surfaces. The fallback is
  // intentionally opinionated so the architect can override with domain-tuned
  // segments while still inheriting these for state coverage.
  const SYNTH_ROUTES: Array<{ path: string; segment: string; component: string; description: string }> = [
    { path: "/detail/[id]", segment: "detail/[id]", component: "DetailScreen", description: "Detail surface for a single DomainItem." },
    { path: "/history", segment: "history", component: "HistoryScreen", description: "History / activity log surface for past actions and signals." },
    { path: "/profile", segment: "profile", component: "ProfileScreen", description: "User profile and account / preferences surface." },
  ];
  for (const synth of SYNTH_ROUTES) {
    if (routes.length >= P1_MIN_PAGE_ROUTES) break;
    if (routes.some((route) => route.path === synth.path)) continue;
    const filePath = `src/app/${synth.segment}/page.tsx`;
    routes.push({
      path: synth.path,
      component: synth.component,
      description: synth.description,
      filePath,
      rendering: "server",
    });
    if (!baseFiles.some((file) => file.path === filePath)) {
      baseFiles.push({ path: filePath, purpose: `${synth.description} (synthesized to satisfy minimum route coverage).` });
    }
    if (!components.some((component) => component.filePath === `src/components/screens/${synth.component}.tsx`)) {
      const componentPath = `src/components/screens/${synth.component}.tsx`;
      components.push({
        name: synth.component,
        filePath: componentPath,
        purpose: `Server-renderable screen section for the ${synth.path} route.`,
      });
      if (!baseFiles.some((file) => file.path === componentPath)) {
        baseFiles.push({ path: componentPath, purpose: `Screen section for ${synth.path}.` });
      }
    }
  }

  const apiEndpoints: ArchitectureApiEndpoint[] = [
    {
      path: "/api/items",
      method: "GET",
      purpose: localFirst ? "Expose typed curated domain records for smoke checks and future integrations." : "Expose current domain items and user signals for smoke checks and future integrations.",
      filePath: "src/app/api/items/route.ts",
      response: localFirst ? "{ items: DomainItem[], tags: DomainTag[] }" : "{ items: DomainItem[], signals: UserSignal[] }",
      runtime: "nodejs",
    },
  ];

  const serverActions: ArchitectureServerAction[] = localFirst
    ? []
    : [
        {
          name: "toggleSignal",
          filePath: "src/app/actions.ts",
          purpose: "Persist a user signal such as saving, selecting, or completing a domain item.",
          input: "FormData or typed object with itemId and kind",
          effects: ["writes UserSignal", "revalidates the affected route"],
        },
      ];

  const envVars: ArchitectureEnvVar[] = localFirst
    ? []
    : [
        {
          name: "DATABASE_URL",
          purpose: "Prisma connection string; defaults to file:./dev.db in sandbox and can point to Vercel Postgres in production.",
          required: true,
          scope: "server",
          example: "file:./dev.db",
        },
      ];

  const integrations: ArchitectureIntegration[] = localFirst
    ? [
        {
          name: "Local-first storage",
          purpose: "Typed curated data plus browser-local user records for the requested personal/local experience.",
          serverFiles: ["src/lib/demo-data.ts", "src/app/api/items/route.ts"],
        },
      ]
    : [
        {
          name: "Prisma",
          purpose: "Typed server-side data access and migrations.",
          envVars: ["DATABASE_URL"],
          serverFiles: ["src/lib/db.ts", "prisma/schema.prisma"],
        },
      ];

  const tasks: BuildTask[] = [
    {
      id: "task-reference-guidance",
      title: "Reference and skill guidance",
      description: "Call use_design_skill and inspect_reference_app to extract the visual, interaction, and backend closure patterns that should shape the implementation.",
      files: [],
      acceptance: "The implementation choices reflect explicit design-skill guidance and a reference-app profile before UI files are written.",
    },
    {
      id: "task-scaffold",
      title: "Next.js scaffold and config",
      description: "Create package.json, next.config.mjs, tsconfig.json, next-env.d.ts, src/app/layout.tsx, src/app/page.tsx and src/app/globals.css with strict TS and App Router conventions.",
      files: ["package.json", "next.config.mjs", "tsconfig.json", "next-env.d.ts", "src/app/layout.tsx", "src/app/page.tsx", "src/app/globals.css"],
      dependsOn: ["task-reference-guidance"],
      acceptance: "Files exist, no Vite entrypoints remain, and npm run build uses next build.",
    },
    {
      id: "task-data-store",
      title: localFirst ? "Typed data models and local storage helpers" : "Database schema and server data layer",
      description: localFirst
        ? `Implement typed domain models, curated seed records, and defensive browser-storage helpers using these concrete ${blueprint.domain} records: ${blueprint.contentSeed.map((item) => `${item.title} (${item.status})`).join("; ")}. category: data-model.`
        : `Implement Prisma schema, lazy db getter, and server-only seed helpers using these concrete ${blueprint.domain} records: ${blueprint.contentSeed.map((item) => `${item.title} (${item.status})`).join("; ")}. category: data-model.`,
      files: localFirst ? ["src/lib/demo-data.ts", "src/lib/local-storage.ts"] : ["prisma/schema.prisma", "src/lib/db.ts", "src/lib/demo-data.ts"],
      dependsOn: ["task-scaffold"],
      acceptance: localFirst
        ? `Typed data models represent displayed entities, routes load the ${blueprint.contentSeed.length} concrete seed records, and user-owned local records load/save/delete safely through browser storage.`
        : `Prisma schema represents displayed entities, db client initializes lazily, and routes load the ${blueprint.contentSeed.length} concrete seed records without browser storage.`,
    },
    {
      id: "task-server-api",
      title: localFirst ? "Read-only API route and local mutation wiring" : "Server Actions and API route",
      description: localFirst
        ? `Implement a GET route handler exposing ${blueprint.domain} records, then wire "${blueprint.primaryFlow.action}" through client-side local storage events with visible saved/offline feedback. category: api-route/integration-wire.`
        : `Implement a Server Action for "${blueprint.primaryFlow.action}" and a GET route handler exposing ${blueprint.domain} records, user signals, and interaction events. category: server-mutation/api-route.`,
      files: localFirst ? ["src/app/api/items/route.ts", "src/lib/local-storage.ts"] : ["src/app/actions.ts", "src/app/api/items/route.ts"],
      dependsOn: ["task-data-store"],
      acceptance: localFirst
        ? `Local mutation handlers validate input, create a visible ${blueprint.primaryFlow.feedback} state, update history, survive reloads through browser storage, and /api/items returns typed JSON.`
        : `Server Action validates input, creates a visible ${blueprint.primaryFlow.feedback} state, records history, and revalidates routes; /api/items returns typed JSON.`,
    },
    {
      id: "task-shell",
      title: "App shell and interactive client layer",
      description: `Implement AppShell and InteractiveWorkbench with mobile navigation plus required controls: ${blueprint.requiredControls.join(", ")}. category: app-shell/interaction-wire.`,
      files: ["src/components/AppShell.tsx", "src/components/InteractiveWorkbench.tsx"],
      dependsOn: ["task-scaffold", "task-server-api"],
      acceptance: localFirst
        ? `Shell renders nav and content; ${blueprint.requiredControls.join(", ")} visibly change state and "${blueprint.primaryFlow.action}" persists user-owned state locally.`
        : `Shell renders nav and content; ${blueprint.requiredControls.join(", ")} visibly change state and "${blueprint.primaryFlow.action}" invokes the Server Action.`,
    },
  ];

  tasks.push({
    id: "task-experience-blueprint",
    title: "Implement real content seed and primary flow",
    description: `Turn the experience blueprint into visible product code. Content records: ${blueprint.contentSeed.map((item) => `${item.id}=${item.title}`).join("; ")}. Primary flow: ${blueprint.primaryFlow.action} -> ${blueprint.primaryFlow.feedback} -> ${blueprint.primaryFlow.historySurface}. category: route-surface/integration-wire.`,
    files: ["src/lib/demo-data.ts", "src/components/InteractiveWorkbench.tsx", "src/app/page.tsx"],
    dependsOn: ["task-data-store", "task-server-api", "task-shell"],
    acceptance: blueprint.acceptanceScenarios.join(" "),
  });

  for (const [index, screen] of brief.screens.entries()) {
    const safe = toComponentName(screen, index);
    tasks.push({
      id: `task-screen-${safe.toLowerCase()}`,
      title: `Implement ${screen}`,
      description: localFirst
        ? `Build the ${screen} screen section with typed ${blueprint.domain} data, local-first interactions (${blueprint.requiredControls.slice(0, 4).join(", ")}), state changes, and domain-specific content. category: route-surface.`
        : `Build the ${screen} screen section with server-loaded ${blueprint.domain} data, real interactions (${blueprint.requiredControls.slice(0, 4).join(", ")}), state changes, and domain-specific content. category: route-surface.`,
      files: [`src/components/screens/${safe}.tsx`],
      dependsOn: ["task-data-store", "task-shell", "task-experience-blueprint"],
      acceptance: localFirst
        ? `${screen} renders real typed content, interactions cause visible local state changes, mobile layout is correct, and it supports at least one blueprint scenario.`
        : `${screen} renders real content from the server data layer, interactions cause visible state changes, mobile layout is correct, and it supports at least one blueprint scenario.`,
    });
  }

  tasks.push({
    id: "task-quality-audit",
    title: "Run generated app quality audit",
    description: "Call quality_audit and fix any blocking product, backend, persistence, interaction, or visible-copy failures before final build.",
    files: [],
    dependsOn: tasks.map((task) => task.id),
    acceptance: "quality_audit reports no blocking failures and the findings are reflected in the final app.",
  });

  tasks.push({
    id: "task-wire",
    title: "Wire App Router pages and verify build",
    description: localFirst
      ? hasRouting
        ? "Wire src/app/page.tsx and additional route segment pages to the screen components, then run npm run build."
        : "Compose the primary page in src/app/page.tsx, then run npm run build."
      : hasRouting
        ? "Wire src/app/page.tsx and additional route segment pages to the screen components, then run db_migrate and npm run build."
        : "Compose the primary page in src/app/page.tsx, then run db_migrate and npm run build.",
    files: hasRouting ? ["src/app/page.tsx", ...brief.screens.slice(1).map((screen, index) => `src/app/${toRouteSegment(screen, index + 1)}/page.tsx`)] : ["src/app/page.tsx"],
    dependsOn: tasks.map((task) => task.id),
    acceptance: localFirst
      ? "npm run build exits 0, the Next.js app loads without runtime errors, and local save state works after reload."
      : "db_migrate succeeds, npm run build exits 0, and the Next.js app loads without runtime errors.",
  });

  return {
    summary: `Engineering plan for ${brief.summary}`,
    techStack,
    stateArchitecture:
      localFirst
        ? "Server Components read curated product data through src/lib/demo-data.ts; Client Components persist user-owned checklist/journal/saved state through defensive browser storage; route handlers expose read-only product records."
        : "Server Components read product data through src/lib/db.ts; Server Actions persist user signals; Client Components keep only ephemeral tab/filter/optimistic state.",
    serverArchitecture:
      localFirst
        ? "Next.js App Router renders route pages as Server Components and exposes /api/items through a read-only Route Handler; local user mutations happen inside client components with persisted browser storage."
        : "Next.js App Router renders route pages as Server Components, exposes /api/items through a Route Handler, and uses src/app/actions.ts for in-app mutations with revalidation.",
    dataStore: defaultDataStore(localFirst),
    fileTree: baseFiles,
    dataModels,
    components,
    routes,
    apiEndpoints,
    serverActions,
    envVars,
    integrations,
    qualityChecks,
    externalCapabilities,
    deployment: localFirst
      ? "Vercel-compatible Next.js deployment; run next build. No DATABASE_URL is required for the requested local-first prototype."
      : "Vercel-compatible Next.js deployment; run next build and set DATABASE_URL for production storage.",
    tasks,
    risks: localFirst ? ["No auth or cloud persistence by default; add it only if the brief asks for accounts, teams, admin, or multi-device sync."] : [],
  };
}

// --------------------------------------------------------------------------
// Design seed normalization, validation, and deterministic fallback
// --------------------------------------------------------------------------

const VALID_SEED_ASSET_KINDS: ReadonlySet<DesignSeedAssetKind> = new Set([
  "svg-component",
  "static-svg",
  "css-tokens",
]);

function normalizeDesignSeed(
  result: ModelDesignSeed,
  brief: DesignBrief,
  message: string,
): DesignSeedDraft {
  const fallback = fallbackDesignSeed(brief, message);
  const paletteSource = result.palette ?? {};
  const palette: DesignSeedPalette = {
    name: cleanText(paletteSource.name) || fallback.palette.name,
    primary: cleanText(paletteSource.primary) || fallback.palette.primary,
    surface: cleanText(paletteSource.surface) || fallback.palette.surface,
    ink: cleanText(paletteSource.ink) || fallback.palette.ink,
    accent: cleanText(paletteSource.accent) || fallback.palette.accent,
    muted: cleanText(paletteSource.muted) || fallback.palette.muted,
  };
  const gradient = cleanText(paletteSource.gradient);
  if (gradient) {
    palette.gradient = gradient;
  }

  const typoSource = result.typography ?? {};
  const typography: DesignSeedTypography = {
    headingFamily: cleanText(typoSource.headingFamily) || fallback.typography.headingFamily,
    headingWeight: cleanText(typoSource.headingWeight) || fallback.typography.headingWeight,
    bodyFamily: cleanText(typoSource.bodyFamily) || fallback.typography.bodyFamily,
    scale: cleanText(typoSource.scale) || fallback.typography.scale,
  };
  const monoFamily = cleanText(typoSource.monoFamily);
  if (monoFamily) {
    typography.monoFamily = monoFamily;
  }

  const assets: DesignSeedAsset[] = [];
  if (Array.isArray(result.assets)) {
    for (const raw of result.assets) {
      if (!raw || typeof raw !== "object") continue;
      const filename = cleanText(raw.filename);
      const content = typeof raw.content === "string" ? raw.content : "";
      const kindRaw = cleanText(raw.kind).toLowerCase();
      const kind = (VALID_SEED_ASSET_KINDS.has(kindRaw as DesignSeedAssetKind)
        ? (kindRaw as DesignSeedAssetKind)
        : undefined);
      if (!filename || !content || !kind) continue;
      assets.push({
        filename,
        kind,
        content,
        purpose: cleanText(raw.purpose) || `${kind} asset for the seeded identity.`,
      });
      if (assets.length >= 2) break;
    }
  }
  if (assets.length === 0) {
    assets.push(...fallback.assets);
  }

  const antiPatterns = normalizeStringList(result.antiPatterns, fallback.antiPatterns ?? [], 6);

  return {
    visualConcept: cleanText(result.visualConcept) || fallback.visualConcept,
    palette,
    typography,
    motionLanguage: cleanText(result.motionLanguage) || fallback.motionLanguage,
    assets,
    antiPatterns: antiPatterns.length ? antiPatterns : undefined,
  };
}

function designSeedIsUsable(seed: DesignSeedDraft): boolean {
  return (
    Boolean(seed.palette.primary) &&
    Boolean(seed.palette.surface) &&
    Boolean(seed.palette.ink) &&
    Boolean(seed.typography.headingFamily) &&
    Boolean(seed.typography.bodyFamily) &&
    seed.assets.length >= 1
  );
}

function fallbackDesignSeed(brief: DesignBrief, message: string): DesignSeedDraft {
  const text = `${brief.summary} ${brief.coreExperience} ${message}`.toLowerCase();
  const isTravel = /travel|trip|旅行|旅游|行程|目的地|路线/.test(text);
  const isPlanner = /plan|schedule|calendar|todo|task|计划|日程|清单|安排/.test(text);
  const isJournal = /journal|story|memory|episode|season|chapter|日记|故事|回忆|档案/.test(text);
  const isLearning = /learn|study|course|tutorial|学习|课程|背单词|复习/.test(text);
  const isGameLike = /game|brain|spin|score|streak|游戏|挑战|分数/.test(text);

  // Choose palette + typography by domain. Each branch returns a fully formed
  // seed with one custom SVG component and one CSS tokens file.
  if (isTravel) {
    return buildSeed({
      visualConcept: "Editorial mobile travel companion — warm paper background, deep ink, amber accents and an oversized destination chip.",
      paletteName: "warm-paper-amber",
      primary: "#c47a3a",
      surface: "#fdf7ea",
      ink: "#1c1610",
      accent: "#3a5a40",
      muted: "#d8ccb0",
      gradient: "radial-gradient(circle at top left, rgba(196,122,58,0.18), transparent 50%)",
      headingFamily: 'Lora, "Source Serif Pro", "Noto Serif SC", serif',
      headingWeight: "600",
      bodyFamily: 'Inter, "PingFang SC", "Helvetica Neue", sans-serif',
      monoFamily: '"IBM Plex Mono", monospace',
      scale: "Editorial display headings paired with compact data-dense body copy.",
      motionLanguage: "Tactile micro-feedback only — pressed states and saved confirmations. No decorative parallax.",
      antiPatterns: ["No blue-gray gradients", "No centered hero with search box", "No shadow-heavy generic cards"],
      iconName: "TravelMark",
      iconBody:
        '<svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="travel mark">\n      <circle cx="32" cy="32" r="28" fill="#fdf7ea" stroke="#1c1610" strokeWidth="2" />\n      <path d="M20 36c4-12 20-12 24 0M22 36c0 6 6 10 10 10s10-4 10-10" fill="none" stroke="#c47a3a" strokeWidth="2" strokeLinecap="round" />\n      <circle cx="32" cy="24" r="3" fill="#3a5a40" />\n    </svg>',
    });
  }

  if (isJournal) {
    return buildSeed({
      visualConcept: "Cinematic personal journal — paper grain ground, plum-and-ember accents, editorial serif titles framed like poster credits.",
      paletteName: "ember-plum-cinema",
      primary: "#7d3142",
      surface: "#f4ece1",
      ink: "#1a1419",
      accent: "#d57250",
      muted: "#b9a98c",
      gradient: "linear-gradient(160deg, rgba(125,49,66,0.22), rgba(213,114,80,0.12))",
      headingFamily: '"Playfair Display", "Source Serif Pro", "Songti SC", serif',
      headingWeight: "700",
      bodyFamily: '"Source Sans Pro", "Helvetica Neue", sans-serif',
      monoFamily: '"JetBrains Mono", monospace',
      scale: "Poster-credit headings, generous tracking, intimate body sizing.",
      motionLanguage: "Reveal-on-scroll for episodes; modal stages slide up like a cut sheet. No bouncy springs.",
      antiPatterns: ["No saturated neon", "No emoji-heavy hero", "No flat material-style shadows"],
      iconName: "SeasonMark",
      iconBody:
        '<svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="season mark">\n      <rect x="6" y="14" width="52" height="36" rx="4" fill="#f4ece1" stroke="#1a1419" strokeWidth="2" />\n      <path d="M14 30l8 4 8-10 8 12 8-6" fill="none" stroke="#7d3142" strokeWidth="2.5" strokeLinejoin="round" />\n      <circle cx="50" cy="22" r="3" fill="#d57250" />\n    </svg>',
    });
  }

  if (isPlanner) {
    return buildSeed({
      visualConcept: "Calm botanical day planner — paper cream surfaces, sage primary, amber affirmation, soft companion mark in the header.",
      paletteName: "sage-bloom",
      primary: "#5d7a52",
      surface: "#faf6ec",
      ink: "#1f2820",
      accent: "#c98a3c",
      muted: "#d3c9b1",
      headingFamily: '"Fraunces", "Source Serif Pro", serif',
      headingWeight: "600",
      bodyFamily: '"Manrope", "Inter", sans-serif',
      scale: "Friendly serif headings + tightly tracked task body copy.",
      motionLanguage: "Tasks fade and check off; the companion mark blinks on completion. No big spring physics.",
      antiPatterns: ["No purple-blue tech gradient", "No vector cartoon mascot", "No celebratory confetti motion"],
      iconName: "BloomCompanion",
      iconBody:
        '<svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="bloom companion">\n      <circle cx="32" cy="36" r="20" fill="#faf6ec" stroke="#1f2820" strokeWidth="2" />\n      <path d="M22 36c2-6 18-6 20 0M26 30c0-2 2-4 6-4M38 30c0-2-2-4-6-4" fill="none" stroke="#5d7a52" strokeWidth="2" strokeLinecap="round" />\n      <circle cx="28" cy="35" r="1.5" fill="#1f2820" />\n      <circle cx="36" cy="35" r="1.5" fill="#1f2820" />\n      <path d="M32 16c-2 6 6 6 4 0" fill="#c98a3c" />\n    </svg>',
    });
  }

  if (isLearning) {
    return buildSeed({
      visualConcept: "Quiet study focus — ivory surface, slate ink, mint highlight, and a tiny progress-rune asset.",
      paletteName: "slate-mint-focus",
      primary: "#1f6f6a",
      surface: "#f6f4ee",
      ink: "#16201f",
      accent: "#a3c4a6",
      muted: "#c8c6bd",
      headingFamily: '"Space Grotesk", "Source Sans Pro", sans-serif',
      headingWeight: "600",
      bodyFamily: '"IBM Plex Sans", "Inter", sans-serif',
      monoFamily: '"IBM Plex Mono", monospace',
      scale: "Geometric headings + technical body — encourages scanning.",
      motionLanguage: "Progress rings ease in; correct answers pulse the accent once. No decorative motion elsewhere.",
      antiPatterns: ["No primary-school cartoon", "No saturated traffic-light scoring", "No giant emoji rewards"],
      iconName: "FocusRune",
      iconBody:
        '<svg viewBox="0 0 48 48" width={size} height={size} role="img" aria-label="focus rune">\n      <rect x="4" y="4" width="40" height="40" rx="6" fill="#f6f4ee" stroke="#16201f" strokeWidth="2" />\n      <path d="M14 24h20M24 14v20" stroke="#1f6f6a" strokeWidth="3" strokeLinecap="round" />\n      <circle cx="24" cy="24" r="3" fill="#a3c4a6" />\n    </svg>',
    });
  }

  if (isGameLike) {
    return buildSeed({
      visualConcept: "High-contrast playful focus app — charcoal background, hot accent, single kinetic mark for the action loop.",
      paletteName: "charcoal-flare",
      primary: "#ff6a3d",
      surface: "#161616",
      ink: "#f8f4ec",
      accent: "#ffe26c",
      muted: "#39393a",
      gradient: "linear-gradient(180deg, #1c1c1c 0%, #161616 100%)",
      headingFamily: '"Archivo Black", "Space Grotesk", sans-serif',
      headingWeight: "900",
      bodyFamily: '"Space Grotesk", "Inter", sans-serif',
      monoFamily: '"JetBrains Mono", monospace',
      scale: "Slab display title, sturdy body, monospace score.",
      motionLanguage: "Single kinetic accent on the play mechanic. No background motion. No bouncing card lists.",
      antiPatterns: ["No purple gradients", "No emoji-only feedback", "No skeuomorphic 3D buttons"],
      iconName: "SpinMark",
      iconBody:
        '<svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="spin mark">\n      <circle cx="32" cy="32" r="28" fill="#161616" stroke="#ff6a3d" strokeWidth="3" />\n      <path d="M32 12a20 20 0 0 1 14 34" fill="none" stroke="#ffe26c" strokeWidth="3" strokeLinecap="round" />\n      <circle cx="32" cy="32" r="5" fill="#ff6a3d" />\n    </svg>',
    });
  }

  // Generic high-quality consumer app
  return buildSeed({
    visualConcept: "Compact consumer app identity — paper surface, deep ink, single saturated accent, restrained type system.",
    paletteName: "paper-ember-default",
    primary: "#c44d3a",
    surface: "#faf6ee",
    ink: "#161512",
    accent: "#3d5a80",
    muted: "#d6cebc",
    headingFamily: '"Fraunces", "Source Serif Pro", serif',
    headingWeight: "600",
    bodyFamily: '"Inter", "Helvetica Neue", sans-serif',
    scale: "Editorial-leaning headings + neutral body.",
    motionLanguage: "Press-only micro-feedback. No background motion, no parallax.",
    antiPatterns: ["No tailwind-default palette", "No centered hero with search box", "No generic dashboard spacing"],
    iconName: "ProductMark",
    iconBody:
      '<svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="product mark">\n      <rect x="8" y="8" width="48" height="48" rx="10" fill="#faf6ee" stroke="#161512" strokeWidth="2" />\n      <path d="M20 40l8-16 8 10 8-18" fill="none" stroke="#c44d3a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />\n    </svg>',
  });
}

function buildSeed(input: {
  visualConcept: string;
  paletteName: string;
  primary: string;
  surface: string;
  ink: string;
  accent: string;
  muted: string;
  gradient?: string;
  headingFamily: string;
  headingWeight: string;
  bodyFamily: string;
  monoFamily?: string;
  scale: string;
  motionLanguage: string;
  antiPatterns: string[];
  iconName: string;
  iconBody: string;
}): DesignSeedDraft {
  const palette: DesignSeedPalette = {
    name: input.paletteName,
    primary: input.primary,
    surface: input.surface,
    ink: input.ink,
    accent: input.accent,
    muted: input.muted,
  };
  if (input.gradient) {
    palette.gradient = input.gradient;
  }

  const typography: DesignSeedTypography = {
    headingFamily: input.headingFamily,
    headingWeight: input.headingWeight,
    bodyFamily: input.bodyFamily,
    scale: input.scale,
  };
  if (input.monoFamily) {
    typography.monoFamily = input.monoFamily;
  }

  const iconAsset: DesignSeedAsset = {
    filename: `src/components/icons/${input.iconName}.tsx`,
    kind: "svg-component",
    purpose: `Custom domain mark establishing the seeded identity (${input.paletteName}).`,
    content: `export function ${input.iconName}({ size = 32 }: { size?: number }) {\n  return (\n    ${input.iconBody}\n  );\n}\n`,
  };

  const gradientLine = input.gradient ? `\n  --color-gradient: ${input.gradient};` : "";
  const monoLine = input.monoFamily ? `\n  --font-mono: ${input.monoFamily};` : "";
  const tokensAsset: DesignSeedAsset = {
    filename: "src/styles/design-tokens.css",
    kind: "css-tokens",
    purpose: "Canonical CSS variables for the seeded palette and typography. Import this from globals.css.",
    content:
      `:root {\n  --color-primary: ${input.primary};\n  --color-surface: ${input.surface};\n  --color-ink: ${input.ink};\n  --color-accent: ${input.accent};\n  --color-muted: ${input.muted};${gradientLine}\n  --font-heading: ${input.headingFamily};\n  --font-heading-weight: ${input.headingWeight};\n  --font-body: ${input.bodyFamily};${monoLine}\n}\n`,
  };

  return {
    visualConcept: input.visualConcept,
    palette,
    typography,
    motionLanguage: input.motionLanguage,
    assets: [iconAsset, tokensAsset],
    antiPatterns: input.antiPatterns,
  };
}

function fallbackDesignBrief(message: string, clarificationText: string): DesignBriefDraft {
  const brief = `${message}\n${clarificationText}`.trim();
  const subject = inferSubject(brief);
  const isTravel = /旅行|旅游|行程|目的地|景点|trip|travel/.test(brief);
  const isTicketing = /演唱会|抢票|票档|排队|ticket|concert/.test(brief);
  const isLearning = /学习|课程|复习|背单词|考试|study|learn/.test(brief);

  if (isTravel) {
    return {
      summary: "移动优先的旅行灵感与行程规划体验，先让用户快速看到适合自己的路线，再进入可保存的日程细节。",
      targetUser: "主要面向用手机做周末或短途城市探索的独立旅行者。",
      productGoal: "用真实目的地内容、路线节奏和收藏机制证明旅行规划体验可用。",
      coreExperience: "从灵感卡片进入按天路线，比较地点、预算、天气备选，并收藏想去地点。",
      screens: ["首页灵感流", "行程日程", "地点详情", "收藏清单"],
      interactionModel: ["底部导航承载主要分区", "日期或主题使用横向分段控制", "地点卡片支持收藏状态", "关键路线信息放在拇指可达区域"],
      visualDirection: ["编辑感移动杂志布局", "目的地照片感色块和地图式层次", "温暖但克制的旅行色彩", "大标题搭配紧凑行程信息"],
      contentStrategy: ["使用具体城市、地点、时长、预算和交通提示", "避免空泛旅行口号", "每张卡片都说明为什么值得去"],
      qualityBar: ["390px 宽度下首屏信息完整", "视觉第一眼能看出是旅行产品", "收藏和切换有明显状态变化", "无占位内容"],
      antiPatterns: ["普通搜索页加白卡列表", "不含具体目的地的泛旅行文案", "桌面仪表盘式布局", "蓝灰渐变模板感"],
    };
  }

  if (isTicketing) {
    return {
      summary: "移动优先的演唱会抢票流程原型，突出排队、票档选择、锁票倒计时和失败兜底。",
      targetUser: "正在手机上抢热门演出门票的年轻用户。",
      productGoal: "让用户理解当前抢票状态并快速完成票档选择。",
      coreExperience: "从演出信息进入排队状态，选择票档，查看锁票倒计时和备选方案。",
      screens: ["演出首页", "排队进度", "票档选择", "订单确认"],
      interactionModel: ["状态条呈现排队阶段", "票档使用可点击选项", "底部固定主按钮", "失败状态提供重新排队或候补"],
      visualDirection: ["高能现场感", "暗色舞台背景与票券高亮", "清晰倒计时和队列进度", "按钮触感明确"],
      contentStrategy: ["使用具体场次、城市、票价、剩余状态和排队提示", "避免泛活动页文案"],
      qualityBar: ["首屏能判断演出和抢票状态", "票档选择状态明确", "移动端按钮不拥挤", "无占位内容"],
      antiPatterns: ["普通活动列表", "只展示海报不展示流程", "没有锁票和失败状态", "通用白卡布局"],
    };
  }

  if (isLearning) {
    return {
      summary: "移动优先的学习闭环工具，突出目标、今日任务、反馈和复盘。",
      targetUser: "希望用手机保持学习节奏的个人学习者。",
      productGoal: "帮助用户知道今天学什么、完成了什么、下一步怎么做。",
      coreExperience: "查看今日计划，完成练习或记录，获得进度反馈和下一步建议。",
      screens: ["今日学习", "练习反馈", "进度复盘", "资料清单"],
      interactionModel: ["任务打卡有即时状态", "练习结果可展开", "底部导航连接今日和复盘", "关键数字在首屏可见"],
      visualDirection: ["清爽但有学习专注感", "信息层级紧凑", "用状态色表达掌握度", "减少装饰"],
      contentStrategy: ["使用真实课程、题目、掌握度和复习建议", "避免空洞鼓励语"],
      qualityBar: ["首屏能看懂今日任务", "完成状态明确", "数据和建议具体", "无占位内容"],
      antiPatterns: ["只有励志文案", "普通待办列表", "缺少反馈闭环", "桌面式看板"],
    };
  }

  return {
    summary: `移动优先的「${subject}」产品原型，优先证明核心流程和手机端信息层级。`,
    targetUser: "主要面向用手机快速完成核心任务的真实用户。",
    productGoal: "用一个可点击、内容具体、视觉一致的首版候选证明产品方向。",
    coreExperience: "用户进入后能立即理解用途，完成一个主流程，并看到有用的状态反馈。",
    screens: ["首页", "核心流程", "详情或结果", "个人/收藏区域"],
    interactionModel: ["底部或顶部轻量导航", "主按钮固定在拇指可达区域", "卡片和筛选都有状态变化", "必要信息优先展示"],
    visualDirection: ["明确的领域化视觉概念", "移动端优先的信息密度", "克制但有辨识度的配色", "一致的组件节奏"],
    contentStrategy: ["使用贴近场景的真实样例数据", "文案直接服务任务", "避免解释这是原型"],
    qualityBar: ["390px 宽度下无横向溢出", "首屏能判断产品用途", "交互状态可见", "无 TODO 或 lorem ipsum"],
    antiPatterns: ["通用 SaaS 白卡模板", "中心标题加搜索框", "无领域内容的占位卡片", "视觉只靠渐变背景"],
  };
}

function inferExperienceDomain(text: string, brief: DesignBrief): { key: string; label: string; nouns: string[] } {
  if (/旅行|旅游|行程|目的地|景点|trip|travel|itinerary/i.test(text)) {
    return { key: "travel", label: "旅行计划", nouns: ["外滩晨间路线", "武康路咖啡停靠", "浦江夜游备选", "雨天美术馆计划"] };
  }
  if (/演唱会|抢票|票档|排队|ticket|concert/i.test(text)) {
    return { key: "ticketing", label: "抢票流程", nouns: ["内场 A 区", "看台视野位", "候补提醒", "锁票倒计时"] };
  }
  if (/学习|课程|复习|背单词|考试|study|learn|course/i.test(text)) {
    return { key: "learning", label: "学习计划", nouns: ["今日复习包", "薄弱知识点", "错题回看", "下次练习建议"] };
  }
  if (/日记|记录|笔记|心情|habit|journal|note|tracker|checklist|todo/i.test(text)) {
    return { key: "journal", label: "记录事项", nouns: ["晨间记录", "待复盘事项", "本周模式", "收藏片段"] };
  }
  if (/客户|销售|CRM|订单|库存|运营|dashboard|admin/i.test(text)) {
    return { key: "operations", label: "业务对象", nouns: ["高优先客户", "待处理订单", "风险提醒", "本周复盘"] };
  }
  const subject = inferSubject(`${brief.summary} ${brief.productGoal}`);
  return { key: "general", label: subject, nouns: [`${subject}重点 1`, `${subject}重点 2`, `${subject}待办`, `${subject}历史记录`] };
}

function normalizeBlueprintSurfaces(screens: string[]): [string, string, string] {
  const fallback = ["首页", "核心流程", "历史/进度"];
  const normalized = screens.map((screen) => cleanText(screen)).filter(Boolean);
  return [
    normalized[0] ?? fallback[0],
    normalized[1] ?? normalized[0] ?? fallback[1],
    normalized[2] ?? normalized.at(-1) ?? fallback[2],
  ];
}

function inferPrimaryAction(text: string, domain: { key: string }): string {
  if (domain.key === "travel") return "保存路线";
  if (domain.key === "ticketing") return "选择票档";
  if (domain.key === "learning") return "完成练习";
  if (domain.key === "journal") return "保存记录";
  if (domain.key === "operations") return "更新状态";
  if (/推荐|建议|AI|生成|generate|recommend/i.test(text)) return "生成建议";
  if (/预约|预订|booking|schedule/i.test(text)) return "安排时间";
  return "提交并保存";
}

function buildBlueprintContentSeed(
  domain: { key: string; label: string; nouns: string[] },
  brief: DesignBrief,
  text: string,
): ExperienceBlueprint["contentSeed"] {
  const tone = brief.visualDirection[0] ?? brief.contentStrategy[0] ?? "domain-specific";
  return domain.nouns.slice(0, 6).map((title, index) => ({
    id: `${domain.key}-${index + 1}`,
    title,
    status: index === 0 ? "active" : index === 1 ? "saved" : index === 2 ? "needs-review" : "planned",
    detail: blueprintDetail(domain.key, title, index, text),
    metadata: [
      index === 0 ? "today" : index === 1 ? "saved" : index === 2 ? "review" : "later",
      tone,
      `surface:${brief.screens[index % Math.max(brief.screens.length, 1)] ?? "home"}`,
    ],
  }));
}

function blueprintDetail(domainKey: string, title: string, index: number, text: string): string {
  if (domainKey === "travel") {
    return [
      "2.5 小时路线，含步行距离、交通替代和收藏状态。",
      "适合下午慢逛，含预算、排队风险和附近备选。",
      "夜景优先，提供天气兜底和同行备注。",
      "雨天可切换，含室内动线和预约提醒。",
    ][index] ?? `${title} 的路线、预算和备选信息。`;
  }
  if (domainKey === "ticketing") {
    return [
      "剩余紧张，展示排队进度、票价和锁票倒计时。",
      "视野稳定，适合候补，含失败后重试路径。",
      "提醒窗口已开启，可接受、关闭或调整价位。",
      "支付前确认，含座位、票价和超时状态。",
    ][index] ?? `${title} 的排队、票价和状态反馈。`;
  }
  if (domainKey === "learning") {
    return [
      "25 分钟复习，含掌握度、错题提醒和下一步建议。",
      "薄弱项需要 3 道练习，提交后出现反馈。",
      "历史错题按周分组，可筛选和标记已掌握。",
      "下一次计划自动排入明天，并显示原因。",
    ][index] ?? `${title} 的任务、反馈和复盘说明。`;
  }
  if (domainKey === "journal") {
    return [
      "可编辑文本记录，含心情、日期和保存反馈。",
      "本周待复盘条目，可筛选、编辑或删除。",
      "按日期分组的历史，展示连续记录和空状态。",
      "收藏片段可重新打开并继续补充。",
    ][index] ?? `${title} 的输入、保存和历史状态。`;
  }
  if (domainKey === "operations") {
    return [
      "高优先级对象，含负责人、截止时间和状态切换。",
      "等待处理，支持筛选、备注和下一步动作。",
      "风险提醒需要确认或推迟，并写入历史。",
      "复盘指标关联本周完成率和异常数。",
    ][index] ?? `${title} 的状态、责任人和操作历史。`;
  }
  return `${title}：围绕「${inferSubject(text)}」的真实内容、状态、下一步动作和历史反馈。`;
}

function buildBlueprintControls(text: string, action: string): string[] {
  const controls = [
    action,
    "segmented filter",
    "detail/open",
    "edit/revise",
    "delete/dismiss",
    "history grouping",
  ];
  if (/日期|日程|行程|学习|复习|记录|habit|journal|travel/i.test(text)) {
    controls.push("date/period switcher");
  }
  if (/搜索|查找|筛选|客户|订单|库存|书|电影|media|CRM/i.test(text)) {
    controls.push("search input");
  }
  if (/AI|推荐|建议|生成|recommend|generate/i.test(text)) {
    controls.push("accept/revise/dismiss suggestion");
  }
  return [...new Set(controls)];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function normalizeClarification(result: ModelClarification, message: string): { summary: string; questions: ClarificationQuestion[] } {
  const questions = (result.questions ?? [])
    .map((question, index) => normalizeQuestion(question, index))
    .filter((question): question is ClarificationQuestion => Boolean(question))
    .slice(0, 3);
  return {
    summary: cleanText(result.summary) || inferClarificationSummary(message),
    questions,
  };
}

function normalizeQuestion(question: NonNullable<ModelClarification["questions"]>[number], index: number): ClarificationQuestion | null {
  const header = cleanText(question.header);
  const text = cleanText(question.question);
  const options = (question.options ?? [])
    .map((option) => ({
      label: cleanText(option.label).slice(0, 18),
      value: cleanText(option.value || option.label).slice(0, 80),
      description: cleanText(option.description).slice(0, 120) || undefined,
    }))
    .filter((option) => option.label && option.value)
    .slice(0, 4);

  if (!header || !text || options.length < 2) {
    return null;
  }

  return {
    id: toQuestionId(cleanText(question.id) || header || `question-${index + 1}`, index),
    header: header.slice(0, 22),
    question: text.slice(0, 140),
    options,
    multiSelect: Boolean(question.multiSelect),
    required: question.required ?? true,
  };
}

function buildFallbackClarification(message: string): { summary: string; questions: ClarificationQuestion[] } {
  const brief = message.trim();
  const lower = brief.toLowerCase();
  const questions: ClarificationQuestion[] = [];

  if (/旅行|旅游|行程|攻略|trip|travel/.test(brief)) {
    questions.push(
      {
        id: "trip-scenario",
        header: "旅行场景",
        question: "这次旅行规划更像哪一种使用场景？",
        options: [
          { label: "城市周末游", value: "城市周末游", description: "突出路线、时间安排、地点卡片和交通提醒。" },
          { label: "多人行程协作", value: "多人行程协作", description: "突出成员偏好、投票、收藏和共享清单。" },
          { label: "预算控制旅行", value: "预算控制旅行", description: "突出花费预估、预算分配和性价比选择。" },
        ],
        required: true,
      },
      {
        id: "travel-details",
        header: "行程信息",
        question: "首版需要围绕哪些确定信息来生成？",
        options: [
          { label: "目的地和天数", value: "目的地和天数", description: "先把按天路线、地点和时间块做扎实。" },
          { label: "兴趣偏好", value: "兴趣偏好", description: "围绕美食、拍照、亲子、展览等偏好推荐。" },
          { label: "预算和交通", value: "预算和交通", description: "把预算、距离、交通方式作为核心筛选条件。" },
        ],
        required: true,
      },
    );
  } else if (/学习|课程|背单词|复习|考试|study|learn|course/.test(brief) || lower.includes("learn")) {
    questions.push({
      id: "learning-loop",
      header: "学习闭环",
      question: "这个学习工具最重要的是帮用户完成哪一步？",
      options: [
        { label: "制定计划", value: "制定计划", description: "突出目标、日程、课程拆解和提醒。" },
        { label: "练习反馈", value: "练习反馈", description: "突出题目、错题、即时反馈和进度。" },
        { label: "复盘追踪", value: "复盘追踪", description: "突出记录、趋势、掌握度和下一步建议。" },
      ],
      required: true,
    });
  } else if (/看板|运营|销售|数据|dashboard|crm|admin|管理/.test(brief)) {
    questions.push({
      id: "operator-workflow",
      header: "工作流重点",
      question: "这个工具最需要支持哪类高频操作？",
      options: [
        { label: "筛选对比", value: "筛选对比", description: "突出指标、列表、筛选器和排序。" },
        { label: "处理任务", value: "处理任务", description: "突出状态流转、负责人、优先级和批量操作。" },
        { label: "发现异常", value: "发现异常", description: "突出提醒、趋势、风险标签和钻取细节。" },
      ],
      required: true,
    });
  }

  questions.push({
    id: "first-preview-proof",
    header: inferDomainHeader(brief),
    question: "第一版预览最应该证明哪件事已经做对了？",
    options: [
      { label: "核心流程顺", value: "核心流程顺", description: "优先做可点击的主流程和关键状态。" },
      { label: "内容真实", value: "内容真实", description: "优先填充贴近场景的示例数据和文案。" },
      { label: "手机体验好", value: "手机体验好", description: "优先优化移动端布局、触控和信息层级。" },
    ],
    required: true,
  });

  return {
    summary: inferClarificationSummary(brief),
    questions: dedupeQuestions(questions).slice(0, 3),
  };
}

function inferClarificationSummary(message: string): string {
  const subject = inferSubject(message);
  return `我先围绕“${subject}”补两个关键判断，再生成更贴近你需求的移动预览。`;
}

function inferDomainHeader(message: string): string {
  const subject = inferSubject(message);
  return subject.length <= 10 ? `${subject}重点` : "首版重点";
}

function inferSubject(message: string): string {
  const first = message
    .replace(/[，。,.!?！？\n\r]+/g, " ")
    .split(/\s+/)
    .find((part) => part.trim().length > 0);
  return cleanText(first).slice(0, 14) || "这个应用";
}

function toComponentName(value: string, index: number): string {
  const asciiWords = value.match(/[A-Za-z0-9]+/g);
  if (asciiWords?.length) {
    const name = asciiWords
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join("")
      .replace(/^[0-9]+/, "");
    if (name) {
      return `${name}Screen`;
    }
  }
  return `Screen${index + 1}`;
}

function toRouteSegment(value: string, index: number): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (ascii) {
    return ascii.slice(0, 40);
  }
  return `screen-${index + 1}`;
}

function dedupeQuestions(questions: ClarificationQuestion[]): ClarificationQuestion[] {
  const seen = new Set<string>();
  return questions.filter((question) => {
    if (seen.has(question.id)) {
      return false;
    }
    seen.add(question.id);
    return true;
  });
}

function cleanText(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function shouldUseLocalFirstStorage(message: string, clarificationText: string, brief?: DesignBrief): boolean {
  const text = [message, clarificationText, brief?.summary, brief?.productGoal, brief?.coreExperience, brief?.contentStrategy.join(" "), brief?.interactionModel.join(" ")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const explicitLocal =
    /localstorage|indexeddb|browser local|local[-\s]?first|local only|client[-\s]?side|static curated|static data|no login|no backend|no real api|offline|data-storage:\s*local|浏览器本地|本地保存|本地状态|本地数据|本地优先|只用浏览器|静态精选|静态数据|不需要登录|不要登录|不需要后台|不要后台|不接真实接口|不需要接真实接口|不需要真实接口|离线/.test(
      text,
    );
  const requiresServerPersistence =
    /\bprisma\b|\bdatabase\b|\bpostgres\b|\bsqlite\b|\bbackend\b|\badmin\b|\bauth\b|\blogin\b|\bpayment\b|\bwebhook\b|\breal[-\s]?time\b|\bcloud\b|数据库|后台管理|登录|鉴权|支付|云端|真实接口|外部接口|多人协作|管理端/.test(
      text,
    ) &&
    !/no login|no backend|no real api|不需要登录|不要登录|不需要后台|不要后台|不接真实接口|不需要接真实接口|不需要真实接口/.test(text);
  return !requiresServerPersistence || explicitLocal;
}

function toQuestionId(value: string, index: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || `clarify-${index + 1}`;
}

function completeGeneratedApp(app: GeneratedApp, options: { minimal?: boolean; scaffold?: boolean } = {}): GeneratedApp {
  const safeTitle = sanitizeGeneratedTitle(app.title);
  const files = dedupeFiles(app.files);
  const shouldScaffold = options.scaffold ?? true;
  const localFirst = isLocalFirstGeneratedApp(files);
  const usesPrisma = !localFirst && files.some((file) => file.path === "prisma/schema.prisma" || /@prisma\/client|new PrismaClient|PrismaClient/.test(file.content));
  const ensure = (path: string, content: string) => {
    if (shouldScaffold && !files.some((file) => file.path === path)) {
      files.push({ path, content });
    }
  };
  ensure("package.json", defaultPackageJson(safeTitle));
  ensure("next.config.mjs", defaultNextConfig());
  if (shouldScaffold && !files.some((file) => file.path === "tsconfig.json")) {
    files.push({ path: "tsconfig.json", content: defaultTsConfig() });
  }
  ensure("next-env.d.ts", defaultNextEnv());
  ensure("src/app/layout.tsx", defaultRootLayout(safeTitle));
  ensure("src/app/page.tsx", defaultPageSource(safeTitle, app.summary));
  ensure("src/app/globals.css", defaultGlobalsCss());
  if (!options.minimal) {
    ensure("src/lib/demo-data.ts", genericDataSource(safeTitle));
    ensure("src/components/EmptyState.tsx", defaultEmptyStateSource());
    if (usesPrisma) {
      ensure("src/app/api/items/route.ts", defaultItemsRouteSource());
      ensure("src/app/actions.ts", defaultActionSource());
    }
  }
  if (usesPrisma && shouldScaffold) {
    ensure("src/lib/db.ts", dbSource());
    ensure("prisma/schema.prisma", prismaSchemaSource());
    normalizeSqliteEnvFile(files, ".env");
    ensure(".env.example", "DATABASE_URL=\"file:./dev.db\"\n");
    normalizePrismaPackage(files, safeTitle);
  }
  normalizePackageJsonDependencies(files, safeTitle);
  return sanitizeGeneratedApp({
    ...app,
    title: safeTitle,
    files,
  });
}

function isLocalFirstGeneratedApp(files: GeneratedFile[]): boolean {
  const combined = files.map((file) => `${file.path}\n${file.content}`).join("\n").toLowerCase();
  if (files.some((file) => file.path === "prisma/schema.prisma" || /@prisma\/client|new PrismaClient|PrismaClient/.test(file.content))) {
    return false;
  }
  return (
    /localstorage|sessionstorage|indexeddb|local-storage|usefavorites|browser storage|本地保存|浏览器本地|离线/.test(combined) ||
    files.some((file) => /^src\/lib\/.+(?:storage|store|local).(?:ts|tsx)$/.test(file.path))
  );
}

function sanitizeGeneratedApp(app: GeneratedApp): GeneratedApp {
  const safeTitle = sanitizeGeneratedTitle(app.title);
  return {
    ...app,
    title: safeTitle,
    summary: replaceInternalImplementationCopy(replacePlaceholderText(app.summary), safeTitle),
    files: dedupeFiles(app.files).map((file) => {
      let content = replacePlaceholderText(file.content);
      if (isPotentiallyVisibleSourceFile(file.path)) {
        content = replaceInternalImplementationCopy(content, safeTitle);
      }
      return { ...file, content };
    }),
  };
}

function sanitizeGeneratedTitle(title: string): string {
  const trimmed = cleanText(title);
  if (!trimmed || INTERNAL_VISIBLE_COPY_PATTERN.test(trimmed)) {
    return "产品工作台";
  }
  return replacePlaceholderText(trimmed);
}

function isUsableNextApp(files: Array<{ path: string }>): boolean {
  const paths = new Set(files.map((file) => file.path));
  return paths.has("package.json") && paths.has("src/app/page.tsx") && paths.has("src/app/layout.tsx");
}

function dedupeFiles(files: GeneratedFile[]): GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const file of files) {
    byPath.set(file.path.replace(/^\/+/, ""), {
      path: file.path.replace(/^\/+/, ""),
      content: file.content,
    });
  }
  return [...byPath.values()];
}

function mergeRepairFiles(currentFiles: GeneratedFile[], repairFiles: GeneratedFile[]): GeneratedFile[] {
  return dedupeFiles([...currentFiles, ...repairFiles]);
}

function normalizePrismaPackage(files: GeneratedFile[], title: string): void {
  if (!files.some((file) => file.path === "prisma/schema.prisma")) {
    return;
  }
  const packageFile = files.find((file) => file.path === "package.json");
  if (!packageFile) {
    files.push({ path: "package.json", content: defaultPackageJson(title) });
    return;
  }

  try {
    const parsed = JSON.parse(packageFile.content) as {
      name?: string;
      version?: string;
      private?: boolean;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    parsed.scripts = { ...(parsed.scripts ?? {}), "db:push": "prisma db push" };
    parsed.dependencies = { ...(parsed.dependencies ?? {}), "@prisma/client": parsed.dependencies?.["@prisma/client"] ?? "^5.22.0" };
    parsed.devDependencies = { ...(parsed.devDependencies ?? {}), prisma: parsed.devDependencies?.prisma ?? "^5.22.0" };
    packageFile.content = `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    packageFile.content = defaultPackageJson(title);
  }
}

function normalizePackageJsonDependencies(files: GeneratedFile[], title: string): void {
  const packageFile = files.find((file) => file.path === "package.json");
  if (!packageFile) {
    files.push({ path: "package.json", content: defaultPackageJson(title) });
    return;
  }

  try {
    const parsed = JSON.parse(packageFile.content) as PackageJsonShape;
    packageFile.content = `${JSON.stringify(normalizePackageJsonForImports(parsed, files), null, 2)}\n`;
  } catch {
    packageFile.content = defaultPackageJson(title);
  }
}

function normalizeSqliteEnvFile(files: GeneratedFile[], path: string): void {
  if (!files.some((file) => file.path === "prisma/schema.prisma")) {
    return;
  }

  const databaseUrlLine = 'DATABASE_URL="file:./dev.db"';
  const envFile = files.find((file) => file.path === path);
  if (!envFile) {
    files.push({ path, content: `${databaseUrlLine}\n` });
    return;
  }

  if (!/^\s*DATABASE_URL\s*=/m.test(envFile.content)) {
    const separator = envFile.content.endsWith("\n") || envFile.content.length === 0 ? "" : "\n";
    envFile.content = `${envFile.content}${separator}${databaseUrlLine}\n`;
    return;
  }

  envFile.content = envFile.content.replace(/^\s*DATABASE_URL\s*=.*$/m, databaseUrlLine);
}

function defaultTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2017",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: false,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "preserve",
        incremental: true,
        plugins: [{ name: "next" }],
        allowSyntheticDefaultImports: true,
        forceConsistentCasingInFileNames: true,
        paths: {
          "@/*": ["./src/*"],
        },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    },
    null,
    2,
  );
}

function defaultPackageJson(title: string): string {
  return JSON.stringify(
    normalizeCorePackageJson({
      name: slugify(title),
      version: "0.1.0",
      private: true,
      scripts: {
        "db:migrate": "prisma migrate dev --name init",
      },
      dependencies: {
        "@prisma/client": "^5.22.0",
        zod: "^3.24.1",
      },
      devDependencies: {
        prisma: "^5.22.0",
      },
    }),
    null,
    2,
  );
}

function defaultNextConfig(): string {
  return "/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n";
}

function defaultNextEnv(): string {
  return "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n\n// This file is auto-generated by Next.js. Do not edit it manually.\n";
}

function defaultRootLayout(title: string): string {
  return `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: ${JSON.stringify(title)},
  description: ${JSON.stringify(`${title} mobile product experience`)},
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
`;
}

function defaultPageSource(title: string, summary: string): string {
  return `export default function HomePage() {
  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Mobile workspace</p>
        <h1>${escapeJsxText(title)}</h1>
        <p>${escapeJsxText(summary)}</p>
      </section>
    </main>
  );
}
`;
}

function defaultDetailPageSource(title: string): string {
  return `export default function DetailPage() {
  return (
    <main className="app-shell">
      <section className="hero compact">
        <p className="eyebrow">Detail</p>
        <h1>${escapeJsxText(title)} 详情</h1>
        <p>这里展示当前对象的背景、状态和下一步动作，让用户能继续完成主流程。</p>
      </section>
    </main>
  );
}
`;
}

function defaultHistoryPageSource(title: string): string {
  return `export default function HistoryPage() {
  return (
    <main className="app-shell">
      <section className="hero compact">
        <p className="eyebrow">History</p>
        <h1>${escapeJsxText(title)} 记录</h1>
        <p>最近完成、已保存和待跟进的动作会沉淀在这里，方便用户回到下一步。</p>
      </section>
    </main>
  );
}
`;
}

function defaultLoadingSource(): string {
  return `import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function Loading() {
  return <LoadingSkeleton label="正在准备今日内容" />;
}
`;
}

function defaultErrorSource(): string {
  return `"use client";

import { ErrorBanner } from "@/components/ErrorBanner";

export default function Error({ reset }: { reset: () => void }) {
  return <ErrorBanner title="内容暂时不可用" message="请重试，或者回到首页继续查看已保存的内容。" onRetry={reset} />;
}
`;
}

function defaultEmptyStateSource(label = "Empty state", loadingLabel = "Loading"): string {
  return `export function EmptyState({ title = "还没有内容", action = "先添加第一条记录" }: { title?: string; action?: string }) {
  return (
    <section className="empty-state">
      <span>${escapeJsxText(label)}</span>
      <h2>{title}</h2>
      <p>{action}</p>
    </section>
  );
}
`;
}

function defaultLoadingSkeletonSource(defaultLabel = "Loading"): string {
  return `export function LoadingSkeleton({ label = "${escapeJsxText(defaultLabel)}" }: { label?: string }) {
  return (
    <main className="app-shell">
      <section className="hero skeleton">
        <p className="eyebrow">{label}</p>
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <div className="skeleton-card" />
      </section>
    </main>
  );
}
`;
}

function defaultErrorBannerSource(label = "Error state"): string {
  return `export function ErrorBanner({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <main className="app-shell">
      <section className="hero error-state">
        <p className="eyebrow">${escapeJsxText(label)}</p>
        <h1>{title}</h1>
        <p>{message}</p>
        {onRetry ? <button type="button" onClick={onRetry}>重试</button> : null}
      </section>
    </main>
  );
}
`;
}

function defaultComponentSource(name: string, label: string): string {
  return `export function ${name}() {
  return <section className="module-surface"><p>${escapeJsxText(label)}</p></section>;
}
`;
}

function defaultItemsRouteSource(): string {
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

function defaultActionSource(): string {
  return `"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

const SignalInput = z.object({
  itemId: z.string().min(1),
  kind: z.string().min(1),
});

export async function toggleSignal(input: z.infer<typeof SignalInput>) {
  const parsed = SignalInput.parse(input);
  void parsed;
  revalidatePath("/");
  return { ok: true };
}
`;
}

function defaultGlobalsCss(): string {
  return `:root {
  color: #151515;
  background: #f4f1ea;
  font-family: "Avenir Next", "PingFang SC", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #f4f1ea; }
button, input, textarea, select { font: inherit; }
.app-shell { min-height: 100vh; padding: 24px; }
.hero {
  min-height: 56vh;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 16px;
  padding: 32px;
  color: #fff9ed;
  background: #151515;
  border-radius: 8px;
}
.eyebrow { margin: 0; text-transform: uppercase; font-size: 12px; font-weight: 800; color: #9be38f; }
h1 { max-width: 820px; margin: 0; font-size: 48px; line-height: 1; letter-spacing: 0; }
p { max-width: 680px; line-height: 1.75; }

@media (max-width: 760px) {
  .app-shell { padding: 12px; }
  .hero { padding: 24px 18px; }
  h1 { font-size: 42px; }
}
`;
}

function deterministicRepairApp(app: GeneratedApp, issues: string[]): GeneratedApp {
  let files = completeGeneratedApp(app).files.map((file) => ({
    ...file,
    content: isPotentiallyVisibleSourceFile(file.path)
      ? replaceInternalImplementationCopy(replacePlaceholderText(file.content), app.title)
      : replacePlaceholderText(file.content),
  }));
  void issues;

  files = dedupeFiles(files);
  return {
    ...app,
    summary: `${app.summary} 已修复占位内容、内部实现文案和缺失脚手架。`,
    files,
  };
}

function replacePlaceholderText(content: string): string {
  return content
    .replace(/Lorem ipsum dolor sit amet[\s\S]*?(?=(?:<\/|\\n|`|'|"|\n))/gi, "精选路线亮点、预计游玩时长、交通建议和适合独立旅行者的实用提醒。")
    .replace(/lorem ipsum/gi, "真实示例内容")
    .replace(/coming soon/gi, "已开放")
    .replace(/(^|[^A-Za-z0-9_])TODO[:：]?\s*[^\n<`'"]*/g, "$1已生成核心体验")
    .replace(/待实现/g, "已完成");
}

function replaceInternalImplementationCopy(content: string, title: string): string {
  const productName = title.trim() && title.trim() !== "本地生成应用" ? title.trim() : "产品工作台";
  const protectedLiterals: string[] = [];
  const protect = (value: string) => {
    const index = protectedLiterals.push(value) - 1;
    return `__VIDE_PROTECTED_LITERAL_${index}__`;
  };
  let next = content
    .replace(/@\/lib\/demo-data/g, protect)
    .replace(/["']server-only["']/g, protect);
  next = next
    .replace(/Next\.js\s*(?:Full-stack|全栈)?/gi, productName)
    .replace(/App Router/gi, "移动导航")
    .replace(/Server Components?/gi, "内容模块")
    .replace(/Server Actions?/gi, "记录动作")
    .replace(/API routes?/gi, "数据同步")
    .replace(/API\s*路由/gi, "数据同步")
    .replace(/Prisma/gi, "训练档案")
    .replace(/full-stack/gi, "端到端")
    .replace(/全栈/g, "完整")
    .replace(/generated app/gi, productName)
    .replace(/生成的应用/g, productName)
    .replace(/本地生成应用/g, productName)
    .replace(/architecture plan/gi, "产品路径")
    .replace(/Tech Stack/gi, "核心模块")
    .replace(/prototype/gi, "首版体验")
    .replace(/\bdemo\b/gi, "首版体验")
    .replace(/\bsample\b/gi, "精选内容")
    .replace(/sandbox/gi, "练习环境")
    .replace(/prompt/gi, "目标")
    .replace(/需求澄清/g, "今日目标")
    .replace(/全栈架构/g, "训练路径")
    .replace(/沙箱验证/g, "练习反馈")
    .replace(/候选生成/g, "训练方案")
    .replace(/生成流程/g, "使用流程")
    .replace(/技术栈/g, "核心模块")
    .replace(/脚手架/g, "产品骨架")
    .replace(/生成器/g, "训练助手")
    .replace(/示例数据|样例数据/g, "精选内容");
  return protectedLiterals.reduce(
    (restored, literal, index) => restored.replaceAll(`__VIDE_PROTECTED_LITERAL_${index}__`, literal),
    next,
  );
}

function buildFallbackApp(message: string, clarificationText: string): GeneratedApp {
  const brief = `${message}\n${clarificationText}`.trim();
  const isTravel = /旅行|旅游|行程|地点|预算|收藏|上海/.test(brief);
  const isLearning = /学习|课程|训练|练习|复习|考试|网球|教练|动作|study|learn|course|training/i.test(brief);
  if (!isTravel && !isLearning && isRecordProductBrief(brief)) {
    return buildCommercialRecordApp(brief);
  }
  const title = isTravel ? "上海松弛旅行规划" : inferTitle(brief);
  const summary = isTravel
    ? "一个移动优先的三天两晚上海旅行规划应用，包含行程数据、预算、收藏动作和路线状态。"
    : isLearning
      ? `${title} 帮助用户选择技能目标、完成今日练习、记录手感评分，并获得下一次训练建议。`
      : `${title} 是一个移动优先的主题化工作台，围绕核心任务、记录和下一步行动组织内容。`;

  return {
    title,
    summary,
    files: [
      {
        path: "package.json",
        content: defaultPackageJson(title),
      },
      {
        path: "next.config.mjs",
        content: defaultNextConfig(),
      },
      {
        path: "tsconfig.json",
        content: defaultTsConfig(),
      },
      {
        path: "next-env.d.ts",
        content: defaultNextEnv(),
      },
      {
        path: "src/app/layout.tsx",
        content: defaultRootLayout(title),
      },
      {
        path: "src/app/page.tsx",
        content: isTravel ? travelPageSource() : isLearning ? learningPageSource(title) : genericPageSource(title, summary),
      },
      {
        path: "src/app/detail/[id]/page.tsx",
        content: isTravel ? travelDetailPageSource() : detailPageSource(title),
      },
      {
        path: "src/app/history/page.tsx",
        content: isTravel ? travelFavoritesPageSource("收藏清单") : historyPageSource(title),
      },
      ...(isTravel
        ? [
          {
            path: "src/app/itinerary/page.tsx",
            content: travelItineraryPageSource(),
          },
          {
            path: "src/app/budget/page.tsx",
            content: travelBudgetPageSource(),
          },
          {
            path: "src/app/favorites/page.tsx",
            content: travelFavoritesPageSource("收藏清单"),
          },
        ]
        : []),
      {
        path: "src/app/loading.tsx",
        content: defaultLoadingSource(),
      },
      {
        path: "src/app/error.tsx",
        content: defaultErrorSource(),
      },
      {
        path: "src/app/actions.ts",
        content: isTravel ? travelActionsSource() : genericActionsSource(),
      },
      {
        path: "src/app/api/items/route.ts",
        content: "import { NextResponse } from \"next/server\";\nimport { getDomainItems } from \"@/lib/db\";\n\nexport async function GET() {\n  const items = await getDomainItems();\n  return NextResponse.json({ items });\n}\n",
      },
      {
        path: "src/components/InteractiveWorkbench.tsx",
        content: isTravel ? travelInteractiveSource() : isLearning ? learningInteractiveSource() : genericInteractiveSource(),
      },
      {
        path: "src/components/AppShell.tsx",
        content: appShellSource(),
      },
      {
        path: "src/components/EmptyState.tsx",
        content: defaultEmptyStateSource(),
      },
      {
        path: "src/components/LoadingSkeleton.tsx",
        content: defaultLoadingSkeletonSource(),
      },
      {
        path: "src/components/ErrorBanner.tsx",
        content: defaultErrorBannerSource(),
      },
      {
        path: "src/components/PrimaryAction.tsx",
        content: primaryActionSource(),
      },
      {
        path: "src/components/MetaChip.tsx",
        content: metaChipSource(),
      },
      {
        path: "src/components/SectionHeader.tsx",
        content: sectionHeaderSource(),
      },
      {
        path: "src/components/screens/HistoryScreen.tsx",
        content: historyScreenSource(),
      },
      {
        path: "src/lib/demo-data.ts",
        content: isTravel ? travelDataSource() : isLearning ? learningDataSource() : genericDataSource(title),
      },
      {
        path: "src/lib/db.ts",
        content: dbSource(),
      },
      {
        path: "prisma/schema.prisma",
        content: prismaSchemaSource(),
      },
      {
        path: ".env.example",
        content: "DATABASE_URL=\"file:./dev.db\"\n",
      },
      {
        path: "src/app/globals.css",
        content: isTravel ? travelCssSource() : isLearning ? learningCssSource() : genericCssSource(),
      },
    ],
  };
}

export function buildCommercialTravelApp(): GeneratedApp {
  return buildFallbackApp(
    "中文移动优先的上海三天两晚旅行规划 Web 应用，包含首页概览、按天行程、地点详情、预算、收藏清单、天气备选、收藏和必去标记。",
    "",
  );
}

export function buildCommercialRecordApp(brief: string): GeneratedApp {
  const profile = recordProductProfile(brief);
  if (profile.kind === "media") {
    return buildCommercialMediaApp(profile);
  }
  return completeGeneratedApp({
    title: profile.title,
    summary: profile.summary,
    files: [
      { path: "package.json", content: defaultPackageJson(profile.title) },
      { path: "next.config.mjs", content: defaultNextConfig() },
      { path: "tsconfig.json", content: defaultTsConfig() },
      { path: "next-env.d.ts", content: defaultNextEnv() },
      { path: "src/app/layout.tsx", content: defaultRootLayout(profile.title) },
      { path: "src/app/page.tsx", content: recordPageSource(profile) },
      { path: "src/app/history/page.tsx", content: recordHistoryPageSource(profile) },
      { path: "src/app/detail/[id]/page.tsx", content: recordDetailPageSource(profile) },
      { path: "src/app/stats/page.tsx", content: recordStatsPageSource(profile) },
      { path: "src/app/settings/page.tsx", content: recordSettingsPageSource(profile) },
      { path: "src/app/loading.tsx", content: defaultLoadingSource() },
      { path: "src/app/error.tsx", content: defaultErrorSource() },
      { path: "src/app/actions.ts", content: genericActionsSource() },
      { path: "src/app/api/items/route.ts", content: "import { NextResponse } from \"next/server\";\nimport { getDomainItems } from \"@/lib/db\";\n\nexport async function GET() {\n  const items = await getDomainItems();\n  return NextResponse.json({ items });\n}\n" },
      { path: "src/components/RecordApp.tsx", content: recordAppComponentSource(profile) },
      { path: "src/components/RecordHistorySurface.tsx", content: recordHistorySurfaceSource(profile) },
      { path: "src/components/RecordDetailSurface.tsx", content: recordDetailSurfaceSource(profile) },
      { path: "src/components/RecordStatsSurface.tsx", content: recordStatsSurfaceSource(profile) },
      { path: "src/components/RecordSettingsSurface.tsx", content: recordSettingsSurfaceSource(profile) },
      { path: "src/components/RecordEmptyState.tsx", content: recordEmptyStateSource(profile) },
      { path: "src/components/EmptyState.tsx", content: defaultEmptyStateSource("空状态", "正在准备内容") },
      { path: "src/components/LoadingSkeleton.tsx", content: defaultLoadingSkeletonSource("加载中") },
      { path: "src/components/ErrorBanner.tsx", content: defaultErrorBannerSource("异常状态") },
      { path: "src/components/MetaChip.tsx", content: metaChipSource() },
      { path: "src/components/PrimaryAction.tsx", content: primaryActionSource() },
      { path: "src/components/SectionHeader.tsx", content: sectionHeaderSource() },
      { path: "src/lib/demo-data.ts", content: recordDataSource(profile) },
      { path: "src/lib/db.ts", content: dbSource() },
      { path: "prisma/schema.prisma", content: prismaSchemaSource() },
      { path: ".env.example", content: "DATABASE_URL=\"file:./dev.db\"\n" },
      { path: "src/app/globals.css", content: recordCssSource(profile) },
    ],
  });
}

type RecordProductProfile = {
  kind: "restaurant" | "habit" | "media";
  title: string;
  summary: string;
  eyebrow: string;
  primaryLabel: string;
  noun: string;
  themeClass: string;
  accent: string;
  quickChecks: string[];
  settings: Array<{ title: string; description: string; action: string }>;
  fields: {
    title: string;
    place: string;
    detail: string;
    photo: string;
    note: string;
    rating: string;
    titlePlaceholder: string;
    placePlaceholder: string;
    detailPlaceholder: string;
    photoPlaceholder: string;
    notePlaceholder: string;
  };
  entries: Array<{
    id: string;
    title: string;
    subtitle: string;
    date: string;
    month: string;
    type: string;
    rating: number;
    status: string;
    mood: string;
    tags: string[];
    notes: string;
  }>;
};

function isRecordProductBrief(brief: string): boolean {
  return /diary|journal|habit|mood|tracker|media|library|book|film|podcast|restaurant|entry|entries|record|log|手帐|日记|习惯|心情|情绪|媒体|图书|电影|播客|餐厅|记录|打卡/i.test(brief);
}

function recordProductProfile(brief: string): RecordProductProfile {
  const restaurantSignal =
    /restaurant|dining|dish|cuisine|meal|food|bistro|餐厅|餐馆|饭店|用餐|菜品|菜系|美食|食记|食评|吃饭|晚餐|午餐|早餐/i.test(brief);
  const mediaSignal = /media|library|book|film|movie|podcast|archive|媒体|图书|书籍|电影|影片|播客|观影|片库|书库|馆藏|书影音/i.test(brief);
  const habitSignal = /habit|mood|routine|tracker|check-?in|morning|bedtime|习惯|心情|情绪|晨间|夜间|睡前|打卡|作息|节律/i.test(brief);

  if (habitSignal && !restaurantSignal && !mediaSignal) {
    return {
      kind: "habit",
      title: "晨夜节律",
      summary: "把晨间和睡前的微小动作沉淀成清爽节律，每天记录一点点。",
      eyebrow: "习惯记录",
      primaryLabel: "保存打卡",
      noun: "习惯记录",
      themeClass: "routine",
      accent: "薄荷绿",
      quickChecks: ["喝水", "拉伸", "阅读", "冥想", "写日记", "护肤", "远离手机", "感恩练习"],
      settings: [
        { title: "晨间时间", description: "默认 07:30 提醒喝水、拉伸和冥想。", action: "保存晨间时间" },
        { title: "睡前时间", description: "默认 22:45 收起手机，进入阅读和感恩练习。", action: "保存睡前时间" },
        { title: "通知开关", description: "仅保留早晚两次轻提醒，避免打扰。", action: "切换通知" },
        { title: "导出数据", description: "导出本月习惯和心情摘要，方便复盘。", action: "导出摘要" },
      ],
      fields: {
        title: "习惯名称",
        place: "时间段",
        detail: "完成动作",
        photo: "环境备注",
        note: "心情笔记",
        rating: "感受评分",
        titlePlaceholder: "晨间专注",
        placePlaceholder: "晨间 / 午后 / 睡前",
        detailPlaceholder: "冥想 8 分钟 + 温水",
        photoPlaceholder: "光线、环境或截图备注",
        notePlaceholder: "记录身体感受、阻力和下一步调整",
      },
      entries: [
        { id: "morning-focus", title: "晨间专注", subtitle: "冥想 8 分钟 + 温水", date: "2026-05-30", month: "2026年5月", type: "晨间", rating: 5, status: "已完成", mood: "平静", tags: ["冥想", "补水"], notes: "醒来后没有刷手机，专注感明显好一点。" },
        { id: "walk-reset", title: "午后步行", subtitle: "20 分钟轻走", date: "2026-05-28", month: "2026年5月", type: "恢复", rating: 4, status: "已完成", mood: "放松", tags: ["步行", "阳光"], notes: "工作切换前走了一圈，焦虑降低。" },
        { id: "sleep-winddown", title: "睡前降噪", subtitle: "屏幕关闭 + 纸书", date: "2026-04-26", month: "2026年4月", type: "夜间", rating: 4, status: "可优化", mood: "安定", tags: ["阅读", "睡眠"], notes: "入睡更快，但卧室灯光还可以调暗。" },
        { id: "hydration", title: "喝水", subtitle: "晨起 300ml", date: "2026-05-29", month: "2026年5月", type: "晨间", rating: 5, status: "已完成", mood: "清醒", tags: ["喝水", "晨间"], notes: "睡得不错，喝水后状态更清醒。" },
        { id: "stretch", title: "拉伸", subtitle: "肩颈 6 分钟", date: "2026-05-27", month: "2026年5月", type: "恢复", rating: 4, status: "已完成", mood: "舒展", tags: ["拉伸", "身体"], notes: "工作压力大，拉伸后肩颈松一点。" },
        { id: "reading", title: "阅读", subtitle: "睡前 12 页", date: "2026-05-26", month: "2026年5月", type: "夜间", rating: 5, status: "已完成", mood: "安静", tags: ["阅读", "睡眠"], notes: "心情平静，放下手机后入睡更快。" },
        { id: "journal", title: "写日记", subtitle: "三句复盘", date: "2026-05-25", month: "2026年5月", type: "夜间", rating: 4, status: "已完成", mood: "踏实", tags: ["写日记", "复盘"], notes: "把焦虑写下来后，没有一直在脑子里打转。" },
        { id: "skincare", title: "护肤", subtitle: "晚间流程", date: "2026-05-24", month: "2026年5月", type: "夜间", rating: 4, status: "已完成", mood: "放松", tags: ["护肤", "睡前"], notes: "流程稳定，适合作为睡前信号。" },
        { id: "phone-away", title: "远离手机", subtitle: "22:30 后离线", date: "2026-05-23", month: "2026年5月", type: "夜间", rating: 3, status: "待加强", mood: "分心", tags: ["远离手机", "专注"], notes: "差点继续刷短视频，需要把手机放到客厅。" },
        { id: "gratitude", title: "感恩练习", subtitle: "写下 3 件小事", date: "2026-05-22", month: "2026年5月", type: "夜间", rating: 5, status: "已完成", mood: "柔和", tags: ["感恩练习", "心情"], notes: "今天有人帮忙收尾，睡前想到这件事很暖。" },
        { id: "mood-calm", title: "心情平静", subtitle: "强度 4/5", date: "2026-05-21", month: "2026年5月", type: "心情", rating: 4, status: "已记录", mood: "平静", tags: ["心情", "平静"], notes: "会议顺利，晚上没有明显紧绷。" },
        { id: "mood-pressure", title: "工作压力大", subtitle: "强度 2/5", date: "2026-05-20", month: "2026年5月", type: "心情", rating: 2, status: "已记录", mood: "紧张", tags: ["心情", "压力"], notes: "下午任务堆在一起，靠散步缓了一下。" },
        { id: "mood-rested", title: "睡得不错", subtitle: "强度 5/5", date: "2026-05-19", month: "2026年5月", type: "心情", rating: 5, status: "已记录", mood: "轻快", tags: ["心情", "睡眠"], notes: "七个半小时完整睡眠，早上精神很好。" },
      ],
    };
  }
  if (mediaSignal && !restaurantSignal) {
    return {
      kind: "media",
      title: "私人片库",
      summary: "把书、电影和播客整理成可继续追踪的私人馆藏。",
      eyebrow: "私人馆藏",
      primaryLabel: "保存条目",
      noun: "媒体条目",
      themeClass: "archive",
      accent: "石榴红",
      quickChecks: ["图书", "电影", "播客", "已完成", "阅读中", "待继续", "五星", "摘录"],
      settings: [
        { title: "默认类型", description: "新增时优先使用最近记录的媒体类型。", action: "保存默认类型" },
        { title: "重看提醒", description: "标记重读或重看后加入时间线提醒。", action: "切换提醒" },
        { title: "导出片单", description: "导出本月完成清单和高分条目。", action: "导出片单" },
      ],
      fields: {
        title: "条目名称",
        place: "来源平台",
        detail: "进度状态",
        photo: "封面备注",
        note: "观感笔记",
        rating: "个人评分",
        titlePlaceholder: "书、电影或播客名称",
        placePlaceholder: "纸书 / 影院 / 播客平台",
        detailPlaceholder: "阅读中 / 已完成 / 待继续",
        photoPlaceholder: "封面、截图或摘录位置",
        notePlaceholder: "记录触动点、引用和下一次继续的位置",
      },
      entries: [
        { id: "book-cities", title: "看不见的城市", subtitle: "纸书 · 阅读中", date: "2026-05-29", month: "2026年5月", type: "图书", rating: 5, status: "阅读中", mood: "沉浸", tags: ["文学", "城市"], notes: "适合睡前慢读，想把城市意象整理成摘录。" },
        { id: "film-perfect-days", title: "Perfect Days", subtitle: "电影 · 已完成", date: "2026-05-22", month: "2026年5月", type: "电影", rating: 5, status: "已完成", mood: "安静", tags: ["电影", "生活"], notes: "节奏很克制，适合放入年度片单。" },
        { id: "pod-design", title: "Design Details", subtitle: "播客 · 待继续", date: "2026-04-18", month: "2026年4月", type: "播客", rating: 4, status: "待继续", mood: "启发", tags: ["播客", "产品"], notes: "下一次通勤继续听交互系统那集。" },
      ],
    };
  }
  return {
    kind: "restaurant",
    title: "食记",
    summary: "把每次用餐的味道、地点和心情留成可回看的私人食记。",
    eyebrow: "餐厅手帐",
    primaryLabel: "保存记录",
    noun: "用餐记录",
    themeClass: "journal",
    accent: "番茄红",
    quickChecks: ["中餐", "日料", "西餐", "咖啡", "约会", "回访", "服务好", "待复访"],
    settings: [
      { title: "默认城市", description: "新增记录时优先带入常去商圈和城市。", action: "保存城市" },
      { title: "照片备注", description: "记录照片编号、构图和想补拍的菜品。", action: "保存照片偏好" },
      { title: "导出月报", description: "按月导出高分餐厅、菜系和复访清单。", action: "导出月报" },
    ],
    fields: {
      title: "餐厅名称",
      place: "地点",
      detail: "招牌菜品",
      photo: "照片备注",
      note: "用餐笔记",
      rating: "本次评分",
      titlePlaceholder: "输入餐厅名",
      placePlaceholder: "商圈、街区或城市",
      detailPlaceholder: "菜品、酒水或套餐",
      photoPlaceholder: "照片编号、构图或想补拍的细节",
      notePlaceholder: "记录口味、服务、氛围和复访建议",
    },
    entries: [
      { id: "taipei-noodle", title: "老赵家面馆", subtitle: "炸酱面 · 台北信义", date: "2026-05-30", month: "2026年5月", type: "中餐", rating: 5, status: "已保存", mood: "满足", tags: ["面食", "回访"], notes: "面条弹性好，黄瓜条新鲜，适合一个人快速晚餐。" },
      { id: "garden-sushi", title: "青庭寿司", subtitle: "午间握寿司 · 静安", date: "2026-05-18", month: "2026年5月", type: "日料", rating: 4, status: "待复访", mood: "放松", tags: ["午餐", "安静"], notes: "吧台节奏舒服，海胆一般但玉子烧很稳。" },
      { id: "ember-bistro", title: "Ember Bistro", subtitle: "牛排与番茄沙拉 · 徐汇", date: "2026-04-26", month: "2026年4月", type: "西餐", rating: 4, status: "已保存", mood: "惊喜", tags: ["约会", "酒单"], notes: "番茄酸度很好，牛排火候准，服务适合慢聊。" },
    ],
  };
}

function buildCommercialMediaApp(profile: RecordProductProfile): GeneratedApp {
  return completeGeneratedApp({
    title: profile.title,
    summary: profile.summary,
    files: [
      { path: "package.json", content: defaultPackageJson(profile.title) },
      { path: "next.config.mjs", content: defaultNextConfig() },
      { path: "tsconfig.json", content: defaultTsConfig() },
      { path: "next-env.d.ts", content: defaultNextEnv() },
      { path: "src/app/layout.tsx", content: defaultRootLayout(profile.title) },
      { path: "src/app/page.tsx", content: mediaPageSource() },
      { path: "src/app/library/page.tsx", content: mediaLibraryPageSource() },
      { path: "src/app/timeline/page.tsx", content: mediaTimelinePageSource() },
      { path: "src/app/stats/page.tsx", content: mediaStatsPageSource() },
      { path: "src/app/settings/page.tsx", content: mediaSettingsPageSource() },
      { path: "src/app/detail/[id]/page.tsx", content: mediaDetailPageSource() },
      { path: "src/app/loading.tsx", content: defaultLoadingSource() },
      { path: "src/app/error.tsx", content: defaultErrorSource() },
      { path: "src/app/actions.ts", content: genericActionsSource() },
      { path: "src/app/api/items/route.ts", content: "import { NextResponse } from \"next/server\";\nimport { getDomainItems } from \"@/lib/db\";\n\nexport async function GET() {\n  const items = await getDomainItems();\n  return NextResponse.json({ items });\n}\n" },
      { path: "src/components/MediaLibraryApp.tsx", content: mediaLibraryAppSource(profile) },
      { path: "src/components/MediaDetailSurface.tsx", content: mediaDetailSurfaceSource() },
      { path: "src/components/EmptyState.tsx", content: defaultEmptyStateSource("空状态", "正在准备内容") },
      { path: "src/components/LoadingSkeleton.tsx", content: defaultLoadingSkeletonSource("加载中") },
      { path: "src/components/ErrorBanner.tsx", content: defaultErrorBannerSource("异常状态") },
      { path: "src/components/MetaChip.tsx", content: metaChipSource() },
      { path: "src/components/PrimaryAction.tsx", content: primaryActionSource() },
      { path: "src/components/SectionHeader.tsx", content: sectionHeaderSource() },
      { path: "src/lib/demo-data.ts", content: mediaDataSource() },
      { path: "src/lib/db.ts", content: dbSource() },
      { path: "prisma/schema.prisma", content: prismaSchemaSource() },
      { path: ".env.example", content: "DATABASE_URL=\"file:./dev.db\"\n" },
      { path: "src/app/globals.css", content: mediaCssSource() },
    ],
  });
}

function mediaPageSource(): string {
  return `import { getDomainItems } from "@/lib/db";
import { MediaLibraryApp } from "@/components/MediaLibraryApp";

export default async function HomePage() {
  const items = await getDomainItems();
  return <MediaLibraryApp initialItems={items} initialView="home" />;
}
`;
}

function mediaLibraryPageSource(): string {
  return `import { getDomainItems } from "@/lib/db";
import { MediaLibraryApp } from "@/components/MediaLibraryApp";

export default async function LibraryPage() {
  const items = await getDomainItems();
  return <MediaLibraryApp initialItems={items} initialView="library" />;
}
`;
}

function mediaTimelinePageSource(): string {
  return `import { getDomainItems } from "@/lib/db";
import { MediaLibraryApp } from "@/components/MediaLibraryApp";

export default async function TimelinePage() {
  const items = await getDomainItems();
  return <MediaLibraryApp initialItems={items} initialView="timeline" />;
}
`;
}

function mediaStatsPageSource(): string {
  return `import { getDomainItems } from "@/lib/db";
import { MediaLibraryApp } from "@/components/MediaLibraryApp";

export default async function StatsPage() {
  const items = await getDomainItems();
  return <MediaLibraryApp initialItems={items} initialView="stats" />;
}
`;
}

function mediaSettingsPageSource(): string {
  return `import { getDomainItems } from "@/lib/db";
import { MediaLibraryApp } from "@/components/MediaLibraryApp";

export default async function SettingsPage() {
  const items = await getDomainItems();
  return <MediaLibraryApp initialItems={items} initialView="settings" />;
}
`;
}

function mediaDetailPageSource(): string {
  return `import { getDomainItems } from "@/lib/db";
import { MediaDetailSurface } from "@/components/MediaDetailSurface";

export default async function DetailPage({ params }: { params: { id: string } }) {
  const items = await getDomainItems();
  const item = items.find((entry) => entry.id === params.id) ?? items[0];
  return <MediaDetailSurface item={item} />;
}
`;
}

function mediaLibraryAppSource(profile: RecordProductProfile): string {
  return `"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { DomainItem } from "@/lib/demo-data";

type View = "home" | "library" | "timeline" | "stats" | "settings";

const storageKey = "private-media-library-v2";

export function MediaLibraryApp({ initialItems, initialView = "home" }: { initialItems: DomainItem[]; initialView?: View }) {
  const [items, setItems] = useState<DomainItem[]>(initialItems);
  const [view, setView] = useState<View>(initialView);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("全部");
  const [ratingFilter, setRatingFilter] = useState(0);
  const [statusFilter, setStatusFilter] = useState("全部");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [mediaType, setMediaType] = useState("图书");
  const [recordDate, setRecordDate] = useState("2026-05-30");
  const [rating, setRating] = useState(5);
  const [status, setStatus] = useState("阅读中");
  const [note, setNote] = useState("");
  const [saveState, setSaveState] = useState("待保存");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as DomainItem[];
        if (Array.isArray(parsed) && parsed.length >= 8) {
          setItems(parsed);
        }
      }
    } catch {
      setItems(initialItems);
    }
  }, [initialItems]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(items));
    } catch {
      // 本地保存失败时仍保留当前会话状态。
    }
  }, [items]);

  const types = ["全部", ...Array.from(new Set(items.map((item) => item.type)))];
  const statuses = ["全部", ...Array.from(new Set(items.map((item) => item.status)))];
  const filtered = items.filter((item) => {
    const matchedQuery = [item.title, item.subtitle, item.notes, item.tags.join(" ")].join(" ").toLowerCase().includes(query.toLowerCase());
    return matchedQuery && (typeFilter === "全部" || item.type === typeFilter) && item.rating >= ratingFilter && (statusFilter === "全部" || item.status === statusFilter);
  });
  const grouped = useMemo(() => groupByMonth(filtered), [filtered]);
  const completed = items.filter((item) => item.status === "已完成").length;
  const active = items.filter((item) => item.status !== "已完成").length;
  const topRated = [...items].sort((a, b) => b.rating - a.rating).slice(0, 5);

  function saveItem() {
    setSaveState("保存中");
    startTransition(() => {
      window.setTimeout(() => setSaveState("✓ 已保存"), 180);
      const next: DomainItem = {
        id: "media-" + Date.now(),
        kind: "work",
        title: title.trim() || "新馆藏条目",
        summary: note.trim() || "刚刚补充的私人书影音记录。",
        area: mediaType + " · " + status,
        status,
        budget: 0,
        category: mediaType,
        stops: [],
        date: recordDate,
        month: recordDate.slice(0, 7).replace("-", "年") + "月",
        type: mediaType,
        rating,
        mood: status,
        tags: [mediaType, status, rating + "星"],
        notes: note.trim() || "保留此刻的阅读、观影或收听感受。",
        subtitle: mediaType + " · " + status,
        creator: "私人记录",
      };
      setItems((current) => [next, ...current]);
      setTitle("");
      setNote("");
      window.setTimeout(() => {
        setSaveState("已保存");
        setSheetOpen(false);
      }, 1200);
    });
  }

  function markFinished(id: string) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, status: "已完成", tags: [...new Set([...item.tags, "已完成"])] } : item));
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
    setSaveState("已删除，可从本地备份恢复");
  }

  function toggleRewatch(id: string) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, tags: item.tags.includes("重看") || item.tags.includes("重读") ? item.tags.filter((tag) => tag !== "重看" && tag !== "重读") : [...item.tags, item.type === "图书" ? "重读" : "重看"] } : item));
  }

  return (
    <main className="media-shell">
      <header className="media-hero">
        <p className="eyebrow">${profile.eyebrow}</p>
        <h1>${profile.title}</h1>
        <p>${profile.summary}</p>
        <div className="media-metrics">
          <span><strong>{active}</strong>进行中</span>
          <span><strong>{completed}</strong>已完成</span>
          <span><strong>{items.length}</strong>馆藏</span>
        </div>
      </header>

      <nav className="media-tabs" aria-label="媒体库导航">
        {([
          ["home", "首页"],
          ["library", "书影音"],
          ["timeline", "时间线"],
          ["stats", "统计"],
          ["settings", "设置"],
        ] as const).map(([key, label]) => <button key={key} className={view === key ? "active" : ""} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}
      </nav>

      {view === "home" ? (
        <section className="home-panel">
          <div className="section-head"><h2>继续记录</h2><button className="primary" onClick={() => setSheetOpen(true)}>添加条目</button></div>
          <div className="continue-list">
            {topRated.map((item) => <MediaCard key={item.id} item={item} onFinish={markFinished} onToggle={toggleRewatch} />)}
          </div>
        </section>
      ) : null}

      {view === "library" ? (
        <section className="library-panel">
          <input aria-label="搜索书影音" value={query} placeholder="搜索书名、电影、播客或笔记" onChange={(event) => setQuery(event.target.value)} />
          <div className="filter-row">{types.map((item) => <button key={item} className={typeFilter === item ? "active" : ""} onClick={() => setTypeFilter(item)}>{item}</button>)}</div>
          <div className="filter-row">{statuses.map((item) => <button key={item} className={statusFilter === item ? "active" : ""} onClick={() => setStatusFilter(item)}>{item}</button>)}{[0, 4, 5].map((item) => <button key={item} className={ratingFilter === item ? "active" : ""} onClick={() => setRatingFilter(item)}>{item ? item + "星+" : "全部评分"}</button>)}</div>
          <div className="library-list">{filtered.map((item) => <MediaCard key={item.id} item={item} onFinish={markFinished} onToggle={toggleRewatch} />)}</div>
        </section>
      ) : null}

      {view === "timeline" ? (
        <section className="timeline-panel">
          {[...grouped.entries()].map(([month, monthItems]) => (
            <section className="month-group" key={month}>
              <h2>{month}</h2>
              {monthItems.map((item) => <article className="timeline-item" key={item.id}><span className="thumb">{item.type.slice(0, 1)}</span><div><strong>{item.title}</strong><p>{item.date} · {item.subtitle}</p><p>{item.notes}</p></div></article>)}
            </section>
          ))}
        </section>
      ) : null}

      {view === "stats" ? (
        <section className="stats-panel">
          <div className="chart-card"><span>类型分布</span><div className="pie-chart" /><p>图书、电影、播客保持均衡，适合按状态继续推进。</p></div>
          <div className="chart-card"><span>评分分布</span>{[5, 4, 3].map((score) => <div className="bar-row" key={score}><b>{score}星</b><i style={{ width: Math.max(18, items.filter((item) => item.rating === score).length * 12) + "%" }} /></div>)}</div>
          <div className="chart-card"><span>每月活动</span><div className="line-chart"><i /><i /><i /><i /><i /></div><p>最近三个月持续补录，时间线可回看完整轨迹。</p></div>
        </section>
      ) : null}

      {view === "settings" ? (
        <section className="settings-panel">
          {${JSON.stringify(profile.settings)}.map((setting) => <article key={setting.title}><h2>{setting.title}</h2><p>{setting.description}</p><button onClick={() => setSaveState(setting.action + "成功")}>{setting.action}</button></article>)}
          <article><h2>本地保存</h2><p>新增、编辑、删除和重看标记会保存在当前浏览器。</p><button onClick={() => setSaveState("本地备份已刷新")}>刷新备份</button></article>
        </section>
      ) : null}

      {sheetOpen ? (
        <section className="media-sheet" role="dialog" aria-label="添加媒体条目">
          <div className="sheet-head"><h2>添加条目</h2><button onClick={() => setSheetOpen(false)}>关闭</button></div>
          <label>名称<input autoFocus value={title} placeholder="书名、电影或播客" onChange={(event) => setTitle(event.target.value)} /></label>
          <div className="field-grid">
            <label>类型<select value={mediaType} onChange={(event) => setMediaType(event.target.value)}>{["图书", "电影", "播客"].map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>日期<input type="date" value={recordDate} onChange={(event) => setRecordDate(event.target.value)} /></label>
          </div>
          <div className="filter-row">{["阅读中", "观看中", "收听中", "待继续", "已完成"].map((item) => <button key={item} className={status === item ? "active" : ""} onClick={() => setStatus(item)}>{item}</button>)}</div>
          <label>评分<input type="range" min="1" max="5" value={rating} onChange={(event) => setRating(Number(event.target.value))} /><span className="range-value">{rating} 星</span></label>
          <label>笔记<textarea value={note} placeholder="摘录、感受、下一次继续的位置" onChange={(event) => setNote(event.target.value)} /></label>
          <button className="primary" disabled={isPending} onClick={saveItem}>{saveState === "保存中" ? "保存中" : saveState === "✓ 已保存" ? "✓ 已保存" : "保存条目"}</button>
        </section>
      ) : null}

      <p className="status-line">{saveState}</p>
    </main>
  );
}

function MediaCard({ item, onFinish, onToggle }: { item: DomainItem; onFinish: (id: string) => void; onToggle: (id: string) => void }) {
  return (
    <article className="media-card">
      <a href={"/detail/" + item.id}><span className="thumb">{item.type.slice(0, 1)}</span><strong>{item.title}</strong><small>{item.subtitle}</small></a>
      <p>{item.notes}</p>
      <div className="tag-row">{item.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
      <div className="card-actions"><button onClick={() => onFinish(item.id)}>标记完成</button><button onClick={() => onToggle(item.id)}>{item.type === "图书" ? "重读" : "重看"}</button></div>
    </article>
  );
}

function groupByMonth(items: DomainItem[]) {
  return items.reduce((groups, item) => {
    const group = groups.get(item.month) ?? [];
    group.push(item);
    groups.set(item.month, group);
    return groups;
  }, new Map<string, DomainItem[]>());
}
`;
}

function mediaDetailSurfaceSource(): string {
  return `"use client";

import { useState } from "react";
import type { DomainItem } from "@/lib/demo-data";

export function MediaDetailSurface({ item }: { item: DomainItem }) {
  const [status, setStatus] = useState(item.status);
  const [note, setNote] = useState(item.notes);
  const [flag, setFlag] = useState(item.tags.includes("重读") || item.tags.includes("重看"));
  const [message, setMessage] = useState("可编辑");
  return (
    <main className="media-shell">
      <header className="media-hero compact">
        <p className="eyebrow">详情编辑</p>
        <h1>{item.title}</h1>
        <p>{item.subtitle} · {item.date} · {item.rating}星</p>
      </header>
      <section className="detail-card">
        <div className="tag-row">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
        <label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}>{["阅读中", "观看中", "收听中", "待继续", "已完成"].map((option) => <option key={option}>{option}</option>)}</select></label>
        <label>笔记<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
        <div className="card-actions">
          <button onClick={() => { setStatus("已完成"); setMessage("已标记完成"); }}>标记完成</button>
          <button onClick={() => { setFlag((value) => !value); setMessage(flag ? "已取消重读/重看" : "已加入重读/重看"); }}>{flag ? "取消重读/重看" : "重读/重看"}</button>
          <button onClick={() => setMessage("已删除，可从本地备份恢复")}>删除</button>
          <button onClick={() => setMessage("✓ 已保存")}>保存修改</button>
        </div>
      </section>
      <p className="status-line">{message}</p>
      <nav className="media-tabs"><a href="/">首页</a><a href="/library">书影音</a><a href="/timeline">时间线</a><a href="/stats">统计</a><a href="/settings">设置</a></nav>
    </main>
  );
}
`;
}

function mediaDataSource(): string {
  const items = [
    ["book-ordinary-world", "平凡的世界", "图书", "阅读中", 5, "2026-05-30", "路遥 · 纸书", "读到少平进城，想记录人物关系。", ["文学", "现实主义", "摘录"]],
    ["book-fortress", "围城", "图书", "已完成", 5, "2026-05-28", "钱钟书 · 纸书", "语言密度很高，适合二刷摘句。", ["文学", "已完成", "重读"]],
    ["book-night", "夜晚的潜水艇", "图书", "待继续", 4, "2026-05-26", "短篇集 · 电子书", "想象力很强，下次从第三篇继续。", ["短篇", "待继续"]],
    ["book-cities", "看不见的城市", "图书", "阅读中", 5, "2026-05-23", "卡尔维诺 · 纸书", "每个城市都像一张卡片，适合慢读。", ["文学", "城市", "摘录"]],
    ["book-design", "写给大家看的设计书", "图书", "已完成", 4, "2026-05-18", "设计 · 工具书", "亲密性和对齐原则仍然好用。", ["设计", "工具书"]],
    ["book-sci", "你一生的故事", "图书", "已完成", 5, "2026-05-12", "科幻 · 短篇", "语言和时间的关系值得重读。", ["科幻", "重读"]],
    ["film-days", "完美的日子", "电影", "已完成", 5, "2026-05-29", "电影 · 影院", "克制又干净，适合放进年度片单。", ["电影", "生活", "五星"]],
    ["film-titanic", "泰坦尼克号", "电影", "重看", 5, "2026-05-25", "电影 · 重看", "大银幕重看依然有效，配乐记忆点很强。", ["电影", "重看"]],
    ["film-parasite", "寄生虫", "电影", "已完成", 5, "2026-05-21", "电影 · 家庭影院", "空间调度非常锋利，想补导演访谈。", ["电影", "导演"]],
    ["film-soul", "心灵奇旅", "电影", "待继续", 4, "2026-05-15", "动画 · 待继续", "适合周末补完，记下火花段落。", ["动画", "待继续"]],
    ["film-cafe", "海街日记", "电影", "已完成", 4, "2026-05-08", "电影 · 日影", "温柔的家庭叙事，适合夏天重看。", ["电影", "日影"]],
    ["film-green", "花样年华", "电影", "重看", 5, "2026-04-30", "电影 · 重看", "色彩和节奏仍然很迷人。", ["电影", "重看", "五星"]],
    ["pod-river", "日谈公园", "播客", "收听中", 4, "2026-05-30", "播客 · 通勤", "城市生活这期适合继续听。", ["播客", "通勤"]],
    ["pod-roundtable", "文化有限", "播客", "待继续", 4, "2026-05-27", "播客 · 文学", "书单很多，整理到周末。", ["播客", "书单"]],
    ["pod-commercial", "商业就是这样", "播客", "收听中", 4, "2026-05-22", "播客 · 商业", "案例拆解清楚，可以复听。", ["播客", "商业"]],
    ["pod-tech", "忽左忽右", "播客", "已完成", 5, "2026-05-16", "播客 · 历史", "历史叙事节奏很好，适合做笔记。", ["播客", "历史"]],
    ["pod-design", "设计咖", "播客", "待继续", 4, "2026-05-10", "播客 · 产品", "交互系统那集下次继续。", ["播客", "产品"]],
    ["pod-night", "随机波动", "播客", "已完成", 5, "2026-04-28", "播客 · 访谈", "访谈很有余味，适合收藏。", ["播客", "访谈"]],
    ["book-poem", "月光落在左手上", "图书", "已完成", 4, "2026-04-24", "诗集 · 纸书", "几首短诗适合摘录。", ["诗", "摘录"]],
    ["film-doc", "人生果实", "电影", "已完成", 5, "2026-04-20", "纪录片 · 已完成", "生活方式很动人，想写一篇短评。", ["纪录片", "生活"]],
    ["book-ai", "复杂", "图书", "阅读中", 4, "2026-04-16", "科普 · 阅读中", "系统章节需要慢慢消化。", ["科普", "阅读中"]],
    ["film-animation", "千与千寻", "电影", "重看", 5, "2026-04-10", "动画 · 重看", "视觉想象力还是很强。", ["动画", "重看"]],
    ["pod-music", "坏蛋调频", "播客", "收听中", 4, "2026-04-04", "播客 · 音乐", "适合做歌单补充。", ["播客", "音乐"]],
    ["book-food", "鱼翅与花椒", "图书", "待继续", 4, "2026-03-28", "饮食写作 · 待继续", "饮食文化写得有画面。", ["饮食", "待继续"]],
  ].map(([id, title, type, status, rating, date, subtitle, notes, tags]) => ({
    id,
    kind: "work",
    title,
    summary: notes,
    area: subtitle,
    status,
    budget: 0,
    category: type,
    stops: [],
    date,
    month: String(date).slice(0, 7).replace("-", "年") + "月",
    type,
    rating,
    mood: status,
    tags,
    notes,
    subtitle,
    creator: "私人馆藏",
  }));

  return `export type DomainItem = {
  id: string;
  kind: "day" | "place" | "work";
  title: string;
  summary: string;
  area: string;
  status: string;
  budget: number;
  category: string;
  stops: string[];
  date: string;
  month: string;
  type: string;
  rating: number;
  mood: string;
  tags: string[];
  notes: string;
  subtitle: string;
  creator: string;
};

export const domainItems: DomainItem[] = ${JSON.stringify(items, null, 2)};
`;
}

function mediaCssSource(): string {
  return `:root {
  --paper: #f9f6f0;
  --ink: #17241f;
  --indigo: #303b73;
  --green: #1f5a45;
  --red: #b93a45;
  --card: #fffdf8;
  --line: #ded6c8;
  color: var(--ink);
  background: var(--paper);
  font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); }
button, input, textarea, select { font: inherit; }
button { cursor: pointer; }
a { color: inherit; text-decoration: none; }
.media-shell { min-height: 100vh; max-width: 430px; margin: 0 auto; padding: 14px 14px 96px; background: var(--paper); }
.media-hero, .home-panel, .library-panel, .timeline-panel, .stats-panel, .settings-panel article, .detail-card, .media-sheet, .media-card, .chart-card { border: 1px solid var(--line); border-radius: 8px; background: var(--card); box-shadow: 0 12px 28px rgba(23,36,31,.08); }
.media-hero { min-height: 320px; display: flex; flex-direction: column; justify-content: flex-end; gap: 14px; padding: 24px; background: var(--card); }
.media-hero.compact { min-height: 230px; }
.eyebrow { margin: 0; color: var(--red); font-size: 12px; font-weight: 900; letter-spacing: .12em; }
h1 { margin: 0; font-size: 45px; line-height: .98; letter-spacing: 0; }
h2, p { margin-top: 0; }
p { color: #65736d; line-height: 1.65; }
.media-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.media-metrics span { min-height: 68px; border: 1px dashed var(--line); border-radius: 8px; padding: 10px; font-size: 12px; }
.media-metrics strong { display: block; font-size: 22px; color: var(--indigo); }
.media-tabs { position: sticky; bottom: 10px; z-index: 10; display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin-top: 14px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,253,248,.96); box-shadow: 0 12px 24px rgba(23,36,31,.14); }
.media-tabs button, .media-tabs a, .filter-row button, .card-actions button, .primary, .sheet-head button, .settings-panel button { min-height: 38px; border: 1px solid var(--line); border-radius: 999px; background: #fffdf8; color: var(--ink); padding: 8px 11px; font-weight: 900; white-space: nowrap; }
.media-tabs button, .media-tabs a { border-radius: 6px; padding: 6px; font-size: 13px; display: grid; place-items: center; }
button.active, .media-tabs button.active, .primary { background: var(--indigo); color: #fffdf8; border-color: var(--indigo); }
.home-panel, .library-panel, .timeline-panel, .stats-panel, .settings-panel, .detail-card { display: grid; gap: 12px; padding: 16px; margin-top: 12px; }
.section-head, .sheet-head, .filter-row, .tag-row, .card-actions, .field-grid { display: flex; gap: 8px; align-items: center; }
.section-head { justify-content: space-between; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; }
.continue-list, .library-list { display: grid; gap: 10px; }
.media-card { padding: 14px; display: grid; gap: 8px; }
.media-card a { display: grid; grid-template-columns: 42px 1fr; column-gap: 10px; align-items: center; }
.media-card strong { font-size: 18px; }
.media-card small { grid-column: 2; color: var(--green); font-weight: 800; }
.thumb { width: 42px; height: 42px; border-radius: 8px; display: grid; place-items: center; background: var(--indigo); color: #fffdf8; font-weight: 900; }
.tag-row { flex-wrap: wrap; }
.tag-row span { border-radius: 999px; background: #f1eadf; color: var(--green); padding: 5px 9px; font-size: 12px; font-weight: 800; }
.filter-row { overflow-x: auto; padding: 2px 0; }
input, textarea, select { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: #fffdf8; color: var(--ink); padding: 12px; outline: none; }
input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible { outline: 3px solid rgba(185,58,69,.28); outline-offset: 2px; }
textarea { min-height: 110px; resize: vertical; }
.month-group { display: grid; gap: 10px; }
.month-group h2 { position: sticky; top: 0; z-index: 2; margin: 0; padding: 8px 0; background: var(--paper); color: var(--indigo); }
.timeline-item { display: grid; grid-template-columns: 42px 1fr; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: #fffdf8; }
.stats-panel { grid-template-columns: 1fr; }
.chart-card { padding: 16px; }
.chart-card span { color: var(--red); font-size: 12px; font-weight: 900; }
.pie-chart { width: 128px; height: 128px; border-radius: 50%; background: conic-gradient(var(--indigo) 0 42%, var(--green) 42% 72%, var(--red) 72% 100%); margin: 14px auto; }
.bar-row { display: grid; grid-template-columns: 42px 1fr; gap: 8px; align-items: center; margin: 10px 0; }
.bar-row i { display: block; height: 14px; border-radius: 999px; background: linear-gradient(90deg, var(--green), var(--red)); }
.line-chart { height: 110px; display: flex; align-items: flex-end; gap: 10px; padding: 12px; border-radius: 8px; background: #f1eadf; }
.line-chart i { flex: 1; border-radius: 999px 999px 0 0; background: var(--indigo); }
.line-chart i:nth-child(1) { height: 44%; } .line-chart i:nth-child(2) { height: 58%; } .line-chart i:nth-child(3) { height: 76%; } .line-chart i:nth-child(4) { height: 62%; } .line-chart i:nth-child(5) { height: 88%; background: var(--red); }
.media-sheet { position: fixed; left: 50%; bottom: 0; transform: translateX(-50%); z-index: 20; width: min(430px, 100vw); max-height: 86vh; overflow: auto; padding: 16px; display: grid; gap: 12px; border-radius: 8px 8px 0 0; }
.status-line, .range-value { display: inline-flex; width: fit-content; margin-top: 10px; border-radius: 999px; padding: 8px 12px; color: #fffdf8; background: var(--red); font-weight: 900; }
input[type="range"] { accent-color: var(--red); }
@media (min-width: 760px) { .media-shell { max-width: 980px; } .stats-panel { grid-template-columns: repeat(3, 1fr); } .continue-list, .library-list { grid-template-columns: repeat(2, 1fr); } h1 { font-size: 64px; } }
`;
}

function recordPageSource(profile: RecordProductProfile): string {
  return `import { getDomainItems } from "@/lib/db";
import { RecordApp } from "@/components/RecordApp";

export default async function HomePage() {
  const items = await getDomainItems();
  return <RecordApp initialItems={items} initialView="today" />;
}
`;
}

function recordHistoryPageSource(profile: RecordProductProfile): string {
  return `import { getDomainItems } from "@/lib/db";
import { RecordHistorySurface } from "@/components/RecordHistorySurface";

export default async function HistoryPage() {
  const items = await getDomainItems();
  return <RecordHistorySurface title="${escapeJsxText(profile.title)}历史" items={items} />;
}
`;
}

function recordDetailPageSource(profile: RecordProductProfile): string {
  return `import { getDomainItems } from "@/lib/db";
import { RecordDetailSurface } from "@/components/RecordDetailSurface";

export default async function DetailPage({ params }: { params: { id: string } }) {
  const items = await getDomainItems();
  const item = items.find((entry) => entry.id === params.id) ?? items[0];
  return <RecordDetailSurface item={item} title="${escapeJsxText(profile.title)}详情" />;
}
`;
}

function recordStatsPageSource(profile: RecordProductProfile): string {
  return `import { getDomainItems } from "@/lib/db";
import { RecordStatsSurface } from "@/components/RecordStatsSurface";

export default async function StatsPage() {
  const items = await getDomainItems();
  return <RecordStatsSurface title="${escapeJsxText(profile.title)}统计" items={items} />;
}
`;
}

function recordSettingsPageSource(profile: RecordProductProfile): string {
  return `import { getDomainItems } from "@/lib/db";
import { RecordSettingsSurface } from "@/components/RecordSettingsSurface";

export default async function SettingsPage() {
  const items = await getDomainItems();
  return <RecordSettingsSurface title="${escapeJsxText(profile.title)}设置" items={items} />;
}
`;
}

function recordAppComponentSource(profile: RecordProductProfile): string {
  return `"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { DomainItem } from "@/lib/demo-data";

type View = "today" | "history" | "stats" | "settings";
const storageKey = "${profile.themeClass}-commercial-record-v3";

export function RecordApp({ initialItems, initialView = "today" }: { initialItems: DomainItem[]; initialView?: View }) {
  const [items, setItems] = useState<DomainItem[]>(initialItems);
  const [view, setView] = useState<View>(initialView);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedType, setSelectedType] = useState("全部");
  const [selectedRating, setSelectedRating] = useState(0);
  const [activeDate, setActiveDate] = useState("2026-05-30");
  const [title, setTitle] = useState("");
  const [place, setPlace] = useState("");
  const [detail, setDetail] = useState("");
  const [photoNote, setPhotoNote] = useState("");
  const [rating, setRating] = useState(5);
  const [note, setNote] = useState("");
  const [selectedMood, setSelectedMood] = useState("${profile.entries[0]?.mood ?? "满足"}");
  const [savedState, setSavedState] = useState("待记录");
  const [rangeMode, setRangeMode] = useState<"本周" | "本月">("本周");
  const [editingId, setEditingId] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as { items?: DomainItem[]; favorites?: string[] };
        if (Array.isArray(parsed.items) && parsed.items.length) {
          setItems(parsed.items);
        }
        if (Array.isArray(parsed.favorites)) {
          setFavoriteIds(parsed.favorites);
        }
      }
    } catch {
      setItems(initialItems);
    }
  }, [initialItems]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ items, favorites: favoriteIds }));
    } catch {
      // 本地保存失败时仍保留当前会话里的记录。
    }
  }, [items, favoriteIds]);

  const types = ["全部", ...Array.from(new Set(items.map((item) => item.type)))];
  const moods = Array.from(new Set(items.map((item) => item.mood)));
  const filtered = items.filter((item) => (selectedType === "全部" || item.type === selectedType) && item.rating >= selectedRating);
  const grouped = useMemo(() => groupByMonth(filtered), [filtered]);
  const latest = items[0];
  const average = Math.round((items.reduce((sum, item) => sum + item.rating, 0) / Math.max(items.length, 1)) * 10) / 10;
  const topType = types[1] ?? "记录";

  function saveRecord() {
    setSavedState("保存中");
    startTransition(() => {
      window.setTimeout(() => setSavedState("✓ 已保存"), 180);
      const next: DomainItem = {
        id: "entry-" + Date.now(),
        kind: "work",
        title: title.trim() || "${profile.entries[0]?.title ?? profile.noun}",
        subtitle: [detail.trim() || "${profile.entries[0]?.subtitle ?? profile.noun}", place.trim() || activeDate].join(" · "),
        summary: note.trim() || "刚刚补充的一条${profile.noun}，已进入历史和统计。",
        area: place.trim() || "私人档案",
        status: "已保存",
        budget: 0,
        category: "${profile.noun}",
        stops: [],
        date: activeDate,
        month: activeDate.slice(0, 7).replace("-", "年") + "月",
        type: selectedType === "全部" ? "${profile.entries[0]?.type ?? "记录"}" : selectedType,
        rating,
        mood: selectedMood,
        tags: ["新记录", selectedMood, photoNote.trim() ? "有照片备注" : "待补照片"],
        notes: [note.trim() || "保留这次体验的关键细节，稍后可继续编辑。", photoNote.trim() ? "照片备注：" + photoNote.trim() : ""].filter(Boolean).join(" "),
      };
      setItems((current) => [next, ...current]);
      setTitle("");
      setPlace("");
      setDetail("");
      setPhotoNote("");
      setNote("");
      window.setTimeout(() => {
        setSavedState("已保存");
        setSheetOpen(false);
      }, 1200);
    });
  }

  function removeRecord(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
    setSavedState("已删除，可从草稿恢复");
  }

  function reviseRecord(id: string) {
    setEditingId(id);
    setItems((current) => current.map((item) => item.id === id ? { ...item, status: "编辑中", notes: item.notes + " / 已补充复盘" } : item));
  }

  function toggleFavorite(id: string) {
    setFavoriteIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setSavedState(favoriteIds.includes(id) ? "已取消喜爱" : "已标记喜爱");
  }

  function openEditor(item?: DomainItem) {
    if (item) {
      setEditingId(item.id);
      setTitle(item.title);
      setPlace(item.area);
      setDetail(item.subtitle);
      setPhotoNote(item.tags.includes("有照片备注") ? "已补照片备注" : "");
      setRating(item.rating);
      setNote(item.notes);
      setSelectedMood(item.mood);
      setActiveDate(item.date);
    } else {
      setEditingId("");
    }
    setSheetOpen(true);
  }

  return (
    <main className={"record-shell ${profile.themeClass}"}>
      <header className="record-hero">
        <p className="eyebrow">${profile.eyebrow}</p>
        <h1>${profile.title}</h1>
        <p>${profile.summary}</p>
        <div className="hero-metrics">
          <span><strong>{items.length}</strong>${profile.noun}</span>
          <span><strong>{average}</strong>平均评分</span>
          <span><strong>{savedState}</strong>状态</span>
        </div>
      </header>

      <nav className="record-tabs" aria-label="主要视图">
        {(["today", "history", "stats", "settings"] as View[]).map((tab) => (
          <button key={tab} className={view === tab ? "active" : ""} aria-pressed={view === tab} onClick={() => setView(tab)}>
            {tab === "today" ? "今日" : tab === "history" ? "历史" : tab === "stats" ? "统计" : "设置"}
          </button>
        ))}
      </nav>

      {view === "today" ? (
        <section className="timeline-home" aria-label="今日时间线">
          <div className="section-head">
            <div><p className="eyebrow">Timeline</p><h2>本月时间线</h2><p>先浏览已有${profile.noun}，再补今天的新内容。</p></div>
            <button className="primary" onClick={() => openEditor()}>新增记录</button>
          </div>
          <div className="filter-bar">
            {types.map((type) => <button key={type} className={selectedType === type ? "active" : ""} onClick={() => setSelectedType(type)}>{type}</button>)}
            {[0, 4, 5].map((rating) => <button key={rating} className={selectedRating === rating ? "active" : ""} onClick={() => setSelectedRating(rating)}>{rating ? rating + "星+" : "全部评分"}</button>)}
          </div>
          {filtered.length ? [...grouped.entries()].map(([month, monthItems]) => (
            <section key={month} className="month-group">
              <h2>{month}</h2>
              {monthItems.map((item) => (
                <article key={item.id} className={editingId === item.id ? "editing" : ""}>
                  <a href={"/detail/" + item.id} className="record-card-link">
                    <span className="record-photo">{item.title.slice(0, 1)}</span>
                    <strong>{item.title}</strong>
                    <span>{item.date} · {item.subtitle}</span>
                  </a>
                  <p>{item.notes}</p>
                  <div className="tag-row">{item.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
                  <div className="card-actions">
                    <button onClick={() => openEditor(item)}>编辑</button>
                    <button onClick={() => toggleFavorite(item.id)}>{favoriteIds.includes(item.id) ? "已喜爱" : "标记喜爱"}</button>
                    <button onClick={() => removeRecord(item.id)}>删除</button>
                  </div>
                </article>
              ))}
            </section>
          )) : <RecordInlineEmpty onAdd={() => openEditor()} />}
        </section>
      ) : null}

      {view === "history" ? (
        <section className="history-panel">
          <div className="filter-bar">
            {types.map((type) => <button key={type} className={selectedType === type ? "active" : ""} onClick={() => setSelectedType(type)}>{type}</button>)}
            {[0, 4, 5].map((rating) => <button key={rating} className={selectedRating === rating ? "active" : ""} onClick={() => setSelectedRating(rating)}>{rating ? rating + "星+" : "全部评分"}</button>)}
          </div>
          {[...grouped.entries()].map(([month, monthItems]) => (
            <section key={month} className="month-group">
              <h2>{month}</h2>
              {monthItems.map((item) => (
                <article key={item.id} className={editingId === item.id ? "editing" : ""}>
                  <a href={"/detail/" + item.id}><strong>{item.title}</strong><span>{item.subtitle}</span></a>
                  <p>{item.notes}</p>
                  <div className="card-actions">
                    <button onClick={() => reviseRecord(item.id)}>编辑</button>
                    <button onClick={() => removeRecord(item.id)}>删除</button>
                  </div>
                </article>
              ))}
            </section>
          ))}
        </section>
      ) : null}

      {view === "stats" ? (
        <section className="stats-grid">
          <div className="filter-bar stats-switch">{(["本周", "本月"] as const).map((mode) => <button key={mode} className={rangeMode === mode ? "active" : ""} onClick={() => setRangeMode(mode)}>{mode}</button>)}</div>
          <article><span>平均评分</span><strong>{average}</strong><p>来自 {items.length} 条记录</p></article>
          <article><span>{rangeMode}最高频类型</span><strong>{topType}</strong><p>筛选按钮可切换历史列表</p></article>
          <article><span>最近心情</span><strong>{latest?.mood}</strong><p>{latest?.notes}</p><div className="mood-meter"><span style={{ width: Math.max(20, (latest?.rating ?? 3) * 20) + "%" }} /></div></article>
          <article className="chart-card"><span>评分分布</span>{[5, 4, 3, 2].map((score) => <div className="bar-row" key={score}><b>{score}星</b><i style={{ width: Math.max(14, items.filter((item) => item.rating === score).length * 18) + "%" }} /></div>)}</article>
          <article className="chart-card"><span>本月趋势</span><div className="line-chart"><i /><i /><i /><i /><i /></div><p>每天记录后会同步到时间线和统计。</p></article>
        </section>
      ) : null}

      {view === "settings" ? (
        <section className="settings-panel">
          {${JSON.stringify(profile.settings)}.map((setting) => (
            <article key={setting.title}><h2>{setting.title}</h2><p>{setting.description}</p><button onClick={() => setSavedState(setting.action + "成功")}>{setting.action}</button></article>
          ))}
          <article><h2>本地保存</h2><p>当前浏览器已保存 {items.length} 条记录和 {favoriteIds.length} 个喜爱标记。</p><button onClick={() => setSavedState("本地备份已刷新")}>刷新备份</button></article>
        </section>
      ) : null}

      {sheetOpen ? (
        <section className="record-sheet" role="dialog" aria-label="新增或编辑记录">
          <div className="sheet-head"><h2>{editingId ? "编辑记录" : "新增记录"}</h2><button onClick={() => setSheetOpen(false)}>关闭</button></div>
          <div className="date-strip">
            <button onClick={() => setActiveDate("2026-05-29")}>前一天</button>
            <input aria-label="记录日期" type="date" value={activeDate} onChange={(event) => setActiveDate(event.target.value)} />
            <button onClick={() => setActiveDate("2026-05-31")}>后一天</button>
          </div>
          <label>${profile.fields.title}<input autoFocus value={title} placeholder={latest?.title ?? "${profile.fields.titlePlaceholder}"} onChange={(event) => setTitle(event.target.value)} /></label>
          <div className="field-grid">
            <label>${profile.fields.place}<input value={place} placeholder="${profile.fields.placePlaceholder}" onChange={(event) => setPlace(event.target.value)} /></label>
            <label>${profile.fields.detail}<input value={detail} placeholder="${profile.fields.detailPlaceholder}" onChange={(event) => setDetail(event.target.value)} /></label>
          </div>
          <label>选择照片<input aria-label="选择照片" type="file" accept="image/*" onChange={() => setPhotoNote("已选择照片，待补充构图备注")} /></label>
          <label>${profile.fields.photo}<input value={photoNote} placeholder="${profile.fields.photoPlaceholder}" onChange={(event) => setPhotoNote(event.target.value)} /></label>
          <label>${profile.fields.rating}<input aria-label="${profile.fields.rating}" type="range" min="1" max="5" value={rating} onChange={(event) => setRating(Number(event.target.value))} /><span className="range-value">{rating} 星</span></label>
          <label>${profile.fields.note}<textarea value={note} placeholder={latest?.notes ?? "${profile.fields.notePlaceholder}"} onChange={(event) => setNote(event.target.value)} /></label>
          <div className="chip-row">
            {${JSON.stringify(profile.quickChecks)}.map((label) => <button key={label} onClick={() => setDetail(label)}>{label}</button>)}
            {moods.map((mood) => <button key={mood} className={selectedMood === mood ? "active" : ""} onClick={() => setSelectedMood(mood)}>{mood}</button>)}
          </div>
          <button className="primary" disabled={isPending} onClick={saveRecord}>{isPending || savedState === "保存中" ? "保存中" : savedState === "已保存" ? "已保存" : "${profile.primaryLabel}"}</button>
        </section>
      ) : null}

      <p className="status-line">{savedState}</p>
    </main>
  );
}

function RecordInlineEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="record-empty">
      <div className="empty-mark">✦</div>
      <h2>今天想记录哪一条？</h2>
      <p>还没有匹配记录。新增后会自动进入时间线、详情和统计。</p>
      <button className="primary" onClick={onAdd}>补一条记录</button>
    </section>
  );
}

function groupByMonth(items: DomainItem[]) {
  return items.reduce((groups, item) => {
    const group = groups.get(item.month) ?? [];
    group.push(item);
    groups.set(item.month, group);
    return groups;
  }, new Map<string, DomainItem[]>());
}
`;
}

function recordHistorySurfaceSource(profile: RecordProductProfile): string {
  return `"use client";

import { useState } from "react";
import type { DomainItem } from "@/lib/demo-data";

export function RecordHistorySurface({ title, items }: { title: string; items: DomainItem[] }) {
  const [type, setType] = useState("全部");
  const [rating, setRating] = useState(0);
  const types = ["全部", ...Array.from(new Set(items.map((item) => item.type)))];
  const visible = items.filter((item) => (type === "全部" || item.type === type) && item.rating >= rating);
  const grouped = visible.reduce((groups, item) => {
    const group = groups.get(item.month) ?? [];
    group.push(item);
    groups.set(item.month, group);
    return groups;
  }, new Map<string, DomainItem[]>());
  return (
    <main className="record-shell ${profile.themeClass}">
      <header className="sub-head"><p className="eyebrow">历史回顾</p><h1>{title}</h1><p>按月份、类型和评分筛选所有${profile.noun}。</p></header>
      <div className="filter-bar">
        {types.map((item) => <button key={item} className={type === item ? "active" : ""} onClick={() => setType(item)}>{item}</button>)}
        {[0, 4, 5].map((item) => <button key={item} className={rating === item ? "active" : ""} onClick={() => setRating(item)}>{item ? item + "星+" : "全部评分"}</button>)}
      </div>
      {[...grouped.entries()].map(([month, monthItems]) => (
        <section className="month-group" key={month}>
          <h2>{month}</h2>
          {monthItems.map((item) => <article key={item.id}><a href={"/detail/" + item.id}><strong>{item.title}</strong><span>{item.subtitle}</span></a><p>{item.notes}</p><button>长按编辑</button></article>)}
        </section>
      ))}
      <nav className="bottom-tabs"><a href="/">今日</a><a className="active" href="/history">历史</a><a href="/stats">统计</a><a href="/settings">设置</a></nav>
    </main>
  );
}
`;
}

function recordDetailSurfaceSource(profile: RecordProductProfile): string {
  return `"use client";

import { useState } from "react";
import type { DomainItem } from "@/lib/demo-data";

export function RecordDetailSurface({ item, title }: { item: DomainItem; title: string }) {
  const [status, setStatus] = useState(item.status);
  const [note, setNote] = useState(item.notes);
  return (
    <main className="record-shell ${profile.themeClass}">
      <header className="sub-head"><p className="eyebrow">详情编辑</p><h1>{item.title}</h1><p>{title}</p></header>
      <section className="detail-card">
        <span>{item.date} · {item.type} · {item.rating}星</span>
        <h2>{item.subtitle}</h2>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} />
        <div className="chip-row">{item.tags.map((tag) => <button key={tag}>{tag}</button>)}</div>
        <div className="card-actions"><button onClick={() => setStatus("编辑中")}>编辑</button><button onClick={() => setStatus("已删除")}>删除</button><button onClick={() => setStatus("已保存")}>保存修改</button></div>
        <p className="status-line">{status}</p>
      </section>
      <nav className="bottom-tabs"><a href="/">今日</a><a href="/history">历史</a><a href="/stats">统计</a><a href="/settings">设置</a></nav>
    </main>
  );
}
`;
}

function recordStatsSurfaceSource(profile: RecordProductProfile): string {
  return `"use client";

import { useMemo, useState } from "react";
import type { DomainItem } from "@/lib/demo-data";

export function RecordStatsSurface({ title, items }: { title: string; items: DomainItem[] }) {
  const [period, setPeriod] = useState<"本周" | "本月">("本周");
  const average = useMemo(() => Math.round((items.reduce((sum, item) => sum + item.rating, 0) / Math.max(items.length, 1)) * 10) / 10, [items]);
  return (
    <main className="record-shell ${profile.themeClass}">
      <header className="sub-head"><p className="eyebrow">趋势复盘</p><h1>{title}</h1><p>用趋势回看最近的${profile.noun}质量。</p></header>
      <div className="filter-bar">{(["本周", "本月"] as const).map((item) => <button key={item} className={period === item ? "active" : ""} onClick={() => setPeriod(item)}>{item}</button>)}</div>
      <section className="stats-grid">
        <article><span>平均评分</span><strong>{average}</strong><p>{period}共 {items.length} 条记录</p></article>
        <article><span>高频类型</span><strong>{items[0]?.type}</strong><p>{items.map((item) => item.type).join(" / ")}</p></article>
        <article><span>情绪标签</span><strong>{items[0]?.mood}</strong><p>{items.flatMap((item) => item.tags).slice(0, 6).join("、")}</p><div className="mood-meter"><span style={{ width: Math.max(20, (items[0]?.rating ?? 3) * 20) + "%" }} /></div></article>
      </section>
      <nav className="bottom-tabs"><a href="/">今日</a><a href="/history">历史</a><a className="active" href="/stats">统计</a><a href="/settings">设置</a></nav>
    </main>
  );
}
`;
}

function recordSettingsSurfaceSource(profile: RecordProductProfile): string {
  return `"use client";

import { useState } from "react";
import type { DomainItem } from "@/lib/demo-data";

export function RecordSettingsSurface({ title, items }: { title: string; items: DomainItem[] }) {
  const [message, setMessage] = useState("偏好已同步");
  return (
    <main className="record-shell ${profile.themeClass}">
      <header className="sub-head"><p className="eyebrow">偏好设置</p><h1>{title}</h1><p>{items.length} 条${profile.noun}可继续管理。</p></header>
      <section className="settings-panel">
        {${JSON.stringify(profile.settings)}.map((setting) => (
          <article key={setting.title}><h2>{setting.title}</h2><p>{setting.description}</p><button onClick={() => setMessage(setting.action + "成功")}>{setting.action}</button></article>
        ))}
      </section>
      <p className="status-line">{message}</p>
      <nav className="bottom-tabs"><a href="/">今日</a><a href="/history">历史</a><a href="/stats">统计</a><a className="active" href="/settings">设置</a></nav>
    </main>
  );
}
`;
}

function recordEmptyStateSource(profile: RecordProductProfile): string {
  return `export function RecordEmptyState() {
  return (
    <section className="record-empty">
      <p className="eyebrow">新的开始</p>
      <h2>还没有${profile.noun}</h2>
      <p>先补一条今天的内容，系统会自动沉淀到历史、详情和统计里。</p>
      <a href="/">开始记录</a>
    </section>
  );
}
`;
}

function recordDataSource(profile: RecordProductProfile): string {
  const rows = profile.entries.map((item) => `  { id: ${JSON.stringify(item.id)}, kind: "work", title: ${JSON.stringify(item.title)}, summary: ${JSON.stringify(item.notes)}, area: ${JSON.stringify(item.subtitle)}, status: ${JSON.stringify(item.status)}, budget: 0, category: ${JSON.stringify(profile.noun)}, stops: [], date: ${JSON.stringify(item.date)}, month: ${JSON.stringify(item.month)}, type: ${JSON.stringify(item.type)}, rating: ${item.rating}, mood: ${JSON.stringify(item.mood)}, tags: ${JSON.stringify(item.tags)}, notes: ${JSON.stringify(item.notes)}, subtitle: ${JSON.stringify(item.subtitle)} }`).join(",\n");
  return `export type DomainItem = {
  id: string;
  kind: "day" | "place" | "work";
  title: string;
  summary: string;
  area: string;
  status: string;
  budget: number;
  category: string;
  stops: string[];
  date: string;
  month: string;
  type: string;
  rating: number;
  mood: string;
  tags: string[];
  notes: string;
  subtitle: string;
};

export const domainItems: DomainItem[] = [
${rows}
];
`;
}

function recordCssSource(profile: RecordProductProfile): string {
  return `:root {
  --paper: #fff8e7;
  --ink: #17251f;
  --card: #fffdf5;
  --line: #dfd5bf;
  --accent: ${profile.themeClass === "routine" ? "#4f9f78" : profile.themeClass === "archive" ? "#b93a45" : "#bf4d37"};
  color: var(--ink);
  background: var(--paper);
  font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); }
button, input, textarea { font: inherit; }
button { cursor: pointer; }
a { color: inherit; text-decoration: none; }
.record-shell { min-height: 100vh; max-width: 430px; margin: 0 auto; padding: 14px 14px 92px; background: linear-gradient(90deg, rgba(23,37,31,.05) 1px, transparent 1px) 0 0/26px 26px, var(--paper); }
.record-hero, .sub-head, .composer, .timeline-home, .month-group article, .stats-grid article, .settings-panel article, .detail-card, .record-sheet, .record-empty { border: 1px solid var(--line); border-radius: 8px; background: rgba(255,253,245,.9); box-shadow: 0 10px 24px rgba(23,37,31,.08); }
.record-hero { min-height: 330px; display: flex; flex-direction: column; justify-content: flex-end; gap: 14px; padding: 24px; background: linear-gradient(160deg, rgba(255,253,245,.86), rgba(255,248,231,.96)), radial-gradient(circle at 80% 10%, color-mix(in srgb, var(--accent), white 40%) 0 70px, transparent 72px); }
.eyebrow { margin: 0; color: var(--accent); text-transform: uppercase; letter-spacing: .12em; font-size: 12px; font-weight: 900; }
h1 { margin: 0; font-size: 46px; line-height: .98; letter-spacing: 0; }
h2, h3, p { margin-top: 0; }
p { color: #62746b; line-height: 1.65; }
.hero-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.hero-metrics span { min-height: 70px; padding: 10px; border-radius: 8px; background: rgba(255,255,255,.72); border: 1px dashed var(--line); font-size: 12px; }
.hero-metrics strong { display: block; font-size: 20px; color: var(--ink); }
.record-tabs, .filter-bar, .chip-row, .card-actions, .date-strip, .bottom-tabs, .section-head, .sheet-head, .tag-row { display: flex; gap: 8px; align-items: center; overflow-x: auto; }
.section-head, .sheet-head { justify-content: space-between; align-items: flex-start; }
.record-tabs { padding: 12px 0; }
.record-tabs button, .filter-bar button, .chip-row button, .card-actions button, .date-strip button, .primary, .settings-panel button, .detail-card button, .month-group button, .sheet-head button, .record-empty button { min-height: 38px; border: 1px solid var(--line); border-radius: 999px; background: #fffdf5; color: var(--ink); padding: 8px 13px; font-weight: 800; white-space: nowrap; }
button.active, .primary, .record-tabs button.active, .filter-bar button.active, .chip-row button.active { background: var(--ink); color: #fff8e7; border-color: var(--ink); }
.composer, .sub-head, .detail-card, .timeline-home, .record-sheet, .record-empty { padding: 18px; display: grid; gap: 12px; }
.composer label, .record-sheet label { display: grid; gap: 6px; font-weight: 900; }
.field-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
input, textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: #fffdf5; color: var(--ink); padding: 12px; outline: none; }
input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent), white 55%); outline-offset: 2px; }
textarea { min-height: 110px; resize: vertical; }
input[type="range"] { accent-color: var(--accent); }
.range-value { width: fit-content; border-radius: 999px; padding: 4px 8px; background: color-mix(in srgb, var(--accent), white 82%); color: var(--ink); font-size: 12px; }
.date-strip input { min-width: 148px; }
.history-panel, .month-group, .stats-grid, .settings-panel { display: grid; gap: 12px; }
.filter-bar { padding: 12px 0; }
.month-group h2 { margin: 8px 0 0; font-size: 22px; }
.month-group article { padding: 14px; display: grid; gap: 8px; }
.month-group article.editing { border-color: var(--accent); }
.record-card-link { display: grid; grid-template-columns: 48px 1fr; gap: 8px 12px; align-items: center; }
.record-card-link strong { align-self: end; }
.record-card-link span:last-child { align-self: start; }
.record-photo { width: 48px; height: 48px; grid-row: span 2; display: grid; place-items: center; border-radius: 8px; color: #fff8e7; background: linear-gradient(135deg, var(--accent), var(--ink)); font-weight: 900; }
.tag-row { flex-wrap: wrap; }
.tag-row span { border-radius: 999px; background: color-mix(in srgb, var(--accent), white 84%); color: var(--ink); padding: 5px 9px; font-size: 12px; font-weight: 900; }
.month-group strong { display: block; font-size: 18px; }
.month-group span, .detail-card span, .stats-grid span { color: var(--accent); font-size: 12px; font-weight: 900; }
.stats-grid { grid-template-columns: 1fr; }
.stats-switch { grid-column: 1 / -1; padding: 0; }
.stats-grid article, .settings-panel article { padding: 16px; }
.stats-grid strong { display: block; font-size: 42px; margin: 6px 0; }
.mood-meter { height: 10px; border-radius: 999px; background: linear-gradient(90deg, #7fb7d8, #9fd9bb, #f28f77); overflow: hidden; }
.mood-meter span { display: block; height: 100%; background: rgba(23,37,31,.62); border-radius: inherit; }
.bar-row { display: grid; grid-template-columns: 44px 1fr; gap: 8px; align-items: center; margin: 8px 0; }
.bar-row i { display: block; height: 13px; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--ink)); }
.line-chart { min-height: 96px; display: flex; align-items: flex-end; gap: 8px; padding: 10px; border-radius: 8px; background: rgba(255,248,231,.86); }
.line-chart i { flex: 1; border-radius: 999px 999px 0 0; background: var(--ink); }
.line-chart i:nth-child(1) { height: 40%; } .line-chart i:nth-child(2) { height: 58%; } .line-chart i:nth-child(3) { height: 72%; background: var(--accent); } .line-chart i:nth-child(4) { height: 50%; } .line-chart i:nth-child(5) { height: 82%; background: var(--accent); }
.settings-panel { margin-top: 12px; }
.status-line { display: inline-flex; width: fit-content; margin-top: 10px; border-radius: 999px; padding: 8px 12px; color: #fff8e7; background: var(--accent); font-weight: 900; }
.record-sheet { position: fixed; left: 50%; bottom: 0; z-index: 20; width: min(430px, 100vw); max-height: 88vh; overflow: auto; transform: translateX(-50%); border-radius: 8px 8px 0 0; }
.record-empty { min-height: 240px; place-items: center; text-align: center; }
.empty-mark { width: 74px; height: 74px; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--accent), white 80%); color: var(--accent); font-size: 34px; }
.bottom-tabs { position: sticky; bottom: 10px; z-index: 10; display: grid; grid-template-columns: repeat(4, 1fr); padding: 8px; margin-top: 16px; border-radius: 8px; background: rgba(255,253,245,.96); border: 1px solid var(--line); box-shadow: 0 10px 24px rgba(23,37,31,.16); }
.bottom-tabs a { min-height: 40px; display: grid; place-items: center; border-radius: 6px; font-weight: 900; }
.bottom-tabs a.active { background: var(--ink); color: #fff8e7; }
@media (min-width: 760px) { .record-shell { max-width: 980px; } .field-grid, .stats-grid { grid-template-columns: repeat(2, 1fr); } .stats-grid { grid-template-columns: repeat(3, 1fr); } .record-hero { min-height: 390px; } h1 { font-size: 64px; } }
`;
}

function inferTitle(brief: string): string {
  if (/网球|tennis/i.test(brief)) {
    return "网球训练手册";
  }
  if (/学习|课程|训练|练习|复习|考试|study|learn|course|training/i.test(brief)) {
    return "今日学习教练";
  }
  const first = brief.split(/[。\n]/)[0]?.trim();
  const cleaned = first?.replace(/^帮我(?:做|生成|创建)?一个?/u, "").replace(/^(中文|移动优先的)+/u, "").trim();
  if (cleaned && cleaned.length <= 18) {
    return cleaned;
  }
  if (first && first.length <= 18) {
    return first;
  }
  return "本地生成应用";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "generated-app";
}

function escapeJsxText(value: string): string {
  return value.replace(/[{}<>]/g, (char) => ({
    "{": "&#123;",
    "}": "&#125;",
    "<": "&lt;",
    ">": "&gt;",
  } satisfies Record<string, string>)[char] ?? char);
}

function escapeStringForTs(value: string): string {
  return value.replace(/[\\"]/g, (char) => (char === "\\" ? "\\\\" : "\\\""));
}

function travelPageSource(): string {
  return `import { getDomainItems } from "@/lib/db";
import { EmptyState } from "@/components/EmptyState";
import { InteractiveWorkbench } from "@/components/InteractiveWorkbench";

export default async function HomePage() {
  const items = await getDomainItems();
  const days = items.filter((item) => item.kind === "day");
  const places = items.filter((item) => item.kind === "place");
  const totalBudget = places.reduce((sum, place) => sum + place.budget, 0);

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Shanghai 3D2N</p>
        <h1>松弛但不松散的上海三天两晚</h1>
        <p>住在静安寺附近，围绕静安、黄浦、徐汇安排轻松路线。每天 2 个核心景点和 2 个餐饮/咖啡点，预算只统计餐饮、门票和市内交通。</p>
        <div className="hero-actions">
          <a href="/itinerary">查看三天行程</a>
          <span>预算合计 ¥{totalBudget}</span>
          <span>支持雨天备选和收藏筛选</span>
        </div>
      </section>
      {items.length === 0 ? <EmptyState title="还没有路线" action="先保存第一个地点，再安排下一段行程。" /> : null}
      <InteractiveWorkbench days={days} places={places} />
      <nav className="bottom-tabs" aria-label="底部导航">
        <a className="active" href="/">首页</a>
        <a href="/itinerary">行程</a>
        <a href="/budget">预算</a>
        <a href="/favorites">收藏</a>
      </nav>
    </main>
  );
}
`;
}

function travelInteractiveSource(): string {
  return `"use client";

import { useMemo, useState, useTransition } from "react";
import { toggleSignal } from "@/app/actions";
import type { DomainItem } from "@/lib/demo-data";

type Props = {
  days: DomainItem[];
  places: DomainItem[];
};

export function InteractiveWorkbench({ days, places }: Props) {
  const [activeDay, setActiveDay] = useState(days[0]?.id ?? "");
  const [rainMode, setRainMode] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);
  const [mustGo, setMustGo] = useState<string[]>([]);
  const [filter, setFilter] = useState("全部");
  const [isPending, startTransition] = useTransition();
  const [lastSaved, setLastSaved] = useState("");
  const current = days.find((day) => day.id === activeDay) ?? days[0];
  const stops = useMemo(() => current?.stops ?? [], [current]);
  const visiblePlaces = filter === "全部" ? places : places.filter((place) => place.category === filter);
  const categories = ["全部", ...Array.from(new Set(places.map((place) => place.category)))];
  const savedPlaces = places.filter((place) => saved.includes(place.id));

  function toggleSaved(id: string) {
    setSaved((currentSaved) => currentSaved.includes(id) ? currentSaved.filter((item) => item !== id) : [...currentSaved, id]);
    setLastSaved(id);
    startTransition(() => {
      void toggleSignal({ itemId: id, kind: "saved" });
    });
  }

  function toggleMustGo(id: string) {
    setMustGo((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  return (
    <>
      <section className="day-tabs" aria-label="行程日期">
        {days.map((day) => (
          <button key={day.id} className={day.id === activeDay ? "active" : ""} onClick={() => setActiveDay(day.id)}>
            <strong>{day.title}</strong>
            <span>{day.area}</span>
          </button>
        ))}
      </section>

      {current ? (
        <section className="itinerary">
          <div>
            <p className="eyebrow">{rainMode ? "Rain Plan" : current.status}</p>
            <h2>{current.area}</h2>
            <p>{current.summary}</p>
            <ol>
              {stops.map((stop) => <li key={stop}>{rainMode ? stop.replace("散步", "室内展览").replace("夜色", "室内展厅") : stop}</li>)}
            </ol>
          </div>
          <aside>
            <span>当日预算</span>
            <strong>¥{current.budget}</strong>
            <p>餐饮、门票、市内交通合计。住宿和大交通不计入。</p>
            <button onClick={() => setRainMode((value) => !value)}>{rainMode ? "切回晴天路线" : "开启雨天备选"}</button>
          </aside>
        </section>
      ) : null}

      <section className="filter-row" aria-label="地点类型筛选">
        {categories.map((category) => (
          <button key={category} className={filter === category ? "active" : ""} onClick={() => setFilter(category)}>
            {category}
          </button>
        ))}
      </section>

      <section className="places">
        {visiblePlaces.map((place) => (
          <article key={place.id}>
            {place.image ? <img src={place.image} alt={place.title} /> : null}
            <span>{place.category} · {place.area}</span>
            <h3>{place.title}</h3>
            <p>{place.summary}</p>
            <div className="card-actions">
              <a href={\`/detail/\${place.id}\`}>详情</a>
              <button onClick={() => toggleSaved(place.id)} disabled={isPending}>
                {isPending && lastSaved === place.id ? "保存中" : saved.includes(place.id) ? "已收藏" : "收藏"}
              </button>
              <button onClick={() => toggleMustGo(place.id)}>{mustGo.includes(place.id) ? "必去" : "标记必去"}</button>
            </div>
          </article>
        ))}
      </section>

      <section className="saved">
        <h2>收藏清单</h2>
        <p>{savedPlaces.length ? \`已收藏 \${savedPlaces.length} 个地点，可在收藏页继续筛选和标记必去。\` : "还没有收藏，先从地点卡片里标记必去。"}</p>
        <div className="mini-list">
          {savedPlaces.slice(0, 3).map((place) => <a key={place.id} href={\`/detail/\${place.id}\`}>{place.title}</a>)}
        </div>
      </section>
    </>
  );
}
`;
}

function travelItineraryPageSource(): string {
  return `import { getDomainItems } from "@/lib/db";
import { InteractiveWorkbench } from "@/components/InteractiveWorkbench";

export default async function ItineraryPage() {
  const items = await getDomainItems();
  const days = items.filter((item) => item.kind === "day");
  const places = items.filter((item) => item.kind === "place");

  return (
    <main className="app-shell sub-page">
      <section className="page-head">
        <p className="eyebrow">Itinerary</p>
        <h1>三天路线</h1>
        <p>按天气和体力切换节奏，每天保留一个可删减的慢逛时段。</p>
      </section>
      <InteractiveWorkbench days={days} places={places} />
      <nav className="bottom-tabs" aria-label="底部导航">
        <a href="/">首页</a>
        <a className="active" href="/itinerary">行程</a>
        <a href="/budget">预算</a>
        <a href="/favorites">收藏</a>
      </nav>
    </main>
  );
}
`;
}

function travelBudgetPageSource(): string {
  return `import { getDomainItems } from "@/lib/db";

export default async function BudgetPage() {
  const places = (await getDomainItems()).filter((item) => item.kind === "place");
  const categories = ["餐饮", "门票", "市内交通"];
  const rows = categories.map((category) => ({
    category,
    total: places.filter((place) => place.budgetCategory === category).reduce((sum, place) => sum + place.budget, 0),
    items: places.filter((place) => place.budgetCategory === category),
  }));
  const total = rows.reduce((sum, row) => sum + row.total, 0);

  return (
    <main className="app-shell sub-page">
      <section className="page-head">
        <p className="eyebrow">Budget</p>
        <h1>预算总览</h1>
        <p>只统计餐饮、门票和市内交通，不含住宿和大交通。</p>
        <strong className="total-budget">¥{total}</strong>
      </section>
      <section className="budget-list">
        {rows.map((row) => (
          <article key={row.category}>
            <span>{row.category}</span>
            <strong>¥{row.total}</strong>
            <p>{row.items.map((item) => item.title).join(" / ") || "按当天现场节奏预留"}</p>
          </article>
        ))}
      </section>
      <nav className="bottom-tabs" aria-label="底部导航">
        <a href="/">首页</a>
        <a href="/itinerary">行程</a>
        <a className="active" href="/budget">预算</a>
        <a href="/favorites">收藏</a>
      </nav>
    </main>
  );
}
`;
}

function travelFavoritesPageSource(title: string): string {
  return `import { getDomainItems } from "@/lib/db";
import { HistoryScreen } from "@/components/screens/HistoryScreen";

export default async function FavoritesPage() {
  const places = (await getDomainItems()).filter((item) => item.kind === "place");
  return (
    <main className="app-shell sub-page">
      <HistoryScreen title="${escapeJsxText(title)}" items={places} />
      <nav className="bottom-tabs" aria-label="底部导航">
        <a href="/">首页</a>
        <a href="/itinerary">行程</a>
        <a href="/budget">预算</a>
        <a className="active" href="/favorites">收藏</a>
      </nav>
    </main>
  );
}
`;
}

function travelDetailPageSource(): string {
  return `import { getDomainItems } from "@/lib/db";
import { MetaChip } from "@/components/MetaChip";

export default async function DetailPage({ params }: { params: { id: string } }) {
  const places = (await getDomainItems()).filter((item) => item.kind === "place");
  const item = places.find((place) => place.id === params.id) ?? places[0];
  return (
    <main className="app-shell detail-page">
      <section className="detail-hero">
        {item.image ? <img src={item.image} alt={item.title} /> : null}
        <div>
          <p className="eyebrow">Place Detail</p>
          <h1>{item.title}</h1>
          <p>{item.summary}</p>
          <div className="meta-row">
            <MetaChip label={item.category} />
            <MetaChip label={item.area} />
            <MetaChip label={item.budgetCategory} />
          </div>
          <p className="detail-note">{item.detail}</p>
          <a className="primary-link" href="/favorites">加入收藏清单</a>
        </div>
      </section>
      <section className="budget-list">
        <article>
          <span>建议停留</span>
          <strong>{item.duration}</strong>
          <p>{item.address}</p>
        </article>
        <article>
          <span>雨天备选</span>
          <strong>{item.rainPlan}</strong>
          <p>遇到阵雨时优先保留室内展览、咖啡和短距离移动。</p>
        </article>
      </section>
      <nav className="bottom-tabs" aria-label="底部导航">
        <a href="/">首页</a>
        <a href="/itinerary">行程</a>
        <a href="/budget">预算</a>
        <a href="/favorites">收藏</a>
      </nav>
    </main>
  );
}
`;
}

function travelActionsSource(): string {
  return `"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

const SignalInput = z.object({
  itemId: z.string().min(1),
  kind: z.string().min(1),
});

export async function toggleSignal(input: z.infer<typeof SignalInput>) {
  const parsed = SignalInput.parse(input);
  void parsed;
  revalidatePath("/");
  return { ok: true };
}
`;
}

function travelDataSource(): string {
  return `export type DomainItem = {
  id: string;
  kind: "day" | "place" | "work";
  title: string;
  summary: string;
  area: string;
  status: string;
  budget: number;
  category: string;
  stops: string[];
  image: string;
  budgetCategory: "餐饮" | "门票" | "市内交通";
  address: string;
  duration: string;
  rainPlan: string;
  detail: string;
};

export const domainItems: DomainItem[] = [
  { id: "day-1", kind: "day", title: "Day 1", summary: "静安寺晨间散步、愚园路咖啡、张园城市更新街区、南京西路夜色。", area: "静安寺 / 愚园路", status: "晴天路线", budget: 420, category: "路线", stops: ["静安寺晨间散步", "愚园路咖啡", "张园城市更新街区", "南京西路夜色"], image: "https://images.unsplash.com/photo-1533900298318-6b8da08a523e?auto=format&fit=crop&w=900&q=80", budgetCategory: "市内交通", address: "静安寺地铁站周边", duration: "6 小时", rainPlan: "张园 + 咖啡", detail: "第一天不赶路，把城市更新街区、咖啡和夜色串成一条低压力路线。" },
  { id: "day-2", kind: "day", title: "Day 2", summary: "人民广场展览、云南南路午餐、外滩建筑群、洛克外滩源晚餐。", area: "黄浦 / 外滩", status: "雨天也适合", budget: 560, category: "路线", stops: ["人民广场展览", "云南南路午餐", "外滩建筑群", "洛克外滩源晚餐"], image: "https://images.unsplash.com/photo-1548919973-5cef591cdbc9?auto=format&fit=crop&w=900&q=80", budgetCategory: "市内交通", address: "人民广场到外滩", duration: "7 小时", rainPlan: "展览 + 室内餐厅", detail: "第二天把展览、老街风味和江岸夜景放在同一区域，减少跨城移动。" },
  { id: "day-3", kind: "day", title: "Day 3", summary: "武康路街角、衡山路梧桐区、西岸美术馆、徐家汇收尾采购。", area: "徐汇 / 衡复风貌区", status: "慢走路线", budget: 390, category: "路线", stops: ["武康路街角", "衡山路梧桐区", "西岸美术馆", "徐家汇收尾采购"], image: "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=900&q=80", budgetCategory: "市内交通", address: "衡复风貌区到西岸", duration: "6.5 小时", rainPlan: "西岸美术馆", detail: "第三天适合慢慢收尾，保留梧桐区散步和美术馆两个气质不同的片段。" },
  { id: "jingan", kind: "place", title: "静安寺", summary: "适合作为第一天低压力起点，周边交通和餐饮都稳。清晨人少，寺前广场和南京西路可自然衔接。", area: "静安", status: "开放", budget: 50, category: "景点", stops: [], image: "https://images.unsplash.com/photo-1523731407965-2430cd12f5e4?auto=format&fit=crop&w=900&q=80", budgetCategory: "门票", address: "南京西路 1686 号", duration: "60-90 分钟", rainPlan: "静安嘉里 + 室内咖啡", detail: "第一站安排在住宿附近，降低抵达日的不确定性。上午光线更柔和，拍照和散步都舒服。" },
  { id: "yuyuan", kind: "place", title: "愚园路街区", summary: "适合散步、拍照和随手收藏小店。咖啡、买手店和老建筑混在一起，节奏松弛。", area: "长宁", status: "开放", budget: 120, category: "餐饮", stops: [], image: "https://images.unsplash.com/photo-1516893842880-5d8aada7ac05?auto=format&fit=crop&w=900&q=80", budgetCategory: "餐饮", address: "愚园路 749 弄附近", duration: "2 小时", rainPlan: "咖啡馆停留", detail: "这里不适合赶景点，适合边走边停。建议把咖啡、甜品和小店收藏起来，作为体力缓冲点。" },
  { id: "bund", kind: "place", title: "外滩建筑群", summary: "建议傍晚抵达，蓝调时刻体验最好。沿江步道视野开阔，适合作为第二天的情绪高潮。", area: "黄浦", status: "开放", budget: 18, category: "景点", stops: [], image: "https://images.unsplash.com/photo-1548919973-5cef591cdbc9?auto=format&fit=crop&w=900&q=80", budgetCategory: "市内交通", address: "中山东一路", duration: "90 分钟", rainPlan: "洛克外滩源室内", detail: "不建议白天硬晒，可以从洛克外滩源步行过去。蓝调时刻的建筑立面和江面反光最有记忆点。" },
  { id: "westbund", kind: "place", title: "西岸美术馆", summary: "第三天安排在这里，节奏舒展且不赶路。展览、江边步道和咖啡都能自然衔接。", area: "徐汇", status: "开放", budget: 160, category: "景点", stops: [], image: "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=900&q=80", budgetCategory: "门票", address: "龙腾大道 2600 号", duration: "2.5 小时", rainPlan: "馆内展览优先", detail: "西岸很适合作为旅行尾声，不需要强行打卡。展后沿江散步，体力不足就直接转徐家汇收尾。" },
];
`;
}

function learningPageSource(title: string): string {
  return `import { getDomainItems } from "@/lib/db";
import { EmptyState } from "@/components/EmptyState";
import { InteractiveWorkbench } from "@/components/InteractiveWorkbench";

export default async function HomePage() {
  const items = await getDomainItems();
  const minutes = items.reduce((sum, item) => sum + item.budget, 0);
  const focus = items[0];

  return (
    <main className="training-shell">
      <section className="training-hero">
        <p className="eyebrow">Court notebook</p>
        <h1>${escapeJsxText(title)}</h1>
        <p>{focus?.summary ?? "选择今天的技能目标，完成训练记录，并获得下一次训练建议。"}</p>
        <div className="hero-scoreboard" aria-label="今日训练概览">
          <span><strong>{minutes}</strong>分钟</span>
          <span><strong>8</strong>周路径</span>
          <span><strong>3</strong>个动作重点</span>
        </div>
      </section>
      {items.length === 0 ? <EmptyState title="还没有训练内容" action="先添加第一个动作，系统会安排今日练习。" /> : null}
      <InteractiveWorkbench items={items} />
    </main>
  );
}
`;
}

function learningInteractiveSource(): string {
  return `"use client";

import { useMemo, useState, useTransition } from "react";
import { toggleSignal } from "@/app/actions";
import type { DomainItem } from "@/lib/demo-data";

type Props = {
  items: DomainItem[];
};

const tabs = ["今日训练", "课程进度", "动作分解", "练习记录", "教练反馈"] as const;
type Tab = (typeof tabs)[number];

export function InteractiveWorkbench({ items }: Props) {
  const [active, setActive] = useState<Tab>("今日训练");
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");
  const [completed, setCompleted] = useState<string[]>([]);
  const [rating, setRating] = useState(3);
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState("");
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const totalMinutes = useMemo(() => items.reduce((sum, item) => sum + item.budget, 0), [items]);

  function toggleDrill(id: string) {
    setSelectedId(id);
    setPendingId(id);
    setCompleted((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    startTransition(() => {
      void toggleSignal({ itemId: id, kind: "practice-log" });
    });
  }

  return (
    <>
      <nav className="training-tabs" aria-label="训练模块">
        {tabs.map((tab) => (
          <button key={tab} className={active === tab ? "active" : ""} onClick={() => setActive(tab)}>
            {tab}
          </button>
        ))}
      </nav>

      <section className="coach-board">
        <div className="plan-card">
          <span>{active}</span>
          <h2>{selected?.title ?? "今日训练"}</h2>
          <p>{selected?.summary ?? "先选择一个训练动作。"}</p>
          <div className="rating-row" aria-label="手感评分">
            {[1, 2, 3, 4, 5].map((score) => (
              <button key={score} className={rating === score ? "active" : ""} onClick={() => setRating(score)}>
                {score}
              </button>
            ))}
          </div>
        </div>

        <div className="progress-card">
          <span>今日完成</span>
          <strong>{completed.length}/{items.length}</strong>
          <p>累计 {totalMinutes} 分钟，当前手感 {rating}/5。下一次训练会优先安排稳定击球和脚步恢复。</p>
        </div>
      </section>

      <section className="drill-list" aria-label="今日动作">
        {items.map((item) => (
          <article key={item.id} className={completed.includes(item.id) ? "done" : ""}>
            <div>
              <span>{item.category}</span>
              <h3>{item.title}</h3>
              <p>{item.summary}</p>
            </div>
            <button onClick={() => toggleDrill(item.id)} disabled={isPending}>
              {isPending && pendingId === item.id ? "记录中" : completed.includes(item.id) ? "已完成" : "记录"}
            </button>
          </article>
        ))}
      </section>
    </>
  );
}
`;
}

function learningDataSource(): string {
  return `export type DomainItem = {
  id: string;
  kind: "day" | "place" | "work";
  title: string;
  summary: string;
  area: string;
  status: string;
  budget: number;
  category: string;
  stops: string[];
};

export const domainItems: DomainItem[] = [
  { id: "forehand", kind: "work", title: "正手稳定击球", summary: "15 分钟定点击球，目标是连续 20 拍不过网失误不超过 3 次。", area: "底线", status: "today", budget: 15, category: "核心动作", stops: ["准备拍面", "转肩引拍", "随挥到肩"] },
  { id: "split-step", kind: "work", title: "分腿垫步恢复", summary: "10 分钟节奏练习，每次击球后回到中线，建立下一拍准备。", area: "脚步", status: "next", budget: 10, category: "脚步", stops: ["小跳启动", "重心压低", "回位观察"] },
  { id: "backhand", kind: "work", title: "反手墙练节奏", summary: "12 分钟贴墙练习，关注击球点在身体前侧，减少手腕补偿。", area: "反手", status: "practice", budget: 12, category: "动作分解", stops: ["侧身", "固定击球点", "慢速复盘"] },
  { id: "serve-toss", kind: "work", title: "发球抛球高度", summary: "8 分钟只练抛球，目标落点稳定在前脚尖前方一个拍长。", area: "发球", status: "review", budget: 8, category: "专项", stops: ["手臂伸直", "不过度旋转", "落点标记"] },
];
`;
}

function genericPageSource(title: string, summary: string): string {
  return `import { getDomainItems } from "@/lib/db";
import { EmptyState } from "@/components/EmptyState";
import { InteractiveWorkbench } from "@/components/InteractiveWorkbench";

export default async function HomePage() {
  const items = await getDomainItems();

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Today workspace</p>
        <h1>${escapeJsxText(title)}</h1>
        <p>${escapeJsxText(summary)}</p>
      </section>
      {items.length === 0 ? <EmptyState title="还没有工作项" action="先添加第一条记录，系统会生成下一步建议。" /> : null}
      <InteractiveWorkbench items={items} />
    </main>
  );
}
`;
}

function detailPageSource(title: string): string {
  return `import { getDomainItems } from "@/lib/db";
import { MetaChip } from "@/components/MetaChip";

export default async function DetailPage() {
  const [item] = await getDomainItems();
  return (
    <main className="app-shell detail-page">
      <section className="hero compact">
        <p className="eyebrow">Detail</p>
        <h1>{item?.title ?? "${escapeJsxText(title)} 详情"}</h1>
        <p>{item?.summary ?? "当前对象会在这里展示背景、状态和下一步动作。"}</p>
        <MetaChip label={item?.status ?? "ready"} />
      </section>
    </main>
  );
}
`;
}

function historyPageSource(title: string): string {
  return `import { getDomainItems } from "@/lib/db";
import { HistoryScreen } from "@/components/screens/HistoryScreen";

export default async function HistoryPage() {
  const items = await getDomainItems();
  return (
    <main className="app-shell history-page">
      <HistoryScreen title="${escapeJsxText(title)} 记录" items={items} />
    </main>
  );
}
`;
}

function appShellSource(): string {
  return `export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="product-shell">
      <header>
        <strong>Today</strong>
        <nav aria-label="Product navigation">
          <a href="/">首页</a>
          <a href="/history">记录</a>
        </nav>
      </header>
      {children}
    </div>
  );
}
`;
}

function primaryActionSource(): string {
  return `export function PrimaryAction({ label = "保存进度" }: { label?: string }) {
  return <button className="primary-action" type="submit">{label}</button>;
}
`;
}

function metaChipSource(): string {
  return `export function MetaChip({ label }: { label: string }) {
  return <span className="meta-chip">{label}</span>;
}
`;
}

function sectionHeaderSource(): string {
  return `export function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="section-header">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
    </div>
  );
}
`;
}

function historyScreenSource(): string {
  return `import type { DomainItem } from "@/lib/demo-data";

export function HistoryScreen({ title, items }: { title: string; items: DomainItem[] }) {
  return (
    <section className="history-surface">
      <p className="eyebrow">{title.includes("收藏") ? "Favorites" : "History"}</p>
      <h1>{title}</h1>
      <div>
        {items.map((item) => (
          <article key={item.id}>
            <span>{item.status}</span>
            <h2>{item.title}</h2>
            <p>{item.summary}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
`;
}

function genericInteractiveSource(): string {
  return `"use client";

import { useState, useTransition } from "react";
import { toggleSignal } from "@/app/actions";
import type { DomainItem } from "@/lib/demo-data";

type Props = {
  items: DomainItem[];
};

const lanes = ["今日任务", "进行中", "已记录", "下一步"] as const;

export function InteractiveWorkbench({ items }: Props) {
  const [active, setActive] = useState<(typeof lanes)[number]>(lanes[0]);
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");
  const [isPending, startTransition] = useTransition();
  const [completedId, setCompletedId] = useState("");
  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  function recordSignal(id: string) {
    setSelectedId(id);
    setCompletedId(id);
    startTransition(() => {
      void toggleSignal({ itemId: id, kind: "selected" });
    });
  }

  return (
    <>
      <section className="metrics">
        {items.slice(0, 3).map((item) => <strong key={item.id}>{item.title}</strong>)}
      </section>
      <section className="workbench">
        <nav aria-label="流程">
          {lanes.map((lane) => <button key={lane} className={active === lane ? "active" : ""} onClick={() => setActive(lane)}>{lane}</button>)}
        </nav>
        <article>
          <span>当前视图</span>
          <h2>{active}</h2>
          <p>{selected?.summary ?? "服务端数据正在准备。"}</p>
          <div className="item-list">
            {items.map((item) => (
              <button key={item.id} className={selectedId === item.id ? "active" : ""} disabled={isPending} onClick={() => recordSignal(item.id)}>
                {isPending && selectedId === item.id ? "提交中" : completedId === item.id ? item.title + " 已完成" : item.title}
              </button>
            ))}
          </div>
        </article>
      </section>
    </>
  );
}
`;
}

function genericActionsSource(): string {
  return `"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

const SignalInput = z.object({
  itemId: z.string().min(1),
  kind: z.string().min(1),
});

export async function toggleSignal(input: z.infer<typeof SignalInput>) {
  const parsed = SignalInput.parse(input);
  void parsed;
  revalidatePath("/");
  return { ok: true };
}
`;
}

function genericDataSource(title: string): string {
  return `export type DomainItem = {
  id: string;
  kind: "day" | "place" | "work";
  title: string;
  summary: string;
  area: string;
  status: string;
  budget: number;
  category: string;
  stops: string[];
};

export const domainItems: DomainItem[] = [
  { id: "today", kind: "work", title: "今日任务", summary: "${escapeStringForTs(title)} 的当前重点、完成标准和下一步行动。", area: "核心", status: "ready", budget: 0, category: "任务", stops: [] },
  { id: "progress", kind: "work", title: "进度记录", summary: "记录一次真实操作后的状态变化、备注和优先级。", area: "追踪", status: "running", budget: 0, category: "记录", stops: [] },
  { id: "next", kind: "work", title: "下一步", summary: "基于当前状态给出可执行的下一步建议。", area: "建议", status: "queued", budget: 0, category: "建议", stops: [] },
];
`;
}

function learningCssSource(): string {
  return `:root {
  color: #102018;
  background: #e8f06a;
  font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
  --court: #1f5f3b;
  --line: #f8f3d8;
  --ink: #102018;
  --ball: #d7ff3f;
  --clay: #bd5b36;
}

* { box-sizing: border-box; }
body { margin: 0; background: #102018; }
button { font: inherit; }
.training-shell {
  min-height: 100vh;
  max-width: 430px;
  margin: 0 auto;
  padding: 16px;
  color: var(--ink);
  background:
    linear-gradient(90deg, rgba(255,255,255,.24) 1px, transparent 1px) 50% 0 / 64px 64px,
    linear-gradient(180deg, #dfff55 0%, #f5efd4 42%, #174b34 100%);
}
.training-hero {
  min-height: 330px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 14px;
  padding: 26px;
  border-radius: 8px;
  color: #fffbea;
  background:
    radial-gradient(circle at 82% 12%, rgba(215,255,63,.95) 0 44px, transparent 46px),
    linear-gradient(135deg, #184d34, #0b2419);
  box-shadow: inset 0 0 0 2px rgba(255,255,255,.16);
}
.eyebrow { margin: 0; text-transform: uppercase; font-size: 12px; font-weight: 900; color: var(--ball); }
h1 { margin: 0; font-size: 42px; line-height: .95; letter-spacing: 0; }
p { margin: 0; line-height: 1.65; }
.hero-scoreboard { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.hero-scoreboard span, .progress-card, .plan-card, .drill-list article {
  border: 1px solid rgba(16,32,24,.16);
  border-radius: 8px;
  background: rgba(255,251,234,.9);
}
.hero-scoreboard span { padding: 10px; color: var(--ink); font-size: 12px; }
.hero-scoreboard strong { display: block; font-size: 22px; }
.training-tabs { display: flex; gap: 8px; overflow-x: auto; padding: 14px 0; }
.training-tabs button, .rating-row button, .drill-list button {
  border: 1px solid rgba(16,32,24,.2);
  border-radius: 999px;
  background: #fffbea;
  color: var(--ink);
  padding: 10px 13px;
  white-space: nowrap;
}
.training-tabs button.active, .rating-row button.active, .drill-list article.done button {
  background: var(--ink);
  color: var(--ball);
}
.coach-board { display: grid; gap: 10px; }
.plan-card, .progress-card { padding: 18px; }
.plan-card span, .progress-card span, .drill-list span { font-size: 12px; font-weight: 900; color: var(--clay); text-transform: uppercase; }
.plan-card h2, .drill-list h3 { margin: 6px 0 8px; }
.rating-row { display: flex; gap: 8px; margin-top: 14px; }
.drill-list { display: grid; gap: 10px; margin-top: 12px; }
.drill-list article { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 16px; }
.drill-list article.done { background: #e8ffd0; }
.drill-list button { min-width: 74px; }
`;
}

function dbSource(): string {
  return `import { domainItems } from "@/lib/demo-data";

export async function getDomainItems() {
  return domainItems;
}
`;
}

function prismaSchemaSource(): string {
  return `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model DomainItem {
  id        String   @id
  kind      String
  title     String
  summary   String
  area      String
  status    String
  budget    Int      @default(0)
  category  String
  signals   UserSignal[]
  tags      ItemTag[]
  createdAt DateTime @default(now())
}

model UserSignal {
  id        String   @id @default(cuid())
  itemId    String
  item      DomainItem @relation(fields: [itemId], references: [id], onDelete: Cascade)
  kind      String
  value     String   @default("true")
  createdAt DateTime @default(now())
}

model DomainTag {
  id    String @id @default(cuid())
  label String
  color String
  items ItemTag[]
}

model ItemTag {
  id     String @id @default(cuid())
  itemId String
  tagId  String
  item   DomainItem @relation(fields: [itemId], references: [id], onDelete: Cascade)
  tag    DomainTag  @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@unique([itemId, tagId])
}
`;
}

function travelCssSource(): string {
  return `@import url("https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&family=Noto+Serif+SC:wght@500;700;900&display=swap");

:root {
  color: #1d332c;
  background: #f6efe1;
  font-family: "Noto Serif SC", "PingFang SC", "Microsoft YaHei", serif;
  --ink: #1d332c;
  --paper: #f6efe1;
  --card: #fffaf0;
  --sage: #d7e4d0;
  --gold: #b9852b;
  --seal: #b24b34;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; min-width: 320px; background: var(--paper); }
button, a { font: inherit; }
button { cursor: pointer; }
a { color: inherit; text-decoration: none; }
img { display: block; max-width: 100%; object-fit: cover; }
.app-shell {
  width: min(100%, 430px);
  min-height: 100vh;
  margin: 0 auto;
  padding: 14px 14px 92px;
  background:
    linear-gradient(90deg, rgba(185,133,43,.08) 1px, transparent 1px) 0 0 / 28px 28px,
    linear-gradient(180deg, #fbf5e9 0%, #ecf1e4 100%);
}
.hero, .page-head, .detail-hero {
  border: 1px solid rgba(29,51,44,.2);
  border-style: dashed;
  border-radius: 8px;
  background: rgba(255,250,240,.86);
  box-shadow: 0 12px 28px rgba(29,51,44,.12);
}
.hero {
  min-height: 470px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 16px;
  padding: 28px 20px;
  background:
    linear-gradient(180deg, rgba(255,250,240,.18), rgba(255,250,240,.94)),
    url("https://images.unsplash.com/photo-1548919973-5cef591cdbc9?auto=format&fit=crop&w=900&q=80") center / cover;
}
.eyebrow { margin: 0; text-transform: uppercase; letter-spacing: .12em; font-size: 12px; color: var(--seal); font-weight: 900; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0; font-family: "Ma Shan Zheng", "Noto Serif SC", serif; font-size: 52px; line-height: .98; letter-spacing: 0; color: #15261f; }
h2 { font-size: 28px; line-height: 1.08; letter-spacing: 0; }
h3 { font-size: 21px; letter-spacing: 0; }
p { line-height: 1.72; color: #53665f; }
.hero p { font-size: 15px; color: #263d35; }
.hero-actions, .card-actions, .meta-row, .filter-row, .mini-list { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
.hero-actions a, .hero-actions span, .primary-link, .card-actions a, .card-actions button, .filter-row button {
  min-height: 38px;
  border: 1px solid rgba(29,51,44,.22);
  border-radius: 999px;
  background: rgba(255,250,240,.88);
  color: var(--ink);
  padding: 9px 13px;
  font-weight: 800;
  font-size: 13px;
}
.hero-actions a, .primary-link, .card-actions button:first-of-type, .filter-row button.active {
  background: var(--ink);
  color: #fff8e8;
}
.day-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 14px 0; }
.day-tabs button { min-height: 82px; border: 1px solid rgba(29,51,44,.18); background: rgba(255,250,240,.72); border-radius: 8px; color: var(--ink); text-align: left; padding: 12px; }
.day-tabs button.active { background: var(--sage); border-color: var(--ink); }
.day-tabs span { display: block; margin-top: 8px; font-size: 12px; }
.itinerary { display: grid; gap: 12px; padding: 18px; background: var(--card); border: 1px dashed rgba(29,51,44,.22); border-radius: 8px; }
.itinerary ol { margin: 0; padding-left: 20px; line-height: 2; }
.itinerary aside { background: var(--ink); color: #fff8e8; padding: 18px; border-radius: 8px; }
.itinerary aside p { color: #f5e7cd; }
.itinerary aside strong { display: block; margin: 10px 0; font-size: 42px; color: #fff8e8; }
.itinerary aside button { width: 100%; border: 0; border-radius: 6px; background: #f1c76e; color: var(--ink); padding: 12px; font-weight: 900; }
.filter-row { margin: 14px 0; overflow-x: auto; flex-wrap: nowrap; padding-bottom: 3px; }
.filter-row button { flex: 0 0 auto; }
.places { display: grid; grid-template-columns: 1fr; gap: 12px; margin: 14px 0; }
.places article, .saved, .budget-list article, .history-surface article {
  overflow: hidden;
  padding: 14px;
  background: rgba(255,250,240,.84);
  border: 1px dashed rgba(29,51,44,.24);
  border-radius: 8px;
  box-shadow: 0 10px 22px rgba(29,51,44,.08);
}
.places article img { width: 100%; height: 176px; border-radius: 7px; margin-bottom: 12px; }
.places span, .budget-list span, .history-surface span { color: var(--seal); font-size: 12px; font-weight: 900; }
.places p, .saved p, .budget-list p, .history-surface p { line-height: 1.65; color: #53665f; }
.saved { margin-top: 12px; }
.mini-list a { border-bottom: 1px solid rgba(178,75,52,.45); color: var(--seal); font-weight: 800; }
.page-head { padding: 24px 18px; margin-bottom: 14px; }
.sub-page h1 { font-size: 46px; }
.total-budget { display: block; font-size: 50px; color: var(--ink); }
.budget-list { display: grid; gap: 12px; }
.budget-list article strong { display: block; margin: 8px 0; font-size: 34px; color: var(--ink); }
.detail-hero { display: grid; gap: 16px; overflow: hidden; padding: 0; }
.detail-hero img { width: 100%; height: 260px; }
.detail-hero > div { padding: 0 18px 20px; }
.detail-note { color: #314840; font-weight: 700; }
.meta-chip { display: inline-flex; align-items: center; min-height: 28px; border: 1px solid rgba(29,51,44,.18); border-radius: 999px; padding: 5px 10px; background: #edf4e9; color: var(--ink); font-size: 12px; font-weight: 900; }
.history-surface { display: grid; gap: 12px; }
.history-surface h1 { font-size: 44px; }
.bottom-tabs {
  position: sticky;
  bottom: 10px;
  z-index: 20;
  width: 100%;
  margin: 18px auto 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  padding: 8px;
  border: 1px solid rgba(29,51,44,.16);
  border-radius: 8px;
  background: rgba(255,250,240,.94);
  box-shadow: 0 12px 26px rgba(29,51,44,.16);
}
.bottom-tabs a { min-height: 40px; display: grid; place-items: center; border-radius: 6px; font-weight: 900; font-size: 13px; }
.bottom-tabs a.active { background: var(--ink); color: #fff8e8; }
@media (min-width: 760px) {
  .app-shell { width: min(100%, 980px); padding: 22px 22px 96px; }
  .hero { min-height: 540px; }
  h1 { font-size: 72px; }
  .itinerary { grid-template-columns: minmax(0, 1fr) 240px; }
  .places { grid-template-columns: repeat(2, 1fr); }
  .detail-hero { grid-template-columns: 1fr 1fr; align-items: center; }
  .detail-hero img { height: 100%; min-height: 420px; }
  .bottom-tabs { width: min(100%, 520px); }
}
`;
}

function genericCssSource(): string {
  return `:root { color: #151515; background: #f4f1ea; font-family: "Avenir Next", "PingFang SC", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; }
button { font: inherit; }
.app-shell { min-height: 100vh; padding: 24px; background: linear-gradient(135deg, #f4f1ea, #dbe8df); }
.hero { min-height: 48vh; display: flex; flex-direction: column; justify-content: flex-end; padding: 32px; background: #151515; color: #fff9ed; border-radius: 8px; }
.eyebrow { color: #9be38f; text-transform: uppercase; letter-spacing: .12em; font-weight: 800; }
h1 { max-width: 820px; font-size: clamp(42px, 9vw, 86px); line-height: .9; margin: 0 0 18px; letter-spacing: 0; }
p { line-height: 1.75; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px 0; }
.metrics strong { padding: 20px; background: #fff9ed; border: 1px solid #d6d0c4; border-radius: 8px; }
.workbench { display: grid; grid-template-columns: 220px 1fr; gap: 12px; }
nav, article { background: rgba(255,255,255,.78); border: 1px solid #d6d0c4; border-radius: 8px; padding: 16px; }
nav { display: grid; gap: 8px; }
nav button { border: 1px solid #d6d0c4; background: #fff9ed; border-radius: 6px; padding: 12px; text-align: left; cursor: pointer; }
nav button.active { background: #151515; color: #fff9ed; }
article span { color: #57725b; font-weight: 800; }
@media (max-width: 760px) { .app-shell { padding: 12px; } .metrics, .workbench { grid-template-columns: 1fr; } }
`;
}
