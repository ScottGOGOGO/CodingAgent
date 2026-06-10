import { randomUUID } from "node:crypto";

import { ExpertRouter, loadRuntimeConfig, ModelClient, QueryEngine, safePreviewPort } from "@vide/agent-runtime";
import type {
  ClarificationAnswer,
  ProjectEvent,
  ProjectRecord,
  RunApproveResponse,
  RunCreateResponse,
  RunRecord,
  RunStateResponse,
  SessionState,
  CandidateChangeSet,
} from "@vide/contracts";

import { ConflictError, NotFoundError } from "../errors.js";
import type { ProjectEventBus } from "../events.js";
import type { RunnerService } from "../runner.js";
import type { ProjectStore } from "../store.js";
import { createVersionRecord } from "../versioning.js";
import type { WorkspaceService } from "../workspace.js";
import { createToolRuntimeAdapters } from "./tool-runtime.js";

export function now() {
  return new Date().toISOString();
}

export function createSession(project: ProjectRecord): SessionState {
  const createdAt = now();
  return {
    id: randomUUID(),
    projectId: project.id,
    mode: "local_generator",
    messages: [],
    tasks: [],
    toolCalls: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export class RunService {
  private readonly activeRuns = new Set<string>();
  private progressQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ProjectStore,
    private readonly bus: ProjectEventBus,
    private readonly workspace: WorkspaceService,
    private readonly runner: RunnerService,
  ) {}

  async createRun(args: {
    projectId: string;
    userMessage?: string;
    clarificationAnswers?: ClarificationAnswer[];
  }): Promise<RunCreateResponse> {
    const project = await this.requireProject(args.projectId);
    const session = await this.requireSession(project.currentSessionId);
    const runId = randomUUID();
    const createdAt = now();
    let run: RunRecord = {
      id: runId,
      projectId: project.id,
      sessionId: session.id,
      mode: "local_generator",
      status: "running",
      phase: "intake",
      userMessage: args.userMessage,
      clarificationAnswers: args.clarificationAnswers,
      tasks: [],
      toolCalls: [],
      createdAt,
      updatedAt: createdAt,
    };

    project.currentRunId = run.id;
    project.latestRun = run;
    project.status = "running";
    project.candidate = undefined;
    project.preview = {
      status: "idle",
      url: project.preview.url,
      updatedAt: now(),
    };
    project.updatedAt = now();
    await this.workspace.resetPreviewLog(project);
    await this.store.createRun(run);
    await this.persist(project, session, run);
    this.publish({ type: "run.started", projectId: project.id, runId: run.id, createdAt: now(), payload: { project, run } });

    this.startRunInBackground(project.id, session.id, run.id, args);
    return { project, run };
  }

  private startRunInBackground(
    projectId: string,
    sessionId: string,
    runId: string,
    args: {
      userMessage?: string;
      clarificationAnswers?: ClarificationAnswer[];
    },
  ) {
    if (this.activeRuns.has(runId)) {
      return;
    }
    this.activeRuns.add(runId);
    void this.executeRun(projectId, sessionId, runId, args)
      .catch((error) => this.failRunFromBackground(projectId, sessionId, runId, error))
      .finally(() => {
        this.activeRuns.delete(runId);
      });
  }

  private async executeRun(
    projectId: string,
    sessionId: string,
    runId: string,
    args: {
      userMessage?: string;
      clarificationAnswers?: ClarificationAnswer[];
    },
  ): Promise<void> {
    const project = await this.requireProject(projectId);
    const session = await this.requireSession(sessionId);
    let run = await this.requireRun(runId);

    const runtimeConfig = loadRuntimeConfig();
    const model = new ModelClient(runtimeConfig);
    const engine = new QueryEngine(
      new ExpertRouter(model, { strictGeneration: runtimeConfig.strictGeneration }),
      undefined,
      {
        onPhase: (phase) => {
          run = { ...run, phase, updatedAt: now() };
          void this.persistProgress(project.id, session.id, run);
          this.publish({ type: "run.updated", projectId: project.id, runId: run.id, createdAt: now(), payload: { run } });
        },
        onToolTrace: (toolCall) => {
          run = {
            ...run,
            toolCalls: upsertToolCall(run.toolCalls, toolCall),
            updatedAt: toolCall.finishedAt ?? toolCall.startedAt,
          };
          void this.persistProgress(project.id, session.id, run);
          this.publish({
            type: toolCall.status === "failed" ? "tool.failed" : toolCall.status === "completed" ? "tool.completed" : "tool.started",
            projectId: project.id,
            runId: run.id,
            createdAt: now(),
            payload: { toolCall },
          });
        },
        onTask: (task) => {
          run = { ...run, tasks: upsertTask(run.tasks, task), updatedAt: task.updatedAt };
          void this.persistProgress(project.id, session.id, run);
          this.publish({ type: "task.updated", projectId: project.id, runId: run.id, createdAt: now(), payload: { task } });
        },
        onLog: (message) => {
          void this.workspace.appendPreviewLog(project, message.endsWith("\n") ? message : `${message}\n`);
          this.publish({ type: "project.preview_log", projectId: project.id, runId: run.id, createdAt: now(), payload: { message } });
        },
      },
      undefined,
      {
        maxTurns: runtimeConfig.maxTurns,
        maxToolCallsPerTurn: runtimeConfig.agentMaxToolCallsPerTurn,
        maxToolCallsTotal: runtimeConfig.agentMaxToolCallsTotal,
        modelTurnTimeoutMs: runtimeConfig.agentModelTurnTimeoutMs,
        skipAcceptance: runtimeConfig.skipAcceptance,
        strictGeneration: runtimeConfig.strictGeneration,
      },
      createToolRuntimeAdapters({ model }),
    );

    const result = await engine.run({
      projectId: project.id,
      sessionId: session.id,
      runId: run.id,
      projectRoot: project.workspaceRoot,
      baseVersion: project.versions.length,
      messages: session.messages,
      userMessage: args.userMessage,
      clarificationAnswers: args.clarificationAnswers,
    });
    await this.flushProgress();

    run = result.run;
    session.messages = result.messages;
    session.contextSummary = result.contextSummary;
    session.tasks = run.tasks;
    session.toolCalls = run.toolCalls;
    session.clarificationRequest = result.clarificationRequest;
    session.designBrief = result.designBrief;
    session.candidate = result.candidate;
    session.error = run.error;
    session.failureKind = run.failureKind;
    session.updatedAt = now();

    if (result.candidate) {
      await this.store.saveCandidate(result.candidate);
      run.candidate = result.candidate;
      project.candidate = result.candidate;
      project.status = "awaiting_approval";
      project.preview = {
        ...project.preview,
        status: "starting",
        updatedAt: now(),
      };
      await this.persist(project, session, run);
      try {
        const startPreview = runtimeConfig.skipAcceptance
          ? this.runner.startDevPreview.bind(this.runner)
          : this.runner.startPreview.bind(this.runner);
        const previewUrl = await startPreview(
          {
            id: `candidate-${run.id}`,
            workspaceRoot: result.candidate.sandboxPath,
            logRoot: project.workspaceRoot,
          },
          this.portForRun(run.id),
          (message) => this.publish({
            type: "project.preview_log",
            projectId: project.id,
            runId: run.id,
            createdAt: now(),
            payload: { message },
          }),
        );
        result.candidate.previewUrl = previewUrl;
        project.preview = { ...project.preview, status: "ready", candidateUrl: previewUrl, updatedAt: now() };
        await this.store.saveCandidate(result.candidate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (runtimeConfig.strictGeneration) {
          run = {
            ...run,
            status: "failed",
            phase: "preview",
            error: message,
            failureKind: "preview_failed",
            updatedAt: now(),
          };
          session.error = message;
          session.failureKind = "preview_failed";
          project.status = "failed";
          project.preview = { ...project.preview, status: "error", lastLog: message, updatedAt: now() };
          project.session = session;
          project.latestRun = run;
          await this.persist(project, session, run);
          this.publish({ type: "run.failed", projectId: project.id, runId: run.id, createdAt: now(), payload: { project, run } });
          return;
        }
        await this.recordCandidatePreviewError(project, session, run, result.candidate, message);
      }
      this.publish({
        type: "candidate.created",
        projectId: project.id,
        runId: run.id,
        createdAt: now(),
        payload: { project, run, candidate: result.candidate },
      });
    } else if (run.status === "awaiting_input") {
      project.status = "awaiting_input";
      this.publish({ type: "run.awaiting_input", projectId: project.id, runId: run.id, createdAt: now(), payload: { project, run } });
    } else if (run.status === "failed") {
      project.status = "failed";
      project.preview = { ...project.preview, status: "error", lastLog: run.error, updatedAt: now() };
      this.publish({ type: "run.failed", projectId: project.id, runId: run.id, createdAt: now(), payload: { project, run } });
    }

    project.session = session;
    project.latestRun = run;
    project.updatedAt = now();
    await this.persist(project, session, run);
    this.publish({ type: "project.updated", projectId: project.id, runId: run.id, createdAt: now(), payload: { project, run } });
  }

  async submitRunInput(runId: string, input: { userMessage?: string; clarificationAnswers?: ClarificationAnswer[] }): Promise<RunCreateResponse> {
    const run = await this.requireRun(runId);
    if (run.status !== "awaiting_input") {
      throw new ConflictError("Run is not waiting for input.");
    }
    return this.createRun({
      projectId: run.projectId,
      userMessage: input.userMessage,
      clarificationAnswers: input.clarificationAnswers,
    });
  }

  async approveRun(runId: string, approved: boolean, feedback?: string): Promise<RunApproveResponse> {
    const run = await this.requireRun(runId);
    const project = await this.requireProject(run.projectId);
    const session = await this.requireSession(run.sessionId);
    const candidate = run.candidate ?? (await this.store.getCandidate(run.id));
    if (run.status !== "awaiting_approval" || !candidate) {
      throw new ConflictError("Run is not waiting for candidate approval.");
    }

    if (!approved) {
      run.status = "cancelled";
      run.phase = "report";
      run.error = feedback || "Candidate rejected.";
      run.updatedAt = now();
      project.status = "draft";
      project.candidate = undefined;
      project.preview = { ...project.preview, candidateUrl: undefined, updatedAt: now() };
      session.messages.push({
        id: randomUUID(),
        role: "assistant",
        content: feedback ? `候选版本已拒绝：${feedback}` : "候选版本已拒绝，可以继续提出修改意见。",
        createdAt: now(),
      });
      session.updatedAt = now();
      project.session = session;
      project.latestRun = run;
      await this.persist(project, session, run);
      this.publish({ type: "run.cancelled", projectId: project.id, runId: run.id, createdAt: now(), payload: { project, run } });
      return { project, run };
    }

    run.phase = "promote";
    project.status = "promoting";
    await this.persist(project, session, run);
    await this.workspace.promoteSandbox(project, candidate.sandboxPath);
    const gitCommit = await this.workspace.snapshot(project, candidate.diffSummary.split("\n")[0] || "Promote generated candidate");
    const version = createVersionRecord(project, candidate.diffSummary, gitCommit);
    await this.store.saveVersion(project.id, version);
    project.versions = await this.store.listVersions(project.id);
    project.candidate = undefined;
    project.status = "ready";
    run.status = "completed";
    run.phase = "preview";
    run.updatedAt = now();
    session.candidate = undefined;
    session.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: "候选版本已批准并发布到正式工作区。",
      createdAt: now(),
    });
    session.updatedAt = now();
    project.session = session;
    project.latestRun = run;

    try {
      const target = { id: `project-${project.id}`, workspaceRoot: project.workspaceRoot, logRoot: project.workspaceRoot };
      await this.runner.stop(target.id);
      await this.runner.runCommand(
        target,
        ["npm", "install"],
        (message) => this.publish({
          type: "project.preview_log",
          projectId: project.id,
          runId: run.id,
          createdAt: now(),
          payload: { message },
        }),
      );
      await this.runner.runCommand(
        target,
        ["npm", "run", "build"],
        (message) => this.publish({
          type: "project.preview_log",
          projectId: project.id,
          runId: run.id,
          createdAt: now(),
          payload: { message },
        }),
      );
      const previewUrl = await this.runner.startPreview(
        target,
        this.portForProject(project.id),
        (message) => this.publish({
          type: "project.preview_log",
          projectId: project.id,
          runId: run.id,
          createdAt: now(),
          payload: { message },
        }),
      );
      project.preview = { status: "ready", url: previewUrl, updatedAt: now() };
    } catch (error) {
      project.preview = {
        status: "error",
        lastLog: error instanceof Error ? error.message : String(error),
        updatedAt: now(),
      };
      project.status = "failed";
      run.status = "failed";
      run.error = project.preview.lastLog;
      run.failureKind = "preview_failed";
      session.failureKind = "preview_failed";
    }

    await this.persist(project, session, run);
    this.publish({ type: "candidate.promoted", projectId: project.id, runId: run.id, createdAt: now(), payload: { project, run } });
    this.publish({ type: "project.preview_ready", projectId: project.id, runId: run.id, createdAt: now(), payload: { project, run } });
    return { project, run };
  }

  async cancelRun(runId: string): Promise<RunStateResponse> {
    const run = await this.requireRun(runId);
    const project = await this.requireProject(run.projectId);
    run.status = "cancelled";
    run.phase = "report";
    run.updatedAt = now();
    project.status = "draft";
    project.latestRun = run;
    project.updatedAt = now();
    await this.store.saveRun(run);
    await this.store.saveProject(project);
    this.publish({ type: "run.cancelled", projectId: project.id, runId: run.id, createdAt: now(), payload: { project, run } });
    return { project, run };
  }

  async getRun(runId: string): Promise<RunRecord> {
    return this.requireRun(runId);
  }

  async getRunState(runId: string): Promise<RunStateResponse> {
    const run = await this.requireRun(runId);
    const project = await this.requireProject(run.projectId);
    return { project, run };
  }

  async getRunDiff(runId: string): Promise<{ diffSummary: string }> {
    const run = await this.requireRun(runId);
    const candidate = run.candidate ?? (await this.store.getCandidate(run.id));
    return { diffSummary: candidate?.diffSummary ?? "" };
  }

  private async persist(project: ProjectRecord, session: SessionState, run: RunRecord) {
    await this.store.saveSession(session);
    await this.store.saveRun(run);
    await this.store.saveProject(project);
  }

  private async recordCandidatePreviewError(
    project: ProjectRecord,
    session: SessionState,
    run: RunRecord,
    candidate: CandidateChangeSet,
    message: string,
  ): Promise<void> {
    project.preview = { ...project.preview, status: "error", lastLog: message, updatedAt: now() };
    project.updatedAt = now();
    project.session = session;
    project.latestRun = run;
    await this.persist(project, session, run);
    this.publish({
      type: "project.updated",
      projectId: project.id,
      runId: run.id,
      createdAt: now(),
      payload: { project, run, candidate },
    });
  }

  private async persistProgress(projectId: string, sessionId: string, run: RunRecord) {
    this.progressQueue = this.progressQueue
      .catch(() => undefined)
      .then(() => this.persistProgressNow(projectId, sessionId, run));
    await this.progressQueue;
  }

  private async flushProgress(): Promise<void> {
    await this.progressQueue.catch(() => undefined);
  }

  private async persistProgressNow(projectId: string, sessionId: string, run: RunRecord) {
    const [project, session] = await Promise.all([this.store.getProject(projectId), this.store.getSession(sessionId)]);
    if (!project || !session) {
      return;
    }
    session.tasks = run.tasks;
    session.toolCalls = run.toolCalls;
    session.updatedAt = now();
    project.latestRun = run;
    project.session = session;
    project.updatedAt = now();
    await this.persist(project, session, run);
  }

  private async failRunFromBackground(projectId: string, sessionId: string, runId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const [project, session, run] = await Promise.all([
      this.store.getProject(projectId),
      this.store.getSession(sessionId),
      this.store.getRun(runId),
    ]);
    if (!project || !session || !run) {
      return;
    }
    const failedRun: RunRecord = {
      ...run,
      status: "failed",
      phase: "report",
      error: message,
      updatedAt: now(),
    };
    session.error = message;
    session.failureKind = "generation_incomplete";
    session.tasks = failedRun.tasks;
    session.toolCalls = failedRun.toolCalls;
    session.updatedAt = now();
    project.status = "failed";
    project.preview = { ...project.preview, status: "error", lastLog: message, updatedAt: now() };
    project.session = session;
    project.latestRun = failedRun;
    project.updatedAt = now();
    await this.persist(project, session, failedRun);
    this.publish({ type: "run.failed", projectId, runId, createdAt: now(), payload: { project, run: failedRun } });
  }

  private async requireProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.store.getProject(projectId);
    if (!project) {
      throw new NotFoundError("Project not found");
    }
    project.versions = await this.store.listVersions(project.id);
    return project;
  }

  private async requireSession(sessionId: string): Promise<SessionState> {
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

  private portForRun(runId: string): number {
    return safePreviewPort(runId, 4300, 500);
  }

  private portForProject(projectId: string): number {
    return safePreviewPort(projectId, 5200, 500);
  }
}

function upsertTask(tasks: RunRecord["tasks"], task: RunRecord["tasks"][number]): RunRecord["tasks"] {
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index < 0) {
    return [...tasks, task];
  }
  return tasks.map((item, itemIndex) => (itemIndex === index ? task : item));
}

function upsertToolCall(
  toolCalls: RunRecord["toolCalls"],
  toolCall: RunRecord["toolCalls"][number],
): RunRecord["toolCalls"] {
  const index = toolCalls.findIndex((item) => item.id === toolCall.id);
  if (index < 0) {
    return [...toolCalls, toolCall];
  }
  return toolCalls.map((item, itemIndex) => (itemIndex === index ? toolCall : item));
}
