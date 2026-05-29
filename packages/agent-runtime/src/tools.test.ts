import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SandboxWorkspace } from "./sandbox.js";
import { createDefaultToolRegistry, isAllowedAgentCommand } from "./tools.js";

test("sandbox rejects paths that escape the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-1");

  assert.throws(() => sandbox.resolveSandboxPath("../outside.txt"), /escapes sandbox/);
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
      { runId: "run-1", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} },
    ),
    /content/,
  );

  await registry.execute(
    "write_file",
    { path: "src/app/page.tsx", content: "export default function HomePage() { return null; }\n" },
    { runId: "run-1", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} },
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

test("quality_audit enforces commercial strictness: routes, components, data depth, states, server-action wiring", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const sandbox = await SandboxWorkspace.create(root, "run-strict");
  const registry = createDefaultToolRegistry();
  const context = { runId: "run-strict", workspace: sandbox, emitTrace: () => {}, emitLog: () => {} };

  // Build a tiny but lexically clean Next.js scaffold that nonetheless violates
  // the commercial strict checks (1 page, 1 component, 1 model, dead Server Action, no states).
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

  assert.equal(audit.status, "failed", "tight audit must catch the under-built app");
  const failedIds = audit.checks.filter((check) => !check.passed).map((check) => check.id);
  assert.ok(failedIds.includes("distinct-page-routes"), `expected distinct-page-routes to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("component-library"), `expected component-library to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("multiple-models"), `expected multiple-models to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("model-relations"), `expected model-relations to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("server-action-wired"), `expected server-action-wired to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("state-coverage"), `expected state-coverage to fail; got ${failedIds.join(",")}`);
  assert.ok(failedIds.includes("workflow-state-depth"), `expected workflow-state-depth to fail; got ${failedIds.join(",")}`);

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

test("quality_audit reports blocking product closure failures", async () => {
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
    checks: Array<{ id: string; passed: boolean }>;
  };
  assert.equal(audit.status, "failed");
  assert.ok(audit.blockingFailures > 0);
  assert.equal(audit.checks.find((check) => check.id === "no-visible-implementation-copy")?.passed, false);

  await rm(root, { recursive: true, force: true });
});
