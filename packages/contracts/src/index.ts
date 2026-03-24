export type ReasoningMode = "plan_solve" | "react";

export type ChatRole = "system" | "user" | "assistant";

export type ProjectStatus =
  | "draft"
  | "clarifying"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "repairing"
  | "ready"
  | "failed"
  | "error";

export type PreviewStatus = "idle" | "starting" | "ready" | "error" | "stopped";

export type RunStatus =
  | "queued"
  | "in_progress"
  | "awaiting_input"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RunAction = "turn" | "repair" | "execute";

export type RunPhase =
  | "intake"
  | "dynamic_clarify"
  | "normalize_spec"
  | "planning"
  | "context_build"
  | "implement_loop"
  | "verify_loop"
  | "approval_interrupt"
  | "execute_dispatch"
  | "report";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  placeholder: string;
  rationale?: string;
  required?: boolean;
}

export interface ClarificationAnswer {
  questionId: string;
  answer: string;
}

export interface ClarificationDecision {
  action: "ask" | "ready" | "assume_ready";
  summary: string;
  clarityScore: number;
  missingInformation: string[];
  questions: ClarificationQuestion[];
  assumptions: string[];
}

export interface ScreenSpec {
  id: string;
  name: string;
  purpose: string;
  elements: unknown[];
}

export interface FlowSpec {
  id: string;
  name: string;
  steps: string[];
  success: string;
}

export interface DataModelNeed {
  entity: string;
  fields: string[];
  notes?: string;
}

export interface WorkingSpec {
  title?: string;
  summary?: string;
  goal?: string;
  targetUsers?: string[];
  screens?: ScreenSpec[];
  coreFlows?: FlowSpec[];
  dataModelNeeds?: DataModelNeed[];
  integrations?: unknown[];
  brandAndVisualDirection?: string;
  constraints?: string[];
  successCriteria?: string[];
  assumptions?: string[];
}

export interface AppSpec {
  appName: string;
  title: string;
  summary: string;
  goal: string;
  targetUsers: string[];
  screens: ScreenSpec[];
  coreFlows: FlowSpec[];
  dataModelNeeds: DataModelNeed[];
  integrations: string[];
  brandAndVisualDirection: string;
  constraints: string[];
  successCriteria: string[];
  assumptions: string[];
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "done";
}

export interface PatchHunk {
  search: string;
  replace: string;
  occurrence?: number;
}

export interface FileOperation {
  type: "write" | "patch" | "delete";
  path: string;
  summary?: string;
  content?: string;
  hunks?: PatchHunk[];
  fallbackContent?: string;
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface ExecutionStep {
  type:
    | "install_dependencies"
    | "build_web_app"
    | "start_vite_preview"
    | "stop_preview"
    | "health_check"
    | "git_snapshot";
  description: string;
  packageManager?: "npm";
  port?: number;
  message?: string;
  url?: string;
}

export interface ProviderRoute {
  clarifierModel: string;
  plannerModel: string;
  coderModel: string;
  criticModel: string;
  provider: string;
}

export interface EvaluationResult {
  buildReadinessScore: number;
  requirementCoverageScore: number;
  summary: string;
  issues: string[];
}

export interface UsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ApprovalRequest {
  runId: string;
  projectId: string;
  summary: string;
  createdAt: string;
  expiresAt?: string;
}

export interface ArtifactRecord {
  id: string;
  projectId: string;
  runId: string;
  kind: "preview_log" | "workspace_snapshot" | "build_bundle" | "diff_bundle";
  uri: string;
  createdAt: string;
}

export interface PreviewInstanceRecord {
  id: string;
  projectId: string;
  runId: string;
  status: PreviewStatus;
  url?: string;
  healthUrl?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface ToolCallTrace {
  id: string;
  runId: string;
  tool: string;
  startedAt: string;
  finishedAt?: string;
  status: "started" | "completed" | "failed";
  inputSummary?: string;
  outputSummary?: string;
}

export interface VersionRecord {
  id: string;
  number: number;
  summary: string;
  createdAt: string;
  gitCommit?: string;
}

export interface PreviewInfo {
  status: PreviewStatus;
  url?: string;
  lastLog?: string;
  updatedAt: string;
}

export interface RunSnapshot {
  id?: string;
  status?: RunStatus;
  phase?: RunPhase;
  approvalRequest?: ApprovalRequest;
  providerRoute?: ProviderRoute;
  evaluation?: EvaluationResult;
  usage?: UsageMetrics;
  error?: string;
}

export interface AgentSessionState {
  sessionId: string;
  projectId: string;
  reasoningMode: ReasoningMode;
  messages: ChatMessage[];
  clarificationDecision?: ClarificationDecision;
  workingSpec: WorkingSpec;
  appSpec?: AppSpec;
  planSteps: PlanStep[];
  assistantSummary?: string;
  fileChangeSummary: string[];
  fileOperations: FileOperation[];
  executionManifest: ExecutionStep[];
  versionNumber: number;
  previewUrl?: string;
  error?: string;
  assumptions: string[];
  providerRoute?: ProviderRoute;
  evaluation?: EvaluationResult;
  lastContextPaths: string[];
  runPhase?: RunPhase;
  status: ProjectStatus;
  run?: RunSnapshot;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  reasoningMode: ReasoningMode;
  createdAt: string;
  updatedAt: string;
  state: AgentSessionState;
}

export interface RunRecord {
  id: string;
  projectId: string;
  sessionId: string;
  reasoningMode: ReasoningMode;
  action: RunAction;
  status: RunStatus;
  phase?: RunPhase;
  createdAt: string;
  updatedAt: string;
  state: AgentSessionState;
  providerRoute?: ProviderRoute;
  evaluation?: EvaluationResult;
  usage?: UsageMetrics;
  approvalRequest?: ApprovalRequest;
  error?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  reasoningMode: ReasoningMode;
  status: ProjectStatus;
  preview: PreviewInfo;
  session: AgentSessionState;
  currentSessionId: string;
  latestRun?: RunRecord;
  versions: VersionRecord[];
}

export interface AgentTurnRequest {
  projectId: string;
  sessionId: string;
  reasoningMode: ReasoningMode;
  state?: AgentSessionState;
  userMessage?: string;
  clarificationAnswers?: ClarificationAnswer[];
  workspaceSnapshot?: WorkspaceFile[];
}

export interface AgentTurnResponse {
  state: AgentSessionState;
}

export interface RepairContext {
  attempt: number;
  category: "dependency" | "type_build" | "preview_boot" | "requirement_mismatch";
  failedCommand: string;
  buildError: string;
}

export interface AgentRepairRequest {
  projectId: string;
  sessionId: string;
  reasoningMode: ReasoningMode;
  state: AgentSessionState;
  workspaceSnapshot: WorkspaceFile[];
  repairContext: RepairContext;
}

export interface AgentRepairResponse {
  state: AgentSessionState;
}

export interface SessionCreateRequest {
  projectId: string;
  reasoningMode?: ReasoningMode;
}

export interface SessionCreateResponse {
  project: ProjectRecord;
  session: SessionRecord;
}

export interface RunCreateRequest {
  sessionId: string;
  projectId: string;
  reasoningMode?: ReasoningMode;
  action?: Exclude<RunAction, "execute">;
  userMessage?: string;
  clarificationAnswers?: ClarificationAnswer[];
}

export interface RunInputRequest {
  userMessage?: string;
  clarificationAnswers?: ClarificationAnswer[];
}

export interface RunCreateResponse {
  project: ProjectRecord;
  session: SessionRecord;
  run: RunRecord;
}

export interface RunApproveRequest {
  approved: boolean;
}

export interface RunApproveResponse {
  project: ProjectRecord;
  session: SessionRecord;
  run: RunRecord;
}

export interface RunStateResponse {
  session: SessionRecord;
  run: RunRecord;
}

export type ProjectEventType =
  | "project.created"
  | "project.updated"
  | "project.preview_log"
  | "project.preview_ready"
  | "project.error"
  | "run.started"
  | "run.updated"
  | "run.approval_required"
  | "run.repair_started"
  | "run.preview_ready"
  | "run.failed"
  | "run.completed";

export interface ProjectEvent {
  type: ProjectEventType;
  projectId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}
