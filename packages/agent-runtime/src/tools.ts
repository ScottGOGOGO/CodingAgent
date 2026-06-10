import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { delimiter } from "node:path";

import type { RunPhase, ToolCallTrace } from "@vide/contracts";

import { collectMissingImportDependencies, type PackageJsonShape } from "./package-dependencies.js";
import type { SandboxWorkspace } from "./sandbox.js";

export type JsonSchema = Record<string, unknown>;
export type ToolPermission = "read" | "write" | "execute" | "network" | "collaborate";
export type ToolCategory = "execution" | "session" | "task" | "integration" | "generation" | "verification";
export type ToolSideEffect = "none" | "workspace" | "process" | "network" | "external";
export type ToolRiskLevel = "low" | "medium" | "high";
export type AgentPhase = RunPhase | "planning" | "build" | "verify" | "review";

export interface ToolManifest {
  id: string;
  title: string;
  category: ToolCategory;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permission: ToolPermission;
  sideEffects: ToolSideEffect;
  riskLevel: ToolRiskLevel;
  phaseAllowlist: AgentPhase[];
  sandboxOnly: boolean;
  timeoutMs?: number;
  budgetCost?: number;
}

export interface ToolPolicy {
  allowedPermissions?: ToolPermission[];
  allowedSideEffects?: ToolSideEffect[];
  allowedRiskLevels?: ToolRiskLevel[];
  allowNetwork?: boolean;
  allowExternal?: boolean;
  sandboxOnly?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
}

export interface RuntimeCapabilities {
  mcp?: boolean;
  network?: boolean;
  subagents?: boolean;
  lsp?: boolean;
}

export interface SubAgentRunRequest {
  task: TaskRecord;
  prompt: string;
  agentType: string;
  allowedTools: string[];
  context: ToolExecutionContext;
}

export interface SubAgentRunResult {
  status: TaskRecord["status"];
  outputSummary: string;
  artifactIds?: string[];
  messages?: string[];
}

export interface SubAgentRunner {
  run(request: SubAgentRunRequest): Promise<SubAgentRunResult>;
}

export interface WebFetchRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface WebFetchResult {
  url: string;
  status: number;
  contentType?: string;
  text: string;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebToolAdapter {
  fetch(request: WebFetchRequest): Promise<WebFetchResult>;
  search(request: { query: string; limit: number }): Promise<{ query: string; results: WebSearchResultItem[] }>;
}

export interface McpResourceSummary {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpToolAdapter {
  listResources(): Promise<McpResourceSummary[]>;
  readResource(uri: string): Promise<{ uri: string; text?: string; blobBase64?: string; mimeType?: string }>;
}

export interface PlanModeState {
  active: boolean;
  objective?: string;
  enteredAt?: string;
  exitedAt?: string;
}

export interface ToolTrace extends ToolCallTrace {
  category?: ToolCategory;
  permission?: ToolPermission;
  sideEffects?: ToolSideEffect;
  riskLevel?: ToolRiskLevel;
  phase?: AgentPhase;
  taskId?: string;
  artifactIds?: string[];
  errorKind?: string;
}

export interface TaskRecord {
  id: string;
  parentTaskId?: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";
  agentType?: string;
  input: unknown;
  outputSummary?: string;
  artifactIds: string[];
  createdAt: string;
  updatedAt: string;
  logs: string[];
}

export interface TaskStore {
  create(input: {
    title: string;
    input?: unknown;
    parentTaskId?: string;
    agentType?: string;
    artifactIds?: string[];
  }): TaskRecord;
  get(id: string): TaskRecord | undefined;
  list(): TaskRecord[];
  update(id: string, patch: Partial<Pick<TaskRecord, "status" | "outputSummary" | "artifactIds" | "agentType">>): TaskRecord;
  appendLog(id: string, message: string): TaskRecord;
}

export interface ArtifactStore {
  add?(artifact: { id?: string; kind: string; path?: string; summary?: string; data?: unknown }): string;
  get?(id: string): unknown;
}

export interface SkillPackManifest {
  id: string;
  domain?: string;
  intents: string[];
  requiredTools: string[];
  outputContracts: string[];
  acceptanceScenarios: string[];
  qualityChecks: string[];
  promptGuidance?: string[];
}

const ALL_AGENT_PHASES: AgentPhase[] = [
  "intake",
  "context",
  "clarify",
  "plan",
  "planning",
  "design",
  "design_seed",
  "architect",
  "tool_loop",
  "build",
  "sandbox_verify",
  "repair",
  "verify",
  "review",
  "approval",
  "promote",
  "preview",
  "report",
];

const NON_MUTATING_PHASES: AgentPhase[] = ["intake", "context", "clarify", "plan", "planning", "design", "design_seed", "architect", "tool_loop", "repair"];
const BUILD_PHASES: AgentPhase[] = ["tool_loop", "build", "repair"];
const VERIFY_PHASES: AgentPhase[] = ["tool_loop", "sandbox_verify", "repair", "verify", "review", "approval"];

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  manifest?: ToolManifest;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  category?: ToolCategory;
  sideEffects?: ToolSideEffect;
  riskLevel?: ToolRiskLevel;
  phaseAllowlist?: AgentPhase[];
  timeoutMs?: number;
  budgetCost?: number;
  permission: ToolPermission;
  sandboxOnly: boolean;
  validate(input: unknown): TInput;
  summarizeInput(input: TInput): string;
  summarizeOutput(output: TOutput): string;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface ToolExecutionContext {
  runId: string;
  projectId?: string;
  phase?: AgentPhase;
  workspace: SandboxWorkspace;
  registry?: ToolRegistry;
  policy?: ToolPolicy;
  taskStore?: TaskStore;
  artifactStore?: ArtifactStore;
  capabilities?: RuntimeCapabilities;
  subAgentRunner?: SubAgentRunner;
  webAdapter?: WebToolAdapter;
  mcpAdapter?: McpToolAdapter;
  planMode?: PlanModeState;
  currentTaskId?: string;
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

const CORE_SKILL_PACKS: SkillPackManifest[] = [
  {
    id: "core-product",
    intents: ["general app generation", "product architecture", "mobile-first software"],
    requiredTools: [
      "list_files",
      "read_file",
      "search_text",
      "write_file",
      "edit_file",
      "run_build",
      "quality_audit",
      "finish_app",
    ],
    outputContracts: ["Next.js App Router workspace", "server data boundary", "visible interactive product workflow"],
    acceptanceScenarios: [
      "The app exposes at least three meaningful product surfaces.",
      "The primary user action changes durable or visible state.",
      "Build and static product audit pass before candidate submission.",
    ],
    qualityChecks: ["commercial-product-identity", "interaction-model-depth", "state-coverage", "deploy-contract"],
    promptGuidance: [
      "Use tools for deterministic inspection and mutation; use this skill pack only for product judgment.",
      "Do not show implementation or tool names in visible UI copy.",
    ],
  },
  {
    id: "frontend-design",
    domain: "interface design",
    intents: ["visual system", "mobile shell", "interaction design"],
    requiredTools: ["use_design_skill", "inspect_reference_app", "asset_brief_generate", "interaction_spec_generate", "quality_audit"],
    outputContracts: ["responsive visual system", "touch-friendly navigation", "loading/empty/error/success states"],
    acceptanceScenarios: [
      "First viewport is usable and domain-specific.",
      "Navigation changes visible surfaces without layout jumps.",
      "Controls have stable dimensions and visible feedback.",
    ],
    qualityChecks: DESIGN_SKILL_GUIDES["frontend-design"].qualityChecks,
    promptGuidance: DESIGN_SKILL_GUIDES["frontend-design"].guidance,
  },
  {
    id: "fullstack-product",
    domain: "full-stack product closure",
    intents: ["server actions", "route handlers", "durable data", "mutation workflow"],
    requiredTools: ["data_model_plan", "feature_flow_plan", "db_migrate", "run_build", "quality_audit"],
    outputContracts: ["server data model", "read boundary", "mutation boundary", "seed strategy"],
    acceptanceScenarios: [
      "Displayed entities map to a server-side data module or schema.",
      "Primary mutation validates input and provides visible feedback.",
      "The app can build without deployment-only environment variables.",
    ],
    qualityChecks: DESIGN_SKILL_GUIDES["fullstack-product"].qualityChecks,
    promptGuidance: DESIGN_SKILL_GUIDES["fullstack-product"].guidance,
  },
];

function now() {
  return new Date().toISOString();
}

function durationMs(startedAt: number) {
  return Date.now() - startedAt;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function objectSchema(properties: Record<string, unknown> = {}, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

const emptyObjectSchema = objectSchema();

function buildToolManifest(tool: ToolDefinition): ToolManifest {
  return {
    id: tool.name,
    title: tool.name,
    category: tool.category ?? inferToolCategory(tool.name, tool.permission),
    version: "1.0.0",
    inputSchema: tool.inputSchema ?? emptyObjectSchema,
    outputSchema: tool.outputSchema ?? { type: "object" },
    permission: tool.permission,
    sideEffects: tool.sideEffects ?? inferToolSideEffect(tool.permission),
    riskLevel: tool.riskLevel ?? inferToolRisk(tool.permission),
    phaseAllowlist: tool.phaseAllowlist ?? inferPhaseAllowlist(tool.permission),
    sandboxOnly: tool.sandboxOnly,
    timeoutMs: tool.timeoutMs,
    budgetCost: tool.budgetCost ?? defaultBudgetCost(tool.permission),
    ...tool.manifest,
  };
}

function inferToolCategory(name: string, permission: ToolPermission): ToolCategory {
  if (/task|agent|message/i.test(name)) {
    return "task";
  }
  if (/skill|ask|todo|plan/i.test(name)) {
    return "session";
  }
  if (/mcp|lsp|search|fetch/i.test(name) && permission === "network") {
    return "integration";
  }
  if (/audit|build|preview|candidate|verify/i.test(name)) {
    return "verification";
  }
  if (/seed|model|feature|asset|scenario|spec/i.test(name)) {
    return "generation";
  }
  return "execution";
}

function inferToolSideEffect(permission: ToolPermission): ToolSideEffect {
  if (permission === "write") {
    return "workspace";
  }
  if (permission === "execute") {
    return "process";
  }
  if (permission === "network") {
    return "network";
  }
  return "none";
}

function inferToolRisk(permission: ToolPermission): ToolRiskLevel {
  if (permission === "execute" || permission === "network") {
    return "high";
  }
  if (permission === "write") {
    return "medium";
  }
  return "low";
}

function inferPhaseAllowlist(permission: ToolPermission): AgentPhase[] {
  if (permission === "write" || permission === "execute") {
    return BUILD_PHASES;
  }
  if (permission === "collaborate") {
    return ALL_AGENT_PHASES;
  }
  return NON_MUTATING_PHASES;
}

function defaultBudgetCost(permission: ToolPermission): number {
  if (permission === "execute" || permission === "network") {
    return 5;
  }
  if (permission === "write") {
    return 2;
  }
  return 1;
}

function defaultToolPolicy(): Required<Omit<ToolPolicy, "allowedTools" | "deniedTools">> {
  return {
    allowedPermissions: ["read", "write", "execute", "collaborate"],
    allowedSideEffects: ["none", "workspace", "process"],
    allowedRiskLevels: ["low", "medium", "high"],
    allowNetwork: false,
    allowExternal: false,
    sandboxOnly: false,
  };
}

function validatePolicy(manifest: ToolManifest, context: ToolExecutionContext): void {
  if (context.phase && !manifest.phaseAllowlist.includes(context.phase)) {
    throw new Error(`Tool is not available during phase ${context.phase}: ${manifest.id}`);
  }
  const policy = { ...defaultToolPolicy(), ...(context.policy ?? {}) };
  if (policy.deniedTools?.includes(manifest.id)) {
    throw new Error(`Tool is denied by policy: ${manifest.id}`);
  }
  if (policy.allowedTools && !policy.allowedTools.includes(manifest.id)) {
    throw new Error(`Tool is not in the active allow list: ${manifest.id}`);
  }
  if (!policy.allowedPermissions.includes(manifest.permission)) {
    throw new Error(`Tool permission is not allowed: ${manifest.permission}`);
  }
  if (!policy.allowedSideEffects.includes(manifest.sideEffects)) {
    throw new Error(`Tool side effect is not allowed: ${manifest.sideEffects}`);
  }
  if (!policy.allowedRiskLevels.includes(manifest.riskLevel)) {
    throw new Error(`Tool risk level is not allowed: ${manifest.riskLevel}`);
  }
  if (manifest.permission === "network" && !policy.allowNetwork) {
    throw new Error(`Network tool is disabled by policy: ${manifest.id}`);
  }
  if (manifest.sideEffects === "external" && !policy.allowExternal) {
    throw new Error(`External side effects are disabled by policy: ${manifest.id}`);
  }
  if (policy.sandboxOnly && !manifest.sandboxOnly) {
    throw new Error(`Tool is not sandbox-only: ${manifest.id}`);
  }
}

function isToolVisible(manifest: ToolManifest, context: ToolExecutionContext): boolean {
  const phase = context.phase;
  if (phase && !manifest.phaseAllowlist.includes(phase)) {
    return false;
  }
  try {
    validatePolicy(manifest, context);
    return true;
  } catch {
    return false;
  }
}

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  create(input: {
    title: string;
    input?: unknown;
    parentTaskId?: string;
    agentType?: string;
    artifactIds?: string[];
  }): TaskRecord {
    const createdAt = now();
    const task: TaskRecord = {
      id: randomUUID(),
      parentTaskId: input.parentTaskId,
      title: input.title,
      status: "pending",
      agentType: input.agentType,
      input: input.input ?? {},
      outputSummary: undefined,
      artifactIds: input.artifactIds ?? [],
      createdAt,
      updatedAt: createdAt,
      logs: [],
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  update(id: string, patch: Partial<Pick<TaskRecord, "status" | "outputSummary" | "artifactIds" | "agentType">>): TaskRecord {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Unknown task: ${id}`);
    }
    const updated: TaskRecord = {
      ...task,
      ...patch,
      artifactIds: patch.artifactIds ?? task.artifactIds,
      updatedAt: now(),
    };
    this.tasks.set(id, updated);
    return updated;
  }

  appendLog(id: string, message: string): TaskRecord {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Unknown task: ${id}`);
    }
    const updated: TaskRecord = {
      ...task,
      logs: [...task.logs, message],
      updatedAt: now(),
    };
    this.tasks.set(id, updated);
    return updated;
  }
}

export class ObservableTaskStore implements TaskStore {
  constructor(
    private readonly inner: TaskStore = new InMemoryTaskStore(),
    private readonly onChange: (task: TaskRecord) => void,
  ) {}

  create(input: {
    title: string;
    input?: unknown;
    parentTaskId?: string;
    agentType?: string;
    artifactIds?: string[];
  }): TaskRecord {
    const task = this.inner.create(input);
    this.onChange(task);
    return task;
  }

  get(id: string): TaskRecord | undefined {
    return this.inner.get(id);
  }

  list(): TaskRecord[] {
    return this.inner.list();
  }

  update(id: string, patch: Partial<Pick<TaskRecord, "status" | "outputSummary" | "artifactIds" | "agentType">>): TaskRecord {
    const task = this.inner.update(id, patch);
    this.onChange(task);
    return task;
  }

  appendLog(id: string, message: string): TaskRecord {
    const task = this.inner.appendLog(id, message);
    this.onChange(task);
    return task;
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, unknown>();

  add(artifact: { id?: string; kind: string; path?: string; summary?: string; data?: unknown }): string {
    const id = artifact.id ?? randomUUID();
    this.artifacts.set(id, { ...artifact, id });
    return id;
  }

  get(id: string): unknown {
    return this.artifacts.get(id);
  }
}

function getTaskStore(context: ToolExecutionContext): TaskStore {
  if (!context.taskStore) {
    context.taskStore = new InMemoryTaskStore();
  }
  return context.taskStore;
}

function parseTaskStatus(value: unknown): TaskRecord["status"] {
  const allowed: TaskRecord["status"][] = ["pending", "running", "completed", "failed", "blocked", "stopped"];
  if (typeof value !== "string" || !allowed.includes(value as TaskRecord["status"])) {
    throw new Error("status must be one of pending, running, completed, failed, blocked, stopped.");
  }
  return value as TaskRecord["status"];
}

function formatTask(task: TaskRecord): Omit<TaskRecord, "logs"> & { logCount: number } {
  const { logs, ...rest } = task;
  return { ...rest, logCount: logs.length };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly manifests = new Map<string, ToolManifest>();
  private readonly skillPacks = new Map<string, SkillPackManifest>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as ToolDefinition);
    this.manifests.set(tool.name, buildToolManifest(tool as ToolDefinition));
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

  getManifest(name: string): ToolManifest {
    const manifest = this.manifests.get(name);
    if (!manifest) {
      throw new Error(`Unknown tool manifest: ${name}`);
    }
    return manifest;
  }

  listManifests(): ToolManifest[] {
    return [...this.manifests.values()];
  }

  getCatalog(context: ToolExecutionContext): ToolManifest[] {
    return this.listManifests().filter((manifest) => isToolVisible(manifest, context));
  }

  registerSkillPack(skill: SkillPackManifest): this {
    if (this.skillPacks.has(skill.id)) {
      throw new Error(`Duplicate skill pack registered: ${skill.id}`);
    }
    this.skillPacks.set(skill.id, skill);
    return this;
  }

  getSkillPack(id: string): SkillPackManifest {
    const direct = this.skillPacks.get(id);
    if (direct) {
      return direct;
    }
    const normalized = normalizeGuideKey(id, Object.fromEntries(this.skillPacks), "core-product");
    const fallback = this.skillPacks.get(normalized);
    if (!fallback) {
      throw new Error(`Unknown skill pack: ${id}`);
    }
    return fallback;
  }

  listSkillPacks(): SkillPackManifest[] {
    return [...this.skillPacks.values()];
  }

  toMcpTool(name: string): { name: string; description: string; inputSchema: JsonSchema } {
    const tool = this.get(name);
    const manifest = this.getManifest(name);
    return {
      name: manifest.id,
      description: tool.description,
      inputSchema: manifest.inputSchema,
    };
  }

  async execute(name: string, input: unknown, context: ToolExecutionContext): Promise<unknown> {
    const tool = this.get(name);
    const manifest = this.getManifest(name);
    validatePolicy(manifest, context);
    const parsed = tool.validate(input);
    const trace: ToolCallTrace = {
      id: randomUUID(),
      runId: context.runId,
      toolName: tool.name,
      status: "started",
      startedAt: now(),
      inputSummary: tool.summarizeInput(parsed),
      sandboxOnly: manifest.sandboxOnly,
      category: manifest.category,
      permission: manifest.permission,
      sideEffects: manifest.sideEffects,
      riskLevel: manifest.riskLevel,
      phase: context.phase,
      taskId: context.currentTaskId,
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
        errorKind: classifyToolError(error),
      };
      context.emitTrace(failed);
      throw error;
    }
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
    .register({
      name: "list_files",
      description: "List text-oriented files in the sandbox workspace.",
      inputSchema: emptyObjectSchema,
      outputSchema: objectSchema({ files: { type: "array", items: { type: "string" } } }, ["files"]),
      category: "execution",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: NON_MUTATING_PHASES,
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
      inputSchema: objectSchema({ path: { type: "string", description: "Path relative to the sandbox root." } }, ["path"]),
      category: "execution",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: NON_MUTATING_PHASES,
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
      inputSchema: objectSchema({ query: { type: "string" } }, ["query"]),
      category: "execution",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: NON_MUTATING_PHASES,
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
      inputSchema: emptyObjectSchema,
      category: "execution",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: NON_MUTATING_PHASES,
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
      inputSchema: objectSchema({
        skill: { type: "string", description: "frontend-design, fullstack-product, mobile-app-shell, or ai-assisted-flow." },
        focus: { type: "string" },
      }),
      category: "session",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
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
      inputSchema: objectSchema({
        app: { type: "string", description: "bloom-planner, my-season, brain-spin, or compact-consumer-app." },
        focus: { type: "string" },
      }),
      category: "session",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
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
      description:
        "Run a static generated-app audit. Only engineering checks are blocking; product, UI, visual, and interaction findings are advisory.",
      inputSchema: objectSchema({ focus: { type: "string" } }),
      category: "verification",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
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
      inputSchema: objectSchema({
        path: { type: "string", description: "Path relative to the sandbox root." },
        content: { type: "string", description: "Complete UTF-8 file content." },
      }, ["path", "content"]),
      category: "execution",
      sideEffects: "workspace",
      riskLevel: "medium",
      phaseAllowlist: BUILD_PHASES,
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
      inputSchema: objectSchema({
        path: { type: "string" },
        search: { type: "string" },
        replace: { type: "string" },
      }, ["path", "search", "replace"]),
      category: "execution",
      sideEffects: "workspace",
      riskLevel: "medium",
      phaseAllowlist: BUILD_PHASES,
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
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
      category: "execution",
      sideEffects: "workspace",
      riskLevel: "medium",
      phaseAllowlist: BUILD_PHASES,
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
      inputSchema: objectSchema({
        command: { type: "array", items: { type: "string" } },
        timeoutMs: { type: "number" },
      }, ["command"]),
      category: "execution",
      sideEffects: "process",
      riskLevel: "high",
      phaseAllowlist: BUILD_PHASES,
      timeoutMs: 180_000,
      budgetCost: 5,
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
      inputSchema: objectSchema({
        name: { type: "string" },
        value: { type: "string" },
        target: { type: "array", items: { type: "string" } },
        sensitive: { type: "boolean" },
        note: { type: "string" },
      }, ["name"]),
      category: "integration",
      sideEffects: "workspace",
      riskLevel: "medium",
      phaseAllowlist: BUILD_PHASES,
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
      inputSchema: objectSchema({
        name: { type: "string" },
        provider: { type: "string" },
        timeoutMs: { type: "number" },
      }),
      category: "execution",
      sideEffects: "process",
      riskLevel: "high",
      phaseAllowlist: BUILD_PHASES,
      timeoutMs: 180_000,
      budgetCost: 5,
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
      inputSchema: { type: "object" },
      category: "session",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
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
      inputSchema: { type: "object" },
      category: "session",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
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
      inputSchema: { type: "object" },
      category: "verification",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: VERIFY_PHASES,
      permission: "collaborate",
      sandboxOnly: true,
      validate: (input) => record(input),
      summarizeInput: () => "submit candidate",
      summarizeOutput: () => "candidate submitted",
      execute: async () => ({ ok: true }),
    });

  for (const skillPack of CORE_SKILL_PACKS) {
    registry.registerSkillPack(skillPack);
  }

  registerArchitectureTools(registry);
  return registry;
}

function registerArchitectureTools(registry: ToolRegistry): void {
  registry
    .register({
      name: "run_build",
      description: "Run the sandbox build pipeline: npm install if needed, Prisma db push when a schema exists, then npm run build.",
      inputSchema: objectSchema({ skipInstall: { type: "boolean" } }),
      category: "verification",
      sideEffects: "process",
      riskLevel: "high",
      phaseAllowlist: BUILD_PHASES,
      timeoutMs: 180_000,
      budgetCost: 6,
      permission: "execute",
      sandboxOnly: true,
      validate: (input) => ({ skipInstall: booleanField(record(input), "skipInstall", false) }),
      summarizeInput: (input) => input.skipInstall ? "build skip install" : "build with install",
      summarizeOutput: () => "build request accepted by agent loop",
      execute: async (input) => ({ skipInstall: input.skipInstall }),
    })
    .register({
      name: "mark_task_done",
      description: "Mark a task from the architecture plan as complete in the agent loop tracker.",
      inputSchema: objectSchema({
        taskId: { type: "string", description: "Exact task id from the architecture plan." },
        summary: { type: "string" },
      }, ["taskId"]),
      category: "task",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return { taskId: stringField(value, "taskId"), summary: optionalStringField(value, "summary") };
      },
      summarizeInput: (input) => `done ${input.taskId}`,
      summarizeOutput: () => "task completion request accepted by agent loop",
      execute: async (input) => input,
    })
    .register({
      name: "finish_app",
      description: "Signal that the app is fully implemented. The agent loop re-runs quality_audit before accepting this.",
      inputSchema: objectSchema({
        title: { type: "string" },
        summary: { type: "string" },
      }, ["title", "summary"]),
      category: "verification",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: VERIFY_PHASES,
      permission: "collaborate",
      sandboxOnly: true,
      validate: (input) => {
        const value = record(input);
        return { title: stringField(value, "title"), summary: stringField(value, "summary") };
      },
      summarizeInput: (input) => `finish ${input.title}`,
      summarizeOutput: () => "finish request accepted by agent loop",
      execute: async (input) => input,
    })
    .register({
      name: "enter_plan_mode",
      description: "Enter planning mode for the current run and record the planning objective.",
      inputSchema: objectSchema({ objective: { type: "string" } }, ["objective"]),
      category: "session",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => ({ objective: stringField(record(input), "objective") }),
      summarizeInput: (input) => `plan ${input.objective}`,
      summarizeOutput: (output: { planMode: PlanModeState }) => output.planMode.active ? "planning active" : "planning inactive",
      execute: async (input, context) => {
        context.planMode = {
          active: true,
          objective: input.objective,
          enteredAt: now(),
        };
        return { planMode: context.planMode };
      },
    })
    .register({
      name: "exit_plan_mode",
      description: "Exit planning mode for the current run and retain the final objective summary.",
      inputSchema: objectSchema({ summary: { type: "string" } }),
      category: "session",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => ({ summary: optionalStringField(record(input), "summary") }),
      summarizeInput: () => "exit plan mode",
      summarizeOutput: (output: { planMode: PlanModeState }) => output.planMode.active ? "planning active" : "planning inactive",
      execute: async (input, context) => {
        context.planMode = {
          ...(context.planMode ?? { active: false }),
          active: false,
          objective: input.summary ?? context.planMode?.objective,
          exitedAt: now(),
        };
        return { planMode: context.planMode };
      },
    })
    .register({
      name: "plan_mode_status",
      description: "Read the current plan mode state for the run.",
      inputSchema: emptyObjectSchema,
      category: "session",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: () => ({}),
      summarizeInput: () => "plan mode status",
      summarizeOutput: (output: { planMode: PlanModeState }) => output.planMode.active ? "planning active" : "planning inactive",
      execute: async (_input, context) => ({
        planMode: context.planMode ?? { active: false },
      }),
    })
    .register({
      name: "list_skill_packs",
      description: "List available skill packs and the tools/quality checks they request.",
      inputSchema: emptyObjectSchema,
      category: "session",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "read",
      sandboxOnly: false,
      validate: () => ({}),
      summarizeInput: () => "list skill packs",
      summarizeOutput: (output: { skills: SkillPackManifest[] }) => `${output.skills.length} skill pack(s)`,
      execute: async (_input, context) => {
        const registryFromContext = context as ToolExecutionContext & { registry?: ToolRegistry };
        const source = registryFromContext.registry ?? registry;
        return { skills: source.listSkillPacks() };
      },
    })
    .register({
      name: "skill_pack_get",
      description: "Read a skill pack manifest for domain strategy, output contracts, and quality checks.",
      inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
      category: "session",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "read",
      sandboxOnly: false,
      validate: (input) => ({ id: stringField(record(input), "id") }),
      summarizeInput: (input) => `skill ${input.id}`,
      summarizeOutput: (output: { skill: SkillPackManifest }) => `${output.skill.id}: ${output.skill.requiredTools.length} tool(s)`,
      execute: async (input, context) => {
        const registryFromContext = context as ToolExecutionContext & { registry?: ToolRegistry };
        const source = registryFromContext.registry ?? registry;
        return { skill: source.getSkillPack(input.id) };
      },
    })
    .register({
      name: "task_create",
      description: "Create a tracked task for a sub-agent, background workflow, or long-running product generation unit.",
      inputSchema: objectSchema({
        title: { type: "string" },
        input: { type: "object" },
        parentTaskId: { type: "string" },
        agentType: { type: "string" },
        artifactIds: { type: "array", items: { type: "string" } },
      }, ["title"]),
      category: "task",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          title: stringField(value, "title"),
          input: value.input ?? {},
          parentTaskId: optionalStringField(value, "parentTaskId"),
          agentType: optionalStringField(value, "agentType"),
          artifactIds: optionalStringListField(value, "artifactIds") ?? [],
        };
      },
      summarizeInput: (input) => `task ${input.title}`,
      summarizeOutput: (output: { task: TaskRecord }) => `task ${output.task.id}`,
      execute: async (input, context) => ({ task: getTaskStore(context).create(input) }),
    })
    .register({
      name: "task_get",
      description: "Read a tracked task by id.",
      inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
      category: "task",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => ({ id: stringField(record(input), "id") }),
      summarizeInput: (input) => `task ${input.id}`,
      summarizeOutput: (output: { task?: ReturnType<typeof formatTask> }) => output.task ? output.task.status : "missing",
      execute: async (input, context) => {
        const task = getTaskStore(context).get(input.id);
        return { task: task ? formatTask(task) : undefined };
      },
    })
    .register({
      name: "task_update",
      description: "Update tracked task status, output summary, agent type, or artifact references.",
      inputSchema: objectSchema({
        id: { type: "string" },
        status: { type: "string" },
        outputSummary: { type: "string" },
        agentType: { type: "string" },
        artifactIds: { type: "array", items: { type: "string" } },
      }, ["id"]),
      category: "task",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          id: stringField(value, "id"),
          status: value.status === undefined ? undefined : parseTaskStatus(value.status),
          outputSummary: optionalStringField(value, "outputSummary"),
          agentType: optionalStringField(value, "agentType"),
          artifactIds: optionalStringListField(value, "artifactIds"),
        };
      },
      summarizeInput: (input) => `task ${input.id} update`,
      summarizeOutput: (output: { task: ReturnType<typeof formatTask> }) => `${output.task.id}:${output.task.status}`,
      execute: async (input, context) => {
        const patch: Partial<Pick<TaskRecord, "status" | "outputSummary" | "artifactIds" | "agentType">> = {};
        if (input.status) {
          patch.status = input.status;
        }
        if (input.outputSummary !== undefined) {
          patch.outputSummary = input.outputSummary;
        }
        if (input.agentType !== undefined) {
          patch.agentType = input.agentType;
        }
        if (input.artifactIds !== undefined) {
          patch.artifactIds = input.artifactIds;
        }
        return { task: formatTask(getTaskStore(context).update(input.id, patch)) };
      },
    })
    .register({
      name: "task_list",
      description: "List tracked tasks for the current run.",
      inputSchema: emptyObjectSchema,
      category: "task",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: () => ({}),
      summarizeInput: () => "list tasks",
      summarizeOutput: (output: { tasks: Array<ReturnType<typeof formatTask>> }) => `${output.tasks.length} task(s)`,
      execute: async (_input, context) => ({ tasks: getTaskStore(context).list().map(formatTask) }),
    })
    .register({
      name: "task_stop",
      description: "Stop a tracked task and record an optional reason.",
      inputSchema: objectSchema({ id: { type: "string" }, reason: { type: "string" } }, ["id"]),
      category: "task",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return { id: stringField(value, "id"), reason: optionalStringField(value, "reason") };
      },
      summarizeInput: (input) => `stop ${input.id}`,
      summarizeOutput: (output: { task: ReturnType<typeof formatTask> }) => `${output.task.id}:stopped`,
      execute: async (input, context) => {
        const store = getTaskStore(context);
        if (input.reason) {
          store.appendLog(input.id, input.reason);
        }
        return { task: formatTask(store.update(input.id, { status: "stopped", outputSummary: input.reason })) };
      },
    })
    .register({
      name: "task_output",
      description: "Read tracked task output summary, artifacts, and recent logs.",
      inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
      category: "task",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => ({ id: stringField(record(input), "id") }),
      summarizeInput: (input) => `output ${input.id}`,
      summarizeOutput: (output: { task?: TaskRecord }) => output.task?.outputSummary ?? "no output",
      execute: async (input, context) => {
        const task = getTaskStore(context).get(input.id);
        return task ? { task: { ...task, logs: task.logs.slice(-20) } } : { task: undefined };
      },
    })
    .register({
      name: "send_message",
      description: "Append a message to a tracked task for lightweight agent-to-agent coordination.",
      inputSchema: objectSchema({ taskId: { type: "string" }, message: { type: "string" } }, ["taskId", "message"]),
      category: "task",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return { taskId: stringField(value, "taskId"), message: stringField(value, "message") };
      },
      summarizeInput: (input) => `message ${input.taskId}`,
      summarizeOutput: (output: { task: ReturnType<typeof formatTask> }) => `${output.task.id}:${output.task.logCount} log(s)`,
      execute: async (input, context) => ({ task: formatTask(getTaskStore(context).appendLog(input.taskId, input.message)) }),
    })
    .register({
      name: "agent_tool",
      description: "Create a bounded sub-agent task. The sub-agent receives an explicit tool allow list instead of inheriting all tools.",
      inputSchema: objectSchema({
        title: { type: "string" },
        prompt: { type: "string" },
        agentType: { type: "string" },
        allowedTools: { type: "array", items: { type: "string" } },
      }, ["title", "prompt"]),
      category: "task",
      sideEffects: "none",
      riskLevel: "medium",
      phaseAllowlist: ["plan", "planning", "architect", "tool_loop", "build", "repair", "review"],
      permission: "collaborate",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          title: stringField(value, "title"),
          prompt: stringField(value, "prompt"),
          agentType: optionalStringField(value, "agentType") ?? "subagent",
          allowedTools: optionalStringListField(value, "allowedTools") ?? ["list_files", "read_file", "search_text"],
        };
      },
      summarizeInput: (input) => `${input.agentType}:${input.title}`,
      summarizeOutput: (output: { task: TaskRecord; allowedTools: string[] }) => `${output.task.id}; tools=${output.allowedTools.join(",")}`,
      execute: async (input, context) => {
        const source = context.registry ?? registry;
        const catalog = source.getCatalog({
          ...context,
          policy: {
            ...context.policy,
            allowedTools: input.allowedTools,
          },
        });
        const allowedTools = catalog.map((tool) => tool.id);
        const task = getTaskStore(context).create({
          title: input.title,
          input: { prompt: input.prompt, allowedTools },
          parentTaskId: context.currentTaskId,
          agentType: input.agentType,
        });
        if (!context.subAgentRunner) {
          getTaskStore(context).update(task.id, {
            status: "blocked",
            outputSummary: "Sub-agent runner is not configured for this runtime.",
          });
          return {
            task: getTaskStore(context).get(task.id) ?? task,
            allowedTools,
            status: "blocked",
            note: "Sub-agent runner is not configured. Attach ToolExecutionContext.subAgentRunner to execute bounded sub-agents.",
          };
        }
        getTaskStore(context).update(task.id, { status: "running" });
        try {
          const result = await context.subAgentRunner.run({
            task,
            prompt: input.prompt,
            agentType: input.agentType,
            allowedTools,
            context: {
              ...context,
              currentTaskId: task.id,
              policy: {
                ...context.policy,
                allowedTools,
              },
            },
          });
          const updated = getTaskStore(context).update(task.id, {
            status: result.status,
            outputSummary: result.outputSummary,
            artifactIds: result.artifactIds ?? task.artifactIds,
          });
          for (const message of result.messages ?? []) {
            getTaskStore(context).appendLog(task.id, message);
          }
          return {
            task: getTaskStore(context).get(task.id) ?? updated,
            allowedTools,
            status: result.status,
            outputSummary: result.outputSummary,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failed = getTaskStore(context).update(task.id, {
            status: "failed",
            outputSummary: message,
          });
          return {
            task: failed,
            allowedTools,
            status: "failed",
            outputSummary: message,
          };
        }
      },
    })
    .register({
      name: "data_model_plan",
      description: "Draft a generic data model contract from domain entities and required workflows.",
      inputSchema: objectSchema({
        domain: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        workflows: { type: "array", items: { type: "string" } },
      }, ["domain"]),
      category: "generation",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ["plan", "planning", "design", "architect", "tool_loop", "repair"],
      permission: "read",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          domain: stringField(value, "domain"),
          entities: optionalStringListField(value, "entities") ?? [],
          workflows: optionalStringListField(value, "workflows") ?? [],
        };
      },
      summarizeInput: (input) => `data model ${input.domain}`,
      summarizeOutput: (output: { models: unknown[] }) => `${output.models.length} model(s)`,
      execute: async (input) => {
        const entities = input.entities.length ? input.entities : ["User", "Item", "Activity"];
        return {
          domain: input.domain,
          models: entities.map((entity, index) => ({
            name: entity,
            role: index === 0 ? "actor or owner" : "domain object",
            fields: ["id", "title", "status", "createdAt", "updatedAt"],
          })),
          relationships: entities.length > 1 ? [`${entities[0]} owns many ${entities.slice(1).join(", ")}`] : [],
          workflows: input.workflows,
        };
      },
    })
    .register({
      name: "tool_search",
      description: "Search the active tool catalog by name, category, permission, or description.",
      inputSchema: objectSchema({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
      category: "integration",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ALL_AGENT_PHASES,
      permission: "read",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return { query: stringField(value, "query").toLowerCase(), limit: Math.max(1, Math.min(25, Number(value.limit ?? 8))) };
      },
      summarizeInput: (input) => input.query,
      summarizeOutput: (output: { tools: ToolManifest[] }) => `${output.tools.length} tool(s)`,
      execute: async (input, context) => {
        const source = context.registry ?? registry;
        const tools = source.getCatalog(context).filter((manifest) => {
          const tool = source.get(manifest.id);
          const haystack = `${manifest.id} ${manifest.title} ${manifest.category} ${manifest.permission} ${tool.description}`.toLowerCase();
          return haystack.includes(input.query);
        });
        return { tools: tools.slice(0, input.limit) };
      },
    })
    .register({
      name: "web_fetch",
      description: "Fetch a URL through the configured WebToolAdapter. Network access is policy-gated and disabled unless an adapter is attached.",
      inputSchema: objectSchema({
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
        timeoutMs: { type: "number" },
      }, ["url"]),
      category: "integration",
      sideEffects: "network",
      riskLevel: "high",
      phaseAllowlist: ["context", "plan", "planning", "architect", "tool_loop", "repair", "review"],
      timeoutMs: 30_000,
      budgetCost: 5,
      permission: "network",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        const method = optionalStringField(value, "method") ?? "GET";
        if (method !== "GET" && method !== "POST") {
          throw new Error("web_fetch method must be GET or POST.");
        }
        const headers = value.headers === undefined
          ? undefined
          : record(value.headers);
        return {
          url: stringField(value, "url"),
          method: method as "GET" | "POST",
          headers: headers ? Object.fromEntries(Object.entries(headers).map(([key, item]) => [key, String(item)])) : undefined,
          body: optionalStringField(value, "body"),
          timeoutMs: Number(value.timeoutMs ?? 30_000),
        };
      },
      summarizeInput: (input) => `${input.method} ${input.url}`,
      summarizeOutput: summarizeWebFetchOutput,
      execute: async (input, context) => {
        if (!context.webAdapter || !context.capabilities?.network) {
          throw new Error("web_fetch requires RuntimeCapabilities.network and ToolExecutionContext.webAdapter.");
        }
        return context.webAdapter.fetch(input);
      },
    })
    .register({
      name: "web_search",
      description: "Search the web through the configured WebToolAdapter. Network access is policy-gated and disabled unless an adapter is attached.",
      inputSchema: objectSchema({
        query: { type: "string" },
        limit: { type: "number" },
      }, ["query"]),
      category: "integration",
      sideEffects: "network",
      riskLevel: "high",
      phaseAllowlist: ["context", "plan", "planning", "architect", "tool_loop", "repair", "review"],
      timeoutMs: 30_000,
      budgetCost: 5,
      permission: "network",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          query: stringField(value, "query"),
          limit: Math.max(1, Math.min(10, Number(value.limit ?? 5))),
        };
      },
      summarizeInput: (input) => input.query,
      summarizeOutput: summarizeWebSearchOutput,
      execute: async (input, context) => {
        if (!context.webAdapter || !context.capabilities?.network) {
          throw new Error("web_search requires RuntimeCapabilities.network and ToolExecutionContext.webAdapter.");
        }
        return context.webAdapter.search(input);
      },
    })
    .register({
      name: "lsp_tool",
      description: "Return the LSP adapter contract for future symbol, diagnostic, and refactor tools.",
      inputSchema: objectSchema({ action: { type: "string" }, path: { type: "string" } }, ["action"]),
      category: "integration",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ["context", "plan", "planning", "architect", "tool_loop", "repair", "review"],
      permission: "read",
      sandboxOnly: true,
      validate: (input) => {
        const value = record(input);
        return { action: stringField(value, "action"), path: optionalStringField(value, "path") };
      },
      summarizeInput: (input) => `${input.action}${input.path ? `:${input.path}` : ""}`,
      summarizeOutput: () => "lsp adapter unavailable",
      execute: async (input) => ({
        action: input.action,
        path: input.path,
        status: "unavailable",
        note: "LSP tool boundary is reserved; connect a language server worker to enable diagnostics and symbol-aware edits.",
      }),
    })
    .register({
      name: "content_seed_generate",
      description: "Generate a neutral product content seed plan without binding to a specific business domain.",
      inputSchema: objectSchema({
        domain: { type: "string" },
        count: { type: "number" },
        tone: { type: "string" },
      }, ["domain"]),
      category: "generation",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ["plan", "planning", "design", "architect", "tool_loop", "repair"],
      permission: "read",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          domain: stringField(value, "domain"),
          count: Math.max(1, Math.min(20, Number(value.count ?? 6))),
          tone: optionalStringField(value, "tone") ?? "specific, practical, non-placeholder",
        };
      },
      summarizeInput: (input) => `content ${input.domain}:${input.count}`,
      summarizeOutput: (output: { records: unknown[] }) => `${output.records.length} record(s)`,
      execute: async (input) => ({
        domain: input.domain,
        tone: input.tone,
        records: Array.from({ length: input.count }, (_, index) => ({
          id: `${input.domain.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "item"}-${index + 1}`,
          title: `${input.domain} item ${index + 1}`,
          status: index === 0 ? "active" : "planned",
          detail: "Replace this neutral seed with domain-specific copy during implementation.",
        })),
      }),
    })
    .register({
      name: "feature_flow_plan",
      description: "Plan inspect-act-feedback-history feature flow surfaces for a generated product.",
      inputSchema: objectSchema({
        goal: { type: "string" },
        primaryAction: { type: "string" },
        surfaces: { type: "array", items: { type: "string" } },
      }, ["goal", "primaryAction"]),
      category: "generation",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ["plan", "planning", "design", "architect", "tool_loop", "repair"],
      permission: "read",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          goal: stringField(value, "goal"),
          primaryAction: stringField(value, "primaryAction"),
          surfaces: optionalStringListField(value, "surfaces") ?? ["Home", "Detail", "History", "Settings"],
        };
      },
      summarizeInput: (input) => `flow ${input.primaryAction}`,
      summarizeOutput: (output: { steps: string[] }) => `${output.steps.length} step(s)`,
      execute: async (input) => ({
        goal: input.goal,
        surfaces: input.surfaces,
        steps: [
          `Inspect current state on ${input.surfaces[0] ?? "Home"}.`,
          `Perform primary action: ${input.primaryAction}.`,
          "Show saving/progress feedback immediately.",
          "Persist or reflect the result in visible product state.",
          `Expose history or review on ${input.surfaces[2] ?? "History"}.`,
        ],
      }),
    })
    .register({
      name: "asset_brief_generate",
      description: "Generate a compact visual asset brief for icons, illustrations, textures, or media needed by a product.",
      inputSchema: objectSchema({
        domain: { type: "string" },
        visualConcept: { type: "string" },
        assetKinds: { type: "array", items: { type: "string" } },
      }, ["domain", "visualConcept"]),
      category: "generation",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ["design", "design_seed", "architect", "tool_loop", "repair"],
      permission: "read",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          domain: stringField(value, "domain"),
          visualConcept: stringField(value, "visualConcept"),
          assetKinds: optionalStringListField(value, "assetKinds") ?? ["icon set", "empty state", "brand mark"],
        };
      },
      summarizeInput: (input) => `assets ${input.domain}`,
      summarizeOutput: (output: { assets: unknown[] }) => `${output.assets.length} asset brief(s)`,
      execute: async (input) => ({
        domain: input.domain,
        visualConcept: input.visualConcept,
        assets: input.assetKinds.map((kind) => ({
          kind,
          purpose: `Support ${input.domain} workflow with ${input.visualConcept}.`,
          constraints: ["must render in-app", "must not be purely decorative", "must fit mobile viewport"],
        })),
      }),
    })
    .register({
      name: "interaction_spec_generate",
      description: "Generate expected controls, states, and feedback loops for a product workflow.",
      inputSchema: objectSchema({
        workflow: { type: "string" },
        controls: { type: "array", items: { type: "string" } },
      }, ["workflow"]),
      category: "generation",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ["design", "architect", "tool_loop", "repair"],
      permission: "read",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          workflow: stringField(value, "workflow"),
          controls: optionalStringListField(value, "controls") ?? ["primary action", "filter", "edit", "delete", "undo"],
        };
      },
      summarizeInput: (input) => `interaction ${input.workflow}`,
      summarizeOutput: (output: { states: string[] }) => `${output.states.length} state(s)`,
      execute: async (input) => ({
        workflow: input.workflow,
        controls: input.controls,
        states: ["idle", "loading", "empty", "editing", "saving", "success", "error"],
        feedback: ["optimistic visual change", "disabled busy control", "recoverable error action", "history/progress update"],
      }),
    })
    .register({
      name: "acceptance_scenario_generate",
      description: "Generate user-centered acceptance scenarios that can later drive build, visual, or smoke verification.",
      inputSchema: objectSchema({
        goal: { type: "string" },
        surfaces: { type: "array", items: { type: "string" } },
      }, ["goal"]),
      category: "verification",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ["plan", "planning", "architect", "tool_loop", "verify", "review", "repair"],
      permission: "read",
      sandboxOnly: false,
      validate: (input) => {
        const value = record(input);
        return {
          goal: stringField(value, "goal"),
          surfaces: optionalStringListField(value, "surfaces") ?? ["home", "detail", "history"],
        };
      },
      summarizeInput: (input) => `acceptance ${input.goal}`,
      summarizeOutput: (output: { scenarios: string[] }) => `${output.scenarios.length} scenario(s)`,
      execute: async (input) => ({
        goal: input.goal,
        scenarios: [
          `User lands on ${input.surfaces[0] ?? "home"} and understands current state within the first viewport.`,
          "User performs the primary action and sees immediate in-progress feedback.",
          `User finds the result again from ${input.surfaces.at(-1) ?? "history"}.`,
          "User can recover from empty or error states without leaving the workflow.",
        ],
      }),
    })
    .register({
      name: "list_mcp_resources",
      description: "List MCP resources through the configured MCP adapter. Disabled unless MCP capability and adapter are attached.",
      inputSchema: emptyObjectSchema,
      category: "integration",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ["context", "plan", "planning", "architect", "tool_loop", "repair"],
      permission: "read",
      sandboxOnly: false,
      validate: () => ({}),
      summarizeInput: () => "list mcp resources",
      summarizeOutput: (output: { resources: unknown[] }) => `${output.resources.length} resource(s)`,
      execute: async (_input, context) => {
        if (!context.mcpAdapter || !context.capabilities?.mcp) {
          return {
            resources: [],
            adapter: {
              status: "not_connected",
              note: "Attach ToolExecutionContext.mcpAdapter and RuntimeCapabilities.mcp to enable live MCP resource enumeration.",
            },
          };
        }
        return { resources: await context.mcpAdapter.listResources() };
      },
    })
    .register({
      name: "read_mcp_resource",
      description: "Read an MCP resource through the configured MCP adapter.",
      inputSchema: objectSchema({ uri: { type: "string" } }, ["uri"]),
      category: "integration",
      sideEffects: "none",
      riskLevel: "low",
      phaseAllowlist: ["context", "plan", "planning", "architect", "tool_loop", "repair"],
      permission: "read",
      sandboxOnly: false,
      validate: (input) => ({ uri: stringField(record(input), "uri") }),
      summarizeInput: (input) => input.uri,
      summarizeOutput: () => "mcp adapter unavailable",
      execute: async (input, context) => {
        if (!context.mcpAdapter || !context.capabilities?.mcp) {
          return {
            uri: input.uri,
            status: "unavailable",
            note: "Attach ToolExecutionContext.mcpAdapter and RuntimeCapabilities.mcp to enable live MCP resource reads.",
          };
        }
        return context.mcpAdapter.readResource(input.uri);
      },
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
  const files = (await workspace.listFiles()).filter(isAuditableSourcePath);
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
  const domainContent = textFiles
    .filter((file) => /^src\/(?:app|components|lib)\//.test(file.path))
    .map((file) => `--- ${file.path}\n${file.content}`)
    .join("\n");
  const cssContent = textFiles.filter((file) => /\.css$/i.test(file.path)).map((file) => file.content).join("\n");
  const packageJson = textFiles.find((file) => file.path === "package.json")?.content ?? "";
  const layoutContent = textFiles.find((file) => file.path === "src/app/layout.tsx" || file.path === "src/app/layout.jsx")?.content ?? "";
  const importedGlobalCssPaths = [...layoutContent.matchAll(/import\s+["']([^"']+\.css)["'];?/g)]
    .map((match) => normalizeCssImportPath(match[1]?.trim() ?? ""))
    .filter((path): path is string => Boolean(path));
  const hasGlobalCssEntry = pathSet.has("src/app/globals.css") || importedGlobalCssPaths.some((path) => pathSet.has(path));
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
  const uiFileMap = new Map(
    textFiles
      .filter((file) => /\.(?:tsx|jsx|ts|js)$/i.test(file.path))
      .map((file) => [file.path, file.content] as const),
  );
  const routeSurfaceReports = routePages.map((path) => analyzeRouteSurface(path, uiFileMap));
  const shallowRouteSurfaces = routeSurfaceReports.filter((report) => !report.passed);
  const rootRouteBundle = collectRouteSurfaceBundle("src/app/page.tsx", uiFileMap);
  const mediaHeavyRootHasMedia = hasScreenshotMediaMarkup(rootRouteBundle);
  const savedRouteReports = routePages
    .filter((path) => /\/(?:favorites|saved|wishlist|collection|bookmarks|收藏|已保存)\/page\.(?:tsx|jsx)$/.test(path))
    .map((path) => analyzeSavedRouteSurface(path, uiFileMap));
  const shallowSavedRoutes = savedRouteReports.filter((report) => !report.passed);
  const travelItineraryReport = analyzeTravelItineraryDepth(fileContent, uiFileMap);
  const travelVisualReport = analyzeTravelPlaceVisualSpecificity(fileContent, uiFileMap);
  const serverActionFiles = textFiles.filter((file) => /["']use server["']/.test(file.content));
  const hasServerAction = serverActionFiles.length > 0;
  const hasRouteHandler = apiRoutes.length > 0;
  const hasPrisma = pathSet.has("prisma/schema.prisma");
  const prismaSchema = textFiles.find((file) => file.path === "prisma/schema.prisma")?.content ?? "";
  const prismaModelMatches = prismaSchema.match(/^\s*model\s+\w+\s*\{/gm) ?? [];
  const prismaRelationMatches = prismaSchema.match(/@relation\s*\(/g) ?? [];
  const hasDbLayer =
    pathSet.has("src/lib/db.ts") ||
    pathSet.has("src/lib/server-data.ts") ||
    files.some((path) => /^src\/lib\/.+(?:db|server-data|serverData)\.(?:ts|tsx)$/.test(path));
  const hasTypedDomainDataModule =
    files.some((path) => /^src\/lib\/(?:demo-data|.+data)\.(?:ts|tsx)$/.test(path)) &&
    /\bexport\s+(?:type|interface|const)\b|as const|satisfies\b/i.test(
      textFiles
        .filter((file) => /^src\/lib\/(?:demo-data|.+data)\.(?:ts|tsx)$/.test(file.path))
        .map((file) => file.content)
        .join("\n"),
    );
  const hasLocalStorageHelper =
    files.some((path) => /^src\/lib\/.+(?:storage|store|local).(?:ts|tsx)$/.test(path)) ||
    /function\s+(?:load|save|read|write)[A-Za-z0-9_]*(?:Local|Storage|Record)|try\s*\{[\s\S]{0,600}localStorage\.getItem|typeof\s+window\s*!==\s*["']undefined["'][\s\S]{0,600}localStorage/i.test(
      fileContent,
    );
  const hasLocalFirstDataBoundary = hasTypedDomainDataModule && (hasRouteHandler || hasLocalStorageHelper);
  const hasLocalStoragePrimary = /\b(localStorage|sessionStorage|indexedDB)\b/i.test(fileContent);
  const hasInteractions = /\bonClick=|\bonSubmit=|\buseState\b|<form\b|formAction=|<button\b/i.test(uiContent);
  const hasStatefulInteraction = /\buseState\b|\buseReducer\b|\buseOptimistic\b|\buseTransition\b|\bisPending\b|\bonClick=|\bonChange=|\bonSubmit=|formAction=|<form\b/i.test(uiContent);
  const hasInputControl = /<textarea\b|<input\b|contentEditable|role=["']textbox["']|name=["'][^"']*(?:entry|note|journal|mood|title|text|body|content|message|task|item)/i.test(uiContent);
  const hasSelectionControl = /selected|active|current|aria-pressed|aria-selected|data-state|setActive|setSelected|setCurrent|tabIndex|role=["']tab/i.test(uiContent);
  const hasFilterOrSortControl = /filter|sort|segment|segmented|category|tag|chip|全部|筛选|排序|分类|标签/i.test(uiContent);
  const hasDateOrPeriodControl =
    /setDate|setMonth|setWeek|selectedDate|activeDate|currentMonth|activeDay|selectedDay|currentDay|dayNumber|tripDays|date-nav|dateNav|day-switch|daySwitcher|day-switcher|type=["']date["']|date-strip|month-switch|week-switch|calendar|prevMonth|nextMonth|previousDay|nextDay|prevDay|nextDay|上一日|下一日|上个月|下个月|前一天|后一天|上一天|下一天|第[一二三四五六七八九十]+天|D\d|日期切换|天数切换|月份切换|日历/i.test(uiContent);
  const hasEditOrSecondaryAction = /edit|delete|remove|revise|rename|archive|duplicate|longPress|contextmenu|onContextMenu|more|ellipsis|编辑|删除|修改|重写|归档|长按|更多/i.test(uiContent);
  const hasHistoryGrouping =
    /grouped|groupBy|groupedEntries|sectioned|monthGroups|weekGroups|reduce\(|new Map|dateTime=|<time\b|按月|按周|分组|月份分组|周分组|历史分组/i.test(uiContent);
  const hasFocusTreatment = /autoFocus|focus-visible|:focus|:focus-visible|focus-within|aria-describedby/i.test(uiContent + cssContent);
  const mediaHeavyProduct =
    /travel|trip|itinerary|destination|place|venue|restaurant|dining|food|gallery|portfolio|catalog|product|photo|image|artwork|旅行|旅游|行程|景点|地点|目的地|上海|餐厅|餐饮|美食|场馆|作品集|画廊|图库|照片|图片|商品|产品|目录|卡片/i.test(
      `${uiContent}\n${domainContent}`,
    );
  const hasScreenshotDetectableMedia = hasScreenshotMediaMarkup(uiContent);
  const hasVisualDataFields =
    /\b(?:image|imageUrl|imageSrc|photo|photoUrl|visual|visualLabel|illustration|media)\b\s*[:=]/i.test(fileContent) &&
    /\balt\b|\bariaLabel\b|\baria-label\b|visualLabel/i.test(fileContent);
  const interactionSignals = [
    hasStatefulInteraction,
    hasInputControl,
    hasSelectionControl,
    hasFilterOrSortControl,
    hasDateOrPeriodControl,
    hasEditOrSecondaryAction,
    hasHistoryGrouping,
    hasFocusTreatment,
  ];
  const interactionSignalCount = interactionSignals.filter(Boolean).length;
  const hasAdvancedInteraction =
    hasSelectionControl || hasFilterOrSortControl || hasDateOrPeriodControl || hasEditOrSecondaryAction || hasHistoryGrouping || hasFocusTreatment;
  const inputHeavyProduct = /diary|journal|note|notes|mood|habit|tracker|checklist|todo|logbook|entry|entries|日记|手帐|笔记|心情|情绪|习惯|清单|待办|记录|打卡/i.test(fileContent);
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
  const rootSurfaceReport = routeSurfaceReports.find((report) => report.path === "src/app/page.tsx" || report.path === "src/app/page.jsx");
  const hasCompactRouteEquivalentSurfaces = Boolean(
    rootSurfaceReport &&
      rootSurfaceReport.controls >= 3 &&
      rootSurfaceReport.modules >= 4 &&
      rootSurfaceReport.codeLength >= 1400 &&
      (hasNavigation || hasSelectionControl || hasFilterOrSortControl),
  );
  const hasCompactComponentSurface =
    componentFiles.length >= 3 ||
    (componentFiles.length >= 1 && hasCompactRouteEquivalentSurfaces) ||
    (componentFiles.length === 0 && hasCompactRouteEquivalentSurfaces && rootRouteBundle.replace(/\s+/g, " ").length >= 2400);
  const appConventionStyledJsxFiles = textFiles
    .filter((file) => /^src\/app\/(?:.+\/)?(?:loading|error|page|layout)\.(?:tsx|jsx)$/.test(file.path))
    .filter((file) => /<style\s+jsx\b/i.test(file.content) && !/^\s*["']use client["'];?/m.test(file.content))
    .map((file) => file.path);
  const clientNotFoundPageFiles = textFiles
    .filter((file) => /^src\/app\/(?:.+\/)?page\.(?:tsx|jsx)$/.test(file.path))
    .filter((file) => /^\s*["']use client["'];?/m.test(file.content) && /\bnotFound\s*\(/.test(file.content))
    .map((file) => file.path);
  const looseTruthyFilterFiles = textFiles
    .filter((file) => /\.(?:ts|tsx|js|jsx)$/i.test(file.path))
    .filter((file) => /\.filter\(\s*Boolean\s*\)/.test(file.content))
    .map((file) => file.path);
  const travelCostFieldReport = analyzeTravelCostFieldConsistency(fileContent, uiContent);
  const travelPlaceFieldReport = analyzeTravelPlaceFieldContract(textFiles, uiContent);
  const travelRouteContractReport = analyzeTravelDynamicRouteContract(fileContent, uiFileMap);

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
        hasGlobalCssEntry,
      blocking: true,
      detail: "Required Next.js App Router files exist, including a layout-imported global CSS entry.",
    },
    {
      id: "distinct-page-routes",
      passed: routePages.length >= 1 && (routePages.length >= 3 || hasCompactRouteEquivalentSurfaces),
      blocking: true,
      detail: `Found ${routePages.length} page route(s); compact route-equivalent surfaces=${hasCompactRouteEquivalentSurfaces}. Lightweight apps may use one strong route when tabs/segments/detail/history modules provide at least three meaningful surfaces.`,
    },
    {
      id: "route-surface-depth",
      passed: shallowRouteSurfaces.length === 0,
      blocking: true,
      detail: shallowRouteSurfaces.length
        ? `Shallow route surface(s): ${shallowRouteSurfaces
            .map((route) => `${route.path} controls=${route.controls} modules=${route.modules} code=${route.codeLength}`)
            .join("; ")}. Every page route must render meaningful domain content plus at least two controls or links after local component imports are considered.`
        : `Route surface depth looks usable across ${routeSurfaceReports.length} page route(s).`,
    },
    {
      id: "component-library",
      passed: hasCompactComponentSurface,
      blocking: true,
      detail: `Found ${componentFiles.length} component file(s) under src/components; compact workbench=${hasCompactRouteEquivalentSurfaces}. Expected a few reusable components or one substantial compact workbench rather than an arbitrary large component library.`,
    },
    {
      id: "multiple-models",
      passed: !hasPrisma || prismaModelMatches.length >= 1,
      blocking: true,
      detail: hasPrisma
        ? `Prisma schema declares ${prismaModelMatches.length} model(s); expected at least one real business entity for a lightweight database-backed app.`
        : "No Prisma schema present; skipped model count check.",
    },
    {
      id: "model-relations",
      passed: !hasPrisma || prismaModelMatches.length <= 1 || prismaRelationMatches.length >= 1,
      blocking: true,
      detail: hasPrisma
        ? `Prisma schema declares ${prismaRelationMatches.length} @relation reference(s); relations are required only when multiple Prisma models are present.`
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
      passed: hasPrisma || hasDbLayer || hasTypedDomainDataModule || hasLocalFirstDataBoundary,
      blocking: true,
      detail: hasLocalFirstDataBoundary
        ? "App has typed local-first data modules plus a route/storage boundary."
        : hasTypedDomainDataModule
          ? "App has a typed domain data module suitable for a lightweight Vercel app."
          : "App has Prisma schema or an explicit server-side data layer.",
    },
    {
      id: "mutation-boundary",
      passed:
        hasServerAction ||
        hasRouteHandler ||
        hasLocalStorageHelper ||
        (hasStatefulInteraction && (hasSavedOrSuccessState || hasSelectionControl || hasEditOrSecondaryAction)),
      blocking: true,
      detail: `Server Action present: ${hasServerAction}; API routes: ${apiRoutes.length}; local storage helper=${hasLocalStorageHelper}; stateful local mutation=${hasStatefulInteraction && (hasSavedOrSuccessState || hasSelectionControl || hasEditOrSecondaryAction)}.`,
    },
    {
      id: "interaction-feedback",
      passed: hasInteractions,
      blocking: true,
      detail: "UI includes forms, buttons, React state, or event handlers for visible state changes.",
    },
    {
      id: "interaction-model-depth",
      passed:
        interactionSignalCount >= 3 &&
        hasStatefulInteraction &&
        (hasInputControl || hasSelectionControl || hasFilterOrSortControl || hasEditOrSecondaryAction) &&
        hasAdvancedInteraction &&
        (!inputHeavyProduct || (hasEditOrSecondaryAction && hasDateOrPeriodControl && hasFocusTreatment)),
      blocking: true,
      detail: `Interaction signals: stateful=${hasStatefulInteraction}; input=${hasInputControl}; selection=${hasSelectionControl}; filter/sort=${hasFilterOrSortControl}; date/period=${hasDateOrPeriodControl}; edit/secondary=${hasEditOrSecondaryAction}; history/grouping=${hasHistoryGrouping}; focus=${hasFocusTreatment}; inputHeavy=${inputHeavyProduct}. Expected at least three real interaction mechanisms, and input-heavy products also need edit/date/focus affordances.`,
    },
    {
      id: "domain-interaction-affordances",
      passed:
        !inputHeavyProduct ||
        (hasInputControl && hasEditOrSecondaryAction && hasDateOrPeriodControl && hasHistoryGrouping && hasFocusTreatment),
      blocking: true,
      detail: inputHeavyProduct
        ? `Input-heavy app detected; required input, edit/revise/delete, date/month navigation, grouped history, and focus treatment. Found input=${hasInputControl}; edit=${hasEditOrSecondaryAction}; date=${hasDateOrPeriodControl}; groupedHistory=${hasHistoryGrouping}; focus=${hasFocusTreatment}.`
        : "Not an input-heavy diary/journal/tracker/planner app; domain-specific interaction affordance gate not applicable.",
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
      id: "domain-visual-media",
      passed: !mediaHeavyProduct || hasScreenshotDetectableMedia,
      blocking: true,
      detail: mediaHeavyProduct
        ? `Media-heavy product detected; visible source-declared media=${hasScreenshotDetectableMedia}; visual data fields=${hasVisualDataFields}. Repeated cards/detail surfaces should use <img>/<Image> media or role="img" data-visual CSS illustrations with alt/aria labels. This finding is advisory.`
        : "Product is not media-heavy; visible media advisory not applicable.",
    },
    {
      id: "media-heavy-home-media",
      passed: !mediaHeavyProduct || mediaHeavyRootHasMedia,
      blocking: true,
      detail: mediaHeavyProduct
        ? `Media-heavy product detected; root route visible source-declared media=${mediaHeavyRootHasMedia}. The first screen/home route should render visible <img>/<Image> media or role="img" data-visual illustrations, not only text cards or background gradients. This finding is advisory.`
        : "Product is not media-heavy; home media advisory not applicable.",
    },
    {
      id: "saved-route-populated",
      passed: shallowSavedRoutes.length === 0,
      blocking: true,
      detail: shallowSavedRoutes.length
        ? `Saved/favorites route(s) need populated saved-item cards plus filter/remove/star controls: ${shallowSavedRoutes
            .map((route) => `${route.path} items=${route.itemSignals} filters=${route.filterSignals} actions=${route.actionSignals} seeded=${route.seededSignals}`)
            .join("; ")}. Do not ship a favorites/saved page that only shows an empty state or hides populated cards behind empty localStorage; seed visible saved items for first load plus empty-state copy for filtered/no-result cases.`
        : savedRouteReports.length
          ? `Saved/favorites route depth looks populated across ${savedRouteReports.length} route(s).`
          : "No saved/favorites route detected; gate not applicable.",
    },
    {
      id: "travel-itinerary-depth",
      passed: !travelItineraryReport.applicable || travelItineraryReport.passed,
      blocking: true,
      detail: travelItineraryReport.applicable
        ? `Travel itinerary depth: days=${travelItineraryReport.dayCount}; default place counts=${travelItineraryReport.defaultPlaceCounts.join(", ") || "(none)"}; alternate place counts=${travelItineraryReport.alternatePlaceCounts.join(", ") || "(none)"}; location/detail routes=${travelItineraryReport.detailRouteCount}; detail-specific copy fields=${travelItineraryReport.detailCopySignals}. Multi-day travel apps need at least 3 days, at least 4 default places on each day, working day/place detail routes, and detail-page copy that is deeper than card descriptions.`
        : "Product is not a multi-day travel itinerary; gate not applicable.",
    },
    {
      id: "travel-place-visual-specificity",
      passed: !travelVisualReport.applicable || travelVisualReport.passed,
      blocking: true,
      detail: travelVisualReport.applicable
        ? `Travel visual specificity: place media fields=${travelVisualReport.placeMediaFields}; place media bindings=${travelVisualReport.placeMediaBindings}; per-place visual branches=${travelVisualReport.placeVisualBranches}; generic type-only visual=${travelVisualReport.genericTypeOnlyVisual}; generic visual assets=${travelVisualReport.genericVisualAssets}. Place cards and detail pages need destination-specific photos/SVG/data visuals keyed by place id/slug/name, not one generic scenic/dining illustration or repeated day-default artwork.`
        : "Product is not a travel/place media app; gate not applicable.",
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
      id: "app-router-client-not-found",
      passed: clientNotFoundPageFiles.length === 0,
      blocking: true,
      detail: clientNotFoundPageFiles.length
        ? `Client App Router page(s) call notFound(): ${clientNotFoundPageFiles.join(", ")}. Keep dynamic page files as Server Components that accept params, or render a client fallback state without notFound().`
        : "Client App Router pages do not call notFound().",
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
      id: "travel-cost-field-consistency",
      passed: !travelCostFieldReport.applicable || travelCostFieldReport.passed,
      blocking: true,
      detail: travelCostFieldReport.applicable
        ? `Travel cost fields: costPerPerson=${travelCostFieldReport.hasCostPerPerson}; cost property=${travelCostFieldReport.hasCostProperty}; .cost accesses=${travelCostFieldReport.directCostAccesses.join(", ") || "(none)"}. If place data uses costPerPerson/pricePerPerson, all card/detail components must read that exact field or define a typed cost alias consistently.`
        : "Product is not a travel budget/place app with per-person costs; gate not applicable.",
    },
    {
      id: "travel-place-field-contract",
      passed: !travelPlaceFieldReport.applicable || travelPlaceFieldReport.passed,
      blocking: true,
      detail: travelPlaceFieldReport.applicable
        ? `Travel place field contract: declared Place fields=${travelPlaceFieldReport.declaredFields.join(", ") || "(none)"}; place field accesses=${travelPlaceFieldReport.accessedFields.join(", ") || "(none)"}; missing fields=${travelPlaceFieldReport.missingFields.join(", ") || "(none)"}. Place card/detail components must only read fields declared on the Place type/interface, or the type, seed data, and components must be updated together.`
        : "No typed Place field contract detected; gate not applicable.",
    },
    {
      id: "travel-dynamic-route-contract",
      passed: !travelRouteContractReport.applicable || travelRouteContractReport.passed,
      blocking: true,
      detail: travelRouteContractReport.applicable
        ? `Travel dynamic route contract: day routes=${travelRouteContractReport.dayRouteCount}; place routes=${travelRouteContractReport.placeRouteCount}; day ids=${travelRouteContractReport.dayIds.join(", ") || "(none)"}; place ids=${travelRouteContractReport.placeIds.join(", ") || "(none)"}; day lookups=${travelRouteContractReport.dayLookupSignals}; place lookups=${travelRouteContractReport.placeLookupSignals}; linked day samples=${travelRouteContractReport.linkedDaySamples.join(", ") || "(none)"}; linked place samples=${travelRouteContractReport.linkedPlaceSamples.join(", ") || "(none)"}; fallback copy=${travelRouteContractReport.fallbackSignals}. Multi-day travel apps with dynamic day/place routes must resolve real seeded ids from those route params instead of shipping detail pages that default to not-found or empty content.`
        : "Product is not a multi-day travel app with dynamic travel routes; gate not applicable.",
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
      passed: !hasLocalStoragePrimary || hasPrisma || hasDbLayer || hasLocalFirstDataBoundary,
      blocking: true,
      detail: hasLocalStoragePrimary
        ? hasLocalFirstDataBoundary
          ? "Browser storage is paired with typed domain data and local-first storage helpers."
          : "Browser storage appears in code; ensure it is only ephemeral and backed by server data or explicit local-first data helpers."
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
      passed: (hasLoadingState || hasSavingState || hasSavedOrSuccessState) && hasEmptyState && hasErrorState,
      blocking: true,
      detail: `Loading/pending/success: ${hasLoadingState || hasSavingState || hasSavedOrSuccessState}; Empty: ${hasEmptyState}; Error handling: ${hasErrorState}. Lightweight candidates need empty, recovery, and loading/pending/success state evidence.`,
    },
    {
      id: "workflow-state-depth",
      passed: hasSavedOrSuccessState && (hasSavingState || hasSelectionControl || hasLocalStorageHelper),
      blocking: true,
      detail: `Saving/submitting state: ${hasSavingState}; selected/local state: ${hasSelectionControl || hasLocalStorageHelper}; saved/success/completed state: ${hasSavedOrSuccessState}. Primary workflows need visible progress or local state plus an outcome state.`,
    },
    {
      id: "commercial-product-identity",
      passed: hasProductIdentity,
      blocking: true,
      detail: "App exposes a clear named product identity and domain-specific first-viewport signal.",
    },
  ];
  const normalizedChecks = checks.map((check) => ({
    ...check,
    blocking: isHardQualityAuditCheck(check.id),
  }));
  const blockingFailures = normalizedChecks.filter((check) => check.blocking && !check.passed).length;
  return {
    status: blockingFailures === 0 ? "passed" : "failed",
    blockingFailures,
    checks: normalizedChecks,
    summary:
      blockingFailures === 0
        ? "Generated app passes the static engineering audit; product-quality findings are advisory only."
        : `Generated app has ${blockingFailures} blocking engineering audit failure${blockingFailures === 1 ? "" : "s"}.`,
  };
}

function isHardQualityAuditCheck(id: string): boolean {
  return HARD_QUALITY_AUDIT_CHECK_IDS.has(id);
}

const HARD_QUALITY_AUDIT_CHECK_IDS = new Set([
  "next-app-scaffold",
  "app-router-client-boundary",
  "app-router-client-not-found",
  "strict-null-narrowing",
  "declared-import-dependencies",
  "deploy-contract",
]);

function isAuditableSourcePath(path: string): boolean {
  return !(
    path.startsWith(".next/") ||
    path.startsWith("out/") ||
    path.startsWith("node_modules/") ||
    path.startsWith("dist/") ||
    path.startsWith("coverage/") ||
    path.endsWith(".map")
  );
}

function analyzeRouteSurface(
  path: string,
  uiFileMap: Map<string, string>,
): { path: string; passed: boolean; controls: number; modules: number; codeLength: number } {
  const bundle = collectRouteSurfaceBundle(path, uiFileMap);
  const controls = countMatches(
    bundle,
    /<button\b|<input\b|<textarea\b|<select\b|<form\b|<a\s|<Link\b|\bonClick=|\bonChange=|\bonSubmit=|formAction=|href=|role=["'](?:button|tab|switch|checkbox|link)["']/gi,
  );
  const modules = countMatches(
    bundle,
    /<section\b|<article\b|<ul\b|<ol\b|<li\b|\.map\(|Array\.from\(|entries|records|items|history|detail|stats|settings|filter|chart|card|list|empty-state|loading/i,
  );
  const codeLength = bundle.replace(/\s+/g, " ").trim().length;
  const isRoot = path === "src/app/page.tsx" || path === "src/app/page.jsx";
  const minimumControls = isRoot ? 2 : 2;
  const minimumModules = isRoot ? 2 : 1;
  const minimumCodeLength = isRoot ? 700 : 450;

  return {
    path,
    controls,
    modules,
    codeLength,
    passed: controls >= minimumControls && modules >= minimumModules && codeLength >= minimumCodeLength,
  };
}

function collectRouteSurfaceBundle(path: string, uiFileMap: Map<string, string>): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  const visit = (currentPath: string, depth: number) => {
    if (seen.has(currentPath) || depth > 3) {
      return;
    }
    seen.add(currentPath);
    const content = uiFileMap.get(currentPath);
    if (!content) {
      return;
    }
    parts.push(`--- ${currentPath}\n${content}`);
    for (const specifier of extractLocalImportSpecifiers(content)) {
      const resolved = resolveLocalImport(currentPath, specifier, uiFileMap);
      if (resolved) {
        visit(resolved, depth + 1);
      }
    }
  };

  visit(path, 0);
  return parts.join("\n");
}

function hasScreenshotMediaMarkup(content: string): boolean {
  return /<img\b[\s\S]{0,500}\bsrc=|<Image\b[\s\S]{0,500}\bsrc=|role=["']img["'][\s\S]{0,500}data-visual|data-visual[\s\S]{0,500}role=["']img["']|aria-label=["'][^"']*(?:景点|地点|城市|照片|图片|插画|illustration|visual|photo|image|place|destination|venue|dish|product)[^"']*["'][\s\S]{0,500}data-visual/i.test(content);
}

function analyzeTravelItineraryDepth(
  fileContent: string,
  uiFileMap: Map<string, string>,
): {
  applicable: boolean;
  passed: boolean;
  dayCount: number;
  defaultPlaceCounts: number[];
  alternatePlaceCounts: number[];
  detailRouteCount: number;
  detailCopySignals: number;
} {
  const travelApp = /travel|trip|itinerary|destination|place|旅行|旅游|行程|景点|地点|目的地|上海/i.test(fileContent);
  const multiDaySignals = countMatches(
    fileContent,
    /\b(?:dayNumber|dayIndex|dayId|tripDays|itineraryDays|placeIds|altPlaceIds|activityIds|rainyActivityIds|第[一二三四五六七八九十]+天|D\d)\b/gi,
  );
  const applicable = travelApp && multiDaySignals >= 2;
  if (!applicable) {
    return {
      applicable,
      passed: true,
      dayCount: 0,
      defaultPlaceCounts: [],
      alternatePlaceCounts: [],
      detailRouteCount: 0,
      detailCopySignals: 0,
    };
  }

  const defaultPlaceCounts = extractArrayPropertyLengths(fileContent, [
    "defaultPlaceIds",
    "defaultPlaces",
    "primaryPlaceIds",
    "primaryPlaces",
    "sunnyPlaceIds",
    "sunnyPlaces",
    "sunPlaceIds",
    "sunPlaces",
    "placesSun",
    "placeIds",
    "places",
    "activityIds",
    "activities",
    "defaultActivityIds",
    "defaultActivities",
    "stops",
    "stopIds",
    "items",
  ]).filter((count) => count > 0);
  const alternatePlaceCounts = extractArrayPropertyLengths(fileContent, [
    "altPlaceIds",
    "altPlaces",
    "altActivityIds",
    "altActivities",
    "rainyPlaceIds",
    "rainyPlaces",
    "rainyActivityIds",
    "rainyActivities",
    "backupPlaceIds",
    "backupPlaces",
    "backupActivityIds",
    "backupActivities",
    "alternativePlaceIds",
    "alternativePlaces",
    "alternativeActivityIds",
    "alternativeActivities",
    "alternatePlaceIds",
    "alternatePlaces",
    "alternateActivityIds",
    "alternateActivities",
    "alternateIds",
    "rainPlaceIds",
    "rainPlaces",
    "placesRain",
  ]).filter((count) => count > 0);
  const dayNumbers = new Set(
    [...fileContent.matchAll(/\bday(?:Number|Index|Id)\s*:\s*(\d+)/gi)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value)),
  );
  const dayIds = new Set(
    [...fileContent.matchAll(/\bid\s*:\s*(?:["'](?:day-|d)?(\d+)["']|(\d+))/gi)]
      .map((match) => Number(match[1] ?? match[2]))
      .filter((value) => Number.isFinite(value)),
  );
  const routeDaySegments = new Set(
    [...uiFileMap.keys()]
      .filter((path) => /^src\/app\/(?:itineraries|itinerary|days?|trips?)\/\[[^\]]+\]\/page\.(?:tsx|jsx)$/.test(path))
      .flatMap(() => [1, 2, 3]),
  );
  const dayCount = Math.max(dayNumbers.size, dayIds.size, defaultPlaceCounts.length, routeDaySegments.size);
  const detailRouteCount = [...uiFileMap.keys()].filter(isTravelPlaceRoutePath).length;
  const detailCopySignals = countMatches(
    fileContent,
    /\b(?:story|note|whyGo|visitReason|vibe|routeNote|editorNote|duration|bestTime|transport|nearby|reservation|rainyTip|photoTip|mustTry|highlights|小贴士|亮点|交通|时长|预约|雨天|拍照|附近|推荐理由|路线)\b/gi,
  );
  const defaultDaysDeep = defaultPlaceCounts.length >= 3 && defaultPlaceCounts.every((count) => count >= 4);
  const alternateDaysUseful = alternatePlaceCounts.length === 0 || alternatePlaceCounts.every((count) => count >= 2);

  return {
    applicable,
    passed: dayCount >= 3 && defaultDaysDeep && alternateDaysUseful && detailRouteCount >= 1 && detailCopySignals >= 4,
    dayCount,
    defaultPlaceCounts,
    alternatePlaceCounts,
    detailRouteCount,
    detailCopySignals,
  };
}

function analyzeTravelPlaceVisualSpecificity(
  fileContent: string,
  uiFileMap: Map<string, string>,
): {
  applicable: boolean;
  passed: boolean;
  placeMediaFields: number;
  placeMediaBindings: number;
  placeVisualBranches: number;
  genericTypeOnlyVisual: boolean;
  genericVisualAssets: number;
} {
  const applicable = /travel|trip|itinerary|destination|place|venue|旅行|旅游|行程|景点|地点|目的地|上海/i.test(fileContent);
  if (!applicable) {
    return {
      applicable,
      passed: true,
      placeMediaFields: 0,
      placeMediaBindings: 0,
      placeVisualBranches: 0,
      genericTypeOnlyVisual: false,
      genericVisualAssets: 0,
    };
  }

  const placeMediaFields = countMatches(
    fileContent,
    /\b(?:image|images|imageUrl|imageSrc|photo|photos|photoUrl|photoUrls|visual|visualLabel|illustration|media|mediaUrl|mediaUrls|svgPath|accentShape)\b\s*[:=]/gi,
  );
  const visualBundles = [...uiFileMap.entries()]
    .filter(([path, content]) => /Visual|Media|Photo|Image|Illustration|视觉|图片|插画/i.test(path) || /data-visual|role=["']img["']|<img\b|<Image\b/.test(content))
    .map(([, content]) => content)
    .join("\n");
  const placeVisualBranches = Math.max(countMatches(
    visualBundles,
    /\b(?:placeId|place\.id|slug|name)\b[\s\S]{0,120}(?:case\s+["']|===\s*["']|includes\(|startsWith\(|visualMap|visualsBy|placeVisuals|Record<)/gi,
  ), countVisualMapEntries(visualBundles));
  const placeMediaBindings = countMatches(
    visualBundles,
    /(?:<img\b|<Image\b)[\s\S]{0,500}\bsrc=\{[^}]*\b(?:place|location|destination|venue|activity|stop)\.(?:images?\s*\[\s*[^\]]+\s*\]|photos?\s*\[\s*[^\]]+\s*\]|imageUrl|imageSrc|photoUrl|photo|mediaUrl|visualUrl|heroImage|coverImage)(?![\w$])[^}]*\}|\b(?:backgroundImage|--[A-Za-z0-9_-]*image)\s*[:=][\s\S]{0,220}\b(?:place|location|destination|venue|activity|stop)\.(?:images?\s*\[\s*[^\]]+\s*\]|photos?\s*\[\s*[^\]]+\s*\]|imageUrl|imageSrc|photoUrl|photo|mediaUrl|visualUrl|heroImage|coverImage)(?![\w$])/gi,
  );
  const genericTypeOnlyVisual =
    /\btype\s*:\s*["'](?:scenic|dining|attraction|restaurant)|type\s*===\s*["'](?:scenic|dining|attraction|restaurant)|isScenic|isDining/i.test(
      visualBundles,
    ) && placeVisualBranches === 0 && placeMediaBindings === 0;
  const genericVisualAssets = countMatches(fileContent, /day-default\.svg|place-default\.svg|placeholder(?:[-_]?image|[-_]?photo|[-_]?visual)?|defaultVisual/gi);
  const hasSpecificVisuals = placeVisualBranches >= 3 || (placeMediaFields >= 2 && placeMediaBindings > 0);

  return {
    applicable,
    passed: hasSpecificVisuals && !genericTypeOnlyVisual,
    placeMediaFields,
    placeMediaBindings,
    placeVisualBranches,
    genericTypeOnlyVisual,
    genericVisualAssets,
  };
}

function countVisualMapEntries(content: string): number {
  let maxEntries = 0;
  const visualMapName =
    "(?:placeVisuals|visualsBy[A-Za-z_$][\\w$]*|[A-Za-z_$][\\w$]*Visuals|svgComponents|visualComponents|placeSvgComponents|placeIllustrations|illustrationsByPlace)";
  const mapPattern = new RegExp(`\\b${visualMapName}\\s*(?::[^=;]+)?=\\s*\\{`, "g");
  let match: RegExpExecArray | null;
  while ((match = mapPattern.exec(content))) {
    const start = match.index + match[0].length - 1;
    const end = findBalancedDelimiterEnd(content, start, "{", "}");
    if (end === -1) {
      continue;
    }
    maxEntries = Math.max(maxEntries, countTopLevelDelimitedItems(content.slice(start + 1, end)));
    mapPattern.lastIndex = end + 1;
  }
  const assignmentPattern = new RegExp(`\\b${visualMapName}\\s*\\[\\s*["'\`][a-z0-9][a-z0-9_-]{1,48}["'\`]\\s*\\]\\s*=`, "gi");
  maxEntries = Math.max(maxEntries, countMatches(content, assignmentPattern));
  return maxEntries;
}

function extractArrayPropertyLengths(content: string, propertyNames: string[]): number[] {
  const propertySet = new Set(propertyNames.map((name) => name.toLowerCase()));
  const topLevelArrayLengths = collectTopLevelArrayLengths(content);
  const lengths: number[] = [];
  const propertyPattern = /\b([A-Za-z_$][\w$]*)\s*:\s*\[/g;
  let match: RegExpExecArray | null;
  while ((match = propertyPattern.exec(content))) {
    const propertyName = match[1]?.toLowerCase();
    if (!propertyName || !propertySet.has(propertyName)) {
      continue;
    }
    const start = match.index + match[0].length - 1;
    const end = findBalancedDelimiterEnd(content, start, "[", "]");
    if (end === -1) {
      continue;
    }
    lengths.push(countArrayItems(content.slice(start + 1, end)));
    propertyPattern.lastIndex = end + 1;
  }
  const referencePattern = /\b([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\b(?!\s*\.)/g;
  while ((match = referencePattern.exec(content))) {
    const propertyName = match[1]?.toLowerCase();
    const referencedName = match[2];
    if (!propertyName || !referencedName || !propertySet.has(propertyName)) {
      continue;
    }
    const length = topLevelArrayLengths.get(referencedName);
    if (length !== undefined) {
      lengths.push(length);
    }
  }
  return lengths;
}

function collectTopLevelArrayLengths(content: string): Map<string, number> {
  const lengths = new Map<string, number>();
  const declarationPattern = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*\[/g;
  let match: RegExpExecArray | null;
  while ((match = declarationPattern.exec(content))) {
    const name = match[1];
    if (!name) {
      continue;
    }
    const start = match.index + match[0].length - 1;
    const end = findBalancedDelimiterEnd(content, start, "[", "]");
    if (end === -1) {
      continue;
    }
    lengths.set(name, countArrayItems(content.slice(start + 1, end)));
    declarationPattern.lastIndex = end + 1;
  }
  return lengths;
}

function countArrayItems(rawItems: string): number {
  const trimmed = rawItems.trim();
  if (!trimmed) {
    return 0;
  }
  return countTopLevelDelimitedItems(trimmed);
}

function countTopLevelDelimitedItems(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) {
    return 0;
  }
  let depth = 0;
  let count = 1;
  let sawToken = false;
  let inString: string | null = null;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      sawToken = true;
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
      sawToken = true;
      inString = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      sawToken = true;
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      sawToken = true;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "," && depth === 0) {
      count += 1;
      sawToken = false;
      continue;
    }
    if (!/\s/.test(char)) {
      sawToken = true;
    }
  }
  return sawToken ? count : Math.max(0, count - 1);
}

function findBalancedDelimiterEnd(content: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
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
    if (char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function analyzeTravelCostFieldConsistency(
  fileContent: string,
  uiContent: string,
): {
  applicable: boolean;
  passed: boolean;
  hasCostPerPerson: boolean;
  hasCostProperty: boolean;
  directCostAccesses: string[];
} {
  const travelBudgetApp = /travel|trip|itinerary|place|budget|旅行|旅游|行程|景点|地点|预算|人均/i.test(fileContent);
  const hasCostPerPerson = /\b(?:costPerPerson|pricePerPerson|perPersonCost|perPersonPrice)\b\s*[:=]/i.test(fileContent);
  const hasCostProperty = /\bcost\s*[:=]/i.test(fileContent);
  const directCostAccesses = [
    ...new Set(
      [...uiContent.matchAll(/\b(?:place|item|stop|entry)\.cost\b/gi)]
        .map((match) => match[0])
        .filter(Boolean),
    ),
  ];
  const applicable = travelBudgetApp && hasCostPerPerson;
  return {
    applicable,
    passed: !applicable || directCostAccesses.length === 0 || hasCostProperty,
    hasCostPerPerson,
    hasCostProperty,
    directCostAccesses,
  };
}

function analyzeTravelPlaceFieldContract(
  textFiles: Array<{ path: string; content: string }>,
  uiContent: string,
): {
  applicable: boolean;
  passed: boolean;
  declaredFields: string[];
  accessedFields: string[];
  missingFields: string[];
} {
  const sourceContent = textFiles
    .filter((file) => /\.(?:ts|tsx|js|jsx)$/i.test(file.path))
    .map((file) => file.content)
    .join("\n");
  const travelPlaceApp = /travel|trip|itinerary|place|destination|旅行|旅游|行程|景点|地点|目的地|上海/i.test(sourceContent);
  const declaredFields = extractDeclaredObjectFields(sourceContent, "Place");
  const accessedFields = [
    ...new Set(
      [...uiContent.matchAll(/\bplace\.([A-Za-z_$][\w$]*)\b/g)]
        .map((match) => match[1])
        .filter((field): field is string => Boolean(field))
        .filter((field) => !["map", "filter", "find", "some", "every", "length"].includes(field)),
    ),
  ].sort();
  const missingFields = declaredFields.length
    ? accessedFields.filter((field) => !declaredFields.includes(field))
    : [];
  const applicable = travelPlaceApp && declaredFields.length > 0 && accessedFields.length > 0;
  return {
    applicable,
    passed: !applicable || missingFields.length === 0,
    declaredFields,
    accessedFields,
    missingFields,
  };
}

function analyzeTravelDynamicRouteContract(
  fileContent: string,
  uiFileMap: Map<string, string>,
): {
  applicable: boolean;
  passed: boolean;
  dayRouteCount: number;
  placeRouteCount: number;
  dayIds: string[];
  placeIds: string[];
  dayLookupSignals: number;
  placeLookupSignals: number;
  linkedDaySamples: string[];
  linkedPlaceSamples: string[];
  fallbackSignals: number;
} {
  const travelApp = /travel|trip|itinerary|destination|place|旅行|旅游|行程|景点|地点|目的地|上海/i.test(fileContent);
  const multiDaySignals = countMatches(
    fileContent,
    /\b(?:dayNumber|dayIndex|dayId|tripDays|itineraryDays|placeIds|altPlaceIds|activityIds|rainyActivityIds|第[一二三四五六七八九十]+天|D\d)\b/gi,
  );
  const dayRoutePaths = [...uiFileMap.keys()].filter((path) =>
    /^src\/app\/(?:.+\/)?(?:itineraries|itinerary|days?|trips?)\/\[[^\]]+\]\/page\.(?:tsx|jsx)$/.test(path),
  );
  const placeRoutePaths = [...uiFileMap.keys()].filter(isTravelPlaceRoutePath);
  const applicable = travelApp && multiDaySignals >= 2 && (dayRoutePaths.length > 0 || placeRoutePaths.length > 0);
  if (!applicable) {
    return {
      applicable,
      passed: true,
      dayRouteCount: dayRoutePaths.length,
      placeRouteCount: placeRoutePaths.length,
      dayIds: [],
      placeIds: [],
      dayLookupSignals: 0,
      placeLookupSignals: 0,
      linkedDaySamples: [],
      linkedPlaceSamples: [],
      fallbackSignals: 0,
    };
  }

  const dayBundles = dayRoutePaths.map((path) => collectRouteSurfaceBundle(path, uiFileMap)).join("\n");
  const placeBundles = placeRoutePaths.map((path) => collectRouteSurfaceBundle(path, uiFileMap)).join("\n");
  const dayIds = extractTravelDayIds(fileContent);
  const placeIds = extractTravelPlaceIds(fileContent);
  const dayLookupSignals =
    countMatches(dayBundles, /\b(?:days|tripDays|itineraryDays|dayPlans|itineraries)\.find\s*\(/gi) +
    countMatches(dayBundles, /\b(?:getDayById|resolveDay|findDay|selectDay|dayById)\b/gi) +
    countMatches(
      dayBundles,
      /\bday(?:Number|Index)\b[\s\S]{0,100}\b(?:dayId|params|slug)\b|\b(?:dayId|params|slug)\b[\s\S]{0,100}\bday(?:Number|Index)\b/gi,
    );
  const placeLookupSignals =
    countMatches(placeBundles, /\b(?:places|tripPlaces|allPlaces|locations|destinations|venues|activities|tripActivities|allActivities)\.find\s*\(/gi) +
    countMatches(placeBundles, /\b(?:getPlaceById|resolvePlace|findPlace|selectPlace|placeById|getLocationById|getDestinationById|getActivityById|resolveActivity|findActivity|selectActivity|activityById)\b/gi) +
    countMatches(placeBundles, /\bflatMap\s*\([^)]*(?:places|placeIds|locations|destinations|activities|activityIds)/gi);
  const linkedDaySamples = extractLinkedRouteSamples(fileContent, ["itineraries", "itinerary", "days", "day", "trips", "trip"]);
  const linkedPlaceSamples = extractLinkedRouteSamples(fileContent, [
    "place",
    "places",
    "location",
    "locations",
    "destination",
    "destinations",
    "venue",
    "venues",
    "activity",
    "activities",
    "stop",
    "stops",
  ]);
  const fallbackSignals = countMatches(
    `${dayBundles}\n${placeBundles}`,
    /未找到|找不到|不存在|暂无|没有匹配|not\s+found|no\s+(?:day|place|location|destination|venue)\s+found|empty[\s-]?state/gi,
  );

  return {
    applicable,
    passed:
      dayRoutePaths.length > 0 &&
      placeRoutePaths.length > 0 &&
      dayIds.length >= 3 &&
      placeIds.length >= 4 &&
      dayLookupSignals > 0 &&
      placeLookupSignals > 0,
    dayRouteCount: dayRoutePaths.length,
    placeRouteCount: placeRoutePaths.length,
    dayIds,
    placeIds,
    dayLookupSignals,
    placeLookupSignals,
    linkedDaySamples,
    linkedPlaceSamples,
    fallbackSignals,
  };
}

function extractTravelDayIds(fileContent: string): string[] {
  const ids = new Set<string>();
  for (const match of fileContent.matchAll(/\bid\s*:\s*(?:["'`](day-?\d+|d\d+|\d+)["'`]|(\d+))/gi)) {
    const value = (match[1] ?? match[2])?.toLowerCase();
    if (value) {
      ids.add(value);
    }
  }
  for (const match of fileContent.matchAll(/\bday(?:Number|Index|Id)\s*:\s*(\d+)/gi)) {
    const value = match[1];
    if (value) {
      ids.add(value);
    }
  }
  for (const match of fileContent.matchAll(/\bday\s*:\s*(?:["'`](\d+)["'`]|(\d+))/gi)) {
    const value = match[1] ?? match[2];
    if (value) {
      ids.add(value);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function isTravelPlaceRoutePath(path: string): boolean {
  return /^src\/app\/(?:.+\/)?(?:places?|locations?|destinations?|venues?|activity|activities|stops?)\/\[[^\]]+\]\/page\.(?:tsx|jsx)$/.test(path);
}

function extractTravelPlaceIds(fileContent: string): string[] {
  const ids = new Set<string>();
  for (const value of extractArrayStringValues(fileContent, [
    "placeIds",
    "placesSun",
    "altPlaceIds",
    "alternateIds",
    "rainyPlaceIds",
    "rainPlaceIds",
    "placesRain",
    "backupPlaceIds",
    "alternativePlaceIds",
    "favoritePlaceIds",
    "savedPlaceIds",
    "activityIds",
    "defaultActivityIds",
    "altActivityIds",
    "rainyActivityIds",
    "backupActivityIds",
    "alternativeActivityIds",
    "favoriteActivityIds",
    "savedActivityIds",
  ])) {
    if (isLikelyTravelPlaceId(value)) {
      ids.add(value);
    }
  }
  for (const match of fileContent.matchAll(/\bid\s*:\s*["'`]([a-z0-9][a-z0-9_-]{1,48})["'`]/gi)) {
    const value = match[1]?.toLowerCase();
    if (value && isLikelyTravelPlaceId(value)) {
      ids.add(value);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function extractArrayStringValues(fileContent: string, propertyNames: string[]): string[] {
  const names = propertyNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`\\b(?:${names})\\s*:\\s*\\[([\\s\\S]*?)\\]`, "gi");
  return [
    ...new Set(
      [...fileContent.matchAll(pattern)].flatMap((match) =>
        [...(match[1] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)]
          .map((valueMatch) => valueMatch[1]?.trim().toLowerCase())
          .filter((value): value is string => Boolean(value)),
      ),
    ),
  ];
}

function isLikelyTravelPlaceId(value: string): boolean {
  return (
    value.length >= 2 &&
    !/^(?:all|default|none|empty|sunny|rainy|food|foods|dining|scenic|restaurant|restaurants|attraction|attractions|hotel|hotels|must|saved|favorite|favorites|day-?\d+|d\d+|\d+)$/.test(
      value,
    )
  );
}

function extractLinkedRouteSamples(fileContent: string, routeNames: string[]): string[] {
  const names = routeNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp("\\/(?:" + names + ")\\/([^\"'`\\s?#){}]+)", "gi");
  return [
    ...new Set(
      [...fileContent.matchAll(pattern)]
        .map((match) => match[1]?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value && value !== "$" && !value.includes("$"))),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function extractDeclaredObjectFields(sourceContent: string, typeName: string): string[] {
  const escapedName = typeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [
    ...sourceContent.matchAll(new RegExp(`\\binterface\\s+${escapedName}\\s*\\{([\\s\\S]*?)\\}`, "g")),
    ...sourceContent.matchAll(new RegExp(`\\btype\\s+${escapedName}\\s*=\\s*\\{([\\s\\S]*?)\\}`, "g")),
  ];
  const fields = new Set<string>();
  for (const block of blocks) {
    const body = block[1] ?? "";
    const matches = body.matchAll(/(?:^|[;\n])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm);
    for (const match of matches) {
      const field = match[1];
      if (field) {
        fields.add(field);
      }
    }
  }
  return [...fields].sort();
}

function analyzeSavedRouteSurface(
  path: string,
  uiFileMap: Map<string, string>,
): { path: string; passed: boolean; itemSignals: number; filterSignals: number; actionSignals: number; seededSignals: number } {
  const bundle = collectRouteSurfaceBundle(path, uiFileMap);
  const itemSignals = countMatches(bundle, /<article\b|<li\b|\.map\(|FavoriteCard|SavedCard|PlaceCard|收藏卡|savedItem|favoriteItem/gi);
  const filterSignals = countMatches(bundle, /filter|segment|category|tag|chip|全部|景点|餐饮|筛选|分类|标签|aria-pressed|aria-selected/gi);
  const actionSignals = countMatches(bundle, /remove|delete|star|must|toggle|favorite|bookmark|移除|删除|必去|星标|收藏|onClick=/gi);
  const seededSignals = countMatches(
    bundle,
    /defaultFavorites|seedFavorites|initialFavorites|savedPlaces|favoritePlaces|initialSaved|seededFavorites|fallbackFavorites|favorites\.length\s*===\s*0\s*\?\s*places|favorites\.length\s*\?\s*favorites\s*:/gi,
  );
  const onlyEmpty =
    /empty[\s-]?state|没有收藏|暂无收藏|no saved|no favorites/i.test(bundle) &&
    itemSignals < 2 &&
    seededSignals === 0;
  const hidesPopulatedStateBehindStorage =
    /\b(?:favorites|saved|bookmarks)\.length\s*===\s*0\b[\s\S]{0,900}return\s*(?:\(|<)/i.test(bundle) &&
    /localStorage|useFavorites|useSaved|useBookmarks/i.test(bundle) &&
    seededSignals === 0;
  return {
    path,
    itemSignals,
    filterSignals,
    actionSignals,
    seededSignals,
    passed: !onlyEmpty && !hidesPopulatedStateBehindStorage && itemSignals >= 2 && filterSignals >= 2 && actionSignals >= 2,
  };
}

function extractLocalImportSpecifiers(content: string): string[] {
  return [...content.matchAll(/import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => Boolean(specifier && (specifier.startsWith("@/") || specifier.startsWith("."))));
}

function resolveLocalImport(currentPath: string, specifier: string, uiFileMap: Map<string, string>): string | null {
  const base =
    specifier.startsWith("@/")
      ? `src/${specifier.slice(2)}`
      : normalizeRelativeImportPath(currentPath, specifier);
  if (!base) {
    return null;
  }

  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.js`,
    `${base}/index.tsx`,
    `${base}/index.jsx`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ];
  return candidates.find((candidate) => uiFileMap.has(candidate)) ?? null;
}

function normalizeRelativeImportPath(currentPath: string, specifier: string): string | null {
  const currentParts = currentPath.split("/");
  currentParts.pop();
  const parts = [...currentParts];
  for (const segment of specifier.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length ? parts.join("/") : null;
}

function normalizeCssImportPath(specifier: string): string | null {
  if (!specifier.endsWith(".css")) {
    return null;
  }
  if (specifier.startsWith("@/")) {
    return `src/${specifier.slice(2)}`;
  }
  if (specifier.startsWith("src/")) {
    return specifier;
  }
  if (specifier.startsWith(".")) {
    return normalizeRelativeImportPath("src/app/layout.tsx", specifier);
  }
  return null;
}

function countMatches(content: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...content.matchAll(new RegExp(pattern.source, flags))].length;
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
      env: cleanChildEnv({
        ...process.env,
        PATH: [localBin, process.env.PATH].filter(Boolean).join(delimiter),
        DATABASE_URL: "file:./dev.db",
        ...env,
      }),
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

function cleanChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  if (next.FORCE_COLOR !== undefined) {
    delete next.NO_COLOR;
  }
  return next;
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

function summarizeWebFetchOutput(output: WebFetchResult): string {
  const contentType = output.contentType ?? "unknown";
  return `${output.status} ${contentType}; ${output.text.length} chars`;
}

function summarizeWebSearchOutput(output: { results: WebSearchResultItem[] }): string {
  if (!output.results.length) {
    return "0 results";
  }
  const highlights = output.results.slice(0, 3).map((result) => {
    let host = "";
    try {
      host = new URL(result.url).hostname.replace(/^www\./, "");
    } catch {
      host = result.url;
    }
    return host ? `${result.title} (${host})` : result.title;
  });
  return `${output.results.length} results: ${highlights.join("; ")}`;
}

function classifyToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/policy|allow list|not allowed|disabled/i.test(message)) {
    return "policy";
  }
  if (/timed out/i.test(message)) {
    return "timeout";
  }
  if (/Missing|string field|Expected|schema|input/i.test(message)) {
    return "validation";
  }
  if (/not found|Unknown/i.test(message)) {
    return "not_found";
  }
  return "execution";
}
