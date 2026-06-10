import test from "node:test";
import assert from "node:assert/strict";

import { ExpertRouter, buildCommercialRecordApp, createExperienceBlueprint, formatExperienceBlueprintForPrompt, formatRepairFilesForPrompt } from "./expert-router.js";
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

class FailingArchitectModel extends ModelClient {
  constructor() {
    super({
      provider: "deepseek",
      apiKey: "invalid",
      baseUrl: "https://api.deepseek.com",
      modelName: "deepseek-v4-flash",
      roleModels: { architect: "deepseek-v4-flash" },
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
    throw new Error("Model request (architect) timed out after 90000ms");
  }
}

class LocalFirstGeneratedAppModel extends ModelClient {
  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { coder: "test-model" },
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
    return {
      title: "旅途手帐",
      summary: "使用浏览器本地保存的旅行手帐。",
      files: [
        ...appWithPage("export default function HomePage() { return <main><h1>旅途手帐</h1><button>保存记录</button></main>; }").files,
        {
          path: "src/lib/local-storage.ts",
          content:
            "export function readLocalRecords() { return typeof window === 'undefined' ? [] : JSON.parse(localStorage.getItem('travel-records') ?? '[]'); }\n",
        },
      ],
    } as T;
  }
}

class StaticRoleModel extends ModelClient {
  constructor(private readonly responder: (request: JsonGenerationRequest) => unknown) {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: {
        clarifier: "test-model",
        planner: "test-model",
        design_director: "test-model",
        design_seed_smith: "test-model",
        architect: "test-model",
        coder: "test-model",
        critic: "test-model",
        visual_critic: "test-model",
        repairer: "test-model",
      },
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

  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    return this.responder(request) as T;
  }
}

function completeDesignBrief() {
  return {
    id: "brief-1",
    runId: "run-1",
    summary: "移动优先旅行手帐，覆盖行前清单、每日记录、灵感收藏和历史回顾。",
    targetUser: "个人旅行者",
    productGoal: "用本地保存帮助用户持续记录旅行状态。",
    coreExperience: "填写今日手帐，保存清单状态，并在历史里继续编辑。",
    screens: ["今日", "清单", "手帐", "历史"],
    interactionModel: ["底部导航", "日期切换", "保存反馈", "历史筛选"],
    visualDirection: ["纸感旅行手帐", "紧凑移动工具"],
    contentStrategy: ["真实行前事项", "具体地点灵感"],
    qualityBar: ["完整移动首屏", "无占位内容"],
    antiPatterns: ["通用白卡", "技术栈文案"],
    createdAt: new Date().toISOString(),
  };
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

test("ExpertRouter generated apps are sanitized before critique", async () => {
  const app = await router().repairApp({
    app: appWithFiles([
      {
        path: "src/app/page.tsx",
        content:
          "export default function HomePage() { return <main><h1>生成的应用</h1><p>TODO: 补齐真实清单</p><p>Next.js demo sample data</p></main>; }",
      },
      {
        path: "src/components/screens/SettingsScreen.tsx",
        content:
          "export function SettingsScreen(){ return <section><span>常用标签（待实现）</span><button>保存设置</button></section>; }",
      },
    ]),
    issues: ["force deterministic repair"],
    buildLog: "",
    message: "生成一个中文移动端记录应用",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
  });
  const source = app.files
    .filter((file) => file.path === "src/app/page.tsx" || /^src\/components\/.+\.(tsx|jsx)$/.test(file.path))
    .map((file) => file.content)
    .join("\n");
  const result = await router().critique({ app, buildPassed: true, buildLog: "" });

  assert.doesNotMatch(source, /TODO|待实现|Next\.js|\bdemo\b|\bsample\b|生成的应用/i);
  assert.equal(result.passed, true, result.issues.join("\n"));
});

test("ExpertRouter repair prompt files exclude build artifacts and stay bounded", () => {
  const currentFiles = formatRepairFilesForPrompt([
    { path: "package.json", content: "{}" },
    { path: "src/app/page.tsx", content: "export default function Page() { return <main>Trip</main>; }\n" },
    { path: ".next/server/chunks/app.js", content: "x".repeat(120_000) },
    { path: "coverage/report.json", content: "x".repeat(120_000) },
    { path: "src/components/Huge.tsx", content: "export const huge = `" + "a".repeat(80_000) + "`;\n" },
  ]);

  assert.match(currentFiles, /--- package\.json/);
  assert.match(currentFiles, /--- src\/app\/page\.tsx/);
  assert.doesNotMatch(currentFiles, /\.next|coverage/);
  assert.ok(currentFiles.length <= 49_000, `repair files prompt was ${currentFiles.length} chars`);
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

test("ExpertRouter treats implementation-mechanics clarification as ready for detailed briefs", async () => {
  const detailedTravelBrief =
    "帮我生成一个中文移动优先的上海三天两晚旅行规划 Web 应用，面向两位成年人在节假日出行，住在静安寺附近，节奏偏轻松休闲。首版必须包含首页概览、按天行程页、地点详情页、预算页、收藏清单页；核心流程是浏览三天行程、查看地点详情、按天气切换备选方案、收藏地点、查看预算汇总。推荐内容用高质量静态精选数据，视觉做成文艺旅行手帐风，预算只统计餐饮、门票和市内交通，收藏清单本地保存。";
  const router = new ExpertRouter(
    new StaticRoleModel(() => ({
      action: "ask",
      summary: "需求整体清晰，但天气切换的具体机制需要明确。",
      questions: [
        {
          id: "weather-switch",
          header: "备选方案机制",
          question: "你提到的“按天气切换备选方案”，希望怎样实现？",
          options: [
            { label: "地点替代", value: "per_place", description: "每个地点预设室内或室外替代。" },
            { label: "整天替换", value: "full_day", description: "每天预设晴天和雨天两套完整行程。" },
          ],
        },
      ],
    })),
    { strictGeneration: true },
  );

  const decision = await router.decideClarification({
    message: detailedTravelBrief,
    context: { summary: "", files: [], gitStatus: "" },
  });

  assert.equal(decision.action, "ready");
  assert.deepEqual(decision.questions, []);
});

test("ExpertRouter strict generation rejects thin design briefs instead of filling deterministic fields", async () => {
  const strictRouter = new ExpertRouter(
    new StaticRoleModel(() => ({
      summary: "旅行手帐。",
      screens: ["今日"],
    })),
    { strictGeneration: true },
  );

  await assert.rejects(
    strictRouter.createDesignBrief({
      message: "生成一个中文移动端旅行手帐。",
      clarificationText: "",
      context: { summary: "", files: [], gitStatus: "" },
    }),
    /design_director 返回的设计 brief 不完整/,
  );
});

test("ExpertRouter strict generation rejects incomplete design seeds instead of borrowing fallback identity", async () => {
  const strictRouter = new ExpertRouter(
    new StaticRoleModel(() => ({
      visualConcept: "旅行纸感手帐。",
      palette: { primary: "#c47a3a" },
      typography: { headingFamily: "Lora, serif", bodyFamily: "Inter, sans-serif" },
      motionLanguage: "Tactile only.",
    })),
    { strictGeneration: true },
  );

  await assert.rejects(
    strictRouter.createDesignSeed({
      message: "生成一个中文移动端旅行手帐。",
      clarificationText: "",
      context: { summary: "", files: [], gitStatus: "" },
      designBrief: completeDesignBrief(),
    }),
    /design_seed_smith 返回的视觉身份种子不完整/,
  );
});

test("ExpertRouter strict generation augments thin architecture plans with the fixed baseline contract", async () => {
  const strictRouter = new ExpertRouter(
    new StaticRoleModel(() => ({
      summary: "一个单页旅行手帐计划。",
      techStack: ["next@14"],
      stateArchitecture: "本地状态。",
      serverArchitecture: "无。",
      dataStore: { provider: "memory", orm: "none" },
      fileTree: [{ path: "src/app/page.tsx", purpose: "首页" }],
      dataModels: [{ name: "Entry", description: "记录", fields: [{ name: "id", type: "string" }] }],
      components: [{ name: "Home", filePath: "src/components/Home.tsx", purpose: "首页" }],
      routes: [{ path: "/", component: "Home" }],
      qualityChecks: [{ id: "quality", category: "frontend", requirement: "首页可见", evidence: "截图", blocking: true }],
      tasks: [{ id: "task-1", title: "首页", description: "写首页", acceptance: "可见" }],
    })),
    { strictGeneration: true },
  );

  const plan = await strictRouter.createArchitecturePlan({
    message: "生成一个中文移动端旅行手帐。",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
    designBrief: completeDesignBrief(),
  });

  for (const path of ["package.json", "next.config.mjs", "tsconfig.json", "next-env.d.ts", "src/app/layout.tsx", "src/app/page.tsx", "src/app/globals.css"]) {
    assert.ok(plan.fileTree.some((file) => file.path === path), `expected baseline file ${path}`);
  }
  assert.ok(plan.components.length >= 3);
  assert.ok(plan.tasks.some((task) => task.id === "task-baseline-scaffold"));
  assert.ok(plan.tasks.some((task) => task.id === "task-build-verify"));
  assert.ok(plan.qualityChecks?.some((check) => check.id === "baseline-nextjs-scaffold"));
});

test("ExpertRouter strict generation retries thin architecture plans before failing", async () => {
  const requests: JsonGenerationRequest[] = [];
  const strictRouter = new ExpertRouter(
    new StaticRoleModel((request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          summary: "一个单页旅行手帐计划。",
          techStack: ["next@14"],
          stateArchitecture: "本地状态。",
          serverArchitecture: "无。",
          dataStore: { provider: "memory", orm: "none" },
          fileTree: [{ path: "src/app/page.tsx", purpose: "首页" }],
          dataModels: [],
          components: [{ name: "Home", filePath: "src/components/Home.tsx", purpose: "首页" }],
          routes: [{ path: "/", component: "Home" }],
          qualityChecks: [{ id: "quality", category: "frontend", requirement: "首页可见", evidence: "截图", blocking: true }],
          tasks: [{ id: "task-1", title: "首页", description: "写首页", acceptance: "可见" }],
        };
      }
      return {
        summary: "移动端旅行手帐完整工程计划。",
        techStack: ["next@14", "react@18", "typescript-strict", "app-router"],
        stateArchitecture: "服务端加载旅行资料，客户端管理日期、筛选、编辑和本地保存反馈。",
        serverArchitecture: "Route Handlers 暴露旅行资料读取接口，浏览器存储保存个人手帐状态。",
        dataStore: { provider: "memory", orm: "none" },
        fileTree: [
          { path: "src/app/page.tsx", purpose: "今日手帐首页" },
          { path: "src/app/checklist/page.tsx", purpose: "行前清单页" },
          { path: "src/app/history/page.tsx", purpose: "历史回顾页" },
        ],
        dataModels: ["TripEntry", "ChecklistItem", "MemoryPlace"].map((name) => ({
          name,
          description: `${name} domain entity.`,
          fields: [{ name: "id", type: "string", description: "stable id" }],
        })),
        components: Array.from({ length: 8 }, (_, index) => ({
          name: `TravelModule${index + 1}`,
          filePath: `src/components/TravelModule${index + 1}.tsx`,
          purpose: `旅行手帐模块 ${index + 1}`,
        })),
        routes: [
          { path: "/", component: "TravelModule1" },
          { path: "/checklist", component: "TravelModule2" },
          { path: "/history", component: "TravelModule3" },
        ],
        qualityChecks: [{ id: "interaction-model-completeness", category: "interaction", requirement: "完整交互", evidence: "状态和按钮", blocking: true }],
        tasks: Array.from({ length: 10 }, (_, index) => ({
          id: `model-task-${index + 1}`,
          title: `完成旅行手帐任务 ${index + 1}`,
          description: `实现旅行手帐第 ${index + 1} 个可见交互单元。`,
          files: ["src/app/page.tsx"],
          dependsOn: index === 0 ? [] : [`model-task-${index}`],
          acceptance: `用户能看到并操作旅行手帐第 ${index + 1} 个单元。`,
        })),
      };
    }),
    { strictGeneration: true },
  );

  const plan = await strictRouter.createArchitecturePlan({
    message: "生成一个中文移动端旅行手帐。",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
    designBrief: completeDesignBrief(),
  });

  assert.equal(requests.length, 2);
  assert.match(requests[1]?.user ?? "", /Previous architecture plan failed the strict no-fallback gate/);
  assert.match(requests[1]?.user ?? "", /dataModels/);
  assert.equal(plan.dataModels.length, 3);
  assert.equal(plan.tasks.length, 10);
});

test("ExpertRouter strict generation fills required architecture quality checks without fallback tasks", async () => {
  const strictRouter = new ExpertRouter(
    new StaticRoleModel(() => ({
      summary: "移动端旅行手帐完整工程计划。",
      techStack: ["next@14", "react@18", "typescript-strict", "app-router"],
      stateArchitecture: "服务端加载旅行资料，客户端管理日期、筛选、编辑和本地保存反馈。",
      serverArchitecture: "Route Handlers 暴露旅行资料读取接口，浏览器存储保存个人手帐状态。",
      dataStore: { provider: "memory", orm: "none" },
      fileTree: [
        { path: "src/app/page.tsx", purpose: "今日手帐首页" },
        { path: "src/app/checklist/page.tsx", purpose: "行前清单页" },
        { path: "src/app/history/page.tsx", purpose: "历史回顾页" },
      ],
      dataModels: ["TripEntry", "ChecklistItem", "MemoryPlace"].map((name) => ({
        name,
        description: `${name} domain entity.`,
        fields: [{ name: "id", type: "string", description: "stable id" }],
      })),
      components: Array.from({ length: 8 }, (_, index) => ({
        name: `TravelModule${index + 1}`,
        filePath: `src/components/TravelModule${index + 1}.tsx`,
        purpose: `旅行手帐模块 ${index + 1}`,
      })),
      routes: [
        { path: "/", component: "TravelModule1" },
        { path: "/checklist", component: "TravelModule2" },
        { path: "/history", component: "TravelModule3" },
      ],
      qualityChecks: Array.from({ length: 16 }, (_, index) => ({
        id: `quality-custom-${index + 1}`,
        category: "interaction",
        requirement: `保存手帐后出现成功反馈并更新历史列表 ${index + 1}。`,
        evidence: "客户端状态、保存按钮和历史列表。",
        blocking: true,
      })),
      tasks: Array.from({ length: 10 }, (_, index) => ({
        id: `model-task-${index + 1}`,
        title: `完成旅行手帐任务 ${index + 1}`,
        description: `category: route-surface。实现旅行手帐第 ${index + 1} 个可见交互单元。`,
        files: ["src/app/page.tsx"],
        dependsOn: index === 0 ? [] : [`model-task-${index}`],
        acceptance: `用户能看到并操作旅行手帐第 ${index + 1} 个单元。`,
      })),
    })),
    { strictGeneration: true },
  );

  const plan = await strictRouter.createArchitecturePlan({
    message: "生成一个中文移动端旅行手帐。",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
    designBrief: completeDesignBrief(),
  });

  assert.ok(plan.qualityChecks?.some((check) => check.id === "interaction-model-completeness"));
  assert.equal(plan.qualityChecks?.length, 16);
  assert.deepEqual(plan.tasks.map((task) => task.id), Array.from({ length: 10 }, (_, index) => `model-task-${index + 1}`));
});

test("ExpertRouter strict generation rejects incomplete generated app files instead of injecting scaffold", async () => {
  const strictRouter = new ExpertRouter(
    new StaticRoleModel(() => ({
      title: "旅途手帐",
      summary: "只返回了首页。",
      files: [
        {
          path: "src/app/page.tsx",
          content: "export default function Page(){ return <main><h1>旅途手帐</h1></main>; }\n",
        },
        {
          path: "src/app/layout.tsx",
          content: "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
        },
        { path: "package.json", content: "{}\n" },
      ],
    })),
    { strictGeneration: true },
  );

  await assert.rejects(
    strictRouter.generateApp({
      message: "生成一个中文移动端旅行手帐。",
      clarificationText: "",
      context: { summary: "", files: [], gitStatus: "" },
    }),
    /coder 返回的 Next\.js 应用不完整/,
  );
});

test("ExpertRouter strict repair merges returned changed files into the current app", async () => {
  const strictRouter = new ExpertRouter(
    new StaticRoleModel(() => ({
      title: "旅途手帐",
      summary: "修复首页文案。",
      files: [
        {
          path: "src/app/page.tsx",
          content: "export default function HomePage() { return <main><h1>旅途手帐</h1><button>保存记录</button><p>行程已更新</p></main>; }",
        },
      ],
    })),
    { strictGeneration: true },
  );

  const app = await strictRouter.repairApp({
    app: appWithPage("export default function HomePage() { return <main><h1>旅途手帐</h1><button>保存记录</button></main>; }"),
    issues: ["首页需要更多反馈文案"],
    buildLog: "",
    message: "生成一个中文移动端旅行手帐。",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
    designBrief: completeDesignBrief(),
  });

  assert.ok(app.files.some((file) => file.path === "package.json"));
  assert.ok(app.files.some((file) => file.path === "src/app/layout.tsx"));
  assert.match(app.files.find((file) => file.path === "src/app/page.tsx")?.content ?? "", /行程已更新/);
});

test("ExpertRouter strict repair reports empty repair file output", async () => {
  const strictRouter = new ExpertRouter(
    new StaticRoleModel(() => ({
      title: "旅途手帐",
      summary: "未能修复。",
      files: [],
    })),
    { strictGeneration: true },
  );

  await assert.rejects(
    () =>
      strictRouter.repairApp({
        app: appWithPage("export default function HomePage() { return <main><h1>旅途手帐</h1><button>保存记录</button></main>; }"),
        issues: ["首页需要更多反馈文案"],
        buildLog: "",
        message: "生成一个中文移动端旅行手帐。",
        clarificationText: "",
        context: { summary: "", files: [], gitStatus: "" },
        designBrief: completeDesignBrief(),
      }),
    /repairer 未返回任何可合并文件/,
  );
});

test("ExpertRouter falls back to deterministic architecture plan on architect transport failures", async () => {
  const failingRouter = new ExpertRouter(new FailingArchitectModel());
  const brief = {
    id: "brief-1",
    runId: "run-1",
    summary: "移动端餐厅手帐，记录餐厅、评分、日期和历史筛选。",
    targetUser: "记录餐厅体验的个人用户",
    productGoal: "快速保存餐厅体验并按月份回顾。",
    coreExperience: "填写记录、保存反馈、筛选历史、编辑删除。",
    screens: ["今日记录", "历史手帐", "统计回顾", "设置"],
    interactionModel: ["日期切换", "保存状态", "月份筛选", "编辑删除"],
    visualDirection: ["温暖纸感手帐"],
    contentStrategy: ["真实餐厅和菜品内容"],
    qualityBar: ["商业级移动端体验"],
    antiPatterns: ["架构阶段超时导致失败"],
    createdAt: new Date().toISOString(),
  };

  const plan = await failingRouter.createArchitecturePlan({
    message: "生成一个中文移动端餐厅手帐",
    clarificationText: "",
    context: { summary: "", files: [], gitStatus: "" },
    designBrief: brief,
  });

  assert.ok(plan.routes.length >= 1);
  assert.ok(plan.components.length >= 3);
  assert.ok(plan.qualityChecks?.some((check) => check.id === "interaction-model-completeness"));
});

test("ExpertRouter commercial record fallback prioritizes restaurant domain over mood tags", async () => {
  const app = buildCommercialRecordApp(
    "Build a Chinese mobile-first restaurant journal with dining date, restaurant name, dishes, rating, cuisine filters, photo notes, and mood tags.",
  );
  const content = app.files.map((file) => file.content).join("\n");

  assert.equal(app.title, "食记");
  assert.match(content, /老赵家面馆|青庭寿司|餐厅手帐|用餐记录|菜系|菜品|番茄红/);
  assert.match(content, /餐厅名称|地点|招牌菜品|照片备注|本次评分|用餐笔记/);
  assert.match(content, /本月时间线|新增记录|选择照片|RecordInlineEmpty|localStorage|评分分布|本地保存/);
  assert.doesNotMatch(content, /晨夜节律|Routine tracker|Private archive|Restaurant journal|Fresh start|Empty state|Error state/);
});

test("ExpertRouter commercial record fallback only uses habit profile when no stronger domain is present", async () => {
  const app = buildCommercialRecordApp(
    "Build a Chinese mobile-first habit and mood tracker with morning routine, bedtime routine, week review, and mood notes.",
  );
  const content = app.files.map((file) => file.content).join("\n");

  assert.equal(app.title, "晨夜节律");
  assert.match(content, /晨间专注|睡前降噪|习惯记录|喝水|拉伸|阅读|冥想|写日记|护肤|远离手机|感恩练习/);
  assert.match(content, /晨间时间|睡前时间|通知开关|导出数据|本周|本月|mood-meter|本月时间线|新增记录/);
  assert.doesNotMatch(content, /Routine tracker|Fresh start|Empty state|Error state/);
});

test("ExpertRouter commercial record fallback keeps reading habits in the habit domain", async () => {
  const app = buildCommercialRecordApp(
    "生成一个中文移动优先的习惯和心情追踪 App，支持喝水、拉伸、阅读、冥想、写日记、睡前习惯和心情强度。",
  );
  const content = app.files.map((file) => file.content).join("\n");

  assert.equal(app.title, "晨夜节律");
  assert.match(content, /喝水|拉伸|阅读|冥想|心情强度|习惯记录/);
  assert.doesNotMatch(content, /私人片库|平凡的世界|播客|电影/);
});

test("ExpertRouter commercial record fallback builds a full media library product", async () => {
  const app = buildCommercialRecordApp(
    "Build a Chinese mobile-first private media library app for books, films, podcasts, timeline, stats, detail editing, local storage, and settings.",
  );
  const paths = app.files.map((file) => file.path);
  const content = app.files.map((file) => file.content).join("\n");

  assert.equal(app.title, "私人片库");
  assert.ok(paths.includes("src/app/library/page.tsx"));
  assert.ok(paths.includes("src/app/timeline/page.tsx"));
  assert.ok(paths.includes("src/app/stats/page.tsx"));
  assert.ok(paths.includes("src/app/settings/page.tsx"));
  assert.ok(paths.includes("src/app/detail/[id]/page.tsx"));
  assert.match(content, /私人馆藏|继续记录|搜索书影音|类型分布|每月活动|添加媒体条目|保存条目/);
  assert.match(content, /平凡的世界|完美的日子|日谈公园|private-media-library-v2/);
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

test("ModelClient retries JSON generation after an empty model response", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requestBodies.push(body);
    const content = requestBodies.length === 1
      ? ""
      : JSON.stringify({
          summary: "上海旅行手帐",
          targetUser: "两位节假日出行成年人",
          productGoal: "三分钟内看完三天路线并收藏地点",
          coreExperience: "浏览路线、天气切换、收藏和预算汇总",
          screens: ["首页", "行程", "详情", "预算", "收藏"],
          interactionModel: ["底部导航", "天气切换", "收藏反馈"],
          visualDirection: ["文艺旅行手帐"],
          contentStrategy: ["静安黄浦徐汇精选地点"],
          qualityBar: ["移动首屏完整"],
          antiPatterns: ["空白卡片"],
        });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new ModelClient({
      provider: "test",
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      modelName: "test-model",
      roleModels: {},
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    });

    const result = await client.generateJson<{ summary: string }>({
      role: "design_director",
      system: "Return JSON.",
      user: "Build a travel app",
      schemaHint: '{"summary": string}',
    });

    assert.equal(result.summary, "上海旅行手帐");
    assert.equal(requestBodies.length, 2);
    const retryMessages = requestBodies[1]?.messages as Array<{ role: string; content: string }>;
    assert.match(retryMessages.at(-1)?.content ?? "", /previous response was empty or invalid JSON/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelClient retries JSON generation after malformed JSON", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    const content = attempts === 1 ? "{not valid json" : "{\"ok\":true}";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new ModelClient({
      provider: "test",
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      modelName: "test-model",
      roleModels: {},
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    });

    const result = await client.generateJson<{ ok: boolean }>({
      role: "architect",
      system: "Return JSON.",
      user: "Plan",
      schemaHint: '{"ok": boolean}',
    });

    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelClient retries transient transport failures without local fallback", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new ModelClient({
      provider: "test",
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      modelName: "test-model",
      roleModels: {},
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    });

    const result = await client.generateJson<{ ok: boolean }>({
      role: "visual_critic",
      system: "Return JSON.",
      user: "Review",
      schemaHint: '{"ok": boolean}',
    });

    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelClient fails immediately for non-retryable model HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("invalid key", {
      status: 401,
      headers: { "content-type": "text/plain" },
    });
  };

  try {
    const client = new ModelClient({
      provider: "test",
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      modelName: "test-model",
      roleModels: {},
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    });

    await assert.rejects(
      client.generateJson({
        role: "visual_critic",
        system: "Return JSON.",
        user: "Review",
        schemaHint: '{"ok": boolean}',
      }),
      /Model tool-use request failed: 401 invalid key/,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelClient accepts tool calls when OpenAI-compatible gateways omit tool call type", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-write",
                  function: { name: "write_file", arguments: "{\"path\":\"src/app/page.tsx\"}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const client = new ModelClient({
      provider: "test",
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      modelName: "test-model",
      roleModels: {},
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    });

    const result = await client.chatWithTools({
      role: "coder",
      messages: [{ role: "user", content: "write a page" }],
      tools: [{ name: "write_file", description: "write", inputSchema: { type: "object" } }],
      forceToolUse: true,
    });

    assert.deepEqual(result.toolCalls, [
      { id: "call-write", name: "write_file", arguments: "{\"path\":\"src/app/page.tsx\"}" },
    ]);
    assert.equal(result.finishReason, "tool_calls");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelClient accepts legacy function_call responses from compatible gateways", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "",
              function_call: { name: "run_build", arguments: "{}" },
            },
            finish_reason: "function_call",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const client = new ModelClient({
      provider: "test",
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      modelName: "test-model",
      roleModels: {},
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    });

    const result = await client.chatWithTools({
      role: "coder",
      messages: [{ role: "user", content: "build" }],
      tools: [{ name: "run_build", description: "build", inputSchema: { type: "object" } }],
      forceToolUse: true,
    });

    assert.deepEqual(result.toolCalls, [{ id: "call_0", name: "run_build", arguments: "{}" }]);
    assert.equal(result.finishReason, "function_call");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelClient retries tool-use requests without tool_choice when thinking models reject it", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requestBodies.push(body);
    if (body.tool_choice !== undefined) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Thinking mode does not support this tool_choice",
            type: "invalid_request_error",
            code: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-list",
                  type: "function",
                  function: { name: "list_files", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = new ModelClient({
      provider: "test",
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      modelName: "test-model",
      roleModels: {},
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      buildAttempts: 1,
      previewPortBase: 4173,
    });

    const result = await client.chatWithTools({
      role: "coder",
      messages: [{ role: "user", content: "inspect" }],
      tools: [{ name: "list_files", description: "list", inputSchema: { type: "object" } }],
      forceToolUse: true,
    });

    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0]?.tool_choice, "required");
    assert.equal(requestBodies[1]?.tool_choice, undefined);
    assert.deepEqual(result.toolCalls, [{ id: "call-list", name: "list_files", arguments: "{}" }]);
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

test("ExpertRouter preserves local-first generated apps without injecting Prisma", async () => {
  const app = await new ExpertRouter(new LocalFirstGeneratedAppModel()).generateApp({
    message: "帮我做一个中文移动优先的旅游手帐 Web App，数据只用浏览器本地状态或 localStorage，不需要登录、后台或真实云接口。",
    clarificationText: "use-case: personal; data-storage: local",
    context: { summary: "Workspace files: 0", files: [], gitStatus: "" },
  });
  const packageJson = JSON.parse(app.files.find((file) => file.path === "package.json")?.content ?? "{}") as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.ok(app.files.some((file) => file.path === "src/lib/local-storage.ts"));
  assert.ok(!app.files.some((file) => file.path === "prisma/schema.prisma"));
  assert.ok(!app.files.some((file) => file.path === "src/lib/db.ts"));
  assert.equal(packageJson.dependencies?.["@prisma/client"], undefined);
  assert.equal(packageJson.devDependencies?.prisma, undefined);
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

test("experience blueprint produces real content, controls, and acceptance scenarios", async () => {
  const brief = await router().createDesignBrief({
    message: "生成一个移动优先的上海旅行规划应用，包含首页、行程、地点详情和我的收藏。",
    clarificationText: "scope: 城市周末游",
    context: { summary: "", files: [], gitStatus: "" },
  });
  const blueprint = createExperienceBlueprint({
    message: "生成一个移动优先的上海旅行规划应用",
    clarificationText: "scope: 城市周末游",
    designBrief: { ...brief, id: "test", runId: "test", createdAt: new Date().toISOString() },
  });
  const rendered = formatExperienceBlueprintForPrompt(blueprint);

  assert.equal(blueprint.domain, "旅行计划");
  assert.ok(blueprint.contentSeed.length >= 4);
  assert.ok(blueprint.contentSeed.some((record) => /外滩|武康路|浦江/.test(record.title)));
  assert.ok(blueprint.requiredControls.includes("保存路线"));
  assert.ok(blueprint.requiredControls.includes("date/period switcher"));
  assert.ok(blueprint.acceptanceScenarios.length >= 4);
  assert.match(rendered, /Content seed records/);
  assert.match(rendered, /Acceptance scenarios/);
});

test("W4: createArchitecturePlan fallback satisfies lightweight P1 hard floor", async () => {
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

  assert.ok(pageRouteCount >= 1, `expected ≥1 page route, got ${pageRouteCount}`);
  assert.ok(componentCount >= 3, `expected ≥3 components, got ${componentCount}`);
  assert.ok(modelCount >= 1, `expected ≥1 data model, got ${modelCount}`);
  assert.ok(taskCount >= 4, `expected ≥4 tasks, got ${taskCount}`);

  assert.equal(plan.dataStore.orm, "none");
  assert.equal(plan.dataStore.provider, "memory");
  assert.equal(plan.fileTree.some((file) => file.path === "prisma/schema.prisma"), false);
  assert.equal(plan.fileTree.some((file) => file.path === "src/app/loading.tsx"), false);
  assert.equal(plan.fileTree.some((file) => file.path === "src/app/error.tsx"), false);

  const blueprintTask = plan.tasks.find((task) => task.id === "task-experience-blueprint");
  assert.ok(blueprintTask, "plan must include an experience blueprint implementation task");
  assert.match(blueprintTask!.description, /Primary flow|Content records/);
  assert.ok(plan.qualityChecks?.some((check) => check.id === "quality-real-content-seed"));
  assert.ok(plan.qualityChecks?.some((check) => check.id === "quality-primary-flow-feedback"));
});
