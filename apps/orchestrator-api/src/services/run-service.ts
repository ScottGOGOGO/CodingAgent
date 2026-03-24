import { randomUUID } from "node:crypto";

import type {
  AgentSessionState,
  ApprovalRequest,
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

function now() {
  return new Date().toISOString();
}

function appendMessage(
  state: AgentSessionState,
  role: "user" | "assistant",
  content?: string,
) {
  const normalized = content?.trim();
  if (!normalized) {
    return;
  }

  state.messages.push({
    id: randomUUID(),
    role,
    content: normalized,
    createdAt: now(),
  });
}

function normalizeProjectStatus(status: ProjectRecord["status"] | AgentSessionState["status"]): ProjectRecord["status"] {
  return status === "error" ? "failed" : status;
}

function decorateStateWithRun(sessionState: AgentSessionState, run: RunRecord) {
  sessionState.run = {
    id: run.id,
    status: run.status,
    phase: run.phase,
    approvalRequest: run.approvalRequest,
    providerRoute: run.providerRoute,
    evaluation: run.evaluation,
    usage: run.usage,
    error: run.error,
  };
}

function buildApproval(project: ProjectRecord, run: RunRecord): ApprovalRequest {
  return {
    runId: run.id,
    projectId: project.id,
    summary: run.state.assistantSummary ?? "Review the proposed changes before execution.",
    createdAt: now(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
  };
}

function formatClarificationAnswers(
  sessionState: AgentSessionState,
  clarificationAnswers?: ClarificationAnswer[],
): string | undefined {
  if (!clarificationAnswers?.length) {
    return undefined;
  }

  const questionLookup = new Map(
    (sessionState.clarificationDecision?.questions ?? []).map((item) => [item.id, item.question]),
  );
  const lines = ["Additional clarification from the user:"];

  for (const answer of clarificationAnswers) {
    const normalized = answer.answer.trim();
    if (!normalized) {
      continue;
    }
    lines.push(`Question: ${questionLookup.get(answer.questionId) ?? answer.questionId}`);
    lines.push(`Answer: ${normalized}`);
  }

  return lines.length > 1 ? lines.join("\n") : undefined;
}

export function initialSessionState(projectId: string, sessionId: string, reasoningMode: ReasoningMode): AgentSessionState {
  return {
    sessionId,
    projectId,
    reasoningMode,
    messages: [],
    workingSpec: {},
    planSteps: [],
    fileChangeSummary: [],
    fileOperations: [],
    executionManifest: [],
    versionNumber: 0,
    assumptions: [],
    lastContextPaths: [],
    status: "draft",
  };
}

export class RunService {
  constructor(
    private readonly store: ProjectStore,
    private readonly bus: ProjectEventBus,
    private readonly workspace: WorkspaceService,
    private readonly agentClient: AgentClient,
    private readonly worker: ExecutionWorker,
    private readonly proposalValidator: ProposalValidator,
  ) {}

  async createSession(project: ProjectRecord, reasoningMode: ReasoningMode): Promise<SessionRecord> {
    const createdAt = now();
    const session: SessionRecord = {
      id: randomUUID(),
      projectId: project.id,
      reasoningMode,
      createdAt,
      updatedAt: createdAt,
      state: initialSessionState(project.id, project.currentSessionId || randomUUID(), reasoningMode),
    };
    session.state.sessionId = session.id;
    project.currentSessionId = session.id;
    project.reasoningMode = reasoningMode;
    project.session = session.state;
    project.status = "draft";
    project.updatedAt = createdAt;
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
    const run = this.newRun(project, session, args.reasoningMode ?? session.reasoningMode);
    await this.store.createRun(run);
    this.publish({ type: "run.started", projectId: project.id, createdAt: now(), payload: { project, run } });

    return this.processTurn(project, session, run, args.userMessage, args.clarificationAnswers);
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
    return this.processTurn(project, session, run, input.userMessage, input.clarificationAnswers);
  }

  async approveRun(runId: string, approved: boolean): Promise<RunApproveResponse> {
    const run = await this.requireRun(runId);
    const project = await this.requireProject(run.projectId);
    const session = await this.requireSession(run.sessionId);

    if (run.status !== "awaiting_approval") {
      throw new ConflictError("Run is not waiting for approval.");
    }

    if (!approved) {
      run.status = "cancelled";
      run.phase = "report";
      run.updatedAt = now();
      run.error = "Approval declined by user.";
      session.state.status = "failed";
      session.state.error = run.error;
      decorateStateWithRun(session.state, run);
      session.updatedAt = now();
      project.status = "failed";
      project.session = session.state;
      project.latestRun = run;
      project.updatedAt = now();
      await this.persist(project, session, run);
      this.publish({
        type: "run.failed",
        projectId: project.id,
        createdAt: now(),
        payload: { project, run, message: run.error },
      });
      return { project, session, run };
    }

    run.status = "queued";
    run.phase = "execute_dispatch";
    run.updatedAt = now();
    session.state.status = "running";
    session.state.runPhase = "execute_dispatch";
    decorateStateWithRun(session.state, run);
    session.updatedAt = now();
    project.status = "running";
    project.session = session.state;
    project.latestRun = run;
    project.updatedAt = now();

    await this.persist(project, session, run);
    this.worker.enqueue(run.id);
    this.publish({ type: "run.updated", projectId: project.id, createdAt: now(), payload: { project, run } });
    return { project, session, run };
  }

  async getRun(runId: string): Promise<RunRecord> {
    return this.requireRun(runId);
  }

  async getRunState(runId: string): Promise<RunStateResponse> {
    const run = await this.requireRun(runId);
    const session = await this.requireSession(run.sessionId);
    return { session, run };
  }

  private async processTurn(
    project: ProjectRecord,
    session: SessionRecord,
    run: RunRecord,
    userMessage?: string,
    clarificationAnswers?: ClarificationAnswer[],
  ): Promise<RunCreateResponse> {
    const workspaceSnapshot = await this.workspace.readWorkspaceSnapshot(project);
    let response;
    try {
      response = await this.agentClient.runTurn({
        project,
        userMessage,
        clarificationAnswers,
        reasoningMode: run.reasoningMode,
        workspaceSnapshot,
      });
    } catch (error) {
      return this.failTurn(project, session, run, error, userMessage, clarificationAnswers);
    }

    session.state = response.state;
    session.reasoningMode = run.reasoningMode;
    session.updatedAt = now();
    run.state = response.state;
    run.phase = response.state.runPhase;
    run.providerRoute = response.state.providerRoute;
    run.evaluation = response.state.evaluation;
    run.updatedAt = now();

    if (response.state.status === "clarifying") {
      run.status = "awaiting_input";
      run.approvalRequest = undefined;
    } else if (response.state.status === "awaiting_approval") {
      try {
        const validatedState = await this.proposalValidator.validate(project, {
          ...run,
          state: response.state,
        });
        session.state = validatedState;
        run.state = validatedState;
        run.phase = validatedState.runPhase;
        run.providerRoute = validatedState.providerRoute;
        run.evaluation = validatedState.evaluation;
      } catch (error) {
        return this.failResolvedTurn(project, session, run, error, response.state);
      }

      run.status = "awaiting_approval";
      run.approvalRequest = buildApproval(project, run);
      await this.store.saveApproval(run.approvalRequest);
    } else if (response.state.status === "error" || response.state.status === "failed") {
      run.status = "failed";
      run.error = response.state.error;
    } else {
      run.status = "completed";
    }

    decorateStateWithRun(session.state, run);
    project.currentSessionId = session.id;
    project.reasoningMode = run.reasoningMode;
    project.session = session.state;
    project.latestRun = run;
    project.status = normalizeProjectStatus(session.state.status);
    project.updatedAt = now();

    await this.persist(project, session, run);

    if (run.status === "awaiting_approval") {
      this.publish({
        type: "run.approval_required",
        projectId: project.id,
        createdAt: now(),
        payload: { project, run },
      });
    } else if (run.status === "failed") {
      this.publish({
        type: "run.failed",
        projectId: project.id,
        createdAt: now(),
        payload: { project, run, message: run.error },
      });
    } else {
      this.publish({ type: "run.updated", projectId: project.id, createdAt: now(), payload: { project, run } });
    }

    this.publish({ type: "project.updated", projectId: project.id, createdAt: now(), payload: { project } });
    return { project, session, run };
  }

  private async failResolvedTurn(
    project: ProjectRecord,
    session: SessionRecord,
    run: RunRecord,
    error: unknown,
    state: AgentSessionState,
  ): Promise<RunCreateResponse> {
    const message = error instanceof Error ? error.message : "Unknown validation error";

    session.state = {
      ...state,
      error: message,
      status: "failed",
      runPhase: "report",
      assistantSummary: `Generation failed: ${message}`,
    };
    appendMessage(session.state, "assistant", session.state.assistantSummary);

    run.status = "failed";
    run.phase = "report";
    run.error = message;
    run.state = session.state;
    run.updatedAt = now();

    decorateStateWithRun(session.state, run);
    session.updatedAt = now();

    project.currentSessionId = session.id;
    project.reasoningMode = run.reasoningMode;
    project.status = "failed";
    project.session = session.state;
    project.latestRun = run;
    project.updatedAt = now();

    await this.persist(project, session, run);
    this.publish({
      type: "run.failed",
      projectId: project.id,
      createdAt: now(),
      payload: { project, run, message },
    });
    this.publish({ type: "project.updated", projectId: project.id, createdAt: now(), payload: { project } });
    return { project, session, run };
  }

  private async failTurn(
    project: ProjectRecord,
    session: SessionRecord,
    run: RunRecord,
    error: unknown,
    userMessage?: string,
    clarificationAnswers?: ClarificationAnswer[],
  ): Promise<RunCreateResponse> {
    const message = error instanceof Error ? error.message : "Unknown agent execution error";
    const userTurn = userMessage?.trim() || formatClarificationAnswers(session.state, clarificationAnswers);

    appendMessage(session.state, "user", userTurn);
    session.state.error = message;
    session.state.status = "failed";
    session.state.runPhase = "report";
    session.state.assistantSummary = `Generation failed: ${message}`;
    appendMessage(session.state, "assistant", session.state.assistantSummary);

    run.status = "failed";
    run.phase = "report";
    run.error = message;
    run.state = session.state;
    run.updatedAt = now();

    decorateStateWithRun(session.state, run);
    session.updatedAt = now();

    project.currentSessionId = session.id;
    project.reasoningMode = run.reasoningMode;
    project.status = "failed";
    project.session = session.state;
    project.latestRun = run;
    project.updatedAt = now();

    await this.persist(project, session, run);
    this.publish({
      type: "run.failed",
      projectId: project.id,
      createdAt: now(),
      payload: { project, run, message },
    });
    this.publish({ type: "project.updated", projectId: project.id, createdAt: now(), payload: { project } });
    return { project, session, run };
  }

  private newRun(project: ProjectRecord, session: SessionRecord, reasoningMode: ReasoningMode): RunRecord {
    const createdAt = now();
    return {
      id: randomUUID(),
      projectId: project.id,
      sessionId: session.id,
      reasoningMode,
      action: "turn",
      status: "in_progress",
      phase: "intake",
      createdAt,
      updatedAt: createdAt,
      state: session.state,
    };
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
