import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import type {
  ApprovalRequest,
  PreviewInstanceRecord,
  ProjectRecord,
  RunRecord,
  SessionRecord,
  UsageMetrics,
  VersionRecord,
} from "@vide/contracts";

import { MemoryProjectStore, PostgresProjectStore } from "./store.js";

function makeSession(project: ProjectRecord): SessionRecord {
  return {
    id: project.currentSessionId,
    projectId: project.id,
    reasoningMode: project.reasoningMode,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    state: project.session,
  };
}

function makeRun(project: ProjectRecord, session: SessionRecord): RunRecord {
  return {
    id: "run-1",
    projectId: project.id,
    sessionId: session.id,
    reasoningMode: project.reasoningMode,
    action: "turn",
    status: "queued",
    phase: "intake",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    state: session.state,
  };
}

function makeApproval(run: RunRecord): ApprovalRequest {
  return {
    runId: run.id,
    projectId: run.projectId,
    summary: "Review the generated changes.",
    createdAt: run.createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function makeVersion(): VersionRecord {
  return {
    id: "version-1",
    number: 1,
    summary: "Initial generated version",
    createdAt: new Date().toISOString(),
  };
}

function makePreviewInstance(projectId: string, runId: string): PreviewInstanceRecord {
  const now = new Date().toISOString();
  return {
    id: "preview-1",
    projectId,
    runId,
    status: "ready",
    url: "http://127.0.0.1:4173",
    healthUrl: "http://127.0.0.1:4173",
    createdAt: now,
    updatedAt: now,
  };
}

class FakePool {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  responses: Array<{ rows: Array<{ payload: unknown }> }> = [];

  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql: String(sql), values });
    return this.responses.shift() ?? { rows: [] };
  }
}

function makeProject(): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: "project-1",
    name: "Test Project",
    createdAt: now,
    updatedAt: now,
    workspaceRoot: "/tmp/project-1",
    reasoningMode: "plan_solve",
    status: "draft",
    preview: {
      status: "idle",
      updatedAt: now,
    },
    currentSessionId: "session-1",
    session: {
      sessionId: "session-1",
      projectId: "project-1",
      reasoningMode: "plan_solve",
      messages: [],
      workingSpec: {},
      status: "draft",
      planSteps: [],
      fileChangeSummary: [],
      fileOperations: [],
      executionManifest: [],
      versionNumber: 0,
      assumptions: [],
      lastContextPaths: [],
    },
    versions: [],
  };
}

test("memory store persists project updates", async () => {
  const store = new MemoryProjectStore();
  const project = makeProject();
  const session = makeSession(project);
  const run = makeRun(project, session);
  const approval = makeApproval(run);
  const version = makeVersion();
  const preview = makePreviewInstance(project.id, run.id);
  const usage: UsageMetrics = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };

  await store.createProject(project);
  await store.createSession(session);
  await store.createRun(run);
  await store.saveApproval(approval);
  await store.saveVersion(project.id, version);
  await store.savePreviewInstance(preview);
  await store.saveUsageMetrics(run.id, usage);
  project.status = "ready";
  await store.saveProject(project);

  const loadedProject = await store.getProject(project.id);
  const loadedSession = await store.getSession(session.id);
  const loadedRun = await store.getRun(run.id);
  const loadedVersions = await store.listVersions(project.id);
  const loadedUsage = await store.getUsageMetrics(run.id);

  assert.equal(loadedProject?.status, "ready");
  assert.deepEqual(loadedSession, session);
  assert.deepEqual(loadedRun, run);
  assert.deepEqual(loadedVersions, [version]);
  assert.deepEqual(loadedUsage, usage);
});

test("postgres store keeps only the retained tables and main-path queries", async () => {
  const project = makeProject();
  const session = makeSession(project);
  const run = makeRun(project, session);
  const approval = makeApproval(run);
  const version = makeVersion();
  const preview = makePreviewInstance(project.id, run.id);
  const usage: UsageMetrics = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };

  const pool = new FakePool();
  pool.responses.push(
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [{ payload: project }] },
    { rows: [{ payload: session }] },
    { rows: [{ payload: run }] },
    { rows: [{ payload: version }] },
    { rows: [{ payload: usage }] },
  );

  const store = new PostgresProjectStore(pool as unknown as Pool);

  await store.initialize();
  await store.saveProject(project);
  await store.saveSession(session);
  await store.saveRun(run);
  await store.saveApproval(approval);
  await store.saveVersion(project.id, version);
  await store.savePreviewInstance(preview);
  await store.saveUsageMetrics(run.id, usage);

  const loadedProject = await store.getProject(project.id);
  const loadedSession = await store.getSession(session.id);
  const loadedRun = await store.getRun(run.id);
  const loadedVersions = await store.listVersions(project.id);
  const loadedUsage = await store.getUsageMetrics(run.id);

  const ddl = pool.calls[0]?.sql ?? "";
  const queries = pool.calls.map((call) => call.sql).join("\n");

  assert.match(ddl, /CREATE TABLE IF NOT EXISTS approvals/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS preview_instances/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS usage_metrics/);
  assert.doesNotMatch(ddl, /CREATE TABLE IF NOT EXISTS artifacts/);
  assert.doesNotMatch(ddl, /CREATE TABLE IF NOT EXISTS tool_call_traces/);
  assert.match(queries, /INSERT INTO projects/);
  assert.match(queries, /INSERT INTO sessions/);
  assert.match(queries, /INSERT INTO runs/);
  assert.match(queries, /INSERT INTO approvals/);
  assert.match(queries, /INSERT INTO versions/);
  assert.match(queries, /INSERT INTO preview_instances/);
  assert.match(queries, /INSERT INTO usage_metrics/);
  assert.equal(loadedProject?.id, project.id);
  assert.equal(loadedSession?.id, session.id);
  assert.equal(loadedRun?.id, run.id);
  assert.deepEqual(loadedVersions, [version]);
  assert.deepEqual(loadedUsage, usage);
});
