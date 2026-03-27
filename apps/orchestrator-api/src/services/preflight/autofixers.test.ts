import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectRecord } from "@vide/contracts";

import { CommandExecutionError } from "../../runner.js";
import {
  ensureMissingTsconfigNode,
  ensureReactRouterDependency,
  ensureRuntimeDependency,
  ensureTailwindToolchain,
  relaxBuildScriptForTypeErrors,
  removeUnusedIdentifierFromImports,
} from "./autofixers.js";

function makeProject(workspaceRoot: string): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: "project-1",
    name: "Autofix Project",
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

test("ensureTailwindToolchain adds missing dependencies and config files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-tailwind-autofix-"));
  const project = makeProject(workspaceRoot);

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify(
        {
          name: "demo",
          private: true,
          devDependencies: {
            vite: "^5.0.0",
          },
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    const changed = await ensureTailwindToolchain(
      project,
      new Error("Tailwind directives were generated without the full Tailwind toolchain."),
    );

    assert.equal(changed, true);
    assert.match(await readFile(join(workspaceRoot, "package.json"), "utf-8"), /"tailwindcss": "\^3\.4\.17"/);
    assert.match(await readFile(join(workspaceRoot, "tailwind.config.js"), "utf-8"), /content/);
    assert.match(await readFile(join(workspaceRoot, "postcss.config.js"), "utf-8"), /tailwindcss/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ensureReactRouterDependency and ensureRuntimeDependency add runtime packages", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-runtime-dep-autofix-"));
  const project = makeProject(workspaceRoot);

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify(
        {
          name: "demo",
          private: true,
          dependencies: {
            react: "^18.3.1",
            "react-dom": "^18.3.1",
          },
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    assert.equal(
      await ensureReactRouterDependency(
        project,
        new Error("React Router is imported in the generated app, but react-router-dom is missing from package.json."),
      ),
      true,
    );
    assert.equal(
      await ensureRuntimeDependency(
        project,
        new Error("lucide-react is imported in the generated app, but lucide-react is missing from package.json."),
        "lucide-react",
        "^0.511.0",
      ),
      true,
    );
    assert.equal(
      await ensureRuntimeDependency(
        project,
        new Error("@radix-ui/react-dialog is imported in the generated app, but @radix-ui/react-dialog is missing from package.json."),
        "@radix-ui/react-dialog",
        "^1.1.2",
      ),
      true,
    );
    assert.equal(
      await ensureRuntimeDependency(
        project,
        new Error("zustand is imported in the generated app, but zustand is missing from package.json."),
        "zustand",
        "^4.5.5",
      ),
      true,
    );

    const packageJson = await readFile(join(workspaceRoot, "package.json"), "utf-8");
    assert.match(packageJson, /"react-router-dom": "\^6\.30\.1"/);
    assert.match(packageJson, /"lucide-react": "\^0\.511\.0"/);
    assert.match(packageJson, /"@radix-ui\/react-dialog": "\^1\.1\.2"/);
    assert.match(packageJson, /"zustand": "\^4\.5\.5"/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("relaxBuildScriptForTypeErrors removes the tsc gate and ensureMissingTsconfigNode backfills config", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-build-script-autofix-"));
  const project = makeProject(workspaceRoot);

  try {
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify(
        {
          name: "demo",
          private: true,
          scripts: {
            build: "tsc && vite build",
          },
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    const commandError = new CommandExecutionError(
      ["npm", "run", "build"],
      "src/App.tsx(1,1): error TS6133: 'foo' is declared but its value is never read.",
    );
    assert.equal(await relaxBuildScriptForTypeErrors(project, commandError), true);
    assert.match(await readFile(join(workspaceRoot, "package.json"), "utf-8"), /"build": "vite build"/);

    assert.equal(
      await ensureMissingTsconfigNode(project, "error TS6053: File 'tsconfig.node.json' not found."),
      true,
    );
    assert.match(await readFile(join(workspaceRoot, "tsconfig.node.json"), "utf-8"), /vite\.config\.ts/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("removeUnusedIdentifierFromImports removes unused import bindings", () => {
  const source = [
    "import React, { useMemo, useState } from 'react';",
    "import { Link } from 'react-router-dom';",
    "const value = useState(0);",
    "export default value;",
  ].join("\n");

  const next = removeUnusedIdentifierFromImports(source, "useMemo");

  assert.doesNotMatch(next, /useMemo/);
  assert.match(next, /useState/);
  assert.match(next, /Link/);
});
