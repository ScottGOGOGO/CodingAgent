import type { FastifyInstance } from "fastify";
import type { ClarificationAnswer, ReasoningMode } from "@vide/contracts";

import type { ProjectService } from "../services/project-service.js";
import type { RunService } from "../services/run-service.js";

const createSessionSchema = {
  body: {
    type: "object" as const,
    required: ["projectId"],
    properties: {
      projectId: { type: "string" as const },
      reasoningMode: { type: "string" as const, enum: ["plan_solve", "react"] },
    },
    additionalProperties: false,
  },
};

const createRunSchema = {
  body: {
    type: "object" as const,
    required: ["projectId", "sessionId"],
    properties: {
      projectId: { type: "string" as const },
      sessionId: { type: "string" as const },
      reasoningMode: { type: "string" as const, enum: ["plan_solve", "react"] },
      userMessage: { type: "string" as const },
      clarificationAnswers: {
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
    },
    additionalProperties: false,
  },
};

const inputRunSchema = {
  body: {
    type: "object" as const,
    properties: {
      userMessage: { type: "string" as const },
      clarificationAnswers: {
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
    },
    additionalProperties: false,
  },
};

export function registerV2Routes(
  app: FastifyInstance,
  projectService: ProjectService,
  runService: RunService,
) {
  app.post("/v2/sessions", { schema: createSessionSchema }, async (request) => {
    const body = request.body as { projectId: string; reasoningMode?: ReasoningMode };
    const project = await projectService.loadProject(body.projectId);
    const session = await runService.createSession(project, body.reasoningMode ?? project.reasoningMode);
    const updatedProject = await projectService.loadProject(project.id);
    return { project: updatedProject, session };
  });

  app.post("/v2/runs", { schema: createRunSchema }, async (request) => {
    const body = request.body as {
      projectId: string;
      sessionId: string;
      reasoningMode?: ReasoningMode;
      userMessage?: string;
      clarificationAnswers?: ClarificationAnswer[];
    };
    return runService.createRun(body);
  });

  app.post("/v2/runs/:id/input", { schema: inputRunSchema }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      userMessage?: string;
      clarificationAnswers?: ClarificationAnswer[];
    };
    return runService.submitRunInput(id, body);
  });

  app.post("/v2/runs/:id/approve", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? { approved: true }) as { approved?: boolean };
    return runService.approveRun(id, body.approved ?? true);
  });

  app.get("/v2/runs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const run = await runService.getRun(id);
    return { run };
  });

  app.get("/v2/runs/:id/state", async (request) => {
    const { id } = request.params as { id: string };
    return runService.getRunState(id);
  });
}
