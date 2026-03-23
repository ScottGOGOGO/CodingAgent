import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import cors from "@fastify/cors";
import Fastify from "fastify";
import type {
  AgentSessionState,
  ExecutionStep,
  PreviewInfo,
  ProjectEvent,
  ProjectRecord,
  ReasoningMode,
  SlotKey,
} from "@vide/contracts";

import { AgentClient } from "./agent-client.js";
import { loadConfig } from "./config.js";
import { ProjectEventBus } from "./events.js";
import { CommandExecutionError, RunnerService } from "./runner.js";
import { createProjectStore } from "./store.js";
import { createVersionRecord } from "./versioning.js";
import { WorkspaceService } from "./workspace.js";

const MAX_BUILD_FIX_ATTEMPTS = 4;

const config = loadConfig();
const app = Fastify({ logger: true });
const bus = new ProjectEventBus();
const workspace = new WorkspaceService();
const runner = new RunnerService(config.runnerStrategy);
const agentClient = new AgentClient(config.agentServiceUrl);
const store = await createProjectStore(config.databaseUrl);

await mkdir(config.projectsRoot, { recursive: true });
await app.register(cors, { origin: true });

function now() {
  return new Date().toISOString();
}

function initialSession(projectId: string, sessionId: string, reasoningMode: ReasoningMode): AgentSessionState {
  return {
    sessionId,
    projectId,
    reasoningMode,
    messages: [],
    requirementSlots: {},
    clarityScore: 0,
    clarificationRounds: 0,
    missingSlots: [],
    clarificationQuestions: [],
    status: "draft",
    planSteps: [],
    fileChangeSummary: [],
    fileChanges: [],
    executionManifest: [],
    versionNumber: 0,
  };
}

function previewInfo(): PreviewInfo {
  return {
    status: "idle",
    updatedAt: now(),
  };
}

function publish(event: ProjectEvent) {
  bus.publish(event);
}

async function publishLog(projectId: string, message: string) {
  publish({
    type: "project.preview_log",
    projectId,
    createdAt: now(),
    payload: { message },
  });
}

async function loadProject(projectId: string): Promise<ProjectRecord> {
  const project = await store.get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  return project;
}

async function runBuildFixLoop(args: {
  project: ProjectRecord;
  buildStep: Extract<ExecutionStep, { type: "build_web_app" }>;
  installStep?: Extract<ExecutionStep, { type: "install_dependencies" }>;
}): Promise<void> {
  const { buildStep, installStep, project } = args;
  const emitLog = async (message: string) => {
    await publishLog(project.id, message);
  };

  for (let attempt = 1; attempt <= MAX_BUILD_FIX_ATTEMPTS + 1; attempt += 1) {
    try {
      await runner.execute(buildStep, project, emitLog);
      return;
    } catch (error) {
      if (!(error instanceof CommandExecutionError) || attempt > MAX_BUILD_FIX_ATTEMPTS) {
        throw error;
      }

      const buildError = error.output || (await workspace.readPreviewLogTail(project)) || error.message;
      await emitLog(`Build failed on attempt ${attempt}. Requesting Qwen repair before retrying.\n`);

      const repair = await agentClient.runRepair({
        project,
        reasoningMode: project.reasoningMode,
        workspaceSnapshot: await workspace.readWorkspaceSnapshot(project),
        repairContext: {
          attempt,
          failedCommand: error.command.join(" "),
          buildError,
        },
      });

      if (repair.state.error) {
        throw new Error(repair.state.error);
      }

      if (!repair.state.fileChanges.length) {
        throw new Error("Repair loop returned no file changes after a failed build.");
      }

      project.session = repair.state;
      project.status = "applying_changes";
      project.updatedAt = now();
      await store.save(project);
      publish({
        type: "project.updated",
        projectId: project.id,
        createdAt: now(),
        payload: { project },
      });

      await workspace.applyFileChanges(project, repair.state.fileChanges);

      if (installStep) {
        await emitLog(`Re-installing dependencies after repair attempt ${attempt}.\n`);
        await runner.execute(installStep, project, emitLog);
      }
    }
  }
}

app.get("/health", async () => ({
  status: "ok",
  agentServiceUrl: config.agentServiceUrl,
  runnerStrategy: config.runnerStrategy,
}));

app.post("/projects", async (request, reply) => {
  const body = (request.body as { name?: string; reasoningMode?: ReasoningMode } | undefined) ?? {};
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const createdAt = now();
  const reasoningMode = body.reasoningMode ?? "plan_solve";

  const project: ProjectRecord = {
    id: projectId,
    name: body.name ?? "Untitled project",
    createdAt,
    updatedAt: createdAt,
    workspaceRoot: join(config.projectsRoot, projectId),
    reasoningMode,
    status: "draft",
    preview: previewInfo(),
    session: initialSession(projectId, sessionId, reasoningMode),
    versions: [],
  };

  await workspace.ensureProjectWorkspace(project);
  await store.create(project);

  publish({
    type: "project.created",
    projectId,
    createdAt,
    payload: { project },
  });

  reply.code(201);
  return { project };
});

app.get("/projects/:id", async (request) => {
  const { id } = request.params as { id: string };
  return { project: await loadProject(id) };
});

app.post("/projects/:id/mode", async (request) => {
  const { id } = request.params as { id: string };
  const body = request.body as { reasoningMode: ReasoningMode };
  const project = await loadProject(id);
  project.reasoningMode = body.reasoningMode;
  project.session.reasoningMode = body.reasoningMode;
  project.updatedAt = now();

  await store.save(project);
  publish({
    type: "project.updated",
    projectId: id,
    createdAt: now(),
    payload: { project },
  });

  return { project };
});

app.post("/projects/:id/messages", async (request) => {
  const { id } = request.params as { id: string };
  const body =
    (request.body as {
      clarificationAnswers?: Partial<Record<SlotKey, string>>;
      content?: string;
      reasoningMode?: ReasoningMode;
    } | undefined) ?? {};

  const project = await loadProject(id);
  const reasoningMode = body.reasoningMode ?? project.reasoningMode;
  const workspaceSnapshot = await workspace.readWorkspaceSnapshot(project);

  const response = await agentClient.runTurn({
    project,
    userMessage: body.content,
    clarificationAnswers: body.clarificationAnswers,
    reasoningMode,
    workspaceSnapshot,
  });

  project.reasoningMode = reasoningMode;
  project.session = response.state;
  project.status = response.state.status;
  project.updatedAt = now();

  await store.save(project);
  publish({
    type: project.status === "ready_for_confirmation" ? "project.plan_ready" : "project.updated",
    projectId: id,
    createdAt: now(),
    payload: { project },
  });

  return { project };
});

app.post("/projects/:id/confirm", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await loadProject(id);

  if (project.status !== "ready_for_confirmation") {
    reply.code(409);
    return { error: "Project is not waiting for confirmation." };
  }

  project.status = "applying_changes";
  project.preview = { ...project.preview, status: "starting", updatedAt: now() };
  await store.save(project);
  publish({
    type: "project.updated",
    projectId: id,
    createdAt: now(),
    payload: { project },
  });

  try {
    await workspace.resetPreviewLog(project);
    await workspace.applyFileChanges(project, project.session.fileChanges);

    let previewUrl: string | undefined;
    let gitCommit: string | undefined;
    const stopStep = project.session.executionManifest.find(
      (step): step is Extract<ExecutionStep, { type: "stop_preview" }> => step.type === "stop_preview",
    );
    const installStep = project.session.executionManifest.find(
      (step): step is Extract<ExecutionStep, { type: "install_dependencies" }> =>
        step.type === "install_dependencies",
    );
    const buildStep = project.session.executionManifest.find(
      (step): step is Extract<ExecutionStep, { type: "build_web_app" }> => step.type === "build_web_app",
    );
    const previewStep = project.session.executionManifest.find(
      (step): step is Extract<ExecutionStep, { type: "start_vite_preview" }> =>
        step.type === "start_vite_preview",
    );
    const snapshotStep = project.session.executionManifest.find(
      (step): step is Extract<ExecutionStep, { type: "git_snapshot" }> => step.type === "git_snapshot",
    );
    const emitLog = async (message: string) => {
      await publishLog(id, message);
    };

    if (stopStep) {
      await runner.execute(stopStep, project, emitLog);
    }

    if (installStep) {
      await runner.execute(installStep, project, emitLog);
    }

    if (buildStep) {
      await runBuildFixLoop({
        project,
        buildStep,
        installStep,
      });
    }

    if (previewStep) {
      previewUrl = (await runner.execute(previewStep, project, emitLog)) ?? previewUrl;
    }

    if (snapshotStep) {
      gitCommit = await workspace.snapshot(project, snapshotStep.message);
    }

    const version = createVersionRecord(
      project,
      project.session.assistantSummary ?? "Generated project version",
      gitCommit,
    );

    project.versions.push(version);
    project.status = previewUrl ? "ready" : "planning";
    project.preview = {
      status: previewUrl ? "ready" : "idle",
      url: previewUrl,
      updatedAt: now(),
    };
    project.session.versionNumber = version.number;
    project.session.previewUrl = previewUrl;
    project.session.status = project.status;
    project.updatedAt = now();

    await store.save(project);
    publish({
      type: "project.preview_ready",
      projectId: id,
      createdAt: now(),
      payload: { project, version },
    });

    return { project, version };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown execution error";
    project.status = "error";
    project.preview = {
      status: "error",
      updatedAt: now(),
      lastLog: message,
    };
    project.session.error = message;
    project.session.status = "error";
    project.updatedAt = now();
    await store.save(project);

    publish({
      type: "project.error",
      projectId: id,
      createdAt: now(),
      payload: { message, project },
    });

    reply.code(500);
    return { error: message };
  }
});

app.get("/projects/:id/versions", async (request) => {
  const { id } = request.params as { id: string };
  const project = await loadProject(id);
  return { versions: project.versions };
});

app.get("/projects/:id/preview", async (request) => {
  const { id } = request.params as { id: string };
  const project = await loadProject(id);
  return { preview: project.preview };
});

app.get("/projects/:id/stream", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await loadProject(id);

  reply.raw.setHeader("content-type", "text/event-stream");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");
  reply.raw.flushHeaders();

  const send = (event: ProjectEvent) => {
    reply.raw.write(`event: ${event.type}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  send({
    type: "project.updated",
    projectId: id,
    createdAt: now(),
    payload: { project },
  });

  const unsubscribe = bus.subscribe(id, send);

  request.raw.on("close", () => {
    unsubscribe();
    reply.raw.end();
  });
});

app.setErrorHandler((error, _request, reply) => {
  reply.status(500).send({ error: error instanceof Error ? error.message : "Internal server error" });
});

await app.listen({ port: config.port, host: "0.0.0.0" });
