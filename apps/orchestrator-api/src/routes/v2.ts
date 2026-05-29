import type { FastifyInstance } from "fastify";
import type { ClarificationAnswer } from "@vide/contracts";

import type { RunService } from "../services/run-service.js";

export function registerV2Routes(app: FastifyInstance, runService: RunService) {
  app.post("/runs/:id/input", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      userMessage?: string;
      clarificationAnswers?: ClarificationAnswer[];
    };
    return runService.submitRunInput(id, body);
  });

  app.post("/runs/:id/approve", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? { approved: true }) as { approved?: boolean; feedback?: string };
    return runService.approveRun(id, body.approved ?? true, body.feedback);
  });

  app.post("/runs/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    return runService.cancelRun(id);
  });

  app.get("/runs/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { run: await runService.getRun(id) };
  });

  app.get("/runs/:id/diff", async (request) => {
    const { id } = request.params as { id: string };
    return runService.getRunDiff(id);
  });

  app.get("/runs/:id/state", async (request) => {
    const { id } = request.params as { id: string };
    return runService.getRunState(id);
  });
}
