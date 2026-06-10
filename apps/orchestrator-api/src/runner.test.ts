import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { commandForStep, previewBuildCommandForWorkspace, previewStartCommandForWorkspace, waitForHealthy } from "./runner.js";

test("commandForStep maps install and build commands", () => {
  assert.deepEqual(commandForStep("install"), ["npm", "install"]);
  assert.deepEqual(commandForStep("build"), ["npm", "run", "build"]);
});

test("commandForStep injects preview port", () => {
  assert.deepEqual(commandForStep("preview", 4300), [
    "npm",
    "run",
    "start",
    "--",
    "--hostname",
    "0.0.0.0",
    "--port",
    "4300",
  ]);
});

test("commandForStep injects dev preview port", () => {
  assert.deepEqual(commandForStep("devPreview", 4301), [
    "npm",
    "run",
    "dev",
    "--",
    "--hostname",
    "0.0.0.0",
    "--port",
    "4301",
  ]);
});

test("commandForStep builds static export preview command", () => {
  const command = commandForStep("staticPreview", 4302);
  assert.deepEqual(command.slice(0, 2), ["node", "-e"]);
  assert.match(command[2] ?? "", /Static export preview ready/);
  assert.equal(command.at(-1), "4302");
});

test("previewBuildCommandForWorkspace rebuilds Next production preview when BUILD_ID is missing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vide-preview-"));
  try {
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { build: "next build", start: "next start" } }),
    );

    assert.deepEqual(await previewBuildCommandForWorkspace(workspace), ["npm", "run", "build"]);

    await mkdir(join(workspace, ".next"), { recursive: true });
    await writeFile(join(workspace, ".next", "BUILD_ID"), "ready");

    assert.equal(await previewBuildCommandForWorkspace(workspace), null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("preview commands serve Next static exports from out directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vide-static-preview-"));
  try {
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { build: "next build", start: "next start" } }),
    );
    await writeFile(join(workspace, "next.config.mjs"), "export default { output: 'export' };\n");

    assert.deepEqual(await previewBuildCommandForWorkspace(workspace), ["npm", "run", "build"]);

    await mkdir(join(workspace, "out"), { recursive: true });
    await writeFile(join(workspace, "out", "index.html"), "<h1>ready</h1>");

    assert.equal(await previewBuildCommandForWorkspace(workspace), null);

    const command = await previewStartCommandForWorkspace(workspace, 4303);
    assert.deepEqual(command.slice(0, 2), ["node", "-e"]);
    assert.match(command[2] ?? "", /Static export preview ready/);
    assert.equal(command.at(-1), "4303");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("previewBuildCommandForWorkspace skips non-Next start scripts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vide-preview-"));
  try {
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { build: "vite build", start: "vite preview" } }),
    );

    assert.equal(await previewBuildCommandForWorkspace(workspace), null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("waitForHealthy surfaces preview runtime 500 log tail", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vide-preview-"));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(workspace, ".preview.log"), "Module not found: Can't resolve '@训练档案/client'\n", "utf-8");
    globalThis.fetch = (async () =>
      new Response("broken preview", {
        status: 500,
      })) as typeof fetch;

    await assert.rejects(
      () =>
        waitForHealthy(
          { id: "preview-runtime-500", workspaceRoot: workspace, logRoot: workspace },
          "http://127.0.0.1:4917",
          100,
        ),
      /Preview server returned 500[\s\S]*@训练档案\/client/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspace, { recursive: true, force: true });
  }
});
