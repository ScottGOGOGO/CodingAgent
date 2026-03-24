import { mkdir } from "node:fs/promises";

import cors from "@fastify/cors";
import Fastify from "fastify";

import { AgentClient } from "./agent-client.js";
import { loadConfig } from "./config.js";
import { ProjectEventBus } from "./events.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerV2Routes } from "./routes/v2.js";
import { RunnerService } from "./runner.js";
import { ExecutionPipeline } from "./services/execution-pipeline.js";
import { ExecutionWorker } from "./services/execution-worker.js";
import { ProjectService } from "./services/project-service.js";
import { ProposalValidator } from "./services/proposal-validator.js";
import { RunService } from "./services/run-service.js";
import { createProjectStore } from "./store.js";
import { WorkspaceService } from "./workspace.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const bus = new ProjectEventBus();
const workspace = new WorkspaceService();
const runner = new RunnerService(config.runnerStrategy);
const agentClient = new AgentClient(config.agentServiceUrl, config.agentServiceTimeoutMs);
const store = await createProjectStore(config.databaseUrl);

const pipeline = new ExecutionPipeline(runner, workspace, agentClient, store, bus);
const worker = new ExecutionWorker(store, bus, pipeline);
const proposalValidator = new ProposalValidator(runner, workspace, agentClient);
const runService = new RunService(store, bus, workspace, agentClient, worker, proposalValidator);
const projectService = new ProjectService(config, store, bus, workspace, runService);

await mkdir(config.projectsRoot, { recursive: true });
await app.register(cors, { origin: true });

registerProjectRoutes(app, projectService, bus);
registerV2Routes(app, projectService, runService);

async function shutdown() {
  app.log.info("Shutting down...");
  await runner.stopAll();
  await app.close();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await app.listen({ port: config.port, host: "0.0.0.0" });
