import type { FastifyInstance } from "fastify";
import type { ClarificationAnswer, ProjectEvent, ProjectRecord } from "@vide/contracts";

import { HttpError } from "../errors.js";
import type { ProjectEventBus } from "../events.js";
import type { ProjectService } from "../services/project-service.js";

const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

const createProjectSchema = {
  body: {
    type: "object" as const,
    properties: {
      name: { type: "string" as const, maxLength: 200 },
      reasoningMode: { type: "string" as const, enum: ["plan_solve", "react"] },
    },
    additionalProperties: false,
  },
};

const changeModeSchema = {
  body: {
    type: "object" as const,
    required: ["reasoningMode"],
    properties: {
      reasoningMode: { type: "string" as const, enum: ["plan_solve", "react"] },
    },
    additionalProperties: false,
  },
};

const sendMessageSchema = {
  body: {
    type: "object" as const,
    properties: {
      content: { type: "string" as const },
      reasoningMode: { type: "string" as const, enum: ["plan_solve", "react"] },
      clarificationAnswers: {
        anyOf: [
          {
            type: "object" as const,
            additionalProperties: { type: "string" as const },
          },
          {
            type: "array" as const,
            items: {
              type: "object" as const,
              required: ["questionId", "answer"],
              properties: {
                questionId: { type: "string" as const },
                answer: { type: "string" as const },
              },
              additionalProperties: false,
            },
          },
        ],
      },
    },
    additionalProperties: false,
  },
};

function normalizeAnswers(
  value?: Record<string, string> | ClarificationAnswer[],
): ClarificationAnswer[] | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.filter((item) => item.answer.trim().length > 0);
  }
  return Object.entries(value)
    .map(([questionId, answer]) => ({ questionId, answer }))
    .filter((item) => item.answer.trim().length > 0);
}

export function registerProjectRoutes(
  app: FastifyInstance,
  projectService: ProjectService,
  bus: ProjectEventBus,
) {
  app.get("/health", async () => ({
    status: "ok",
  }));

  app.post("/projects", { schema: createProjectSchema }, async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string; reasoningMode?: "plan_solve" | "react" };
    const project = await projectService.createProject(body.name, body.reasoningMode);
    reply.code(201);
    return { project };
  });

  app.get("/projects/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { project: await projectService.loadProject(id) };
  });

  app.post("/projects/:id/mode", { schema: changeModeSchema }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { reasoningMode: "plan_solve" | "react" };
    const project = await projectService.changeMode(id, body.reasoningMode);
    return { project };
  });

  app.post("/projects/:id/messages", { schema: sendMessageSchema }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      content?: string;
      clarificationAnswers?: Record<string, string> | ClarificationAnswer[];
      reasoningMode?: "plan_solve" | "react";
    };
    const project = await projectService.sendMessage(
      id,
      body.content,
      normalizeAnswers(body.clarificationAnswers),
      body.reasoningMode,
    );
    return { project };
  });

  app.post("/projects/:id/confirm", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await projectService.confirmGeneration(id);
    } catch (error) {
      if (error instanceof HttpError) {
        reply.code(error.statusCode);
        return { error: error.message };
      }
      const message = error instanceof Error ? error.message : "Unknown execution error";
      reply.code(500);
      return { error: message };
    }
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

    send({
      type: "project.updated",
      projectId: id,
      createdAt: new Date().toISOString(),
      payload: { project },
    });

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
