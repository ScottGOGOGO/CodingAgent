import { Pool } from "pg";

import type { CandidateChangeSet, ProjectRecord, RunRecord, SessionState, VersionRecord } from "@vide/contracts";

export interface ProjectStore {
  createProject(project: ProjectRecord): Promise<void>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  saveProject(project: ProjectRecord): Promise<void>;
  listProjects(): Promise<ProjectRecord[]>;
  createSession(session: SessionState): Promise<void>;
  getSession(sessionId: string): Promise<SessionState | null>;
  saveSession(session: SessionState): Promise<void>;
  createRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  saveRun(run: RunRecord): Promise<void>;
  listRuns(projectId: string): Promise<RunRecord[]>;
  saveCandidate(candidate: CandidateChangeSet): Promise<void>;
  getCandidate(runId: string): Promise<CandidateChangeSet | null>;
  saveVersion(projectId: string, version: VersionRecord): Promise<void>;
  listVersions(projectId: string): Promise<VersionRecord[]>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly candidates = new Map<string, CandidateChangeSet>();
  private readonly versions = new Map<string, VersionRecord[]>();

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
    return [...this.projects.values()].map((project) => clone(project));
  }

  async createSession(session: SessionState): Promise<void> {
    this.sessions.set(session.id, clone(session));
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    const session = this.sessions.get(sessionId);
    return session ? clone(session) : null;
  }

  async saveSession(session: SessionState): Promise<void> {
    this.sessions.set(session.id, clone(session));
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
      .filter((run) => run.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((run) => clone(run));
  }

  async saveCandidate(candidate: CandidateChangeSet): Promise<void> {
    this.candidates.set(candidate.runId, clone(candidate));
  }

  async getCandidate(runId: string): Promise<CandidateChangeSet | null> {
    const candidate = this.candidates.get(runId);
    return candidate ? clone(candidate) : null;
  }

  async saveVersion(projectId: string, version: VersionRecord): Promise<void> {
    const versions = this.versions.get(projectId) ?? [];
    this.versions.set(projectId, [...versions.filter((item) => item.id !== version.id), clone(version)]);
  }

  async listVersions(projectId: string): Promise<VersionRecord[]> {
    return (this.versions.get(projectId) ?? []).map((version) => clone(version));
  }
}

export class PostgresProjectStore implements ProjectStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS candidates (run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    `);
  }

  private async upsert(table: string, idColumn: string, idValue: string, projectId: string, payload: unknown, extra: Record<string, string> = {}) {
    const columns = [idColumn, "project_id", ...Object.keys(extra), "payload", "updated_at"];
    const values = [idValue, projectId, ...Object.values(extra), JSON.stringify(payload)];
    const placeholders = columns.slice(0, -1).map((_, index) => `$${index + 1}`).join(", ");
    const updateColumns = columns
      .filter((column) => column !== idColumn)
      .map((column) => (column === "updated_at" ? "updated_at = NOW()" : `${column} = EXCLUDED.${column}`))
      .join(", ");
    await this.pool.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}, NOW())
       ON CONFLICT (${idColumn}) DO UPDATE SET ${updateColumns}`,
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

  async createSession(session: SessionState): Promise<void> {
    await this.saveSession(session);
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    return this.readOne<SessionState>("SELECT payload FROM sessions WHERE id = $1", [sessionId]);
  }

  async saveSession(session: SessionState): Promise<void> {
    await this.upsert("sessions", "id", session.id, session.projectId, session);
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

  async saveCandidate(candidate: CandidateChangeSet): Promise<void> {
    await this.upsert("candidates", "run_id", candidate.runId, "", candidate);
  }

  async getCandidate(runId: string): Promise<CandidateChangeSet | null> {
    return this.readOne<CandidateChangeSet>("SELECT payload FROM candidates WHERE run_id = $1", [runId]);
  }

  async saveVersion(projectId: string, version: VersionRecord): Promise<void> {
    await this.upsert("versions", "id", version.id, projectId, version);
  }

  async listVersions(projectId: string): Promise<VersionRecord[]> {
    return this.readMany<VersionRecord>("SELECT payload FROM versions WHERE project_id = $1 ORDER BY updated_at ASC", [projectId]);
  }
}

export async function createProjectStore(databaseUrl?: string): Promise<ProjectStore> {
  if (!databaseUrl) {
    return new MemoryProjectStore();
  }

  const store = new PostgresProjectStore(new Pool({ connectionString: databaseUrl }));
  try {
    await store.initialize();
    return store;
  } catch (error) {
    console.warn("Postgres store unavailable; falling back to in-memory store.", error);
    return new MemoryProjectStore();
  }
}
