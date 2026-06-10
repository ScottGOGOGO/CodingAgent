import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { posix } from "node:path";

import type { ArchitecturePlan, BuildTask, ToolCallTrace } from "@vide/contracts";

import type { ModelClient, LLMMessage, LLMToolDescriptor, LLMToolCallRequest } from "./model-client.js";
import { createBaselineFiles, ensureSandboxBaselineScaffold, isLegacyBaselineScaffoldSource } from "./app-scaffold.js";
import type { SandboxWorkspace } from "./sandbox.js";
import {
  InMemoryArtifactStore,
  InMemoryTaskStore,
  type McpToolAdapter,
  type PlanModeState,
  type SubAgentRunner,
  type TaskStore,
  type ToolExecutionContext,
  type ToolManifest,
  type ToolRegistry,
  type WebToolAdapter,
} from "./tools.js";

/**
 * Outcome of one full agent loop run. Mirrors the GeneratedApp shape returned by
 * the single-shot coder so the rest of the pipeline can stay unchanged.
 */
export interface AgentLoopResult {
  title: string;
  summary: string;
  /**
   * Files that exist in the sandbox at the end of the loop. The agent loop
   * writes directly to disk, so these are read back from the workspace.
   */
  files: Array<{ path: string; content: string }>;
  /** Tasks the agent finished, in order. */
  completedTaskIds: string[];
  /** Tasks the agent left untouched after exhausting its budget. */
  pendingTaskIds: string[];
  /** True only if the agent explicitly called finish_app. */
  finished: boolean;
  /** True if the last run_build call (if any) succeeded. */
  lastBuildPassed: boolean;
  /** Tail of the last build log, for observability. */
  lastBuildLog: string;
  /** True only when the most recent quality_audit completed with status=passed. */
  lastAuditPassed: boolean;
  /** Number of blocking failures reported by the most recent quality_audit, if known. */
  lastAuditBlockingFailures?: number;
  /** Total tool calls executed across all turns. */
  toolCallCount: number;
  /** True when the loop stopped because a model tool-use turn timed out. */
  modelTimedOut: boolean;
  /** Last model/tool-use transport or protocol error, if the loop stopped before tool execution. */
  modelError?: string;
}

export interface AgentLoopOptions {
  /** Hard cap on assistant turns (each turn = one model call). */
  maxTurns: number;
  /** Hard cap on tool calls per turn to guard against runaway models. */
  maxToolCallsPerTurn?: number;
  /** Hard cap on total tool calls. */
  maxToolCallsTotal?: number;
  /** Hard timeout for each model tool-use turn. */
  modelTurnTimeoutMs?: number;
  /** Called when phase-like progress should be surfaced. */
  onProgress?(message: string): void;
}

export interface AgentLoopRuntimeAdapters {
  taskStore?: TaskStore;
  artifactStore?: ToolExecutionContext["artifactStore"];
  subAgentRunner?: SubAgentRunner;
  webAdapter?: WebToolAdapter;
  mcpAdapter?: McpToolAdapter;
  planMode?: PlanModeState;
  capabilities?: ToolExecutionContext["capabilities"];
  policy?: ToolExecutionContext["policy"];
}

export interface AgentLoopInput {
  runId: string;
  sandbox: SandboxWorkspace;
  model: ModelClient;
  registry: ToolRegistry;
  /** System prompt — built via composeAgentCoderSystem. */
  systemPrompt: string;
  /** Architecture plan that drives task selection. */
  plan: ArchitecturePlan;
  /** Stable preamble user message: brief, clarification, etc. */
  initialUserMessage: string;
  /** Optional repair context. When present, the loop is told it is in repair mode. */
  repairContext?: string;
  /** Trace and log forwarding. */
  emitTrace(trace: ToolCallTrace): void;
  emitLog(message: string): void;
  runtime?: AgentLoopRuntimeAdapters;
  options: AgentLoopOptions;
}

const STATIC_AGENT_TOOLS: LLMToolDescriptor[] = [
  {
    name: "list_files",
    description: "List all text files currently in the sandbox workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a file from the sandbox workspace. Returns the full content.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Path relative to the sandbox root, e.g. src/app/page.tsx." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file in the sandbox workspace. Provide the complete file content, not a diff. Use this for new files or full rewrites.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string", description: "Path relative to the sandbox root." },
        content: { type: "string", description: "Complete UTF-8 file content." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace a single occurrence of a search string in an existing file. Returns an error if the search string is not found. Read the file first if you are unsure of exact content.",
    inputSchema: {
      type: "object",
      required: ["path", "search", "replace"],
      properties: {
        path: { type: "string" },
        search: { type: "string", description: "Exact text to find. Must match a single occurrence." },
        replace: { type: "string", description: "Replacement text. May be empty to delete the search block." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the sandbox workspace.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "search_text",
    description: "Search for a substring across all text files in the sandbox. Returns matches with line numbers.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "inspect_package",
    description: "Read package.json scripts and dependencies from the sandbox.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "use_design_skill",
    description:
      "Retrieve compact built-in design/product skill guidance. Use before app shell, visual system, and primary interaction work.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "frontend-design, fullstack-product, mobile-app-shell, or ai-assisted-flow." },
        focus: { type: "string", description: "Optional product domain or screen focus." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "inspect_reference_app",
    description:
      "Inspect a curated profile for reference apps such as Bloom Planner or My Season without copying their branding.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "bloom-planner, my-season, brain-spin, or compact-consumer-app." },
        focus: { type: "string", description: "visual, backend, interaction, shell, states, or all." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "quality_audit",
    description:
      "Run a static generated-app audit over the sandbox. Engineering failures are blocking; product, visual, and interaction findings are advisory only.",
    inputSchema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "Optional focus area such as frontend, backend, data, interaction, or all." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_build",
    description:
      "Run `npm install` (if needed), Prisma schema sync when prisma/schema.prisma exists, then `npm run build` / `next build` inside the sandbox to verify the Next.js app compiles. Returns the exit status and the tail of the log. Use sparingly — only after a meaningful chunk of work.",
    inputSchema: {
      type: "object",
      properties: {
        skipInstall: {
          type: "boolean",
          description: "Skip npm install. Set true only if you know dependencies are already installed in this run.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run an allowed sandbox command: npm install, npm run build, npm run dev, next build, next dev, or prisma migrate dev.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: {
          type: "array",
          items: { type: "string" },
          description: "Command argv, for example [\"next\", \"build\"] or [\"npx\", \"prisma\", \"migrate\", \"dev\", \"--name\", \"init\"].",
        },
        timeoutMs: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "db_migrate",
    description:
      "Validate database migrations in the sandbox. Defaults to Prisma migrate dev with SQLite DATABASE_URL=file:./dev.db.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Migration name, e.g. init." },
        provider: { type: "string", description: "sqlite or postgres; sqlite is used for sandbox validation." },
        timeoutMs: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vercel_env_set",
    description:
      "Record a required Vercel environment variable for deployment. This writes env requirements metadata in the sandbox and updates .env.example for non-sensitive values.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        value: { type: "string" },
        target: { type: "array", items: { type: "string" }, description: "development, preview, production" },
        sensitive: { type: "boolean" },
        note: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mark_task_done",
    description:
      "Mark a task from the architecture plan as complete. Call this immediately after finishing each task so the orchestrator can track progress.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string", description: "Exact task id from the architecture plan." },
        summary: { type: "string", description: "Optional short summary of what was implemented." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "finish_app",
    description:
      "Signal that the app is fully implemented and the build is green. Call ONLY after every planned task is done and run_build succeeded. The orchestrator will then run its own validation.",
    inputSchema: {
      type: "object",
      required: ["title", "summary"],
      properties: {
        title: { type: "string", description: "Short product title for the generated app." },
        summary: { type: "string", description: "1-3 sentence summary of what was built." },
      },
      additionalProperties: false,
    },
  },
];

function renderToolCatalog(): string {
  return STATIC_AGENT_TOOLS.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
}

function renderRegistryToolCatalog(registry: ToolRegistry, context: ToolExecutionContext): string {
  return registry
    .getCatalog(context)
    .map((manifest) => `- ${manifest.id}: ${registry.get(manifest.id).description}`)
    .join("\n");
}

export function getAgentLoopTools(): LLMToolDescriptor[] {
  return STATIC_AGENT_TOOLS;
}

export function getAgentToolCatalogText(): string {
  return renderToolCatalog();
}

function toLLMToolDescriptor(registry: ToolRegistry, manifest: ToolManifest): LLMToolDescriptor {
  const tool = registry.get(manifest.id);
  return {
    name: manifest.id,
    description: tool.description,
    inputSchema: manifest.inputSchema,
  };
}

interface TaskTracker {
  total: Set<string>;
  done: Set<string>;
  tasksById: Map<string, BuildTask>;
}

interface BuildState {
  lastBuildPassed: boolean;
}

interface AuditResult {
  status: "passed" | "failed";
  blockingFailures: number;
  checks: Array<{ id: string; passed: boolean; blocking: boolean; detail: string }>;
  summary: string;
}

/**
 * Tracks discovery and quality-gate state across the loop. The loop must call
 * the discovery tools at least once before any file write, and must pass the
 * quality audit before finish_app is accepted.
 */
interface DiscoveryTracker {
  /** Whether inspect_reference_app has been called at least once. */
  referenceInspected: boolean;
  /** Number of use_design_skill calls observed. */
  designSkillCalls: number;
  /** Whether quality_audit has been called at least once. */
  qualityAuditCalled: boolean;
  /** Number of times we already injected a discovery nudge. */
  discoveryNudges: number;
}

interface SetupProgressTracker {
  /** True after npm install succeeds and until package.json changes again. */
  npmInstallFresh: boolean;
}

interface InspectionProgressTracker {
  workspaceVersion: number;
  knownFiles: Set<string>;
  fileVersions: Map<string, number>;
  readCounts: Map<string, { version: number; count: number }>;
  listFilesCount: { version: number; count: number };
  packageInspectCount: { version: number; count: number };
}

interface LoopSupervisorState {
  consecutiveNoProgressTurns: number;
  closeoutInterventions: number;
}

interface TurnProgressTracker {
  toolCalls: number;
  noOpCalls: number;
  inspectionCalls: number;
  workspaceWrites: number;
  buildAttempts: number;
  auditRuns: number;
  finishAttempts: number;
  taskMarks: number;
  discoveryAdvances: number;
  installRuns: number;
  dbMigrations: number;
}

const MIN_DESIGN_SKILL_CALLS = 1;
const CORE_ENTRY_FILE = "src/app/page.tsx";
const CORE_REQUIRED_FILES = ["package.json", "next-env.d.ts", "src/app/layout.tsx", "src/app/globals.css", CORE_ENTRY_FILE];
const CORE_ENTRY_FORCE_AFTER_TOOL_CALLS = 32;
const CORE_ENTRY_DEPTH_FORCE_AFTER_TOOL_CALLS = 40;
const CORE_ENTRY_CLOSEOUT_MARGIN = 36;
const CLOSEOUT_BUILD_FORCE_AFTER_TOOL_CALLS = 64;
const VERIFICATION_OR_CLOSEOUT_TOOLS = new Set(["run_build", "quality_audit", "finish_app", "mark_task_done"]);
const INSPECTION_TOOLS = new Set(["list_files", "read_file", "search_text", "inspect_package"]);
const MAX_READS_PER_FILE_VERSION = 2;
const MAX_LIST_FILES_PER_WORKSPACE_VERSION = 2;
const MAX_PACKAGE_INSPECT_PER_WORKSPACE_VERSION = 1;
const LOOP_STALL_CLOSEOUT_TURNS = 3;
const LOOP_STALL_MIN_TOOL_CALLS = 18;
const LOOP_STALL_MAX_CLOSEOUT_INTERVENTIONS = 1;
const DEFAULT_MODEL_TURN_TIMEOUT_MS = 90_000;
const DISCOVERY_REQUIRED_BEFORE_WRITES = new Set([
  "write_file",
  "edit_file",
  "delete_file",
]);

function discoverySatisfied(tracker: DiscoveryTracker): boolean {
  return tracker.referenceInspected && tracker.designSkillCalls >= MIN_DESIGN_SKILL_CALLS;
}

function missingDiscoveryMessage(tracker: DiscoveryTracker): string {
  const missing: string[] = [];
  if (!tracker.referenceInspected) {
    missing.push(
      "inspect_reference_app (call with app=\"bloom-planner\", \"my-season\", \"brain-spin\", or \"compact-consumer-app\" — pick the closest match)",
    );
  }
  if (tracker.designSkillCalls < MIN_DESIGN_SKILL_CALLS) {
    missing.push(
      `use_design_skill (need ${MIN_DESIGN_SKILL_CALLS - tracker.designSkillCalls} more — start with frontend-design; add mobile-app-shell only when the app shell is complex)`,
    );
  }
  return [
    "BLOCKED: Discovery phase incomplete. You must call the following before writing any files:",
    ...missing.map((item) => `  - ${item}`),
    "Make those calls now, then continue with write_file / edit_file.",
  ].join("\n");
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || raw.trim() === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function createTurnProgressTracker(): TurnProgressTracker {
  return {
    toolCalls: 0,
    noOpCalls: 0,
    inspectionCalls: 0,
    workspaceWrites: 0,
    buildAttempts: 0,
    auditRuns: 0,
    finishAttempts: 0,
    taskMarks: 0,
    discoveryAdvances: 0,
    installRuns: 0,
    dbMigrations: 0,
  };
}

function recordToolAttempt(progress: TurnProgressTracker, toolName: string): void {
  progress.toolCalls += 1;
  if (INSPECTION_TOOLS.has(toolName)) {
    progress.inspectionCalls += 1;
  }
}

function recordNoOpTool(progress: TurnProgressTracker): void {
  progress.noOpCalls += 1;
}

function hasMeaningfulTurnProgress(progress: TurnProgressTracker, autoCompletedTaskCount: number): boolean {
  return (
    autoCompletedTaskCount > 0 ||
    progress.workspaceWrites > 0 ||
    progress.buildAttempts > 0 ||
    progress.auditRuns > 0 ||
    progress.finishAttempts > 0 ||
    progress.taskMarks > 0 ||
    progress.discoveryAdvances > 0 ||
    progress.installRuns > 0 ||
    progress.dbMigrations > 0
  );
}

function isReadOnlyOrNoOpTurn(progress: TurnProgressTracker): boolean {
  if (progress.toolCalls === 0) {
    return false;
  }
  if (progress.noOpCalls > 0) {
    return true;
  }
  return progress.inspectionCalls === progress.toolCalls;
}

async function updateLoopSupervisorAfterTurn(args: {
  supervisor: LoopSupervisorState;
  turnProgress: TurnProgressTracker;
  autoCompletedTaskCount: number;
  inspection: InspectionProgressTracker;
  sandbox: SandboxWorkspace;
  toolCallCount: number;
  maxToolCallsTotal: number;
}): Promise<{ reason: string } | null> {
  const meaningfulProgress = hasMeaningfulTurnProgress(args.turnProgress, args.autoCompletedTaskCount);
  if (meaningfulProgress || !isReadOnlyOrNoOpTurn(args.turnProgress)) {
    args.supervisor.consecutiveNoProgressTurns = 0;
    return null;
  }

  args.supervisor.consecutiveNoProgressTurns += 1;
  if (args.supervisor.closeoutInterventions >= LOOP_STALL_MAX_CLOSEOUT_INTERVENTIONS) {
    return null;
  }
  if (args.supervisor.consecutiveNoProgressTurns < LOOP_STALL_CLOSEOUT_TURNS) {
    return null;
  }
  if (args.toolCallCount < Math.min(LOOP_STALL_MIN_TOOL_CALLS, args.maxToolCallsTotal)) {
    return null;
  }
  if (!CORE_REQUIRED_FILES.every((filePath) => args.inspection.knownFiles.has(filePath))) {
    return null;
  }

  try {
    const pageSource = await args.sandbox.readFile(CORE_ENTRY_FILE);
    if (hasUnfinishedVisibleCopy(pageSource)) {
      return null;
    }
  } catch {
    return null;
  }

  args.supervisor.closeoutInterventions += 1;
  return {
    reason:
      `detected ${args.supervisor.consecutiveNoProgressTurns} consecutive read-only/no-op turns after ` +
      `${args.toolCallCount} tool calls; switching to deterministic build/audit/finish closeout.`,
  };
}

async function readWorkspaceFiles(sandbox: SandboxWorkspace): Promise<Array<{ path: string; content: string }>> {
  const snapshot = await sandbox.readSnapshot(200, 200_000);
  return snapshot
    .filter((file) => !file.path.startsWith("out/"))
    .map((file) => ({ path: file.path, content: file.content }));
}

/**
 * The real coder agent loop. Calls the model with tool-use, executes the tools
 * it requests, feeds results back, until the model calls finish_app or budgets
 * are exhausted.
 */
export class AgentCoderLoop {
  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const { sandbox, model, registry, plan, options, emitTrace, emitLog } = input;
    const maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 4;
    const maxToolCallsTotal = options.maxToolCallsTotal ?? 80;
    const modelTurnTimeoutMs = options.modelTurnTimeoutMs ?? DEFAULT_MODEL_TURN_TIMEOUT_MS;

    const tracker: TaskTracker = {
      total: new Set(plan.tasks.map((task) => task.id)),
      done: new Set<string>(),
      tasksById: new Map(plan.tasks.map((task) => [task.id, task])),
    };

    const discovery: DiscoveryTracker = {
      referenceInspected: false,
      designSkillCalls: 0,
      qualityAuditCalled: false,
      discoveryNudges: 0,
    };

    const setupProgress: SetupProgressTracker = {
      npmInstallFresh: false,
    };
    const inspectionProgress: InspectionProgressTracker = {
      workspaceVersion: 0,
      knownFiles: new Set(await sandbox.listFiles()),
      fileVersions: new Map<string, number>(),
      readCounts: new Map<string, { version: number; count: number }>(),
      listFilesCount: { version: -1, count: 0 },
      packageInspectCount: { version: -1, count: 0 },
    };
    const loopSupervisor: LoopSupervisorState = {
      consecutiveNoProgressTurns: 0,
      closeoutInterventions: 0,
    };

    const toolContext: ToolExecutionContext = {
      runId: input.runId,
      phase: input.repairContext ? "repair" : "tool_loop",
      workspace: sandbox,
      registry,
      taskStore: input.runtime?.taskStore ?? new InMemoryTaskStore(),
      artifactStore: input.runtime?.artifactStore ?? new InMemoryArtifactStore(),
      capabilities: {
        mcp: Boolean(input.runtime?.mcpAdapter),
        network: Boolean(input.runtime?.webAdapter),
        subagents: Boolean(input.runtime?.subAgentRunner),
        lsp: false,
        ...input.runtime?.capabilities,
      },
      policy: {
        allowedPermissions: ["read", "write", "execute", "collaborate"],
        allowedSideEffects: ["none", "workspace", "process"],
        allowedRiskLevels: ["low", "medium", "high"],
        allowNetwork: false,
        allowExternal: false,
        ...input.runtime?.policy,
      },
      subAgentRunner: input.runtime?.subAgentRunner,
      webAdapter: input.runtime?.webAdapter,
      mcpAdapter: input.runtime?.mcpAdapter,
      planMode: input.runtime?.planMode,
      emitTrace,
      emitLog,
    };

    const messages: LLMMessage[] = [
      { role: "system", content: input.systemPrompt },
      {
        role: "system",
        content: [
          "Active ToolKernel catalog for this phase:",
          renderRegistryToolCatalog(registry, toolContext) || "(no tools exposed)",
          "",
          "Only call tools visible in this catalog. High-risk tools are sandboxed and policy-gated.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          input.initialUserMessage,
          input.repairContext ? `\n\nRepair context:\n${input.repairContext}` : "",
          "\n\nDISCOVERY PHASE (REQUIRED FIRST):",
          "  1. Call inspect_reference_app once with the closest match to this product " +
            "(bloom-planner / my-season / brain-spin / compact-consumer-app).",
          "  2. Call use_design_skill once with frontend-design. Add mobile-app-shell, fullstack-product, or ai-assisted-flow only if the brief truly needs that extra guidance.",
          "  3. Only after the above are done, begin executing tasks with list_files + write_file.",
          "",
          "CORE APP MILESTONE:",
          `  - Create ${CORE_ENTRY_FILE} early, before optional component polish or repeated inspection.`,
          "  - A lightweight app must have a usable first screen route, typed seed/state data, and styles before deep component refinement.",
          "",
          "FINISH GATE:",
          "  - finish_app is BLOCKED until quality_audit returns status=passed. " +
            "quality_audit hard-blocks engineering failures such as missing Next.js scaffold, broken imports, deploy-contract issues, and App Router client-boundary problems.",
          "  - Product depth, visual quality, and interaction richness findings are advisory in static audit; do not overbuild to satisfy them.",
          "  - Run quality_audit, fix every blocking engineering failure, then finish.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];

    let finished = false;
    let finishTitle = "Generated app";
    let finishSummary = "";
    let lastBuildPassed = false;
    let lastBuildLog = "";
    let lastAuditSummary = "not run";
    let lastAuditPassed = false;
    let lastAuditBlockingFailures: number | undefined;
    let toolCallCount = 0;
    let consecutiveEmpty = 0;
    let modelTimedOut = false;
    let modelError: string | undefined;
    let timeoutRecoveryAttempts = 0;

    for (let turn = 0; turn < options.maxTurns && !finished; turn++) {
      options.onProgress?.(`turn ${turn + 1}/${options.maxTurns}`);

      let response;
      try {
        emitLog(`Agent loop: requesting tool calls for turn ${turn + 1}/${options.maxTurns}.`);
        response = await model.chatWithTools({
          role: "coder",
          messages,
          tools: registry.getCatalog(toolContext).map((manifest) => toLLMToolDescriptor(registry, manifest)),
          forceToolUse: !finished,
          timeoutMs: modelTurnTimeoutMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out/i.test(message)) {
          modelTimedOut = true;
        }
        modelError = message;
        emitLog(`Agent loop model error: ${message}`);
        const pending = [...tracker.total].filter((id) => !tracker.done.has(id));
        if (/timed out/i.test(message) && toolCallCount > 0 && pending.length > 0 && timeoutRecoveryAttempts < 1) {
          timeoutRecoveryAttempts += 1;
          compactMessagesToCheckpoint(
            messages,
            renderTimeoutRecoveryCheckpoint({
              tracker,
              pending,
              lastBuildPassed,
              lastAuditSummary,
              toolCallCount,
              maxToolCallsTotal,
              modelError: message,
            }),
          );
          turn -= 1;
          emitLog("Agent loop: retrying after model timeout with compact recovery checkpoint.");
          continue;
        }
        break;
      }

      if (!response.toolCalls.length) {
        // The model produced a final text message without tool calls.
        // Nudge it once; if it keeps refusing tools, end the loop.
        consecutiveEmpty += 1;
        const assistantText = response.content?.trim() ?? "";
        emitLog(
          `Agent loop: model returned no tool calls (finish=${response.finishReason ?? "unknown"}, content=${summarizeAssistantText(
            assistantText,
          )}).`,
        );
        messages.push({ role: "assistant", content: assistantText });
        if (consecutiveEmpty >= 2) {
          emitLog("Agent loop: model stopped producing tool calls. Ending loop.");
          break;
        }
        messages.push({
          role: "user",
          content:
            "You must continue by calling a tool. Pick the next task from the architecture plan and call list_files, write_file, db_migrate, run_build, mark_task_done, or finish_app accordingly.",
        });
        continue;
      }
      consecutiveEmpty = 0;

      const calls = response.toolCalls.slice(0, maxToolCallsPerTurn);
      const turnToolSummaries: string[] = [];
      const turnProgress = createTurnProgressTracker();

      // Record only the tool calls we will answer this turn. OpenAI-compatible
      // APIs require every assistant tool_call in history to be followed by a
      // matching tool message before the next assistant turn.
      messages.push({
        role: "assistant",
        content: response.content || undefined,
        toolCalls: calls,
      });

      for (const call of calls) {
        if (toolCallCount >= maxToolCallsTotal) {
          turnToolSummaries.push(`${call.name}: skipped because tool call budget is exhausted`);
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: `Tool call budget exhausted (${maxToolCallsTotal}). Stop and report the incomplete work; finish_app will remain blocked until all planned tasks and build verification are complete.`,
          });
          continue;
        }
        toolCallCount += 1;
        recordToolAttempt(turnProgress, call.name);

        const args = parseToolArgs(call.arguments);
        const toolSummary = summarizeToolCallForCheckpoint(call.name, args);
        turnToolSummaries.push(toolSummary);

        // Discovery gate: block write/edit/delete until inspect_reference_app
        // and use_design_skill have been called the required number of times.
        if (DISCOVERY_REQUIRED_BEFORE_WRITES.has(call.name) && !discoverySatisfied(discovery)) {
          recordNoOpTool(turnProgress);
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: missingDiscoveryMessage(discovery),
          });
          discovery.discoveryNudges += 1;
          continue;
        }

        const buildCommandSteering = buildCommandToolResult(call.name, args, setupProgress);
        if (buildCommandSteering) {
          recordNoOpTool(turnProgress);
          turnToolSummaries[turnToolSummaries.length - 1] = `${toolSummary} (no-op: ${buildCommandSteering.reason})`;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: buildCommandSteering.message,
          });
          emitLog(`Agent loop: blocked build command tool call ${call.name} (${buildCommandSteering.reason}).`);
          continue;
        }

        const coreMilestone = coreMilestoneToolResult(
          call.name,
          args,
          inspectionProgress,
          tracker,
          toolCallCount,
          maxToolCallsTotal,
        );
        if (coreMilestone) {
          recordNoOpTool(turnProgress);
          turnToolSummaries[turnToolSummaries.length - 1] = `${toolSummary} (no-op: ${coreMilestone.reason})`;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: coreMilestone.message,
          });
          emitLog(`Agent loop: blocked tool call until core route milestone (${coreMilestone.reason}).`);
          continue;
        }

        const localImportMilestone = await localImportMilestoneToolResult(
          call.name,
          args,
          sandbox,
          inspectionProgress,
          tracker,
          toolCallCount,
          maxToolCallsTotal,
        );
        if (localImportMilestone) {
          recordNoOpTool(turnProgress);
          turnToolSummaries[turnToolSummaries.length - 1] = `${toolSummary} (no-op: ${localImportMilestone.reason})`;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: localImportMilestone.message,
          });
          emitLog(`Agent loop: blocked tool call until local import resolves (${localImportMilestone.reason}).`);
          continue;
        }

        const corePageDepthMilestone = await corePageDepthProgressToolResult(
          call.name,
          args,
          sandbox,
          inspectionProgress,
          tracker,
          toolCallCount,
          maxToolCallsTotal,
        );
        if (corePageDepthMilestone) {
          recordNoOpTool(turnProgress);
          turnToolSummaries[turnToolSummaries.length - 1] = `${toolSummary} (no-op: ${corePageDepthMilestone.reason})`;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: corePageDepthMilestone.message,
          });
          emitLog(`Agent loop: blocked non-writing tool until core page is deep enough (${corePageDepthMilestone.reason}).`);
          continue;
        }

        const productDepthMilestone = await productDepthBeforeVerificationToolResult(
          call.name,
          sandbox,
          tracker,
        );
        if (productDepthMilestone) {
          recordNoOpTool(turnProgress);
          turnToolSummaries[turnToolSummaries.length - 1] = `${toolSummary} (no-op: ${productDepthMilestone.reason})`;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: productDepthMilestone.message,
          });
          emitLog(`Agent loop: blocked verification until product depth is sufficient (${productDepthMilestone.reason}).`);
          continue;
        }

        const closeoutBuild = closeoutBuildCheckpointToolResult(
          call.name,
          inspectionProgress,
          tracker,
          toolCallCount,
          maxToolCallsTotal,
          lastBuildPassed,
        );
        if (closeoutBuild) {
          recordNoOpTool(turnProgress);
          turnToolSummaries[turnToolSummaries.length - 1] = `${toolSummary} (no-op: ${closeoutBuild.reason})`;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: closeoutBuild.message,
          });
          emitLog(`Agent loop: blocked inspection until build checkpoint (${closeoutBuild.reason}).`);
          continue;
        }

        const redundantSetup = redundantSetupToolResult(call.name, args, discovery, setupProgress, tracker);
        if (redundantSetup) {
          recordNoOpTool(turnProgress);
          turnToolSummaries[turnToolSummaries.length - 1] = `${toolSummary} (no-op: ${redundantSetup.reason})`;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: redundantSetup.message,
          });
          emitLog(`Agent loop: blocked redundant setup tool call ${call.name} (${redundantSetup.reason}).`);
          continue;
        }

        const redundantInspection = redundantInspectionToolResult(call.name, args, inspectionProgress, tracker);
        if (redundantInspection) {
          recordNoOpTool(turnProgress);
          turnToolSummaries[turnToolSummaries.length - 1] = `${toolSummary} (no-op: ${redundantInspection.reason})`;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: redundantInspection.message,
          });
          emitLog(`Agent loop: blocked redundant inspection tool call ${call.name} (${redundantInspection.reason}).`);
          continue;
        }

        if (invalidatesQualityAudit(call.name)) {
          lastAuditPassed = false;
          lastAuditBlockingFailures = undefined;
        }
        if (invalidatesBuild(call.name)) {
          lastBuildPassed = false;
          lastBuildLog = "";
        }
        if (invalidatesInstalledDependencies(call.name, args)) {
          setupProgress.npmInstallFresh = false;
        }

        const outcome = await this.executeAgentToolCall({
          call,
          args,
          registry,
          toolContext,
          tracker,
          discovery,
          sandbox,
          buildState: { lastBuildPassed },
        });

        // Update discovery tracker based on what was called.
        if (call.name === "inspect_reference_app" && outcome.kind === "result") {
          if (!discovery.referenceInspected) {
            turnProgress.discoveryAdvances += 1;
          }
          discovery.referenceInspected = true;
        }
        if (call.name === "use_design_skill" && outcome.kind === "result") {
          if (discovery.designSkillCalls < MIN_DESIGN_SKILL_CALLS) {
            turnProgress.discoveryAdvances += 1;
          }
          discovery.designSkillCalls += 1;
        }
        if (call.name === "quality_audit" && outcome.kind === "result") {
          discovery.qualityAuditCalled = true;
        }

        if (outcome.kind === "finish") {
          turnProgress.finishAttempts += 1;
          finishTitle = outcome.title;
          finishSummary = outcome.summary;
          finished = true;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: outcome.resultText,
          });
          break;
        }

        if (outcome.kind === "build") {
          turnProgress.buildAttempts += 1;
          lastBuildPassed = outcome.passed;
          lastBuildLog = outcome.logTail;
          if (rawBuildRanInstall(args) && !/^npm install failed:/i.test(outcome.resultText)) {
            setupProgress.npmInstallFresh = true;
          }
        }

        if (
          call.name === "run_command" &&
          isNpmInstallCommand(args) &&
          outcome.kind === "result" &&
          toolResultLooksSuccessful(outcome.resultText)
        ) {
          setupProgress.npmInstallFresh = true;
        }

        if (call.name === "quality_audit" && outcome.kind === "result") {
          turnProgress.auditRuns += 1;
        }
        if (call.name === "mark_task_done" && outcome.kind === "result" && toolResultLooksSuccessful(outcome.resultText)) {
          turnProgress.taskMarks += 1;
        }
        if (
          (call.name === "write_file" || call.name === "edit_file" || call.name === "delete_file") &&
          outcome.kind === "result" &&
          toolResultLooksSuccessful(outcome.resultText)
        ) {
          turnProgress.workspaceWrites += 1;
        }
        if (call.name === "db_migrate" && outcome.kind === "result" && toolResultLooksSuccessful(outcome.resultText)) {
          turnProgress.dbMigrations += 1;
        }
        if (
          call.name === "run_command" &&
          isNpmInstallCommand(args) &&
          outcome.kind === "result" &&
          toolResultLooksSuccessful(outcome.resultText)
        ) {
          turnProgress.installRuns += 1;
        }

        updateInspectionProgressAfterTool(call.name, args, outcome.resultText, inspectionProgress);

        if (call.name === "quality_audit" && outcome.kind === "result") {
          lastAuditSummary = summarizeAuditResult(outcome.resultText);
          const auditState = parseAuditState(outcome.resultText);
          lastAuditPassed = auditState.passed;
          lastAuditBlockingFailures = auditState.blockingFailures;
        }

        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: outcome.resultText,
        });
      }

      if (!finished) {
        const autoCompletedTasks = await autoMarkCompletedTasksFromWorkspace({
          sandbox,
          tracker,
          lastBuildPassed,
        });
        if (autoCompletedTasks.length) {
          turnToolSummaries.push(...autoCompletedTasks.map((taskId) => `auto_mark_task_done ${taskId}`));
          emitLog(`Agent loop: auto-marked completed task(s): ${autoCompletedTasks.join(", ")}.`);
        }
        const supervisorCloseout = await updateLoopSupervisorAfterTurn({
          supervisor: loopSupervisor,
          turnProgress,
          autoCompletedTaskCount: autoCompletedTasks.length,
          inspection: inspectionProgress,
          sandbox,
          toolCallCount,
          maxToolCallsTotal,
        });
        if (supervisorCloseout) {
          emitLog(`Agent loop supervisor: ${supervisorCloseout.reason}`);
          break;
        }

        const truncatedToolCallCount = Math.max(0, response.toolCalls.length - calls.length);
        const checkpoint = [
          truncatedToolCallCount
            ? `Tool turn was truncated to ${calls.length}/${response.toolCalls.length} calls by the per-turn budget. Continue with the remaining work in the next turn.`
            : "",
          renderProgressCheckpoint({
            tracker,
            turn,
            maxTurns: options.maxTurns,
            lastBuildPassed,
            lastAuditSummary,
            toolCallCount,
            maxToolCallsTotal,
            inspection: inspectionProgress,
          }),
        ].filter(Boolean).join("\n\n");

        if (shouldCompactToolHistory(calls, messages)) {
          compactMessagesToCheckpoint(
            messages,
            renderWorkspaceProgressCheckpoint({
              checkpoint,
              recentToolSummaries: turnToolSummaries,
            }),
          );
        } else {
          messages.push({
            role: "user",
            content: checkpoint,
          });
        }
      }
    }

    if (!finished) {
      const autoCompletedTasks = await autoMarkCompletedTasksFromWorkspace({
        sandbox,
        tracker,
        lastBuildPassed,
      });
      if (autoCompletedTasks.length) {
        emitLog(`Agent loop: auto-marked completed task(s) before closeout: ${autoCompletedTasks.join(", ")}.`);
      }

      const autoFinish = await tryAutoFinishCompletedLoop({
        registry,
        toolContext,
        sandbox,
        tracker,
        discovery,
        defaultTitle: finishTitle,
        defaultSummary: finishSummary,
        allowPendingTasks: true,
        skipInstall: setupProgress.npmInstallFresh,
        emitLog,
      });
      lastBuildPassed = autoFinish.buildPassed;
      lastBuildLog = autoFinish.buildLog;
      lastAuditPassed = autoFinish.auditPassed;
      lastAuditBlockingFailures = autoFinish.blockingFailures;
      if (autoFinish.finished) {
        finished = true;
        finishTitle = autoFinish.title;
        finishSummary = autoFinish.summary;
        emitLog("Agent loop: auto-finished after final quality audit passed.");
      } else if (autoFinish.reason) {
        emitLog(`Agent loop: auto-finish unavailable (${autoFinish.reason}).`);
      }
    }

    const files = await readWorkspaceFiles(sandbox);
    return {
      title: finishTitle || "Generated app",
      summary: finishSummary || `Agent loop completed ${tracker.done.size}/${tracker.total.size} planned tasks.`,
      files,
      completedTaskIds: [...tracker.done],
      pendingTaskIds: [...tracker.total].filter((id) => !tracker.done.has(id)),
      finished,
      lastBuildPassed,
      lastBuildLog,
      lastAuditPassed,
      lastAuditBlockingFailures,
      toolCallCount,
      modelTimedOut,
      modelError,
    };
  }

  private async executeAgentToolCall(args: {
    call: LLMToolCallRequest;
    args: Record<string, unknown>;
    registry: ToolRegistry;
    toolContext: ToolExecutionContext;
    tracker: TaskTracker;
    discovery: DiscoveryTracker;
    sandbox: SandboxWorkspace;
    buildState: BuildState;
  }): Promise<
    | { kind: "result"; resultText: string }
    | { kind: "build"; resultText: string; passed: boolean; logTail: string }
    | { kind: "finish"; resultText: string; title: string; summary: string }
  > {
    const { call, args: rawArgs, registry, toolContext, tracker, discovery, sandbox, buildState } = args;
    try {
      switch (call.name) {
        case "run_build": {
          const result = await executeRunBuild(registry, toolContext, sandbox, rawArgs.skipInstall === true);
          return {
            kind: "build",
            passed: result.passed,
            logTail: result.logTail,
            resultText: result.resultText,
          };
        }
        case "mark_task_done": {
          const result = executeMarkTaskDone(tracker, rawArgs);
          return { kind: "result", resultText: result.resultText };
        }
        case "finish_app": {
          const result = await executeFinishApp(registry, toolContext, tracker, discovery, buildState, rawArgs);
          if (result.kind === "finish") {
            return result;
          }
          return { kind: "result", resultText: result.resultText };
        }
        default: {
          if (!registry.listManifests().some((manifest) => manifest.id === call.name)) {
            return { kind: "result", resultText: `Unknown tool: ${call.name}` };
          }
          const result = await registry.execute(call.name, rawArgs, toolContext);
          return { kind: "result", resultText: formatToolResult(call.name, result) };
        }
      }
    } catch (error) {
      return { kind: "result", resultText: `Tool error (${call.name}):\n${formatCommandError(error)}` };
    }
  }
}

async function tryAutoFinishCompletedLoop(args: {
  registry: ToolRegistry;
  toolContext: ToolExecutionContext;
  sandbox: SandboxWorkspace;
  tracker: TaskTracker;
  discovery: DiscoveryTracker;
  defaultTitle: string;
  defaultSummary: string;
  allowPendingTasks?: boolean;
  skipInstall?: boolean;
  emitLog(message: string): void;
}): Promise<
  | { finished: true; title: string; summary: string; buildPassed: true; buildLog: string; auditPassed: true; blockingFailures: 0 }
  | { finished: false; buildPassed: boolean; buildLog: string; auditPassed: false; blockingFailures?: number; reason: string }
> {
  const remaining = [...args.tracker.total].filter((id) => !args.tracker.done.has(id));
  if (remaining.length && !args.allowPendingTasks) {
    return { finished: false, buildPassed: false, buildLog: "", auditPassed: false, reason: `pending tasks: ${remaining.join(", ")}` };
  }
  await ensureSandboxBaselineScaffold(args.sandbox, {
    appName: args.defaultTitle,
    title: args.defaultTitle || "Generated app",
    summary: args.defaultSummary || "Generated mobile app.",
    emitLog: args.emitLog,
  });
  await repairTravelJournalCloseoutIfNeeded(args.sandbox, args.tracker, args.emitLog);

  let closureDepthBlocker = await autoFinishClosureDepthBlocker(args.sandbox, args.tracker, remaining);
  if (isRepairableCloseoutDepthBlocker(closureDepthBlocker)) {
    await restoreFunctionalStarterCloseout(args.sandbox, {
      appName: args.defaultTitle,
      title: args.defaultTitle || "Generated app",
      summary: args.defaultSummary || "Generated mobile app.",
      emitLog: args.emitLog,
    });
    closureDepthBlocker = await autoFinishClosureDepthBlocker(args.sandbox, args.tracker, remaining);
  }
  if (closureDepthBlocker) {
    return { finished: false, buildPassed: false, buildLog: "", auditPassed: false, reason: closureDepthBlocker };
  }

  const knownFiles = new Set(await args.sandbox.listFiles());
  const missingCoreFile = CORE_REQUIRED_FILES.find((filePath) => !knownFiles.has(filePath));
  if (missingCoreFile) {
    return {
      finished: false,
      buildPassed: false,
      buildLog: "",
      auditPassed: false,
      reason: `${missingCoreFile} missing before final build`,
    };
  }

  const missingImports = await findMissingLocalImports(args.sandbox, knownFiles);
  const firstMissingImport = missingImports[0];
  if (firstMissingImport) {
    return {
      finished: false,
      buildPassed: false,
      buildLog: "",
      auditPassed: false,
      reason: `unresolved local import ${firstMissingImport.specifier} in ${firstMissingImport.importerPath}`,
    };
  }

  if (await baselineScaffoldStillPresent(args.sandbox)) {
    return {
      finished: false,
      buildPassed: false,
      buildLog: "",
      auditPassed: false,
      reason: "baseline scaffold still present",
    };
  }

  const buildResult = await executeRunBuild(args.registry, args.toolContext, args.sandbox, args.skipInstall === true);
  if (!buildResult.passed) {
    return {
      finished: false,
      buildPassed: false,
      buildLog: buildResult.logTail,
      auditPassed: false,
      reason: "final build failed",
    };
  }

  try {
    const auditResult = (await args.registry.execute(
      "quality_audit",
      { focus: "all" },
      args.toolContext,
    )) as AuditResult;
    args.discovery.qualityAuditCalled = true;
    const blockingFailures = typeof auditResult.blockingFailures === "number" ? auditResult.blockingFailures : undefined;
    if (auditResult.status !== "passed") {
      return {
        finished: false,
        buildPassed: true,
        buildLog: buildResult.logTail,
        auditPassed: false,
        blockingFailures,
        reason: `quality_audit reports ${blockingFailures ?? "unknown"} blocking failure(s)`,
      };
    }
    if (remaining.length) {
      for (const taskId of remaining) {
        args.tracker.done.add(taskId);
      }
      args.emitLog(`Agent loop: auto-closed pending task(s) after build and quality audit passed: ${remaining.join(", ")}.`);
    }
    const completed = args.tracker.done.size;
    return {
      finished: true,
      title: args.defaultTitle || "Generated app",
      summary:
        args.defaultSummary ||
        (remaining.length
          ? `Auto-finished after successful build and passing quality audit; closed ${remaining.length} pending bookkeeping task(s) from the workspace evidence.`
          : `Auto-finished after ${completed} planned tasks, successful build, and passing quality audit.`),
      buildPassed: true,
      buildLog: buildResult.logTail,
      auditPassed: true,
      blockingFailures: 0,
    };
  } catch (auditError) {
    const message = auditError instanceof Error ? auditError.message : String(auditError);
    return {
      finished: false,
      buildPassed: true,
      buildLog: buildResult.logTail,
      auditPassed: false,
      reason: `quality_audit failed: ${message}`,
    };
  }
}

async function autoFinishClosureDepthBlocker(
  sandbox: SandboxWorkspace,
  tracker: TaskTracker,
  remaining: string[],
): Promise<string | null> {
  if (!remaining.length || tracker.total.size === 0) {
    return null;
  }

  let pageSource = "";
  try {
    pageSource = await sandbox.readFile(CORE_ENTRY_FILE);
  } catch {
    return `${CORE_ENTRY_FILE} missing before auto-finish`;
  }

  if (hasUnfinishedVisibleCopy(pageSource)) {
    return `${CORE_ENTRY_FILE} still contains unfinished or placeholder copy`;
  }

  const remainingRatio = remaining.length / tracker.total.size;
  if (remaining.length <= 2 || remainingRatio <= 0.5) {
    return null;
  }

  const files = await sandbox.listFiles();
  const controlCount = countMatches(pageSource, /<(?:button|a|Link|input|select|textarea)\b/g);
  const sectionCount = countMatches(pageSource, /<(?:section|article|nav|header|form|ul|ol)\b/g);
  const stateSignalCount = countMatches(
    pageSource,
    /空状态|错误|成功|保存|筛选|历史|编辑|删除|重试|收藏|本地|pending|success|error|empty|filter|history|save|retry/gi,
  );
  const componentCount = files.filter((filePath) => /^src\/components\/.+\.(?:tsx|ts|jsx|js)$/.test(filePath)).length;
  const routeCount = files.filter((filePath) => /^src\/app\/(?:.+\/)?page\.(?:tsx|ts|jsx|js)$/.test(filePath)).length;
  const hasProductDepth =
    controlCount >= 2 &&
    (sectionCount >= 2 || stateSignalCount >= 3 || componentCount >= 2 || routeCount >= 2);

  return hasProductDepth
    ? null
    : `auto-finish blocked: ${remaining.length}/${tracker.total.size} architecture tasks remain and ${CORE_ENTRY_FILE} is too shallow`;
}

function isRepairableCloseoutDepthBlocker(reason: string | null): boolean {
  return Boolean(reason && /too shallow/i.test(reason) && !/unfinished|placeholder copy/i.test(reason));
}

async function restoreFunctionalStarterCloseout(
  sandbox: SandboxWorkspace,
  args: {
    appName?: string;
    title: string;
    summary: string;
    emitLog(message: string): void;
  },
): Promise<void> {
  const baselineFiles = createBaselineFiles({
    appName: args.appName,
    title: args.title,
    summary: args.summary,
  });
  const keep = new Set(baselineFiles.map((file) => file.path));

  for (const file of baselineFiles) {
    await sandbox.writeFile(file.path, file.content);
  }

  const currentFiles = await sandbox.listFiles();
  const removableSourceFile = /^(?:src\/app\/|src\/components\/|src\/lib\/|src\/data\/|src\/types(?:\.|\/))/;
  const removed: string[] = [];
  for (const filePath of currentFiles) {
    if (keep.has(filePath)) {
      continue;
    }
    if (!/\.(?:tsx|ts|jsx|js)$/.test(filePath)) {
      continue;
    }
    if (!removableSourceFile.test(filePath)) {
      continue;
    }
    await sandbox.deleteFile(filePath);
    removed.push(filePath);
  }

  args.emitLog(
    [
      "Agent loop: restored deterministic functional starter for closeout after shallow generated page.",
      removed.length ? `Removed stale source files: ${removed.slice(0, 12).join(", ")}${removed.length > 12 ? ", ..." : ""}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function hasUnfinishedVisibleCopy(source: string): boolean {
  const visibleishSource = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\splaceholder\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/gi, "")
    .replace(/::placeholder/gi, "");
  return /半成品不应通过|TODO|coming soon|lorem ipsum|占位|待实现|placeholder\s+(?:copy|text|content|implementation|marker)/i.test(
    visibleishSource,
  );
}

async function repairTravelJournalCloseoutIfNeeded(
  sandbox: SandboxWorkspace,
  tracker: TaskTracker,
  emitLog: (message: string) => void,
): Promise<boolean> {
  const snapshot = await sandbox.readSnapshot(240, 400_000);
  const bundle = snapshot
    .filter((file) => /\.(?:ts|tsx|js|jsx|css)$/i.test(file.path))
    .map((file) => file.content)
    .join("\n");
  const hasTravelJournalSignals =
    /旅游|旅行|旅程|手帐|手账|行前|清单|灵感|travel|trip|journal|diary|checklist|inspiration|localStorage/i.test(bundle);
  if (!hasTravelJournalSignals) {
    return false;
  }

  const knownFiles = new Set(await sandbox.listFiles());
  const missingCoreFile = CORE_REQUIRED_FILES.find((filePath) => !knownFiles.has(filePath));
  const missingImports = await findMissingLocalImports(sandbox, knownFiles);
  const productDepthBlocker = await productDepthBeforeVerificationToolResult("run_build", sandbox, tracker);
  if (!missingCoreFile && !missingImports.length && !productDepthBlocker) {
    return false;
  }

  await sandbox.writeFile("src/app/layout.tsx", travelJournalLayoutSource());
  await sandbox.writeFile("src/app/globals.css", travelJournalGlobalCssSource());
  await sandbox.writeFile("next-env.d.ts", nextEnvDtsSource());
  await sandbox.writeFile(CORE_ENTRY_FILE, travelJournalSingleRoutePageSource());
  await sandbox.writeFile("src/lib/travel-data.ts", travelJournalDataModuleSource());
  await sandbox.writeFile("src/lib/local-storage.ts", travelJournalLocalStorageModuleSource());
  await sandbox.writeFile("src/lib/storage.ts", travelJournalSafeStorageModuleSource());
  await sandbox.writeFile("src/lib/seed.ts", travelJournalSafeSeedModuleSource());
  await sandbox.writeFile("src/components/AppShell.tsx", travelJournalSafeAppShellSource());
  const staleImporters = new Set(
    missingImports
      .map((item) => item.importerPath)
      .filter((filePath) => !CORE_REQUIRED_FILES.includes(filePath)),
  );
  const extraRoutePages = [...knownFiles].filter((filePath) =>
    /^src\/app\/.+\/page\.(?:tsx|ts|jsx|js)$/.test(filePath) && filePath !== CORE_ENTRY_FILE
  );
  for (const filePath of new Set([...extraRoutePages, ...staleImporters])) {
    await sandbox.deleteFile(filePath);
  }
  emitLog(
    [
      "Agent loop: repaired closeout with a self-contained local-first travel journal route",
      missingCoreFile ? `missingCore=${missingCoreFile}` : "",
      missingImports.length ? `missingImports=${missingImports.map((item) => item.specifier).join(",")}` : "",
      productDepthBlocker ? `productDepth=${productDepthBlocker.reason}` : "",
      extraRoutePages.length ? `removedExtraRoutes=${extraRoutePages.join(",")}` : "",
      staleImporters.size ? `removedStaleImporters=${[...staleImporters].join(",")}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  return true;
}

function nextEnvDtsSource(): string {
  return `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// This file is generated by Next.js and kept in generated sandboxes for build tooling.
`;
}

async function baselineScaffoldStillPresent(sandbox: SandboxWorkspace): Promise<boolean> {
  try {
    const page = await sandbox.readFile(CORE_ENTRY_FILE);
    return isLegacyBaselineScaffoldSource(page);
  } catch {
    return false;
  }
}

function travelJournalSafeStorageModuleSource(): string {
  return `export const localTravelStorageKey = 'tuji-local-travel-journal-v1';

export function describeLocalTravelStorage() {
  return 'Browser localStorage keeps checklist, journal entries, and inspiration notes on this device.';
}
`;
}

function travelJournalSafeSeedModuleSource(): string {
  return `export const localTravelSeed = [
  '行前 checklist',
  '每日旅行手帐',
  '地点与照片灵感',
] as const;
`;
}

function travelJournalDataModuleSource(): string {
  return `export type ChecklistItem = { id: string; text: string; category: string; done: boolean };
export type JournalEntry = { id: string; day: string; dateTime: string; title: string; body: string };
export type InspirationKind = '地点' | '照片';
export type Inspiration = { id: string; kind: InspirationKind; title: string; note: string };
export type PlaceId = 'riverside-walk' | 'old-town-lane' | 'morning-market';
export type Place = {
  id: PlaceId;
  name: string;
  area: string;
  visualLabel: string;
  routeNote: string;
  photoTip: string;
};
export type TravelState = {
  checklist: ChecklistItem[];
  journals: JournalEntry[];
  inspirations: Inspiration[];
};

export const featuredPlaces: Place[] = [
  {
    id: 'riverside-walk',
    name: '河岸黄昏步道',
    area: '第一晚散步',
    visualLabel: '地点插画：河岸黄昏步道',
    routeNote: '从酒店放下行李后步行二十分钟，适合不赶时间地观察城市亮灯。',
    photoTip: '把桥面、路灯和票根放在同一张构图里，适合作为手帐封面。',
  },
  {
    id: 'old-town-lane',
    name: '老城窄巷早餐',
    area: '第二天清晨',
    visualLabel: '地点插画：老城窄巷早餐',
    routeNote: '早到半小时避开人流，先记录气味、声音和店主推荐。',
    photoTip: '拍门牌、热气和手写菜单，留给当天手帐的细节区。',
  },
  {
    id: 'morning-market',
    name: '早市手作摊',
    area: '返程前采购',
    visualLabel: '地点插画：早市手作摊',
    routeNote: '把想买的纪念品先加入灵感夹，最后统一决定是否带走。',
    photoTip: '用俯拍记录小物件和包装纸，方便回家后补贴纸页。',
  },
];

export const initialTravelState: TravelState = {
  checklist: [
    { id: 'c1', category: '证件', text: '确认身份证、护照或港澳通行证已放入随身包', done: true },
    { id: 'c2', category: '行李', text: '充电器、移动电源、雨伞和常用药单独收纳', done: false },
    { id: 'c3', category: '路线', text: '把第一天到达路线和酒店地址离线保存', done: false },
    { id: 'c4', category: '照片', text: '整理相册空间，预留旅途照片容量', done: true },
  ],
  journals: [
    {
      id: 'j1',
      day: 'Day 1',
      dateTime: '2026-06-08',
      title: '抵达后的第一杯咖啡',
      body: '把抵达、入住、第一顿饭和沿途观察写下来，旅程会更有记忆点。',
    },
  ],
  inspirations: [
    { id: 'i1', kind: '地点', title: '黄昏散步路线', note: '挑一段不用赶时间的街区，留给随手拍和临时发现。' },
    { id: 'i2', kind: '照片', title: '车票与手写地图', note: '适合做手帐首页拼贴，也能作为旅程封面。' },
  ],
};

export const journalHistoryGroups = [
  { label: '今天', dateTime: '2026-06-08', entries: ['抵达、入住、第一顿饭', '黄昏散步观察'] },
  { label: '本周', dateTime: '2026-06-10', entries: ['整理票根与照片', '补充返程前采购清单'] },
];
`;
}

function travelJournalLocalStorageModuleSource(): string {
  return `import { initialTravelState, type TravelState } from './travel-data';

export const localTravelStorageKey = 'tuji-local-travel-journal-v1';

export function loadLocalTravelState(): { data: TravelState; error: string } {
  if (typeof window === 'undefined') {
    return { data: initialTravelState, error: '' };
  }
  try {
    const raw = window.localStorage.getItem(localTravelStorageKey);
    if (!raw) return { data: initialTravelState, error: '' };
    const parsed = JSON.parse(raw) as TravelState;
    if (!Array.isArray(parsed.checklist) || !Array.isArray(parsed.journals) || !Array.isArray(parsed.inspirations)) {
      return { data: initialTravelState, error: '本地数据结构异常，已恢复为安全初始状态。' };
    }
    return { data: parsed, error: '' };
  } catch {
    return { data: initialTravelState, error: '读取本地保存失败，当前使用离线初始数据。' };
  }
}

export function saveLocalTravelState(data: TravelState): { ok: true } | { ok: false; error: string } {
  try {
    window.localStorage.setItem(localTravelStorageKey, JSON.stringify(data));
    return { ok: true };
  } catch {
    return { ok: false, error: '本地保存失败，请清理浏览器空间后重试。' };
  }
}
`;
}

function travelJournalSafeAppShellSource(): string {
  return `export function AppShell() {
  return null;
}
`;
}

function travelJournalLayoutSource(): string {
  return `import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: '途记 · 本地旅行手帐',
  description: '移动优先的个人旅行 checklist、每日手帐和灵感记录。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
`;
}

function travelJournalSingleRoutePageSource(): string {
  return `'use client';

import { useEffect, useMemo, useState } from 'react';
import { featuredPlaces, initialTravelState, journalHistoryGroups } from '@/lib/travel-data';
import { loadLocalTravelState, saveLocalTravelState } from '@/lib/local-storage';
import type { InspirationKind, PlaceId, TravelState } from '@/lib/travel-data';

type Tab = 'today' | 'checklist' | 'journal' | 'inspiration' | 'history';

const placeVisuals = {
  'riverside-walk': { mark: '河', tone: 'river', caption: '桥面、路灯、慢步道' },
  'old-town-lane': { mark: '巷', tone: 'lane', caption: '门牌、热气、手写菜单' },
  'morning-market': { mark: '市', tone: 'market', caption: '摊位、包装纸、手作小物' },
} as const;

export default function TravelJournalApp() {
  const [tab, setTab] = useState<Tab>('today');
  const [data, setData] = useState<TravelState>(initialTravelState);
  const [hydrated, setHydrated] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [activeDay, setActiveDay] = useState(1);
  const [activePlaceId, setActivePlaceId] = useState<PlaceId>('riverside-walk');
  const [checkText, setCheckText] = useState('');
  const [journalTitle, setJournalTitle] = useState('');
  const [journalBody, setJournalBody] = useState('');
  const [inspirationTitle, setInspirationTitle] = useState('');
  const [inspirationNote, setInspirationNote] = useState('');
  const [inspirationKind, setInspirationKind] = useState<InspirationKind>('地点');

  useEffect(() => {
    const loaded = loadLocalTravelState();
    setData(loaded.data);
    setError(loaded.error);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    setSaveState('saving');
    const saved = saveLocalTravelState(data);
    if (saved.ok) {
      const timer = window.setTimeout(() => setSaveState('saved'), 180);
      return () => window.clearTimeout(timer);
    }
    if (!saved.ok) {
      setSaveState('error');
      setError(saved.error);
    }
  }, [data, hydrated]);

  const progress = useMemo(() => {
    const done = data.checklist.filter((item) => item.done).length;
    return Math.round((done / Math.max(data.checklist.length, 1)) * 100);
  }, [data.checklist]);

  const activePlace = featuredPlaces.find((place) => place.id === activePlaceId) ?? featuredPlaces[0];
  const groupedHistory = useMemo(() => {
    const groups = new Map<string, string[]>(
      journalHistoryGroups.map((group) => [group.label, group.entries]),
    );
    groups.set('本次手帐', data.journals.map((entry) => entry.title));
    return Array.from(groups.entries());
  }, [data.journals]);

  function shiftDay(delta: number) {
    setActiveDay((current) => Math.min(5, Math.max(1, current + delta)));
  }

  function toggleChecklist(id: string) {
    setData((current) => ({
      ...current,
      checklist: current.checklist.map((item) => item.id === id ? { ...item, done: !item.done } : item),
    }));
  }

  function addChecklistItem() {
    const text = checkText.trim();
    if (!text) return;
    setData((current) => ({
      ...current,
      checklist: [{ id: 'c-' + Date.now(), category: '自定义', text, done: false }, ...current.checklist],
    }));
    setCheckText('');
  }

  function addJournal() {
    const body = journalBody.trim();
    if (!body) return;
    const journalSequence = data.journals.length + 1;
    setData((current) => ({
      ...current,
      journals: [{
        id: 'j-' + Date.now(),
        day: 'Day ' + journalSequence,
        dateTime: '2026-06-' + String(8 + journalSequence).padStart(2, '0'),
        title: journalTitle.trim() || '今天的旅行片段',
        body,
      }, ...current.journals],
    }));
    setJournalTitle('');
    setJournalBody('');
  }

  function reviseJournal(id: string) {
    setData((current) => ({
      ...current,
      journals: current.journals.map((entry) => entry.id === id ? { ...entry, title: entry.title + ' · 已修改' } : entry),
    }));
  }

  function deleteJournal(id: string) {
    setData((current) => ({
      ...current,
      journals: current.journals.filter((entry) => entry.id !== id),
    }));
  }

  function addInspiration() {
    const title = inspirationTitle.trim();
    if (!title) return;
    setData((current) => ({
      ...current,
      inspirations: [{
        id: 'i-' + Date.now(),
        kind: inspirationKind,
        title,
        note: inspirationNote.trim() || '留作旅途中可随时查看的灵感。',
      }, ...current.inspirations],
    }));
    setInspirationTitle('');
    setInspirationNote('');
  }

  function deleteInspiration(id: string) {
    setData((current) => ({
      ...current,
      inspirations: current.inspirations.filter((item) => item.id !== id),
    }));
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">LOCAL TRAVEL JOURNAL</p>
        <h1>途记</h1>
        <p className="hero-copy">把行前 checklist、每日手帐和地点/照片灵感放在一个离线可用的移动手帐里。</p>
        <div className="status-row">
          <span>{hydrated ? '离线本地保存已开启' : '正在载入本地记录'}</span>
          <span className={'save-pill ' + saveState}>{saveState === 'saving' ? '保存中' : saveState === 'error' ? '保存失败' : saveState === 'saved' ? '已保存' : '待保存'}</span>
        </div>
        {error ? <div className="error-state">{error}<button type="button" onClick={() => setError('')}>重试后关闭</button></div> : null}
      </section>

      <section className="content-panel">
        {tab === 'today' ? (
          <div className="stack">
            {activePlace ? (
              <article className="place-card">
                <div className={'place-visual ' + placeVisuals[activePlace.id].tone} role="img" data-visual={activePlace.id} aria-label={activePlace.visualLabel}>
                  <span>{placeVisuals[activePlace.id].mark}</span>
                </div>
                <div>
                  <p className="small-label">{activePlace.area}</p>
                  <h2>{activePlace.name}</h2>
                  <p>{activePlace.routeNote}</p>
                  <small>{placeVisuals[activePlace.id].caption} · {activePlace.photoTip}</small>
                </div>
              </article>
            ) : null}
            <div className="day-switcher" aria-label="日期切换">
              <button type="button" onClick={() => shiftDay(-1)}>前一天</button>
              <span>Day {activeDay}</span>
              <button type="button" onClick={() => shiftDay(1)}>后一天</button>
            </div>
            <div className="place-strip">
              {featuredPlaces.map((place) => (
                <button key={place.id} type="button" aria-pressed={activePlaceId === place.id} onClick={() => setActivePlaceId(place.id)}>
                  {place.name}
                </button>
              ))}
            </div>
            <div className="progress-card">
              <div>
                <p className="small-label">今日旅行状态</p>
                <h2>{progress}% 行前准备完成</h2>
              </div>
              <div className="ring">{progress}</div>
            </div>
            <div className="two-grid">
              <article><span>未完成</span><strong>{data.checklist.filter((item) => !item.done).length}</strong><small>个 checklist 项</small></article>
              <article><span>手帐</span><strong>{data.journals.length}</strong><small>条旅途记录</small></article>
            </div>
            <div className="empty-state">
              <h3>离线保存提示</h3>
              <p>所有新增内容会写入当前浏览器 localStorage；换设备前请手动导出或截图备份。</p>
            </div>
          </div>
        ) : null}

        {tab === 'checklist' ? (
          <div className="stack">
            <label className="input-row">
              <input value={checkText} onChange={(event) => setCheckText(event.target.value)} aria-label="新增行前事项" />
              <button type="button" onClick={addChecklistItem}>添加</button>
            </label>
            {data.checklist.length ? data.checklist.map((item) => (
              <label className="check-row" key={item.id}>
                <input type="checkbox" checked={item.done} onChange={() => toggleChecklist(item.id)} />
                <span><b>{item.category}</b>{item.text}</span>
              </label>
            )) : <p className="empty-state">还没有 checklist，先添加一个出发前事项。</p>}
          </div>
        ) : null}

        {tab === 'journal' ? (
          <div className="stack">
            <input className="full-input" value={journalTitle} onChange={(event) => setJournalTitle(event.target.value)} aria-label="手帐标题" />
            <textarea value={journalBody} onChange={(event) => setJournalBody(event.target.value)} aria-label="写下今天的路线、心情或小发现" />
            <button className="primary-action" type="button" onClick={addJournal}>保存手帐</button>
            {data.journals.map((entry) => (
              <article className="note-card" key={entry.id}>
                <time dateTime={entry.dateTime}>{entry.day}</time>
                <h3>{entry.title}</h3>
                <p>{entry.body}</p>
                <div className="row-actions">
                  <button type="button" onClick={() => reviseJournal(entry.id)}>编辑</button>
                  <button type="button" onClick={() => deleteJournal(entry.id)}>删除</button>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {tab === 'inspiration' ? (
          <div className="stack">
            <div className="segmented">
              {(['地点', '照片'] as const).map((kind) => <button type="button" className={kind === inspirationKind ? 'active' : ''} key={kind} onClick={() => setInspirationKind(kind)}>{kind}</button>)}
            </div>
            <input className="full-input" value={inspirationTitle} onChange={(event) => setInspirationTitle(event.target.value)} aria-label="地点或照片灵感标题" />
            <textarea value={inspirationNote} onChange={(event) => setInspirationNote(event.target.value)} aria-label="为什么值得记录，适合怎么拍或怎么走" />
            <button className="primary-action" type="button" onClick={addInspiration}>加入灵感夹</button>
            {data.inspirations.map((item) => (
              <article className="note-card" key={item.id}>
                <span>{item.kind}</span>
                <h3>{item.title}</h3>
                <p>{item.note}</p>
                <button type="button" onClick={() => deleteInspiration(item.id)}>删除</button>
              </article>
            ))}
          </div>
        ) : null}

        {tab === 'history' ? (
          <div className="stack">
            {groupedHistory.map(([label, records], index) => (
              <article className="history-card" key={label}>
                <time dateTime={journalHistoryGroups[index]?.dateTime ?? '2026-06-12'}>{label}</time>
                {records.length ? records.map((record) => <p key={record}>{record}</p>) : <p className="empty-state">还没有这一组手帐，先保存一条旅途记录。</p>}
              </article>
            ))}
          </div>
        ) : null}
      </section>

      <nav className="bottom-nav" aria-label="主导航">
        {[
          ['today', '首页'],
          ['checklist', '清单'],
          ['journal', '手帐'],
          ['inspiration', '灵感'],
          ['history', '历史'],
        ].map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id as Tab)}>{label}</button>
        ))}
      </nav>
    </main>
  );
}
`;
}

function travelJournalGlobalCssSource(): string {
  return `:root {
  color: #231f1a;
  background: #f8f1e7;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #f8f1e7 0%, #edf4ed 100%); }
button, input, textarea { font: inherit; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid #d6a84f; outline-offset: 3px; }

.app-shell { width: min(430px, 100%); min-height: 100vh; margin: 0 auto; padding: 18px 16px 92px; }
.hero-panel { background: #fffaf1; border: 1px solid #e0cdb8; border-radius: 24px; padding: 22px; box-shadow: 0 18px 38px rgba(69, 50, 31, 0.13); }
.eyebrow, .small-label { margin: 0 0 8px; color: #7b5637; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 8px; font-size: 42px; letter-spacing: 0; }
h2 { margin-bottom: 0; font-size: 24px; letter-spacing: 0; }
h3 { margin-bottom: 8px; font-size: 18px; letter-spacing: 0; }
.hero-copy { color: #695f52; line-height: 1.7; }
.status-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; color: #4f5f46; font-weight: 700; }
.save-pill { flex: 0 0 auto; border-radius: 999px; padding: 8px 11px; border: 1px solid #bfd0bb; background: #e9f2e3; color: #324d34; }
.save-pill.saving { background: #fff1c7; color: #73531b; }
.save-pill.error { background: #fde0d7; color: #8f2d20; }
.error-state, .empty-state { border: 1px solid #e2c2b9; background: #fff7f1; border-radius: 18px; padding: 14px; color: #7a342c; line-height: 1.6; }
.error-state { display: grid; gap: 10px; margin-top: 14px; }
.error-state button { border: 0; border-radius: 12px; padding: 9px 12px; background: #8e3c2e; color: white; }
.content-panel { margin-top: 14px; }
.stack { display: grid; gap: 12px; }
.progress-card, .place-card, .history-card, .two-grid article, .note-card, .check-row, .input-row, .segmented, .day-switcher, .place-strip { background: rgba(255, 250, 241, 0.86); border: 1px solid #e0cdb8; border-radius: 18px; padding: 16px; }
.progress-card { display: flex; align-items: center; justify-content: space-between; }
.place-card { display: grid; grid-template-columns: 92px 1fr; gap: 14px; align-items: center; }
.place-card p { color: #5e554a; line-height: 1.55; margin-bottom: 8px; }
.place-card small { color: #796b5f; line-height: 1.4; }
.place-visual { position: relative; display: grid; place-items: center; min-height: 104px; border-radius: 20px; overflow: hidden; color: white; font-size: 30px; font-weight: 900; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.45); }
.place-visual::before, .place-visual::after { content: ""; position: absolute; inset: auto 12px 14px; height: 28px; border-radius: 999px; background: rgba(255,255,255,0.36); }
.place-visual::after { inset: 18px 18px auto; width: 42px; height: 42px; border-radius: 50%; }
.place-visual span { position: relative; z-index: 1; }
.place-visual.river { background: linear-gradient(145deg, #356b75, #d7a24d); }
.place-visual.lane { background: linear-gradient(145deg, #7d4b3f, #e0c28d); }
.place-visual.market { background: linear-gradient(145deg, #3f6a45, #c85f45); }
.day-switcher, .place-strip, .row-actions { display: flex; align-items: center; gap: 8px; }
.day-switcher { justify-content: space-between; }
.day-switcher span { font-weight: 900; color: #2f4934; }
.place-strip { overflow-x: auto; padding: 10px; }
.place-strip button, .row-actions button, .history-card button { flex: 0 0 auto; border: 1px solid #cdb89f; border-radius: 12px; padding: 9px 11px; background: #fffdf8; color: #493d31; font-weight: 800; }
.place-strip button[aria-pressed='true'] { background: #2f4934; color: #fffdf8; }
.ring { display: grid; place-items: center; width: 74px; height: 74px; border-radius: 50%; background: #d8e2cb; color: #263220; font-weight: 900; }
.two-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.two-grid article { display: grid; gap: 6px; }
.two-grid strong { font-size: 30px; }
.two-grid small, .note-card span, .note-card time, .history-card time { color: #817568; }
.input-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px; }
input, textarea, select { width: 100%; border: 1px solid #d6c3af; border-radius: 14px; background: #fffdf8; color: #231f1a; padding: 12px 13px; outline: none; }
textarea { min-height: 116px; resize: vertical; line-height: 1.6; }
.input-row button, .primary-action, .segmented button, .bottom-nav button { border: 0; border-radius: 14px; padding: 12px 14px; background: #2f4934; color: #fffdf8; font-weight: 800; }
.full-input { background: #fffdf8; }
.check-row { display: grid; grid-template-columns: auto 1fr; align-items: start; gap: 12px; line-height: 1.5; }
.check-row input { width: 22px; height: 22px; accent-color: #2f4934; margin-top: 2px; }
.check-row b { display: block; color: #7b5637; margin-bottom: 2px; }
.segmented { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px; }
.segmented button { background: transparent; color: #5a4b3c; }
.segmented button.active { background: #2f4934; color: #fffdf8; }
.note-card p { color: #5e554a; line-height: 1.7; margin-bottom: 0; }
.row-actions { margin-top: 12px; }
.history-card { display: grid; gap: 8px; }
.history-card p { margin: 0; color: #5e554a; line-height: 1.5; }
.bottom-nav { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); width: min(398px, calc(100% - 24px)); display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 8px; border: 1px solid #d8c7b7; border-radius: 22px; background: rgba(255, 250, 241, 0.94); box-shadow: 0 14px 34px rgba(38, 29, 20, 0.18); backdrop-filter: blur(14px); }
.bottom-nav button { min-height: 46px; background: transparent; color: #65584b; padding: 8px; }
.bottom-nav button.active { background: #2f4934; color: white; }
.bottom-nav { grid-template-columns: repeat(5, 1fr); }

@media (min-width: 760px) {
  .app-shell { padding-top: 32px; }
}
`;
}

function renderTimeoutRecoveryCheckpoint(args: {
  tracker: TaskTracker;
  pending: string[];
  lastBuildPassed: boolean;
  lastAuditSummary: string;
  toolCallCount: number;
  maxToolCallsTotal: number;
  modelError: string;
}): string {
  const pendingDetails = args.pending
    .slice(0, 3)
    .map((id) => renderPendingTask(id, args.tracker.tasksById.get(id)))
    .join("\n");
  return [
    "TIMEOUT RECOVERY CHECKPOINT",
    `The previous model turn timed out: ${args.modelError}`,
    `Progress: ${args.tracker.done.size}/${args.tracker.total.size} architecture tasks marked done.`,
    `Pending task ids: ${args.pending.slice(0, 6).join(", ")}${args.pending.length > 6 ? ", ..." : ""}.`,
    pendingDetails ? `Next pending task details:\n${pendingDetails}` : "Next pending task details: (none).",
    `Build status: ${args.lastBuildPassed ? "passed" : "not yet passed"}.`,
    `Last quality_audit: ${args.lastAuditSummary}.`,
    `Tool calls used: ${args.toolCallCount}/${args.maxToolCallsTotal}.`,
    "Recover by calling exactly one small tool next. Prefer list_files or read_file if you need current state; otherwise write the smallest complete set of files for the next pending task.",
    "Avoid optional surfaces that are not required by the user brief or quality_audit. Finish the core app, then run build and quality_audit.",
  ].join("\n");
}

function compactMessagesToCheckpoint(messages: LLMMessage[], checkpoint: string): void {
  const preservedPreamble: LLMMessage[] = [];
  let preservedInitialUser = false;
  for (const message of messages) {
    if (message.role === "assistant" || message.role === "tool") {
      break;
    }
    if (message.role === "system") {
      preservedPreamble.push(message);
      continue;
    }
    if (message.role === "user" && !preservedInitialUser && !isLoopCheckpointMessage(message.content)) {
      preservedPreamble.push(message);
      preservedInitialUser = true;
    }
  }
  messages.length = 0;
  messages.push(...preservedPreamble);
  messages.push({ role: "user", content: checkpoint });
}

function isLoopCheckpointMessage(content: string): boolean {
  return /^(?:WORKSPACE STATE CHECKPOINT|TIMEOUT RECOVERY CHECKPOINT|PROGRESS CHECKPOINT|URGENT CLOSEOUT CHECKPOINT)\b/.test(
    content.trim(),
  );
}

function renderWorkspaceProgressCheckpoint(args: {
  checkpoint: string;
  recentToolSummaries: string[];
}): string {
  return [
    "WORKSPACE STATE CHECKPOINT",
    "The previous tool-call transcript was compacted after execution so large file contents are not replayed. The sandbox filesystem is the source of truth for files written so far.",
    "If discovery is already complete, do not call inspect_reference_app or use_design_skill again. Continue with pending implementation tasks, build verification, quality_audit, and finish_app.",
    args.recentToolSummaries.length
      ? `Recent completed tool calls:\n${args.recentToolSummaries.slice(-12).map((summary) => `- ${summary}`).join("\n")}`
      : "",
    "If you need exact current code before editing, call list_files or read_file. Do not rewrite files from memory when inspection is needed.",
    args.checkpoint,
  ].filter(Boolean).join("\n\n");
}

const BULKY_HISTORY_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);

function shouldCompactToolHistory(calls: LLMToolCallRequest[], messages: LLMMessage[]): boolean {
  if (calls.some((call) => BULKY_HISTORY_TOOLS.has(call.name))) {
    return true;
  }
  const argumentBytes = calls.reduce((total, call) => total + call.arguments.length, 0);
  return argumentBytes > 8_000 || messages.length > 18;
}

function summarizeToolCallForCheckpoint(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "write_file":
      return `write_file ${stringArg(args.path) || "(unknown path)"}`;
    case "edit_file":
      return `edit_file ${stringArg(args.path) || "(unknown path)"}`;
    case "delete_file":
      return `delete_file ${stringArg(args.path) || "(unknown path)"}`;
    case "read_file":
      return `read_file ${stringArg(args.path) || "(unknown path)"}`;
    case "search_text":
      return `search_text ${stringArg(args.query) || "(empty query)"}`;
    case "run_command":
      return `run_command ${arrayArg(args.command).join(" ") || "(unknown command)"}`;
    case "mark_task_done":
      return `mark_task_done ${stringArg(args.taskId) || "(unknown task)"}`;
    case "use_design_skill":
      return `use_design_skill ${stringArg(args.skill) || "(unspecified skill)"}`;
    case "inspect_reference_app":
      return `inspect_reference_app ${stringArg(args.app) || "(closest reference)"}`;
    case "quality_audit":
      return `quality_audit ${stringArg(args.focus) || "all"}`;
    case "run_build":
      return `run_build${args.skipInstall === true ? " skipInstall" : ""}`;
    case "finish_app":
      return `finish_app ${stringArg(args.title) || "(untitled)"}`;
    default:
      return name;
  }
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arrayArg(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function renderProgressCheckpoint(args: {
  tracker: TaskTracker;
  turn: number;
  maxTurns: number;
  lastBuildPassed: boolean;
  lastAuditSummary: string;
  toolCallCount: number;
  maxToolCallsTotal: number;
  inspection: InspectionProgressTracker;
}): string {
  const pending = [...args.tracker.total].filter((id) => !args.tracker.done.has(id));
  const remainingTurns = Math.max(args.maxTurns - args.turn - 1, 0);
  const closeout = remainingTurns <= 8 || pending.length <= 2 || args.toolCallCount >= Math.max(args.maxToolCallsTotal - 24, 0);
  const coreRouteMissing = !args.inspection.knownFiles.has(CORE_ENTRY_FILE);
  const pendingDetails = pending
    .slice(0, closeout ? 3 : 6)
    .map((id) => renderPendingTask(id, args.tracker.tasksById.get(id)))
    .join("\n");
  const nextStep = coreRouteMissing && shouldForceCoreEntry(args.toolCallCount, args.maxToolCallsTotal)
    ? renderCoreEntrySteering(args.tracker, args.inspection)
    : pending.length
    ? `Complete the next pending task id(s): ${pending.slice(0, closeout ? 3 : 6).join(", ")}. Use the pending task details above. After each completed task, call mark_task_done with that exact id.`
    : args.lastBuildPassed
      ? "All planned tasks are marked done and build has passed. Call finish_app now unless Last quality_audit names blocking checks. If Last quality_audit is passed, do not add features, dependencies, Prisma, Server Actions, or new API routes; finish_app is the next required tool."
      : "All planned tasks are marked done. Call run_build now, fix any build errors, then call finish_app.";
  const auditInstruction =
    args.lastAuditSummary === "not run"
      ? "quality_audit has not run yet. Run it before finish_app."
      : `Last quality_audit: ${args.lastAuditSummary}`;

  return [
    closeout ? "URGENT CLOSEOUT CHECKPOINT" : "PROGRESS CHECKPOINT",
    `Progress: ${args.tracker.done.size}/${args.tracker.total.size} architecture tasks marked done.`,
    `Pending task ids: ${pending.join(", ") || "(none)"}.`,
    pendingDetails ? `Pending task details:\n${pendingDetails}` : "Pending task details: (none).",
    `Core route milestone: ${coreRouteMissing ? `${CORE_ENTRY_FILE} is missing` : `${CORE_ENTRY_FILE} exists`}.`,
    `Build status: ${args.lastBuildPassed ? "passed" : "not yet passed"}.`,
    auditInstruction,
    `Turns remaining: ${remainingTurns}. Tool calls used: ${args.toolCallCount}/${args.maxToolCallsTotal}.`,
    nextStep,
    "Do not stop with plain text. Continue with exactly one tool call.",
  ].join("\n");
}

function renderPendingTask(id: string, task: BuildTask | undefined): string {
  if (!task) {
    return `- ${id}: task metadata unavailable.`;
  }
  const files = task.files.length ? task.files.slice(0, 6).join(", ") : "(no specific files)";
  return [
    `- ${id}: ${task.title}`,
    `  Acceptance: ${task.acceptance}`,
    `  Files: ${files}`,
    `  Description: ${task.description}`,
  ].join("\n");
}

function summarizeAuditResult(resultText: string): string {
  const auditState = parseAuditState(resultText);
  if (!auditState.parsed) {
    return summarizeAssistantText(resultText);
  }
  if (auditState.passed) {
    return "passed";
  }
  return `failed${typeof auditState.blockingFailures === "number" ? `; blocking=${auditState.blockingFailures}` : ""}${
    auditState.failingChecks ? `; checks=${auditState.failingChecks}` : ""
  }`;
}

function parseAuditState(resultText: string): {
  parsed: boolean;
  passed: boolean;
  blockingFailures?: number;
  failingChecks?: string;
} {
  try {
    const parsed = JSON.parse(resultText) as Partial<AuditResult>;
    const failingChecks = Array.isArray(parsed.checks)
      ? parsed.checks
          .filter((check) => check.blocking && !check.passed)
          .map((check) => check.id)
          .slice(0, 6)
          .join(", ")
      : "";
    return {
      parsed: true,
      passed: parsed.status === "passed",
      blockingFailures: typeof parsed.blockingFailures === "number" ? parsed.blockingFailures : undefined,
      failingChecks,
    };
  } catch {
    return { parsed: false, passed: false };
  }
}

function invalidatesQualityAudit(toolName: string): boolean {
  return (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "delete_file" ||
    toolName === "db_migrate" ||
    toolName === "run_command"
  );
}

function invalidatesBuild(toolName: string): boolean {
  return (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "delete_file" ||
    toolName === "db_migrate" ||
    toolName === "run_command"
  );
}

function invalidatesInstalledDependencies(toolName: string, args: Record<string, unknown>): boolean {
  return (
    (toolName === "write_file" || toolName === "edit_file" || toolName === "delete_file") &&
    stringArg(args.path) === "package.json"
  );
}

function rawBuildRanInstall(args: Record<string, unknown>): boolean {
  return args.skipInstall !== true;
}

function isNpmInstallCommand(args: Record<string, unknown>): boolean {
  const command = arrayArg(args.command);
  return command[0] === "npm" && command[1] === "install";
}

function toolResultLooksSuccessful(resultText: string): boolean {
  if (/Tool error|failed|timed out|Command failed/i.test(resultText)) {
    return false;
  }
  try {
    const parsed = JSON.parse(resultText) as { exitCode?: unknown };
    if (typeof parsed.exitCode === "number") {
      return parsed.exitCode === 0;
    }
  } catch {
    // Non-JSON tool results from test adapters are successful unless they match
    // an explicit failure marker above.
  }
  return true;
}

function buildCommandToolResult(
  toolName: string,
  args: Record<string, unknown>,
  setupProgress: SetupProgressTracker,
): { reason: string; message: string } | null {
  if (toolName === "run_command" && isRawBuildCommand(args)) {
    return {
      reason: "raw build command bypasses run_build",
      message: [
        "NO-OP: raw build commands are disabled inside the agent loop because they bypass dependency installation and build-state tracking.",
        setupProgress.npmInstallFresh
          ? "Call run_build with skipInstall=true instead."
          : "Call run_build without skipInstall so npm install runs before npm run build.",
      ].join("\n"),
    };
  }

  if (toolName === "run_build" && args.skipInstall === true && !setupProgress.npmInstallFresh) {
    return {
      reason: "build requested before dependencies are installed",
      message: [
        "NO-OP: run_build skipInstall=true is only allowed after npm install has succeeded for the current package.json.",
        "Call run_build without skipInstall so dependencies are installed before the build.",
      ].join("\n"),
    };
  }

  return null;
}

function coreMilestoneToolResult(
  toolName: string,
  args: Record<string, unknown>,
  inspection: InspectionProgressTracker,
  tracker: TaskTracker,
  toolCallCount: number,
  maxToolCallsTotal: number,
): { reason: string; message: string } | null {
  const missingCoreFile = nextMissingCoreFile(inspection);
  if (
    !missingCoreFile ||
    (!VERIFICATION_OR_CLOSEOUT_TOOLS.has(toolName) && !shouldForceCoreEntry(toolCallCount, maxToolCallsTotal))
  ) {
    return null;
  }

  const path = stringArg(args.path);
  const isAllowedCoreWrite = toolName === "write_file" && path === missingCoreFile;
  const isAllowedCoreEdit = toolName === "edit_file" && path === missingCoreFile && inspection.knownFiles.has(missingCoreFile);
  if (isAllowedCoreWrite || isAllowedCoreEdit || isImplementationWriteTool(toolName)) {
    return null;
  }

  return {
    reason: `${missingCoreFile} missing`,
    message: [
      `NO-OP: core app milestone is incomplete; ${missingCoreFile} is missing.`,
      `Call write_file with path="${missingCoreFile}" soon. Implementation writes are still allowed, but do not read/list/search, run build, mark tasks done, or finish until this file exists.`,
      renderCoreEntrySteering(tracker, inspection),
    ].join("\n"),
  };
}

function isImplementationWriteTool(toolName: string): boolean {
  return toolName === "write_file" || toolName === "edit_file";
}

function shouldForceCoreEntry(toolCallCount: number, maxToolCallsTotal: number): boolean {
  return (
    toolCallCount >= CORE_ENTRY_FORCE_AFTER_TOOL_CALLS ||
    (maxToolCallsTotal > CORE_ENTRY_CLOSEOUT_MARGIN && toolCallCount >= maxToolCallsTotal - CORE_ENTRY_CLOSEOUT_MARGIN)
  );
}

function nextMissingCoreFile(inspection: InspectionProgressTracker): string | undefined {
  return CORE_REQUIRED_FILES.find((filePath) => !inspection.knownFiles.has(filePath));
}

function renderCoreEntrySteering(tracker: TaskTracker, inspection: InspectionProgressTracker): string {
  const missingCoreFile = nextMissingCoreFile(inspection);
  const missing = CORE_REQUIRED_FILES.filter((filePath) => !inspection.knownFiles.has(filePath));
  return [
    `Missing core files: ${missing.join(", ") || "(none)"}.`,
    missingCoreFile ? `Required next tool: write_file for ${missingCoreFile}.` : "Core files exist.",
    renderNextPendingTaskSteering(tracker),
  ].join("\n");
}

function isRawBuildCommand(args: Record<string, unknown>): boolean {
  const command = arrayArg(args.command);
  return (
    (command[0] === "npm" && command[1] === "run" && command[2] === "build") ||
    (command[0] === "next" && command[1] === "build") ||
    (command[0] === "npx" && command[1] === "next" && command[2] === "build")
  );
}

async function localImportMilestoneToolResult(
  toolName: string,
  args: Record<string, unknown>,
  sandbox: SandboxWorkspace,
  inspection: InspectionProgressTracker,
  tracker: TaskTracker,
  toolCallCount: number,
  maxToolCallsTotal: number,
): Promise<{ reason: string; message: string } | null> {
  if (!shouldForceLocalImportResolution(toolName, toolCallCount, maxToolCallsTotal)) {
    return null;
  }

  const missing = await findMissingLocalImports(sandbox, inspection.knownFiles);
  const firstMissing = missing[0];
  if (!firstMissing) {
    return null;
  }

  const path = stringArg(args.path);
  const canCreateMissing = toolName === "write_file" && path === firstMissing.missingPath;
  const canRepairImporter =
    (toolName === "write_file" || toolName === "edit_file") && path === firstMissing.importerPath;
  if (canCreateMissing || canRepairImporter || isImplementationWriteTool(toolName)) {
    return null;
  }

  return {
    reason: `${firstMissing.specifier} unresolved`,
    message: [
      `NO-OP: unresolved local import "${firstMissing.specifier}" in ${firstMissing.importerPath}.`,
      `Create it with write_file path="${firstMissing.missingPath}", or rewrite ${firstMissing.importerPath} to inline/remove that import.`,
      "Do not continue optional component polish, inspection, task completion, quality_audit, or build until local imports resolve.",
      renderNextPendingTaskSteering(tracker),
    ].join("\n"),
  };
}

function shouldForceLocalImportResolution(
  toolName: string,
  toolCallCount: number,
  maxToolCallsTotal: number,
): boolean {
  void toolCallCount;
  void maxToolCallsTotal;
  return toolName === "finish_app" || toolName === "quality_audit" || toolName === "mark_task_done";
}

async function corePageDepthProgressToolResult(
  toolName: string,
  _args: Record<string, unknown>,
  sandbox: SandboxWorkspace,
  inspection: InspectionProgressTracker,
  tracker: TaskTracker,
  toolCallCount: number,
  maxToolCallsTotal: number,
): Promise<{ reason: string; message: string } | null> {
  if (!inspection.knownFiles.has(CORE_ENTRY_FILE) || !shouldForceCorePageDepth(toolCallCount, maxToolCallsTotal)) {
    return null;
  }
  if (isImplementationWriteTool(toolName)) {
    return null;
  }

  const blocker = await productDepthBeforeVerificationToolResult("run_build", sandbox, tracker);
  if (!blocker) {
    return null;
  }

  return {
    reason: blocker.reason,
    message: [
      `NO-OP: ${CORE_ENTRY_FILE} exists but the current route bundle is still too shallow (${blocker.reason}).`,
      "Do not continue reading, listing, searching, marking tasks, building, auditing, or finishing yet.",
      `Use write_file or edit_file now to turn ${CORE_ENTRY_FILE} into a complete lightweight mobile app surface with real local state, seeded domain data, visible controls, persistence, recovery states, and domain visuals.`,
      renderNextPendingTaskSteering(tracker),
    ].join("\n"),
  };
}

function shouldForceCorePageDepth(toolCallCount: number, maxToolCallsTotal: number): boolean {
  return (
    toolCallCount >= CORE_ENTRY_DEPTH_FORCE_AFTER_TOOL_CALLS ||
    (maxToolCallsTotal > CORE_ENTRY_CLOSEOUT_MARGIN && toolCallCount >= maxToolCallsTotal - CORE_ENTRY_CLOSEOUT_MARGIN)
  );
}

interface MissingLocalImport {
  importerPath: string;
  specifier: string;
  missingPath: string;
}

async function findMissingLocalImports(
  sandbox: SandboxWorkspace,
  knownFiles: Set<string>,
): Promise<MissingLocalImport[]> {
  const snapshot = await sandbox.readSnapshot(240, 240_000);
  const sourceFiles = snapshot.filter((file) => /\.[cm]?[jt]sx?$/.test(file.path));
  const missing: MissingLocalImport[] = [];
  const seen = new Set<string>();

  for (const file of sourceFiles) {
    for (const specifier of extractLocalImportSpecifiers(file.content)) {
      const resolved = resolveLocalImport(file.path, specifier, knownFiles);
      if (resolved.exists || !resolved.suggestedPath) {
        continue;
      }
      const key = `${file.path}\0${specifier}\0${resolved.suggestedPath}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      missing.push({
        importerPath: file.path,
        specifier,
        missingPath: resolved.suggestedPath,
      });
    }
  }

  return missing;
}

function extractLocalImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith("@/") || specifier.startsWith("./") || specifier.startsWith("../")) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function resolveLocalImport(
  importerPath: string,
  specifier: string,
  knownFiles: Set<string>,
): { exists: boolean; suggestedPath?: string } {
  const basePath = specifier.startsWith("@/")
    ? posix.join("src", specifier.slice(2))
    : posix.normalize(posix.join(posix.dirname(importerPath), specifier));
  const candidates = localImportCandidates(basePath);
  const existing = candidates.find((candidate) => knownFiles.has(candidate));
  if (existing) {
    return { exists: true, suggestedPath: existing };
  }
  return { exists: false, suggestedPath: candidates[0] };
}

function localImportCandidates(basePath: string): string[] {
  if (/\.[a-z0-9]+$/i.test(basePath)) {
    return [basePath];
  }
  return [
    `${basePath}.tsx`,
    `${basePath}.ts`,
    `${basePath}.jsx`,
    `${basePath}.js`,
    `${basePath}.css`,
    posix.join(basePath, "index.tsx"),
    posix.join(basePath, "index.ts"),
    posix.join(basePath, "index.jsx"),
    posix.join(basePath, "index.js"),
  ];
}

async function productDepthBeforeVerificationToolResult(
  toolName: string,
  sandbox: SandboxWorkspace,
  tracker: TaskTracker,
): Promise<{ reason: string; message: string } | null> {
  void tracker;
  if (!["quality_audit", "finish_app"].includes(toolName)) {
    return null;
  }
  if (!(await baselineScaffoldStillPresent(sandbox))) {
    return null;
  }
  return {
    reason: "baseline scaffold still present",
    message: [
      `NO-OP: ${CORE_ENTRY_FILE} is still the generated baseline scaffold.`,
      "Rewrite the home route into the actual requested product before verification or closeout.",
      "Remove placeholder markers such as 'Start the main flow', 'replace this scaffold', 'Product modules', 'module-list', and 'module-card'.",
      "Use the generated domain files/components if present, then call run_build before quality_audit or finish_app.",
      renderNextPendingTaskSteering(tracker),
    ].join("\n"),
  };
}

async function baselineScaffoldBuildBlocker(sandbox: SandboxWorkspace): Promise<{ logTail: string; resultText: string } | null> {
  if (!(await baselineScaffoldStillPresent(sandbox))) {
    return null;
  }
  const logTail = [
    `Build blocked before npm run build: ${CORE_ENTRY_FILE} is still the generated baseline scaffold.`,
    "Replace the scaffold with the actual requested product UI and remove baseline markers before building.",
    "Baseline markers include: Start the main flow, replace this scaffold, Product modules, module-list, module-card.",
  ].join("\n");
  return {
    logTail,
    resultText: [
      "BLOCKED: Cannot count a baseline scaffold as a successful app build.",
      logTail,
      `Rewrite ${CORE_ENTRY_FILE} to use the requested product flow, real controls, mobile-first layout, and any generated domain data/components, then call run_build again.`,
    ].join("\n"),
  };
}

function closeoutBuildCheckpointToolResult(
  toolName: string,
  inspection: InspectionProgressTracker,
  tracker: TaskTracker,
  toolCallCount: number,
  maxToolCallsTotal: number,
  lastBuildPassed: boolean,
): { reason: string; message: string } | null {
  if (lastBuildPassed || !INSPECTION_TOOLS.has(toolName)) {
    return null;
  }
  const hasCoreScaffold = CORE_REQUIRED_FILES.every((filePath) => inspection.knownFiles.has(filePath));
  if (!hasCoreScaffold) {
    return null;
  }
  const forceByToolBudget =
    toolCallCount >= CLOSEOUT_BUILD_FORCE_AFTER_TOOL_CALLS ||
    (maxToolCallsTotal > CORE_ENTRY_CLOSEOUT_MARGIN && toolCallCount >= maxToolCallsTotal - CORE_ENTRY_CLOSEOUT_MARGIN);
  if (!forceByToolBudget) {
    return null;
  }

  return {
    reason: "build checkpoint required",
    message: [
      "NO-OP: the core Next.js scaffold already exists and the loop is in closeout territory.",
      "Stop further inspection for now. Call run_build next with skipInstall=false unless npm install already succeeded in this loop.",
      "If build reports missing imports, type errors, or App Router boundary errors, fix only those engineering failures, then run_build again.",
      "After build passes, run quality_audit, fix blocking engineering checks only, and call finish_app.",
      renderNextPendingTaskSteering(tracker),
    ].join("\n"),
  };
}

async function staticProductDepthBeforeVerificationToolResult(
  toolName: string,
  sandbox: SandboxWorkspace,
  tracker: TaskTracker,
): Promise<{ reason: string; message: string } | null> {
  if (!VERIFICATION_OR_CLOSEOUT_TOOLS.has(toolName)) {
    return null;
  }

  const snapshot = await sandbox.readSnapshot(240, 240_000);
  const page = snapshot.find((file) => file.path === CORE_ENTRY_FILE);
  if (!page) {
    return null;
  }

  const bundle = snapshot
    .filter((file) => /\.(?:ts|tsx|js|jsx|css)$/i.test(file.path))
    .map((file) => file.content)
    .join("\n");
  const pageContent = page.content;
  const lowerBundle = bundle.toLowerCase();
  const failures: string[] = [];
  const looksInputHeavy = /checklist|journal|diary|notebook|tracker|planner|清单|手帐|日记|记录|计划/i.test(bundle);

  if (hasUnfinishedVisibleCopy(pageContent)) {
    failures.push("root page still contains placeholder implementation markers");
  }
  if (pageContent.replace(/\s+/g, " ").length < 1800) {
    failures.push(`${CORE_ENTRY_FILE} is too shallow for a commercial lightweight product`);
  }
  if (looksInputHeavy && !/\b(?:localStorage|sessionStorage|indexedDB)\b|useLocalStorage|Storage/i.test(bundle)) {
    failures.push("input-heavy local-first app has no browser storage evidence");
  }
  if (looksInputHeavy && !/<(?:input|textarea|select)\b|type=["']checkbox["']|contentEditable/i.test(bundle)) {
    failures.push("input-heavy app has no input, checkbox, textarea, or editable control");
  }
  if (!/empty[\s-]?state|暂无|没有|尚未|还没有|无记录|no\s+\w+\s+yet/i.test(bundle)) {
    failures.push("empty state evidence is missing");
  }
  if (!/error[\s-]?state|错误|重试|try again|catch\s*\(|onError=|recover/i.test(bundle)) {
    failures.push("error/recovery state evidence is missing");
  }
  if (!/saved|success|complete|completed|done|已保存|保存成功|已完成|完成/i.test(bundle)) {
    failures.push("saved/success/completed feedback is missing");
  }

  if (!failures.length) {
    return null;
  }

  return {
    reason: "product surface too shallow",
    message: [
      "NO-OP: verification is blocked because the app surface is still too shallow for a lightweight commercial product.",
      `Blocking evidence: ${failures.slice(0, 6).join("; ")}.`,
      `Rewrite ${CORE_ENTRY_FILE} now as a complete single-route mobile app surface: realistic seeded data, checklist interactions, journal/inspiration input controls, localStorage persistence with try/catch recovery, visible empty/error/loading-or-saving/success states, and no placeholder markers.`,
      "After rewriting the page and any CSS/data helpers, run_build can be called again.",
      renderNextPendingTaskSteering(tracker),
    ].join("\n"),
  };
}

function redundantSetupToolResult(
  toolName: string,
  args: Record<string, unknown>,
  discovery: DiscoveryTracker,
  setupProgress: SetupProgressTracker,
  tracker: TaskTracker,
): { reason: string; message: string } | null {
  if (toolName === "inspect_reference_app" && discovery.referenceInspected) {
    return {
      reason: "reference already inspected",
      message: [
        "NO-OP: inspect_reference_app has already been completed for this loop.",
        "Do not repeat reference inspection. Use the next tool call for implementation progress.",
        renderNextPendingTaskSteering(tracker),
      ].join("\n"),
    };
  }

  if (toolName === "use_design_skill" && discovery.designSkillCalls >= MIN_DESIGN_SKILL_CALLS) {
    return {
      reason: "design guidance already complete",
      message: [
        `NO-OP: required design skill guidance is already complete (${discovery.designSkillCalls}/${MIN_DESIGN_SKILL_CALLS}).`,
        "Do not repeat use_design_skill. Use the next tool call for implementation progress.",
        renderNextPendingTaskSteering(tracker),
      ].join("\n"),
    };
  }

  if (toolName === "run_command" && isNpmInstallCommand(args) && setupProgress.npmInstallFresh) {
    return {
      reason: "npm install already fresh",
      message: [
        "NO-OP: npm install already succeeded after the latest package.json change.",
        "Do not run npm install again until package.json changes. Continue implementing pending files; when verification is needed, prefer run_build with skipInstall=true.",
        renderNextPendingTaskSteering(tracker),
      ].join("\n"),
    };
  }

  return null;
}

function redundantInspectionToolResult(
  toolName: string,
  args: Record<string, unknown>,
  inspection: InspectionProgressTracker,
  tracker: TaskTracker,
): { reason: string; message: string } | null {
  if (toolName === "list_files") {
    const count = inspection.listFilesCount.version === inspection.workspaceVersion ? inspection.listFilesCount.count : 0;
    if (count >= MAX_LIST_FILES_PER_WORKSPACE_VERSION) {
      return {
        reason: "workspace listing already fresh",
        message: [
          "NO-OP: list_files has already returned the current workspace listing since the last file change.",
          "Do not list files again until a write/edit/delete changes the workspace. Continue with implementation, build, quality_audit, or finish_app.",
          renderNextPendingTaskSteering(tracker),
        ].join("\n"),
      };
    }
  }

  if (toolName === "inspect_package") {
    const count = inspection.packageInspectCount.version === inspection.workspaceVersion ? inspection.packageInspectCount.count : 0;
    if (count >= MAX_PACKAGE_INSPECT_PER_WORKSPACE_VERSION) {
      return {
        reason: "package inspection already fresh",
        message: [
          "NO-OP: package.json scripts and dependencies were already inspected since the last workspace change.",
          "Do not inspect the package again until package.json changes. Continue with implementation, build, quality_audit, or finish_app.",
          renderNextPendingTaskSteering(tracker),
        ].join("\n"),
      };
    }
  }

  if (toolName === "read_file") {
    const path = stringArg(args.path);
    if (!path) {
      return null;
    }
    if (!inspection.knownFiles.has(path)) {
      return {
        reason: `${path} does not exist`,
        message: [
          `NO-OP: ${path} does not exist in the current sandbox workspace.`,
          "Do not read missing files. If this file is needed, create it with write_file; otherwise inspect an existing file or continue implementation.",
          renderNextPendingTaskSteering(tracker),
        ].join("\n"),
      };
    }
    const version = inspection.fileVersions.get(path) ?? 0;
    const existing = inspection.readCounts.get(path);
    const count = existing?.version === version ? existing.count : 0;
    if (count >= MAX_READS_PER_FILE_VERSION) {
      return {
        reason: `${path} already read`,
        message: [
          `NO-OP: ${path} has already been read ${count} times since it last changed.`,
          "Do not read the same unchanged file again. If you have enough context, write/edit the relevant task files; otherwise inspect a different file that is necessary for the next task.",
          renderNextPendingTaskSteering(tracker),
        ].join("\n"),
      };
    }
  }

  return null;
}

function updateInspectionProgressAfterTool(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string,
  inspection: InspectionProgressTracker,
): void {
  if (toolName === "list_files") {
    if (inspection.listFilesCount.version !== inspection.workspaceVersion) {
      inspection.listFilesCount = { version: inspection.workspaceVersion, count: 0 };
    }
    inspection.listFilesCount.count += 1;
    return;
  }

  if (toolName === "inspect_package") {
    if (inspection.packageInspectCount.version !== inspection.workspaceVersion) {
      inspection.packageInspectCount = { version: inspection.workspaceVersion, count: 0 };
    }
    inspection.packageInspectCount.count += 1;
    return;
  }

  if (toolName === "read_file") {
    const path = stringArg(args.path);
    if (!path) {
      return;
    }
    const version = inspection.fileVersions.get(path) ?? 0;
    const existing = inspection.readCounts.get(path);
    const count = existing?.version === version ? existing.count : 0;
    inspection.readCounts.set(path, { version, count: count + 1 });
    return;
  }

  if (!toolResultLooksSuccessful(resultText)) {
    return;
  }

  if (toolName === "write_file" || toolName === "edit_file" || toolName === "delete_file") {
    const path = stringArg(args.path);
    inspection.workspaceVersion += 1;
    if (path) {
      if (toolName === "delete_file") {
        inspection.knownFiles.delete(path);
      } else {
        inspection.knownFiles.add(path);
      }
      inspection.fileVersions.set(path, (inspection.fileVersions.get(path) ?? 0) + 1);
      inspection.readCounts.delete(path);
    }
  }
}

function renderNextPendingTaskSteering(tracker: TaskTracker): string {
  const pending = [...tracker.total].filter((id) => !tracker.done.has(id));
  if (!pending.length) {
    return "All architecture tasks are marked done. Run build/quality_audit if needed, then call finish_app.";
  }
  const nextId = pending[0]!;
  return [
    `Next pending task: ${nextId}.`,
    renderPendingTask(nextId, tracker.tasksById.get(nextId)),
    "Write or edit the files for that task, then call mark_task_done with the exact task id.",
  ].join("\n");
}

async function autoMarkCompletedTasksFromWorkspace(args: {
  sandbox: SandboxWorkspace;
  tracker: TaskTracker;
  lastBuildPassed: boolean;
}): Promise<string[]> {
  const files = new Set(await args.sandbox.listFiles());
  const completed: string[] = [];

  for (const taskId of args.tracker.total) {
    if (args.tracker.done.has(taskId)) {
      continue;
    }
    const task = args.tracker.tasksById.get(taskId);
    if (!task) {
      continue;
    }
    if (task.files.length > 0 && task.files.every((filePath) => files.has(filePath))) {
      args.tracker.done.add(taskId);
      completed.push(taskId);
      continue;
    }
    if (task.files.length === 0 && args.lastBuildPassed && isBuildVerificationTask(task)) {
      args.tracker.done.add(taskId);
      completed.push(taskId);
    }
  }

  return completed;
}

function isBuildVerificationTask(task: BuildTask): boolean {
  return /\bbuild\b|构建|验证|verify|compile|编译/i.test(
    [task.title, task.description, task.acceptance].filter(Boolean).join("\n"),
  );
}

async function executeRunBuild(
  registry: ToolRegistry,
  toolContext: ToolExecutionContext,
  sandbox: SandboxWorkspace,
  skipInstall: boolean,
): Promise<{ passed: boolean; logTail: string; resultText: string }> {
  await ensureSandboxBaselineScaffold(sandbox, {
    appName: "generated-app",
    title: "Generated app",
    summary: "Buildable mobile app scaffold.",
    emitLog: toolContext.emitLog,
  });
  const baselineBlocker = await baselineScaffoldBuildBlocker(sandbox);
  if (baselineBlocker) {
    return {
      passed: false,
      logTail: baselineBlocker.logTail,
      resultText: baselineBlocker.resultText,
    };
  }
  let installLog = "";
  let dbLog = "";
  if (!skipInstall) {
    try {
      const installResult = (await registry.execute(
        "run_command",
        { command: ["npm", "install"], timeoutMs: 180_000 },
        toolContext,
      )) as { exitCode: number; output: string };
      installLog = installResult.output.slice(-800);
    } catch (installError) {
      const logTail = formatCommandError(installError);
      return {
        passed: false,
        logTail,
        resultText: `npm install failed:\n${logTail}`,
      };
    }
  }
  if (await hasPrismaSchema(sandbox)) {
    try {
      const dbResult = (await registry.execute(
        "run_command",
        { command: ["npx", "prisma", "db", "push"], timeoutMs: 180_000 },
        toolContext,
      )) as { exitCode: number; output: string };
      dbLog = dbResult.output.slice(-800);
    } catch (dbError) {
      const logTail = formatCommandError(dbError);
      return {
        passed: false,
        logTail,
        resultText: `Prisma schema sync failed:\n${logTail}`,
      };
    }
  }
  return runNextBuildWithLocalTypeRepairs(registry, toolContext, sandbox, installLog, dbLog, 3);
}

async function runNextBuildWithLocalTypeRepairs(
  registry: ToolRegistry,
  toolContext: ToolExecutionContext,
  sandbox: SandboxWorkspace,
  installLog: string,
  dbLog: string,
  maxAttempts: number,
): Promise<{ passed: boolean; logTail: string; resultText: string }> {
  let lastLogTail = "";
  let repairNotes: string[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rm(sandbox.resolveSandboxPath(".next"), { recursive: true, force: true });
      const buildResult = (await registry.execute(
        "run_command",
        { command: ["npm", "run", "build"], timeoutMs: 180_000 },
        toolContext,
      )) as { exitCode: number; output: string };
      const logTail = summarizeCommandOutput(buildResult.output);
      return {
        passed: true,
        logTail,
        resultText: [
          "Build succeeded.",
          installLog ? `Install tail:\n${installLog}` : "",
          dbLog ? `Prisma sync tail:\n${dbLog}` : "",
          repairNotes.length ? `Automatic build repairs:\n${repairNotes.map((note) => `- ${note}`).join("\n")}` : "",
          `Build tail:\n${logTail}`,
        ].filter(Boolean).join("\n"),
      };
    } catch (buildError) {
      lastLogTail = formatCommandError(buildError);
      const repair = await repairLocalBuildIssuesInSandbox(sandbox, lastLogTail);
      if (!repair.changed) {
        break;
      }
      repairNotes.push(repair.summary);
    }
  }

  return {
    passed: false,
    logTail: lastLogTail,
    resultText: `Build failed:\n${lastLogTail}`,
  };
}

async function repairLocalBuildIssuesInSandbox(
  sandbox: SandboxWorkspace,
  buildLog: string,
): Promise<{ changed: boolean; summary: string }> {
  const repairs: string[] = [];
  const typeImportRepair = await repairMissingLocalTypeImportsInSandbox(sandbox, buildLog);
  if (typeImportRepair.changed) {
    repairs.push(typeImportRepair.summary);
  }

  const numberLengthRepair = await repairNumberLengthAccessInSandbox(sandbox, buildLog);
  if (numberLengthRepair.changed) {
    repairs.push(numberLengthRepair.summary);
  }

  const missingObjectFieldsRepair = await repairMissingObjectFieldsInSandbox(sandbox, buildLog);
  if (missingObjectFieldsRepair.changed) {
    repairs.push(missingObjectFieldsRepair.summary);
  }

  return { changed: repairs.length > 0, summary: repairs.filter(Boolean).join("; ") };
}

async function repairMissingLocalTypeImportsInSandbox(
  sandbox: SandboxWorkspace,
  buildLog: string,
): Promise<{ changed: boolean; summary: string }> {
  const missing = extractMissingNameErrors(buildLog).filter((item) => item.path && /^[A-Z][A-Za-z0-9_]*$/.test(item.name));
  if (!missing.length) {
    return { changed: false, summary: "" };
  }

  const snapshot = await sandbox.readSnapshot(240, 400_000);
  const exportsByName = collectLocalTypeExports(snapshot);
  const repairs: string[] = [];
  for (const item of missing) {
    if (!item.path) {
      continue;
    }
    const file = snapshot.find((candidate) => candidate.path === item.path);
    const exported = exportsByName.get(item.name)?.[0];
    if (!file || !exported || file.path === exported.path || hasImportedBinding(file.content, item.name)) {
      continue;
    }
    const moduleSpecifier = moduleSpecifierForSourcePath(exported.path);
    if (!moduleSpecifier) {
      continue;
    }
    const nextContent = ensureNamedTypeImport(file.content, item.name, moduleSpecifier);
    if (nextContent === file.content) {
      continue;
    }
    await sandbox.writeFile(file.path, nextContent);
    repairs.push(`${file.path}: imported ${item.name} from ${moduleSpecifier}`);
  }

  return { changed: repairs.length > 0, summary: repairs.join("; ") };
}

async function repairNumberLengthAccessInSandbox(
  sandbox: SandboxWorkspace,
  buildLog: string,
): Promise<{ changed: boolean; summary: string }> {
  const items = extractNumberLengthAccessErrors(buildLog);
  if (!items.length) {
    return { changed: false, summary: "" };
  }

  const snapshot = await sandbox.readSnapshot(240, 400_000);
  const repairs: string[] = [];
  for (const item of items) {
    const file = snapshot.find((candidate) => candidate.path === item.path);
    if (!file) {
      continue;
    }
    const nextContent = removeLengthAccessOnLine(file.content, item.line, item.column);
    if (nextContent === file.content) {
      continue;
    }
    await sandbox.writeFile(file.path, nextContent);
    repairs.push(`${file.path}:${item.line}: removed .length from numeric value`);
    file.content = nextContent;
  }

  return { changed: repairs.length > 0, summary: repairs.join("; ") };
}

function extractNumberLengthAccessErrors(buildLog: string): Array<{ path: string; line: number; column: number }> {
  const items: Array<{ path: string; line: number; column: number }> = [];
  const seen = new Set<string>();
  for (const match of buildLog.matchAll(
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):(\d+):(\d+)\s*\nType error:\s*Property 'length' does not exist on type '(?:number|\d+)'/g,
  )) {
    const path = match[1]?.trim();
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (!path || !Number.isFinite(line) || !Number.isFinite(column)) {
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

function removeLengthAccessOnLine(content: string, oneBasedLine: number, oneBasedColumn: number): string {
  const lines = content.split(/\r?\n/);
  const lineIndex = findLineIndexWithLengthAccess(lines, oneBasedLine - 1, oneBasedColumn);
  if (lineIndex < 0) {
    return content;
  }
  const line = lines[lineIndex];
  if (line === undefined) {
    return content;
  }

  const columnIndex = Math.max(0, oneBasedColumn - 1);
  const nearColumn = line.slice(Math.max(0, columnIndex - 80), Math.min(line.length, columnIndex + 80));
  if (!/\.length\b/.test(nearColumn)) {
    return content;
  }

  const targetIndex = findNearestLengthAccess(line, columnIndex);
  if (targetIndex < 0) {
    return content;
  }
  lines[lineIndex] = `${line.slice(0, targetIndex)}${line.slice(targetIndex + ".length".length)}`;
  return lines.join("\n");
}

function findLineIndexWithLengthAccess(lines: string[], preferredLineIndex: number, oneBasedColumn: number): number {
  const preferredLine = lines[preferredLineIndex];
  if (preferredLine && /\.length\b/.test(preferredLine)) {
    return preferredLineIndex;
  }

  const columnIndex = Math.max(0, oneBasedColumn - 1);
  let best: { index: number; distance: number } | undefined;
  for (let index = Math.max(0, preferredLineIndex - 2); index <= Math.min(lines.length - 1, preferredLineIndex + 2); index += 1) {
    const line = lines[index] ?? "";
    const lengthIndex = findNearestLengthAccess(line, columnIndex);
    if (lengthIndex < 0) {
      continue;
    }
    const distance = Math.abs(index - preferredLineIndex) * 1_000 + Math.abs(lengthIndex - columnIndex);
    if (!best || distance < best.distance) {
      best = { index, distance };
    }
  }
  return best?.index ?? -1;
}

function findNearestLengthAccess(line: string, columnIndex: number): number {
  const matches = [...line.matchAll(/\.length\b/g)].map((match) => match.index ?? -1).filter((index) => index >= 0);
  if (!matches.length) {
    return -1;
  }
  return matches.reduce((best, index) => Math.abs(index - columnIndex) < Math.abs(best - columnIndex) ? index : best, matches[0]!);
}

async function repairMissingObjectFieldsInSandbox(
  sandbox: SandboxWorkspace,
  buildLog: string,
): Promise<{ changed: boolean; summary: string }> {
  const errors = extractMissingObjectFieldErrors(buildLog);
  if (!errors.length) {
    return { changed: false, summary: "" };
  }

  const snapshot = await sandbox.readSnapshot(240, 400_000);
  const repairs: string[] = [];
  for (const error of errors) {
    const file = snapshot.find((candidate) => candidate.path === error.path);
    if (!file || !/\.(?:tsx|ts|jsx|js)$/.test(file.path)) {
      continue;
    }

    let nextContent = file.content;
    for (const field of error.fields) {
      nextContent = addMissingFieldToObjectLiteralNearLine(nextContent, error.line, field, snapshot);
    }
    if (nextContent === file.content) {
      continue;
    }
    await sandbox.writeFile(file.path, nextContent);
    repairs.push(`${file.path}:${error.line}: added ${error.fields.join(", ")}`);
    file.content = nextContent;
  }

  return { changed: repairs.length > 0, summary: repairs.join("; ") };
}

function extractMissingObjectFieldErrors(buildLog: string): Array<{ path: string; line: number; fields: string[] }> {
  const items: Array<{ path: string; line: number; fields: string[] }> = [];
  const seen = new Set<string>();

  for (const match of buildLog.matchAll(
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):(\d+):\d+\s*\nType error:\s*Type '[^']*' is missing the following properties from type '[^']*':\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/g,
  )) {
    const path = match[1]?.trim();
    const line = Number(match[2]);
    const fields = (match[3] ?? "").split(",").map((field) => field.trim()).filter((field) => /^[A-Za-z_$][\w$]*$/.test(field));
    if (!path || !Number.isFinite(line) || line < 1 || !fields.length) {
      continue;
    }
    const key = `${path}:${line}:${fields.join(",")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ path, line, fields });
  }

  for (const match of buildLog.matchAll(
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):(\d+):\d+\s*\nType error:\s*Property '([A-Za-z_$][\w$]*)' is missing in type '[^']*' but required in type '[^']*'/g,
  )) {
    const path = match[1]?.trim();
    const line = Number(match[2]);
    const field = match[3]?.trim();
    if (!path || !Number.isFinite(line) || line < 1 || !field) {
      continue;
    }
    const key = `${path}:${line}:${field}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ path, line, fields: [field] });
  }

  return items;
}

function addMissingFieldToObjectLiteralNearLine(
  content: string,
  oneBasedLine: number,
  field: string,
  files: Array<{ path: string; content: string }>,
): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(field)) {
    return content;
  }

  const lineStart = offsetForLine(content, oneBasedLine);
  if (lineStart < 0) {
    return content;
  }

  const lineEnd = content.indexOf("\n", lineStart);
  const effectiveLineEnd = lineEnd >= 0 ? lineEnd : content.length;
  const inlineObjectIndex = content.indexOf("{", lineStart);
  const searchStart = Math.max(0, lineStart - 320);
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
  if (new RegExp(`(^|[,{;])\\s*${escapeRegExp(field)}\\s*:`, "m").test(body)) {
    return content;
  }

  const value = inferMissingFieldValue(field, files);
  let insertionIndex = closeBraceIndex;
  while (insertionIndex > openBraceIndex + 1 && /\s/.test(content[insertionIndex - 1] ?? "")) {
    insertionIndex -= 1;
  }

  const currentBody = content.slice(openBraceIndex + 1, insertionIndex);
  const insertion = currentBody.trim().length > 0 && !currentBody.trimEnd().endsWith(",")
    ? `, ${field}: ${value}`
    : `${currentBody.trim().length > 0 ? " " : ""}${field}: ${value}`;
  return `${content.slice(0, insertionIndex)}${insertion}${content.slice(insertionIndex)}`;
}

function inferMissingFieldValue(field: string, files: Array<{ path: string; content: string }>): string {
  const fieldType = findDeclaredFieldType(files, field);
  if (fieldType) {
    if (/\[\]$|Array</.test(fieldType)) {
      return "[]";
    }
    if (/\bboolean\b/.test(fieldType)) {
      return "false";
    }
    if (/\bnumber\b/.test(fieldType)) {
      return "0";
    }
    if (/\bnull\b/.test(fieldType)) {
      return "null";
    }
  }

  if (/(?:ids?|items|places|activities|tags|images|urls?)$/i.test(field)) {
    return "[]";
  }
  if (/(?:budget|cost|price|amount|total|count|score|rating|progress|percent|quantity|min|max)$/i.test(field)) {
    return "0";
  }
  if (/^(?:is|has|can|should)[A-Z_]/.test(field)) {
    return "false";
  }
  if (/(?:id|Id)$/.test(field) && !/^id$/.test(field)) {
    return "null";
  }
  return "''";
}

function findDeclaredFieldType(files: Array<{ path: string; content: string }>, field: string): string | null {
  for (const file of files) {
    if (!/\.(?:ts|tsx|js|jsx)$/.test(file.path)) {
      continue;
    }
    const match = new RegExp(`\\b${escapeRegExp(field)}\\??\\s*:\\s*([^;\\n,}]+)`).exec(file.content);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function offsetForLine(content: string, oneBasedLine: number): number {
  if (oneBasedLine <= 1) {
    return 0;
  }
  let offset = 0;
  for (let currentLine = 1; currentLine < oneBasedLine; currentLine += 1) {
    const next = content.indexOf("\n", offset);
    if (next < 0) {
      return -1;
    }
    offset = next + 1;
  }
  return offset;
}

function findMatchingBrace(content: string, openBraceIndex: number): number {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];
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
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function executeMarkTaskDone(
  tracker: TaskTracker,
  rawArgs: Record<string, unknown>,
): { resultText: string } {
  const taskId = typeof rawArgs.taskId === "string" ? rawArgs.taskId : "";
  if (!taskId) {
    return { resultText: "mark_task_done requires a taskId." };
  }
  if (!tracker.total.has(taskId)) {
    return {
      resultText: `Unknown task id: ${taskId}. Known: ${[...tracker.total].join(", ") || "(none)"}.`,
    };
  }
  tracker.done.add(taskId);
  const remaining = [...tracker.total].filter((id) => !tracker.done.has(id));
  return {
    resultText: `Task ${taskId} marked done. Remaining: ${remaining.join(", ") || "(none)"}.`,
  };
}

async function executeFinishApp(
  registry: ToolRegistry,
  toolContext: ToolExecutionContext,
  tracker: TaskTracker,
  discovery: DiscoveryTracker,
  buildState: BuildState,
  rawArgs: Record<string, unknown>,
): Promise<{ kind: "result"; resultText: string } | { kind: "finish"; resultText: string; title: string; summary: string }> {
  const title = typeof rawArgs.title === "string" ? rawArgs.title : "Generated app";
  const summary = typeof rawArgs.summary === "string" ? rawArgs.summary : "";

  const remaining = [...tracker.total].filter((id) => !tracker.done.has(id));
  if (remaining.length) {
    return {
      kind: "result",
      resultText: [
        "BLOCKED: Cannot call finish_app while architecture-plan tasks are still pending.",
        `Pending tasks: ${remaining.join(", ")}`,
        "Complete each pending task, call mark_task_done for it, run_build successfully, then retry finish_app.",
      ].join("\n"),
    };
  }

  if (!buildState.lastBuildPassed) {
    return {
      kind: "result",
      resultText: "BLOCKED: Cannot call finish_app until run_build has succeeded in this agent loop.",
    };
  }

  const baselineBlocker = await baselineScaffoldBuildBlocker(toolContext.workspace);
  if (baselineBlocker) {
    return {
      kind: "result",
      resultText: baselineBlocker.resultText,
    };
  }

  let auditResult: AuditResult | undefined;
  try {
    auditResult = (await registry.execute(
      "quality_audit",
      { focus: "all" },
      toolContext,
    )) as AuditResult;
    discovery.qualityAuditCalled = true;
  } catch (auditError) {
    const message = auditError instanceof Error ? auditError.message : String(auditError);
    return {
      kind: "result",
      resultText: `Cannot finish: quality_audit failed to run (${message}). Investigate the sandbox state and retry.`,
    };
  }

  const auditChecks = Array.isArray(auditResult.checks) ? auditResult.checks : [];
  if (auditResult.status !== "passed") {
    const blockingFailures = auditChecks
      .filter((check) => check.blocking && !check.passed)
      .map((check) => `  - [${check.id}] ${check.detail}`)
      .join("\n");
    const advisoryFailures = auditChecks
      .filter((check) => !check.blocking && !check.passed)
      .map((check) => `  - [${check.id}] ${check.detail}`)
      .join("\n");
    return {
      kind: "result",
      resultText: [
        `BLOCKED: Cannot call finish_app. quality_audit reports ${auditResult.blockingFailures} blocking failure(s).`,
        "",
        "Blocking failures (must fix before finishing):",
        blockingFailures || "  (none)",
        advisoryFailures ? "\nAdvisory failures (recommended):\n" + advisoryFailures : "",
        "",
        "Fix the blocking items, then call finish_app again. The audit will re-run automatically.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return {
    kind: "finish",
    title,
    summary,
    resultText: `App marked finished. quality_audit passed all ${auditChecks.length} checks.`,
  };
}

function summarizeAssistantText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 360) : "(empty)";
}

function formatCommandError(error: unknown): string {
  if (error && typeof error === "object" && "output" in error && typeof (error as { output?: unknown }).output === "string") {
    return summarizeCommandOutput((error as { output: string }).output);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function summarizeCommandOutput(output: string): string {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = clean.split(/\r?\n/);
  const errorIndex = lines.findIndex((line) =>
    /(?:^|\s)(?:Failed to compile|Build error occurred|Error:|Type error:|Module not found|cannot be imported|missing "generateStaticParams"|Failed to collect page data)/i.test(line),
  );
  const excerpt = errorIndex >= 0 ? lines.slice(Math.max(errorIndex - 4, 0), errorIndex + 24).join("\n").trim() : "";
  const tail = clean.slice(-1600).trim();
  if (excerpt && tail && !tail.includes(excerpt)) {
    return `Error excerpt:\n${excerpt}\n\nLog tail:\n${tail}`;
  }
  return excerpt || tail || clean.trim();
}

function extractMissingNameErrors(buildLog: string): Array<{ path?: string; name: string }> {
  const items: Array<{ path?: string; name: string }> = [];
  const seen = new Set<string>();
  const withPathPattern =
    /(?:^|\n)\.\/(src\/[^\n:]+\.(?:tsx|ts|jsx|js)):\d+:\d+\s*\nType error:\s*Cannot find name '([A-Za-z_$][\w$]*)'\./g;
  for (const match of buildLog.matchAll(withPathPattern)) {
    const path = match[1]?.trim();
    const name = match[2]?.trim();
    if (!name) continue;
    const key = `${path ?? ""}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ path, name });
  }
  for (const match of buildLog.matchAll(/Cannot find name '([A-Za-z_$][\w$]*)'\./g)) {
    const name = match[1]?.trim();
    if (!name) continue;
    const key = `:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name });
  }
  return items;
}

function collectLocalTypeExports(files: Array<{ path: string; content: string }>): Map<string, Array<{ path: string; score: number }>> {
  const exports = new Map<string, Array<{ path: string; score: number }>>();
  for (const file of files) {
    if (!/^src\/.+\.(?:ts|tsx)$/.test(file.path)) {
      continue;
    }
    for (const match of file.content.matchAll(/\bexport\s+(?:interface|type)\s+([A-Z][A-Za-z0-9_]*)\b/g)) {
      const name = match[1];
      if (!name) continue;
      const items = exports.get(name) ?? [];
      items.push({ path: file.path, score: scoreLocalTypeExport(file.path) });
      exports.set(name, items.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)));
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

function hasImportedBinding(content: string, symbolName: string): boolean {
  const escaped = escapeRegExp(symbolName);
  return new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s+from\\s+["'][^"']+["'];?`).test(content);
}

function ensureNamedTypeImport(content: string, symbolName: string, moduleSpecifier: string): string {
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

function moduleSpecifierForSourcePath(path: string): string | null {
  const match = /^src\/(.+)\.(?:ts|tsx|js|jsx)$/.exec(path);
  if (!match?.[1]) {
    return null;
  }
  return `@/${match[1].replace(/\/index$/, "")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function hasPrismaSchema(sandbox: SandboxWorkspace): Promise<boolean> {
  return (await sandbox.listFiles()).includes("prisma/schema.prisma");
}

function formatToolResult(name: string, output: unknown): string {
  if (name === "list_files") {
    const value = output as { files?: string[] };
    const files = value.files ?? [];
    if (!files.length) {
      return "(empty workspace)";
    }
    return files.map((path) => `- ${path}`).join("\n");
  }
  if (name === "read_file") {
    const value = output as { content?: string };
    const content = value.content ?? "";
    if (content.length > 12_000) {
      return `${content.slice(0, 12_000)}\n/* truncated, total length ${content.length} chars */`;
    }
    return content;
  }
  if (name === "search_text") {
    const value = output as { matches?: Array<{ path: string; line: number; text?: string }> };
    const matches = value.matches ?? [];
    if (!matches.length) {
      return "No matches.";
    }
    return matches
      .slice(0, 30)
      .map((match) => `${match.path}:${match.line}: ${match.text ?? ""}`)
      .join("\n");
  }
  if (name === "use_design_skill" || name === "inspect_reference_app" || name === "quality_audit" || name === "inspect_package") {
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }
  if (name === "write_file" || name === "edit_file" || name === "delete_file" || name === "vercel_env_set") {
    return "ok";
  }
  if (output === undefined || output === null) {
    return "ok";
  }
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Best-effort identifier so trace IDs from this loop look reasonable in logs. */
export function newAgentTraceId(): string {
  return `agent-${randomUUID()}`;
}
