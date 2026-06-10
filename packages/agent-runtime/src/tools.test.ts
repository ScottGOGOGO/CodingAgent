import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SandboxWorkspace } from "./sandbox.js";
import { InMemoryTaskStore, ObservableTaskStore, createDefaultToolRegistry, isAllowedAgentCommand } from "./tools.js";

function toolContext(runId: string, sandbox: SandboxWorkspace, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    workspace: sandbox,
    emitTrace: () => {},
    emitLog: () => {},
    ...overrides,
  };
}

test("sandbox rejects paths that escape the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-1");

  assert.throws(() => sandbox.resolveSandboxPath("../outside.txt"), /escapes sandbox/);
  await rm(root, { recursive: true, force: true });
});

test("sandbox file listing ignores generated build artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-build-artifacts");

  await sandbox.writeFile("src/app/page.tsx", "export default function Page() { return <main>App</main>; }\n");
  await sandbox.writeFile(".next/server/chunks/app.js", "const largeGeneratedArtifact = 'noise';\n");
  await sandbox.writeFile("coverage/report.json", "{}\n");

  const files = await sandbox.listFiles();
  assert.deepEqual(files.filter((path) => path.startsWith(".next/")), []);
  assert.deepEqual(files.filter((path) => path.startsWith("coverage/")), []);
  assert.ok(files.includes("src/app/page.tsx"));
  await rm(root, { recursive: true, force: true });
});

test("tool registry validates write_file input", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-1");
  const registry = createDefaultToolRegistry();

  await assert.rejects(
    registry.execute(
      "write_file",
      { path: "src/app/page.tsx" },
      toolContext("run-1", sandbox),
    ),
    /content/,
  );

  await registry.execute(
    "write_file",
    { path: "src/app/page.tsx", content: "export default function HomePage() { return null; }\n" },
    toolContext("run-1", sandbox),
  );
  assert.match(await sandbox.readFile("src/app/page.tsx"), /HomePage/);
  await rm(root, { recursive: true, force: true });
});

test("command allow list permits only npm agent commands", () => {
  assert.equal(isAllowedAgentCommand(["npm", "install"]), true);
  assert.equal(isAllowedAgentCommand(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"]), true);
  assert.equal(isAllowedAgentCommand(["npm", "run", "build"]), true);
  assert.equal(isAllowedAgentCommand(["npm", "run", "dev"]), true);
  assert.equal(isAllowedAgentCommand(["next", "build"]), true);
  assert.equal(isAllowedAgentCommand(["next", "dev", "--hostname", "127.0.0.1", "--port", "3000"]), true);
  assert.equal(isAllowedAgentCommand(["npx", "prisma", "migrate", "dev", "--name", "init"]), true);
  assert.equal(isAllowedAgentCommand(["npx", "prisma", "db", "push"]), true);
  assert.equal(isAllowedAgentCommand(["prisma", "validate"]), true);
  assert.equal(isAllowedAgentCommand(["prisma", "generate"]), true);
  assert.equal(isAllowedAgentCommand(["prisma", "db", "push"]), true);
  assert.equal(isAllowedAgentCommand(["rm", "-rf", "/"]), false);
  assert.equal(isAllowedAgentCommand(["npm", "publish"]), false);
  assert.equal(isAllowedAgentCommand(["npm", "install", "--foreground-scripts"]), false);
});

test("tool kernel exposes phase-aware catalog with strict policy metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-catalog");
  const registry = createDefaultToolRegistry();

  const planningCatalog = registry.getCatalog(toolContext("run-catalog", sandbox, {
    phase: "plan",
    policy: {
      allowedPermissions: ["read", "collaborate"],
      allowedSideEffects: ["none"],
      allowedRiskLevels: ["low", "medium"],
    },
  }));
  const planningToolIds = planningCatalog.map((tool) => tool.id);
  assert.ok(planningToolIds.includes("read_file"));
  assert.ok(planningToolIds.includes("task_create"));
  assert.ok(planningToolIds.includes("skill_pack_get"));
  assert.equal(planningToolIds.includes("write_file"), false);
  assert.equal(planningToolIds.includes("run_command"), false);

  const buildCatalog = registry.getCatalog(toolContext("run-catalog", sandbox, {
    phase: "tool_loop",
    policy: {
      allowedPermissions: ["read", "write", "execute", "collaborate"],
      allowedSideEffects: ["none", "workspace", "process"],
      allowedRiskLevels: ["low", "medium", "high"],
    },
  }));
  const writeManifest = buildCatalog.find((tool) => tool.id === "write_file");
  const bashManifest = buildCatalog.find((tool) => tool.id === "run_command");
  assert.equal(writeManifest?.category, "execution");
  assert.equal(writeManifest?.sideEffects, "workspace");
  assert.equal(bashManifest?.riskLevel, "high");

  await rm(root, { recursive: true, force: true });
});

test("tool policy blocks high risk and network tools at execution time", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-policy");
  const registry = createDefaultToolRegistry();

  await assert.rejects(
    registry.execute(
      "run_command",
      { command: ["npm", "run", "build"] },
      toolContext("run-policy", sandbox, {
        phase: "tool_loop",
        policy: {
          allowedPermissions: ["read", "write", "execute", "collaborate"],
          allowedSideEffects: ["none", "workspace"],
          allowedRiskLevels: ["low", "medium"],
        },
      }),
    ),
    /side effect|risk level/,
  );

  await rm(root, { recursive: true, force: true });
});

test("task tools manage lifecycle and task output", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-tasks");
  const registry = createDefaultToolRegistry();
  const taskStore = new InMemoryTaskStore();
  const context = toolContext("run-tasks", sandbox, {
    phase: "tool_loop",
    taskStore,
    registry,
  });

  const created = (await registry.execute(
    "task_create",
    { title: "Research data layer", agentType: "planner", input: { focus: "data" } },
    context,
  )) as { task: { id: string; status: string; title: string } };
  assert.equal(created.task.status, "pending");

  const updated = (await registry.execute(
    "task_update",
    { id: created.task.id, status: "completed", outputSummary: "Use server data module." },
    context,
  )) as { task: { status: string; outputSummary?: string } };
  assert.equal(updated.task.status, "completed");

  await registry.execute("send_message", { taskId: created.task.id, message: "handoff note" }, context);
  const output = (await registry.execute("task_output", { id: created.task.id }, context)) as {
    task?: { outputSummary?: string; logs: string[] };
  };
  assert.equal(output.task?.outputSummary, "Use server data module.");
  assert.deepEqual(output.task?.logs, ["handoff note"]);

  await rm(root, { recursive: true, force: true });
});

test("observable task store emits task lifecycle changes for UI bridges", async () => {
  const changes: Array<{ id: string; status: string; outputSummary?: string }> = [];
  const store = new ObservableTaskStore(new InMemoryTaskStore(), (task) => {
    changes.push({ id: task.id, status: task.status, outputSummary: task.outputSummary });
  });

  const task = store.create({ title: "Bridge task", agentType: "inspector" });
  store.update(task.id, { status: "running" });
  store.update(task.id, { status: "completed", outputSummary: "Done" });

  assert.deepEqual(changes.map((change) => change.status), ["pending", "running", "completed"]);
  assert.equal(changes.at(-1)?.outputSummary, "Done");
});

test("skill pack manifests expose required tools and quality checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-skills");
  const registry = createDefaultToolRegistry();
  const context = toolContext("run-skills", sandbox, { phase: "planning", registry });

  const list = (await registry.execute("list_skill_packs", {}, context)) as { skills: Array<{ id: string }> };
  assert.ok(list.skills.some((skill) => skill.id === "core-product"));

  const fullstack = (await registry.execute("skill_pack_get", { id: "fullstack-product" }, context)) as {
    skill: { requiredTools: string[]; qualityChecks: string[] };
  };
  assert.ok(fullstack.skill.requiredTools.includes("data_model_plan"));
  assert.ok(fullstack.skill.qualityChecks.some((check) => /server|data|mutation/i.test(check)));

  await rm(root, { recursive: true, force: true });
});

test("tool execution traces include manifest metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trace");
  const registry = createDefaultToolRegistry();
  const traces: Array<{ status: string; category?: string; permission?: string; sideEffects?: string; phase?: string }> = [];

  await registry.execute(
    "read_file",
    { path: "missing.txt" },
    {
      ...toolContext("run-trace", sandbox, { phase: "context" }),
      emitTrace: (trace) => traces.push(trace),
    },
  ).catch(() => undefined);

  assert.equal(traces[0]?.category, "execution");
  assert.equal(traces[0]?.permission, "read");
  assert.equal(traces[0]?.sideEffects, "none");
  assert.equal(traces[0]?.phase, "context");
  assert.equal(traces.at(-1)?.status, "failed");

  await rm(root, { recursive: true, force: true });
});

test("agent_tool executes a bounded sub-agent runner with a filtered tool allow list", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-agent-tool");
  const registry = createDefaultToolRegistry();
  const taskStore = new InMemoryTaskStore();
  const seen: Array<{ allowedTools: string[]; prompt: string }> = [];
  const context = toolContext("run-agent-tool", sandbox, {
    phase: "tool_loop",
    taskStore,
    registry,
    subAgentRunner: {
      run: async (request: { allowedTools: string[]; prompt: string }) => {
        seen.push({ allowedTools: request.allowedTools, prompt: request.prompt });
        return {
          status: "completed" as const,
          outputSummary: "Sub-agent inspected files.",
          artifactIds: ["artifact-1"],
          messages: ["finished"],
        };
      },
    },
  });

  const result = (await registry.execute(
    "agent_tool",
    {
      title: "Inspect app shape",
      prompt: "Find the product routes",
      agentType: "inspector",
      allowedTools: ["read_file", "write_file"],
    },
    context,
  )) as { task: { status: string; outputSummary?: string; artifactIds: string[] }; allowedTools: string[] };

  assert.deepEqual(seen[0]?.allowedTools, ["read_file", "write_file"]);
  assert.equal(result.task.status, "completed");
  assert.equal(result.task.outputSummary, "Sub-agent inspected files.");
  assert.deepEqual(result.task.artifactIds, ["artifact-1"]);

  await rm(root, { recursive: true, force: true });
});

test("web tools are hidden and blocked unless network policy and adapter are enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-web");
  const registry = createDefaultToolRegistry();

  const lockedContext = toolContext("run-web", sandbox, {
    phase: "context",
    capabilities: { network: false },
  });
  assert.equal(registry.getCatalog(lockedContext).some((tool) => tool.id === "web_fetch"), false);
  await assert.rejects(
    registry.execute("web_fetch", { url: "https://example.com" }, lockedContext),
    /Tool permission is not allowed: network|Network tool is disabled|requires RuntimeCapabilities\.network/,
  );

  const openContext = toolContext("run-web", sandbox, {
    phase: "context",
    capabilities: { network: true },
    policy: {
      allowedPermissions: ["read", "network"],
      allowedSideEffects: ["none", "network"],
      allowedRiskLevels: ["low", "high"],
      allowNetwork: true,
    },
    webAdapter: {
      fetch: async (request: { url: string }) => ({ url: request.url, status: 200, contentType: "text/plain", text: "hello" }),
      search: async (request: { query: string; limit: number }) => ({
        query: request.query,
        results: [{ title: "Example", url: "https://example.com", snippet: `limit ${request.limit}` }],
      }),
    },
  });

  assert.equal(registry.getCatalog(openContext).some((tool) => tool.id === "web_fetch"), true);
  const fetched = (await registry.execute("web_fetch", { url: "https://example.com" }, openContext)) as { text: string };
  assert.equal(fetched.text, "hello");
  const search = (await registry.execute("web_search", { query: "agent tools", limit: 1 }, openContext)) as {
    results: Array<{ title: string }>;
  };
  assert.equal(search.results[0]?.title, "Example");

  await rm(root, { recursive: true, force: true });
});

test("web tool traces include readable network result summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-web-summary");
  const registry = createDefaultToolRegistry();
  const traces: Array<{ toolName: string; status: string; outputSummary?: string }> = [];
  const context = toolContext("run-web-summary", sandbox, {
    phase: "context",
    capabilities: { network: true },
    emitTrace: (trace: { toolName: string; status: string; outputSummary?: string }) => traces.push(trace),
    policy: {
      allowedPermissions: ["read", "network"],
      allowedSideEffects: ["none", "network"],
      allowedRiskLevels: ["low", "high"],
      allowNetwork: true,
    },
    webAdapter: {
      fetch: async (request: { url: string }) => ({ url: request.url, status: 200, contentType: "text/html", text: "hello world" }),
      search: async (request: { query: string }) => ({
        query: request.query,
        results: [
          { title: "OpenAI Docs", url: "https://platform.openai.com/docs" },
          { title: "API Reference", url: "https://developers.openai.com/api/docs" },
        ],
      }),
    },
  });

  await registry.execute("web_fetch", { url: "https://example.com" }, context);
  await registry.execute("web_search", { query: "OpenAI docs", limit: 2 }, context);

  const fetchTrace = traces.find((trace) => trace.toolName === "web_fetch" && trace.status === "completed");
  const searchTrace = traces.find((trace) => trace.toolName === "web_search" && trace.status === "completed");
  assert.equal(fetchTrace?.outputSummary, "200 text/html; 11 chars");
  assert.equal(searchTrace?.outputSummary, "2 results: OpenAI Docs (platform.openai.com); API Reference (developers.openai.com)");

  await rm(root, { recursive: true, force: true });
});

test("mcp resource tools use a live adapter when capability is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-mcp");
  const registry = createDefaultToolRegistry();
  const context = toolContext("run-mcp", sandbox, {
    phase: "context",
    capabilities: { mcp: true },
    mcpAdapter: {
      listResources: async () => [{ uri: "mcp://project/schema", name: "Schema" }],
      readResource: async (uri: string) => ({ uri, text: "resource body", mimeType: "text/plain" }),
    },
  });

  const listed = (await registry.execute("list_mcp_resources", {}, context)) as {
    resources: Array<{ uri: string; name?: string }>;
  };
  assert.equal(listed.resources[0]?.uri, "mcp://project/schema");

  const read = (await registry.execute("read_mcp_resource", { uri: "mcp://project/schema" }, context)) as {
    text?: string;
  };
  assert.equal(read.text, "resource body");

  await rm(root, { recursive: true, force: true });
});

test("plan mode tools update runtime planning state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-plan-mode");
  const registry = createDefaultToolRegistry();
  const context = toolContext("run-plan-mode", sandbox, { phase: "plan" });

  const entered = (await registry.execute("enter_plan_mode", { objective: "Design tool architecture" }, context)) as {
    planMode: { active: boolean; objective?: string; enteredAt?: string };
  };
  assert.equal(entered.planMode.active, true);
  assert.equal(entered.planMode.objective, "Design tool architecture");
  assert.equal(typeof entered.planMode.enteredAt, "string");

  const status = (await registry.execute("plan_mode_status", {}, context)) as { planMode: { active: boolean } };
  assert.equal(status.planMode.active, true);

  const exited = (await registry.execute("exit_plan_mode", { summary: "Plan accepted" }, context)) as {
    planMode: { active: boolean; objective?: string; exitedAt?: string };
  };
  assert.equal(exited.planMode.active, false);
  assert.equal(exited.planMode.objective, "Plan accepted");
  assert.equal(typeof exited.planMode.exitedAt, "string");

  await rm(root, { recursive: true, force: true });
});

test("run_command uses sandbox SQLite DATABASE_URL instead of host DATABASE_URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-env");
  const registry = createDefaultToolRegistry();
  const previousDatabaseUrl = process.env.DATABASE_URL;

  await sandbox.writeFile(
    "package.json",
    JSON.stringify({
      scripts: {
        build: "node -e \"require('node:fs').writeFileSync('db-url.txt', process.env.DATABASE_URL || '')\"",
      },
    }),
  );

  try {
    process.env.DATABASE_URL = "postgresql://host.example/app";
    await registry.execute(
      "run_command",
      { command: ["npm", "run", "build"] },
      { runId: "run-env", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} },
    );

    assert.equal(await readFile(join(sandbox.sandboxRoot, "db-url.txt"), "utf-8"), "file:./dev.db");
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("run_command times out cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-timeout");
  const registry = createDefaultToolRegistry();

  await sandbox.writeFile(
    "package.json",
    JSON.stringify({
      scripts: {
        build: "node -e \"console.log('started'); setTimeout(() => {}, 10000)\"",
      },
    }),
  );

  try {
    const startedAt = Date.now();
    await assert.rejects(
      registry.execute(
        "run_command",
        { command: ["npm", "run", "build"], timeoutMs: 100 },
        { runId: "run-timeout", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /timed out after 100ms/);
        assert.equal((error as { exitCode?: number }).exitCode, 124);
        assert.equal(typeof (error as { output?: string }).output, "string");
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent design and reference tools return bounded guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-1");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-1", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  const skill = (await registry.execute("use_design_skill", { skill: "frontend-design", focus: "planner" }, context)) as {
    guidance: string[];
    avoid: string[];
  };
  assert.ok(skill.guidance.some((item) => /390px|mobile/i.test(item)));
  assert.ok(skill.avoid.some((item) => /generic/i.test(item)));

  const reference = (await registry.execute("inspect_reference_app", { app: "my-season", focus: "backend" }, context)) as {
    backend: string[];
    loop: string[];
    commercialSignals: string[];
  };
  assert.ok(reference.backend.some((item) => /api/i.test(item)));
  assert.ok(reference.loop.some((item) => /suggestion|fragment/i.test(item)));
  assert.ok(reference.commercialSignals.some((item) => /Archive|AI|loading|durable/i.test(item)));

  await rm(root, { recursive: true, force: true });
});

test("quality_audit reports lightweight product closure issues as advisory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-strict");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-strict", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  // Build a tiny but lexically clean Next.js scaffold that still violates real
  // product-closure checks (shallow route surface, dead Server Action, weak interactions, no states).
  await sandbox.writeFile(
    "package.json",
    JSON.stringify({ name: "demo", scripts: { build: "next build" } }),
  );
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile(
    "src/app/layout.tsx",
    "export const metadata = { title: 'Demo App' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  await sandbox.writeFile(
    "src/app/page.tsx",
    "import { Card } from \"@/components/Card\";\nexport default function Page() { return <main><nav><a href=\"/\">Home</a></nav><Card><button onClick={() => {}}>Save</button></Card></main>; }\n",
  );
  await sandbox.writeFile(
    "src/app/globals.css",
    ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n",
  );
  await sandbox.writeFile("src/components/Card.tsx", "export function Card({ children }: { children: React.ReactNode }) { return <div className=\"card\">{children}</div>; }\n");
  await sandbox.writeFile(
    "src/app/actions.ts",
    "\"use server\";\nexport async function saveItem(_form: FormData) { /* never called from UI */ }\n",
  );
  await sandbox.writeFile("prisma/schema.prisma", "model Item {\n  id String @id\n  title String\n}\n");
  await sandbox.writeFile("src/lib/db.ts", "export const db = {};\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    status: string;
    blockingFailures: number;
    checks: Array<{ id: string; passed: boolean; blocking: boolean; detail: string }>;
  };

  assert.equal(audit.status, "passed", "product-closure issues should not block the static engineering audit");
  assert.equal(audit.blockingFailures, 0);
  const failedChecks = audit.checks.filter((check) => !check.passed);
  const failedIds = failedChecks.map((check) => check.id);
  assert.ok(failedIds.includes("route-surface-depth"), `expected route-surface-depth to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("server-action-wired"), `expected server-action-wired to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("interaction-model-depth"), `expected interaction-model-depth to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("state-coverage"), `expected state-coverage to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("workflow-state-depth"), `expected workflow-state-depth to fail; got ${failedIds.join(",")}`);
  assert.ok(failedChecks.every((check) => !check.blocking), "product-closure failures should remain advisory");
  assert.equal(audit.checks.find((check) => check.id === "distinct-page-routes")?.passed, false);
  assert.equal(audit.checks.find((check) => check.id === "multiple-models")?.passed, true);
  assert.equal(audit.checks.find((check) => check.id === "model-relations")?.passed, true);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts a compact single-route Vercel app with local state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-lightweight-app");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-lightweight-app", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile(
    "package.json",
    JSON.stringify({
      scripts: { build: "next build" },
      dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
    }),
  );
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile(
    "src/app/layout.tsx",
    "import './globals.css';\nexport const metadata = { title: '晨间计划', description: '轻量个人计划工作台' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html lang=\"zh-CN\"><body>{children}</body></html>; }\n",
  );
  await sandbox.writeFile(
    "src/app/page.tsx",
    "import { FocusWorkbench } from '@/components/FocusWorkbench';\nimport { focusItems } from '@/lib/demo-data';\nexport default function Page() { return <FocusWorkbench items={focusItems} />; }\n",
  );
  await sandbox.writeFile(
    "src/components/AppShell.tsx",
    "export function AppShell({ children }: { children: React.ReactNode }) { return <main><nav aria-label=\"主导航\"><a href=\"#today\">今日</a><a href=\"#history\">历史</a><a href=\"#settings\">设置</a></nav>{children}</main>; }\n",
  );
  await sandbox.writeFile(
    "src/components/EmptyState.tsx",
    "export function EmptyState() { return <p className=\"empty-state\">没有符合筛选的计划，先保存一个今天的重点。</p>; }\n",
  );
  await sandbox.writeFile(
    "src/components/FocusWorkbench.tsx",
    [
      "\"use client\";",
      "import { useMemo, useState } from 'react';",
      "import { AppShell } from './AppShell';",
      "import { EmptyState } from './EmptyState';",
      "import { saveLocalPlan } from '@/lib/local-storage';",
      "import type { FocusItem } from '@/lib/demo-data';",
      "export function FocusWorkbench({ items }: { items: FocusItem[] }) {",
      "  const [activeTab, setActiveTab] = useState<'today' | 'history' | 'settings'>('today');",
      "  const [filter, setFilter] = useState<'all' | 'deep' | 'quick'>('all');",
      "  const [savedId, setSavedId] = useState(items[0]?.id ?? '');",
      "  const [errorState, setErrorState] = useState('');",
      "  const visibleItems = useMemo(() => items.filter((item) => filter === 'all' || item.kind === filter), [filter, items]);",
      "  const historyGroups = new Map([['今天', visibleItems.map((item) => item.title)], ['本周', ['复盘晨间节奏', '完成桌面整理']]]);",
      "  function handleSave(id: string) { setSavedId(id); setErrorState(''); saveLocalPlan(id); }",
      "  return <AppShell><header className=\"brand\"><p>晨间计划</p><h1>把今天收成三个轻重点</h1><p>保存成功后会出现在历史分组里；如果本地保存失败，可以点重试恢复。</p></header><section className=\"surface-tabs\" id=\"today\">{(['today','history','settings'] as const).map((tab) => <button key={tab} aria-pressed={activeTab === tab} onClick={() => setActiveTab(tab)}>{tab === 'today' ? '今日' : tab === 'history' ? '历史' : '设置'}</button>)}</section><section className=\"filter-panel\"><h2>今日节奏</h2>{(['all','deep','quick'] as const).map((item) => <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item === 'all' ? '全部' : item === 'deep' ? '深度' : '快速'}</button>)}</section><section className=\"action-grid\">{visibleItems.length === 0 ? <EmptyState /> : visibleItems.map((item) => <article className={savedId === item.id ? 'card saved' : 'card'} key={item.id}><h2>{item.title}</h2><p>{item.summary}</p><button onClick={() => handleSave(item.id)}>{savedId === item.id ? '已保存' : '保存重点'}</button><button onClick={() => setErrorState('已恢复，可以继续编辑')}>重试</button><button>编辑</button></article>)}</section><section className=\"history-panel\" id=\"history\">{[...historyGroups].map(([day, records]) => <article key={day}><time>{day}</time>{records.map((record) => <p key={record}>{record}<button>删除</button></p>)}</article>)}</section><section className=\"settings-panel\" id=\"settings\"><h2>本地偏好</h2><p>已完成轻量保存，当前状态会在本机保留。</p><button onClick={() => setErrorState('保存失败，请重试')}>模拟异常</button>{errorState ? <p role=\"alert\">{errorState}</p> : null}</section></AppShell>;",
      "}",
    ].join("\n"),
  );
  await sandbox.writeFile(
    "src/lib/demo-data.ts",
    "export type FocusItem = { id: string; title: string; summary: string; kind: 'deep' | 'quick'; tags: string[]; updatedAt: string };\nexport const focusItems = [{ id: 'deep-1', title: '写完晨间提纲', summary: '25 分钟完成第一版结构，保留两个待确认问题。', kind: 'deep', tags: ['写作'], updatedAt: '今天 08:10' }, { id: 'quick-1', title: '整理桌面入口', summary: '归档下载区和项目便签，让下一步可见。', kind: 'quick', tags: ['整理'], updatedAt: '今天 08:30' }, { id: 'deep-2', title: '复盘昨日阻塞', summary: '标记一个需要求助的点和一个可独立推进的点。', kind: 'deep', tags: ['复盘'], updatedAt: '今天 08:45' }] satisfies FocusItem[];\n",
  );
  await sandbox.writeFile(
    "src/lib/local-storage.ts",
    "export function saveLocalPlan(id: string) { try { localStorage.setItem('morning-plan-id', id); } catch { /* ignore unavailable storage */ } }\n",
  );
  await sandbox.writeFile(
    "src/app/globals.css",
    ":root { --paper: #faf7ef; --ink: #172018; --accent: #3f7d58; --line: #d8cfbd; }\n* { box-sizing: border-box; }\nbody { margin: 0; background: var(--paper); color: var(--ink); font-family: Inter, 'PingFang SC', sans-serif; }\nmain { width: min(100%, 430px); margin: 0 auto; padding: 18px; }\nnav, .surface-tabs, .filter-panel { display: flex; gap: 8px; flex-wrap: wrap; }\nbutton { min-height: 38px; border: 1px solid var(--line); background: white; color: var(--ink); border-radius: 8px; }\nbutton[aria-pressed='true'], .saved { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }\nbutton:focus-visible { outline: 3px solid #e2b85b; outline-offset: 2px; }\n.brand, .card, .history-panel article, .settings-panel { border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin: 12px 0; background: #fffdf8; }\n.action-grid { display: grid; gap: 10px; }\n.empty-state { padding: 12px; border: 1px dashed var(--accent); }\n@media (min-width: 760px) { main { width: min(100%, 880px); } .action-grid { grid-template-columns: repeat(3, 1fr); } }\n",
  );

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    status: string;
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  assert.equal(audit.status, "passed", audit.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`).join("\n"));
  assert.equal(audit.checks.find((check) => check.id === "distinct-page-routes")?.passed, true);
  assert.equal(audit.checks.find((check) => check.id === "component-library")?.passed, true);
  assert.equal(audit.checks.find((check) => check.id === "server-data-boundary")?.passed, true);
  assert.equal(audit.checks.find((check) => check.id === "mutation-boundary")?.passed, true);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts layout-imported global CSS outside src/app", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-global-css-entry");
  const registry = createDefaultToolRegistry();
  const context = toolContext("run-global-css-entry", sandbox);

  await sandbox.writeFile("package.json", JSON.stringify({ name: "demo", scripts: { build: "next build" } }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile(
    "src/app/layout.tsx",
    "import '@/styles/globals.css';\nexport const metadata = { title: 'Demo App', description: 'Demo' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  await sandbox.writeFile(
    "src/app/page.tsx",
    "import { Card } from '@/components/Card';\nexport default function Page() { return <main><nav><a href=\"/favorites\">收藏</a></nav><Card><button>保存</button></Card></main>; }\n",
  );
  await sandbox.writeFile(
    "src/styles/globals.css",
    ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n",
  );
  await sandbox.writeFile("src/components/Card.tsx", "export function Card({ children }: { children: React.ReactNode }) { return <article>{children}</article>; }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const scaffold = audit.checks.find((check) => check.id === "next-app-scaffold");
  assert.equal(scaffold?.passed, true, scaffold?.detail);
  await rm(root, { recursive: true, force: true });
});

test("quality_audit reports input-heavy apps with shallow interaction models as advisory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-interaction-model");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-interaction-model", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile(
    "package.json",
    JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" } }),
  );
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile(
    "src/app/layout.tsx",
    "export const metadata = { title: 'Diary' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  await sandbox.writeFile(
    "src/app/page.tsx",
    [
      "import { saveEntry } from './actions';",
      "export default function Page() {",
      "  return <main><nav>Today History Settings</nav><h1>Diary</h1><form action={saveEntry}><textarea name=\"entry\" /><button>保存中</button><p>保存成功</p></form><p className=\"empty-state\">没有日记记录，写下第一篇。</p></main>;",
      "}",
    ].join("\n"),
  );
  await sandbox.writeFile("src/app/history/page.tsx", "export default function History() { return <main><h1>History</h1><p>历史记录列表</p></main>; }\n");
  await sandbox.writeFile("src/app/settings/page.tsx", "export default function Settings() { return <main><h1>Settings</h1></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.empty-state {}\n");
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "DiaryCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <div>${name}</div>; }\n`);
  }
  await sandbox.writeFile("src/app/actions.ts", "\"use server\";\nexport async function saveEntry(_form: FormData) { return { saved: true }; }\n");
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/db.ts", "export const db = {};\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    status: string;
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const interactionDepth = audit.checks.find((check) => check.id === "interaction-model-depth");
  const affordances = audit.checks.find((check) => check.id === "domain-interaction-affordances");
  assert.equal(interactionDepth?.passed, false);
  assert.equal(affordances?.passed, false);
  assert.match(affordances?.detail ?? "", /edit=false/);
  assert.match(affordances?.detail ?? "", /date=false/);
  assert.match(affordances?.detail ?? "", /focus=false/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit reports shallow secondary route surfaces as advisory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-route-depth");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-route-depth", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile(
    "package.json",
    JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" } }),
  );
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile(
    "src/app/layout.tsx",
    "export const metadata = { title: 'Journal' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  await sandbox.writeFile(
    "src/app/page.tsx",
    "import { HomeSurface } from '@/components/HomeSurface';\nexport default function Page() { return <HomeSurface />; }\n",
  );
  await sandbox.writeFile(
    "src/app/history/page.tsx",
    "export default function History() { return <main><h1>记录</h1><p>历史记录列表</p></main>; }\n",
  );
  await sandbox.writeFile(
    "src/app/settings/page.tsx",
    "export default function Settings() { return <main><h1>设置</h1><p>偏好设置</p></main>; }\n",
  );
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.empty-state {}\n");
  await sandbox.writeFile(
    "src/components/HomeSurface.tsx",
    [
      "\"use client\";",
      "import { useState } from 'react';",
      "export function HomeSurface() {",
      "  const [filter, setFilter] = useState('all');",
      "  const entries = ['早餐记录', '晚餐记录'];",
      "  return <main><nav><a href=\"/history\">历史</a><a href=\"/settings\">设置</a></nav><section><h1>食记</h1><form><input autoFocus className=\"focus-visible:ring\" name=\"entry\" /><button>保存中</button><p>保存成功</p></form></section><section>{['all','month','tag'].map((item) => <button aria-pressed={filter===item} onClick={() => setFilter(item)} key={item}>{item}</button>)}</section><section>{entries.map((entry) => <article key={entry}><button>编辑</button><button>删除</button>{entry}</article>)}</section><p className=\"empty-state\">没有记录</p></main>;",
      "}",
    ].join("\n"),
  );
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "DiaryCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <div>${name}</div>; }\n`);
  }
  await sandbox.writeFile("src/app/actions.ts", "\"use server\";\nexport async function saveEntry(_form: FormData) { return { saved: true }; }\n");
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/db.ts", "export const db = {};\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    status: string;
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const routeDepth = audit.checks.find((check) => check.id === "route-surface-depth");
  assert.equal(routeDepth?.passed, false);
  assert.match(routeDepth?.detail ?? "", /src\/app\/history\/page\.tsx/);
  assert.match(routeDepth?.detail ?? "", /src\/app\/settings\/page\.tsx/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit blocks styled-jsx in App Router server convention files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-boundary");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-boundary", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({ scripts: { build: "next build" } }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Journal' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "export default function Page() { return <main><nav>Today History Settings</nav><h1>Journal</h1><button>Save</button></main>; }\n");
  await sandbox.writeFile("src/app/history/page.tsx", "export default function History() { return <main><h1>History</h1></main>; }\n");
  await sandbox.writeFile("src/app/settings/page.tsx", "export default function Settings() { return <main><h1>Settings</h1></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main><style jsx>{`.x{color:red}`}</style></main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.empty-state {}\n");
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "JournalCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <div>${name}</div>; }\n`);
  }
  await sandbox.writeFile("src/app/actions.ts", "\"use server\";\nexport async function saveEntry(_form: FormData) { return { saved: true }; }\n");
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/db.ts", "export const db = {};\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    status: string;
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const boundary = audit.checks.find((check) => check.id === "app-router-client-boundary");
  assert.equal(boundary?.passed, false);
  assert.match(boundary?.detail ?? "", /loading\.tsx/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit blocks loose truthy filters in strict TypeScript files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-null-narrowing");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-null-narrowing", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({ scripts: { build: "next build" } }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "export default function Page() { const items = ['a'].map((id) => ({ id })).filter(Boolean); return <main><nav>Home Saved Budget</nav><h1>Trip</h1>{items.map((item) => <button key={item.id}>{item.id}</button>)}</main>; }\n");
  await sandbox.writeFile("src/app/saved/page.tsx", "export default function Saved() { return <main><h1>Saved</h1></main>; }\n");
  await sandbox.writeFile("src/app/budget/page.tsx", "export default function Budget() { return <main><h1>Budget</h1></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.empty-state {}\n");
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <div>${name}</div>; }\n`);
  }
  await sandbox.writeFile("src/app/actions.ts", "\"use server\";\nexport async function saveTrip(_form: FormData) { return { saved: true }; }\n");
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/db.ts", "export const db = {};\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    status: string;
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const narrowing = audit.checks.find((check) => check.id === "strict-null-narrowing");
  assert.equal(narrowing?.passed, false);
  assert.match(narrowing?.detail ?? "", /filter\(Boolean\)/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit blocks undeclared recognized import dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-import-deps");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-import-deps", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { saveTrip } from './actions';\nexport default function Page() { return <main><nav>Home Saved Budget</nav><h1>Trip</h1><form action={saveTrip}><button>保存中</button><p>保存成功</p></form><p className=\"empty-state\">没有收藏</p></main>; }\n");
  await sandbox.writeFile("src/app/saved/page.tsx", "export default function Saved() { return <main><h1>Saved</h1></main>; }\n");
  await sandbox.writeFile("src/app/budget/page.tsx", "export default function Budget() { return <main><h1>Budget</h1></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.empty-state {}\n");
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <div>${name}</div>; }\n`);
  }
  await sandbox.writeFile("src/app/actions.ts", "\"use server\";\nimport { z } from \"zod\";\nconst Input = z.object({ id: z.string().optional() });\nexport async function saveTrip(form: FormData) { Input.parse({ id: form.get('id') }); return { saved: true }; }\n");
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/db.ts", "export const db = {};\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    status: string;
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const declaredDeps = audit.checks.find((check) => check.id === "declared-import-dependencies");
  assert.equal(declaredDeps?.passed, false);
  assert.match(declaredDeps?.detail ?? "", /zod/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit ignores build artifacts and framework sentinel imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-audit-source-only");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-audit-source-only", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { saveTrip } from './actions';\nexport default function Page() { return <main><nav>Home Saved Budget</nav><h1>Trip</h1><form action={saveTrip}><button>保存中</button><p>保存成功</p></form><p className=\"empty-state\">没有收藏</p></main>; }\n");
  await sandbox.writeFile("src/app/saved/page.tsx", "export default function Saved() { return <main><h1>Saved</h1><a href=\"/\">Home</a><button>筛选</button></main>; }\n");
  await sandbox.writeFile("src/app/budget/page.tsx", "export default function Budget() { return <main><h1>Budget</h1><a href=\"/\">Home</a><button>编辑</button></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.empty-state {}\n");
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/actions.ts", "\"use server\";\nexport async function saveTrip(_form: FormData) { return { saved: true }; }\n");
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/server-data.ts", "import 'server-only';\nexport const trips = [{ id: 'trip-1', title: '静安路线' }] as const;\n");
  await sandbox.writeFile(".next/server/chunks/compiled.js", "const unsafe = [1].filter(Boolean);\nimport 'server-only';\n");
  await sandbox.writeFile("out/_next/static/chunks/compiled.js", "const unsafe = [1].filter(Boolean);\nimport 'server-only';\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  assert.equal(audit.checks.find((check) => check.id === "server-data-boundary")?.passed, true);
  assert.equal(audit.checks.find((check) => check.id === "strict-null-narrowing")?.passed, true);
  assert.equal(audit.checks.find((check) => check.id === "declared-import-dependencies")?.passed, true);
  assert.equal(audit.checks.find((check) => check.id === "durable-state")?.passed, true);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit recognizes trip day navigation as date-period interaction evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-day-nav");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-day-nav", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/day/[dayNumber]/page.tsx", "export default function DayPage() { return <main><h1>第一天路线</h1><a href=\"/\">首页</a><button>编辑</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏历史</h1><a href=\"/\">首页</a><button>筛选</button></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n.day-switcher {}\n.day-switch-btn.active {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "const tripDays = [{ dayNumber: 1, title: '第一天' }, { dayNumber: 2, title: '第二天' }, { dayNumber: 3, title: '第三天' }];",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [filter, setFilter] = useState('all');",
    "  const [note, setNote] = useState('');",
    "  const groupedHistory = new Map([['5月1日', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/\">首页</a><a href=\"/favorites\">收藏</a><a href=\"/day/1\">日期</a></nav><h1>沪上漫记</h1><section className=\"day-switcher\">{tripDays.map((day) => <button className={selectedDay === day.dayNumber ? 'day-switch-btn active' : 'day-switch-btn'} aria-pressed={selectedDay === day.dayNumber} onClick={() => setSelectedDay(day.dayNumber)} key={day.dayNumber}>D{day.dayNumber} {day.title}</button>)}</section><section><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>餐饮</button></section><form><textarea autoFocus value={note} onChange={(event) => setNote(event.currentTarget.value)} name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form><section>{[...groupedHistory].map(([month, items]) => <article key={month}><time>{month}</time>{items.map((item) => <p key={item}>{item}<button>编辑</button><button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏记录</p></main>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", "export type TripDay = { dayNumber: number; title: string };\nexport const tripDays = [{ dayNumber: 1, title: '第一天' }] satisfies TripDay[];\n");
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  assert.equal(audit.checks.find((check) => check.id === "interaction-model-depth")?.passed, true);
  assert.equal(audit.checks.find((check) => check.id === "domain-interaction-affordances")?.passed, true);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit reports missing media-heavy visuals as advisory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-media-missing");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-media-missing", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/itinerary/page.tsx", "export default function Itinerary() { return <main><h1>上海行程</h1><a href=\"/\">首页</a><button>雨天切换</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><a href=\"/\">首页</a><button>筛选景点</button></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "const places = ['静安寺', '武康路', '外滩'];",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/itinerary\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{[1,2,3].map((day) => <button aria-pressed={selectedDay === day} onClick={() => setSelectedDay(day)} key={day}>D{day}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <article key={place}><h2>{place}</h2><button>查看详情</button><button>编辑</button></article>)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", "export type TripPlace = { id: string; name: string; imageAlt: string };\nexport const tripPlaces = [{ id: 'jing-an', name: '静安寺', imageAlt: '静安寺手绘插画' }] satisfies TripPlace[];\n");
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    status: string;
    blockingFailures: number;
    checks: Array<{ id: string; passed: boolean; blocking: boolean; detail: string }>;
  };

  const media = audit.checks.find((check) => check.id === "domain-visual-media");
  assert.equal(media?.passed, false);
  assert.equal(media?.blocking, false);
  assert.match(media?.detail ?? "", /visible source-declared media=false/);
  const homeMedia = audit.checks.find((check) => check.id === "media-heavy-home-media");
  assert.equal(homeMedia?.passed, false);
  assert.equal(homeMedia?.blocking, false);
  assert.match(homeMedia?.detail ?? "", /root route visible source-declared media=false/);
  assert.equal(audit.status, "passed");
  assert.equal(audit.blockingFailures, 0);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts role img data-visual illustrations for media-heavy trip apps", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-media-present");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-media-present", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/itinerary/page.tsx", "export default function Itinerary() { return <main><h1>上海行程</h1><a href=\"/\">首页</a><button>雨天切换</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><a href=\"/\">首页</a><button>筛选景点</button></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; background: radial-gradient(circle at 30% 30%, #e7b85f, transparent 20%), linear-gradient(#dfe8d8, #f7ead0); }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "const places = ['静安寺', '武康路', '外滩'];",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/itinerary\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{[1,2,3].map((day) => <button aria-pressed={selectedDay === day} onClick={() => setSelectedDay(day)} key={day}>D{day}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <article key={place}><div role=\"img\" data-visual aria-label={`${place} 手绘旅行插画`} className=\"place-visual\" /><h2>{place}</h2><button>查看详情</button><button>编辑</button></article>)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", "export type TripPlace = { id: string; name: string; visualLabel: string };\nexport const tripPlaces = [{ id: 'jing-an', name: '静安寺', visualLabel: '静安寺手绘插画' }] satisfies TripPlace[];\n");
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const media = audit.checks.find((check) => check.id === "domain-visual-media");
  assert.equal(media?.passed, true);
  assert.match(media?.detail ?? "", /visible source-declared media=true/);
  const homeMedia = audit.checks.find((check) => check.id === "media-heavy-home-media");
  assert.equal(homeMedia?.passed, true);
  assert.match(homeMedia?.detail ?? "", /root route visible source-declared media=true/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit reports thin travel itineraries and generic place visuals as advisory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-thin-itinerary");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-thin-itinerary", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/day/[dayId]/page.tsx", "export default function DayPage() { return <main><h1>行程详情</h1><a href=\"/\">首页</a><button>雨天切换</button><button>收藏</button></main>; }\n");
  await sandbox.writeFile("src/app/place/[placeId]/page.tsx", "export default function PlacePage() { return <main><h1>地点详情</h1><a href=\"/\">首页</a><button>收藏</button><button>标记必去</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><article><h2>静安寺</h2><button>筛选景点</button><button>移除</button><button>必去</button></article><article><h2>武康路</h2><button>筛选餐饮</button><button>移除</button><button>必去</button></article></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "import { days, places } from '@/lib/demo-data';",
    "import { PlaceVisual } from './PlaceVisual';",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/day/day-1\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{days.map((day) => <button aria-pressed={selectedDay === day.dayNumber} onClick={() => setSelectedDay(day.dayNumber)} key={day.id}>D{day.dayNumber}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <article key={place.id}><PlaceVisual placeId={place.id} name={place.name} type={place.type} /><h2>{place.name}</h2><a href={`/place/${place.id}`}>查看详情</a><button>编辑</button></article>)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/components/PlaceVisual.tsx", [
    "export function PlaceVisual({ name, type }: { placeId: string; name: string; type: 'scenic' | 'dining' }) {",
    "  const scenic = type === 'scenic';",
    "  return <div role=\"img\" data-visual aria-label={`${name} 手绘旅行插画`} className=\"place-visual\"><svg><rect fill={scenic ? '#dfe8d8' : '#f7ead0'} /><text>{name.slice(0, 4)}</text></svg></div>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", [
    "export type TripPlace = { id: string; name: string; type: 'scenic' | 'dining'; description: string; tips: string };",
    "export const places = [",
    "  { id: 'p-1', name: '静安寺', type: 'scenic', description: '古刹与咖啡街区。', tips: '上午去。' },",
    "  { id: 'p-2', name: '璞丽下午茶', type: 'dining', description: '酒店下午茶。', tips: '预约。' },",
    "  { id: 'p-3', name: '豫园', type: 'scenic', description: '江南园林。', tips: '早到。' },",
    "  { id: 'p-4', name: '南翔馒头店', type: 'dining', description: '小笼包。', tips: '错峰。' }",
    "] satisfies TripPlace[];",
    "export const days = [",
    "  { id: 'day-1', dayNumber: 1, placeIds: ['p-1', 'p-2'], altPlaceIds: ['p-1'] },",
    "  { id: 'day-2', dayNumber: 2, placeIds: ['p-3', 'p-4', 'p-1', 'p-2'], altPlaceIds: ['p-3', 'p-4'] },",
    "  { id: 'day-3', dayNumber: 3, placeIds: ['p-1', 'p-3', 'p-4'], altPlaceIds: ['p-2'] }",
    "];",
  ].join("\n"));
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const itineraryDepth = audit.checks.find((check) => check.id === "travel-itinerary-depth");
  assert.equal(itineraryDepth?.passed, false);
  assert.match(itineraryDepth?.detail ?? "", /default place counts=2, 4, 3/);
  const visualSpecificity = audit.checks.find((check) => check.id === "travel-place-visual-specificity");
  assert.equal(visualSpecificity?.passed, false);
  assert.match(visualSpecificity?.detail ?? "", /place media fields=0/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts deep travel itineraries with place-specific visuals", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-deep-itinerary");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-deep-itinerary", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/day/[dayId]/page.tsx", "export default function DayPage() { return <main><h1>行程详情</h1><a href=\"/\">首页</a><button>雨天切换</button><button>收藏</button></main>; }\n");
  await sandbox.writeFile("src/app/place/[placeId]/page.tsx", "export default function PlacePage() { return <main><h1>地点详情</h1><a href=\"/\">首页</a><button>收藏</button><button>标记必去</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><article><h2>静安寺</h2><button>筛选景点</button><button>移除</button><button>必去</button></article><article><h2>武康路</h2><button>筛选餐饮</button><button>移除</button><button>必去</button></article></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; background: radial-gradient(circle at 20% 20%, #d6af62, transparent 20%), linear-gradient(#dfe8d8, #f7ead0); }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "import { days, places } from '@/lib/demo-data';",
    "import { PlaceVisual } from './PlaceVisual';",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/day/day-1\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{days.map((day) => <button aria-pressed={selectedDay === day.dayNumber} onClick={() => setSelectedDay(day.dayNumber)} key={day.id}>D{day.dayNumber}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <article key={place.id}><PlaceVisual placeId={place.id} name={place.name} /><h2>{place.name}</h2><a href={`/place/${place.id}`}>查看详情</a><button>编辑</button></article>)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/components/PlaceVisual.tsx", [
    "const placeVisuals: Record<string, string> = { 'p-1': '寺院金顶和梧桐', 'p-2': '露台咖啡杯', 'p-3': '豫园屋檐', 'p-4': '小笼蒸笼' };",
    "export function PlaceVisual({ placeId, name }: { placeId: string; name: string }) {",
    "  const defaultVisual = 'defaultVisual';",
    "  const label = placeVisuals[placeId] ?? defaultVisual ?? name;",
    "  return <div role=\"img\" data-visual aria-label={`${name} ${label} 专属插画`} className=\"place-visual\"><svg><text>{label}</text></svg></div>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", [
    "export type TripPlace = { id: string; name: string; imageUrl: string; visualLabel: string; whyGo: string; bestTime: string; transport: string; photoTip: string; nearby: string };",
    "export const places = Array.from({ length: 12 }, (_, index) => ({",
    "  id: `p-${index + 1}`,",
    "  name: ['静安寺','璞丽下午茶','巨鹿路','静安公园','豫园','南翔馒头店','外滩源','上海博物馆','武康路','老吉士','衡山坊','电影博物馆'][index],",
    "  imageUrl: `/images/place-${index + 1}.svg`,",
    "  visualLabel: `上海地点 ${index + 1} 专属插画`,",
    "  whyGo: '把建筑、餐饮和散步节奏串成一个明确停留理由。',",
    "  bestTime: '上午或傍晚光线最舒服。',",
    "  transport: '地铁加步行十分钟内可达。',",
    "  photoTip: '从街角低角度拍建筑线条。',",
    "  nearby: '附近有咖啡、书店和可休息的小广场。'",
    "}));",
    "export const days = [",
    "  { id: 'day-1', dayNumber: 1, placeIds: ['p-1', 'p-2', 'p-3', 'p-4'], altPlaceIds: ['p-1', 'p-2', 'p-4'] },",
    "  { id: 'day-2', dayNumber: 2, placeIds: ['p-5', 'p-6', 'p-7', 'p-8'], altPlaceIds: ['p-6', 'p-8', 'p-5'] },",
    "  { id: 'day-3', dayNumber: 3, placeIds: ['p-9', 'p-10', 'p-11', 'p-12'], altPlaceIds: ['p-10', 'p-11', 'p-12'] }",
    "];",
  ].join("\n"));
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const itineraryDepth = audit.checks.find((check) => check.id === "travel-itinerary-depth");
  assert.equal(itineraryDepth?.passed, true, itineraryDepth?.detail);
  const visualSpecificity = audit.checks.find((check) => check.id === "travel-place-visual-specificity");
  assert.equal(visualSpecificity?.passed, true, visualSpecificity?.detail);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts data-bound travel place images", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-data-bound-images");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-data-bound-images", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/day/[dayId]/page.tsx", "import { days } from '@/lib/demo-data';\nexport default function DayPage({ params }: { params: { dayId: string } }) { const day = days.find((item) => item.id === params.dayId) ?? days[0]; return <main><h1>{day.title}</h1><a href=\"/\">首页</a><a href=\"/place/p-1\">地点</a><button>雨天切换</button></main>; }\n");
  await sandbox.writeFile("src/app/place/[placeId]/page.tsx", "import { places } from '@/lib/demo-data';\nimport { PlaceCard } from '@/components/PlaceCard';\nexport default function PlacePage({ params }: { params: { placeId: string } }) { const place = places.find((item) => item.id === params.placeId) ?? places[0]; return <main><h1>{place.name}</h1><PlaceCard place={place} /><p>{place.whyGo}</p><a href=\"/favorites\">收藏</a><button>标记必去</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "import { places } from '@/lib/demo-data';\nimport { PlaceCard } from '@/components/PlaceCard';\nexport default function Favorites() { return <main><h1>收藏地点</h1><button>筛选景点</button><button>筛选餐饮</button>{places.slice(0, 2).map((place) => <PlaceCard key={place.id} place={place} />)}<button>移除</button><button>必去</button></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.card-img { width: 100%; height: 180px; object-fit: cover; }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "import { days, places } from '@/lib/demo-data';",
    "import { PlaceCard } from './PlaceCard';",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState('day-1');",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/day/day-1\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{days.map((day) => <button aria-pressed={selectedDay === day.id} onClick={() => setSelectedDay(day.id)} key={day.id}>D{day.dayNumber}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <PlaceCard key={place.id} place={place} />)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/components/PlaceCard.tsx", [
    "import Link from 'next/link';",
    "import type { TripPlace } from '@/lib/demo-data';",
    "export function PlaceCard({ place }: { place: TripPlace }) {",
    "  const typeLabel = place.type === 'restaurant' ? '餐饮' : '景点';",
    "  return <article><Link href={`/place/${place.id}`}><img src={place.images[0]} alt={place.name} className=\"card-img\" loading=\"lazy\" /><h2>{place.name}</h2><p>{place.whyGo}</p><span>{typeLabel}</span></Link><button>收藏</button><button>编辑</button></article>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", [
    "export type TripPlace = { id: string; name: string; type: 'restaurant' | 'attraction'; images: string[]; whyGo: string; bestTime: string; transport: string; photoTip: string; nearby: string };",
    "export const places: TripPlace[] = Array.from({ length: 12 }, (_, index) => ({",
    "  id: `p-${index + 1}`,",
    "  name: ['静安寺','璞丽下午茶','巨鹿路','静安公园','豫园','南翔馒头店','外滩源','上海博物馆','武康路','老吉士','衡山坊','电影博物馆'][index],",
    "  type: index % 3 === 1 ? 'restaurant' : 'attraction',",
    "  images: [`/images/place-${index + 1}.jpg`, `/images/place-${index + 1}-detail.jpg`],",
    "  whyGo: '把建筑、餐饮和散步节奏串成一个明确停留理由。',",
    "  bestTime: '上午或傍晚光线最舒服。',",
    "  transport: '地铁加步行十分钟内可达。',",
    "  photoTip: '从街角低角度拍建筑线条。',",
    "  nearby: '附近有咖啡、书店和可休息的小广场。'",
    "}));",
    "export const days = [",
    "  { id: 'day-1', title: '静安寺与梧桐街区', dayNumber: 1, placeIds: ['p-1', 'p-2', 'p-3', 'p-4'], altPlaceIds: ['p-1', 'p-2', 'p-4'] },",
    "  { id: 'day-2', title: '外滩与豫园', dayNumber: 2, placeIds: ['p-5', 'p-6', 'p-7', 'p-8'], altPlaceIds: ['p-6', 'p-8', 'p-5'] },",
    "  { id: 'day-3', title: '武康路与老上海', dayNumber: 3, placeIds: ['p-9', 'p-10', 'p-11', 'p-12'], altPlaceIds: ['p-10', 'p-11', 'p-12'] }",
    "];",
  ].join("\n"));
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const visualSpecificity = audit.checks.find((check) => check.id === "travel-place-visual-specificity");
  assert.equal(visualSpecificity?.passed, true, visualSpecificity?.detail);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts embedded travel day place arrays with dynamic route lookups", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-embedded-places");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-embedded-places", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/day/[dayIndex]/page.tsx", [
    "import { getAllDays } from '@/lib/demo-data';",
    "export function generateStaticParams() { return getAllDays().map((day) => ({ dayIndex: String(day.dayId) })); }",
    "export default function DayPage({ params }: { params: { dayIndex: string } }) {",
    "  const days = getAllDays();",
    "  const day = days.find((item) => item.dayId === Number(params.dayIndex));",
    "  return <main><h1>{day?.title ?? '行程详情'}</h1><a href=\"/\">首页</a><button>雨天切换</button><button>收藏</button><section>{day?.places.map((place) => <article key={place.id}><h2>{place.name}</h2><p>{place.transport}</p><a href={`/places/${place.id}`}>地点详情</a></article>)}</section><p className=\"empty-state\">没有匹配行程时显示路线建议</p></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/places/[id]/page.tsx", [
    "import { allPlaces, getPlaceById } from '@/lib/demo-data';",
    "export function generateStaticParams() { return allPlaces.map((place) => ({ id: place.id })); }",
    "export default function PlacePage({ params }: { params: { id: string } }) {",
    "  const place = getPlaceById(params.id);",
    "  return <main><h1>{place?.name ?? '地点详情'}</h1><a href=\"/\">首页</a><button>收藏</button><button>标记必去</button><p>{place?.whyGo}</p><p>{place?.bestTime}</p><p>{place?.transport}</p><p>{place?.photoTip}</p><p>{place?.nearby}</p></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><article><h2>静安寺</h2><button>全部</button><button>筛选景点</button><button>移除</button><button>必去</button></article><article><h2>武康路</h2><button>筛选餐饮</button><button>移除</button><button>必去</button></article></main>; }\n");
  await sandbox.writeFile("src/app/budget/page.tsx", "export default function Budget() { return <main><h1>预算</h1><button>展开每日小计</button><p>餐饮 360</p><p>门票 210</p><p>交通 96</p></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; background: radial-gradient(circle at 20% 20%, #d6af62, transparent 20%), linear-gradient(#dfe8d8, #f7ead0); }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "import { tripDays } from '@/lib/demo-data';",
    "import { PlaceVisual } from './PlaceVisual';",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/favorites\">收藏</a><a href=\"/budget\">预算</a></nav><h1>沪上手帐旅行</h1><section>{tripDays.map((day) => <article key={day.id}><button aria-pressed={selectedDay === day.dayId} onClick={() => setSelectedDay(day.dayId)}>D{day.dayId}</button><a href={`/day/${day.dayId}`}>{day.title}</a>{day.places.map((place) => <article key={place.id}><PlaceVisual placeId={place.id} name={place.name} /><h2>{place.name}</h2><a href={`/places/${place.id}`}>查看详情</a><button>编辑</button></article>)}</article>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form><section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/components/PlaceVisual.tsx", [
    "const placeVisuals: Record<string, string> = { 'jingan-temple': '寺院金顶和梧桐', 'puli-tea': '露台茶盏', 'julu-road': '街角梧桐', 'jingan-park': '绿地长椅' };",
    "export function PlaceVisual({ placeId, name }: { placeId: string; name: string }) {",
    "  const label = placeVisuals[placeId] ?? name;",
    "  return <div role=\"img\" data-visual aria-label={`${name} ${label} 专属插画`} className=\"place-visual\"><svg><text>{label}</text></svg></div>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", [
    "export type TripPlace = { id: string; name: string; imageUrl: string; visualLabel: string; whyGo: string; bestTime: string; transport: string; photoTip: string; nearby: string; tags: string[] };",
    "export type TripDay = { id: string; dayId: number; title: string; places: TripPlace[]; rainyPlaceIds: string[] };",
    "export const tripDays = [",
    "  { id: 'day-1', dayId: 1, title: '静安梧桐线', rainyPlaceIds: ['jingan-temple', 'puli-tea', 'jingan-park'], places: [",
    "    { id: 'jingan-temple', name: '静安寺', imageUrl: '/images/jingan.svg', visualLabel: '金色寺檐', whyGo: '寺院和商圈并置的上海节奏。', bestTime: '上午九点', transport: '地铁二号线', photoTip: '从门楼斜侧拍金顶。', nearby: '久光百货', tags: ['temple', 'photo'] },",
    "    { id: 'puli-tea', name: '璞丽下午茶', imageUrl: '/images/puli.svg', visualLabel: '茶盏露台', whyGo: '给上午步行留一段慢休息。', bestTime: '下午两点', transport: '步行八分钟', photoTip: '靠窗拍茶具。', nearby: '静安公园', tags: ['tea', 'indoor'] },",
    "    { id: 'julu-road', name: '巨鹿路', imageUrl: '/images/julu.svg', visualLabel: '街角梧桐', whyGo: '适合把咖啡和小店串起来。', bestTime: '傍晚', transport: '骑行十五分钟', photoTip: '街角低角度。', nearby: '富民路', tags: ['street', 'walk'] },",
    "    { id: 'jingan-park', name: '静安公园', imageUrl: '/images/park.svg', visualLabel: '绿地长椅', whyGo: '行程里最适合停下来写手帐。', bestTime: '午后', transport: '步行五分钟', photoTip: '长椅和树影。', nearby: '南京西路', tags: ['park', 'rest'] }",
    "  ] },",
    "  { id: 'day-2', dayId: 2, title: '豫园外滩线', rainyPlaceIds: ['yuyuan-garden', 'nanxiang-bun', 'shanghai-museum'], places: [",
    "    { id: 'yuyuan-garden', name: '豫园', imageUrl: '/images/yuyuan.svg', visualLabel: '飞檐水榭', whyGo: '传统园林和老城厢故事密度高。', bestTime: '开园后', transport: '地铁十号线', photoTip: '九曲桥侧拍。', nearby: '城隍庙', tags: ['garden', 'history'] },",
    "    { id: 'nanxiang-bun', name: '南翔馒头店', imageUrl: '/images/bun.svg', visualLabel: '蒸笼小笼', whyGo: '把餐饮变成路线节点而非随便吃。', bestTime: '十一点前', transport: '步行三分钟', photoTip: '蒸汽逆光。', nearby: '豫园商城', tags: ['food', 'classic'] },",
    "    { id: 'bund-origin', name: '外滩源', imageUrl: '/images/bund.svg', visualLabel: '老楼街廓', whyGo: '从建筑尺度理解外滩。', bestTime: '下午四点', transport: '公交两站', photoTip: '街廓纵深。', nearby: '圆明园路', tags: ['architecture', 'walk'] },",
    "    { id: 'shanghai-museum', name: '上海博物馆', imageUrl: '/images/museum.svg', visualLabel: '青铜展厅', whyGo: '雨天也有足够文化内容。', bestTime: '预约上午场', transport: '地铁一号线', photoTip: '展厅局部。', nearby: '人民广场', tags: ['museum', 'indoor'] }",
    "  ] },",
    "  { id: 'day-3', dayId: 3, title: '衡复街区线', rainyPlaceIds: ['wukang-road', 'lao-jishi', 'film-museum'], places: [",
    "    { id: 'wukang-road', name: '武康路', imageUrl: '/images/wukang.svg', visualLabel: '红砖转角', whyGo: '梧桐和历史建筑最集中。', bestTime: '清晨', transport: '地铁十号线', photoTip: '转角广角。', nearby: '武康大楼', tags: ['street', 'photo'] },",
    "    { id: 'lao-jishi', name: '老吉士', imageUrl: '/images/laojishi.svg', visualLabel: '本帮菜桌', whyGo: '用晚餐收束街区漫步。', bestTime: '晚餐预约', transport: '步行十分钟', photoTip: '桌面俯拍。', nearby: '天平路', tags: ['food', 'reservation'] },",
    "    { id: 'hengshan-courtyard', name: '衡山坊', imageUrl: '/images/hengshan.svg', visualLabel: '院落灯光', whyGo: '街区里轻松补给点。', bestTime: '下午茶', transport: '骑行八分钟', photoTip: '院落灯串。', nearby: '衡山路', tags: ['cafe', 'rest'] },",
    "    { id: 'film-museum', name: '电影博物馆', imageUrl: '/images/film.svg', visualLabel: '胶片展墙', whyGo: '下雨时能保持路线完整。', bestTime: '下午三点', transport: '地铁加步行', photoTip: '胶片墙细节。', nearby: '徐家汇', tags: ['museum', 'rainy'] }",
    "  ] }",
    "] satisfies TripDay[];",
    "export const allPlaces = tripDays.flatMap((day) => day.places);",
    "export function getAllDays() { return tripDays; }",
    "export function getPlaceById(id: string) { return allPlaces.find((place) => place.id === id); }",
  ].join("\n"));
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const itineraryDepth = audit.checks.find((check) => check.id === "travel-itinerary-depth");
  assert.equal(itineraryDepth?.passed, true, itineraryDepth?.detail);
  assert.match(itineraryDepth?.detail ?? "", /default place counts=4, 4, 4/);
  const dynamicRoutes = audit.checks.find((check) => check.id === "travel-dynamic-route-contract");
  assert.equal(dynamicRoutes?.passed, true, dynamicRoutes?.detail);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts referenced travel place arrays with numeric day routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-referenced-places");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-referenced-places", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/itinerary/[dayId]/page.tsx", [
    "import { days } from '@/lib/server-data';",
    "import ItineraryClient from '../ItineraryClient';",
    "export default function ItineraryDayPage({ params }: { params: { dayId: string } }) {",
    "  const dayId = parseInt(params.dayId, 10);",
    "  const validDay = !isNaN(dayId) && dayId >= 1 && dayId <= 3 ? dayId : 1;",
    "  return <ItineraryClient days={days} initialDay={validDay} />;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/itinerary/ItineraryClient.tsx", "import type { Day } from '@/lib/types';\nexport default function ItineraryClient({ days, initialDay }: { days: Day[]; initialDay: number }) { return <main><h1>每日行程</h1><a href=\"/\">首页</a><button>雨天切换</button><button>收藏</button>{days.map((day) => <article key={day.id}>{day.id === initialDay ? '当前' : ''}<h2>{day.title}</h2>{day.defaultPlaces.map((place) => <a key={place.id} href={`/place/${place.id}`}>{place.name}</a>)}</article>)}</main>; }\n");
  await sandbox.writeFile("src/app/place/[id]/page.tsx", [
    "import Link from 'next/link';",
    "import { findPlaceById } from '@/lib/server-data';",
    "import PlaceDetailPageClient from './PlaceDetailPageClient';",
    "export default function PlacePage({ params }: { params: { id: string } }) {",
    "  const place = findPlaceById(params.id);",
    "  if (!place) return <main><Link href=\"/itinerary\">返回行程</Link><p>没有匹配地点</p><button>收藏</button></main>;",
    "  return <PlaceDetailPageClient place={place} />;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/place/[id]/PlaceDetailPageClient.tsx", "import type { Place } from '@/lib/types';\nexport default function PlaceDetailPageClient({ place }: { place: Place }) { return <main><h1>{place.name}</h1><a href=\"/itinerary\">返回行程</a><button>收藏</button><button>标记必去</button><p>{place.description}</p><p>{place.tips}</p><p>{place.duration}</p><p>{place.bestTime}</p><p>{place.transport}</p><p>{place.nearby}</p><p>{place.imageAlt}</p><div role=\"img\" data-visual aria-label={`${place.name} ${place.visualLabel} 插画`}>{place.visualLabel}</div></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><article><h2>静安寺</h2><button>全部</button><button>筛选景点</button><button>移除</button><button>必去</button></article><article><h2>武康路</h2><button>筛选餐饮</button><button>移除</button><button>必去</button></article></main>; }\n");
  await sandbox.writeFile("src/app/budget/page.tsx", "export default function Budget() { return <main><h1>预算</h1><button>展开每日小计</button><p>餐饮 360</p><p>门票 210</p><p>交通 96</p></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; background: linear-gradient(#dfe8d8, #f7ead0); }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "import { days } from '@/lib/data';",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/favorites\">收藏</a><a href=\"/budget\">预算</a></nav><h1>沪上手帐旅行</h1><section>{days.map((day) => <article key={day.id}><button aria-pressed={selectedDay === day.id} onClick={() => setSelectedDay(day.id)}>D{day.id}</button><a href={`/itinerary/${day.id}`}>{day.title}</a>{day.defaultPlaces.map((place) => <article key={place.id}><div role=\"img\" data-visual aria-label={`${place.name} ${place.visualLabel} 专属插画`}>{place.visualLabel}</div><h2>{place.name}</h2><a href={`/place/${place.id}`}>查看详情</a><button>编辑</button></article>)}</article>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form><section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/itinerary/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/types.ts", "export interface Place { id: string; name: string; type: 'attraction' | 'restaurant'; district: string; description: string; budget: number; duration: string; tips: string; bestTime: string; transport: string; nearby: string; imageAlt: string; visualLabel: string; }\nexport interface Day { id: number; title: string; date: string; weather: 'sunny' | 'rainy'; defaultPlaces: Place[]; alternatePlaces: Place[]; }\n");
  await sandbox.writeFile("src/lib/server-data.ts", "import { days, budgetItems, findPlaceById, getAllPlaces } from './data';\nexport { days, budgetItems, findPlaceById, getAllPlaces };\nexport function getDayById(id: number) { return days.find((day) => day.id === id) ?? null; }\n");
  await sandbox.writeFile("src/lib/data.ts", [
    "import type { Day, Place } from './types';",
    "const placeBase = { district: '静安', description: '路线里的重点地点，有明确停留理由和城市氛围。', budget: 60, duration: '1 小时', tips: '建议错峰前往，适合拍照和休息。', bestTime: '上午九点或傍晚五点', transport: '地铁加步行十分钟', nearby: '附近有咖啡馆和可休息街角', imageAlt: '现场照片', visualLabel: '专属视觉' };",
    "const day1places: Place[] = [{ ...placeBase, id: 'jingan-temple', name: '静安寺', type: 'attraction' }, { ...placeBase, id: 'kumara', name: 'Kumara', type: 'restaurant' }, { ...placeBase, id: 'shanghai-library', name: '上海图书馆', type: 'attraction' }, { ...placeBase, id: 'la-creperie', name: 'La Creperie', type: 'restaurant' }];",
    "const day1alt: Place[] = [{ ...placeBase, id: 'reel-mall', name: '芮欧百货', type: 'attraction' }, { ...placeBase, id: 'smaka', name: 'SMaka', type: 'restaurant' }];",
    "const day2places: Place[] = [{ ...placeBase, id: 'the-bund', name: '外滩', type: 'attraction' }, { ...placeBase, id: 'de-da-lu', name: '德大西菜社', type: 'restaurant' }, { ...placeBase, id: 'yu-garden', name: '豫园', type: 'attraction' }, { ...placeBase, id: 'old-jiang', name: '老吉士', type: 'restaurant' }];",
    "const day2alt: Place[] = [{ ...placeBase, id: 'shanghai-museum', name: '上海博物馆', type: 'attraction' }, { ...placeBase, id: 'drizzle-cafe', name: 'Drizzle 咖啡', type: 'restaurant' }];",
    "const day3places: Place[] = [{ ...placeBase, id: 'wukang-road', name: '武康路', type: 'attraction' }, { ...placeBase, id: 'sunshine-coffee', name: 'Sunshine Coffee', type: 'restaurant' }, { ...placeBase, id: 'xuhui-riverside', name: '徐汇滨江', type: 'attraction' }, { ...placeBase, id: 'lost-heaven', name: '花马天堂', type: 'restaurant' }];",
    "const day3alt: Place[] = [{ ...placeBase, id: 'power-long-museum', name: '余德耀美术馆', type: 'attraction' }, { ...placeBase, id: 'wenheyou', name: '文和友', type: 'restaurant' }];",
    "export const days: Day[] = [",
    "  { id: 1, title: '第一天', date: '10月3日', weather: 'sunny', defaultPlaces: day1places, alternatePlaces: day1alt },",
    "  { id: 2, title: '第二天', date: '10月4日', weather: 'sunny', defaultPlaces: day2places, alternatePlaces: day2alt },",
    "  { id: 3, title: '第三天', date: '10月5日', weather: 'sunny', defaultPlaces: day3places, alternatePlaces: day3alt },",
    "];",
    "export const budgetItems = [{ category: '餐饮', amount: 120, day: 1 }];",
    "const allPlaces = days.flatMap((day) => [...day.defaultPlaces, ...day.alternatePlaces]);",
    "export function findPlaceById(id: string) { return allPlaces.find((place) => place.id === id); }",
    "export function getAllPlaces() { return days.flatMap((day) => [...day.defaultPlaces, ...day.alternatePlaces]); }",
  ].join("\n"));
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const itineraryDepth = audit.checks.find((check) => check.id === "travel-itinerary-depth");
  assert.equal(itineraryDepth?.passed, true, itineraryDepth?.detail);
  assert.match(itineraryDepth?.detail ?? "", /default place counts=4, 4, 4/);
  assert.match(itineraryDepth?.detail ?? "", /alternate place counts=2, 2, 2/);
  const dynamicRoutes = audit.checks.find((check) => check.id === "travel-dynamic-route-contract");
  assert.equal(dynamicRoutes?.passed, true, dynamicRoutes?.detail);
  assert.match(dynamicRoutes?.detail ?? "", /day ids=1, 2, 3/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts assignment-based travel place visual maps", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-assignment-visuals");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-assignment-visuals", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/trips/[day]/page.tsx", "export default function DayPage() { return <main><h1>行程详情</h1><a href=\"/\">首页</a><a href=\"/places/jingan-temple\">地点</a><button>雨天切换</button></main>; }\n");
  await sandbox.writeFile("src/app/places/[id]/page.tsx", "import { places } from '@/lib/demo-data';\nimport { PlaceVisual } from '@/components/PlaceVisual';\nexport default function PlacePage({ params }: { params: { id: string } }) { const place = places.find((item) => item.id === params.id) ?? places[0]; return <main><h1>{place.name}</h1><PlaceVisual placeId={place.id} name={place.name} /><p>{place.whyGo}</p><p>{place.bestTime}</p><p>{place.transport}</p><p>{place.photoTip}</p><button>收藏</button><button>标记必去</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "import { places } from '@/lib/demo-data';\nexport default function Favorites() { return <main><h1>收藏地点</h1><button>全部</button><button>景点</button><button>餐饮</button><button>必去</button>{places.slice(0, 2).map((place) => <article key={place.id}><h2>{place.name}</h2><button>移除</button></article>)}</main>; }\n");
  await sandbox.writeFile("src/app/budget/page.tsx", "export default function Budget() { return <main><h1>预算</h1><p>每人预算 360</p><p>双人合计 720</p><button>展开每日小计</button></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n.scroll-x { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; }\n.place-visual { width: 140px; height: 90px; }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "import { days, places } from '@/lib/demo-data';",
    "import { PlaceVisual } from './PlaceVisual';",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/trips/1\">行程</a><a href=\"/favorites\">收藏</a><a href=\"/budget\">预算</a></nav><h1>沪上手帐旅行</h1><section className=\"scroll-x\">{days.map((day) => <article key={day.day}><button aria-pressed={selectedDay === day.day} onClick={() => setSelectedDay(day.day)}>D{day.day}</button>{places.slice(0, 4).map((place) => <article key={place.id}><PlaceVisual placeId={place.id} name={place.name} /><h2>{place.name}</h2><a href={`/places/${place.id}`}>查看详情</a><button>收藏</button></article>)}</article>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选餐饮</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form><section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/components/PlaceVisual.tsx", [
    "import type { ReactElement } from 'react';",
    "type SvgProps = { name: string };",
    "const svgComponents: Record<string, (props: SvgProps) => ReactElement> = {};",
    "svgComponents['jingan-temple'] = ({ name }) => <div role=\"img\" data-visual aria-label={`${name} 静安寺金顶插画`} className=\"place-visual\" />;",
    "svgComponents['nanjing-road'] = ({ name }) => <div role=\"img\" data-visual aria-label={`${name} 南京西路橱窗插画`} className=\"place-visual\" />;",
    "svgComponents['the-bund'] = ({ name }) => <div role=\"img\" data-visual aria-label={`${name} 外滩晨光插画`} className=\"place-visual\" />;",
    "svgComponents['wukang-road'] = ({ name }) => <div role=\"img\" data-visual aria-label={`${name} 武康路梧桐插画`} className=\"place-visual\" />;",
    "export function PlaceVisual({ placeId, name }: { placeId: string; name: string }) { const Visual = svgComponents[placeId] ?? svgComponents['jingan-temple']; return <Visual name={name} />; }",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", [
    "export type TripPlace = { id: string; name: string; visualLabel: string; whyGo: string; bestTime: string; transport: string; photoTip: string; nearby: string; budget: number };",
    "export const places: TripPlace[] = [",
    "  { id: 'jingan-temple', name: '静安寺', visualLabel: '金顶', whyGo: '住宿附近低压力起点。', bestTime: '上午', transport: '地铁二号线', photoTip: '寺前广场', nearby: '久光百货', budget: 50 },",
    "  { id: 'nanjing-road', name: '南京西路', visualLabel: '橱窗', whyGo: '商圈散步自然衔接。', bestTime: '傍晚', transport: '步行', photoTip: '街角橱窗', nearby: '张园', budget: 0 },",
    "  { id: 'the-bund', name: '外滩', visualLabel: '晨光', whyGo: '建筑群记忆点强。', bestTime: '清晨', transport: '地铁十号线', photoTip: '江岸', nearby: '外滩源', budget: 0 },",
    "  { id: 'wukang-road', name: '武康路', visualLabel: '梧桐', whyGo: '衡复街区文艺核心。', bestTime: '下午', transport: '地铁十号线', photoTip: '转角', nearby: '武康大楼', budget: 0 }",
    "];",
    "export const days = [",
    "  { day: 1, placeIds: ['jingan-temple', 'nanjing-road', 'the-bund', 'wukang-road'], rainyPlaceIds: ['jingan-temple', 'nanjing-road'] },",
    "  { day: 2, placeIds: ['the-bund', 'jingan-temple', 'nanjing-road', 'wukang-road'], rainyPlaceIds: ['the-bund', 'jingan-temple'] },",
    "  { day: 3, placeIds: ['wukang-road', 'the-bund', 'jingan-temple', 'nanjing-road'], rainyPlaceIds: ['wukang-road', 'the-bund'] }",
    "];",
  ].join("\n"));
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const visualSpecificity = audit.checks.find((check) => check.id === "travel-place-visual-specificity");
  assert.equal(visualSpecificity?.passed, true, visualSpecificity?.detail);
  assert.match(visualSpecificity?.detail ?? "", /per-place visual branches=4/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts plural trips dynamic routes with day fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-plural-routes");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-plural-routes", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", [
    "import { dayPlans, getPlacesByIds } from '@/lib/demo-data';",
    "export default function Page() {",
    "  return <main><h1>沪上手帐旅行</h1><nav><a href=\"/favorites\">收藏</a><a href=\"/budget\">预算</a></nav>{dayPlans.map((day) => <article key={day.day}><a href={`/trips/${day.day}`}>Day {day.day}</a>{getPlacesByIds(day.placeIds).map((place) => <article key={place.id}><div role=\"img\" data-visual aria-label={`${place.name} ${place.visualLabel}`}>{place.visualLabel}</div><h2>{place.name}</h2><a href={`/places/${place.id}`}>地点详情</a><button>收藏</button></article>)}</article>)}</main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/trips/[day]/page.tsx", [
    "import Link from 'next/link';",
    "import { dayPlans, getPlacesByIds, getRainyPlacesForDay } from '@/lib/demo-data';",
    "export function generateStaticParams() { return [{ day: '1' }, { day: '2' }, { day: '3' }]; }",
    "export default function DayDetailPage({ params }: { params: { day: string } }) {",
    "  const dayNumber = parseInt(params.day, 10);",
    "  const plan = dayPlans.find((candidate) => candidate.day === dayNumber) ?? dayPlans[0];",
    "  const sunnyPlaces = getPlacesByIds(plan.placeIds);",
    "  const rainyPlaces = getRainyPlacesForDay(plan.day);",
    "  return <main><Link href=\"/trips\">返回行程总览</Link><h1>Day {plan.day} · {plan.title}</h1><section>{sunnyPlaces.map((place) => <article key={place.id}><h2>{place.name}</h2><p>{place.longDescription}</p><a href={`/places/${place.id}`}>地点详情</a></article>)}</section><section>{rainyPlaces.map((place) => <article key={place.id}><h2>{place.name}</h2><p>{place.longDescription}</p></article>)}</section><nav>{[1, 2, 3].map((day) => <Link key={day} href={`/trips/${day}`}>Day {day}</Link>)}</nav></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/places/[placeId]/page.tsx", [
    "import { places } from '@/lib/demo-data';",
    "export function generateStaticParams() { return places.map((place) => ({ placeId: place.id })); }",
    "export default function PlacePage({ params }: { params: { placeId: string } }) {",
    "  const place = places.find((candidate) => candidate.id === params.placeId);",
    "  return <main><h1>{place?.name ?? '地点详情'}</h1><button>收藏</button><button>标记必去</button><p>{place?.longDescription}</p><p>{place?.openingHours}</p><p>{place?.address}</p><p>{place?.timeRequired}</p><div role=\"img\" data-visual aria-label={`${place?.name ?? '地点'} 专属视觉`}>{place?.visualLabel}</div></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/trips/page.tsx", "import { dayPlans } from '@/lib/demo-data';\nexport default function TripsPage() { return <main><h1>按天行程</h1>{dayPlans.map((day) => <article key={day.day}><a href={`/trips/${day.day}`}>完整详情</a><button>雨天路线</button><button>晴天路线</button></article>)}</main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><article><h2>静安寺</h2><button>全部</button><button>筛选景点</button><button>移除</button><button>必去</button></article><article><h2>武康路</h2><button>筛选餐饮</button><button>移除</button><button>必去</button></article></main>; }\n");
  await sandbox.writeFile("src/app/budget/page.tsx", "export default function Budget() { return <main><h1>预算</h1><button>展开每日小计</button><p>餐饮 360</p><p>门票 210</p><p>交通 96</p></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\nbutton:focus-visible { outline: 2px solid red; }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", [
    "export type Place = { id: string; name: string; visualLabel: string; longDescription: string; openingHours: string; address: string; timeRequired: string; cost: number };",
    "export const places: Place[] = [",
    "  { id: 'jingan-temple', name: '静安寺', visualLabel: '金色寺檐', longDescription: '寺院和商圈并置的上海节奏。', openingHours: '07:30-17:00', address: '静安区南京西路1686号', timeRequired: '1.5小时', cost: 50 },",
    "  { id: 'jiuguang-department', name: '久光百货', visualLabel: '现代商场', longDescription: '静安商圈精致购物体验。', openingHours: '10:00-22:00', address: '静安区南京西路1618号', timeRequired: '1小时', cost: 0 },",
    "  { id: 'xiaoyang-shengjian', name: '小杨生煎', visualLabel: '生煎蒸汽', longDescription: '地道上海生煎体验。', openingHours: '07:00-21:00', address: '静安区久光百货B1', timeRequired: '0.5小时', cost: 30 },",
    "  { id: 'cafe-strada', name: 'Café Strada', visualLabel: '咖啡暖灯', longDescription: '适合午后写手帐。', openingHours: '08:00-20:00', address: '静安区华山路228号', timeRequired: '1小时', cost: 65 },",
    "  { id: 'shanghai-museum-natural', name: '上海自然博物馆', visualLabel: '恐龙骨架', longDescription: '雨天室内探索。', openingHours: '09:00-17:00', address: '静安区北京西路510号', timeRequired: '3小时', cost: 30 },",
    "  { id: 'the-bund', name: '外滩', visualLabel: '浦江天际线', longDescription: '百年建筑与黄浦江。', openingHours: '全天开放', address: '黄浦区中山东一路', timeRequired: '2小时', cost: 0 },",
    "  { id: 'yuyuan-garden', name: '豫园', visualLabel: '江南亭台', longDescription: '明代园林和九曲桥。', openingHours: '09:00-16:30', address: '黄浦区豫园老街279号', timeRequired: '2小时', cost: 40 },",
    "  { id: 'nanxiang-mantou', name: '南翔馒头店', visualLabel: '小笼蒸笼', longDescription: '蟹粉小笼老店。', openingHours: '08:00-20:00', address: '黄浦区豫园路85号', timeRequired: '0.5小时', cost: 50 },",
    "  { id: 'peace-hotel-tea', name: '和平饭店下午茶', visualLabel: '老上海下午茶', longDescription: '外滩传奇建筑内的下午茶。', openingHours: '14:00-17:00', address: '黄浦区南京东路20号', timeRequired: '2小时', cost: 298 },",
    "  { id: 'wukang-road', name: '武康路', visualLabel: '梧桐街角', longDescription: '衡复街区文艺漫步。', openingHours: '全天开放', address: '徐汇区武康路', timeRequired: '2小时', cost: 0 },",
    "  { id: 'shanghai-library', name: '上海图书馆', visualLabel: '阅读大厅', longDescription: '舒适阅读和城市天际线。', openingHours: '09:00-20:30', address: '徐汇区淮海中路1555号', timeRequired: '1.5小时', cost: 0 },",
    "  { id: 'laojishi', name: '老吉士', visualLabel: '本帮菜桌', longDescription: '本帮菜馆和红烧肉。', openingHours: '11:00-21:30', address: '徐汇区天平路41号', timeRequired: '1.5小时', cost: 120 },",
    "  { id: 'arabica-coffee', name: '% Arabica', visualLabel: '咖啡拉花', longDescription: '武康路转角咖啡。', openingHours: '09:00-20:00', address: '徐汇区武康路378号', timeRequired: '0.5小时', cost: 45 }",
    "];",
    "export const dayPlans = [",
    "  { day: 1, title: '静安寺慢游', placeIds: ['jingan-temple', 'jiuguang-department', 'xiaoyang-shengjian', 'cafe-strada'], rainyPlaceIds: ['shanghai-museum-natural', 'jiuguang-department', 'xiaoyang-shengjian', 'cafe-strada'] },",
    "  { day: 2, title: '外滩豫园线', placeIds: ['the-bund', 'yuyuan-garden', 'nanxiang-mantou', 'peace-hotel-tea'], rainyPlaceIds: ['yuyuan-garden', 'nanxiang-mantou', 'peace-hotel-tea', 'shanghai-museum-natural'] },",
    "  { day: 3, title: '武康路街区', placeIds: ['wukang-road', 'shanghai-library', 'laojishi', 'arabica-coffee'], rainyPlaceIds: ['shanghai-library', 'laojishi', 'arabica-coffee', 'shanghai-museum-natural'] }",
    "];",
    "export function getPlacesByIds(ids: string[]) { return ids.map((id) => places.find((place) => place.id === id)).filter(Boolean) as Place[]; }",
    "export function getRainyPlacesForDay(day: number) { return getPlacesByIds(dayPlans.find((plan) => plan.day === day)?.rainyPlaceIds ?? []); }",
  ].join("\n"));

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const dynamicRoutes = audit.checks.find((check) => check.id === "travel-dynamic-route-contract");
  assert.equal(dynamicRoutes?.passed, true, dynamicRoutes?.detail);
  assert.match(dynamicRoutes?.detail ?? "", /day routes=1/);
  assert.match(dynamicRoutes?.detail ?? "", /day ids=1, 2, 3/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts sun/rain travel place arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-sun-rain-arrays");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-sun-rain-arrays", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", [
    "import { days, getPlacesByIds } from '@/lib/data';",
    "export default function Page() {",
    "  return <main><h1>沪上手帐旅行</h1><nav><a href=\"/day/day-1\">行程</a><a href=\"/favorites\">收藏</a></nav>{days.map((day) => <article key={day.id}><a href={`/day/${day.id}`}>Day {day.day}</a>{getPlacesByIds(day.placesSun).map((place) => <article key={place.id}><div role=\"img\" data-visual aria-label={`${place.name} ${place.visualLabel}`}>{place.visualLabel}</div><h2>{place.name}</h2><a href={`/place/${place.id}`}>地点详情</a><button>收藏</button></article>)}</article>)}</main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/day/[dayId]/page.tsx", [
    "import { days, getPlacesByIds } from '@/lib/data';",
    "export function generateStaticParams() { return days.map((day) => ({ dayId: day.id })); }",
    "export default function DayPage({ params }: { params: { dayId: string } }) {",
    "  const day = days.find((item) => item.id === params.dayId) ?? days[0];",
    "  return <main><h1>Day {day.day}</h1><button>晴天路线</button><button>雨天路线</button>{getPlacesByIds(day.placesRain).map((place) => <article key={place.id}><h2>{place.name}</h2><p>{place.whyGo}</p><a href={`/place/${place.id}`}>详情</a></article>)}</main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/place/[placeId]/page.tsx", [
    "import { places } from '@/lib/data';",
    "export function generateStaticParams() { return places.map((place) => ({ placeId: place.id })); }",
    "export default function PlacePage({ params }: { params: { placeId: string } }) {",
    "  const place = places.find((item) => item.id === params.placeId);",
    "  return <main><h1>{place?.name ?? '地点详情'}</h1><button>收藏</button><button>标记必去</button><p>{place?.whyGo}</p><p>{place?.bestTime}</p><p>{place?.transport}</p><p>{place?.nearby}</p><p>{place?.rainyTip}</p><div role=\"img\" data-visual aria-label={`${place?.name ?? '地点'} 专属视觉`}>{place?.visualLabel}</div></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><article><h2>静安寺</h2><button>全部</button><button>筛选景点</button><button>移除</button><button>必去</button></article><article><h2>武康路</h2><button>筛选餐饮</button><button>移除</button><button>必去</button></article></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/app/api/places/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readSavedPlaces() { try { return localStorage.getItem('places') ?? ''; } catch { return ''; } }\n");
  await sandbox.writeFile("src/lib/data.ts", [
    "export type Place = { id: string; name: string; visualLabel: string; whyGo: string; bestTime: string; transport: string; nearby: string; rainyTip: string };",
    "export type TripDay = { id: string; day: number; placesSun: string[]; placesRain: string[]; alternateIds: string[] };",
    "export const places: Place[] = Array.from({ length: 12 }, (_, index) => ({ id: `place-${index + 1}`, name: `上海地点${index + 1}`, visualLabel: `地点${index + 1} 专属插画`, whyGo: '真实路线节点和明确停留理由。', bestTime: '上午或傍晚', transport: '地铁加步行', nearby: '咖啡和街区', rainyTip: '雨天也有室内备选。' }));",
    "export const days: TripDay[] = [",
    "  { id: 'day-1', day: 1, placesSun: ['place-1', 'place-2', 'place-3', 'place-4'], placesRain: ['place-5', 'place-6', 'place-7'], alternateIds: ['place-5', 'place-6'] },",
    "  { id: 'day-2', day: 2, placesSun: ['place-5', 'place-6', 'place-7', 'place-8'], placesRain: ['place-1', 'place-9', 'place-10'], alternateIds: ['place-9', 'place-10'] },",
    "  { id: 'day-3', day: 3, placesSun: ['place-9', 'place-10', 'place-11', 'place-12'], placesRain: ['place-2', 'place-3', 'place-4'], alternateIds: ['place-2', 'place-3'] }",
    "];",
    "export function getPlacesByIds(ids: string[]) { return ids.map((id) => places.find((place) => place.id === id)).filter(Boolean) as Place[]; }",
  ].join("\n"));

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const itineraryDepth = audit.checks.find((check) => check.id === "travel-itinerary-depth");
  assert.equal(itineraryDepth?.passed, true, itineraryDepth?.detail);
  assert.match(itineraryDepth?.detail ?? "", /default place counts=4, 4, 4/);
  assert.match(itineraryDepth?.detail ?? "", /alternate place counts=.*3, 2, 3, 2, 3, 2/);
  const dynamicRoutes = audit.checks.find((check) => check.id === "travel-dynamic-route-contract");
  assert.equal(dynamicRoutes?.passed, true, dynamicRoutes?.detail);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit accepts activity-based travel itineraries with activity detail routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-activity-routes");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-activity-routes", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Activity Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", [
    "import { defaultItineraries, getActivityById } from '@/lib/demo-data';",
    "export default function Page() {",
    "  return <main><h1>上海三日旅行</h1><nav><a href=\"/favorites\">收藏</a><a href=\"/budget\">预算</a></nav>{defaultItineraries.map((day) => <article key={day.dayNumber}><a href={`/day/${day.dayNumber}`}>Day {day.dayNumber}</a>{day.activityIds.map((id) => { const activity = getActivityById(id); return activity ? <article key={activity.id}><div role=\"img\" data-visual aria-label={`${activity.nameZh} ${activity.visualLabel}`}>{activity.visualLabel}</div><h2>{activity.nameZh}</h2><a href={`/activity/${activity.id}`}>活动详情</a><button>收藏</button></article> : null; })}</article>)}</main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/day/[dayId]/page.tsx", [
    "import { defaultItineraries, getActivityById } from '@/lib/demo-data';",
    "export function generateStaticParams() { return defaultItineraries.map((day) => ({ dayId: String(day.dayNumber) })); }",
    "export default function DayPage({ params }: { params: { dayId: string } }) {",
    "  const day = defaultItineraries.find((item) => item.dayNumber === Number(params.dayId));",
    "  return <main><h1>Day {day?.dayNumber ?? 1} 行程</h1><a href=\"/\">首页</a><button>雨天切换</button><button>收藏</button>{day?.activityIds.map((id) => { const activity = getActivityById(id); return activity ? <article key={activity.id}><h2>{activity.nameZh}</h2><p>{activity.transport}</p><a href={`/activity/${activity.id}`}>活动详情</a></article> : null; })}</main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/activity/[activityId]/page.tsx", [
    "import { activities, getActivityById } from '@/lib/demo-data';",
    "export function generateStaticParams() { return activities.map((activity) => ({ activityId: activity.id })); }",
    "export default function ActivityPage({ params }: { params: { activityId: string } }) {",
    "  const activity = getActivityById(params.activityId);",
    "  return <main><h1>{activity?.nameZh ?? '活动详情'}</h1><a href=\"/\">首页</a><button>收藏</button><button>标记必去</button><p>{activity?.description}</p><p>{activity?.bestTime}</p><p>{activity?.transport}</p><p>{activity?.photoTip}</p><p>{activity?.nearby}</p><div role=\"img\" data-visual aria-label={`${activity?.nameZh ?? '上海活动'} 专属视觉`}>{activity?.visualLabel}</div></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏活动</h1><article><h2>静安寺</h2><button>全部</button><button>筛选景点</button><button>移除</button><button>必去</button></article><article><h2>外滩</h2><button>筛选餐饮</button><button>移除</button><button>必去</button></article></main>; }\n");
  await sandbox.writeFile("src/app/budget/page.tsx", "export default function Budget() { return <main><h1>预算</h1><button>展开每日小计</button><p>餐饮 360</p><p>门票 210</p><p>交通 96</p></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "ActivityCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/activities/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", [
    "export type Activity = { id: string; nameZh: string; category: string; pricePerPerson: number; duration: number; description: string; bestTime: string; transport: string; photoTip: string; nearby: string; visualLabel: string };",
    "export const activities: Activity[] = Array.from({ length: 12 }, (_, index) => ({",
    "  id: `a${index + 1}`,",
    "  nameZh: ['老吉士','Manner Coffee','外滩','% Arabica','Chikalicious','西岸美术馆','武康路','上海博物馆','人和馆','龙美术馆','新天地','Polly 咖啡'][index],",
    "  category: ['local_cuisine','coffee','landmark','coffee','dessert','museum','landmark','museum','local_cuisine','museum','landmark','coffee'][index],",
    "  pricePerPerson: 80 + index * 5,",
    "  duration: 60 + index * 5,",
    "  description: '上海行程里的重点停留，包含餐饮、街区、博物馆和拍照节奏。',",
    "  bestTime: '上午或傍晚光线最舒服。',",
    "  transport: '地铁加步行十分钟可达。',",
    "  photoTip: '从街角低角度拍建筑线条。',",
    "  nearby: '附近有咖啡、书店和可休息的小广场。',",
    "  visualLabel: `上海活动 ${index + 1} 专属视觉`,",
    "}));",
    "export const defaultItineraries = [",
    "  { dayNumber: 1, activityIds: ['a1', 'a2', 'a3', 'a4'] },",
    "  { dayNumber: 2, activityIds: ['a5', 'a6', 'a7', 'a8'] },",
    "  { dayNumber: 3, activityIds: ['a9', 'a10', 'a11', 'a12'] },",
    "];",
    "export function getActivityById(id: string) { return activities.find((activity) => activity.id === id); }",
  ].join("\n"));
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const itineraryDepth = audit.checks.find((check) => check.id === "travel-itinerary-depth");
  assert.equal(itineraryDepth?.passed, true, itineraryDepth?.detail);
  assert.match(itineraryDepth?.detail ?? "", /default place counts=4, 4, 4/);
  const dynamicRoutes = audit.checks.find((check) => check.id === "travel-dynamic-route-contract");
  assert.equal(dynamicRoutes?.passed, true, dynamicRoutes?.detail);
  assert.match(dynamicRoutes?.detail ?? "", /place routes=1/);
  assert.match(dynamicRoutes?.detail ?? "", /place lookups=[1-9]/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit blocks travel place cards that read stale cost aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-cost-field-mismatch");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-cost-field-mismatch", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/day/[dayId]/page.tsx", "export default function DayPage() { return <main><h1>行程详情</h1><a href=\"/\">首页</a><button>雨天切换</button><button>收藏</button></main>; }\n");
  await sandbox.writeFile("src/app/place/[placeId]/page.tsx", "export default function PlacePage() { return <main><h1>地点详情</h1><a href=\"/\">首页</a><button>收藏</button><button>标记必去</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><article><h2>静安寺</h2><button>筛选景点</button><button>移除</button><button>必去</button></article><article><h2>武康路</h2><button>筛选餐饮</button><button>移除</button><button>必去</button></article></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; background: radial-gradient(circle at 20% 20%, #d6af62, transparent 20%), linear-gradient(#dfe8d8, #f7ead0); }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "import { days, places } from '@/lib/demo-data';",
    "import { PlaceVisual } from './PlaceVisual';",
    "import { PlaceCard } from './PlaceCard';",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/day/day-1\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{days.map((day) => <button aria-pressed={selectedDay === day.dayNumber} onClick={() => setSelectedDay(day.dayNumber)} key={day.id}>D{day.dayNumber}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <article key={place.id}><PlaceVisual placeId={place.id} name={place.name} /><PlaceCard place={place} /><a href={`/place/${place.id}`}>查看详情</a><button>编辑</button></article>)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/components/PlaceCard.tsx", "export function PlaceCard({ place }: { place: { name: string; costPerPerson: number } }) { return <p>人均 ¥{place.cost}</p>; }\n");
  await sandbox.writeFile("src/components/PlaceVisual.tsx", [
    "const placeVisuals: Record<string, string> = { 'p-1': '寺院金顶和梧桐', 'p-2': '露台咖啡杯', 'p-3': '豫园屋檐', 'p-4': '小笼蒸笼' };",
    "export function PlaceVisual({ placeId, name }: { placeId: string; name: string }) {",
    "  const label = placeVisuals[placeId] ?? name;",
    "  return <div role=\"img\" data-visual aria-label={`${name} ${label} 专属插画`} className=\"place-visual\"><svg><text>{label}</text></svg></div>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", [
    "export type TripPlace = { id: string; name: string; imageUrl: string; visualLabel: string; costPerPerson: number; whyGo: string; bestTime: string; transport: string; photoTip: string; nearby: string };",
    "export const places = Array.from({ length: 12 }, (_, index) => ({",
    "  id: `p-${index + 1}`, name: `上海地点${index + 1}`, imageUrl: `/images/place-${index + 1}.svg`, visualLabel: `专属插画${index + 1}`, costPerPerson: 120, whyGo: '明确停留理由。', bestTime: '上午。', transport: '地铁。', photoTip: '街角拍摄。', nearby: '咖啡店。'",
    "}));",
    "export const days = [",
    "  { id: 'day-1', dayNumber: 1, placeIds: ['p-1', 'p-2', 'p-3', 'p-4'], altPlaceIds: ['p-1', 'p-2', 'p-4'] },",
    "  { id: 'day-2', dayNumber: 2, placeIds: ['p-5', 'p-6', 'p-7', 'p-8'], altPlaceIds: ['p-6', 'p-8', 'p-5'] },",
    "  { id: 'day-3', dayNumber: 3, placeIds: ['p-9', 'p-10', 'p-11', 'p-12'], altPlaceIds: ['p-10', 'p-11', 'p-12'] }",
    "];",
  ].join("\n"));
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const costFields = audit.checks.find((check) => check.id === "travel-cost-field-consistency");
  assert.equal(costFields?.passed, false);
  assert.match(costFields?.detail ?? "", /\.cost accesses=place\.cost/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit blocks travel place details that read undeclared place fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-place-field-contract");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-place-field-contract", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/day/[dayId]/page.tsx", "export default function DayPage() { return <main><h1>行程详情</h1><a href=\"/\">首页</a><button>雨天切换</button><button>收藏</button></main>; }\n");
  await sandbox.writeFile("src/app/place/[placeId]/page.tsx", "import { places } from '@/lib/demo-data';\nimport { PlaceDetail } from '@/components/PlaceDetail';\nexport default function PlacePage() { return <PlaceDetail place={places[0]} />; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><article><h2>静安寺</h2><button>筛选景点</button><button>移除</button><button>必去</button></article><article><h2>武康路</h2><button>筛选餐饮</button><button>移除</button><button>必去</button></article></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; background: radial-gradient(circle at 20% 20%, #d6af62, transparent 20%), linear-gradient(#dfe8d8, #f7ead0); }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/types.ts", "export interface Place { id: string; name: string; description: string; cost: number; imageUrl: string; whyGo?: string; }\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "import { days, places } from '@/lib/demo-data';",
    "import { PlaceVisual } from './PlaceVisual';",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/day/day-1\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{days.map((day) => <button aria-pressed={selectedDay === day.dayNumber} onClick={() => setSelectedDay(day.dayNumber)} key={day.id}>D{day.dayNumber}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <article key={place.id}><PlaceVisual placeId={place.id} name={place.name} /><h2>{place.name}</h2><p>{place.description}</p><a href={`/place/${place.id}`}>查看详情</a><button>编辑</button></article>)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/components/PlaceDetail.tsx", [
    "import type { Place } from '@/types';",
    "export function PlaceDetail({ place }: { place: Place }) {",
    "  return <article><h1>{place.name}</h1><img src={place.imageUrl} alt={place.name} /><p>{place.description}</p><p>{place.whyGo}</p><p>{place.bestTime}</p><p>{place.transport}</p><button>收藏</button></article>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/components/PlaceVisual.tsx", [
    "const placeVisuals: Record<string, string> = { 'p-1': '寺院金顶和梧桐', 'p-2': '露台咖啡杯', 'p-3': '豫园屋檐', 'p-4': '小笼蒸笼' };",
    "export function PlaceVisual({ placeId, name }: { placeId: string; name: string }) {",
    "  const label = placeVisuals[placeId] ?? name;",
    "  return <div role=\"img\" data-visual aria-label={`${name} ${label} 专属插画`} className=\"place-visual\"><svg><text>{label}</text></svg></div>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "BudgetEditor", "DayCard", "DayList", "EmptyState", "ErrorBanner", "FavoriteList", "LoadingSkeleton", "MetaChip", "PrimaryAction"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", [
    "import type { Place } from '@/types';",
    "export const places: Place[] = Array.from({ length: 12 }, (_, index) => ({",
    "  id: `p-${index + 1}`, name: `上海地点${index + 1}`, imageUrl: `/images/place-${index + 1}.svg`, cost: 120, description: '一段具体地点描述。', whyGo: '明确停留理由。'",
    "}));",
    "export const days = [",
    "  { id: 'day-1', dayNumber: 1, placeIds: ['p-1', 'p-2', 'p-3', 'p-4'], altPlaceIds: ['p-1', 'p-2', 'p-4'] },",
    "  { id: 'day-2', dayNumber: 2, placeIds: ['p-5', 'p-6', 'p-7', 'p-8'], altPlaceIds: ['p-6', 'p-8', 'p-5'] },",
    "  { id: 'day-3', dayNumber: 3, placeIds: ['p-9', 'p-10', 'p-11', 'p-12'], altPlaceIds: ['p-10', 'p-11', 'p-12'] }",
    "];",
  ].join("\n"));
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const fieldContract = audit.checks.find((check) => check.id === "travel-place-field-contract");
  assert.equal(fieldContract?.passed, false);
  assert.match(fieldContract?.detail ?? "", /missing fields=bestTime, transport/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit reports empty saved routes in travel apps as advisory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-empty-saved-route");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-empty-saved-route", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/itinerary/page.tsx", "export default function Itinerary() { return <main><h1>上海行程</h1><a href=\"/\">首页</a><button>雨天切换</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><a href=\"/\">首页</a><button>筛选景点</button><p className=\"empty-state\">没有收藏地点</p></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; background: linear-gradient(#dfe8d8, #f7ead0); }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "const places = ['静安寺', '武康路', '外滩'];",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/itinerary\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{[1,2,3].map((day) => <button aria-pressed={selectedDay === day} onClick={() => setSelectedDay(day)} key={day}>D{day}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <article key={place}><div role=\"img\" data-visual aria-label={`${place} 手绘旅行插画`} className=\"place-visual\" /><h2>{place}</h2><button>查看详情</button><button>编辑</button></article>)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", "export type TripPlace = { id: string; name: string; visualLabel: string };\nexport const tripPlaces = [{ id: 'jing-an', name: '静安寺', visualLabel: '静安寺手绘插画' }] satisfies TripPlace[];\n");
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const savedRoute = audit.checks.find((check) => check.id === "saved-route-populated");
  assert.equal(savedRoute?.passed, false);
  assert.match(savedRoute?.detail ?? "", /only shows an empty state|items=/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit reports saved routes that hide populated cards behind empty localStorage as advisory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-trip-saved-route-hidden");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-trip-saved-route-hidden", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/itinerary/page.tsx", "export default function Itinerary() { return <main><h1>上海行程</h1><a href=\"/\">首页</a><button>雨天切换</button></main>; }\n");
  await sandbox.writeFile("src/app/favorites/page.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "import { useFavorites } from '@/lib/local-storage';",
    "export default function Favorites() {",
    "  const { favorites, removeFavorite, toggleMustVisit } = useFavorites();",
    "  const [filter, setFilter] = useState('all');",
    "  const filteredPlaces = favorites.filter((place) => filter === 'all' || place.type === filter);",
    "  if (favorites.length === 0) {",
    "    return <main><h1>收藏地点</h1><p className=\"empty-state\">没有收藏地点</p><button>探索行程</button></main>;",
    "  }",
    "  return <main><h1>收藏地点</h1><section>{['all','attraction','restaurant','mustvisit'].map((tab) => <button aria-pressed={filter === tab} onClick={() => setFilter(tab)} key={tab}>{tab}</button>)}</section>{filteredPlaces.map((place) => <article key={place.id}><h2>{place.name}</h2><button onClick={() => toggleMustVisit(place.id)}>标记必去</button><button onClick={() => removeFavorite(place.id)}>删除</button></article>)}</main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; background: linear-gradient(#dfe8d8, #f7ead0); }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "const places = ['静安寺', '武康路', '外滩'];",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/itinerary\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{[1,2,3].map((day) => <button aria-pressed={selectedDay === day} onClick={() => setSelectedDay(day)} key={day}>D{day}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <article key={place}><div role=\"img\" data-visual aria-label={`${place} 手绘旅行插画`} className=\"place-visual\" /><h2>{place}</h2><button>查看详情</button><button>编辑</button></article>)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", "export type TripPlace = { id: string; name: string; visualLabel: string };\nexport const tripPlaces = [{ id: 'jing-an', name: '静安寺', visualLabel: '静安寺手绘插画' }] satisfies TripPlace[];\n");
  await sandbox.writeFile("src/lib/local-storage.ts", [
    "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }",
    "export function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }",
    "export function useFavorites() { return { favorites: [], removeFavorite() {}, toggleMustVisit() {} }; }",
  ].join("\n"));

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const savedRoute = audit.checks.find((check) => check.id === "saved-route-populated");
  assert.equal(savedRoute?.passed, false);
  assert.match(savedRoute?.detail ?? "", /empty localStorage|seeded=0/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit blocks client App Router pages that call notFound", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-client-not-found-page");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-client-not-found-page", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
  }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "import './globals.css';\nexport const metadata = { title: 'Shanghai Trip' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n");
  await sandbox.writeFile("src/app/page.tsx", "import { TripWorkbench } from '@/components/TripWorkbench';\nexport default function Page() { return <TripWorkbench />; }\n");
  await sandbox.writeFile("src/app/itinerary/page.tsx", "export default function Itinerary() { return <main><h1>上海行程</h1><a href=\"/\">首页</a><a href=\"/itinerary/1\">第一天详情</a><button>雨天切换</button></main>; }\n");
  await sandbox.writeFile("src/app/itinerary/[day]/page.tsx", [
    "\"use client\";",
    "import { notFound, useParams } from 'next/navigation';",
    "export default function DayPage() {",
    "  const params = useParams<{ day: string }>();",
    "  if (!params.day) notFound();",
    "  return <main><h1>第 {params.day} 天</h1><a href=\"/\">首页</a><button>收藏</button></main>;",
    "}",
  ].join("\n"));
  await sandbox.writeFile("src/app/favorites/page.tsx", "export default function Favorites() { return <main><h1>收藏地点</h1><article><h2>静安寺</h2><p>已保存</p><button>筛选景点</button><button>移除</button></article><a href=\"/\">首页</a></main>; }\n");
  await sandbox.writeFile("src/app/error.tsx", "\"use client\";\nexport default function Error({ reset }: { reset: () => void }) { return <button onClick={reset}>重试</button>; }\n");
  await sandbox.writeFile("src/app/loading.tsx", "export default function Loading() { return <main>Loading</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; --paper: #f9f6ee; }\n@media (max-width: 480px) { body { padding: 0; } }\n.place-visual { width: 120px; height: 80px; background: linear-gradient(#dfe8d8, #f7ead0); }\nbutton:focus-visible { outline: 2px solid red; }\n.empty-state {}\n");
  await sandbox.writeFile("src/components/TripWorkbench.tsx", [
    "\"use client\";",
    "import { useState } from 'react';",
    "const places = ['静安寺', '武康路', '外滩'];",
    "export function TripWorkbench() {",
    "  const [selectedDay, setSelectedDay] = useState(1);",
    "  const [weather, setWeather] = useState('sunny');",
    "  const [filter, setFilter] = useState('all');",
    "  const [note, setNote] = useState('');",
    "  const groupedHistory = new Map([['第一天', ['已保存 静安路线']]]);",
    "  return <main><nav><a href=\"/itinerary\">行程</a><a href=\"/favorites\">收藏</a></nav><h1>沪上手帐旅行</h1><section>{[1,2,3].map((day) => <button aria-pressed={selectedDay === day} onClick={() => setSelectedDay(day)} key={day}>D{day}</button>)}</section><section><button aria-pressed={weather === 'rainy'} onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>雨天切换</button><button aria-pressed={filter === 'food'} onClick={() => setFilter('food')}>筛选美食</button></section><form><textarea autoFocus value={note} onChange={(event) => setNote(event.currentTarget.value)} name=\"entry\" /><button type=\"button\">保存中</button><p>保存成功</p></form>{places.map((place) => <article key={place}><div role=\"img\" data-visual aria-label={`${place} 手绘旅行插画`} className=\"place-visual\" /><h2>{place}</h2><button>查看详情</button><button>编辑</button></article>)}<section>{[...groupedHistory].map(([day, items]) => <article key={day}><time>{day}</time>{items.map((item) => <p key={item}>{item}<button>删除</button></p>)}</article>)}</section><p className=\"empty-state\">没有收藏地点</p></main>;",
    "}",
  ].join("\n"));
  for (const name of ["AppShell", "EmptyState", "ErrorBanner", "LoadingSkeleton", "MetaChip", "PrimaryAction", "SectionHeader", "TripCard"]) {
    await sandbox.writeFile(`src/components/${name}.tsx`, `export function ${name}() { return <section><button>${name}</button><p>已保存</p></section>; }\n`);
  }
  await sandbox.writeFile("src/app/api/items/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n");
  await sandbox.writeFile("src/lib/demo-data.ts", "export type TripPlace = { id: string; name: string; visualLabel: string };\nexport const tripPlaces = [{ id: 'jing-an', name: '静安寺', visualLabel: '静安寺手绘插画' }] satisfies TripPlace[];\n");
  await sandbox.writeFile("src/lib/local-storage.ts", "export function readLocalTripNotes() { try { return localStorage.getItem('trip-notes') ?? ''; } catch { return ''; } }\nexport function saveLocalTripNotes(value: string) { localStorage.setItem('trip-notes', value); }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };

  const clientNotFound = audit.checks.find((check) => check.id === "app-router-client-not-found");
  assert.equal(clientNotFound?.passed, false);
  assert.match(clientNotFound?.detail ?? "", /src\/app\/itinerary\/\[day\]\/page\.tsx/);

  await rm(root, { recursive: true, force: true });
});

test("quality_audit reports product closure failures as advisory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-1");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-1", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  await sandbox.writeFile("package.json", JSON.stringify({ scripts: { build: "next build" } }));
  await sandbox.writeFile("next.config.mjs", "export default {};\n");
  await sandbox.writeFile("tsconfig.json", "{}\n");
  await sandbox.writeFile("next-env.d.ts", "/// <reference types=\"next\" />\n");
  await sandbox.writeFile("src/app/layout.tsx", "export const metadata = { title: 'Tiny App' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return children; }\n");
  await sandbox.writeFile("src/app/page.tsx", "export default function Page() { return <main>Prototype generated app</main>; }\n");
  await sandbox.writeFile("src/app/globals.css", ":root { --ink: #111; }\n");

  const audit = (await registry.execute("quality_audit", {}, context)) as {
    status: string;
    blockingFailures: number;
    checks: Array<{ id: string; passed: boolean; blocking: boolean }>;
  };
  assert.equal(audit.status, "passed");
  assert.equal(audit.blockingFailures, 0);
  const implementationCopy = audit.checks.find((check) => check.id === "no-visible-implementation-copy");
  assert.equal(implementationCopy?.passed, false);
  assert.equal(implementationCopy?.blocking, false);

  await rm(root, { recursive: true, force: true });
});
