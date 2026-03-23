import { Pool } from "pg";

import type { ProjectRecord } from "@vide/contracts";

export interface ProjectStore {
  create(project: ProjectRecord): Promise<void>;
  get(projectId: string): Promise<ProjectRecord | null>;
  save(project: ProjectRecord): Promise<void>;
}

export class MemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, ProjectRecord>();

  async create(project: ProjectRecord): Promise<void> {
    this.projects.set(project.id, project);
  }

  async get(projectId: string): Promise<ProjectRecord | null> {
    return this.projects.get(projectId) ?? null;
  }

  async save(project: ProjectRecord): Promise<void> {
    this.projects.set(project.id, project);
  }
}

export class PostgresProjectStore implements ProjectStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async create(project: ProjectRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO projects (id, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [project.id, JSON.stringify(project)],
    );
  }

  async get(projectId: string): Promise<ProjectRecord | null> {
    const result = await this.pool.query<{ payload: ProjectRecord }>(
      "SELECT payload FROM projects WHERE id = $1",
      [projectId],
    );
    return result.rows[0]?.payload ?? null;
  }

  async save(project: ProjectRecord): Promise<void> {
    await this.create(project);
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
