import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ClarificationAnswer, ProjectEvent, ProjectRecord } from "@vide/contracts";

import type { AppConfig } from "../config.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { ProjectEventBus } from "../events.js";
import type { ProjectStore } from "../store.js";
import type { WorkspaceService } from "../workspace.js";
import { createSession, now, RunService } from "./run-service.js";

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

  async createProject(name?: string): Promise<ProjectRecord> {
    const createdAt = now();
    const project: ProjectRecord = {
      id: randomUUID(),
      name: name?.trim() || "Untitled local app",
      createdAt,
      updatedAt: createdAt,
      workspaceRoot: "",
      mode: "local_generator",
      status: "draft",
      preview: { status: "idle", updatedAt: createdAt },
      session: undefined as unknown as ProjectRecord["session"],
      currentSessionId: "",
      versions: [],
    };
    project.workspaceRoot = join(this.config.projectsRoot, project.id);
    const session = createSession(project);
    project.session = session;
    project.currentSessionId = session.id;

    await this.workspace.ensureProjectWorkspace(project);
    await this.store.createProject(project);
    await this.store.createSession(session);
    this.publish({ type: "project.created", projectId: project.id, createdAt, payload: { project } });
    return project;
  }

  async sendMessage(
    projectId: string,
    content?: string,
    clarificationAnswers?: ClarificationAnswer[],
  ): Promise<ProjectRecord> {
    const project = await this.loadProject(projectId);
    if (project.latestRun?.status === "awaiting_input") {
      const response = await this.runService.submitRunInput(project.latestRun.id, {
        userMessage: content,
        clarificationAnswers,
      });
      return response.project;
    }

    const response = await this.runService.createRun({
      projectId,
      userMessage: content,
      clarificationAnswers,
    });
    return response.project;
  }

  async approveLatestCandidate(projectId: string, approved: boolean, feedback?: string): Promise<{ project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    if (!project.latestRun) {
      throw new ConflictError("Project has no active run.");
    }
    const response = await this.runService.approveRun(project.latestRun.id, approved, feedback);
    return { project: response.project };
  }

  private publish(event: ProjectEvent) {
    this.bus.publish(event);
  }
}
