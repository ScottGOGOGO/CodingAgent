import { randomUUID } from "node:crypto";

import type { ProjectRecord, VersionRecord } from "@vide/contracts";

export function createVersionRecord(project: ProjectRecord, summary: string, gitCommit?: string): VersionRecord {
  return {
    id: randomUUID(),
    number: project.versions.length + 1,
    summary,
    createdAt: new Date().toISOString(),
    gitCommit,
  };
}
