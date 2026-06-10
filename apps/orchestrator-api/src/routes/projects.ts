import type { FastifyInstance } from "fastify";
import type { ClarificationAnswer, ProjectEvent } from "@vide/contracts";

import { HttpError } from "../errors.js";
import type { ProjectEventBus } from "../events.js";
import type { ProjectService } from "../services/project-service.js";
import type { RunService } from "../services/run-service.js";

const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

export function registerProjectRoutes(
  app: FastifyInstance,
  projectService: ProjectService,
  runService: RunService,
  bus: ProjectEventBus,
) {
  app.get("/health", async () => ({ status: "ok", runtime: "typescript-agent" }));

  app.post("/projects", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string };
    const project = await projectService.createProject(body.name);
    reply.code(201);
    return { project };
  });

  app.get("/projects/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { project: await projectService.loadProject(id) };
  });

  app.post("/projects/:id/runs", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      userMessage?: string;
      content?: string;
      clarificationAnswers?: ClarificationAnswer[];
    };
    return runService.createRun({
      projectId: id,
      userMessage: body.userMessage ?? body.content,
      clarificationAnswers: body.clarificationAnswers,
    });
  });

  app.post("/projects/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      content?: string;
      userMessage?: string;
      clarificationAnswers?: ClarificationAnswer[];
    };
    const project = await projectService.sendMessage(id, body.content ?? body.userMessage, body.clarificationAnswers);
    return { project };
  });

  app.post("/projects/:id/approve", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? { approved: true }) as { approved?: boolean; feedback?: string };
    return projectService.approveLatestCandidate(id, body.approved ?? true, body.feedback);
  });

  app.post("/projects/:id/confirm", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? { approved: true }) as { approved?: boolean; feedback?: string };
    return projectService.approveLatestCandidate(id, body.approved ?? true, body.feedback);
  });

  app.get("/projects/:id/versions", async (request) => {
    const { id } = request.params as { id: string };
    const project = await projectService.loadProject(id);
    return { versions: project.versions };
  });

  app.get("/projects/:id/preview", async (request) => {
    const { id } = request.params as { id: string };
    const project = await projectService.loadProject(id);
    return { preview: project.preview };
  });

  app.get("/projects/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await projectService.loadProject(id);

    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    reply.raw.flushHeaders();

    const send = (event: ProjectEvent) => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ type: "project.updated", projectId: id, createdAt: new Date().toISOString(), payload: { project } });

    const unsubscribe = bus.subscribe(id, send);
    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, SSE_HEARTBEAT_INTERVAL_MS);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }
    const err = error as Record<string, unknown>;
    if (err.validation) {
      reply.status(400).send({ error: String(err.message ?? "Validation error") });
      return;
    }
    reply.status(500).send({ error: error instanceof Error ? error.message : "Internal server error" });
  });
}
