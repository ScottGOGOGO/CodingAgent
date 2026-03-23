import type {
  AgentRepairRequest,
  AgentRepairResponse,
  AgentTurnRequest,
  AgentTurnResponse,
  ProjectRecord,
  ReasoningMode,
  RepairContext,
  SlotKey,
  WorkspaceFile,
} from "@vide/contracts";

export class AgentClient {
  constructor(private readonly baseUrl: string) {}

  async runTurn(args: {
    project: ProjectRecord;
    userMessage?: string;
    clarificationAnswers?: Partial<Record<SlotKey, string>>;
    reasoningMode: ReasoningMode;
    workspaceSnapshot: WorkspaceFile[];
  }): Promise<AgentTurnResponse> {
    const payload: AgentTurnRequest = {
      projectId: args.project.id,
      sessionId: args.project.session.sessionId,
      reasoningMode: args.reasoningMode,
      state: args.project.session,
      userMessage: args.userMessage,
      clarificationAnswers: args.clarificationAnswers,
      workspaceSnapshot: args.workspaceSnapshot,
    };

    const response = await fetch(`${this.baseUrl}/agent/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Agent service failed: ${response.status} ${text}`);
    }

    return (await response.json()) as AgentTurnResponse;
  }

  async runRepair(args: {
    project: ProjectRecord;
    reasoningMode: ReasoningMode;
    workspaceSnapshot: WorkspaceFile[];
    repairContext: RepairContext;
  }): Promise<AgentRepairResponse> {
    const payload: AgentRepairRequest = {
      projectId: args.project.id,
      sessionId: args.project.session.sessionId,
      reasoningMode: args.reasoningMode,
      state: args.project.session,
      workspaceSnapshot: args.workspaceSnapshot,
      repairContext: args.repairContext,
    };

    const response = await fetch(`${this.baseUrl}/agent/repair`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Agent repair failed: ${response.status} ${text}`);
    }

    return (await response.json()) as AgentRepairResponse;
  }
}
