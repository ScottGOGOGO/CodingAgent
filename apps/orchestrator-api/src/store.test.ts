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

  await store.createProject(project);
  project.status = "ready";
  await store.saveProject(project);

  const loaded = await store.getProject(project.id);
  assert.equal(loaded?.status, "ready");
});
