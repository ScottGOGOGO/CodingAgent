import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { delimiter } from "node:path";

import type { ToolCallTrace } from "@vide/contracts";

import { collectMissingImportDependencies, type PackageJsonShape } from "./package-dependencies.js";
import type { SandboxWorkspace } from "./sandbox.js";

export type ToolPermission = "read" | "write" | "execute" | "collaborate";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  permission: ToolPermission;
  sandboxOnly: boolean;
  validate(input: unknown): TInput;
  summarizeInput(input: TInput): string;
  summarizeOutput(output: TOutput): string;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface ToolExecutionContext {
  runId: string;
  workspace: SandboxWorkspace;
  emitTrace(trace: ToolCallTrace): void;
  emitLog(message: string): void;
}

type JsonRecord = Record<string, unknown>;

function record(input: unknown): JsonRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tool input must be an object.");
  }
  return input as JsonRecord;
}

function stringField(input: JsonRecord, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing string field: ${key}`);
  }
  return value;
}

function optionalStringField(input: JsonRecord, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string field: ${key}`);
  }
  return value;
}

function optionalStringListField(input: JsonRecord, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected string array field: ${key}`);
  }
  return value;
}

function booleanField(input: JsonRecord, key: string, fallback = false): boolean {
  const value = input[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean field: ${key}`);
  }
  return value;
}

const VISIBLE_INTERNAL_COPY_RE =
  /Next\.js|App Router|Prisma|Server Components?|Server Actions?|API\s*routes?|full-stack|generated app|architecture plan|Tech Stack|prototype|sandbox|prompt|build\s+passed|需求澄清|全栈架构|沙箱验证|候选生成|技术栈|脚手架|生成器/i;

const DESIGN_SKILL_GUIDES: Record<string, { title: string; guidance: string[]; qualityChecks: string[]; avoid: string[] }> = {
  "frontend-design": {
    title: "Frontend Design",
    guidance: [
      "Choose one domain-specific visual concept and carry it through typography, color, spacing, copy, motion, and state.",
      "Start from a 390px mobile app viewport with an app shell, compact navigation, a primary action, and visible domain objects.",
      "Use tactile controls with icons, clear selected/empty/loading/error/success states, and stable dimensions for repeated UI.",
      "Make the first viewport usable rather than explanatory: the user should inspect, choose, log, save, schedule, or progress something immediately.",
      "Commercial-grade mobile apps need a product shell, repeatable workflow, credible copy, and non-happy-path states. Visual polish without product depth is still a failure.",
    ],
    qualityChecks: [
      "At least four product modules or surfaces are visible through routes, tabs, or structured sections.",
      "Every primary control changes visible UI state or calls a server mutation.",
      "Loading, empty, error, saving, and success states are intentionally designed and do not feel like default browser text.",
      "The app does not read like a landing page, prompt summary, or technology showcase.",
    ],
    avoid: [
      "Centered title plus generic search box plus white cards.",
      "Blue-gray gradients, placeholder copy, and generic dashboard spacing.",
      "Visible implementation words such as Next.js, Prisma, generated app, prototype, or demo.",
    ],
  },
  "fullstack-product": {
    title: "Full-stack Product Closure",
    guidance: [
      "Model every mutable business object on the server side and expose a clear read/write boundary.",
      "Use Server Actions for in-app mutations and Route Handlers for public API or smoke-test surfaces.",
      "Validate mutation input, revalidate affected routes, and provide visible optimistic or post-submit feedback.",
      "Seed realistic domain data through server-only helpers or Prisma, not through UI text that says sample/demo.",
    ],
    qualityChecks: [
      "prisma/schema.prisma or an explicit server data module covers displayed entities.",
      "The primary loop includes create, update, delete, toggle, submit, or accept/dismiss behavior.",
      "The build can run without deployment-only env vars because clients initialize lazily.",
    ],
    avoid: [
      "Browser-only localStorage as the primary durable store.",
      "Dead buttons that only decorate the UI.",
      "API files that exist but are not wired to visible product behavior.",
    ],
  },
  "mobile-app-shell": {
    title: "Mobile App Shell",
    guidance: [
      "Use thumb-friendly bottom navigation or contextual segmented controls for primary surfaces.",
      "Keep header, identity, current state, and primary action visible without crowding the phone viewport.",
      "Treat safe areas, scroll regions, and sticky controls deliberately; avoid horizontal overflow at 390px.",
      "Give each tab/surface a distinct job: current state, detail/action, progress/history, collection/settings.",
    ],
    qualityChecks: [
      "Navigation exposes at least three meaningful surfaces or a one-screen equivalent with four modules.",
      "The active surface is visibly selected and changes without layout jumps.",
      "Inputs and buttons are at least touch-friendly and labels fit inside containers.",
    ],
    avoid: [
      "Desktop dashboard structure squeezed into a phone.",
      "Nested cards inside cards.",
      "Hero-only pages where the user cannot act.",
    ],
  },
  "ai-assisted-flow": {
    title: "AI-assisted Product Flow",
    guidance: [
      "Show AI as an assistant inside a domain workflow, not as generic chat unless the product is chat-first.",
      "Provide accept, revise, dismiss, save, or apply controls for generated suggestions.",
      "Include a local fallback or useful error state when model/API credentials are unavailable.",
      "Store accepted outputs as first-class product data with provenance or status.",
    ],
    qualityChecks: [
      "AI suggestions have action buttons and visible outcomes.",
      "The UI distinguishes draft/suggested/accepted/dismissed states.",
      "Missing API keys or failed model calls produce a useful product fallback.",
    ],
    avoid: [
      "A single generic prompt box with no product state.",
      "AI output that cannot be accepted, revised, or persisted.",
      "Visible explanations of the underlying model provider.",
    ],
  },
};

const REFERENCE_APP_PROFILES: Record<
  string,
  {
    title: string;
    summary: string;
    shell: string[];
    visual: string[];
    loop: string[];
    backend: string[];
    states: string[];
    commercialSignals: string[];
    avoid: string[];
  }
> = {
  "bloom-planner": {
    title: "Bloom Planner",
    summary: "A compact mobile planner with a companion character, Today/Schedule navigation, task CRUD, AI drafting, and visible progress.",
    shell: ["Desktop side rail plus mobile bottom nav.", "Today is the default action surface; Schedule is a secondary inspection surface.", "Header shows date, progress, add action, and profile/auth affordance."],
    visual: ["Warm paper/cream base, amber primary accent, muted botanical colors, Lora-style heading/body pairing.", "Custom companion SVG gives the app a remembered identity.", "Cards are tactile but compact, with category and priority chips."],
    loop: ["Create a task, edit metadata, complete/uncomplete it, optionally generate an AI draft, export calendar data.", "Progress ring and companion copy respond to task state.", "Schedule/calendar view turns task data into another surface."],
    backend: ["Route handlers for tasks, pet profile, calendar data, and AI generation.", "Session-aware requests, server-persisted task fields, and PATCH/DELETE mutations.", "AI stream writes drafts back onto task state."],
    states: ["Loading with character.", "Signed-out onboarding.", "Empty task list with useful action.", "Saving/deleting modal states.", "AI generation streaming/error states."],
    commercialSignals: ["Brand mark is visible immediately but restrained.", "Primary workflow is task creation/completion, not an explanatory hero.", "State changes alter progress and companion copy, so the app feels persistent."],
    avoid: ["Do not copy the pet art or exact Bloom branding.", "Do not reduce it to a static checklist.", "Do not hide backend behavior behind local-only state."],
  },
  "my-season": {
    title: "My Season",
    summary: "A personal year-as-series app with Season/Episode/Archive surfaces, fragment logging, AI edit-room suggestions, and archive history.",
    shell: ["Bottom nav covers Season, Episode, Archive.", "Top header carries series identity, active season/year, profile/auth menu.", "Each surface has a cinematic poster-like hero plus dense product modules below."],
    visual: ["Paper grain, editorial serif titles, ember/plum/teal accents, poster gradients, monospaced metadata.", "Large identity moments are balanced by compact cards and lists.", "Strong empty/error/loading pages still stay inside the product fiction."],
    loop: ["Add text/photo fragments to the current episode.", "Open edit room to generate recap/title/character/plot suggestions.", "Accept, dismiss, or revise suggestions; accepted suggestions update episodes, characters, plot lines, or recaps.", "Archive tracks previous seasons and progress."],
    backend: ["GET /api/season loads season universe.", "POST/DELETE fragments, POST suggestions, POST AI edit-room and revise-suggestion endpoints.", "Local fallback exists when AI service is unavailable."],
    states: ["Load error screen with reload action.", "Local/demo cut badge.", "Busy edit-room state.", "Revision count state.", "Empty footage guidance."],
    commercialSignals: ["The loading screen itself is branded and intentional.", "Archive/history makes the product feel durable beyond the first session.", "AI output has accept, revise, and dismiss outcomes instead of being decorative."],
    avoid: ["Do not copy the exact film/season metaphor unless the user's domain fits it.", "Do not create an AI suggestion card without accept/revise/dismiss actions.", "Do not leave archive/history as static decoration."],
  },
  "brain-spin": {
    title: "Brain Spin",
    summary: "A compact game-like thinking app pattern: one memorable mechanic, tight state feedback, and fast repeated action.",
    shell: ["Single primary play/work surface with status, score/progress, and recent history.", "Minimal navigation; mode controls are close to the main mechanic."],
    visual: ["High-contrast identity, kinetic controls, and playful feedback that still remains legible on mobile.", "Motion supports the mechanic rather than decorating the page."],
    loop: ["Start, make a choice, receive feedback, progress, repeat.", "History and streak/progress make the loop feel persistent."],
    backend: ["Persist sessions, attempts, scores, or generated prompts when relevant.", "Expose a simple read endpoint for history/progress."],
    states: ["Idle, active, success, miss/fail, completed, reset."],
    commercialSignals: ["One core mechanic is instantly understandable.", "Feedback is immediate and visible.", "History or streaks give the user a reason to return."],
    avoid: ["Avoid static landing pages.", "Avoid controls without immediate feedback.", "Avoid one-note neon visuals if the domain calls for calm."],
  },
  "compact-consumer-app": {
    title: "Compact Consumer App",
    summary: "A generic high-quality reference profile for mobile-first consumer tools with strong identity and closed-loop workflows.",
    shell: ["Named product identity.", "Bottom nav or segmented surfaces.", "Current-state home, action/detail surface, history/progress surface, and profile/settings surface."],
    visual: ["A specific material metaphor or editorial concept.", "Purposeful type pairing and non-generic palette.", "Small, stable, touch-friendly controls."],
    loop: ["Inspect current state.", "Perform one primary action.", "See visible feedback.", "Review history/progress.", "Return for next action."],
    backend: ["Server-side data model.", "At least one read API and one mutation boundary.", "Input validation and route revalidation."],
    states: ["Loading.", "Empty with next action.", "Saving/submitting.", "Error with recovery.", "Completed/success."],
    commercialSignals: ["Named identity and app navigation are visible in the first viewport.", "Business objects use specific copy and data.", "Every primary action either mutates durable state or changes the current product surface."],
    avoid: ["Stack explanations.", "Placeholder copy.", "Frontend-only fake CRUD.", "A hero page instead of an app."],
  },
};

function now() {
  return new Date().toISOString();
}

function durationMs(startedAt: number) {
  return Date.now() - startedAt;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as ToolDefinition);
    return this;
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async execute(name: string, input: unknown, context: ToolExecutionContext): Promise<unknown> {
    const tool = this.get(name);
    const parsed = tool.validate(input);
    const trace: ToolCallTrace = {
      id: randomUUID(),
      runId: context.runId,
      toolName: tool.name,
      status: "started",
      startedAt: now(),
      inputSummary: tool.summarizeInput(parsed),
      sandboxOnly: tool.sandboxOnly,
    };
    context.emitTrace(trace);
    const startedAt = Date.now();
    try {
      const output = await tool.execute(parsed, context);
      const completed: ToolCallTrace = {
        ...trace,
        status: "completed",
        finishedAt: now(),
        durationMs: durationMs(startedAt),
        outputSummary: tool.summarizeOutput(output),
      };
      context.emitTrace(completed);
      return output;
    } catch (error) {
      const failed: ToolCallTrace = {
        ...trace,
        status: "failed",
        finishedAt: now(),
        durationMs: durationMs(startedAt),
        error: summarizeToolError(error),
      };
      context.emitTrace(failed);
      throw error;
    }
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: "list_files",
      description: "List text-oriented files in the sandbox workspace.",
      permission: "read",
      sandboxOnly: true,
      validate: () => ({}),
      summarizeInput: () => "List workspace files",
      summarizeOutput: (output: { files: string[] }) => `${output.files.length} files`,
      execute: async (_input, context) => ({ files: await context.workspace.listFiles() }),
    })
    .register({
      name: "read_file",
      description: "Read a file from the sandbox workspace.",
      permission: "read",
      sandboxOnly: true,
      validate: (input) => ({ path: stringField(record(input), "path") }),
      summarizeInput: (input) => input.path,
      summarizeOutput: (output: { content: string }) => `${output.content.length} chars`,
      execute: async (input, context) => ({ content: await context.workspace.readFile(input.path) }),
    })
    .register({
      name: "search_text",
      description: "Search text in sandbox files.",
      permission: "read",
      sandboxOnly: true,
      validate: (input) => {
        const value = record(input);
        return { query: stringField(value, "query") };
      },
      summarizeInput: (input) => input.query,
      summarizeOutput: (output: { matches: Array<{ path: string; line: number }> }) => `${output.matches.length} matches`,
      execute: async (input, context) => {
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const path of await context.workspace.listFiles()) {
          try {
            const content = await context.workspace.readFile(path);
            content.split(/\r?\n/).forEach((line, index) => {
              if (line.toLowerCase().includes(input.query.toLowerCase())) {
                matches.push({ path, line: index + 1, text: line.slice(0, 240) });
              }
            });
          } catch {
            // Skip binary/unreadable files.
          }
        }
        return { matches: matches.slice(0, 80) };
      },
    })
    .register({
      name: "inspect_package",
      description: "Read and parse package.json if present.",
      permission: "read",
      sandboxOnly: true,
      validate: () => ({}),
      summarizeInput: () => "Inspect package.json",
      summarizeOutput: (output: { exists: boolean; scripts?: JsonRecord }) =>
        output.exists ? `scripts=${Object.keys(output.scripts ?? {}).join(",") || "none"}` : "package.json missing",
      execute: async (_input, context) => {
        try {
          const parsed = JSON.parse(await context.workspace.readFile("package.json")) as JsonRecord;
          return {
            exists: true,
            name: parsed.name,
            scripts: typeof parsed.scripts === "object" && parsed.scripts ? (parsed.scripts as JsonRecord) : {},
            dependencies: parsed.dependencies,
            devDependencies: parsed.devDependencies,
          };
        } catch {
          return { exists: false };
        }
      },
    })
    .register({
      name: "use_design_skill",
      description: "Return compact built-in design/product skill guidance.",
      permission: "read",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          skill: optionalStringField(value, "skill") ?? "frontend-design",
          focus: optionalStringField(value, "focus"),
        };
      },
      summarizeInput: (input) => `${input.skill}${input.focus ? `:${input.focus}` : ""}`,
      summarizeOutput: (output: { title: string; guidance: string[] }) => `${output.title}: ${output.guidance.length} guidance items`,
      execute: async (input) => {
        const key = normalizeGuideKey(input.skill, DESIGN_SKILL_GUIDES, "frontend-design");
        const guide = DESIGN_SKILL_GUIDES[key];
        return {
          skill: key,
          focus: input.focus,
          title: guide.title,
          guidance: guide.guidance,
          qualityChecks: guide.qualityChecks,
          avoid: guide.avoid,
          usage: "Apply this to product decisions and code structure; do not render the skill name or this guidance as visible UI copy.",
        };
      },
    })
    .register({
      name: "inspect_reference_app",
      description: "Return a curated reference-app profile for product and implementation patterns.",
      permission: "read",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          app: optionalStringField(value, "app") ?? "compact-consumer-app",
          focus: optionalStringField(value, "focus") ?? "all",
        };
      },
      summarizeInput: (input) => `${input.app}:${input.focus}`,
      summarizeOutput: (output: { title: string; summary: string }) => `${output.title}: ${output.summary}`,
      execute: async (input) => {
        const key = normalizeGuideKey(input.app, REFERENCE_APP_PROFILES, "compact-consumer-app");
        const profile = REFERENCE_APP_PROFILES[key];
        return {
          app: key,
          focus: input.focus,
          title: profile.title,
          summary: profile.summary,
          shell: profile.shell,
          visual: profile.visual,
          loop: profile.loop,
          backend: profile.backend,
          states: profile.states,
          commercialSignals: profile.commercialSignals,
          avoid: profile.avoid,
          usage: "Borrow structural patterns and quality bars only. Do not copy exact branding, artwork, copy, URLs, or proprietary implementation details.",
        };
      },
    })
    .register({
      name: "quality_audit",
      description: "Run a static generated-app quality audit over the sandbox workspace.",
      permission: "read",
      sandboxOnly: true,
      validate: (input) => ({ focus: optionalStringField(record(input), "focus") ?? "all" }),
      summarizeInput: (input) => `quality audit ${input.focus}`,
      summarizeOutput: (output: { status: string; blockingFailures: number }) =>
        `${output.status}; blocking=${output.blockingFailures}`,
      execute: async (_input, context) => auditGeneratedApp(context.workspace),
    })
    .register({
      name: "write_file",
      description: "Write a complete file into the sandbox workspace.",
      permission: "write",
      sandboxOnly: true,
      validate: (input) => {
        const value = record(input);
        return { path: stringField(value, "path"), content: stringField(value, "content") };
      },
      summarizeInput: (input) => `write ${input.path}`,
      summarizeOutput: () => "file written",
      execute: async (input, context) => {
        await context.workspace.writeFile(input.path, input.content);
        return { ok: true };
      },
    })
    .register({
      name: "edit_file",
      description: "Replace a search block in a sandbox file.",
      permission: "write",
      sandboxOnly: true,
      validate: (input) => {
        const value = record(input);
        return {
          path: stringField(value, "path"),
          search: stringField(value, "search"),
          replace: optionalStringField(value, "replace") ?? "",
        };
      },
      summarizeInput: (input) => `edit ${input.path}`,
      summarizeOutput: () => "file edited",
      execute: async (input, context) => {
        const content = await context.workspace.readFile(input.path);
        if (!content.includes(input.search)) {
          throw new Error(`Search block not found in ${input.path}`);
        }
        await context.workspace.writeFile(input.path, content.replace(input.search, input.replace));
        return { ok: true };
      },
    })
    .register({
      name: "delete_file",
      description: "Delete a file from the sandbox workspace.",
      permission: "write",
      sandboxOnly: true,
      validate: (input) => ({ path: stringField(record(input), "path") }),
      summarizeInput: (input) => `delete ${input.path}`,
      summarizeOutput: () => "file deleted",
      execute: async (input, context) => {
        await context.workspace.deleteFile(input.path);
        return { ok: true };
      },
    })
    .register({
      name: "run_command",
      description: "Run an allowed command in the sandbox workspace.",
      permission: "execute",
      sandboxOnly: true,
      validate: (input) => {
        const value = record(input);
        const command = value.command;
        if (!Array.isArray(command) || !command.every((part) => typeof part === "string")) {
          throw new Error("command must be a string array.");
        }
        return { command: command as string[], timeoutMs: Number(value.timeoutMs ?? "120000") };
      },
      summarizeInput: (input) => input.command.join(" "),
      summarizeOutput: (output: { exitCode: number; output: string }) =>
        `exit=${output.exitCode} output=${stripAnsi(output.output).slice(0, 120).replace(/\s+/g, " ")}`,
      execute: async (input, context) => runAllowedCommand(input.command, context, input.timeoutMs),
    })
    .register({
      name: "vercel_env_set",
      description: "Record a Vercel environment variable requirement for the generated app.",
      permission: "write",
      sandboxOnly: true,
      validate: (input) => {
        const value = record(input);
        return {
          name: stringField(value, "name"),
          value: optionalStringField(value, "value"),
          target: optionalStringListField(value, "target") ?? ["development", "preview", "production"],
          sensitive: booleanField(value, "sensitive", true),
          note: optionalStringField(value, "note"),
        };
      },
      summarizeInput: (input) => `env ${input.name} -> ${input.target.join(",")}`,
      summarizeOutput: () => "env requirement recorded",
      execute: async (input, context) => {
        const targetPath = context.workspace.resolveSandboxPath(".agent/vercel-env.jsonl");
        const entry = {
          name: input.name,
          target: input.target,
          sensitive: input.sensitive,
          hasValue: Boolean(input.value),
          note: input.note,
          recordedAt: new Date().toISOString(),
        };
        await appendFile(targetPath, `${JSON.stringify(entry)}\n`, "utf-8");
        if (input.value !== undefined) {
          await upsertEnvExample(context.workspace, input.name, input.sensitive ? "" : input.value);
        }
        return { ok: true, recorded: entry };
      },
    })
    .register({
      name: "db_migrate",
      description: "Validate database migrations in the sandbox, preferring Prisma migrate dev with SQLite.",
      permission: "execute",
      sandboxOnly: true,
      validate: (input) => {
        const value = record(input);
        return {
          name: optionalStringField(value, "name") ?? "init",
          provider: optionalStringField(value, "provider") ?? "sqlite",
          timeoutMs: Number(value.timeoutMs ?? "180000"),
        };
      },
      summarizeInput: (input) => `db migrate ${input.provider}:${input.name}`,
      summarizeOutput: (output: { exitCode: number; output: string }) =>
        `exit=${output.exitCode} output=${stripAnsi(output.output).slice(0, 120).replace(/\s+/g, " ")}`,
      execute: async (input, context) => {
        const command = ["npx", "prisma", "migrate", "dev", "--name", input.name, "--skip-seed"];
        return runAllowedCommand(command, context, input.timeoutMs, {
          DATABASE_URL: "file:./dev.db",
        });
      },
    })
    .register({
      name: "ask_user_question",
      description: "Create a structured user clarification request.",
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => record(input),
      summarizeInput: () => "ask user",
      summarizeOutput: () => "question prepared",
      execute: async (input) => ({ request: input }),
    })
    .register({
      name: "update_tasks",
      description: "Update visible agent tasks.",
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => record(input),
      summarizeInput: () => "update tasks",
      summarizeOutput: () => "tasks updated",
      execute: async (input) => ({ tasks: input.tasks ?? [] }),
    })
    .register({
      name: "submit_candidate",
      description: "Mark the current sandbox as the candidate change set.",
      permission: "collaborate",
      sandboxOnly: true,
      validate: (input) => record(input),
      summarizeInput: () => "submit candidate",
      summarizeOutput: () => "candidate submitted",
      execute: async () => ({ ok: true }),
    });
}

export function isAllowedAgentCommand(command: string[]): boolean {
  const [bin, ...args] = command;
  const joined = args.join(" ");
  if (bin === "npm") {
    const npmInstallFlags = new Set(["--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"]);
    const isInstall = args[0] === "install" && args.slice(1).every((arg) => npmInstallFlags.has(arg));
    return (
      isInstall ||
      joined === "ci" ||
      joined === "run build" ||
      joined === "run dev" ||
      joined === "test" ||
      joined === "run test"
    );
  }
  if (bin === "next") {
    return joined === "build" || joined.startsWith("dev ");
  }
  if (bin === "npx") {
    return (
      (args[0] === "prisma" && args[1] === "migrate" && args[2] === "dev") ||
      (args[0] === "prisma" && args[1] === "db" && args[2] === "push")
    );
  }
  if (bin === "prisma") {
    return args[0] === "validate" || args[0] === "generate" || (args[0] === "migrate" && args[1] === "dev") || (args[0] === "db" && args[1] === "push");
  }
  return false;
}

function normalizeGuideKey<T>(raw: string, options: Record<string, T>, fallback: string): string {
  const normalized = raw.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized in options) {
    return normalized;
  }
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  const found = Object.keys(options).find((key) => key.replace(/[^a-z0-9]/g, "") === compact);
  return found ?? fallback;
}

async function auditGeneratedApp(workspace: SandboxWorkspace): Promise<{
  status: "passed" | "failed";
  blockingFailures: number;
  checks: Array<{ id: string; passed: boolean; blocking: boolean; detail: string }>;
  summary: string;
}> {
  const files = await workspace.listFiles();
  const pathSet = new Set(files);
  const textFiles = await Promise.all(
    files
      .filter((path) => /\.(?:ts|tsx|js|jsx|css|json|md|mjs|cjs|prisma)$/i.test(path))
      .map(async (path) => {
        try {
          return { path, content: await workspace.readFile(path) };
        } catch {
          return { path, content: "" };
        }
      }),
  );
  const fileContent = textFiles.map((file) => `--- ${file.path}\n${file.content}`).join("\n");
  const uiContent = textFiles
    .filter((file) => /\.(?:tsx|jsx)$/i.test(file.path))
    .map((file) => `--- ${file.path}\n${file.content}`)
    .join("\n");
  const cssContent = textFiles.filter((file) => /\.css$/i.test(file.path)).map((file) => file.content).join("\n");
  const packageJson = textFiles.find((file) => file.path === "package.json")?.content ?? "";
  let parsedPackageJson: PackageJsonShape = {};
  try {
    parsedPackageJson = packageJson ? JSON.parse(packageJson) as PackageJsonShape : {};
  } catch {
    parsedPackageJson = {};
  }
  const missingImportDependencies = collectMissingImportDependencies(parsedPackageJson, textFiles);
  const componentFiles = files.filter((path) => /^src\/components\/.+\.(?:tsx|jsx)$/.test(path));
  const routePages = files.filter((path) => /^src\/app\/(?:.+\/)?page\.(?:tsx|jsx)$/.test(path));
  const apiRoutes = files.filter((path) => /^src\/app\/api\/.+\/route\.ts$/.test(path));
  const serverActionFiles = textFiles.filter((file) => /["']use server["']/.test(file.content));
  const hasServerAction = serverActionFiles.length > 0;
  const hasRouteHandler = apiRoutes.length > 0;
  const hasPrisma = pathSet.has("prisma/schema.prisma");
  const prismaSchema = textFiles.find((file) => file.path === "prisma/schema.prisma")?.content ?? "";
  const prismaModelMatches = prismaSchema.match(/^\s*model\s+\w+\s*\{/gm) ?? [];
  const prismaRelationMatches = prismaSchema.match(/@relation\s*\(/g) ?? [];
  const hasDbLayer = pathSet.has("src/lib/db.ts") || files.some((path) => /^src\/lib\/.+db\.(?:ts|tsx)$/.test(path));
  const hasLocalStoragePrimary = /\b(localStorage|sessionStorage|indexedDB)\b/i.test(fileContent);
  const hasInteractions = /\bonClick=|\bonSubmit=|\buseState\b|<form\b|formAction=|<button\b/i.test(uiContent);
  const hasNavigation = /<nav\b|bottom-nav|tab|tabs|AppShell|aria-label=["'][^"']*navigation/i.test(uiContent + cssContent);
  const hasCssSystem = /:root\s*{[^}]*--|var\(--|@media\s*\(max-width|@media\s*\(min-width/i.test(cssContent);
  const hasMetadata = /export\s+const\s+metadata|<title>|description:/i.test(textFiles.find((file) => file.path === "src/app/layout.tsx")?.content ?? "");
  const hasBuildScript = /"build"\s*:\s*"next build"/.test(packageJson);
  const forbiddenCopyMatches = uiContent.match(VISIBLE_INTERNAL_COPY_RE);

  // Check whether any Server Action is actually wired into the UI. A common
  // failure mode is generating actions.ts but never importing the action in a
  // <form action={...}> or formAction binding — looks like backend, behaves
  // like dead code.
  const exportedServerActions: string[] = [];
  for (const file of serverActionFiles) {
    const matches = file.content.match(/export\s+(?:async\s+)?function\s+(\w+)/g) ?? [];
    for (const match of matches) {
      const name = match.replace(/.*function\s+/, "");
      if (name) {
        exportedServerActions.push(name);
      }
    }
  }
  const serverActionWired = !hasServerAction
    ? true
    : exportedServerActions.some((actionName) => {
        const usagePattern = new RegExp(
          `(?:formAction|action)\\s*=\\s*\\{?\\s*${actionName}\\b|<form\\b[^>]*action=\\{${actionName}\\}|\\b${actionName}\\.bind\\(|\\b${actionName}\\s*\\(`,
          "i",
        );
        return usagePattern.test(uiContent);
      });

  // Loading/empty/error state coverage signals — bloom-planner-style polish.
  const hasLoadingState = /\bloading\b|<Suspense\b|Skeleton|isPending|isLoading/i.test(uiContent + fileContent);
  const hasEmptyState = /empty[\s-]?state|没有|尚未|getStarted|create your first|no\s+\w+\s+yet/i.test(uiContent);
  const hasErrorState =
    pathSet.has("src/app/error.tsx") ||
    /error\.tsx|<ErrorBoundary|onError=|catch\s*\(|throw new Error|errorState|reset\(\)|try again|重试/i.test(fileContent);
  const hasSavedOrSuccessState = /saved|success|complete|completed|done|已保存|已完成|完成|保存成功|提交成功/i.test(uiContent);
  const hasSavingState = /isPending|pending|saving|submitting|保存中|提交中|记录中|disabled=\{isPending\}/i.test(uiContent);
  const hasProductIdentity = /metadata\s*[:=]|<h1|AppShell|brand|logo|identity|产品|计划|训练|行程|Season|Planner|Coach/i.test(uiContent + fileContent);
  const appConventionStyledJsxFiles = textFiles
    .filter((file) => /^src\/app\/(?:.+\/)?(?:loading|error|page|layout)\.(?:tsx|jsx)$/.test(file.path))
    .filter((file) => /<style\s+jsx\b/i.test(file.content) && !/^\s*["']use client["'];?/m.test(file.content))
    .map((file) => file.path);
  const looseTruthyFilterFiles = textFiles
    .filter((file) => /\.(?:ts|tsx|js|jsx)$/i.test(file.path))
    .filter((file) => /\.filter\(\s*Boolean\s*\)/.test(file.content))
    .map((file) => file.path);

  const checks = [
    {
      id: "next-app-scaffold",
      passed:
        pathSet.has("package.json") &&
        pathSet.has("next.config.mjs") &&
        pathSet.has("tsconfig.json") &&
        pathSet.has("next-env.d.ts") &&
        pathSet.has("src/app/layout.tsx") &&
        pathSet.has("src/app/page.tsx") &&
        pathSet.has("src/app/globals.css"),
      blocking: true,
      detail: "Required Next.js App Router files exist.",
    },
    {
      id: "distinct-page-routes",
      passed: routePages.length >= 3,
      blocking: true,
      detail: `Found ${routePages.length} page route(s); expected at least 3 distinct surfaces (e.g. /, /schedule, /[id], /history).`,
    },
    {
      id: "component-library",
      passed: componentFiles.length >= 8,
      blocking: true,
      detail: `Found ${componentFiles.length} component file(s) under src/components; expected at least 8 for a commercial-grade component library.`,
    },
    {
      id: "multiple-models",
      passed: !hasPrisma || prismaModelMatches.length >= 3,
      blocking: true,
      detail: hasPrisma
        ? `Prisma schema declares ${prismaModelMatches.length} model(s); expected at least 3 related entities.`
        : "No Prisma schema present; skipped model count check.",
    },
    {
      id: "model-relations",
      passed: !hasPrisma || prismaRelationMatches.length >= 1,
      blocking: true,
      detail: hasPrisma
        ? `Prisma schema declares ${prismaRelationMatches.length} @relation reference(s); commercial candidates need at least one relationship.`
        : "No Prisma schema; skipped relation check.",
    },
    {
      id: "server-action-wired",
      passed: serverActionWired,
      blocking: true,
      detail: hasServerAction
        ? `Server Action functions: ${exportedServerActions.join(", ") || "(none exported)"}. They must be referenced via formAction={...} / <form action={...}> / .bind(...) in UI files.`
        : "No Server Actions present; gate not applicable.",
    },
    {
      id: "server-data-boundary",
      passed: hasPrisma || hasDbLayer,
      blocking: true,
      detail: "App has Prisma schema or an explicit server-side data layer.",
    },
    {
      id: "mutation-boundary",
      passed: hasServerAction || hasRouteHandler,
      blocking: true,
      detail: `Server Action present: ${hasServerAction}; API routes: ${apiRoutes.length}.`,
    },
    {
      id: "interaction-feedback",
      passed: hasInteractions,
      blocking: true,
      detail: "UI includes forms, buttons, React state, or event handlers for visible state changes.",
    },
    {
      id: "app-shell-navigation",
      passed: hasNavigation,
      blocking: true,
      detail: "UI includes app shell navigation, tabs, or equivalent surface switching.",
    },
    {
      id: "visual-system",
      passed: hasCssSystem,
      blocking: true,
      detail: "CSS includes variables, responsive rules, or tokenized styling.",
    },
    {
      id: "no-visible-implementation-copy",
      passed: !forbiddenCopyMatches,
      blocking: true,
      detail: forbiddenCopyMatches ? `Found visible implementation-like copy: ${forbiddenCopyMatches[0]}` : "No obvious implementation-copy leaks in TSX/JSX files.",
    },
    {
      id: "app-router-client-boundary",
      passed: appConventionStyledJsxFiles.length === 0,
      blocking: true,
      detail: appConventionStyledJsxFiles.length
        ? `App Router convention files use styled-jsx without 'use client': ${appConventionStyledJsxFiles.join(", ")}. Move styles to globals.css or a CSS module.`
        : "App Router convention files avoid client-only styled-jsx in Server Components.",
    },
    {
      id: "strict-null-narrowing",
      passed: looseTruthyFilterFiles.length === 0,
      blocking: true,
      detail: looseTruthyFilterFiles.length
        ? `Loose .filter(Boolean) null narrowing found in strict TypeScript files: ${looseTruthyFilterFiles.join(", ")}. Use a typed predicate such as .filter((item): item is NonNullable<typeof item> => Boolean(item)).`
        : "No loose .filter(Boolean) narrowing detected in TypeScript/JSX files.",
    },
    {
      id: "declared-import-dependencies",
      passed: missingImportDependencies.length === 0,
      blocking: true,
      detail: missingImportDependencies.length
        ? `Source imports undeclared package(s): ${missingImportDependencies.join(", ")}. Add them to package.json dependencies before finishing.`
        : "All recognized external imports are declared in package.json.",
    },
    {
      id: "durable-state",
      passed: !hasLocalStoragePrimary || hasPrisma || hasDbLayer,
      blocking: true,
      detail: hasLocalStoragePrimary
        ? "Browser storage appears in code; ensure it is only ephemeral and backed by server data."
        : "No browser storage detected as the main persistence layer.",
    },
    {
      id: "deploy-contract",
      passed: hasMetadata && hasBuildScript,
      blocking: true,
      detail: `Metadata: ${hasMetadata}; package build script: ${hasBuildScript}.`,
    },
    {
      id: "state-coverage",
      passed: hasLoadingState && hasEmptyState && hasErrorState,
      blocking: true,
      detail: `Loading: ${hasLoadingState}; Empty: ${hasEmptyState}; Error handling: ${hasErrorState}. Commercial candidates need all three non-happy-path states.`,
    },
    {
      id: "workflow-state-depth",
      passed: hasSavedOrSuccessState && hasSavingState,
      blocking: true,
      detail: `Saving/submitting state: ${hasSavingState}; saved/success/completed state: ${hasSavedOrSuccessState}. Primary workflows need visible in-progress and outcome states.`,
    },
    {
      id: "commercial-product-identity",
      passed: hasProductIdentity,
      blocking: true,
      detail: "App exposes a clear named product identity and domain-specific first-viewport signal.",
    },
  ];
  const blockingFailures = checks.filter((check) => check.blocking && !check.passed).length;
  return {
    status: blockingFailures === 0 ? "passed" : "failed",
    blockingFailures,
    checks,
    summary:
      blockingFailures === 0
        ? "Generated app passes the static product-quality audit."
        : `Generated app has ${blockingFailures} blocking quality audit failure${blockingFailures === 1 ? "" : "s"}.`,
  };
}

async function runAllowedCommand(
  command: string[],
  context: ToolExecutionContext,
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
  if (!isAllowedAgentCommand(command)) {
    throw new Error(`Command is not allowed in agent sandbox: ${command.join(" ")}`);
  }

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const localBin = context.workspace.resolveSandboxPath("node_modules/.bin");
    const child = spawn(command[0], command.slice(1), {
      cwd: context.workspace.sandboxRoot,
      detached: true,
      env: {
        ...process.env,
        PATH: [localBin, process.env.PATH].filter(Boolean).join(delimiter),
        DATABASE_URL: "file:./dev.db",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timeout: NodeJS.Timeout | null = null;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      callback();
    };
    const terminate = () => {
      const pid = child.pid;
      if (pid) {
        try {
          process.kill(-pid, "SIGTERM");
          setTimeout(() => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              // Process already exited.
            }
          }, 2_000).unref();
          return;
        } catch {
          // Fall back to killing the npm wrapper process below.
        }
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };

    timeout = timeoutMs > 0
      ? setTimeout(() => {
        terminate();
        finish(() => {
          const error = new Error(`Command timed out after ${timeoutMs}ms: ${command.join(" ")}`);
          Object.assign(error, { exitCode: 124, output });
          reject(error);
        });
      }, timeoutMs)
      : null;

    child.stdout?.on("data", (chunk) => {
      const text = stripAnsi(String(chunk));
      output += text;
      context.emitLog(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = stripAnsi(String(chunk));
      output += text;
      context.emitLog(text);
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("close", (code) => {
      finish(() => {
        const exitCode = code ?? 1;
        const result = { exitCode, output };
        if (exitCode === 0) {
          resolve(result);
        } else {
          const error = new Error(`Command failed: ${command.join(" ")}`);
          Object.assign(error, result);
          reject(error);
        }
      });
    });
  });
}

async function upsertEnvExample(workspace: SandboxWorkspace, name: string, value: string): Promise<void> {
  let content = "";
  try {
    content = await workspace.readFile(".env.example");
  } catch {
    content = "";
  }
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const escaped = JSON.stringify(value);
  const nextLine = `${name}=${escaped}`;
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) {
    lines[index] = nextLine;
  } else {
    lines.push(nextLine);
  }
  await workspace.writeFile(".env.example", `${lines.join("\n")}\n`);
}

function summarizeToolError(error: unknown): string {
  const message = stripAnsi(error instanceof Error ? error.message : String(error));
  if (error && typeof error === "object" && "output" in error && typeof (error as { output?: unknown }).output === "string") {
    const tail = stripAnsi((error as { output: string }).output).slice(-1200).trim();
    return tail ? `${message}\n${tail}` : message;
  }
  return message;
}
