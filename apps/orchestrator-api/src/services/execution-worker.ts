import { randomUUID } from "node:crypto";

import type { PreviewInstanceRecord, ProjectEvent, ProjectRecord, RunRecord, SessionRecord } from "@vide/contracts";

import type { ProjectEventBus } from "../events.js";
import type { ProjectStore } from "../store.js";
import { createVersionRecord } from "../versioning.js";
import { type PipelineResult, ExecutionPipeline } from "./execution-pipeline.js";

function now() {
  return new Date().toISOString();
}

export class ExecutionWorker {
  private readonly queue: string[] = [];
  private draining = false;

  constructor(
    private readonly store: ProjectStore,
    private readonly bus: ProjectEventBus,
    private readonly pipeline: ExecutionPipeline,
  ) {}

  enqueue(runId: string) {
    this.queue.push(runId);
    if (!this.draining) {
      void this.drain();
    }
  }

  private async drain() {
    this.draining = true;
    while (this.queue.length > 0) {
      const runId = this.queue.shift();
      if (!runId) {
        continue;
      }
      await this.process(runId);
    }
    this.draining = false;
  }

  private async process(runId: string) {
    const run = await this.store.getRun(runId);
    if (!run) {
      return;
    }

    const project = await this.store.getProject(run.projectId);
    const session = await this.store.getSession(run.sessionId);
    if (!project || !session) {
      return;
    }

    try {
      run.status = "running";
      run.phase = "execute_dispatch";
      run.updatedAt = now();
      session.state.status = "running";
      session.state.runPhase = "execute_dispatch";
      session.updatedAt = now();
      project.status = "running";
      project.preview = { ...project.preview, status: "starting", updatedAt: now() };
      project.session = session.state;
      project.latestRun = run;
      project.updatedAt = now();

      await this.persist(project, session, run);
      this.publish({ type: "run.updated", projectId: project.id, createdAt: now(), payload: { project, run } });

      const result = await this.pipeline.execute(project, run);
      await this.complete(project, session, run, result);
    } catch (error) {
      await this.fail(project, session, run, error);
    }
  }

  private async complete(project: ProjectRecord, session: SessionRecord, run: RunRecord, result: PipelineResult) {
    session.state = result.sessionState;
    session.reasoningMode = project.reasoningMode;
    const version = createVersionRecord(
      project,
      session.state.assistantSummary ?? "Generated project version",
      result.gitCommit,
    );
    await this.store.saveVersion(project.id, version);

    const updatedVersions = await this.store.listVersions(project.id);
    const preview: PreviewInstanceRecord = {
      id: randomUUID(),
      projectId: project.id,
      runId: run.id,
      status: result.previewUrl ? "ready" : "error",
      url: result.previewUrl,
      healthUrl: result.previewUrl,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.store.savePreviewInstance(preview);

    session.state.versionNumber = version.number;
    session.state.previewUrl = result.previewUrl;
    session.state.status = result.previewUrl ? "ready" : "failed";
    session.state.runPhase = "report";
    session.state.run = {
      id: run.id,
      status: "completed",
      phase: "report",
      approvalRequest: run.approvalRequest,
      providerRoute: run.providerRoute,
      evaluation: run.evaluation,
      usage: run.usage,
    };
    session.updatedAt = now();

    run.status = "completed";
    run.phase = "report";
    run.state = session.state;
    run.updatedAt = now();

    project.status = result.previewUrl ? "ready" : "failed";
    project.preview = {
      status: result.previewUrl ? "ready" : "error",
      url: result.previewUrl,
      updatedAt: now(),
    };
    project.session = session.state;
    project.latestRun = run;
    project.versions = updatedVersions;
    project.updatedAt = now();

    await this.persist(project, session, run);
    this.publish({
      type: "run.completed",
      projectId: project.id,
      createdAt: now(),
      payload: { project, run, version },
    });
    this.publish({
      type: "project.preview_ready",
      projectId: project.id,
      createdAt: now(),
      payload: { project, version },
    });
  }

  private async fail(project: ProjectRecord, session: SessionRecord, run: RunRecord, error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown execution error";

    session.state.error = message;
    session.state.status = "failed";
    session.state.runPhase = "report";
    session.state.run = {
      id: run.id,
      status: "failed",
      phase: "report",
      approvalRequest: run.approvalRequest,
      providerRoute: run.providerRoute,
      evaluation: run.evaluation,
      usage: run.usage,
      error: message,
    };
    session.updatedAt = now();

    run.status = "failed";
    run.phase = "report";
    run.error = message;
    run.state = session.state;
    run.updatedAt = now();

    project.status = "failed";
    project.preview = { status: "error", updatedAt: now(), lastLog: message };
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
    this.publish({
      type: "project.error",
      projectId: project.id,
      createdAt: now(),
      payload: { project, message },
    });
  }

  private async persist(project: ProjectRecord, session: SessionRecord, run: RunRecord) {
    await this.store.saveProject(project);
    await this.store.saveSession(session);
    await this.store.saveRun(run);
  }

  private publish(event: ProjectEvent) {
    this.bus.publish(event);
  }
}
