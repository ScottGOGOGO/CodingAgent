import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileOperation, ProjectRecord } from "@vide/contracts";

import { WorkspaceService } from "./workspace.js";

function makeProject(workspaceRoot: string): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: "project-1",
    name: "Workspace Test Project",
    createdAt: now,
    updatedAt: now,
    workspaceRoot,
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

test("applyFileOperations supports multiple writes to the same path", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-workspace-test-"));
  const workspace = new WorkspaceService();
  const project = makeProject(workspaceRoot);

  try {
    await workspace.ensureProjectWorkspace(project);

    const operations: FileOperation[] = [
      { type: "write", path: "src/App.tsx", summary: "First write", content: "export default 'first';\n" },
      { type: "write", path: "src/App.tsx", summary: "Second write", content: "export default 'second';\n" },
    ];

    await workspace.applyFileOperations(project, operations);

    const content = await readFile(join(workspaceRoot, "src/App.tsx"), "utf-8");
    assert.equal(content, "export default 'second';\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("applyFileOperations patches the staged content from earlier operations in the same batch", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-workspace-test-"));
  const workspace = new WorkspaceService();
  const project = makeProject(workspaceRoot);

  try {
    await workspace.ensureProjectWorkspace(project);
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src/App.tsx"), "export default function App() {\n  return <main>Old</main>;\n}\n", "utf-8");

    const operations: FileOperation[] = [
      {
        type: "write",
        path: "src/App.tsx",
        summary: "Base rewrite",
        content: "export default function App() {\n  return <main>Draft</main>;\n}\n",
      },
      {
        type: "patch",
        path: "src/App.tsx",
        summary: "Finalize content",
        hunks: [
          {
            search: "Draft",
            replace: "Ready",
          },
        ],
      },
    ];

    await workspace.applyFileOperations(project, operations);

    const content = await readFile(join(workspaceRoot, "src/App.tsx"), "utf-8");
    assert.match(content, /Ready/);
    assert.doesNotMatch(content, /Draft/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
