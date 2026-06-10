export type AgentMode = "local_generator";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ProjectStatus =
  | "draft"
  | "running"
  | "awaiting_input"
  | "awaiting_approval"
  | "promoting"
  | "ready"
  | "failed";

export type PreviewStatus = "idle" | "starting" | "ready" | "error" | "stopped";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type RunPhase =
  | "intake"
  | "context"
  | "clarify"
  | "plan"
  | "design"
  | "design_seed"
  | "architect"
  | "tool_loop"
  | "sandbox_verify"
  | "repair"
  | "approval"
  | "promote"
  | "preview"
  | "report";

export type GenerationFailureKind =
  | "model_call_failed"
  | "generation_incomplete"
  | "build_failed"
  | "preview_failed";

export type AgentTaskStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  toolName?: string;
}

export interface ClarificationOption {
  label: string;
  value: string;
  description?: string;
  preview?: string;
}

export interface ClarificationQuestion {
  id: string;
  header: string;
  question: string;
  options: ClarificationOption[];
  multiSelect?: boolean;
  required?: boolean;
}

export interface ClarificationAnswer {
  questionId: string;
  answer: string;
}

export interface ClarificationRequest {
  questions: ClarificationQuestion[];
  summary: string;
}

export interface AgentTask {
  id: string;
  title: string;
  owner:
    | "clarifier"
    | "planner"
    | "context_scout"
    | "design_director"
    | "design_seed_smith"
    | "architect"
    | "coder"
    | "critic"
    | "repairer"
    | "runtime";
  status: AgentTaskStatus;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignBrief {
  id: string;
  runId: string;
  summary: string;
  targetUser: string;
  productGoal: string;
  coreExperience: string;
  screens: string[];
  interactionModel: string[];
  visualDirection: string[];
  contentStrategy: string[];
  qualityBar: string[];
  antiPatterns: string[];
  createdAt: string;
}

/**
 * Concrete visual identity for a single run. Produced after the design brief
 * and consumed by the architect (to plan theme files) and the coder loop (to
 * apply exact colors, fonts, and bring-your-own SVG assets).
 */
export interface DesignSeedPalette {
  /** Short slug, e.g. "warm-paper-amber" or "ember-plum". */
  name: string;
  /** Primary brand / action color. CSS color value. */
  primary: string;
  /** Surface / background color. */
  surface: string;
  /** Body text / strong ink color. */
  ink: string;
  /** Accent or secondary call-to-action color. */
  accent: string;
  /** Muted UI color for borders / dividers / quiet copy. */
  muted: string;
  /** Optional gradient or pattern declaration. */
  gradient?: string;
}

export interface DesignSeedTypography {
  /** CSS font-family stack for headings, e.g. 'Lora, "Source Serif Pro", serif'. */
  headingFamily: string;
  /** Heading weight as CSS weight (string for "500", "700", or "bold"). */
  headingWeight: string;
  /** CSS font-family stack for body copy. */
  bodyFamily: string;
  /** Optional mono-space stack for metadata, timestamps, code-like UI. */
  monoFamily?: string;
  /** Short description of the type scale (e.g. "editorial display + compact body"). */
  scale: string;
}

export type DesignSeedAssetKind = "svg-component" | "static-svg" | "css-tokens";

export interface DesignSeedAsset {
  /** Sandbox-relative path where the file should be written before the coder loop starts. */
  filename: string;
  kind: DesignSeedAssetKind;
  /** Complete file contents. The orchestrator writes this verbatim. */
  content: string;
  /** Short description of why this asset exists and how it ties to the identity. */
  purpose: string;
}

export interface DesignSeed {
  id: string;
  runId: string;
  /** One-sentence visual concept, e.g. "Editorial mobile journal with botanical companion." */
  visualConcept: string;
  palette: DesignSeedPalette;
  typography: DesignSeedTypography;
  /** Short narrative on motion language — when motion is used and when restrained. */
  motionLanguage: string;
  /** Optional concrete assets (SVGs, CSS token files) to seed the sandbox. */
  assets: DesignSeedAsset[];
  /** Anti-patterns specific to this identity (e.g. "no neon gradients"). */
  antiPatterns?: string[];
  createdAt: string;
}

export interface ArchitectureFileNode {
  path: string;
  purpose: string;
  /** Other file paths this file imports / depends on. */
  dependencies?: string[];
}

export interface ArchitectureDataModel {
  name: string;
  description: string;
  fields: Array<{ name: string; type: string; description?: string }>;
}

export interface ArchitectureComponent {
  name: string;
  filePath: string;
  purpose: string;
  props?: string[];
  /** Hooks, child components, stores it relies on. */
  uses?: string[];
}

export interface ArchitectureRoute {
  path: string;
  component: string;
  description: string;
  /** Next.js file-system route file that owns this route, e.g. src/app/dashboard/page.tsx. */
  filePath?: string;
  /** Rendering mode expected for this route. */
  rendering?: "server" | "client" | "static" | "dynamic" | "isr";
}

export interface ArchitectureApiEndpoint {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  purpose: string;
  /** Next.js route handler file, e.g. src/app/api/items/route.ts. */
  filePath: string;
  request?: string;
  response?: string;
  auth?: string;
  runtime?: "nodejs" | "edge";
}

export interface ArchitectureServerAction {
  name: string;
  filePath: string;
  purpose: string;
  input?: string;
  effects?: string[];
}

export interface ArchitectureDataStore {
  provider: "sqlite" | "postgres" | "vercel-postgres" | "kv" | "blob" | "memory" | "external";
  orm?: "prisma" | "drizzle" | "none";
  schemaPath?: string;
  migrationStrategy?: string;
  seedStrategy?: string;
  persistenceNotes?: string;
}

export interface ArchitectureEnvVar {
  name: string;
  purpose: string;
  required: boolean;
  scope?: "server" | "client";
  example?: string;
}

export interface ArchitectureIntegration {
  name: string;
  purpose: string;
  envVars?: string[];
  serverFiles?: string[];
}

export interface ArchitectureQualityCheck {
  id: string;
  category: "frontend" | "backend" | "data" | "interaction" | "deployment" | "accessibility";
  requirement: string;
  evidence: string;
  blocking: boolean;
}

export interface ArchitectureExternalCapability {
  name: string;
  purpose: string;
  trigger: string;
  expectedOutput: string;
  constraints: string[];
}

export interface BuildTask {
  id: string;
  title: string;
  description: string;
  /** Files this task creates or modifies. */
  files: string[];
  /** IDs of tasks that must complete before this one starts. */
  dependsOn?: string[];
  /** What "done" looks like for this task. */
  acceptance: string;
  status?: AgentTaskStatus;
}

export interface ArchitecturePlan {
  id: string;
  runId: string;
  summary: string;
  /** High-level technical decisions, libraries chosen, etc. */
  techStack: string[];
  /** Narrative description of state architecture and data flow. */
  stateArchitecture: string;
  /** Server-side rendering, data fetching, route handler, and mutation plan. */
  serverArchitecture: string;
  /** Database or durable storage plan for the generated app. */
  dataStore: ArchitectureDataStore;
  fileTree: ArchitectureFileNode[];
  dataModels: ArchitectureDataModel[];
  components: ArchitectureComponent[];
  routes: ArchitectureRoute[];
  apiEndpoints: ArchitectureApiEndpoint[];
  serverActions: ArchitectureServerAction[];
  envVars: ArchitectureEnvVar[];
  integrations: ArchitectureIntegration[];
  qualityChecks?: ArchitectureQualityCheck[];
  externalCapabilities?: ArchitectureExternalCapability[];
  deployment: string;
  /** Ordered build tasks, smallest deliverable units. */
  tasks: BuildTask[];
  /** Critical risks / open questions identified by the architect. */
  risks?: string[];
  createdAt: string;
}

export interface ToolCallTrace {
  id: string;
  runId: string;
  toolName: string;
  status: "started" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
  sandboxOnly: boolean;
  category?: string;
  permission?: string;
  sideEffects?: string;
  riskLevel?: string;
  phase?: string;
  taskId?: string;
  artifactIds?: string[];
  errorKind?: string;
}

export interface CandidateValidation {
  status: "pending" | "passed" | "failed";
  command?: string;
  summary: string;
  warnings?: string[];
  logTail?: string;
  failureKind?: GenerationFailureKind;
}

export interface ChangedFile {
  path: string;
  changeType: "created" | "updated" | "deleted";
  additions: number;
  deletions: number;
}

export interface CandidateChangeSet {
  id: string;
  runId: string;
  baseVersion: number;
  changedFiles: ChangedFile[];
  diffSummary: string;
  validation: CandidateValidation;
  previewUrl?: string;
  sandboxPath: string;
  artifactIds: string[];
  createdAt: string;
}

export interface PreviewInfo {
  status: PreviewStatus;
  url?: string;
  candidateUrl?: string;
  lastLog?: string;
  updatedAt: string;
}

export interface VersionRecord {
  id: string;
  number: number;
  summary: string;
  createdAt: string;
  gitCommit?: string;
}

export interface SessionState {
  id: string;
  projectId: string;
  mode: AgentMode;
  messages: ChatMessage[];
  contextSummary?: string;
  tasks: AgentTask[];
  toolCalls: ToolCallTrace[];
  clarificationRequest?: ClarificationRequest;
  designBrief?: DesignBrief;
  designSeed?: DesignSeed;
  architecturePlan?: ArchitecturePlan;
  candidate?: CandidateChangeSet;
  error?: string;
  failureKind?: GenerationFailureKind;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  sessionId: string;
  mode: AgentMode;
  status: RunStatus;
  phase: RunPhase;
  userMessage?: string;
  clarificationAnswers?: ClarificationAnswer[];
  designBrief?: DesignBrief;
  designSeed?: DesignSeed;
  architecturePlan?: ArchitecturePlan;
  candidate?: CandidateChangeSet;
  tasks: AgentTask[];
  toolCalls: ToolCallTrace[];
  error?: string;
  failureKind?: GenerationFailureKind;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  mode: AgentMode;
  status: ProjectStatus;
  preview: PreviewInfo;
  session: SessionState;
  currentSessionId: string;
  currentRunId?: string;
  latestRun?: RunRecord;
  candidate?: CandidateChangeSet;
  versions: VersionRecord[];
}

export interface ProjectEvent {
  type:
    | "project.created"
    | "project.updated"
    | "project.preview_log"
    | "project.preview_ready"
    | "project.error"
    | "run.started"
    | "run.updated"
    | "run.awaiting_input"
    | "run.approval_required"
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | "candidate.created"
    | "candidate.promoted"
    | "tool.started"
    | "tool.completed"
    | "tool.failed"
    | "task.updated";
  projectId: string;
  runId?: string;
  createdAt: string;
  payload: {
    project?: ProjectRecord;
    run?: RunRecord;
    candidate?: CandidateChangeSet;
    designBrief?: DesignBrief;
    toolCall?: ToolCallTrace;
    task?: AgentTask;
    message?: string;
  };
}

export interface ProjectCreateResponse {
  project: ProjectRecord;
}

export interface RunCreateRequest {
  userMessage?: string;
  clarificationAnswers?: ClarificationAnswer[];
}

export interface RunCreateResponse {
  project: ProjectRecord;
  run: RunRecord;
}

export interface RunInputRequest {
  userMessage?: string;
  clarificationAnswers?: ClarificationAnswer[];
}

export interface RunApproveRequest {
  approved?: boolean;
  feedback?: string;
}

export interface RunApproveResponse {
  project: ProjectRecord;
  run: RunRecord;
}

export interface RunStateResponse {
  project: ProjectRecord;
  run: RunRecord;
}
