import type {
  ClarificationAnswer,
  ProjectEvent,
  ProjectRecord,
  ReasoningMode,
  RunApproveResponse,
  RunCreateResponse,
  RunRecord,
  RunStateResponse,
  SessionRecord,
} from "@vide/contracts";

import type { AgentClient } from "../agent-client.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { ProjectEventBus } from "../events.js";
import type { ProjectStore } from "../store.js";
import type { WorkspaceService } from "../workspace.js";
import { ExecutionWorker } from "./execution-worker.js";
import type { ProposalValidator } from "./proposal-validator.js";
import { RunApprovalService } from "./run/run-approval-service.js";
import { createSessionRecord, initialSessionState, newRun } from "./run/run-session-factory.js";
import { now, summarizeRunFailure } from "./run/run-state.js";
import { RunTurnProcessor } from "./run/run-turn-processor.js";

export { initialSessionState } from "./run/run-session-factory.js";
export { summarizeRunFailure } from "./run/run-state.js";

export class RunService {
  private readonly turnProcessor: RunTurnProcessor;
  private readonly approvalService: RunApprovalService;

  constructor(
    private readonly store: ProjectStore,
    private readonly bus: ProjectEventBus,
    private readonly workspace: WorkspaceService,
    private readonly agentClient: AgentClient,
    private readonly worker: ExecutionWorker,
    private readonly proposalValidator: ProposalValidator,
  ) {
    const effects = {
      persist: this.persist.bind(this),
      publish: this.publish.bind(this),
    };
    this.turnProcessor = new RunTurnProcessor(this.store, this.workspace, this.agentClient, this.proposalValidator, effects);
    this.approvalService = new RunApprovalService(this.worker, effects);
  }

  async createSession(project: ProjectRecord, reasoningMode: ReasoningMode): Promise<SessionRecord> {
    const session = createSessionRecord(project, reasoningMode);
    project.currentSessionId = session.id;
    project.reasoningMode = reasoningMode;
    project.session = session.state;
    project.status = "draft";
    project.updatedAt = session.createdAt;
    await this.store.createSession(session);
    await this.store.saveProject(project);
    return session;
  }

  async createRun(args: {
    projectId: string;
    sessionId: string;
    reasoningMode?: ReasoningMode;
    userMessage?: string;
    clarificationAnswers?: ClarificationAnswer[];
  }): Promise<RunCreateResponse> {
    const project = await this.requireProject(args.projectId);
    const session = await this.requireSession(args.sessionId);
    const run = newRun(project, session, args.reasoningMode ?? session.reasoningMode);
    await this.store.createRun(run);
    this.publish({ type: "run.started", projectId: project.id, createdAt: now(), payload: { project, run } });

    return this.turnProcessor.processTurn(project, session, run, args.userMessage, args.clarificationAnswers);
  }

  async submitRunInput(
    runId: string,
    input: { userMessage?: string; clarificationAnswers?: ClarificationAnswer[] },
  ): Promise<RunCreateResponse> {
    const run = await this.requireRun(runId);
    if (run.status !== "awaiting_input") {
      throw new ConflictError("Run is not waiting for more input.");
    }

    const project = await this.requireProject(run.projectId);
    const session = await this.requireSession(run.sessionId);
    return this.turnProcessor.processTurn(project, session, run, input.userMessage, input.clarificationAnswers);
  }

  async approveRun(runId: string, approved: boolean): Promise<RunApproveResponse> {
    const run = await this.requireRun(runId);
    const project = await this.requireProject(run.projectId);
    const session = await this.requireSession(run.sessionId);

    if (run.status !== "awaiting_approval") {
      throw new ConflictError("Run is not waiting for approval.");
    }

    return this.approvalService.approveRun(project, session, run, approved);
  }

  async getRun(runId: string): Promise<RunRecord> {
    return this.requireRun(runId);
  }

  async getRunState(runId: string): Promise<RunStateResponse> {
    const run = await this.requireRun(runId);
    const session = await this.requireSession(run.sessionId);
    return { session, run };
  }

  private async persist(project: ProjectRecord, session: SessionRecord, run: RunRecord) {
    await this.store.saveSession(session);
    await this.store.saveRun(run);
    await this.store.saveProject(project);
  }

  private async requireProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.store.getProject(projectId);
    if (!project) {
      throw new NotFoundError("Project not found");
    }
    return project;
  }

  private async requireSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new NotFoundError("Session not found");
    }
    return session;
  }

  private async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.store.getRun(runId);
    if (!run) {
      throw new NotFoundError("Run not found");
    }
    return run;
  }

  private publish(event: ProjectEvent) {
    this.bus.publish(event);
  }
}
