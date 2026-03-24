import type { AgentSessionState, ExecutionStep, ProjectEvent, ProjectRecord, RunRecord } from "@vide/contracts";

import type { AgentClient } from "../agent-client.js";
import type { ProjectEventBus } from "../events.js";
import { CommandExecutionError, type RunnerService } from "../runner.js";
import type { ProjectStore } from "../store.js";
import type { WorkspaceService } from "../workspace.js";

const MAX_BUILD_FIX_ATTEMPTS = 4;

function now() {
  return new Date().toISOString();
}

export interface PipelineResult {
  previewUrl?: string;
  gitCommit?: string;
  sessionState: AgentSessionState;
}

export class ExecutionPipeline {
  constructor(
    private readonly runner: RunnerService,
    private readonly workspace: WorkspaceService,
    private readonly agentClient: AgentClient,
    private readonly store: ProjectStore,
    private readonly bus: ProjectEventBus,
  ) {}

  async execute(project: ProjectRecord, run: RunRecord): Promise<PipelineResult> {
    const emitLog = async (message: string) => {
      this.publishLog(project.id, message);
    };

    await this.workspace.resetPreviewLog(project);
    await this.workspace.applyFileOperations(project, run.state.fileOperations);

    let previewUrl: string | undefined;
    let gitCommit: string | undefined;

    const stopStep = this.findStep(run, "stop_preview");
    const installStep = this.findStep(run, "install_dependencies");
    const buildStep = this.findStep(run, "build_web_app");
    const previewStep = this.findStep(run, "start_vite_preview");
    const healthStep = this.findStep(run, "health_check");
    const snapshotStep = this.findStep(run, "git_snapshot");

    if (stopStep) {
      await this.runner.execute(stopStep, project, emitLog);
    }

    if (installStep) {
      await this.runner.execute(installStep, project, emitLog);
    }

    if (buildStep) {
      await this.runBuildFixLoop(project, run, buildStep, installStep, emitLog);
    }

    if (previewStep) {
      previewUrl = (await this.runner.execute(previewStep, project, emitLog)) ?? previewUrl;
    }

    if (healthStep) {
      previewUrl = (await this.runner.execute(
        {
          type: "health_check",
          description: healthStep.description,
          url: healthStep.url ?? previewUrl,
          port: healthStep.port,
        },
        project,
        emitLog,
      )) ?? previewUrl;
    }

    if (snapshotStep?.message) {
      gitCommit = await this.workspace.snapshot(project, snapshotStep.message);
    }

    return { previewUrl, gitCommit, sessionState: run.state };
  }

  private findStep(run: RunRecord, type: ExecutionStep["type"]): ExecutionStep | undefined {
    return run.state.executionManifest.find((step) => step.type === type);
  }

  private async runBuildFixLoop(
    project: ProjectRecord,
    run: RunRecord,
    buildStep: ExecutionStep,
    installStep: ExecutionStep | undefined,
    emitLog: (message: string) => Promise<void>,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_BUILD_FIX_ATTEMPTS + 1; attempt += 1) {
      try {
        await this.runner.execute(buildStep, project, emitLog);
        return;
      } catch (error) {
        if (!(error instanceof CommandExecutionError) || attempt > MAX_BUILD_FIX_ATTEMPTS) {
          throw error;
        }

        const buildError = error.output || (await this.workspace.readPreviewLogTail(project)) || error.message;
        await emitLog(`Build failed on attempt ${attempt}. Requesting repair before retrying.\n`);

        const repair = await this.agentClient.runRepair({
          project,
          reasoningMode: project.reasoningMode,
          workspaceSnapshot: await this.workspace.readWorkspaceSnapshot(project),
          repairContext: {
            attempt,
            category: "type_build",
            failedCommand: error.command.join(" "),
            buildError,
          },
        });

        if (repair.state.error) {
          throw new Error(repair.state.error);
        }

        if (!repair.state.fileOperations.length) {
          throw new Error("Repair loop returned no file operations after a failed build.");
        }

        project.session = repair.state;
        project.status = "repairing";
        project.updatedAt = now();
        run.state = repair.state;
        run.phase = repair.state.runPhase;
        run.updatedAt = now();
        run.status = "running";
        const session = (await this.store.getSession(project.currentSessionId)) ?? {
          id: project.currentSessionId,
          projectId: project.id,
          reasoningMode: project.reasoningMode,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          state: project.session,
        };
        session.state = project.session;
        session.reasoningMode = project.reasoningMode;
        session.updatedAt = project.updatedAt;

        await this.store.saveProject(project);
        await this.store.saveSession(session);
        await this.store.saveRun(run);
        this.publish({ type: "run.repair_started", projectId: project.id, createdAt: now(), payload: { project, run } });

        await this.workspace.applyFileOperations(project, repair.state.fileOperations);

        if (installStep) {
          await emitLog(`Re-installing dependencies after repair attempt ${attempt}.\n`);
          await this.runner.execute(installStep, project, emitLog);
        }
      }
    }
  }

  private publish(event: ProjectEvent) {
    this.bus.publish(event);
  }

  private publishLog(projectId: string, message: string) {
    this.bus.publish({
      type: "project.preview_log",
      projectId,
      createdAt: now(),
      payload: { message },
    });
  }
}
