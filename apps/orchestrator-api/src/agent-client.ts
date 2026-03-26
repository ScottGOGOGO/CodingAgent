import type {
  AgentRepairRequest,
  AgentRepairResponse,
  AgentTurnRequest,
  AgentTurnResponse,
  ClarificationAnswer,
  ProjectRecord,
  ReasoningMode,
  RepairContext,
  WorkspaceFile,
} from "@vide/contracts";

const DEFAULT_TIMEOUT_MS = 420_000;

export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Agent service ${path} failed: ${response.status} ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Agent service ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async runTurn(args: {
    project: ProjectRecord;
    userMessage?: string;
    clarificationAnswers?: ClarificationAnswer[];
    reasoningMode: ReasoningMode;
    workspaceSnapshot: WorkspaceFile[];
  }): Promise<AgentTurnResponse> {
    const payload: AgentTurnRequest = {
      projectId: args.project.id,
      sessionId: args.project.currentSessionId,
      reasoningMode: args.reasoningMode,
      state: args.project.session,
      userMessage: args.userMessage,
      clarificationAnswers: args.clarificationAnswers,
      workspaceSnapshot: args.workspaceSnapshot,
    };

    return this.post<AgentTurnResponse>("/agent/turn", payload);
  }

  async runRepair(args: {
    project: ProjectRecord;
    reasoningMode: ReasoningMode;
    workspaceSnapshot: WorkspaceFile[];
    repairContext: RepairContext;
  }): Promise<AgentRepairResponse> {
    const payload: AgentRepairRequest = {
      projectId: args.project.id,
      sessionId: args.project.currentSessionId,
      reasoningMode: args.reasoningMode,
      state: args.project.session,
      workspaceSnapshot: args.workspaceSnapshot,
      repairContext: args.repairContext,
    };

    return this.post<AgentRepairResponse>("/agent/repair", payload);
  }
}
