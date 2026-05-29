import { randomUUID } from "node:crypto";

import type { ArchitecturePlan, ToolCallTrace } from "@vide/contracts";

import type { ModelClient, LLMMessage, LLMToolDescriptor, LLMToolCallRequest } from "./model-client.js";
import type { SandboxWorkspace } from "./sandbox.js";
import type { ToolExecutionContext, ToolRegistry } from "./tools.js";

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
  /** Total tool calls executed across all turns. */
  toolCallCount: number;
  /** True when the loop stopped because a model tool-use turn timed out. */
  modelTimedOut: boolean;
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
  options: AgentLoopOptions;
}

const DEFAULT_TOOLS: LLMToolDescriptor[] = [
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
      "Run a static generated-app quality audit over the sandbox for product modules, backend closure, persistence, interactions, and visible implementation leaks.",
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
  return DEFAULT_TOOLS.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
}

export function getAgentLoopTools(): LLMToolDescriptor[] {
  return DEFAULT_TOOLS;
}

export function getAgentToolCatalogText(): string {
  return renderToolCatalog();
}

interface TaskTracker {
  total: Set<string>;
  done: Set<string>;
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

const MIN_DESIGN_SKILL_CALLS = 2;
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
      `use_design_skill (need ${MIN_DESIGN_SKILL_CALLS - tracker.designSkillCalls} more — try frontend-design, mobile-app-shell, fullstack-product, ai-assisted-flow)`,
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

async function readWorkspaceFiles(sandbox: SandboxWorkspace): Promise<Array<{ path: string; content: string }>> {
  const snapshot = await sandbox.readSnapshot(200, 200_000);
  return snapshot.map((file) => ({ path: file.path, content: file.content }));
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
    };

    const discovery: DiscoveryTracker = {
      referenceInspected: false,
      designSkillCalls: 0,
      qualityAuditCalled: false,
      discoveryNudges: 0,
    };

    const toolContext: ToolExecutionContext = {
      runId: input.runId,
      workspace: sandbox,
      emitTrace,
      emitLog,
    };

    const messages: LLMMessage[] = [
      { role: "system", content: input.systemPrompt },
      {
        role: "user",
        content: [
          input.initialUserMessage,
          input.repairContext ? `\n\nRepair context:\n${input.repairContext}` : "",
          "\n\nDISCOVERY PHASE (REQUIRED FIRST):",
          "  1. Call inspect_reference_app once with the closest match to this product " +
            "(bloom-planner / my-season / brain-spin / compact-consumer-app).",
          "  2. Call use_design_skill at least twice — start with frontend-design and mobile-app-shell. " +
            "Add fullstack-product or ai-assisted-flow if relevant.",
          "  3. Only after the above are done, begin executing tasks with list_files + write_file.",
          "",
          "FINISH GATE:",
          "  - finish_app is BLOCKED until quality_audit returns status=passed. " +
            "Run quality_audit, fix every blocking failure, then finish.",
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
    let toolCallCount = 0;
    let consecutiveEmpty = 0;
    let modelTimedOut = false;

    for (let turn = 0; turn < options.maxTurns && !finished; turn++) {
      options.onProgress?.(`turn ${turn + 1}/${options.maxTurns}`);

      let response;
      try {
        emitLog(`Agent loop: requesting tool calls for turn ${turn + 1}/${options.maxTurns}.`);
        response = await model.chatWithTools({
          role: "coder",
          messages,
          tools: DEFAULT_TOOLS,
          forceToolUse: !finished,
          timeoutMs: modelTurnTimeoutMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out/i.test(message)) {
          modelTimedOut = true;
        }
        emitLog(`Agent loop model error: ${message}`);
        break;
      }

      if (!response.toolCalls.length) {
        // The model produced a final text message without tool calls.
        // Nudge it once; if it keeps refusing tools, end the loop.
        consecutiveEmpty += 1;
        const assistantText = response.content?.trim() ?? "";
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

      // Record the assistant message with its tool calls.
      messages.push({
        role: "assistant",
        content: response.content || undefined,
        toolCalls: response.toolCalls,
      });

      const calls = response.toolCalls.slice(0, maxToolCallsPerTurn);
      for (const call of calls) {
        if (toolCallCount >= maxToolCallsTotal) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: `Tool call budget exhausted (${maxToolCallsTotal}). Call finish_app now with what you have.`,
          });
          continue;
        }
        toolCallCount += 1;

        const args = parseToolArgs(call.arguments);

        // Discovery gate: block write/edit/delete until inspect_reference_app
        // and use_design_skill have been called the required number of times.
        if (DISCOVERY_REQUIRED_BEFORE_WRITES.has(call.name) && !discoverySatisfied(discovery)) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: missingDiscoveryMessage(discovery),
          });
          discovery.discoveryNudges += 1;
          continue;
        }

        const outcome = await this.executeAgentToolCall({
          call,
          args,
          registry,
          toolContext,
          tracker,
          discovery,
          sandbox,
        });

        // Update discovery tracker based on what was called.
        if (call.name === "inspect_reference_app" && outcome.kind === "result") {
          discovery.referenceInspected = true;
        }
        if (call.name === "use_design_skill" && outcome.kind === "result") {
          discovery.designSkillCalls += 1;
        }
        if (call.name === "quality_audit" && outcome.kind === "result") {
          discovery.qualityAuditCalled = true;
        }

        if (outcome.kind === "finish") {
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
          lastBuildPassed = outcome.passed;
          lastBuildLog = outcome.logTail;
        }

        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: outcome.resultText,
        });
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
      toolCallCount,
      modelTimedOut,
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
  }): Promise<
    | { kind: "result"; resultText: string }
    | { kind: "build"; resultText: string; passed: boolean; logTail: string }
    | { kind: "finish"; resultText: string; title: string; summary: string }
  > {
    const { call, args: rawArgs, registry, toolContext, tracker, discovery, sandbox } = args;
    try {
      switch (call.name) {
        case "list_files":
        case "read_file":
        case "write_file":
        case "edit_file":
        case "delete_file":
        case "search_text":
        case "inspect_package":
        case "use_design_skill":
        case "inspect_reference_app":
        case "quality_audit":
        case "run_command":
        case "db_migrate":
        case "vercel_env_set": {
          const result = await registry.execute(call.name, rawArgs, toolContext);
          return { kind: "result", resultText: formatToolResult(call.name, result) };
        }
        case "run_build": {
          const skipInstall = rawArgs.skipInstall === true;
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
                kind: "build",
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
                kind: "build",
                passed: false,
                logTail,
                resultText: `Prisma schema sync failed:\n${logTail}`,
              };
            }
          }
          try {
            const buildResult = (await registry.execute(
              "run_command",
              { command: ["npm", "run", "build"], timeoutMs: 180_000 },
              toolContext,
            )) as { exitCode: number; output: string };
            const logTail = buildResult.output.slice(-1200);
            return {
              kind: "build",
              passed: true,
              logTail,
              resultText: `Build succeeded.${installLog ? `\nInstall tail:\n${installLog}` : ""}${dbLog ? `\nPrisma sync tail:\n${dbLog}` : ""}\nBuild tail:\n${logTail}`,
            };
          } catch (buildError) {
            const logTail = formatCommandError(buildError);
            return {
              kind: "build",
              passed: false,
              logTail,
              resultText: `Build failed:\n${logTail}`,
            };
          }
        }
        case "mark_task_done": {
          const taskId = typeof rawArgs.taskId === "string" ? rawArgs.taskId : "";
          if (!taskId) {
            return { kind: "result", resultText: "mark_task_done requires a taskId." };
          }
          if (!tracker.total.has(taskId)) {
            return {
              kind: "result",
              resultText: `Unknown task id: ${taskId}. Known: ${[...tracker.total].join(", ") || "(none)"}.`,
            };
          }
          tracker.done.add(taskId);
          const remaining = [...tracker.total].filter((id) => !tracker.done.has(id));
          return {
            kind: "result",
            resultText: `Task ${taskId} marked done. Remaining: ${remaining.join(", ") || "(none)"}.`,
          };
        }
        case "finish_app": {
          const title = typeof rawArgs.title === "string" ? rawArgs.title : "Generated app";
          const summary = typeof rawArgs.summary === "string" ? rawArgs.summary : "";

          // Hard gate: quality_audit must pass before finish is accepted. We
          // always run a fresh audit here so the agent cannot finish on a stale
          // pass. Any blocking failure forces the agent to keep working.
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

          if (auditResult.status !== "passed") {
            const blockingFailures = auditResult.checks
              .filter((check) => check.blocking && !check.passed)
              .map((check) => `  - [${check.id}] ${check.detail}`)
              .join("\n");
            const advisoryFailures = auditResult.checks
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

          const remaining = [...tracker.total].filter((id) => !tracker.done.has(id));
          const note = remaining.length ? ` (pending tasks: ${remaining.join(", ")})` : "";
          return {
            kind: "finish",
            title,
            summary,
            resultText: `App marked finished${note}. quality_audit passed all ${auditResult.checks.length} checks.`,
          };
        }
        default:
          return { kind: "result", resultText: `Unknown tool: ${call.name}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "result", resultText: `Tool error (${call.name}): ${message}` };
    }
  }
}

function formatCommandError(error: unknown): string {
  if (error && typeof error === "object" && "output" in error && typeof (error as { output?: unknown }).output === "string") {
    return (error as { output: string }).output.slice(-1200);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
