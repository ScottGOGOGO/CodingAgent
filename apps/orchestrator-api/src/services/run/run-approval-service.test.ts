import test from "node:test";
import assert from "node:assert/strict";

import type { ProjectEvent, ProjectRecord, RunRecord, SessionRecord } from "@vide/contracts";

import { ConflictError } from "../../errors.js";
import { RunApprovalService } from "./run-approval-service.js";

function makeSession(): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: "session-1",
    projectId: "project-1",
    reasoningMode: "plan_solve",
    createdAt: now,
    updatedAt: now,
    state: {
      sessionId: "session-1",
      projectId: "project-1",
      reasoningMode: "plan_solve",
      messages: [],
      workingSpec: {},
      status: "awaiting_approval",
      runPhase: "report",
      planSteps: [],
      fileChangeSummary: [],
      fileOperations: [],
      executionManifest: [],
      versionNumber: 0,
      assumptions: [],
      lastContextPaths: [],
    },
  };
}

function makeRun(): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    projectId: "project-1",
    sessionId: "session-1",
    reasoningMode: "plan_solve",
    action: "turn",
    status: "awaiting_approval",
    phase: "report",
    createdAt: now,
    updatedAt: now,
    state: makeSession().state,
  };
}

function makeProject(session: SessionRecord, run: RunRecord): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: "project-1",
    name: "Demo",
    createdAt: now,
    updatedAt: now,
    workspaceRoot: "/tmp/demo",
    reasoningMode: "plan_solve",
    status: "awaiting_approval",
    preview: {
      status: "idle",
      updatedAt: now,
    },
    currentSessionId: session.id,
    session: session.state,
    latestRun: run,
    versions: [],
  };
}

test("RunApprovalService queues approved runs and enqueues execution", async () => {
  const calls: string[] = [];
  const events: ProjectEvent[] = [];
  const service = new RunApprovalService(
    {
      enqueue(runId: string) {
        calls.push(runId);
      },
    } as never,
    {
      async persist() {
        return;
      },
      publish(event) {
        events.push(event);
      },
    },
  );
  const session = makeSession();
  const run = makeRun();
  const project = makeProject(session, run);

  const result = await service.approveRun(project, session, run, true);

  assert.equal(result.run.status, "queued");
  assert.equal(result.run.phase, "execute_dispatch");
  assert.equal(result.session.state.status, "running");
  assert.equal(result.project.status, "running");
  assert.deepEqual(calls, ["run-1"]);
  assert.equal(events[0]?.type, "run.updated");
});

test("RunApprovalService marks rejected runs as failed", async () => {
  const events: ProjectEvent[] = [];
  const service = new RunApprovalService(
    { enqueue() {} } as never,
    {
      async persist() {
        return;
      },
      publish(event) {
        events.push(event);
      },
    },
  );
  const session = makeSession();
  const run = makeRun();
  const project = makeProject(session, run);

  const result = await service.approveRun(project, session, run, false);

  assert.equal(result.run.status, "cancelled");
  assert.equal(result.run.error, "Approval declined by user.");
  assert.equal(result.session.state.status, "failed");
  assert.equal(result.project.status, "failed");
  assert.equal(events[0]?.type, "run.failed");
});

test("RunApprovalService rejects duplicate approvals", async () => {
  const service = new RunApprovalService(
    { enqueue() {} } as never,
    {
      async persist() {
        return;
      },
      publish() {
        return;
      },
    },
  );
  const session = makeSession();
  const run = { ...makeRun(), status: "completed" as const };
  const project = makeProject(session, run);

  await assert.rejects(() => service.approveRun(project, session, run, true), ConflictError);
});
