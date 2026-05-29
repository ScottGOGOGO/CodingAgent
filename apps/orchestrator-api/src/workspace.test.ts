import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectRecord, SessionState } from "@vide/contracts";

import { WorkspaceService } from "./workspace.js";

function makeProject(workspaceRoot: string): ProjectRecord {
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
    name: "Workspace Test Project",
    createdAt: now,
    updatedAt: now,
    workspaceRoot,
    mode: "local_generator",
    status: "draft",
    preview: { status: "idle", updatedAt: now },
    currentSessionId: session.id,
    session,
    versions: [],
  };
}

test("workspace can create sandbox and promote it without copying .agent", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-workspace-test-"));
  const workspace = new WorkspaceService();
  const project = makeProject(workspaceRoot);

  try {
    await workspace.ensureProjectWorkspace(project);
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src/App.tsx"), "old\n", "utf-8");

    const sandbox = await workspace.createSandbox(project, "run-1");
    await sandbox.writeFile("src/App.tsx", "new\n");
    await sandbox.writeFile("src/Extra.ts", "export const value = 1;\n");
    await workspace.promoteSandbox(project, sandbox.sandboxRoot);

    assert.equal(await readFile(join(workspaceRoot, "src/App.tsx"), "utf-8"), "new\n");
    assert.equal(await readFile(join(workspaceRoot, "src/Extra.ts"), "utf-8"), "export const value = 1;\n");
    assert.deepEqual((await workspace.listFiles(project)).sort(), [".gitignore", "src/App.tsx", "src/Extra.ts"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
