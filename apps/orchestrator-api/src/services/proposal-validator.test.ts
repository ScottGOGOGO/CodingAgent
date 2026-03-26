import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectRecord, WorkspaceFile } from "@vide/contracts";

import { detectStaticValidationIssue, ProposalValidator } from "./proposal-validator.js";
import { CommandExecutionError } from "../runner.js";

function makeProject(workspaceRoot: string): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: "project-1",
    name: "Tailwind Repair Project",
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

test("detectStaticValidationIssue flags tailwind directives without toolchain", () => {
  const files: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          typescript: "^5.6.2",
          vite: "^5.4.5",
        },
      }),
    },
    {
      path: "src/index.css",
      content: "@tailwind base;\n@tailwind components;\n.btn { @apply px-4 py-2; }\n",
    },
  ];

  assert.match(detectStaticValidationIssue(files) ?? "", /tailwind/i);
});

test("detectStaticValidationIssue ignores plain CSS apps without tailwind usage", () => {
  const files: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
      }),
    },
    {
      path: "src/index.css",
      content: ".hero { color: #123456; }\n",
    },
    {
      path: "src/App.tsx",
      content: "export default function App() { return <input placeholder=\"Type here\" className=\"hero\" />; }\n",
    },
  ];

  assert.equal(detectStaticValidationIssue(files), null);
});

test("detectStaticValidationIssue flags missing react-router-dom dependency", () => {
  const files: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
      }),
    },
    {
      path: "src/App.tsx",
      content: "import { Routes, Route } from 'react-router-dom';\nexport default function App() { return <Routes />; }\n",
    },
  ];

  assert.match(detectStaticValidationIssue(files) ?? "", /react-router-dom/i);
});

test("detectStaticValidationIssue flags missing lucide-react dependency", () => {
  const files: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
      }),
    },
    {
      path: "src/App.tsx",
      content: "import { Sparkles } from 'lucide-react';\nexport default function App() { return <Sparkles />; }\n",
    },
  ];

  assert.match(detectStaticValidationIssue(files) ?? "", /lucide-react/i);
});

test("detectStaticValidationIssue flags malformed critical json files before build", () => {
  const files: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "demo",
        private: true,
      }),
    },
    {
      path: "tsconfig.json",
      content: '{\n  "compilerOptions": {\n    "target": "ES2020"\n  },\n  "include": ["src"]\n',
    },
  ];

  assert.match(detectStaticValidationIssue(files) ?? "", /tsconfig\.json/);
  assert.match(detectStaticValidationIssue(files) ?? "", /JSON/);
});

test("detectStaticValidationIssue flags truncated index html before build", () => {
  const files: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "demo",
        private: true,
      }),
    },
    {
      path: "index.html",
      content: "<!doctype html>\n<html>\n  <head>\n    <meta charset=\"UTF-8\" />\n    <link rel=",
    },
  ];

  assert.match(detectStaticValidationIssue(files) ?? "", /index\.html/);
  assert.match(detectStaticValidationIssue(files) ?? "", /截断|不完整/);
});

test("ensureTailwindToolchain adds the missing dependencies and config files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-tailwind-autofix-"));
  const validator = new ProposalValidator({} as never, {} as never, {} as never);
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

    const changed = await (validator as any).ensureTailwindToolchain(
      project,
      new Error("Tailwind directives were generated without the full Tailwind toolchain."),
    );

    assert.equal(changed, true);

    const packageJson = await readFile(join(workspaceRoot, "package.json"), "utf-8");
    assert.match(packageJson, /"tailwindcss": "\^3\.4\.17"/);
    assert.match(packageJson, /"postcss": "\^8\.4\.49"/);
    assert.match(packageJson, /"autoprefixer": "\^10\.4\.20"/);

    const tailwindConfig = await readFile(join(workspaceRoot, "tailwind.config.js"), "utf-8");
    assert.match(tailwindConfig, /content/);

    const postcssConfig = await readFile(join(workspaceRoot, "postcss.config.js"), "utf-8");
    assert.match(postcssConfig, /tailwindcss/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ensureRuntimeDependency adds missing visual runtime dependencies to dependencies", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-runtime-dep-autofix-"));
  const validator = new ProposalValidator({} as never, {} as never, {} as never);
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

    const changed = await (validator as any).ensureRuntimeDependency(
      project,
      new Error("lucide-react is imported in the generated app, but lucide-react is missing from package.json."),
      "lucide-react",
      "^0.511.0",
    );

    assert.equal(changed, true);

    const packageJson = await readFile(join(workspaceRoot, "package.json"), "utf-8");
    assert.match(packageJson, /"lucide-react": "\^0\.511\.0"/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ensureReactRouterDependency adds the missing runtime dependency", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-react-router-autofix-"));
  const validator = new ProposalValidator({} as never, {} as never, {} as never);
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

    const changed = await (validator as any).ensureReactRouterDependency(
      project,
      new Error("React Router is imported in the generated app, but react-router-dom is missing from package.json."),
    );

    assert.equal(changed, true);

    const packageJson = await readFile(join(workspaceRoot, "package.json"), "utf-8");
    assert.match(packageJson, /"react-router-dom": "\^6\.30\.1"/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("relaxBuildScriptForTypeErrors removes the tsc gate for TypeScript-only build failures", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vide-build-script-autofix-"));
  const validator = new ProposalValidator({} as never, {} as never, {} as never);
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

    const changed = await (validator as any).relaxBuildScriptForTypeErrors(
      project,
      new CommandExecutionError(
        ["npm", "run", "build"],
        "src/App.tsx(1,1): error TS6133: 'foo' is declared but its value is never read.",
      ),
    );

    assert.equal(changed, true);

    const packageJson = await readFile(join(workspaceRoot, "package.json"), "utf-8");
    assert.match(packageJson, /"build": "vite build"/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
