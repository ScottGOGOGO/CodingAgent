import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ClarificationAnswer, ProjectRecord, ReasoningMode } from "@vide/contracts";

import type { AppConfig } from "../config.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { ProjectEventBus } from "../events.js";
import type { ProjectStore } from "../store.js";
import type { WorkspaceService } from "../workspace.js";
import { RunService } from "./run-service.js";

function now() {
  return new Date().toISOString();
}

export class ProjectService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: ProjectStore,
    private readonly bus: ProjectEventBus,
    private readonly workspace: WorkspaceService,
    private readonly runService: RunService,
  ) {}

  async loadProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.store.getProject(projectId);
    if (!project) {
      throw new NotFoundError("Project not found");
    }
    project.versions = await this.store.listVersions(project.id);
    return project;
  }

  async createProject(name?: string, reasoningMode?: ReasoningMode): Promise<ProjectRecord> {
    const createdAt = now();
    const mode = reasoningMode ?? "plan_solve";
    const project: ProjectRecord = {
      id: randomUUID(),
      name: name ?? "Untitled project",
      createdAt,
      updatedAt: createdAt,
      workspaceRoot: join(this.config.projectsRoot, randomUUID()),
      reasoningMode: mode,
      status: "draft",
      preview: { status: "idle", updatedAt: createdAt },
      session: {
        sessionId: "",
        projectId: "",
        reasoningMode: mode,
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
      },
      currentSessionId: "",
      versions: [],
    };

    project.workspaceRoot = join(this.config.projectsRoot, project.id);
    project.session.projectId = project.id;
    await this.workspace.ensureProjectWorkspace(project);
    await this.store.createProject(project);
    const session = await this.runService.createSession(project, mode);
    project.currentSessionId = session.id;
    project.session = session.state;
    await this.store.saveProject(project);

    this.publish({ type: "project.created", projectId: project.id, createdAt, payload: { project } });
    return project;
  }

  async changeMode(projectId: string, reasoningMode: ReasoningMode): Promise<ProjectRecord> {
    const project = await this.loadProject(projectId);
    project.reasoningMode = reasoningMode;
    project.session.reasoningMode = reasoningMode;
    project.updatedAt = now();

    const session = await this.store.getSession(project.currentSessionId);
    if (session) {
      session.reasoningMode = reasoningMode;
      session.state.reasoningMode = reasoningMode;
      session.updatedAt = now();
      await this.store.saveSession(session);
    }

    await this.store.saveProject(project);
    this.publish({ type: "project.updated", projectId, createdAt: now(), payload: { project } });
    return project;
  }

  async sendMessage(
    projectId: string,
    content?: string,
    clarificationAnswers?: ClarificationAnswer[],
    reasoningMode?: ReasoningMode,
  ): Promise<ProjectRecord> {
    const project = await this.loadProject(projectId);
    const mode = reasoningMode ?? project.reasoningMode;

    if (project.latestRun?.status === "awaiting_input") {
      const response = await this.runService.submitRunInput(project.latestRun.id, {
        userMessage: content,
        clarificationAnswers,
      });
      return response.project;
    }

    const response = await this.runService.createRun({
      projectId,
      sessionId: project.currentSessionId,
      reasoningMode: mode,
      userMessage: content,
      clarificationAnswers,
    });
    return response.project;
  }

  async confirmGeneration(projectId: string): Promise<{ project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    if (!project.latestRun || project.latestRun.status !== "awaiting_approval") {
      throw new ConflictError("Project is not waiting for approval.");
    }

    const result = await this.runService.approveRun(project.latestRun.id, true);
    return { project: result.project };
  }

  private publish(event: import("@vide/contracts").ProjectEvent) {
    this.bus.publish(event);
  }
}
