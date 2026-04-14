import { performance } from "node:perf_hooks";

import type {
  AgentSessionState,
  ClarificationAnswer,
  ProjectEvent,
  ProjectRecord,
  RunCreateResponse,
  RunRecord,
  SessionRecord,
} from "@vide/contracts";

import type { AgentClient } from "../../agent-client.js";
import type { ProjectStore } from "../../store.js";
import type { WorkspaceService } from "../../workspace.js";
import type { ProposalValidator } from "../proposal-validator.js";
import {
  appendMessage,
  buildApproval,
  decorateStateWithRun,
  formatClarificationAnswers,
  normalizeProjectStatus,
  now,
  summarizeRunFailure,
} from "./run-state.js";

type RunPersistence = {
  persist(project: ProjectRecord, session: SessionRecord, run: RunRecord): Promise<void>;
  publish(event: ProjectEvent): void;
};

export class RunTurnProcessor {
  constructor(
    private readonly store: Pick<ProjectStore, "saveApproval">,
    private readonly workspace: WorkspaceService,
    private readonly agentClient: AgentClient,
    private readonly proposalValidator: ProposalValidator,
    private readonly effects: RunPersistence,
  ) {}

  async processTurn(
    project: ProjectRecord,
    session: SessionRecord,
    run: RunRecord,
    userMessage?: string,
    clarificationAnswers?: ClarificationAnswer[],
  ): Promise<RunCreateResponse> {
    const workspaceSnapshot = await this.workspace.readWorkspaceSnapshot(project);
    let response;
    const startedAt = performance.now();
    console.info(
      [
        "event=run_turn_started",
        `projectId=${project.id}`,
        `sessionId=${session.id}`,
        `runId=${run.id}`,
        `reasoningMode=${run.reasoningMode}`,
        `workspaceFiles=${workspaceSnapshot.length}`,
        `userMessageLength=${userMessage?.length ?? 0}`,
        `clarificationAnswers=${clarificationAnswers?.length ?? 0}`,
      ].join(" "),
    );
    try {
      response = await this.agentClient.runTurn({
        project,
        userMessage,
        clarificationAnswers,
        reasoningMode: run.reasoningMode,
        workspaceSnapshot,
      });
      console.info(
        [
          "event=run_turn_agent_completed",
          `projectId=${project.id}`,
          `sessionId=${session.id}`,
          `runId=${run.id}`,
          `durationMs=${Math.round(performance.now() - startedAt)}`,
          `stateStatus=${response.state.status}`,
          `runPhase=${response.state.runPhase}`,
        ].join(" "),
      );
    } catch (error) {
      console.info(
        [
          "event=run_turn_agent_failed",
          `projectId=${project.id}`,
          `sessionId=${session.id}`,
          `runId=${run.id}`,
          `durationMs=${Math.round(performance.now() - startedAt)}`,
          `error=${JSON.stringify(summarizeRunFailure(error))}`,
        ].join(" "),
      );
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

    await this.effects.persist(project, session, run);

    if (run.status === "awaiting_approval") {
      this.effects.publish({
        type: "run.approval_required",
        projectId: project.id,
        createdAt: now(),
        payload: { project, run },
      });
    } else if (run.status === "failed") {
      this.effects.publish({
        type: "run.failed",
        projectId: project.id,
        createdAt: now(),
        payload: { project, run, message: run.error },
      });
    } else {
      this.effects.publish({
        type: "run.updated",
        projectId: project.id,
        createdAt: now(),
        payload: { project, run },
      });
    }

    this.effects.publish({ type: "project.updated", projectId: project.id, createdAt: now(), payload: { project } });
    return { project, session, run };
  }

  private async failResolvedTurn(
    project: ProjectRecord,
    session: SessionRecord,
    run: RunRecord,
    error: unknown,
    state: AgentSessionState,
  ): Promise<RunCreateResponse> {
    const message = summarizeRunFailure(error);

    session.state = {
      ...state,
      evaluation: undefined,
      error: message,
      status: "failed",
      runPhase: "report",
      assistantSummary: `生成失败：${message}`,
    };
    appendMessage(session.state, "assistant", session.state.assistantSummary);

    run.status = "failed";
    run.phase = "report";
    run.error = message;
    run.evaluation = undefined;
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

    await this.effects.persist(project, session, run);
    this.effects.publish({
      type: "run.failed",
      projectId: project.id,
      createdAt: now(),
      payload: { project, run, message },
    });
    this.effects.publish({ type: "project.updated", projectId: project.id, createdAt: now(), payload: { project } });
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
    const message = summarizeRunFailure(error);
    const userTurn = userMessage?.trim() || formatClarificationAnswers(session.state, clarificationAnswers);

    appendMessage(session.state, "user", userTurn);
    session.state.evaluation = undefined;
    session.state.error = message;
    session.state.status = "failed";
    session.state.runPhase = "report";
    session.state.assistantSummary = `生成失败：${message}`;
    appendMessage(session.state, "assistant", session.state.assistantSummary);

    run.status = "failed";
    run.phase = "report";
    run.error = message;
    run.evaluation = undefined;
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

    await this.effects.persist(project, session, run);
    this.effects.publish({
      type: "run.failed",
      projectId: project.id,
      createdAt: now(),
      payload: { project, run, message },
    });
    this.effects.publish({ type: "project.updated", projectId: project.id, createdAt: now(), payload: { project } });
    return { project, session, run };
  }
}
