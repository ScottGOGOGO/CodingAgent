import test from "node:test";
import assert from "node:assert/strict";

import type { CandidateChangeSet, ProjectRecord, RunRecord, SessionState, VersionRecord } from "@vide/contracts";
import { safePreviewPort } from "@vide/agent-runtime";

import { ProjectEventBus } from "../events.js";
import type { RunnerService } from "../runner.js";
import { MemoryProjectStore } from "../store.js";
import type { WorkspaceService } from "../workspace.js";
import { RunService } from "./run-service.js";

function makeSession(projectId: string, now: string): SessionState {
  return {
    id: "session-1",
    projectId,
    mode: "local_generator",
    messages: [],
    tasks: [],
    toolCalls: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeProject(now: string): ProjectRecord {
  const session = makeSession("project-1", now);
  return {
    id: "project-1",
    name: "Generated App",
    createdAt: now,
    updatedAt: now,
    workspaceRoot: "/tmp/generated-app",
    mode: "local_generator",
    status: "awaiting_approval",
    preview: { status: "ready", candidateUrl: "http://127.0.0.1:4300", updatedAt: now },
    session,
    currentSessionId: session.id,
    versions: [],
  };
}

function makeRun(project: ProjectRecord, now: string): RunRecord {
  return {
    id: "run-1",
    projectId: project.id,
    sessionId: project.currentSessionId,
    mode: "local_generator",
    status: "awaiting_approval",
    phase: "approval",
    tasks: [],
    toolCalls: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeCandidate(run: RunRecord, now: string): CandidateChangeSet {
  return {
    id: "candidate-1",
    runId: run.id,
    baseVersion: 0,
    changedFiles: [{ path: "src/app/page.tsx", changeType: "created", additions: 40, deletions: 0 }],
    diffSummary: "created: src/app/page.tsx",
    validation: { status: "passed", command: "npm run build", summary: "Build passed." },
    sandboxPath: "/tmp/generated-app/.agent/sandboxes/run-1",
    artifactIds: [],
    createdAt: now,
  };
}

test("approveRun stops old preview, builds production bundle, then starts production preview", async () => {
  const now = new Date().toISOString();
  const store = new MemoryProjectStore();
  const bus = new ProjectEventBus();
  const project = makeProject(now);
  const run = makeRun(project, now);
  const candidate = makeCandidate(run, now);
  run.candidate = candidate;
  project.latestRun = run;
  project.candidate = candidate;

  await store.createProject(project);
  await store.createSession(project.session);
  await store.createRun(run);
  await store.saveCandidate(candidate);

  const workspaceCalls: string[] = [];
  const workspace = {
    async promoteSandbox(promotedProject: ProjectRecord, sandboxPath: string) {
      workspaceCalls.push(`promote:${promotedProject.id}:${sandboxPath}`);
    },
    async snapshot(): Promise<string> {
      workspaceCalls.push("snapshot");
      return "abc123";
    },
  } as unknown as WorkspaceService;

  const runnerCalls: string[] = [];
  const runner = {
    async stop(id: string) {
      runnerCalls.push(`stop:${id}`);
    },
    async runCommand(_target: unknown, command: string[]) {
      runnerCalls.push(`run:${command.join(" ")}`);
    },
    async startPreview(_target: unknown, port: number) {
      runnerCalls.push(`start:${port}`);
      return `http://127.0.0.1:${port}`;
    },
    async startDevPreview(_target: unknown, port: number) {
      runnerCalls.push(`dev-start:${port}`);
      return `http://127.0.0.1:${port}`;
    },
  } as unknown as RunnerService;

  const service = new RunService(store, bus, workspace, runner);
  const response = await service.approveRun(run.id, true);

  assert.deepEqual(workspaceCalls, [`promote:${project.id}:${candidate.sandboxPath}`, "snapshot"]);
  assert.deepEqual(runnerCalls, [
    `stop:project-${project.id}`,
    "run:npm install",
    "run:npm run build",
    `start:${safePreviewPort(project.id, 5200, 500)}`,
  ]);
  assert.equal(response.project.status, "ready");
  assert.equal(response.project.preview.status, "ready");
  assert.match(response.project.preview.url ?? "", /^http:\/\/127\.0\.0\.1:/);

  const versions: VersionRecord[] = await store.listVersions(project.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.gitCommit, "abc123");
});

test("candidate preview errors are persisted and broadcast with log details", async () => {
  const now = new Date().toISOString();
  const store = new MemoryProjectStore();
  const bus = new ProjectEventBus();
  const project = makeProject(now);
  const run = makeRun(project, now);
  const candidate = makeCandidate(run, now);
  run.candidate = candidate;
  project.latestRun = run;
  project.candidate = candidate;

  await store.createProject(project);
  await store.createSession(project.session);
  await store.createRun(run);
  await store.saveCandidate(candidate);

  const events: string[] = [];
  bus.subscribe(project.id, (event) => {
    if (event.type === "project.updated") {
      events.push(event.payload.project?.preview.lastLog ?? "");
    }
  });

  const service = new RunService(store, bus, {} as WorkspaceService, {} as RunnerService);
  await (service as unknown as {
    recordCandidatePreviewError(
      project: ProjectRecord,
      session: SessionState,
      run: RunRecord,
      candidate: CandidateChangeSet,
      message: string,
    ): Promise<void>;
  }).recordCandidatePreviewError(
    project,
    project.session,
    run,
    candidate,
    "Preview server returned 500.\nModule not found: Can't resolve '@训练档案/client'",
  );

  assert.ok(events.some((message) => /@训练档案\/client/.test(message)));

  const savedProject = await store.getProject(project.id);
  assert.equal(savedProject?.preview.status, "error");
  assert.match(savedProject?.preview.lastLog ?? "", /Preview server returned 500/);
});

test("safePreviewPort skips browser-reserved preview ports", () => {
  assert.equal(safePreviewPort("l", 6560, 120), 6670);
  assert.notEqual(safePreviewPort("l", 6560, 120), 6668);
});
