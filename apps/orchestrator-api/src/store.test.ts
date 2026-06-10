import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import type { CandidateChangeSet, ProjectRecord, RunRecord, SessionState, VersionRecord } from "@vide/contracts";

import { MemoryProjectStore, PostgresProjectStore } from "./store.js";

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
  const session: SessionState = {
    id: "session-1",
    projectId: "project-1",
    mode: "local_generator",
    messages: [],
    tasks: [],
    toolCalls: [],
    createdAt: now,
    updatedAt: now,
  };
  return {
    id: "project-1",
    name: "Test Project",
    createdAt: now,
    updatedAt: now,
    workspaceRoot: "/tmp/project-1",
    mode: "local_generator",
    status: "draft",
    preview: { status: "idle", updatedAt: now },
    currentSessionId: session.id,
    session,
    versions: [],
  };
}

function makeRun(project: ProjectRecord): RunRecord {
  return {
    id: "run-1",
    projectId: project.id,
    sessionId: project.currentSessionId,
    mode: "local_generator",
    status: "running",
    phase: "intake",
    tasks: [],
    toolCalls: [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function makeCandidate(run: RunRecord): CandidateChangeSet {
  return {
    id: "candidate-1",
    runId: run.id,
    baseVersion: 0,
    changedFiles: [{ path: "src/App.tsx", changeType: "created", additions: 10, deletions: 0 }],
    diffSummary: "created: src/App.tsx",
    validation: { status: "passed", summary: "ok" },
    sandboxPath: "/tmp/project/.agent/sandboxes/run-1",
    artifactIds: [],
    createdAt: run.createdAt,
  };
}

function makeVersion(): VersionRecord {
  return { id: "version-1", number: 1, summary: "Initial", createdAt: new Date().toISOString() };
}

test("memory store persists project, session, run, candidate, and versions", async () => {
  const store = new MemoryProjectStore();
  const project = makeProject();
  const run = makeRun(project);
  const candidate = makeCandidate(run);
  const version = makeVersion();

  await store.createProject(project);
  await store.createSession(project.session);
  await store.createRun(run);
  await store.saveCandidate(candidate);
  await store.saveVersion(project.id, version);
  project.status = "ready";
  await store.saveProject(project);

  assert.equal((await store.getProject(project.id))?.status, "ready");
  assert.deepEqual(await store.getSession(project.session.id), project.session);
  assert.deepEqual(await store.getRun(run.id), run);
  assert.deepEqual(await store.getCandidate(run.id), candidate);
  assert.deepEqual(await store.listVersions(project.id), [version]);
});

test("postgres store creates v3 tables and writes main entities", async () => {
  const project = makeProject();
  const run = makeRun(project);
  const candidate = makeCandidate(run);
  const version = makeVersion();
  const pool = new FakePool();
  pool.responses.push(
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [{ payload: project }] },
    { rows: [{ payload: project.session }] },
    { rows: [{ payload: run }] },
    { rows: [{ payload: candidate }] },
    { rows: [{ payload: version }] },
  );
  const store = new PostgresProjectStore(pool as unknown as Pool);

  await store.initialize();
  await store.saveProject(project);
  await store.saveSession(project.session);
  await store.saveRun(run);
  await store.saveCandidate(candidate);
  await store.saveVersion(project.id, version);

  assert.equal((await store.getProject(project.id))?.id, project.id);
  assert.equal((await store.getSession(project.session.id))?.id, project.session.id);
  assert.equal((await store.getRun(run.id))?.id, run.id);
  assert.equal((await store.getCandidate(run.id))?.id, candidate.id);
  assert.deepEqual(await store.listVersions(project.id), [version]);

  const ddl = pool.calls[0]?.sql ?? "";
  const queries = pool.calls.map((call) => call.sql).join("\n");
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS candidates/);
  assert.match(queries, /INSERT INTO projects/);
  assert.match(queries, /INSERT INTO sessions/);
  assert.match(queries, /INSERT INTO runs/);
  assert.match(queries, /INSERT INTO candidates/);
  assert.match(queries, /INSERT INTO versions/);
});
