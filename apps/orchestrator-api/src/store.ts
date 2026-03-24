import { Pool } from "pg";

import type {
  ApprovalRequest,
  ArtifactRecord,
  PreviewInstanceRecord,
  ProjectRecord,
  RunRecord,
  SessionRecord,
  ToolCallTrace,
  UsageMetrics,
  VersionRecord,
} from "@vide/contracts";

export interface ProjectStore {
  createProject(project: ProjectRecord): Promise<void>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  saveProject(project: ProjectRecord): Promise<void>;
  listProjects(): Promise<ProjectRecord[]>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  saveSession(session: SessionRecord): Promise<void>;
  listSessions(projectId: string): Promise<SessionRecord[]>;
  createRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  saveRun(run: RunRecord): Promise<void>;
  listRuns(projectId: string): Promise<RunRecord[]>;
  saveApproval(approval: ApprovalRequest): Promise<void>;
  getApproval(runId: string): Promise<ApprovalRequest | null>;
  saveVersion(projectId: string, version: VersionRecord): Promise<void>;
  listVersions(projectId: string): Promise<VersionRecord[]>;
  saveArtifact(artifact: ArtifactRecord): Promise<void>;
  listArtifacts(runId: string): Promise<ArtifactRecord[]>;
  savePreviewInstance(instance: PreviewInstanceRecord): Promise<void>;
  listPreviewInstances(projectId: string): Promise<PreviewInstanceRecord[]>;
  saveToolCallTrace(trace: ToolCallTrace): Promise<void>;
  listToolCallTraces(runId: string): Promise<ToolCallTrace[]>;
  saveUsageMetrics(runId: string, usage: UsageMetrics): Promise<void>;
  getUsageMetrics(runId: string): Promise<UsageMetrics | null>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly versions = new Map<string, VersionRecord[]>();
  private readonly artifacts = new Map<string, ArtifactRecord[]>();
  private readonly previewInstances = new Map<string, PreviewInstanceRecord[]>();
  private readonly toolCallTraces = new Map<string, ToolCallTrace[]>();
  private readonly usageMetrics = new Map<string, UsageMetrics>();

  async createProject(project: ProjectRecord): Promise<void> {
    this.projects.set(project.id, clone(project));
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const project = this.projects.get(projectId);
    return project ? clone(project) : null;
  }

  async saveProject(project: ProjectRecord): Promise<void> {
    this.projects.set(project.id, clone(project));
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return [...this.projects.values()].map((item) => clone(item));
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, clone(session));
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session ? clone(session) : null;
  }

  async saveSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, clone(session));
  }

  async listSessions(projectId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()].filter((item) => item.projectId === projectId).map((item) => clone(item));
  }

  async createRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, clone(run));
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  async saveRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, clone(run));
  }

  async listRuns(projectId: string): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((item) => item.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item) => clone(item));
  }

  async saveApproval(approval: ApprovalRequest): Promise<void> {
    this.approvals.set(approval.runId, clone(approval));
  }

  async getApproval(runId: string): Promise<ApprovalRequest | null> {
    const approval = this.approvals.get(runId);
    return approval ? clone(approval) : null;
  }

  async saveVersion(projectId: string, version: VersionRecord): Promise<void> {
    const current = this.versions.get(projectId) ?? [];
    const next = current.filter((item) => item.id !== version.id);
    next.push(clone(version));
    this.versions.set(projectId, next.sort((left, right) => left.number - right.number));
  }

  async listVersions(projectId: string): Promise<VersionRecord[]> {
    return (this.versions.get(projectId) ?? []).map((item) => clone(item));
  }

  async saveArtifact(artifact: ArtifactRecord): Promise<void> {
    const current = this.artifacts.get(artifact.runId) ?? [];
    this.artifacts.set(artifact.runId, [...current.filter((item) => item.id !== artifact.id), clone(artifact)]);
  }

  async listArtifacts(runId: string): Promise<ArtifactRecord[]> {
    return (this.artifacts.get(runId) ?? []).map((item) => clone(item));
  }

  async savePreviewInstance(instance: PreviewInstanceRecord): Promise<void> {
    const current = this.previewInstances.get(instance.projectId) ?? [];
    this.previewInstances.set(
      instance.projectId,
      [...current.filter((item) => item.id !== instance.id), clone(instance)],
    );
  }

  async listPreviewInstances(projectId: string): Promise<PreviewInstanceRecord[]> {
    return (this.previewInstances.get(projectId) ?? []).map((item) => clone(item));
  }

  async saveToolCallTrace(trace: ToolCallTrace): Promise<void> {
    const current = this.toolCallTraces.get(trace.runId) ?? [];
    this.toolCallTraces.set(trace.runId, [...current.filter((item) => item.id !== trace.id), clone(trace)]);
  }

  async listToolCallTraces(runId: string): Promise<ToolCallTrace[]> {
    return (this.toolCallTraces.get(runId) ?? []).map((item) => clone(item));
  }

  async saveUsageMetrics(runId: string, usage: UsageMetrics): Promise<void> {
    this.usageMetrics.set(runId, clone(usage));
  }

  async getUsageMetrics(runId: string): Promise<UsageMetrics | null> {
    const usage = this.usageMetrics.get(runId);
    return usage ? clone(usage) : null;
  }
}

export class PostgresProjectStore implements ProjectStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS preview_instances (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tool_call_traces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS usage_metrics (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  private async upsert(
    table: string,
    idColumn: string,
    idValue: string,
    projectId: string,
    payload: unknown,
    extra: Record<string, string> = {},
  ): Promise<void> {
    const columns = [idColumn, "project_id", ...Object.keys(extra), "payload", "updated_at"];
    const values = [idValue, projectId, ...Object.values(extra), JSON.stringify(payload)];
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const updateColumns = [...columns.filter((column) => column !== idColumn && column !== "updated_at"), "updated_at"];
    const updateStatement = updateColumns
      .map((column) => (column === "updated_at" ? "updated_at = NOW()" : `${column} = EXCLUDED.${column}`))
      .join(", ");
    await this.pool.query(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${placeholders.slice(0, columns.length - 1).join(", ")}, NOW())
       ON CONFLICT (${idColumn}) DO UPDATE SET ${updateStatement}`,
      values,
    );
  }

  private async readOne<T>(query: string, values: unknown[]): Promise<T | null> {
    const result = await this.pool.query<{ payload: T }>(query, values);
    return result.rows[0]?.payload ?? null;
  }

  private async readMany<T>(query: string, values: unknown[]): Promise<T[]> {
    const result = await this.pool.query<{ payload: T }>(query, values);
    return result.rows.map((row) => row.payload);
  }

  async createProject(project: ProjectRecord): Promise<void> {
    await this.saveProject(project);
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    return this.readOne<ProjectRecord>("SELECT payload FROM projects WHERE id = $1", [projectId]);
  }

  async saveProject(project: ProjectRecord): Promise<void> {
    await this.upsert("projects", "id", project.id, project.id, project);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return this.readMany<ProjectRecord>("SELECT payload FROM projects ORDER BY updated_at DESC", []);
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.saveSession(session);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.readOne<SessionRecord>("SELECT payload FROM sessions WHERE id = $1", [sessionId]);
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.upsert("sessions", "id", session.id, session.projectId, session);
  }

  async listSessions(projectId: string): Promise<SessionRecord[]> {
    return this.readMany<SessionRecord>(
      "SELECT payload FROM sessions WHERE project_id = $1 ORDER BY updated_at DESC",
      [projectId],
    );
  }

  async createRun(run: RunRecord): Promise<void> {
    await this.saveRun(run);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.readOne<RunRecord>("SELECT payload FROM runs WHERE id = $1", [runId]);
  }

  async saveRun(run: RunRecord): Promise<void> {
    await this.upsert("runs", "id", run.id, run.projectId, run, { session_id: run.sessionId });
  }

  async listRuns(projectId: string): Promise<RunRecord[]> {
    return this.readMany<RunRecord>("SELECT payload FROM runs WHERE project_id = $1 ORDER BY updated_at DESC", [projectId]);
  }

  async saveApproval(approval: ApprovalRequest): Promise<void> {
    await this.upsert("approvals", "id", approval.runId, approval.projectId, approval, { run_id: approval.runId });
  }

  async getApproval(runId: string): Promise<ApprovalRequest | null> {
    return this.readOne<ApprovalRequest>("SELECT payload FROM approvals WHERE run_id = $1", [runId]);
  }

  async saveVersion(projectId: string, version: VersionRecord): Promise<void> {
    await this.upsert("versions", "id", version.id, projectId, version);
  }

  async listVersions(projectId: string): Promise<VersionRecord[]> {
    return this.readMany<VersionRecord>(
      "SELECT payload FROM versions WHERE project_id = $1 ORDER BY updated_at ASC",
      [projectId],
    );
  }

  async saveArtifact(artifact: ArtifactRecord): Promise<void> {
    await this.upsert("artifacts", "id", artifact.id, artifact.projectId, artifact, { run_id: artifact.runId });
  }

  async listArtifacts(runId: string): Promise<ArtifactRecord[]> {
    return this.readMany<ArtifactRecord>("SELECT payload FROM artifacts WHERE run_id = $1 ORDER BY updated_at ASC", [runId]);
  }

  async savePreviewInstance(instance: PreviewInstanceRecord): Promise<void> {
    await this.upsert("preview_instances", "id", instance.id, instance.projectId, instance, { run_id: instance.runId });
  }

  async listPreviewInstances(projectId: string): Promise<PreviewInstanceRecord[]> {
    return this.readMany<PreviewInstanceRecord>(
      "SELECT payload FROM preview_instances WHERE project_id = $1 ORDER BY updated_at DESC",
      [projectId],
    );
  }

  async saveToolCallTrace(trace: ToolCallTrace): Promise<void> {
    await this.upsert("tool_call_traces", "id", trace.id, "", trace, { run_id: trace.runId });
  }

  async listToolCallTraces(runId: string): Promise<ToolCallTrace[]> {
    return this.readMany<ToolCallTrace>(
      "SELECT payload FROM tool_call_traces WHERE run_id = $1 ORDER BY updated_at ASC",
      [runId],
    );
  }

  async saveUsageMetrics(runId: string, usage: UsageMetrics): Promise<void> {
    await this.upsert("usage_metrics", "run_id", runId, "", usage);
  }

  async getUsageMetrics(runId: string): Promise<UsageMetrics | null> {
    return this.readOne<UsageMetrics>("SELECT payload FROM usage_metrics WHERE run_id = $1", [runId]);
  }
}

export async function createProjectStore(databaseUrl?: string): Promise<ProjectStore> {
  if (!databaseUrl) {
    return new MemoryProjectStore();
  }

  try {
    const pool = new Pool({ connectionString: databaseUrl });
    const store = new PostgresProjectStore(pool);
    await store.initialize();
    return store;
  } catch (error) {
    console.warn("Falling back to memory store because PostgreSQL initialization failed.", error);
    return new MemoryProjectStore();
  }
}
