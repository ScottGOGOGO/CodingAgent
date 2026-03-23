export type ReasoningMode = "plan_solve" | "react";

export type ChatRole = "system" | "user" | "assistant";

export type ProjectStatus =
  | "draft"
  | "clarifying"
  | "planning"
  | "ready_for_confirmation"
  | "applying_changes"
  | "running"
  | "ready"
  | "error";

export type PreviewStatus = "idle" | "starting" | "ready" | "error" | "stopped";

export type SlotKey =
  | "product_goal"
  | "target_users"
  | "core_pages"
  | "key_interactions"
  | "visual_style"
  | "external_integrations";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface RequirementSlots {
  product_goal?: string;
  target_users?: string;
  core_pages?: string;
  key_interactions?: string;
  visual_style?: string;
  external_integrations?: string;
}

export interface ClarificationQuestion {
  key: SlotKey;
  question: string;
  placeholder: string;
}

export interface AppSpec {
  appName: string;
  title: string;
  summary: string;
  targetUsers: string;
  pages: string[];
  keyInteractions: string[];
  visualStyle: string;
  integrations: string[];
  assumptions: string[];
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "done";
}

export interface FileChange {
  path: string;
  action: "write" | "delete";
  content?: string;
  summary: string;
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

export type ExecutionStep =
  | {
      type: "install_dependencies";
      description: string;
      packageManager: "npm";
    }
  | {
      type: "build_web_app";
      description: string;
      packageManager: "npm";
    }
  | {
      type: "start_vite_preview";
      description: string;
      packageManager: "npm";
      port: number;
    }
  | {
      type: "stop_preview";
      description: string;
    }
  | {
      type: "git_snapshot";
      description: string;
      message: string;
    };

export interface AgentSessionState {
  sessionId: string;
  projectId: string;
  reasoningMode: ReasoningMode;
  messages: ChatMessage[];
  requirementSlots: RequirementSlots;
  clarityScore: number;
  clarificationRounds: number;
  missingSlots: SlotKey[];
  clarificationQuestions: ClarificationQuestion[];
  status: ProjectStatus;
  appSpec?: AppSpec;
  planSteps: PlanStep[];
  assistantSummary?: string;
  fileChangeSummary: string[];
  fileChanges: FileChange[];
  executionManifest: ExecutionStep[];
  versionNumber: number;
  previewUrl?: string;
  error?: string;
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
  versions: VersionRecord[];
}

export interface AgentTurnRequest {
  projectId: string;
  sessionId: string;
  reasoningMode: ReasoningMode;
  state?: AgentSessionState;
  userMessage?: string;
  clarificationAnswers?: Partial<Record<SlotKey, string>>;
  workspaceSnapshot?: WorkspaceFile[];
}

export interface AgentTurnResponse {
  state: AgentSessionState;
}

export interface RepairContext {
  attempt: number;
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

export type ProjectEventType =
  | "project.created"
  | "project.updated"
  | "project.plan_ready"
  | "project.preview_log"
  | "project.preview_ready"
  | "project.error";

export interface ProjectEvent {
  type: ProjectEventType;
  projectId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}
