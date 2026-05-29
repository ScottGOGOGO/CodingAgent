import test from "node:test";
import assert from "node:assert/strict";

import { ExpertRouter } from "./expert-router.js";
import { ModelClient } from "./model-client.js";
import type { JsonGenerationRequest } from "./model-client.js";

function router() {
  return new ExpertRouter(
    new ModelClient({
      provider: "test",
      roleModels: {},
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    }),
  );
}

function appWithPage(page: string) {
  return {
    title: "训练计划",
    summary: "测试候选",
    files: [
      { path: "package.json", content: "{}" },
      { path: "tsconfig.json", content: "{}" },
      { path: "next-env.d.ts", content: "" },
      { path: "next.config.mjs", content: "const nextConfig = {}; export default nextConfig;\n" },
      { path: "src/app/layout.tsx", content: "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n" },
      { path: "src/app/page.tsx", content: page },
      { path: "src/app/globals.css", content: "body { margin: 0; }\n" },
    ],
  };
}

function appWithFiles(files: Array<{ path: string; content: string }>) {
  const base = appWithPage("export default function HomePage() { return <main><h1>今日训练</h1><button>记录完成</button></main>; }");
  const byPath = new Map(base.files.map((file) => [file.path, file]));
  for (const file of files) {
    byPath.set(file.path, file);
  }
  return { ...base, files: [...byPath.values()] };
}

class FailingConfiguredModel extends ModelClient {
  constructor() {
    super({
      provider: "deepseek",
      apiKey: "invalid",
      baseUrl: "https://api.deepseek.com",
      modelName: "deepseek-v4-flash",
      roleModels: { clarifier: "deepseek-v4-flash" },
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    });
  }

  override get configured() {
    return true;
  }

  override async generateJson<T>(_request: JsonGenerationRequest): Promise<T> {
    throw new Error("Model request failed: 401 invalid_request_error");
  }
}

test("ExpertRouter critique ignores non-visible React identifiers in TSX source", async () => {
  const result = await router().critique({
    app: appWithPage(
      [
        "import React from 'react';",
        "export default function HomePage() {",
        "  const label = React.useMemo(() => '今日训练', []);",
        "  return <main><h1>{label}</h1><button>记录完成</button></main>;",
        "}",
      ].join("\n"),
    ),
    buildPassed: true,
    buildLog: "",
  });

  assert.equal(result.passed, true);
});

test("ExpertRouter critique does not treat todo icon names or form placeholders as unfinished content", async () => {
  const result = await router().critique({
    app: appWithFiles([
      {
        path: "src/components/Checklist.tsx",
        content: [
          "import { ListTodo } from 'lucide-react';",
          "export function Checklist() {",
          "  return <section><ListTodo aria-hidden /><input placeholder=\"添加新事项...\" /><button>保存清单</button></section>;",
          "}",
        ].join("\n"),
      },
    ]),
    buildPassed: true,
    buildLog: "",
  });

  assert.equal(result.passed, true, result.issues.join("\n"));
});

test("ExpertRouter critique still blocks explicit visible TODO copy", async () => {
  const result = await router().critique({
    app: appWithPage("export default function HomePage() { return <main><h1>今日训练</h1><p>TODO: 补齐真实清单</p></main>; }"),
    buildPassed: true,
    buildLog: "",
  });

  assert.equal(result.passed, false);
  assert.match(result.issues.join("\n"), /占位内容/);
});

test("ExpertRouter surfaces configured model failures instead of silent fallback", async () => {
  const failingRouter = new ExpertRouter(new FailingConfiguredModel());

  await assert.rejects(
    failingRouter.decideClarification({
      message: "做一个移动端旅行预算协作应用，包含行程、预算、收藏、预订和 AI 建议。",
      context: { summary: "", files: [], gitStatus: "" },
    }),
    /模型调用失败（clarifier）/,
  );
});

test("ModelClient applies a hard timeout when fetch does not settle", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, _reject) => {
      init?.signal?.addEventListener("abort", () => {
        // Simulate a transport that ignores AbortSignal; the hard timeout must
        // still reject the caller's promise.
      });
    });

  try {
    const client = new ModelClient({
      provider: "test",
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      modelName: "test-model",
      roleModels: {},
      timeoutMs: 25,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    });

    const startedAt = Date.now();
    await assert.rejects(
      client.generateJson({
        role: "architect",
        system: "Return JSON.",
        user: "{}",
        schemaHint: "{}",
      }),
      /Model request \(architect\) timed out after 25ms/,
    );
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ExpertRouter critique blocks visible implementation copy", async () => {
  const result = await router().critique({
    app: appWithPage(
      [
        "export default function HomePage() {",
        "  return <main><h1>Next.js Full-stack</h1><section>需求澄清</section></main>;",
        "}",
      ].join("\n"),
    ),
    buildPassed: true,
    buildLog: "",
  });

  assert.equal(result.passed, false);
  assert.match(result.summary, /页面文案暴露内部实现/);
});

test("ExpertRouter critique scans visible seed data for implementation copy", async () => {
  const result = await router().critique({
    app: appWithFiles([
      {
        path: "src/lib/demo-data.ts",
        content:
          'export const domainItems = [{ id: "architecture", title: "全栈架构", summary: "API 路由和 Server Action 支撑完整应用行为。" }];',
      },
    ]),
    buildPassed: true,
    buildLog: "",
  });

  assert.equal(result.passed, false);
  assert.match(result.issues.join("\n"), /页面文案暴露内部实现/);
});

test("ExpertRouter critique blocks generic fallback app structure", async () => {
  const result = await router().critique({
    app: appWithFiles([
      {
        path: "src/app/page.tsx",
        content:
          'import { InteractiveWorkbench } from "@/components/InteractiveWorkbench"; export default function HomePage(){ const items=[]; return <InteractiveWorkbench items={items} />; }',
      },
      {
        path: "src/components/InteractiveWorkbench.tsx",
        content: 'const lanes = ["今日任务", "进行中", "已记录", "下一步"] as const; export function InteractiveWorkbench(){ return null; }',
      },
      {
        path: "src/lib/demo-data.ts",
        content: 'export const domainItems = [{ id: "intake" }, { id: "architecture" }, { id: "validation" }];',
      },
    ]),
    buildPassed: true,
    buildLog: "",
  });

  assert.equal(result.passed, false);
  assert.match(result.issues.join("\n"), /通用生成模板/);
});

test("ExpertRouter learning fallback avoids implementation copy", async () => {
  const app = await router().generateApp({
    message: "帮我做一个中文移动优先的网球学习规划软件，面向刚入门的成年人。",
    clarificationText: "重点做今日训练、课程进度、练习记录和教练反馈。",
    context: { summary: "Workspace files: 0", files: [], gitStatus: "" },
  });
  const result = await router().critique({
    app,
    buildPassed: true,
    buildLog: "",
  });

  assert.notEqual(app.title, "本地生成应用");
  assert.match(app.title, /网球训练手册/);
  assert.equal(result.passed, true, result.issues.join("\n"));
});

test("ExpertRouter fallback normalizes Prisma environment and package dependencies", async () => {
  const app = await router().generateApp({
    message: "帮我做一个中文移动优先的上海旅行规划应用，包含行程、收藏和预算。",
    clarificationText: "静态精选数据即可，但要有可部署的数据层。",
    context: { summary: "Workspace files: 0", files: [], gitStatus: "" },
  });
  const packageJson = JSON.parse(app.files.find((file) => file.path === "package.json")?.content ?? "{}") as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.ok(app.files.some((file) => file.path === "prisma/schema.prisma"));
  assert.ok(app.files.some((file) => file.path === ".env" && /DATABASE_URL="file:\.\/dev\.db"/.test(file.content)));
  assert.ok(packageJson.dependencies?.["@prisma/client"]);
  assert.ok(packageJson.devDependencies?.prisma);
});

test("ExpertRouter normalizes imported third-party packages into dependencies", async () => {
  const app = await router().repairApp({
    app: appWithFiles([
      {
        path: "package.json",
        content: JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1" },
        }),
      },
      {
        path: "src/app/actions.ts",
        content: '"use server";\nimport { z } from "zod";\nconst Input = z.object({ id: z.string() });\nexport async function saveAction(formData: FormData) { Input.parse({ id: String(formData.get("id") ?? "") }); return { ok: true }; }\n',
      },
      {
        path: "src/components/IconButton.tsx",
        content: 'import { Star } from "lucide-react";\nexport function IconButton() { return <button><Star size={16} />收藏</button>; }\n',
      },
    ]),
    issues: ["force deterministic repair normalization"],
    buildLog: "",
    message: "测试",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
  });
  const packageJson = JSON.parse(app.files.find((file) => file.path === "package.json")?.content ?? "{}") as {
    dependencies?: Record<string, string>;
  };

  assert.ok(packageJson.dependencies?.zod);
  assert.ok(packageJson.dependencies?.["lucide-react"]);
});

test("W5: createDesignSeed deterministic fallback produces a concrete identity with custom assets", async () => {
  const brief = await router().createDesignBrief({
    message: "生成一个移动优先的上海旅行规划应用，包含首页、行程、地点详情和我的收藏。",
    clarificationText: "scope: 城市周末游",
    context: { summary: "", files: [], gitStatus: "" },
  });
  const seed = await router().createDesignSeed({
    message: "生成一个移动优先的上海旅行规划应用",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
    designBrief: { ...brief, id: "test", runId: "test", createdAt: new Date().toISOString() },
  });

  // Palette is concrete (not empty, not generic blue-gray defaults).
  assert.ok(seed.palette.primary.startsWith("#"), `primary should be a hex color, got ${seed.palette.primary}`);
  assert.ok(seed.palette.surface.startsWith("#"));
  assert.ok(seed.palette.ink.startsWith("#"));
  assert.notEqual(seed.palette.name, "default");

  // Typography is a real pair, not system-ui everywhere.
  assert.notEqual(seed.typography.headingFamily, seed.typography.bodyFamily, "heading and body must differ");
  assert.match(seed.typography.headingFamily, /\w+/);
  assert.match(seed.typography.bodyFamily, /\w+/);

  // At least one custom asset and one CSS tokens file.
  assert.ok(seed.assets.length >= 1, "must produce at least one asset");
  const hasSvgComponent = seed.assets.some((asset) => asset.kind === "svg-component" && asset.filename.endsWith(".tsx"));
  const hasCssTokens = seed.assets.some((asset) => asset.kind === "css-tokens" && asset.content.includes("--color-primary"));
  assert.ok(hasSvgComponent, "must produce an SVG component asset");
  assert.ok(hasCssTokens, "must produce a CSS tokens file exposing --color-primary");
});

test("W4: createArchitecturePlan fallback satisfies P1 hard floor (≥3 routes, ≥8 components, ≥3 models, ≥10 tasks)", async () => {
  // Use a brief with only 1 screen — this is the worst case for hitting the
  // P1 floor and is where the orchestrator needs to synthesize aggressively.
  const brief = await router().createDesignBrief({
    message: "做一个非常简单的单页 todo 应用",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
  });
  const plan = await router().createArchitecturePlan({
    message: "做一个非常简单的单页 todo 应用",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
    designBrief: { ...brief, id: "test", runId: "test", createdAt: new Date().toISOString() },
  });

  // Hard floor checks — orchestrator must augment or replace with fallback so
  // every plan meets these regardless of model output.
  const pageRouteCount = plan.routes.length;
  const componentCount = plan.components.length;
  const modelCount = plan.dataModels.length;
  const taskCount = plan.tasks.length;

  assert.ok(pageRouteCount >= 3, `expected ≥3 page routes, got ${pageRouteCount}`);
  assert.ok(componentCount >= 8, `expected ≥8 components, got ${componentCount}`);
  assert.ok(modelCount >= 3, `expected ≥3 data models, got ${modelCount}`);
  assert.ok(taskCount >= 10, `expected ≥10 tasks, got ${taskCount}`);

  // Empty/loading/error state coverage MUST be a task.
  const stateTask = plan.tasks.find((task) => task.id === "task-state-coverage");
  assert.ok(stateTask, "plan must include a task-state-coverage task");
  assert.ok(stateTask!.files.some((f) => f.endsWith("loading.tsx")), "state-coverage task must include loading.tsx");
  assert.ok(stateTask!.files.some((f) => f.endsWith("error.tsx")), "state-coverage task must include error.tsx");

  // Auth strategy MUST be addressed explicitly.
  const authTask = plan.tasks.find((task) => task.id === "task-auth-strategy");
  assert.ok(authTask, "plan must include a task-auth-strategy task");
});
