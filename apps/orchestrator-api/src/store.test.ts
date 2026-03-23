import test from "node:test";
import assert from "node:assert/strict";

import type { ProjectRecord } from "@vide/contracts";

import { MemoryProjectStore } from "./store.js";

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
    session: {
      sessionId: "session-1",
      projectId: "project-1",
      reasoningMode: "plan_solve",
      messages: [],
      requirementSlots: {},
      clarityScore: 0,
      clarificationRounds: 0,
      missingSlots: [],
      clarificationQuestions: [],
      status: "draft",
      planSteps: [],
      fileChangeSummary: [],
      fileChanges: [],
      executionManifest: [],
      versionNumber: 0,
    },
    versions: [],
  };
}

test("memory store persists project updates", async () => {
  const store = new MemoryProjectStore();
  const project = makeProject();

  await store.create(project);
  project.status = "ready";
  await store.save(project);

  const loaded = await store.get(project.id);
  assert.equal(loaded?.status, "ready");
});
