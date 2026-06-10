import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExpertRouter } from "./expert-router.js";
import { ModelClient } from "./model-client.js";
import type { ChatWithToolsRequest, ChatWithToolsResponse, JsonGenerationRequest } from "./model-client.js";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry, createDefaultToolRegistry } from "./tools.js";
import type { ArchitecturePlanDraft } from "./expert-router.js";

function engine() {
  return new QueryEngine(
    new ExpertRouter(
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
    ),
    testTools(),
  );
}

function engineWithModel(model: ModelClient) {
  return new QueryEngine(new ExpertRouter(model), testTools());
}

function previewFirstEngineWithModel(model: ModelClient) {
  return new QueryEngine(new ExpertRouter(model), testTools(), {}, undefined, {
    maxTurns: 8,
    maxToolCallsPerTurn: 6,
    maxToolCallsTotal: 300,
    modelTurnTimeoutMs: 90_000,
    skipAcceptance: true,
  });
}

function defaultToolsWithFakeRunCommand() {
  const baseTools = createDefaultToolRegistry();
  const runCommand = baseTools.get("run_command");
  const tools = new ToolRegistry();
  for (const tool of baseTools.list()) {
    if (tool.name !== "run_command") {
      tools.register(tool);
    }
  }
  tools.register({
    name: runCommand.name,
    description: runCommand.description,
    permission: runCommand.permission,
    sandboxOnly: runCommand.sandboxOnly,
    validate: runCommand.validate,
    summarizeInput: runCommand.summarizeInput,
    summarizeOutput: runCommand.summarizeOutput,
    execute: async () => ({ exitCode: 0, output: "ok" }),
  });
  return tools;
}

function nextPackageJson() {
  return JSON.stringify({
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    dependencies: { next: "14.2.25", react: "^18.3.1", "react-dom": "^18.3.1", zod: "^3.24.1" },
    devDependencies: {
      typescript: "^5.8.0",
      "@types/node": "^22.10.0",
      "@types/react": "^18.3.12",
      "@types/react-dom": "^18.3.1",
    },
  });
}

function nextAppFiles(args: { title: string; page: string; css?: string }) {
  return [
    { path: "package.json", content: nextPackageJson() },
    { path: "next.config.mjs", content: "const nextConfig = {};\nexport default nextConfig;\n" },
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "es5",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./src/*"] },
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
    },
    { path: "next-env.d.ts", content: "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n" },
    {
      path: "src/app/layout.tsx",
      content: `import "./globals.css";\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }\n`,
    },
    { path: "src/app/page.tsx", content: args.page },
    { path: "src/app/globals.css", content: args.css ?? "body { margin: 0; } main { padding: 24px; }\n" },
  ];
}

function strictDesignSeedDraft() {
  return {
    visualConcept: "Commercial mobile clarity",
    palette: {
      name: "editorial green",
      primary: "#276749",
      surface: "#fbfaf6",
      ink: "#17221d",
      accent: "#d97706",
      muted: "#94a3a0",
    },
    typography: {
      headingFamily: "Inter, system-ui, sans-serif",
      headingWeight: "700",
      bodyFamily: "Inter, system-ui, sans-serif",
      scale: "compact",
    },
    motionLanguage: "Fast state transitions with subtle pressed feedback.",
    assets: [
      {
        filename: "src/styles/generated-identity.css",
        kind: "css-tokens",
        content: ":root { --color-primary: #276749; --color-surface: #fbfaf6; --color-ink: #17221d; --color-accent: #d97706; --color-muted: #94a3a0; }\n",
        purpose: "Strict test identity tokens.",
      },
    ],
    antiPatterns: ["No placeholder-only cards."],
  };
}

function minimalArchitecturePlanDraft(): ArchitecturePlanDraft {
  const componentFiles = [
    "AppShell",
    "MobileNavigation",
    "PrimaryActionBar",
    "RecordComposer",
    "RecordTimeline",
    "RecordDetailEditor",
    "StatsSummary",
    "SettingsPanel",
  ];
  const tasks = [
    "identity",
    "layout",
    "data",
    "home",
    "history",
    "detail",
    "stats",
    "settings",
    "states",
    "quality",
  ].map((name, index) => ({
    id: `task-${name}`,
    title: `Build ${name}`,
    description: `Implement ${name} surface and wire visible state changes.`,
    files: index < componentFiles.length ? [`src/components/${componentFiles[index]}.tsx`] : ["src/app/page.tsx"],
    dependsOn: index === 0 ? undefined : [`task-${index === 1 ? "identity" : tasksDependencyName(index - 1)}`],
    acceptance: `${name} surface is complete and quality-auditable.`,
  }));

  return {
    summary: "Minimal adapter bridge plan.",
    techStack: ["Next.js", "TypeScript"],
    stateArchitecture: "Server Components load curated records; Client Components manage filters, edit state, pending save feedback, and local persistence.",
    serverArchitecture: "Next.js App Router renders route pages, exposes a read-only items endpoint, and keeps mutation logic in client state for local-first tests.",
    dataStore: { provider: "memory", orm: "none" },
    fileTree: [
      { path: "package.json", purpose: "Package manifest." },
      { path: "next.config.mjs", purpose: "Next config." },
      { path: "tsconfig.json", purpose: "TypeScript config." },
      { path: "next-env.d.ts", purpose: "Next types." },
      { path: "src/app/layout.tsx", purpose: "Root layout." },
      { path: "src/app/page.tsx", purpose: "Home page." },
      { path: "src/app/history/page.tsx", purpose: "History route." },
      { path: "src/app/detail/page.tsx", purpose: "Detail editor route." },
      { path: "src/app/stats/page.tsx", purpose: "Stats route." },
      { path: "src/app/budget/page.tsx", purpose: "Budget route." },
      { path: "src/app/favorites/page.tsx", purpose: "Favorites route." },
      { path: "src/app/globals.css", purpose: "Global CSS." },
      ...componentFiles.map((component) => ({
        path: `src/components/${component}.tsx`,
        purpose: `${component} component.`,
      })),
    ],
    dataModels: [
      {
        name: "RecordItem",
        description: "Primary record rendered in home, history, detail, and stats surfaces.",
        fields: [
          { name: "id", type: "string" },
          { name: "title", type: "string" },
          { name: "rating", type: "number" },
        ],
      },
      {
        name: "RecordFilter",
        description: "Visible filter state used by timeline and stats.",
        fields: [
          { name: "id", type: "string" },
          { name: "label", type: "string" },
          { name: "active", type: "boolean" },
        ],
      },
      {
        name: "RecordAction",
        description: "Pending/success/error feedback for save, edit, and delete actions.",
        fields: [
          { name: "id", type: "string" },
          { name: "kind", type: "string" },
          { name: "state", type: "string" },
        ],
      },
    ],
    components: componentFiles.map((component) => ({
      name: component,
      filePath: `src/components/${component}.tsx`,
      purpose: `${component} implements a concrete product surface or reusable control.`,
    })),
    routes: [
      { path: "/", component: "HomeSurface", description: "Home", filePath: "src/app/page.tsx", rendering: "server" },
      { path: "/history", component: "HistorySurface", description: "History", filePath: "src/app/history/page.tsx", rendering: "server" },
      { path: "/detail", component: "DetailSurface", description: "Detail", filePath: "src/app/detail/page.tsx", rendering: "server" },
      { path: "/stats", component: "StatsSurface", description: "Stats", filePath: "src/app/stats/page.tsx", rendering: "server" },
      { path: "/budget", component: "StatsSurface", description: "Budget", filePath: "src/app/budget/page.tsx", rendering: "server" },
      { path: "/favorites", component: "HistorySurface", description: "Favorites", filePath: "src/app/favorites/page.tsx", rendering: "server" },
    ],
    apiEndpoints: [],
    serverActions: [],
    envVars: [],
    integrations: [],
    qualityChecks: [
      {
        id: "interaction-model-completeness",
        category: "interaction",
        requirement: "Primary controls expose pending, success, empty, and editing states.",
        evidence: "Client state, handlers, labels, and route surfaces.",
        blocking: true,
      },
    ],
    externalCapabilities: [],
    deployment: "Next build.",
    tasks,
    risks: [],
  };
}

function tasksDependencyName(index: number) {
  return ["identity", "layout", "data", "home", "history", "detail", "stats", "settings", "states", "quality"][index] ?? "identity";
}

class FakeClarifierModel extends ModelClient {
  readonly requests: JsonGenerationRequest[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { clarifier: "test-model" },
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
    this.requests.push(request);
    return {
      summary: "我需要确认演唱会抢票里的排队、票档和失败兜底，避免做成普通活动页。",
      questions: [
        {
          id: "ticketing-flow",
          header: "抢票流程",
          question: "这个 App 首版要重点模拟哪段抢票流程？",
          options: [
            { label: "排队进场", value: "排队进场", description: "突出倒计时、排队进度和入场状态。" },
            { label: "选票支付", value: "选票支付", description: "突出票档选择、锁票和支付确认。" },
          ],
          required: true,
        },
      ],
    } as T;
  }
}

class FakeReadyClarifierModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { clarifier: "test-model", design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "clarifier") {
      return {
        action: "ready",
        summary: "需求已经足够生成第一版候选。",
        questions: [],
      } as T;
    }
    if (request.role === "design_director") {
      return {
        summary: "清晰的移动端旅行产品 brief。",
        targetUser: "周末城市探索用户",
        productGoal: "生成旅行灵感与路线详情",
        coreExperience: "浏览灵感并保存路线",
        screens: ["灵感", "路线详情", "收藏"],
        interactionModel: ["底部导航", "收藏按钮"],
        visualDirection: ["旅行杂志感"],
        contentStrategy: ["真实城市路线"],
        qualityBar: ["移动端清晰"],
        antiPatterns: ["通用白卡"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 88,
        summary: "视觉检查通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }
    return {
      title: "旅行灵感",
      summary: "模型判断无需澄清后生成候选。",
      files: nextAppFiles({
        title: "旅行灵感",
        page: "export default function HomePage() { return <main><h1>旅行灵感</h1><button>保存路线</button></main>; }",
        css: ":root { --paper: #f6efe1; } body { margin: 0; background: var(--paper); } main { padding: 24px; }",
      }),
    } as T;
  }
}

class FakeCoderMissingTsConfigModel extends ModelClient {
  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model" },
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
    if (request.role === "design_director") {
      return {
        summary: "移动端旅行规划设计 brief。",
        targetUser: "独立旅行者",
        productGoal: "生成可用的旅行规划体验",
        coreExperience: "探索地点并保存行程",
        screens: ["探索", "我的行程"],
        interactionModel: ["底部导航", "收藏状态"],
        visualDirection: ["内容杂志感"],
        contentStrategy: ["真实地点内容"],
        qualityBar: ["移动端首屏清晰"],
        antiPatterns: ["通用白卡模板"],
      } as T;
    }
    assert.equal(request.role, "coder");
    assert.match(request.user, /Design Brief/);
    return {
      title: "旅行计划",
      summary: "缺少 tsconfig 的模型输出也应被 runtime 补齐。",
      files: [
        ...nextAppFiles({
          title: "旅行计划",
          page: [
            "export default function HomePage() {",
            "  const places = ['静安寺晨访', '武康路午后', '外滩夜风'];",
            "  return <main><nav aria-label=\"旅行导航\"><a href=\"#explore\">探索</a><a href=\"#saved\">我的行程</a><a href=\"#status\">状态</a></nav><header className=\"surface\"><p>旅行计划</p><h1>把上海一天压成三段轻行程</h1><p>保存中状态已准备，保存成功后会进入我的行程；如果网络异常，可以点重试。</p></header><section className=\"surface\" id=\"explore\"><h2>探索路线</h2><button aria-pressed=\"true\">全部</button><button aria-pressed=\"false\">景点</button><button aria-pressed=\"false\">餐饮</button>{places.map((place) => <article key={place}><h3>{place}</h3><p>适合独立旅行者，含交通建议、停留时间和附近备选。</p><button>保存行程</button><button>查看详情</button></article>)}</section><section className=\"surface\" id=\"saved\"><h2>我的行程</h2><p>已保存 2 段路线，保存成功。</p><p className=\"empty-state\">没有符合筛选的收藏时，会显示这条行动提示。</p><button>编辑</button><button>删除</button></section><section className=\"surface\" id=\"status\"><h2>恢复状态</h2><p role=\"alert\">遇到错误时可以重试，不会丢失已保存路线。</p><button>重试</button></section></main>;",
            "}",
          ].join("\n"),
          css: ":root { --paper: #fbf6ed; --ink: #1f221c; --accent: #b66a34; } body { margin: 0; background: var(--paper); color: var(--ink); font-family: Inter, sans-serif; } main { width: min(100%, 430px); margin: 0 auto; padding: 18px; } nav { display: flex; gap: 8px; } .surface, article { border: 1px solid rgba(31,34,28,.18); border-radius: 8px; padding: 14px; margin: 12px 0; background: white; } button { min-height: 36px; border-radius: 8px; } button[aria-pressed='true'] { outline: 2px solid var(--accent); }",
        }),
        { path: "src/components/AppShell.tsx", content: "export function AppShell({ children }: { children: React.ReactNode }) { return <main>{children}</main>; }\n" },
        { path: "src/components/RouteCard.tsx", content: "export function RouteCard({ title }: { title: string }) { return <article><h2>{title}</h2><button>保存</button></article>; }\n" },
        { path: "src/components/EmptyState.tsx", content: "export function EmptyState() { return <p className=\"empty-state\">没有收藏路线。</p>; }\n" },
      ],
    } as T;
  }
}

class FakePlaceholderRepairModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model", repairer: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "国内景点探索设计 brief。",
        targetUser: "独立旅行者",
        productGoal: "发现并收藏国内目的地",
        coreExperience: "探索景点详情并保存",
        screens: ["探索", "详情", "收藏"],
        interactionModel: ["底部导航", "收藏按钮"],
        visualDirection: ["旅行杂志感"],
        contentStrategy: ["具体景点、交通和时长"],
        qualityBar: ["无占位内容"],
        antiPatterns: ["Lorem ipsum"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "移动端视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }
    const details =
      request.role === "repairer"
        ? "适合独立旅行者的国内目的地推荐，包含游玩时长、交通提示和收藏建议。"
        : "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
    return {
      title: "旅行探索",
      summary: request.role === "repairer" ? "已替换占位内容。" : "包含占位内容的初稿。",
      files: nextAppFiles({
        title: "旅行探索",
        page: `export default function HomePage() { return <main><h1>旅行探索</h1><p>${details}</p></main>; }`,
      }),
    } as T;
  }
}

class FakeVisualRepairModel extends ModelClient {
  readonly roles: string[] = [];
  private visualCalls = 0;

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model", repairer: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "旅行杂志风移动端设计 brief。",
        targetUser: "周末城市探索用户",
        productGoal: "发现并保存旅行灵感",
        coreExperience: "从灵感进入路线详情",
        screens: ["灵感", "路线", "收藏"],
        interactionModel: ["底部导航", "路线切换", "收藏状态"],
        visualDirection: ["移动旅行杂志", "高质感首屏"],
        contentStrategy: ["具体目的地和时间安排"],
        qualityBar: ["不能是通用白卡"],
        antiPatterns: ["通用白卡列表"],
      } as T;
    }
    if (request.role === "visual_critic") {
      this.visualCalls += 1;
      return {
        status: this.visualCalls === 1 ? "failed" : "passed",
        score: this.visualCalls === 1 ? 62 : 91,
        summary: this.visualCalls === 1 ? "视觉太像通用白卡列表。" : "视觉返工后通过。",
        issues: this.visualCalls === 1 ? ["视觉太像通用白卡列表"] : [],
        repairInstructions: this.visualCalls === 1 ? ["重写首屏为旅行杂志式移动布局"] : [],
      } as T;
    }

    const repaired = request.role === "repairer";
    return {
      title: "周末旅行灵感",
      summary: repaired ? "已完成视觉返工。" : "初稿通过构建但视觉普通。",
      files: nextAppFiles({
        title: "周末旅行灵感",
        page: repaired
          ? "export default function HomePage() { return <main><section><p>Shanghai Weekend</p><h1>梧桐树下的周末路线</h1><button>保存路线</button></section></main>; }"
          : "export default function HomePage() { return <main><h1>旅行 App</h1><article>地点卡片</article><article>地点卡片</article></main>; }",
        css: repaired
          ? ":root { --ink: #1d2a24; --paper: #f5ead2; } body { margin: 0; font-family: 'Avenir Next', sans-serif; background: var(--paper); } main { min-height: 100vh; padding: 22px; } section { min-height: 70vh; display: flex; flex-direction: column; justify-content: flex-end; } h1 { font-size: 44px; line-height: 1; }"
          : "body { margin: 0; font-family: sans-serif; background: white; } main { padding: 24px; } article { background: white; margin: 12px; }",
      }),
    } as T;
  }
}

class FakeMinorVisualIssueModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model", repairer: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "本地存储日记移动端设计 brief。",
        targetUser: "想快速记录情绪和日记的个人用户",
        productGoal: "用本地存储保存日记和情绪标签",
        coreExperience: "选择心情、写日记、保存并回看历史",
        screens: ["今日记录", "历史", "情绪统计"],
        interactionModel: ["心情选择", "保存按钮", "历史筛选"],
        visualDirection: ["温暖纸感", "柔和心情色"],
        contentStrategy: ["具体心情和日记样例"],
        qualityBar: ["移动端清晰", "保存状态明确"],
        antiPatterns: ["通用白卡"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "failed",
        score: 74,
        summary: "Well-crafted diary app with warm aesthetic, mood selection, and local storage. Minor issues present.",
        issues: ["Minor polish issue: history card spacing could be tighter."],
        repairInstructions: ["Optional polish: tighten history card spacing."],
      } as T;
    }
    return {
      title: "温柔日记",
      summary: "带心情选择和本地存储的日记应用。",
      files: nextAppFiles({
        title: "温柔日记",
        page: "export default function HomePage() { return <main><h1>温柔日记</h1><p>选择今天的心情，写下一段日记并保存到本地。</p><button>保存日记</button></main>; }",
        css: ":root { --paper: #fff8ee; --ink: #201a16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { padding: 24px; }",
      }),
    } as T;
  }
}

class FakeTravelVisualFalseNegativeModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: {
        design_director: "test-model",
        design_seed_smith: "test-model",
        architect: "test-model",
        coder: "test-model",
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海双人旅行规划器设计 brief。",
        targetUser: "节假日去上海旅行的双人用户",
        productGoal: "浏览三天行程、收藏必去地点、查看双人预算。",
        coreExperience: "首页横向浏览行程，进入详情，切换天气，收藏并筛选必去地点。",
        screens: ["首页", "按天行程", "地点详情", "预算", "收藏"],
        interactionModel: ["天气切换", "收藏", "必去筛选", "预算分类", "横向滑动行程卡"],
        visualDirection: ["文艺旅行手帐"],
        contentStrategy: ["真实上海地点、预算和路线文案"],
        qualityBar: ["控件必须有源码证据"],
        antiPatterns: ["空收藏页", "只有单人预算"],
      } as T;
    }
    if (request.role === "design_seed_smith") {
      return strictDesignSeedDraft() as T;
    }
    if (request.role === "architect") {
      return minimalArchitecturePlanDraft() as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "failed",
        score: 62,
        summary:
          "App is structurally complete with all required screens and working interactions, but missing key design details.",
        issues: [
          "no '必去' filter in favorites",
          "no double total in budget",
          "home page lacks horizontal scrolling",
          "slight viewport overflow",
        ],
        blockingIssues: [
          "no '必去' filter in favorites",
          "no double total in budget",
          "home page lacks horizontal scrolling",
        ],
        repairInstructions: [
          "Add the favorites 必去 filter.",
          "Add the double total budget card.",
          "Add horizontal scrolling to the home day cards.",
        ],
      } as T;
    }

    return {
      title: "沪上漫游",
      summary: "完整上海旅行规划器。",
      files: [
        ...nextAppFiles({
          title: "沪上漫游",
          page: [
            "import Link from 'next/link';",
            "import { days, places } from '@/lib/demo-data';",
            "import BottomNav from '@/components/BottomNav';",
            "export default function HomePage() {",
            "  return <main><nav><Link href=\"/trips/1\">行程</Link><Link href=\"/budget\">预算</Link><Link href=\"/favorites\">收藏</Link></nav><h1>沪上漫游</h1><section className=\"scroll-x\">{days.map((day) => <article key={day.day}><Link href={`/trips/${day.day}`}>Day {day.day}</Link>{places.slice(0, 4).map((place) => <article key={place.id}><h2>{place.name}</h2><Link href={`/places/${place.id}`}>查看详情</Link><button>收藏</button></article>)}</article>)}</section><BottomNav /></main>;",
            "}",
          ].join("\n"),
          css: [
            "*, *::before, *::after { box-sizing: border-box; }",
            "body { margin: 0; background: #fbf7ef; color: #17221d; }",
            "main { max-width: 480px; margin: 0 auto; padding: 20px 16px 88px; }",
            ".scroll-x { display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; }",
            ".scroll-x > * { flex: 0 0 78%; scroll-snap-align: start; }",
          ].join("\n"),
        }),
        {
          path: "src/app/trips/[day]/page.tsx",
          content:
            "import Link from 'next/link';\nexport default function TripDayPage() { return <main><h1>第一天：静安漫步</h1><button>晴天模式</button><button>雨天模式</button><Link href=\"/places/jingan-temple\">静安寺详情</Link><Link href=\"/favorites\">收藏</Link></main>; }\n",
        },
        {
          path: "src/app/places/[id]/page.tsx",
          content:
            "export default function PlacePage() { return <main><h1>静安寺</h1><p>清晨抵达，先在寺前广场和南京西路慢走。</p><button>收藏</button><button>标记必去</button><a href=\"/trips/1\">返回行程</a></main>; }\n",
        },
        {
          path: "src/app/budget/page.tsx",
          content: [
            "\"use client\";",
            "import { useState } from 'react';",
            "const categoryTotals = { food: 360, ticket: 160, transport: 96 };",
            "export default function BudgetPage() {",
            "  const [active, setActive] = useState('all');",
            "  const visibleTotal = Object.values(categoryTotals).reduce((sum, value) => sum + value, 0);",
            "  return <main><h1>预算</h1><button aria-pressed={active === 'food'} onClick={() => setActive('food')}>餐饮</button><button aria-pressed={active === 'ticket'} onClick={() => setActive('ticket')}>门票</button><p>每人预算 ￥{visibleTotal}</p><p>双人合计 ￥{visibleTotal * 2}</p></main>;",
            "}",
          ].join("\n"),
        },
        {
          path: "src/app/favorites/page.tsx",
          content: [
            "\"use client\";",
            "import { useState } from 'react';",
            "const favoritePlaces = [{ id: 'jingan-temple', name: '静安寺', type: 'attraction', starred: true }, { id: 'fu-restaurant', name: '福兰小馆', type: 'food', starred: false }];",
            "export default function FavoritesPage() {",
            "  const [activeFilter, setActiveFilter] = useState('all');",
            "  const filtered = favoritePlaces.filter((place) => activeFilter === 'all' || (activeFilter === 'starred' ? place.starred : place.type === activeFilter));",
            "  return <main><h1>收藏地点</h1><section><button aria-pressed={activeFilter === 'all'} onClick={() => setActiveFilter('all')}>全部</button><button aria-pressed={activeFilter === 'attraction'} onClick={() => setActiveFilter('attraction')}>景点</button><button aria-pressed={activeFilter === 'food'} onClick={() => setActiveFilter('food')}>餐饮</button><button aria-pressed={activeFilter === 'starred'} onClick={() => setActiveFilter('starred')}>必去</button></section>{filtered.map((place) => <article key={place.id}><h2>{place.name}</h2><button>移除</button><button>标记必去</button></article>)}</main>;",
            "}",
          ].join("\n"),
        },
        {
          path: "src/components/BottomNav.tsx",
          content:
            "import Link from 'next/link';\nexport default function BottomNav() { return <nav className=\"bottom-nav\"><Link href=\"/trips/1\">行程</Link><Link href=\"/budget\">预算</Link><Link href=\"/favorites\">收藏</Link></nav>; }\n",
        },
        {
          path: "src/lib/demo-data.ts",
          content:
            "export const places = [{ id: 'jingan-temple', name: '静安寺' }, { id: 'fu-restaurant', name: '福兰小馆' }, { id: 'the-bund', name: '外滩' }, { id: 'wukang-road', name: '武康路' }];\nexport const days = [{ day: 1 }, { day: 2 }, { day: 3 }];\n",
        },
      ],
    } as T;
  }
}

class FakeLoadingRepairSafetyModel extends ModelClient {
  readonly roles: string[] = [];
  private visualCalls = 0;

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model", repairer: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "商务旅行移动端设计 brief。",
        targetUser: "经常出差的商务旅行者",
        productGoal: "快速查看行程并探索当地商务活动",
        coreExperience: "首屏展示今日行程、会议地点和探索建议",
        screens: ["行程", "探索", "个人"],
        interactionModel: ["底部导航", "行程卡片", "添加按钮"],
        visualDirection: ["高效工具感", "移动端清晰"],
        contentStrategy: ["具体会议、航班、酒店和商务活动"],
        qualityBar: ["首屏必须直接显示核心内容"],
        antiPatterns: ["首屏空白", "模拟加载遮挡内容"],
      } as T;
    }
    if (request.role === "visual_critic") {
      this.visualCalls += 1;
      if (this.visualCalls === 1) {
        return {
          status: "failed",
          score: 58,
          summary: "首稿没有体现商务旅行 brief。",
          issues: ["没有展示商务行程内容"],
          repairInstructions: ["重写为商务旅行首屏"],
        } as T;
      }
      if (this.visualCalls === 2) {
        assert.match(request.user, /useState\(true\)/);
        return {
          status: "failed",
          score: 64,
          summary: "加载状态导致首屏空白，截图只显示标题和底部导航。",
          issues: ["初始加载状态导致首屏空白"],
          repairInstructions: ["移除阻塞首屏的模拟加载状态"],
        } as T;
      }
      assert.match(request.user, /useState\(false\)/);
      return {
        status: "passed",
        score: 90,
        summary: "首屏核心内容已直接呈现。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    const repaired = request.role === "repairer";
    const page = repaired
      ? [
          "\"use client\";",
          "import { useEffect, useState } from 'react';",
          "export default function HomePage() {",
          "  const [loading, setLoading] = useState(true);",
          "  useEffect(() => {",
          "    const timer = setTimeout(() => setLoading(false), 1500);",
          "    return () => clearTimeout(timer);",
          "  }, []);",
          "  if (loading) return <main><h1>商务旅行</h1><nav>行程 探索 个人</nav></main>;",
          "  return <main><h1>商务旅行</h1><section><h2>今日上海出差</h2><p>09:30 虹桥抵达，11:00 客户会议，19:00 行业晚宴。</p></section><nav>行程 探索 个人</nav></main>;",
          "}",
        ].join("\n")
      : "export default function HomePage() { return <main><h1>旅行 App</h1><p>景点探索</p></main>; }";
    return {
      title: "商务旅行",
      summary: repaired ? "已改成商务旅行，但误加了阻塞首屏的加载状态。" : "初稿内容偏通用。",
      files: nextAppFiles({
        title: "商务旅行",
        page,
        css: ":root { --ink: #111820; --paper: #f4f7fb; --accent: #1f6feb; } body { margin: 0; font-family: Inter, system-ui, sans-serif; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; } section { background: #eef5ff; padding: 18px; border-radius: 18px; } nav { position: fixed; left: 0; right: 0; bottom: 0; padding: 16px; background: white; }",
      }),
    } as T;
  }
}

class FakeStoreLoadingRepairModel extends ModelClient {
  readonly roles: string[] = [];
  private visualCalls = 0;

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "餐厅手帐本地记录产品 brief。",
        targetUser: "记录餐厅体验的个人用户",
        productGoal: "保存餐厅体验并按月份筛选回顾",
        coreExperience: "加载本地记录、查看历史、保存设置",
        screens: ["今日记录", "历史筛选", "设置"],
        interactionModel: ["本地存储", "筛选按钮", "保存反馈"],
        visualDirection: ["温暖纸感"],
        contentStrategy: ["餐厅、菜品、评分和心情"],
        qualityBar: ["首屏不能卡在加载中"],
        antiPatterns: ["loading 卡死"],
      } as T;
    }
    if (request.role === "visual_critic") {
      this.visualCalls += 1;
      if (this.visualCalls === 1) {
        assert.doesNotMatch(request.user, /try\s*\{/);
        return {
          status: "failed",
          score: 20,
          summary: "App remains stuck on loading screen because localStorage seed initialization can throw before setLoading(false).",
          issues: ["Loading state never transitions to main UI", "Seed data not initialized or store fails to load"],
          repairInstructions: ["Wrap localStorage and seed data initialization in try/catch/finally and always call setLoading(false)."],
        } as T;
      }
      assert.match(request.user, /finally\s*\{\s*setLoading\(false\);/);
      return {
        status: "passed",
        score: 90,
        summary: "首屏能稳定进入餐厅手帐主界面。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "食记",
      summary: "本地餐厅手帐。",
      files: [
        ...nextAppFiles({
          title: "食记",
          page: "import App from '@/components/App';\nexport default function HomePage() { return <App />; }",
        }),
        {
          path: "src/components/App.tsx",
          content: [
            "'use client';",
            "import { useStore } from '@/lib/store';",
            "export default function App() {",
            "  const store = useStore();",
            "  if (store.loading) return <main><h1>加载中...</h1></main>;",
            "  return <main><h1>食记</h1><button onClick={() => store.setCurrentPage('history')}>历史</button><p>{store.entries.length} 条餐厅记录</p></main>;",
            "}",
          ].join("\n"),
        },
        {
          path: "src/lib/store.ts",
          content: [
            "'use client';",
            "import { useEffect, useState } from 'react';",
            "type Entry = { id: string; name: string };",
            "const STORAGE_KEY = 'shiji-entries';",
            "function generateSeedData(): Entry[] { return [{ id: 'seed-1', name: '桂满陇' }]; }",
            "export function useStore() {",
            "  const [entries, setEntries] = useState<Entry[]>([]);",
            "  const [currentPage, setCurrentPage] = useState<'home' | 'history'>('home');",
            "  const [loading, setLoading] = useState(true);",
            "  useEffect(() => {",
            "    const stored = localStorage.getItem(STORAGE_KEY);",
            "    if (stored) {",
            "      setEntries(JSON.parse(stored));",
            "    } else {",
            "      setEntries(generateSeedData());",
            "    }",
            "    setLoading(false);",
            "  }, []);",
            "  return { entries, currentPage, setCurrentPage, loading };",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeRecordFallbackAfterRepeatedVisualFailureModel extends ModelClient {
  readonly roles: string[] = [];
  private toolTurn = 0;

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model", repairer: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "餐厅手帐产品 brief。",
        targetUser: "记录用餐体验的个人用户",
        productGoal: "保存餐厅、日期、评分和备注，并按月回顾。",
        coreExperience: "今日输入、历史筛选、详情编辑、统计回顾和设置。",
        screens: ["今日记录", "历史手帐", "餐厅详情", "统计回顾", "设置"],
        interactionModel: ["日期切换", "保存反馈", "类型筛选", "编辑删除", "按月分组"],
        visualDirection: ["温暖纸感手帐", "番茄红与墨绿"],
        contentStrategy: ["真实餐厅、菜品、地点和评分"],
        qualityBar: ["不能是浅层空页面"],
        antiPatterns: ["空历史页", "缺少筛选", "加载卡死"],
      } as T;
    }
    if (request.role === "design_seed_smith") {
      return strictDesignSeedDraft() as T;
    }
    if (request.role === "architect") {
      return minimalArchitecturePlanDraft() as T;
    }
    if (request.role === "visual_critic") {
      const isFallback = request.user.includes("RecordHistorySurface") && request.user.includes("默认城市");
      return {
        status: "failed",
        score: isFallback ? 62 : 48,
        summary: isFallback
          ? "候选实现了基本功能框架，但使用预置假数据、照片缺失、时间线还可以更手帐风，评分星星可优化。"
          : "Route checks: /history status=200 headings=(none) text=0 controls=0 ; /detail/jing-an-temple status=200 headings=(none) text=0 controls=0. 交互模型不完整，缺少历史筛选、编辑删除和保存反馈。",
        issues: isFallback ? ["使用预置假数据", "照片缺失"] : ["历史页和详情页为空", "缺少筛选、编辑、删除和保存反馈"],
        repairInstructions: isFallback ? ["照片占位图可以更精致。"] : ["补齐历史、详情、统计和设置，并确保每个页面至少有真实控件。"],
      } as T;
    }

    return {
      title: "餐厅手帐",
      summary: "反复输出浅层页面。",
      files: nextAppFiles({
        title: "餐厅手帐",
        page: "export default function HomePage() { return <main><h1>餐厅手帐</h1><button>保存</button></main>; }",
        css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
      }),
    } as T;
  }

  override async chatWithTools(_request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.roles.push("coder");
    this.toolTurn += 1;
    const files = nextAppFiles({
      title: "餐厅手帐",
      page: "export default function HomePage() { return <main><h1>餐厅手帐</h1><button>保存</button></main>; }",
      css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
    });
    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
        ],
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: [
          ...files.map((file, index) => ({
            id: `call-write-${index}`,
            name: "write_file",
            arguments: JSON.stringify(file),
          })),
        ],
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 3) {
      return {
        content: "",
        toolCalls: minimalArchitecturePlanDraft().tasks.map((task, index) => ({
          id: `call-done-${index}`,
          name: "mark_task_done",
          arguments: JSON.stringify({ taskId: task.id }),
        })),
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 4) {
      return {
        content: "",
        toolCalls: [
          { id: "call-build", name: "run_build", arguments: "{\"skipInstall\":true}" },
          { id: "call-finish", name: "finish_app", arguments: "{\"title\":\"餐厅手帐\",\"summary\":\"反复输出浅层页面。\"}" },
        ],
        finishReason: "tool_calls",
      };
    }
    return { content: "", toolCalls: [], finishReason: "stop" };
  }
}

class FakeMediaFallbackOnIncompleteProductModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model", repairer: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "私人媒体库产品 brief。",
        targetUser: "重度记录书、电影和播客的个人用户",
        productGoal: "保存馆藏、继续记录、按时间线回看并查看统计。",
        coreExperience: "首页续录、书影音筛选、详情编辑、时间线、统计和设置。",
        screens: ["首页", "书影音", "详情编辑", "时间线", "统计", "设置"],
        interactionModel: ["筛选芯片", "保存反馈", "标记完成", "重读重看", "本地保存"],
        visualDirection: ["温暖纸感", "靛蓝与墨绿"],
        contentStrategy: ["真实书名、电影、播客和笔记"],
        qualityBar: ["不能只有首页和列表"],
        antiPatterns: ["缺少时间线", "缺少统计", "缺少设置"],
      } as T;
    }
    if (request.role === "visual_critic") {
      const isFallback = request.user.includes("MediaLibraryApp") && request.user.includes("private-media-library-v2");
      return {
        status: isFallback ? "passed" : "failed",
        score: isFallback ? 93 : 70,
        summary: isFallback
          ? "私人媒体库包含首页、书影音、时间线、统计、设置和详情编辑，交互完整。"
          : "The candidate implements a basic home screen and library with realistic Chinese content, but critically misses required screens (Timeline, Stats, Settings) and key interactions such as saving feedback, functional filters, swipe gestures, and smooth transitions. The app is incomplete for a commercial-grade product.",
        issues: isFallback ? [] : ["timeline、stats、settings 页面缺失", "保存反馈和筛选状态缺失"],
        repairInstructions: isFallback ? [] : ["Create page components for /timeline, /stats, /settings, /detail/[id] and complete the interaction model."],
      } as T;
    }

    return {
      title: "墨藏",
      summary: "只实现了首页和基础列表。",
      files: nextAppFiles({
        title: "墨藏",
        page: "export default function HomePage() { return <main><h1>墨藏</h1><button>添加记录</button><article>三体</article><article>故事FM</article></main>; }",
        css: ":root { --paper: #faf5f0; --ink: #17241f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
      }),
    } as T;
  }
}

class FakeProductCompletenessRepairModel extends ModelClient {
  readonly roles: string[] = [];
  private visualCalls = 0;

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model", repairer: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海三天两晚旅行规划产品 brief。",
        targetUser: "两位成年休闲游客",
        productGoal: "三分钟内看完路线并收藏地点",
        coreExperience: "浏览三天行程、查看地点详情、收藏地点、查看预算",
        screens: ["首页概览", "按天行程", "地点详情", "预算页", "收藏清单"],
        interactionModel: ["底部导航", "详情链接", "收藏按钮", "天气切换"],
        visualDirection: ["文艺旅行手帐", "米白墨绿暖金"],
        contentStrategy: ["静安、黄浦、徐汇的真实精选数据"],
        qualityBar: ["核心页面都可访问", "不能只有首页"],
        antiPatterns: ["单页展示假导航"],
      } as T;
    }
    if (request.role === "visual_critic") {
      this.visualCalls += 1;
      if (this.visualCalls === 1) {
        return {
          status: "failed",
          score: 55,
          summary: "只实现了首页，缺少行程页、地点详情页、预算页和收藏清单页。",
          issues: ["核心流程页面缺失"],
          repairInstructions: ["补齐 /itinerary/1、/place/jingan-temple、/budget、/favorites 等页面和真实链接"],
        } as T;
      }
      assert.match(request.user, /src\/app\/budget\/page\.tsx/);
      assert.match(request.user, /src\/app\/favorites\/page\.tsx/);
      return {
        status: "passed",
        score: 90,
        summary: "核心流程页面齐全，移动端体验可审批。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    const repaired = request.role === "repairer";
    const files = repaired
      ? [
          ...nextAppFiles({
            title: "沪上漫游",
            page: "import Link from 'next/link';\nexport default function HomePage() { return <main><h1>沪上漫游</h1><Link href=\"/itinerary/1\">查看完整行程</Link><Link href=\"/budget\">预算</Link><Link href=\"/favorites\">收藏</Link></main>; }",
          }),
          { path: "src/app/itinerary/[day]/page.tsx", content: "import Link from 'next/link';\nexport default function ItineraryPage() { return <main><h1>行程 · 第1天</h1><Link href=\"/place/jingan-temple\">静安寺详情</Link></main>; }" },
          { path: "src/app/place/[id]/page.tsx", content: "export default function PlacePage() { return <main><h1>静安寺</h1><button>加入收藏</button></main>; }" },
          { path: "src/app/budget/page.tsx", content: "export default function BudgetPage() { return <main><h1>预算汇总</h1><p>餐饮、门票和市内交通合计 2600 元。</p></main>; }" },
          { path: "src/app/favorites/page.tsx", content: "export default function FavoritesPage() { return <main><h1>我的收藏</h1><button>按类型筛选</button><button>标记必去</button></main>; }" },
        ]
      : nextAppFiles({
          title: "沪上漫游",
          page: "export default function HomePage() { return <main><h1>沪上漫游</h1><p>上海三天两晚</p></main>; }",
        });

    return {
      title: "沪上漫游",
      summary: repaired ? "已补齐核心页面和链接。" : "初稿只有首页。",
      files,
    } as T;
  }
}

class FakeCrossDomainTravelModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model", repairer: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "网球学习规划产品 brief。",
        targetUser: "刚入门的成年网球学习者",
        productGoal: "帮助用户安排训练、记录练习并复盘动作掌握度",
        coreExperience: "查看今日训练、选择技术目标、记录练习结果并获得教练反馈",
        screens: ["今日训练", "课程进度", "练习记录", "教练反馈"],
        interactionModel: ["底部导航", "训练打卡", "技术筛选", "反馈展开"],
        visualDirection: ["清爽运动训练手册"],
        contentStrategy: ["发球、正手、步伐等真实网球训练内容"],
        qualityBar: ["不能生成旅行、预算或收藏行程应用"],
        antiPatterns: ["上海旅行规划", "旅游行程", "预算合计"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "failed",
        score: 30,
        summary: "生成的 UI 是上海旅行规划应用，完全偏离用户请求的网球学习产品。",
        issues: ["领域错误：用户要网球学习 app，但候选是上海旅行规划。"],
        repairInstructions: ["必须重写成网球学习、训练计划、练习记录和反馈闭环。"],
      } as T;
    }

    return {
      title: "上海松弛旅行规划",
      summary: "一个构建通过但领域错误的上海旅行候选。",
      files: nextAppFiles({
        title: "上海松弛旅行规划",
        page: "export default function HomePage() { return <main><h1>松弛但不松散的上海三天两晚</h1><p>静安寺、黄浦、徐汇路线，预算合计 ¥348。</p><button>查看三天行程</button></main>; }",
        css: ":root { --paper: #f6efe1; --ink: #18302b; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
      }),
    } as T;
  }
}

class FakeTennisRecordFailureModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model", repairer: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "网球训练规划产品 brief。",
        targetUser: "刚入门的成年网球学习者",
        productGoal: "安排今日训练、练习记录、课程进度和教练反馈。",
        coreExperience: "选择训练目标、完成打卡、记录练习结果并查看动作反馈。",
        screens: ["今日训练", "课程进度", "练习记录", "动作反馈"],
        interactionModel: ["训练打卡", "技术筛选", "练习记录", "反馈展开"],
        visualDirection: ["清爽运动训练手册"],
        contentStrategy: ["发球、正手、反手和步伐训练内容"],
        qualityBar: ["不能切换成餐厅或手帐模板"],
        antiPatterns: ["餐厅手帐", "食记", "用餐记录"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "failed",
        score: 42,
        summary: "候选仍缺少练习记录、历史筛选、编辑删除和保存反馈，但产品领域必须保持网球训练规划。",
        issues: ["缺少练习记录历史筛选", "缺少编辑删除和保存反馈"],
        repairInstructions: ["补齐网球训练计划、练习记录、课程进度和教练反馈，不要改成餐厅记录体验。"],
      } as T;
    }

    return {
      title: "网球训练手册",
      summary: "网球训练规划候选仍然偏薄。",
      files: nextAppFiles({
        title: "网球训练手册",
        page: "export default function HomePage() { return <main><h1>网球训练手册</h1><p>今日训练：正手稳定性、步伐热身、发球落点。</p><button>记录练习</button></main>; }",
        css: ":root { --court: #edf6e8; --ink: #14231c; } body { margin: 0; background: var(--court); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
      }),
    } as T;
  }
}

class FakeBrokenStateSetterModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "旅行工具移动端设计 brief。",
        targetUser: "独立旅行者",
        productGoal: "查看行程并在底部导航中切换页面",
        coreExperience: "切换首页、行程、设置和详情",
        screens: ["首页", "行程", "详情", "设置"],
        interactionModel: ["底部导航", "详情跳转"],
        visualDirection: ["移动工具感"],
        contentStrategy: ["具体旅行行程"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["TypeScript 类型错误"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 88,
        summary: "视觉检查通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "旅行规划",
      summary: "包含常见的字面量 state setter 类型错误。",
      files: [
        ...nextAppFiles({
          title: "旅行规划",
          page: [
            "\"use client\";",
            "import { useState } from 'react';",
            "const navItems: { id: string; label: string }[] = [",
            "  { id: 'home', label: '首页' },",
            "  { id: 'trips', label: '行程' },",
            "  { id: 'settings', label: '设置' },",
            "];",
            "export default function HomePage() {",
            "  const [currentPage, setCurrentPage] = useState<'home' | 'trips' | 'settings' | 'tripDetail'>('home');",
            "  return <main><h1>{currentPage}</h1>{navItems.map((item) => <button key={item.id} onClick={() => setCurrentPage(item.id)}>{item.label}</button>)}</main>;",
            "}",
          ].join("\n"),
          css: ":root { --paper: #f6efe1; } body { margin: 0; background: var(--paper); } main { padding: 24px; }",
        }),
        {
          path: "src/lib/demo-data.ts",
          content: "export const defaultCategories = ['证件', '衣物', '药品'] as const;\n",
        },
        {
          path: "src/components/checklist/AddChecklistItemForm.tsx",
          content: [
            "\"use client\";",
            "import { useState } from 'react';",
            "import { defaultCategories } from '@/lib/demo-data';",
            "export default function AddChecklistItemForm() {",
            "  const [category, setCategory] = useState(defaultCategories[0]);",
            "  return <select value={category} onChange={(event) => setCategory(event.target.value)}>{defaultCategories.map((item) => <option key={item}>{item}</option>)}</select>;",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeContextualStringUnionModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海旅行移动端设计 brief。",
        targetUser: "休闲旅行者",
        productGoal: "查看多区旅行地点",
        coreExperience: "按区浏览地点和预算",
        screens: ["首页", "地点"],
        interactionModel: ["地点卡片"],
        visualDirection: ["移动杂志"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["联合类型遗漏数据地区"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 88,
        summary: "视觉检查通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海区县旅行",
      summary: "包含字面量联合类型遗漏的 District。",
      files: [
        ...nextAppFiles({
          title: "上海区县旅行",
          page: [
            "import { places } from '@/lib/data';",
            "export default function HomePage() {",
            "  return <main><h1>上海区县旅行</h1>{places.map((place) => <p key={place.id}>{place.name} · {place.district}</p>)}</main>;",
            "}",
          ].join("\n"),
          css: "body { margin: 0; } main { padding: 24px; }\n",
        }),
        {
          path: "src/lib/types.ts",
          content: [
            "export type District = '静安' | '黄浦' | '徐汇';",
            "export interface Place {",
            "  id: string;",
            "  name: string;",
            "  district: District;",
            "}",
          ].join("\n"),
        },
        {
          path: "src/lib/data.ts",
          content: [
            "import type { Place } from './types';",
            "export const places: Place[] = [",
            "  { id: 'jing-an', name: '静安寺', district: '静安' },",
            "  { id: 'powerlong', name: '上海宝龙美术馆', district: '闵行' },",
            "];",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeStyledJsxLoadingModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "复古日记产品设计 brief。",
        targetUser: "每日记录生活和图片的移动端用户",
        productGoal: "快速记录今日心情、图片和历史回顾",
        coreExperience: "打开即写，保存后回顾历史",
        screens: ["今日", "日历", "历史", "设置"],
        interactionModel: ["底部导航", "保存表单", "历史筛选"],
        visualDirection: ["复古纸张", "精致移动工具"],
        contentStrategy: ["真实日期、心情、图片和回顾"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["App Router 客户端边界错误"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 89,
        summary: "移动端日记产品视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "复古日记",
      summary: "包含 styled-jsx loading 文件的候选。",
      files: [
        ...nextAppFiles({
          title: "复古日记",
          page: "export default function HomePage() { return <main><h1>复古日记</h1><form><button>保存今日记录</button></form></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/app/loading.tsx",
          content: [
            "export default function Loading() {",
            "  return (",
            "    <main className=\"journal-loading\">",
            "      <p>正在准备今日内容</p>",
            "      <style jsx>{`",
            "        .journal-loading { min-height: 100vh; display: grid; place-items: center; }",
            "      `}</style>",
            "    </main>",
            "  );",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeStyledJsxComponentModel extends FakeStyledJsxLoadingModel {
  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    const response = await super.generateJson<T>(request);
    if (request.role !== "coder" && request.role !== "repairer") {
      return response;
    }
    const app = response as {
      files: Array<{ path: string; content: string }>;
    };
    return {
      ...app,
      summary: "包含 styled-jsx 普通组件的候选。",
      files: [
        ...app.files.filter((file) => file.path !== "src/app/loading.tsx"),
        {
          path: "src/app/page.tsx",
          content: "import ResourceList from '@/components/ResourceList';\nexport default function HomePage() { return <main><h1>训练资料</h1><ResourceList /></main>; }\n",
        },
        {
          path: "src/components/ResourceList.tsx",
          content: [
            "export default function ResourceList() {",
            "  return (",
            "    <section>",
            "      <a className=\"resource-item\" href=\"#\">正手基础</a>",
            "      <style jsx>{`",
            "        .resource-item { display: flex; justify-content: space-between; }",
            "      `}</style>",
            "    </section>",
            "  );",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeReexportedLocalTypeModel extends FakeStyledJsxLoadingModel {
  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    const response = await super.generateJson<T>(request);
    if (request.role !== "coder" && request.role !== "repairer") {
      return response;
    }
    const app = response as {
      files: Array<{ path: string; content: string }>;
    };
    return {
      ...app,
      summary: "包含本地类型转导出缺失的候选。",
      files: [
        ...app.files.filter((file) => file.path !== "src/app/loading.tsx"),
        {
          path: "src/app/page.tsx",
          content: "import FeedbackList from '@/components/FeedbackList';\nexport default function HomePage() { return <main><h1>练习反馈</h1><FeedbackList /></main>; }\n",
        },
        {
          path: "src/lib/types.ts",
          content: "export type Completion = { id: string; date: string; rating: number };\n",
        },
        {
          path: "src/lib/storage.ts",
          content: "import { Completion } from './types';\nexport function getCompletions(): Completion[] { return []; }\n",
        },
        {
          path: "src/components/FeedbackList.tsx",
          content: "'use client';\nimport { getCompletions, Completion } from '@/lib/storage';\nexport default function FeedbackList() { const items: Completion[] = getCompletions(); return <p>{items.length} 条反馈</p>; }\n",
        },
      ],
    } as T;
  }
}

class FakeDuplicateImportedTypeAndIconModel extends FakeStyledJsxLoadingModel {
  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    const response = await super.generateJson<T>(request);
    if (request.role !== "coder" && request.role !== "repairer") {
      return response;
    }
    const app = response as {
      files: Array<{ path: string; content: string }>;
    };
    return {
      ...app,
      summary: "包含本地 Activity 类型和 lucide Activity 图标同名导入冲突的候选。",
      files: [
        ...app.files.filter((file) => file.path !== "src/app/loading.tsx"),
        {
          path: "src/app/page.tsx",
          content:
            "import Link from 'next/link';\nexport default function HomePage() { return <main><h1>独行计划</h1><Link href=\"/trips/seed-trip\">查看行程</Link></main>; }\n",
        },
        {
          path: "src/lib/types.ts",
          content: "export interface Activity { id: string; name: string; }\nexport interface Trip { id: string; activities: Activity[]; }\n",
        },
        {
          path: "src/lib/storage.ts",
          content: "import { Trip } from './types';\nexport function getTrips(): Trip[] { return []; }\nexport function addActivity(tripId: string, activity: Activity): void { void tripId; void activity; }\n",
        },
        {
          path: "src/app/trips/[id]/page.tsx",
          content: [
            "'use client';",
            "import { getTrips, addActivity } from '@/lib/storage';",
            "import { Activity, Trip } from '@/lib/types';",
            "import { Activity } from 'lucide-react';",
            "",
            "export default function TripDetailPage() {",
            "  const trips: Trip[] = getTrips();",
            "  const first = trips[0];",
            "  const handleSave = (activity: Activity) => addActivity(first?.id ?? 'seed-trip', activity);",
            "  return <main><h1>行程详情</h1><button onClick={() => handleSave({ id: 'walk', name: '外滩漫步' })}>添加活动</button></main>;",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeConflictingBudgetTypeModel extends FakeStyledJsxLoadingModel {
  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    const response = await super.generateJson<T>(request);
    if (request.role !== "coder" && request.role !== "repairer") {
      return response;
    }
    const app = response as {
      files: Array<{ path: string; content: string }>;
    };
    return {
      ...app,
      summary: "包含重复 Budget 类型定义的旅行预算候选。",
      files: [
        ...app.files.filter((file) => file.path !== "src/app/loading.tsx"),
        {
          path: "src/app/page.tsx",
          content:
            "import Link from 'next/link';\nexport default function HomePage() { return <main><h1>梧桐漫游预算</h1><Link href=\"/budget\">打开预算</Link></main>; }\n",
        },
        {
          path: "src/types/index.ts",
          content:
            "export interface Budget { id: string; day: number; categories: Record<string, number>; total: number; }\n",
        },
        {
          path: "src/lib/types.ts",
          content:
            "export interface Budget { id: string; day: number; categories: { 餐饮: number; 门票: number; 交通: number; 其他: number }; total: number; }\n",
        },
        {
          path: "src/lib/storage.ts",
          content:
            "import type { Budget } from './types';\nexport function saveBudgetAdjustments(budgets: Budget[]): void { void budgets; }\n",
        },
        {
          path: "src/app/budget/page.tsx",
          content: [
            "'use client';",
            "import { useCallback, useState } from 'react';",
            "import type { Budget } from '@/types';",
            "import { saveBudgetAdjustments } from '@/lib/storage';",
            "",
            "const initialBudgets: Budget[] = [",
            "  { id: 'day-1', day: 1, categories: { 餐饮: 220, 门票: 160, 交通: 80, 其他: 60 }, total: 520 },",
            "];",
            "",
            "export default function BudgetPage() {",
            "  const [budgets] = useState(initialBudgets);",
            "  const [saved, setSaved] = useState(false);",
            "  const handleSave = useCallback(() => {",
            "    saveBudgetAdjustments(budgets);",
            "    setSaved(true);",
            "  }, [budgets]);",
            "  return <main><h1>预算估算</h1><button onClick={handleSave}>保存预算</button>{saved ? <p>已保存</p> : null}</main>;",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeIncompleteBudgetRangeModel extends FakeStyledJsxLoadingModel {
  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    const response = await super.generateJson<T>(request);
    if (request.role !== "coder" && request.role !== "repairer") {
      return response;
    }
    const app = response as {
      files: Array<{ path: string; content: string }>;
    };
    return {
      ...app,
      summary: "包含缺失 budgetRange.max 的旅行地点数据候选。",
      files: [
        ...app.files.filter((file) => file.path !== "src/app/loading.tsx"),
        {
          path: "src/app/page.tsx",
          content:
            "import { places } from '@/lib/demo-data';\nexport default function HomePage() { return <main><h1>上海漫游记</h1>{places.map((place) => <article key={place.id}>{place.name}</article>)}</main>; }\n",
        },
        {
          path: "src/lib/types.ts",
          content:
            "export interface Place { id: string; name: string; budgetRange: { min: number; max: number }; }\n",
        },
        {
          path: "src/lib/demo-data.ts",
          content: [
            "import type { Place } from './types';",
            "",
            "export const places: Place[] = [",
            "  {",
            "    id: 'old-lane-noodle',",
            "    name: '弄堂面馆',",
            "    budgetRange: { min: 40 },",
            "  },",
            "];",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeExcessPlacePropertyModel extends FakeStyledJsxLoadingModel {
  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    const response = await super.generateJson<T>(request);
    if (request.role !== "coder" && request.role !== "repairer") {
      return response;
    }
    const app = response as {
      files: Array<{ path: string; content: string }>;
    };
    return {
      ...app,
      summary: "包含 Place 类型缺少 tips 字段的旅行地点数据候选。",
      files: [
        ...app.files.filter((file) => file.path !== "src/app/loading.tsx"),
        {
          path: "src/app/page.tsx",
          content:
            "import { places } from '@/lib/demo-data';\nexport default function HomePage() { return <main><h1>上海漫游记</h1>{places.map((place) => <article key={place.id}>{place.name}</article>)}</main>; }\n",
        },
        {
          path: "src/lib/types.ts",
          content:
            "export interface Place { id: string; name: string; description: string; cost: number; }\n",
        },
        {
          path: "src/lib/demo-data.ts",
          content: [
            "import type { Place } from './types';",
            "",
            "export const places: Place[] = [",
            "  {",
            "    id: 'jingan-temple',",
            "    name: '静安寺',",
            "    description: '闹市里的寺院和梧桐街景。',",
            "    tips: '建议早上九点前到达。',",
            "    cost: 50,",
            "  },",
            "];",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeMissingArrayAliasExportModel extends FakeStyledJsxLoadingModel {
  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    const response = await super.generateJson<T>(request);
    if (request.role !== "coder" && request.role !== "repairer") {
      return response;
    }
    const app = response as {
      files: Array<{ path: string; content: string }>;
    };
    return {
      ...app,
      summary: "包含缺失 demoDays 导出别名的旅行数据候选。",
      files: [
        ...app.files.filter((file) => file.path !== "src/app/loading.tsx"),
        {
          path: "src/app/page.tsx",
          content:
            "import { demoDays } from '@/lib/trip-data';\nexport default function HomePage() { return <main><h1>上海漫游记</h1>{demoDays.map((day) => <article key={day.id}>{day.title}</article>)}</main>; }\n",
        },
        {
          path: "src/app/api/itinerary/route.ts",
          content:
            "import { NextResponse } from 'next/server';\nimport { demoDays } from '@/lib/trip-data';\nexport async function GET() { return NextResponse.json({ days: demoDays }); }\n",
        },
        {
          path: "src/lib/trip-data.ts",
          content: [
            "export const tripDays = [",
            "  { id: 'day-1', title: '静安漫步' },",
            "  { id: 'day-2', title: '外滩夜景' },",
            "];",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeInvalidJsxAttributeModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "日记应用移动端设计 brief。",
        targetUser: "每天记录日记和心情的个人用户",
        productGoal: "快速进入今天的日记并查看历史记录",
        coreExperience: "打开今日日记、记录内容、返回首页",
        screens: ["今日", "历史", "设置", "404"],
        interactionModel: ["日期链接", "底部导航", "保存按钮"],
        visualDirection: ["温暖纸张日记感"],
        contentStrategy: ["真实日期、心情和记录入口"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["JSX 属性字符串拼接语法错误"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "日记体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "日记小册",
      summary: "包含 not-found 页面 JSX 属性拼接语法错误的候选。",
      files: [
        ...nextAppFiles({
          title: "日记小册",
          page: "export default function HomePage() { return <main><h1>日记小册</h1><a href=\"/diary/today\">打开今天</a><button>保存记录</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/app/not-found.tsx",
          content: [
            "import Link from 'next/link';",
            "",
            "export default function NotFound() {",
            "  return (",
            "    <div className=\"empty-state\">",
            "      <h2>页面未找到</h2>",
            "      <Link",
            "        href=\"/diary/\" + new Date().toISOString().slice(0, 10)",
            "        className=\"empty-action\"",
            "      >",
            "        回到今天",
            "      </Link>",
            "    </div>",
            "  );",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeLooseTruthyFilterModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "收藏旅行产品设计 brief。",
        targetUser: "整理目的地收藏的旅行者",
        productGoal: "让用户收藏地点并标记必去",
        coreExperience: "收藏、筛选、标记和取消收藏",
        screens: ["首页", "收藏", "预算", "设置"],
        interactionModel: ["收藏按钮", "必去切换", "筛选标签"],
        visualDirection: ["精致旅行工具"],
        contentStrategy: ["真实目的地和收藏状态"],
        qualityBar: ["TypeScript strict 构建必须通过"],
        antiPatterns: ["filter(Boolean) 后继续当作非空对象使用"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "收藏体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海收藏行程",
      summary: "包含 filter(Boolean) 非空收窄问题的收藏页。",
      files: nextAppFiles({
        title: "上海收藏行程",
        page: [
          "\"use client\";",
          "type Place = { id: string; name: string };",
          "const places: Place[] = [{ id: 'bund', name: '外滩' }];",
          "function getPlace(id: string): Place | undefined { return places.find((place) => place.id === id); }",
          "function toggleMustGo(id: string) { return id; }",
          "export default function HomePage() {",
          "  const favoritePlaces = ['bund'].map((id) => getPlace(id)).filter(Boolean).map((place) => ({ ...place, isMustGo: false }));",
          "  return <main>{favoritePlaces.map((place) => <button key={place!.id} onClick={() => toggleMustGo(place!.id)}>{place!.name}</button>)}</main>;",
          "}",
        ].join("\n"),
        css: ":root { --paper: #f6efe1; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
      }),
    } as T;
  }
}

class FakeOptionalImageSrcModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "旅行灵感产品设计 brief。",
        targetUser: "收藏地点灵感的旅行者",
        productGoal: "展示地点图片、说明和收藏动作",
        coreExperience: "灵感卡片、地点图片和底部导航",
        screens: ["首页", "灵感", "收藏", "设置"],
        interactionModel: ["图片卡片", "收藏按钮", "筛选"],
        visualDirection: ["精致旅行手帐"],
        contentStrategy: ["真实地点图片和说明"],
        qualityBar: ["可选图片字段不能阻塞构建"],
        antiPatterns: ["把 string | undefined 直接传给 img src"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "图片卡片视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "旅行灵感卡片",
      summary: "包含可选图片字段直接传入 img src 的候选。",
      files: nextAppFiles({
        title: "旅行灵感卡片",
        page: [
          "type Place = { id: string; title: string; image?: string };",
          "const places: Place[] = [{ id: 'bund', title: '外滩' }];",
          "export default function HomePage() {",
          "  return <main>{places.map((place) => (",
          "    <article key={place.id}>",
          "      <img src={place.image} alt={place.title} />",
          "      <h2>{place.title}</h2>",
          "    </article>",
          "  ))}<button>收藏灵感</button></main>;",
          "}",
        ].join("\n"),
        css: ":root { --paper: #f6efe1; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
      }),
    } as T;
  }
}

class FakeInvalidOptionalEnvComparisonModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "本地美食手帐产品设计 brief。",
        targetUser: "记录餐厅体验的移动端用户",
        productGoal: "填写餐厅、评分、日期并回看历史手帐",
        coreExperience: "输入餐厅记录、保存、按月份筛选并编辑历史记录",
        screens: ["今日记录", "历史手帐", "统计回顾", "设置"],
        interactionModel: ["日期切换", "保存状态", "月份筛选", "编辑删除"],
        visualDirection: ["温暖纸感手帐"],
        contentStrategy: ["真实餐厅、菜品、评分和备注"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["非法 optional chaining 环境变量比较"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 91,
        summary: "美食手帐视觉和交互检查通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "餐厅手帐",
      summary: "包含非法 optional chaining 环境变量比较的候选。",
      files: [
        ...nextAppFiles({
          title: "餐厅手帐",
          page: [
            "import { shouldSeed } from '@/lib/prisma';",
            "",
            "export default function HomePage() {",
            "  return <main><h1>餐厅手帐</h1><p>{shouldSeed() ? '本地记录已准备' : '线上记录模式'}</p><button>保存记录</button></main>;",
            "}",
          ].join("\n"),
          css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/prisma.ts",
          content: [
            "export function shouldSeed() {",
            "  return process.env.NODE_ENV !== 'production' || process.env.VERCEL?. !== '1';",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeDuplicateObjectKeyModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "旅行手帐数据产品 brief。",
        targetUser: "记录旅迹并查看统计的旅行者",
        productGoal: "首页和统计 API 都必须能稳定运行",
        coreExperience: "打开首页、查看地点记录、读取统计数据",
        screens: ["首页", "统计", "地图", "我的"],
        interactionModel: ["底部导航", "统计接口", "记录列表"],
        visualDirection: ["温暖纸张旅行手帐"],
        contentStrategy: ["真实旅行记录"],
        qualityBar: ["构建和预览前 smoke 必须通过"],
        antiPatterns: ["重复对象 key 导致 TypeScript 编译失败"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "移动端旅行手帐视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "旅迹手帐",
      summary: "包含重复对象 key 的 stats route。",
      files: [
        ...nextAppFiles({
          title: "旅迹手帐",
          page: "export default function HomePage() { return <main><h1>旅迹手帐</h1><p>查看已保存旅迹、地点统计和地图足迹。</p><button>新建记录</button></main>; }",
          css: ":root { --paper: #fff8df; --ink: #432424; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/app/api/entries/stats/route.ts",
          content: [
            "import { NextResponse } from 'next/server';",
            "import prisma from '@/lib/db';",
            "",
            "export async function GET() {",
            "  const total = await prisma.entry.count();",
            "  const locations = await prisma.entry.count({",
            "    where: { location: { not: null }, location: { not: '' } },",
            "  });",
            "  return NextResponse.json({ total, locations });",
            "}",
          ].join("\n"),
        },
        {
          path: "src/lib/db.ts",
          content: "export default { entry: { count: async () => 0 } };\n",
        },
      ],
    } as T;
  }
}

class FakePrismaDateTypeMismatchModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "旅行手帐详情页产品 brief。",
        targetUser: "查看旅迹详情的旅行者",
        productGoal: "首页和详情页都能读取 Prisma 记录并显示日期",
        coreExperience: "打开详情、查看日期、编辑和删除记录",
        screens: ["首页", "详情", "编辑", "统计"],
        interactionModel: ["详情跳转", "编辑删除", "日期展示"],
        visualDirection: ["温暖纸张旅行手帐"],
        contentStrategy: ["真实旅行记录"],
        qualityBar: ["Prisma Date 类型必须能通过构建"],
        antiPatterns: ["把 Prisma Date 直接传给只接收 string 的组件类型"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "详情页日期展示通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "旅迹详情",
      summary: "包含 Prisma Date 与组件 string 类型不匹配的候选。",
      files: [
        ...nextAppFiles({
          title: "旅迹详情",
          page: "export default function HomePage() { return <main><h1>旅迹详情</h1><p>打开详情查看日期。</p><button>查看详情</button></main>; }",
          css: ":root { --paper: #fff8df; --ink: #432424; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/app/entry/[id]/page.tsx",
          content: [
            "import EntryDetail from '@/components/EntryDetail';",
            "import prisma from '@/lib/db';",
            "",
            "export default async function EntryPage() {",
            "  const entry = await prisma.entry.findUnique({ where: { id: 1 } });",
            "  if (!entry) return null;",
            "  return <EntryDetail entry={entry} />;",
            "}",
          ].join("\n"),
        },
        {
          path: "src/components/EntryDetail.tsx",
          content: [
            "'use client';",
            "",
            "interface Entry {",
            "  id: number;",
            "  title: string;",
            "  date: string;",
            "  createdAt?: string;",
            "  updatedAt?: string;",
            "}",
            "",
            "export default function EntryDetail({ entry }: { entry: Entry }) {",
            "  return <article><h1>{entry.title}</h1><time>{new Date(entry.date).toLocaleDateString('zh-CN')}</time></article>;",
            "}",
          ].join("\n"),
        },
        {
          path: "src/lib/db.ts",
          content: [
            "export default {",
            "  entry: {",
            "    findUnique: async () => ({ id: 1, title: '外滩夜行', date: new Date(), createdAt: new Date(), updatedAt: new Date() }),",
            "  },",
            "};",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeLocallyDeclaredMissingExportModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "餐厅手帐历史页产品设计 brief。",
        targetUser: "整理餐厅体验的个人用户",
        productGoal: "查看历史记录并进入详情编辑",
        coreExperience: "历史分组、筛选、记录卡片和编辑入口",
        screens: ["首页", "历史", "详情", "设置"],
        interactionModel: ["月份筛选", "记录编辑", "删除恢复"],
        visualDirection: ["温暖纸感手帐"],
        contentStrategy: ["真实餐厅记录"],
        qualityBar: ["跨文件类型导入必须构建通过"],
        antiPatterns: ["本地声明的类型忘记导出"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "历史记录体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "餐厅历史",
      summary: "包含本地声明类型未导出的候选。",
      files: [
        ...nextAppFiles({
          title: "餐厅历史",
          page: [
            "import { records, Record } from '@/lib/data';",
            "",
            "export default function HomePage() {",
            "  const latest: Record = records[0];",
            "  return <main><h1>餐厅历史</h1><p>{latest.title}</p><button>编辑记录</button></main>;",
            "}",
          ].join("\n"),
          css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/data.ts",
          content: [
            "type Record = { id: string; title: string; month: string };",
            "",
            "export const records: Record[] = [",
            "  { id: 'r1', title: '晚餐手帐', month: '2026-05' },",
            "];",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeMissingLookupExportAndTimestampModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海旅行收藏产品设计 brief。",
        targetUser: "计划上海周末旅行的双人用户",
        productGoal: "查看地点、收藏必去地点并保留收藏时间",
        coreExperience: "首页行程、收藏列表、地点查找和收藏反馈",
        screens: ["首页", "收藏"],
        interactionModel: ["收藏", "取消收藏", "查看地点"],
        visualDirection: ["温暖旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["本地数据查询与收藏时间类型必须构建通过"],
        antiPatterns: ["导入不存在的 lookup 函数", "Date.now 写入 string 字段"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "上海旅行收藏体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海收藏",
      summary: "包含缺失 lookup 导出和 Date.now 类型不匹配的候选。",
      files: [
        ...nextAppFiles({
          title: "上海收藏",
          page: [
            "import FavoriteItem from '@/components/FavoriteItem';",
            "import { addFavorite } from '@/lib/favorites';",
            "",
            "export default function HomePage() {",
            "  const favorite = addFavorite('bund-001');",
            "  return <main><h1>上海收藏</h1><button>收藏地点</button><FavoriteItem favorite={favorite} /></main>;",
            "}",
          ].join("\n"),
          css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/components/FavoriteItem.tsx",
          content: [
            "import { findLocationById, getAllPlaces, getPlacesByType } from '@/lib/data';",
            "import type { Favorite } from '@/lib/types';",
            "",
            "export default function FavoriteItem({ favorite }: { favorite: Favorite }) {",
            "  const location = findLocationById(favorite.locationId);",
            "  const allPlaces = getAllPlaces();",
            "  const scenicCount = getPlacesByType('景点').length;",
            "  return <article><h2>{location?.name ?? favorite.locationId}</h2><p>{allPlaces.length} 个地点 / {scenicCount} 个景点</p><time>{favorite.addedAt}</time></article>;",
            "}",
          ].join("\n"),
        },
        {
          path: "src/lib/data.ts",
          content: [
            "export const days = [",
            "  { id: 'day-1', title: '外滩日', locations: [{ id: 'bund-001', name: '外滩源', area: '黄浦', type: '景点' }] },",
            "];",
          ].join("\n"),
        },
        {
          path: "src/lib/favorites.ts",
          content: [
            "import type { Favorite } from './types';",
            "",
            "export function addFavorite(locationId: string): Favorite {",
            "  return {",
            "    id: locationId,",
            "    locationId,",
            "    isMustGo: false,",
            "    addedAt: Date.now(),",
            "  };",
            "}",
          ].join("\n"),
        },
        {
          path: "src/lib/types.ts",
          content: [
            "export type Favorite = {",
            "  id: string;",
            "  locationId: string;",
            "  isMustGo: boolean;",
            "  addedAt: string;",
            "};",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeMissingRelativeLookupReExportModel extends ModelClient {
  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    if (request.role === "design_director") {
      return {
        summary: "上海行程产品设计 brief。",
        targetUser: "计划上海三日游的用户",
        productGoal: "查看每日地点列表和详情",
        coreExperience: "首页、每日行程和地点列表",
        screens: ["首页", "每日行程"],
        interactionModel: ["查看每日地点"],
        visualDirection: ["清爽旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["server-data 相对路径重导出必须构建通过"],
        antiPatterns: ["重导出 data 中不存在的 lookup 函数"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 91,
        summary: "每日行程体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海每日行程",
      summary: "包含相对路径 re-export 缺失 getPlacesByDay 的候选。",
      files: [
        ...nextAppFiles({
          title: "上海每日行程",
          page: [
            "import { getPlacesByDay } from '@/lib/server-data';",
            "",
            "export default function HomePage() {",
            "  const places = getPlacesByDay('day-1');",
            "  return <main><h1>上海每日行程</h1><p>{places.length} 个当日地点</p><button>查看路线</button></main>;",
            "}",
          ].join("\n"),
          css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/server-data.ts",
          content: "export { getAllDays, getDayById, getPlacesByDay } from './data';\n",
        },
        {
          path: "src/lib/data.ts",
          content: [
            "export const days = [",
            "  { id: 'day-1', title: '外滩日', places: [{ id: 'bund-001', name: '外滩源', area: '黄浦', type: '景点' }] },",
            "];",
            "",
            "export function getAllDays() { return days; }",
            "export function getDayById(id: string) { return days.find((day) => day.id === id) ?? null; }",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeMissingLocalTypeExportModel extends ModelClient {
  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    if (request.role === "design_director") {
      return {
        summary: "上海旅行收藏产品设计 brief。",
        targetUser: "计划上海周末旅行的双人用户",
        productGoal: "查看地点、收藏必去地点并筛选收藏",
        coreExperience: "首页、收藏列表、预算和详情页",
        screens: ["首页", "收藏", "预算"],
        interactionModel: ["收藏", "筛选", "标记必去", "查看详情"],
        visualDirection: ["温暖旅行手帐"],
        contentStrategy: ["真实上海地点和收藏状态"],
        qualityBar: ["本地类型导入必须构建通过"],
        antiPatterns: ["导入不存在的 Favorite 类型"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "收藏体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海收藏",
      summary: "包含缺失 Favorite 类型导出的候选。",
      files: [
        ...nextAppFiles({
          title: "上海收藏",
          page: "import FavoriteList from '@/components/FavoriteList';\nexport default function HomePage() { return <main><h1>上海收藏</h1><FavoriteList favorites={[{ locationId: 'bund', isMustGo: false }]} /></main>; }\n",
          css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/components/FavoriteList.tsx",
          content: [
            "import type { Favorite, Location } from '@/lib/data';",
            "",
            "export default function FavoriteList({ favorites }: { favorites: Favorite[] }) {",
            "  const places: Location[] = [];",
            "  return <section><h2>收藏清单</h2>{favorites.map((item) => <article key={item.locationId}>{item.locationId}{places.length}</article>)}</section>;",
            "}",
          ].join("\n"),
        },
        {
          path: "src/lib/data.ts",
          content: [
            "export interface Location {",
            "  id: string;",
            "  name: string;",
            "  category: '景点' | '餐饮';",
            "}",
            "export const locations: Location[] = [{ id: 'bund', name: '外滩', category: '景点' }];",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeRelativeMissingLocalTypeExportModel extends ModelClient {
  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    if (request.role === "design_director") {
      return {
        summary: "上海旅行收藏产品设计 brief。",
        targetUser: "计划上海短途旅行的用户",
        productGoal: "收藏地点并保留本地状态",
        coreExperience: "首页、收藏列表、地点卡片",
        screens: ["首页", "收藏"],
        interactionModel: ["收藏", "移除收藏"],
        visualDirection: ["温暖旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["相对路径类型导入必须构建通过"],
        antiPatterns: ["./types 缺少 Favorite 导出"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "收藏体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海收藏",
      summary: "包含相对路径缺失 Favorite 类型导出的候选。",
      files: [
        ...nextAppFiles({
          title: "上海收藏",
          page: [
            "import { addFavorite } from '@/lib/favorites';",
            "",
            "export default function HomePage() {",
            "  const favorite = addFavorite('bund');",
            "  return <main><h1>上海收藏</h1><article>{favorite.locationId}</article><button>移除收藏</button></main>;",
            "}",
          ].join("\n"),
          css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/favorites.ts",
          content: [
            "import type { Favorite } from './types';",
            "",
            "export function addFavorite(locationId: string): Favorite {",
            "  return { locationId, isMustGo: false };",
            "}",
          ].join("\n"),
        },
        {
          path: "src/lib/types.ts",
          content: "export interface Place { id: string; name: string; }\n",
        },
      ],
    } as T;
  }
}

class FakeUndefinedNamedReExportModel extends ModelClient {
  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    if (request.role === "design_director") {
      return {
        summary: "上海旅行预算产品设计 brief。",
        targetUser: "计划上海短途旅行的用户",
        productGoal: "查看地点类型、预算和收藏",
        coreExperience: "首页浏览、预算汇总、地点数据复用",
        screens: ["首页", "预算"],
        interactionModel: ["预算汇总", "类型标签"],
        visualDirection: ["旅行手帐"],
        contentStrategy: ["真实上海地点和分类"],
        qualityBar: ["数据模块构建通过"],
        antiPatterns: ["导出未声明符号"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "预算体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海预算",
      summary: "包含未定义 re-export 的候选。",
      files: [
        ...nextAppFiles({
          title: "上海预算",
          page: "import { places } from '@/lib/demo-data';\nexport default function HomePage() { return <main><h1>上海预算</h1><p>{places.length} 个地点</p></main>; }\n",
          css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/demo-data.ts",
          content: [
            "export { TYPE_LABELS };",
            "const imageBase = 'https://images.unsplash.com/photo-';",
            "export const places = [{ id: 'bund', name: '外滩', image: `${imageBase}1502602898657-3e91760cbb34` }];",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeDateGroupingGenericInferenceModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "餐厅手帐历史列表产品设计 brief。",
        targetUser: "按月回看餐厅记录的个人用户",
        productGoal: "筛选、查看和编辑本地餐厅历史记录",
        coreExperience: "历史按月分组、记录卡片点击、编辑删除和筛选",
        screens: ["首页", "历史", "详情", "设置"],
        interactionModel: ["月份分组", "筛选", "卡片点击", "编辑删除"],
        visualDirection: ["温暖纸感手帐"],
        contentStrategy: ["真实餐厅记录"],
        qualityBar: ["分组工具泛型必须保持记录类型"],
        antiPatterns: ["groupByMonth 推断成仅包含 date 的窄类型"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "餐厅历史体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "餐厅历史",
      summary: "包含按月分组泛型推断过窄的候选。",
      files: [
        ...nextAppFiles({
          title: "餐厅历史",
          page:
            "import HistoryView from '@/components/HistoryView';\nexport default function HomePage() { return <main><HistoryView /></main>; }",
          css: ":root { --paper: #f8efe3; --ink: #211c16; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/components/HistoryView.tsx",
          content: [
            "import { RestaurantEntry } from '@/lib/types';",
            "import { groupByMonth } from '@/lib/utils';",
            "",
            "const filteredEntries: RestaurantEntry[] = [{ id: 'r1', date: '2026-05-01', title: '晚餐' }];",
            "",
            "export default function HistoryView() {",
            "  const grouped = groupByMonth(filteredEntries);",
            "  return <section>{Array.from(grouped.entries()).map(([month, { entries }]) => (",
            "    <div key={month}>{entries.map((entry) => <article key={entry.id}>{entry.title}</article>)}</div>",
            "  ))}</section>;",
            "}",
          ].join("\n"),
        },
        {
          path: "src/lib/types.ts",
          content: "export type RestaurantEntry = { id: string; date: string; title: string };\n",
        },
        {
          path: "src/lib/utils.ts",
          content:
            "export function groupByMonth<T extends { date: string }>(entries: T[]): Map<string, { entries: T[] }> { return new Map([[entries[0]?.date.slice(0, 7) ?? '2026-05', { entries }]]); }\n",
        },
      ],
    } as T;
  }
}

class FakeSequentialBuildRepairModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海行程产品设计 brief。",
        targetUser: "查看行程和地点详情的旅行者",
        productGoal: "浏览推荐地点并进入详情页",
        coreExperience: "首页推荐、详情跳转、收藏反馈",
        screens: ["首页", "行程", "详情", "收藏"],
        interactionModel: ["卡片点击", "天气切换", "收藏"],
        visualDirection: ["文艺旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["连续构建修复必须通过"],
        antiPatterns: ["漏 import 图标", "把引用对象当实体对象使用"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "行程体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海漫步",
      summary: "包含连续 TypeScript 构建错误的候选。",
      files: nextAppFiles({
        title: "上海漫步",
        page: [
          "\"use client\";",
          "import { useState } from 'react';",
          "import { useRouter } from 'next/navigation';",
          "import { ForkKnife, Sun } from 'lucide-react';",
          "const trips = [{ day: 1, places: [{ id: 'bund', timeSlot: '下午' }] }];",
          "function getPlaceById(id: string): { id: string; name: string; shortDesc: string } | undefined { return id ? { id, name: '外滩', shortDesc: '黄浦江边的城市名片' } : undefined; }",
          "export default function HomePage() {",
          "  const router = useRouter();",
          "  const [weather] = useState<'sunny' | 'rainy'>('sunny');",
          "  const dayData = trips[0];",
          "  const places = weather === 'sunny' ? dayData.places : dayData.places;",
          "  return <main><button onClick={() => router.push(`/detail/${places[0].id}`)}><ForkKnife /><Sun /><ChevronRight />{places[0]?.name} · {places[0]?.shortDesc || '探索上海魅力'}</button></main>;",
          "}",
        ].join("\n"),
        css: ":root { --paper: #f6efe1; --ink: #18302b; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
      }),
    } as T;
  }
}

class FakeMissingDomainItemsModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "个人旅行手帐产品设计 brief。",
        targetUser: "记录行程和清单的个人用户",
        productGoal: "管理本地旅行清单和手帐记录",
        coreExperience: "查看清单、添加事项、保存本地记录",
        screens: ["首页", "清单", "手帐", "设置"],
        interactionModel: ["本地状态", "清单勾选", "记录保存"],
        visualDirection: ["精致手帐式移动工具"],
        contentStrategy: ["真实旅行清单和记录"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["API 路由引用不存在的 db 导出"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "手帐清单体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "旅行手帐清单",
      summary: "包含本地清单、手帐记录和一个缺失导出的 API 路由。",
      files: [
        ...nextAppFiles({
          title: "旅行手帐清单",
          page: "export default function HomePage() { return <main><h1>旅行手帐清单</h1><button>添加清单</button><section>本地保存</section></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/db.ts",
          content: "export const storageMode = 'local';\n",
        },
        {
          path: "src/app/api/items/route.ts",
          content:
            "import { NextResponse } from 'next/server';\nimport { getDomainItems } from '@/lib/db';\n\nexport async function GET() {\n  const items = await getDomainItems();\n  return NextResponse.json({ items });\n}\n",
        },
      ],
    } as T;
  }
}

class FakeConflictingDynamicRoutesModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海每日路线产品设计 brief。",
        targetUser: "查看每日路线的旅行者",
        productGoal: "按天查看路线和地点细节",
        coreExperience: "首页、每日路线、地点详情和收藏",
        screens: ["首页", "每日路线", "地点详情", "收藏"],
        interactionModel: ["底部导航", "日程卡片", "详情跳转"],
        visualDirection: ["文艺旅行手帐"],
        contentStrategy: ["真实上海路线内容"],
        qualityBar: ["动态路由必须能构建"],
        antiPatterns: ["同级动态路由参数名冲突"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "每日路线视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海每日路线",
      summary: "包含两个同级动态路由参数名的候选。",
      files: [
        ...nextAppFiles({
          title: "上海每日路线",
          page: "export default function HomePage() { return <main><h1>上海每日路线</h1><a href=\"/day/1\">查看第 1 天</a><button>收藏路线</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/app/day/[day]/page.tsx",
          content:
            "export default function DayPage({ params }: { params: { day: string } }) { return <main><h1>第 {params.day} 天</h1><a href=\"/\">回首页</a></main>; }\n",
        },
        {
          path: "src/app/day/[dayId]/page.tsx",
          content:
            "export default function DayAliasPage({ params }: { params: { dayId: string } }) { return <main><h1>路线 {params.dayId}</h1><a href=\"/\">回首页</a></main>; }\n",
        },
      ],
    } as T;
  }
}

class FakeRootOptionalCatchAllConflictModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "餐厅手帐产品设计 brief。",
        targetUser: "记录餐厅体验的个人用户",
        productGoal: "首页记录餐厅并查看历史详情",
        coreExperience: "填写、保存、筛选、详情编辑",
        screens: ["首页", "历史", "详情", "设置"],
        interactionModel: ["底部导航", "日期切换", "保存反馈", "筛选"],
        visualDirection: ["温暖纸感手帐"],
        contentStrategy: ["真实餐厅记录"],
        qualityBar: ["路由必须能构建"],
        antiPatterns: ["根页面和根 optional catch-all 冲突"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "餐厅手帐视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "食记",
      summary: "包含根页面和根 optional catch-all 冲突的候选。",
      files: [
        ...nextAppFiles({
          title: "食记",
          page: "export default function HomePage() { return <main><h1>今日食记</h1><button>保存记录</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/app/[[...slug]]/page.tsx",
          content:
            "export default function CatchAllPage() { return <main><h1>食记详情</h1><a href=\"/\">回首页</a></main>; }\n",
        },
      ],
    } as T;
  }
}

class FakeCommentOnlyRemovedRouteModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海收藏清单产品设计 brief。",
        targetUser: "整理旅行收藏的用户",
        productGoal: "浏览路线并管理收藏清单",
        coreExperience: "首页、收藏、预算和地点详情",
        screens: ["首页", "收藏", "预算", "详情"],
        interactionModel: ["底部导航", "收藏按钮", "筛选"],
        visualDirection: ["旅行手帐"],
        contentStrategy: ["真实上海路线和收藏内容"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["用注释占位已删除路由"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "收藏清单视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海收藏清单",
      summary: "包含一个注释占位的已删除历史页。",
      files: [
        ...nextAppFiles({
          title: "上海收藏清单",
          page: "export default function HomePage() { return <main><h1>上海收藏清单</h1><a href=\"/favorites\">查看收藏</a><button>保存地点</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/app/history/page.tsx",
          content: "// Removed: This route is not needed. Use /favorites instead.",
        },
        {
          path: "src/app/favorites/page.tsx",
          content: "export default function FavoritesPage() { return <main><h1>我的收藏</h1><button>按类型筛选</button></main>; }\n",
        },
      ],
    } as T;
  }
}

class FakeMissingNamedPropertyModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "个人记录产品设计 brief。",
        targetUser: "记录文字和图片的个人用户",
        productGoal: "保存日记、分类记录并查看预算式统计",
        coreExperience: "写记录、看分类、查看历史",
        screens: ["首页", "分类", "统计", "历史"],
        interactionModel: ["底部导航", "分类筛选", "保存反馈"],
        visualDirection: ["温暖手帐式移动工具"],
        contentStrategy: ["真实记录和分类"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["字段类型和页面引用不一致"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "记录统计体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "拾光手帐",
      summary: "包含一个页面引用了未声明字段的候选。",
      files: [
        ...nextAppFiles({
          title: "拾光手帐",
          page: "export default function HomePage() { return <main><h1>拾光手帐</h1><a href=\"/budget\">查看分类统计</a><button>保存记录</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/demo-data.ts",
          content:
            "export type DomainItem = {\n  id: string;\n  kind: 'place' | 'work';\n  title: string;\n  summary: string;\n  budget: number;\n  category: string;\n};\n\nexport const domainItems: DomainItem[] = [\n  { id: 'coffee', kind: 'place', title: '咖啡记录', summary: '周末写作与图片整理。', budget: 48, category: '餐饮' },\n];\n",
        },
        {
          path: "src/lib/db.ts",
          content: "import { domainItems } from './demo-data';\n\nexport async function getDomainItems() {\n  return domainItems;\n}\n",
        },
        {
          path: "src/app/budget/page.tsx",
          content:
            "import { getDomainItems } from '@/lib/db';\n\nexport default async function BudgetPage() {\n  const places = (await getDomainItems()).filter((item) => item.kind === 'place');\n  const rows = ['餐饮', '门票'].map((category) => ({\n    category,\n    total: places.filter((place) => place.budgetCategory === category).reduce((sum, place) => sum + place.budget, 0),\n  }));\n  return <main>{rows.map((row) => <p key={row.category}>{row.category}: {row.total}</p>)}</main>;\n}\n",
        },
      ],
    } as T;
  }
}

class FakeBooleanCallableFavoriteModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海旅行收藏产品设计 brief。",
        targetUser: "收藏上海地点的旅行者",
        productGoal: "浏览地点并收藏到清单",
        coreExperience: "首页、地点卡片、收藏按钮、收藏列表",
        screens: ["首页", "收藏", "地点详情", "预算"],
        interactionModel: ["收藏切换", "筛选", "保存反馈"],
        visualDirection: ["温暖旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["收藏 context API 错配"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "收藏按钮体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海收藏",
      summary: "包含收藏 context 误解构的候选。",
      files: [
        ...nextAppFiles({
          title: "上海收藏",
          page: "import FavoriteButton from '@/components/FavoriteButton';\nexport default function HomePage() { return <main><h1>上海收藏</h1><FavoriteButton locationId=\"the-bund\" /><button>查看收藏</button></main>; }\n",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/types.ts",
          content:
            "export interface Favorite { locationId: string; name: string; type: 'attraction' | 'restaurant'; area: string; budget: number; budgetCategory: 'dining' | 'ticket' | 'transport'; addedAt: number; mustVisit: boolean; }\n",
        },
        {
          path: "src/context/FavoritesContext.tsx",
          content: [
            "'use client';",
            "import { createContext, useCallback, useContext, useState } from 'react';",
            "import { Favorite } from '@/lib/types';",
            "interface FavoritesContextType {",
            "  favorites: Favorite[];",
            "  toggleFavorite: (favorite: Omit<Favorite, 'addedAt' | 'mustVisit'>) => void;",
            "  isFavorite: (locationId: string) => boolean;",
            "  removeFavorite: (locationId: string) => void;",
            "  isFavorited?: boolean;",
            "  addFavorite?: string;",
            "}",
            "const FavoritesContext = createContext<FavoritesContextType | undefined>(undefined);",
            "export function FavoritesProvider({ children }: { children: React.ReactNode }) {",
            "  const [favorites, setFavorites] = useState<Favorite[]>([]);",
            "  const isFavorite = useCallback((locationId: string) => favorites.some((item) => item.locationId === locationId), [favorites]);",
            "  const toggleFavorite = useCallback((favorite: Omit<Favorite, 'addedAt' | 'mustVisit'>) => setFavorites((items) => items.some((item) => item.locationId === favorite.locationId) ? items.filter((item) => item.locationId !== favorite.locationId) : [...items, { ...favorite, addedAt: Date.now(), mustVisit: false }]), []);",
            "  const removeFavorite = useCallback((locationId: string) => setFavorites((items) => items.filter((item) => item.locationId !== locationId)), []);",
            "  return <FavoritesContext.Provider value={{ favorites, toggleFavorite, isFavorite, removeFavorite }}>{children}</FavoritesContext.Provider>;",
            "}",
            "export function useFavorites() { const context = useContext(FavoritesContext); if (!context) throw new Error('missing favorites provider'); return context; }",
          ].join("\n"),
        },
        {
          path: "src/components/FavoriteButton.tsx",
          content: [
            "'use client';",
            "import React from 'react';",
            "import { useFavorites } from '@/context/FavoritesContext';",
            "interface FavoriteButtonProps { locationId: string; }",
            "export default function FavoriteButton({ locationId }: FavoriteButtonProps) {",
            "  const { isFavorited, addFavorite, removeFavorite } = useFavorites();",
            "  const isFav = isFavorited(locationId);",
            "  const handleToggle = (event: React.MouseEvent) => {",
            "    event.preventDefault();",
            "    if (isFav) {",
            "      removeFavorite(locationId);",
            "    } else {",
            "      addFavorite(locationId);",
            "    }",
            "  };",
            "  return <button onClick={handleToggle}>{isFav ? '取消收藏' : '收藏'}</button>;",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeNullableJsxPropModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海旅行地点详情产品设计 brief。",
        targetUser: "查看地点和雨天替代方案的旅行者",
        productGoal: "展示地点详情和可选替代地点",
        coreExperience: "地点详情、天气替代、收藏",
        screens: ["首页", "地点详情", "行程", "收藏"],
        interactionModel: ["点击地点", "查看替代路线"],
        visualDirection: ["文艺旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["find 返回 undefined 直接传给 nullable prop"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "地点详情体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海地点手帐",
      summary: "包含 nullable JSX prop 传值不一致的候选。",
      files: [
        ...nextAppFiles({
          title: "上海地点手帐",
          page: "export default function HomePage() { return <main><h1>上海地点手帐</h1><a href=\"/location/the-bund\">查看外滩</a><button>保存地点</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/types.ts",
          content: "export interface Location { id: string; name: string; }\n",
        },
        {
          path: "src/lib/demo-data.ts",
          content:
            "import type { Location } from './types';\n\nexport const locations: Location[] = [\n  { id: 'the-bund', name: '外滩' },\n  { id: 'yu-garden', name: '豫园' },\n];\n",
        },
        {
          path: "src/components/LocationHero.tsx",
          content:
            "import type { Location } from '@/lib/types';\n\ninterface LocationHeroProps {\n  location: Location | null;\n  weatherAlt: Location | null;\n}\n\nexport function LocationHero({ location, weatherAlt }: LocationHeroProps) {\n  return <section><h1>{location?.name ?? '地点'}</h1><p>{weatherAlt?.name ?? '无替代地点'}</p></section>;\n}\n",
        },
        {
          path: "src/app/location/[locationId]/page.tsx",
          content:
            "import { LocationHero } from '@/components/LocationHero';\nimport { locations } from '@/lib/demo-data';\n\nexport default function LocationPage({ params }: { params: { locationId: string } }) {\n  const location = locations.find((item) => item.id === params.locationId) ?? null;\n  const displayAlt = locations.find((item) => item.id === 'yu-garden');\n  return (\n    <main>\n      <LocationHero\n        location={location}\n        weatherAlt={displayAlt}\n      />\n    </main>\n  );\n}\n",
        },
      ],
    } as T;
  }
}

class FakeStringJsxPropModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海地点详情产品设计 brief。",
        targetUser: "查看地点地址和开放时间的旅行者",
        productGoal: "展示地点详情和行程信息",
        coreExperience: "地点详情、地址、开放时间",
        screens: ["首页", "地点详情", "行程", "收藏"],
        interactionModel: ["点击地点", "查看详情"],
        visualDirection: ["文艺旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["可选字段直接传给必填字符串 prop"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "地点详情体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海地点手帐",
      summary: "包含 string JSX prop 传值不一致的候选。",
      files: [
        ...nextAppFiles({
          title: "上海地点手帐",
          page: "export default function HomePage() { return <main><h1>上海地点手帐</h1><a href=\"/place/the-bund\">查看外滩</a><button>保存地点</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/types.ts",
          content: "export interface Place { id: string; name: string; address?: string; openTime?: string; }\n",
        },
        {
          path: "src/lib/demo-data.ts",
          content:
            "import type { Place } from './types';\n\nexport const places: Place[] = [\n  { id: 'the-bund', name: '外滩', address: '中山东一路' },\n  { id: 'yu-garden', name: '豫园' },\n];\n",
        },
        {
          path: "src/components/InfoItem.tsx",
          content:
            "export function InfoItem({ label, value }: { label: string; value: string }) {\n  return <p><strong>{label}</strong>{value}</p>;\n}\n",
        },
        {
          path: "src/app/place/[placeId]/page.tsx",
          content:
            "import { InfoItem } from '@/components/InfoItem';\nimport { places } from '@/lib/demo-data';\n\nexport default function PlacePage({ params }: { params: { placeId: string } }) {\n  const place = places.find((item) => item.id === params.placeId) ?? places[0];\n  return <main><h1>{place.name}</h1><InfoItem label=\"地址\" value={place.address} /><InfoItem label=\"开放时间\" value={place.openTime} /></main>;\n}\n",
        },
      ],
    } as T;
  }
}

class FakeStringIdObjectMapAccessModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海按天行程产品设计 brief。",
        targetUser: "查看晴雨两套行程的旅行者",
        productGoal: "按天展示地点和雨天替代地点",
        coreExperience: "日程详情、天气切换、地点卡片",
        screens: ["首页", "日程", "地点详情", "预算"],
        interactionModel: ["天气切换", "地点跳转"],
        visualDirection: ["文艺旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["字符串 ID 数组被当作地点对象数组"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "日程体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海晴雨行程",
      summary: "包含 string ID map 中对象访问的候选。",
      files: [
        ...nextAppFiles({
          title: "上海晴雨行程",
          page: "export default function HomePage() { return <main><h1>上海晴雨行程</h1><a href=\"/day/day-1\">查看第一天</a><button>切换天气</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/types.ts",
          content:
            "export interface Location { id: string; name: string; }\nexport interface Day { id: string; title: string; locations: string[]; weatherAlternatives: Record<string, string>; }\n",
        },
        {
          path: "src/lib/demo-data.ts",
          content:
            "import type { Day, Location } from './types';\n\nexport const locations: Location[] = [\n  { id: 'the-bund', name: '外滩' },\n  { id: 'museum', name: '上海博物馆' },\n];\n\nexport const days: Day[] = [\n  { id: 'day-1', title: '第一天', locations: ['the-bund'], weatherAlternatives: { 'the-bund': 'museum' } },\n];\n\nexport function getLocationById(id: string) {\n  return locations.find((location) => location.id === id) ?? null;\n}\n",
        },
        {
          path: "src/app/day/[dayId]/page.tsx",
          content:
            "import { days, getLocationById } from '@/lib/demo-data';\n\nexport default function DayPage({ params }: { params: { dayId: string } }) {\n  const day = days.find((item) => item.id === params.dayId) ?? days[0]!;\n  const weather = '雨';\n  const displayLocations = day.locations.map(loc => {\n    if (weather === '雨' && day.weatherAlternatives[loc.id]) {\n      const alt = getLocationById(day.weatherAlternatives[loc.id]);\n      return alt || loc;\n    }\n    return loc;\n  });\n  return <main>{displayLocations.map((loc) => <p key={loc.id}>{loc.name}</p>)}</main>;\n}\n",
        },
      ],
    } as T;
  }
}

class FakeWeatherModeArrayArgumentModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海晴雨行程产品设计 brief。",
        targetUser: "需要晴雨两套路线的短途旅行者",
        productGoal: "按天气切换当天地点列表",
        coreExperience: "日程详情、天气切换、地点卡片",
        screens: ["首页", "日程", "地点详情", "收藏"],
        interactionModel: ["天气切换", "地点跳转", "收藏"],
        visualDirection: ["文艺旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["天气函数传参必须构建通过"],
        antiPatterns: ["把地点数组传给天气模式参数"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "晴雨行程视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海晴雨行程",
      summary: "包含天气函数数组参数错位的候选。",
      files: [
        ...nextAppFiles({
          title: "上海晴雨行程",
          page: "export default function HomePage() { return <main><h1>上海晴雨行程</h1><a href=\"/day/day-1\">第一天</a><button>切换天气</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #20342f; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/lib/data.ts",
          content: [
            "export type WeatherMode = 'sunny' | 'rainy';",
            "export interface Place { id: string; name: string; }",
            "export interface DayTrip { id: string; title: string; sunnyPlaceIds: string[]; rainyPlaceIds: string[]; }",
            "export const places: Place[] = [{ id: 'bund', name: '外滩' }, { id: 'museum', name: '上海博物馆' }];",
            "export const days: DayTrip[] = [{ id: 'day-1', title: '第一天', sunnyPlaceIds: ['bund'], rainyPlaceIds: ['museum'] }];",
            "export function getPlacesForDay(day: DayTrip, weather: WeatherMode): Place[] {",
            "  const ids = weather === 'sunny' ? day.sunnyPlaceIds : day.rainyPlaceIds;",
            "  return ids.map((id) => places.find((place) => place.id === id)).filter(Boolean) as Place[];",
            "}",
          ].join("\n"),
        },
        {
          path: "src/app/day/[dayId]/page.tsx",
          content: [
            "'use client';",
            "import { useMemo, useState } from 'react';",
            "import { days, places, getPlacesForDay, type WeatherMode } from '@/lib/data';",
            "",
            "export default function DayPage({ params }: { params: { dayId: string } }) {",
            "  const day = useMemo(() => days.find((item) => item.id === params.dayId) ?? days[0]!, [params.dayId]);",
            "  const [weather, setWeather] = useState<WeatherMode>('sunny');",
            "  const dayWithWeather = { ...day, weather };",
            "  const dayPlaces = getPlacesForDay(dayWithWeather, places);",
            "  return <main><h1>{day.title}</h1><button onClick={() => setWeather(weather === 'sunny' ? 'rainy' : 'sunny')}>切换天气</button>{dayPlaces.map((place) => <article key={place.id}>{place.name}</article>)}</main>;",
            "}",
          ].join("\n"),
        },
      ],
    } as T;
  }
}

class FakeErrorBannerPropsModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "上海旅行产品设计 brief。",
        targetUser: "查看三日行程的旅行者",
        productGoal: "浏览行程并保存地点",
        coreExperience: "首页查看路线、收藏、错误恢复",
        screens: ["首页", "行程", "收藏", "设置"],
        interactionModel: ["收藏", "筛选", "重试"],
        visualDirection: ["文艺旅行手帐"],
        contentStrategy: ["真实上海地点"],
        qualityBar: ["构建必须通过"],
        antiPatterns: ["组件 props 与调用不一致"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "错误恢复体验视觉通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海旅行手帐",
      summary: "包含 ErrorBanner props 不一致的候选。",
      files: [
        ...nextAppFiles({
          title: "上海旅行手帐",
          page:
            "export default function HomePage() { return <main><h1>上海旅行手帐</h1><a href=\"/history\">收藏路线</a><button>保存地点</button></main>; }",
          css: ":root { --paper: #f8efe3; --ink: #21362d; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "src/app/error.tsx",
          content:
            '"use client";\nimport { ErrorBanner } from "@/components/ErrorBanner";\n\nexport default function Error({ reset }: { reset: () => void }) {\n  return <ErrorBanner title="内容暂时不可用" message="请重试，或者回到首页继续查看已保存的内容。" onRetry={reset} />;\n}\n',
        },
        {
          path: "src/components/ErrorBanner.tsx",
          content:
            "interface ErrorBannerProps {\n  message: string;\n}\n\nexport function ErrorBanner({ message }: ErrorBannerProps) {\n  return <section><p>{message}</p></section>;\n}\n",
        },
      ],
    } as T;
  }
}

class FakePrismaSchemaWithoutCliModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
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
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "旅行数据产品设计 brief。",
        targetUser: "查看行程和收藏状态的旅行者",
        productGoal: "用静态精选数据和轻量 API 展示旅行计划",
        coreExperience: "浏览路线、查看地点和保存收藏",
        screens: ["首页", "行程", "收藏", "预算"],
        interactionModel: ["底部导航", "收藏按钮", "预算汇总"],
        visualDirection: ["文艺旅行手帐"],
        contentStrategy: ["上海真实地点"],
        qualityBar: ["构建不依赖临时下载 prisma CLI"],
        antiPatterns: ["有 schema 但 package.json 缺 prisma 依赖"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "旅行数据体验通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }

    return {
      title: "上海轻行程",
      summary: "包含 Prisma schema 但缺少本地 Prisma CLI 的候选。",
      files: [
        ...nextAppFiles({
          title: "上海轻行程",
          page: "export default function HomePage() { return <main><h1>上海轻行程</h1><button>保存收藏</button></main>; }",
          css: ":root { --paper: #f6efe1; --ink: #18302b; } body { margin: 0; background: var(--paper); color: var(--ink); } main { min-height: 100vh; padding: 24px; }",
        }),
        {
          path: "prisma/schema.prisma",
          content: [
            'generator client { provider = "prisma-client-js" }',
            'datasource db { provider = "sqlite"; url = env("DATABASE_URL") }',
            "model TripDay { id String @id title String places Place[] }",
            "model Place { id String @id name String dayId String day TripDay @relation(fields: [dayId], references: [id]) }",
            "model Favorite { id String @id placeId String }",
          ].join("\n"),
        },
        {
          path: ".env",
          content: 'DATABASE_URL="postgresql://example.invalid/travel"\n',
        },
      ],
    } as T;
  }
}

class FakeHangingToolLoopModel extends ModelClient {
  readonly roles: string[] = [];

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: { design_director: "test-model", coder: "test-model", visual_critic: "test-model" },
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      agentModelTurnTimeoutMs: 90_000,
      buildAttempts: 1,
      previewPortBase: 4173,
    });
  }

  override get configured() {
    return true;
  }

  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    this.roles.push(request.role);
    if (request.role === "design_director") {
      return {
        summary: "个人旅行手帐设计 brief。",
        targetUser: "个人旅行者",
        productGoal: "本地管理旅行清单和手帐",
        coreExperience: "旅行状态、清单、手帐和灵感记录",
        screens: ["今日", "清单", "手帐", "灵感"],
        interactionModel: ["底部导航", "本地保存", "清单勾选"],
        visualDirection: ["旅行手帐", "移动效率工具"],
        contentStrategy: ["真实行前事项和每日记录"],
        qualityBar: ["模型工具调用慢时仍可生成"],
        antiPatterns: ["等待外部模型导致路径阻塞"],
      } as T;
    }
    if (request.role === "visual_critic") {
      return {
        status: "passed",
        score: 90,
        summary: "视觉检查通过。",
        issues: [],
        repairInstructions: [],
      } as T;
    }
    if (request.role === "design_seed_smith") {
      return strictDesignSeedDraft() as T;
    }
    if (request.role === "architect") {
      return minimalArchitecturePlanDraft() as T;
    }
    throw new Error(`Unexpected JSON role ${request.role}`);
  }

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.roles.push(request.role);
    await new Promise((resolve) => setTimeout(resolve, (request.timeoutMs ?? 0) + 25));
    throw new Error(`Model tool-use request (${request.role}) timed out after ${request.timeoutMs}ms`);
  }
}

class FakeAgentToolBridgeModel extends ModelClient {
  readonly roles: string[] = [];
  protected toolTurn = 0;

  constructor() {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://test.invalid/v1",
      modelName: "test-model",
      roleModels: {
        clarifier: "test-model",
        design_director: "test-model",
        design_seed_smith: "test-model",
        architect: "test-model",
        coder: "test-model",
        visual_critic: "test-model",
      },
      timeoutMs: 0,
      maxTurns: 8,
      agentMaxToolCallsPerTurn: 6,
      agentMaxToolCallsTotal: 300,
      agentModelTurnTimeoutMs: 90_000,
      buildAttempts: 1,
      previewPortBase: 4173,
    });
  }

  override get configured() {
    return true;
  }

  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    this.roles.push(request.role);
    if (request.role === "clarifier") {
      return { action: "ready", summary: "ready", questions: [] } as T;
    }
    if (request.role === "design_director") {
      return {
        summary: "工具桥接测试 brief。",
        targetUser: "内部测试用户",
        productGoal: "验证 agent tools runtime adapter 注入",
        coreExperience: "生成最小页面并调用子 agent",
        screens: ["首页", "任务"],
        interactionModel: ["按钮", "任务状态"],
        visualDirection: ["清晰工具感"],
        contentStrategy: ["具体测试文案"],
        qualityBar: ["adapter 可见"],
        antiPatterns: ["静态占位"],
      } as T;
    }
    if (request.role === "design_seed_smith") {
      return strictDesignSeedDraft() as T;
    }
    if (request.role === "architect") {
      return minimalArchitecturePlanDraft() as T;
    }
    if (request.role === "visual_critic") {
      return { status: "passed", score: 92, summary: "adapter 视觉检查通过。", issues: [], repairInstructions: [] } as T;
    }
    throw new Error(`Unexpected JSON role ${request.role}`);
  }

  override async chatWithTools(_request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.roles.push("coder");
    this.toolTurn += 1;
    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
          { id: "call-design-2", name: "use_design_skill", arguments: "{\"skill\":\"mobile-app-shell\"}" },
          {
            id: "call-agent",
            name: "agent_tool",
            arguments: JSON.stringify({
              title: "Adapter subtask",
              prompt: "Use injected runtime adapter",
              agentType: "inspector",
              allowedTools: ["read_file", "web_search"],
            }),
          },
        ],
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call-write-package",
            name: "write_file",
            arguments: JSON.stringify({ path: "package.json", content: nextPackageJson() }),
          },
          {
            id: "call-write-config",
            name: "write_file",
            arguments: JSON.stringify({ path: "next.config.mjs", content: "export default {};\n" }),
          },
          {
            id: "call-write-tsconfig",
            name: "write_file",
            arguments: JSON.stringify({
              path: "tsconfig.json",
              content: JSON.stringify(
                {
                  compilerOptions: {
                    target: "es5",
                    lib: ["dom", "dom.iterable", "esnext"],
                    allowJs: true,
                    skipLibCheck: true,
                    strict: true,
                    noEmit: true,
                    esModuleInterop: true,
                    module: "esnext",
                    moduleResolution: "bundler",
                    resolveJsonModule: true,
                    isolatedModules: true,
                    jsx: "preserve",
                    incremental: true,
                    plugins: [{ name: "next" }],
                    paths: { "@/*": ["./src/*"] },
                  },
                  include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
                  exclude: ["node_modules"],
                },
                null,
                2,
              ),
            }),
          },
          {
            id: "call-write-env",
            name: "write_file",
            arguments: JSON.stringify({ path: "next-env.d.ts", content: "/// <reference types=\"next\" />\n" }),
          },
          {
            id: "call-write-layout",
            name: "write_file",
            arguments: JSON.stringify({
              path: "src/app/layout.tsx",
              content: "import './globals.css';\nexport const metadata = { title: 'Adapter Bridge' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
            }),
          },
          {
            id: "call-write-page",
            name: "write_file",
            arguments: JSON.stringify({
              path: "src/app/page.tsx",
              content: "export default function Page() { return <main><h1>Adapter Bridge</h1><button>保存状态</button><p className=\"empty-state\">暂无任务</p></main>; }\n",
            }),
          },
        ],
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 3) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call-write-css",
            name: "write_file",
            arguments: JSON.stringify({ path: "src/app/globals.css", content: ":root { --ink: #0f172a; }\nbody { margin: 0; color: var(--ink); }\nmain { padding: 24px; }\n" }),
          },
          { id: "call-done-reference", name: "mark_task_done", arguments: "{\"taskId\":\"task-reference-guidance\"}" },
          { id: "call-done-scaffold", name: "mark_task_done", arguments: "{\"taskId\":\"task-scaffold\"}" },
          { id: "call-build", name: "run_build", arguments: "{\"skipInstall\":true}" },
          { id: "call-finish", name: "finish_app", arguments: "{\"title\":\"Adapter Bridge\",\"summary\":\"Generated with injected tool adapters.\"}" },
        ],
        finishReason: "tool_calls",
      };
    }
    return { content: "", toolCalls: [], finishReason: "stop" };
  }
}

class FakeUnfinishedAgentLoopModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;
    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
        ],
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: [
          { id: "call-write-package", name: "write_file", arguments: JSON.stringify({ path: "package.json", content: nextPackageJson() }) },
          { id: "call-write-config", name: "write_file", arguments: JSON.stringify({ path: "next.config.mjs", content: "export default {};\n" }) },
          { id: "call-write-tsconfig", name: "write_file", arguments: JSON.stringify({ path: "tsconfig.json", content: "{}" }) },
          { id: "call-write-env", name: "write_file", arguments: JSON.stringify({ path: "next-env.d.ts", content: "/// <reference types=\"next\" />\n" }) },
          {
            id: "call-write-layout",
            name: "write_file",
            arguments: JSON.stringify({
              path: "src/app/layout.tsx",
              content: "import './globals.css';\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
            }),
          },
          {
            id: "call-write-page",
            name: "write_file",
            arguments: JSON.stringify({
              path: "src/app/page.tsx",
              content: "export default function Page() { return <main><h1>半成品不应通过</h1><button>保存</button></main>; }\n",
            }),
          },
        ],
        finishReason: "tool_calls",
      };
    }
    return { content: "", toolCalls: [], finishReason: "stop" };
  }
}

class FakeCompletedNoFinishAgentLoopModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;
    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
          { id: "call-design-2", name: "use_design_skill", arguments: "{\"skill\":\"mobile-app-shell\"}" },
        ],
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: nextAppFiles({
          title: "完成但漏收口",
          page: "export default function Page() { return <main><h1>完成但漏收口</h1><button>保存</button><p>空状态、错误状态和成功反馈都已经就绪。</p></main>; }\n",
          css: "body { margin: 0; } main { min-height: 100vh; padding: 24px; }\n",
        }).map((file, index) => ({
          id: `call-write-${index}`,
          name: "write_file",
          arguments: JSON.stringify(file),
        })),
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 3) {
      return {
        content: "",
        toolCalls: minimalArchitecturePlanDraft().tasks.map((task, index) => ({
          id: `call-done-${index}`,
          name: "mark_task_done",
          arguments: JSON.stringify({ taskId: task.id }),
        })),
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 4) {
      return {
        content: "",
        toolCalls: [{ id: "call-build", name: "run_build", arguments: "{\"skipInstall\":true}" }],
        finishReason: "tool_calls",
      };
    }
    return { content: "All done.", toolCalls: [], finishReason: "stop" };
  }
}

class FakeBaselineScaffoldCloseoutModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;
    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
          { id: "call-design-2", name: "use_design_skill", arguments: "{\"skill\":\"mobile-app-shell\"}" },
        ],
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: [
          ...minimalArchitecturePlanDraft().tasks.map((task, index) => ({
            id: `call-done-${index}`,
            name: "mark_task_done",
            arguments: JSON.stringify({ taskId: task.id }),
          })),
          { id: "call-build", name: "run_build", arguments: "{\"skipInstall\":true}" },
          { id: "call-finish", name: "finish_app", arguments: "{\"title\":\"Baseline\",\"summary\":\"Tried to finish the scaffold.\"}" },
        ],
        finishReason: "tool_calls",
      };
    }
    return { content: "Done.", toolCalls: [], finishReason: "stop" };
  }
}

class FakeBaselineScaffoldAutoFinishModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;
    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
        ],
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: [{ id: "call-build", name: "run_build", arguments: "{\"skipInstall\":true}" }],
        finishReason: "tool_calls",
      };
    }
    return { content: "The starter works, but I forgot finish_app.", toolCalls: [], finishReason: "stop" };
  }
}

class FakeCompletedThenTimeoutNoFinishAgentLoopModel extends FakeCompletedNoFinishAgentLoopModel {
  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    if (this.toolTurn >= 4) {
      this.toolRequests.push(request);
      this.roles.push("coder");
      throw new Error("model turn timed out after completed tool loop");
    }
    return super.chatWithTools(request);
  }
}

class FakeAutoMarkCompletedNoFinishAgentLoopModel extends FakeCompletedNoFinishAgentLoopModel {
  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    if (request.role === "architect") {
      const base = minimalArchitecturePlanDraft();
      return {
        ...base,
        summary: "Small plan for auto bookkeeping.",
        tasks: base.tasks.map((task, index) =>
          index === base.tasks.length - 1
            ? {
                ...task,
                title: "Build verify",
                description: "Run a production build verification.",
                files: [],
                acceptance: "npm run build exits with 0.",
              }
            : {
                ...task,
                files: ["src/app/page.tsx"],
              },
        ),
      } as T;
    }
    return super.generateJson<T>(request);
  }

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;

    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
          { id: "call-design-2", name: "use_design_skill", arguments: "{\"skill\":\"mobile-app-shell\"}" },
        ],
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: nextAppFiles({
          title: "自动任务记账",
          page: "export default function Page() { return <main><h1>自动任务记账</h1><button>保存</button><p>空状态、错误状态和成功反馈都已经就绪。</p></main>; }\n",
          css: "body { margin: 0; } main { min-height: 100vh; padding: 24px; }\n",
        }).map((file, index) => ({
          id: `call-write-${index}`,
          name: "write_file",
          arguments: JSON.stringify(file),
        })),
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 3) {
      return {
        content: "",
        toolCalls: [{ id: "call-build", name: "run_build", arguments: "{\"skipInstall\":true}" }],
        finishReason: "tool_calls",
      };
    }

    return { content: "Done but no explicit task marks.", toolCalls: [], finishReason: "stop" };
  }
}

class FakeMostlyCompleteNoFinishAgentLoopModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    if (request.role === "architect") {
      const base = minimalArchitecturePlanDraft();
      return {
        ...base,
        summary: "Nine-task plan that leaves optional bookkeeping tasks unmarked.",
        tasks: Array.from({ length: 9 }, (_, index) => ({
          id: `task-${index + 1}`,
          title: index < 7 ? `Build compact surface ${index + 1}` : `Optional bookkeeping ${index + 1}`,
          description:
            index < 7
              ? "Implement the compact Next.js app surface and mark it done."
              : "Optional follow-up route bookkeeping that should not block a build-and-audit-clean app.",
          files: index < 7 ? ["src/app/page.tsx"] : [`src/app/optional-${index + 1}/page.tsx`],
          dependsOn: index === 0 ? [] : [`task-${index}`],
          acceptance: index < 7 ? "The main compact app surface is visible and interactive." : "Optional route is only needed if the product flow requires it.",
        })),
      } as T;
    }
    return super.generateJson<T>(request);
  }

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;

    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
        ],
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: nextAppFiles({
          title: "七成任务已够收口",
          page:
            "export default function Page() { return <main><h1>七成任务已够收口</h1><button>保存</button><button>筛选</button><p>空状态、错误恢复、保存成功和历史回顾都已经就绪。</p></main>; }\n",
          css: "body { margin: 0; } main { min-height: 100vh; padding: 24px; } button { min-height: 36px; margin-right: 8px; }\n",
        }).map((file, index) => ({
          id: `call-write-${index}`,
          name: "write_file",
          arguments: JSON.stringify(file),
        })),
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 3) {
      return {
        content: "",
        toolCalls: [
          ...Array.from({ length: 7 }, (_, index) => ({
            id: `call-done-${index + 1}`,
            name: "mark_task_done",
            arguments: JSON.stringify({ taskId: `task-${index + 1}` }),
          })),
          { id: "call-build", name: "run_build", arguments: "{\"skipInstall\":true}" },
        ],
        finishReason: "tool_calls",
      };
    }

    return { content: "The app is usable, but I forgot to call finish_app.", toolCalls: [], finishReason: "stop" };
  }
}

class FakePartialThenTimeoutRecoveryAgentLoopModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;

    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
          { id: "call-design-2", name: "use_design_skill", arguments: "{\"skill\":\"mobile-app-shell\"}" },
        ],
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: nextAppFiles({
          title: "超时恢复完成",
          page: "export default function Page() { return <main><h1>超时恢复完成</h1><button>保存</button><p>空状态、错误状态和成功反馈都已经就绪。</p></main>; }\n",
          css: "body { margin: 0; } main { min-height: 100vh; padding: 24px; }\n",
        }).map((file, index) => ({
          id: `call-write-${index}`,
          name: "write_file",
          arguments: JSON.stringify(file),
        })),
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 3) {
      throw new Error("Model tool-use request (coder) timed out after 90000ms");
    }

    return {
      content: "",
      toolCalls: [
        ...minimalArchitecturePlanDraft().tasks.map((task, index) => ({
          id: `call-done-${index}`,
          name: "mark_task_done",
          arguments: JSON.stringify({ taskId: task.id }),
        })),
        { id: "call-build", name: "run_build", arguments: "{\"skipInstall\":true}" },
        { id: "call-audit", name: "quality_audit", arguments: "{\"focus\":\"all\"}" },
        {
          id: "call-finish",
          name: "finish_app",
          arguments: "{\"title\":\"Recovered\",\"summary\":\"Finished after compact timeout recovery.\"}",
        },
      ],
      finishReason: "tool_calls",
    };
  }
}

class FakeCompletedNoFinishNumericLengthModel extends FakeCompletedNoFinishAgentLoopModel {
  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    if (this.toolTurn !== 1) {
      return super.chatWithTools(request);
    }

    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;
    return {
      content: "",
      toolCalls: nextAppFiles({
        title: "完成但数字长度错误",
        page: [
          "export default function Page() {",
          "  const seeded = 8;",
          "  return <main><h1>完成但数字长度错误</h1><p>{seeded.length} 个精选推荐</p><button>保存</button></main>;",
          "}",
        ].join("\n"),
        css: "body { margin: 0; } main { min-height: 100vh; padding: 24px; }\n",
      }).map((file, index) => ({
        id: `call-write-${index}`,
        name: "write_file",
        arguments: JSON.stringify(file),
      })),
      finishReason: "tool_calls",
    };
  }
}

class FakeCompletedNoFinishMissingRequiredObjectFieldsModel extends FakeCompletedNoFinishAgentLoopModel {
  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    if (this.toolTurn !== 1) {
      return super.chatWithTools(request);
    }

    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;
    return {
      content: "",
      toolCalls: [
        ...nextAppFiles({
          title: "完成但地点字段缺失",
          page: "import { places } from '@/lib/data';\nexport default function Page() { return <main><h1>完成但地点字段缺失</h1>{places.map((place) => <article key={place.id}>{place.name}</article>)}<button>保存</button></main>; }\n",
          css: "body { margin: 0; } main { min-height: 100vh; padding: 24px; }\n",
        }),
        {
          path: "src/types.ts",
          content: "export interface Place { id: string; name: string; address: string; openHours: string; budget: number; }\n",
        },
        {
          path: "src/lib/data.ts",
          content: [
            "import type { Place } from '@/types';",
            "export const marker = 'missingRequiredPlaceFields';",
            "export const places: Place[] = [",
            "  {",
            "    id: 'place-1',",
            "    name: '静安寺',",
            "    budget: 50,",
            "  },",
            "];",
          ].join("\n"),
        },
      ].map((file, index) => ({
        id: `call-write-${index}`,
        name: "write_file",
        arguments: JSON.stringify(file),
      })),
      finishReason: "tool_calls",
    };
  }
}

class FakeManyToolCallsProtocolModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;
    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
          { id: "call-design-2", name: "use_design_skill", arguments: "{\"skill\":\"mobile-app-shell\"}" },
          { id: "call-list", name: "list_files", arguments: "{}" },
          { id: "call-extra", name: "search_text", arguments: "{\"query\":\"never-executed-this-turn\"}" },
        ],
        finishReason: "tool_calls",
      };
    }
    if (this.toolTurn === 2) {
      const previousAssistant = [...request.messages].reverse().find((message) => message.role === "assistant" && message.toolCalls?.length);
      const previousAssistantCalls = previousAssistant?.role === "assistant" ? previousAssistant.toolCalls ?? [] : [];
      const answeredIds = new Set(
        request.messages
          .filter((message) => message.role === "tool")
          .map((message) => message.role === "tool" ? message.toolCallId : ""),
      );
      if (previousAssistantCalls.length !== 3 || previousAssistantCalls.some((call) => !answeredIds.has(call.id))) {
        throw new Error("agent loop sent unanswered assistant tool calls into the next request");
      }
      return {
        content: "",
        toolCalls: [
          { id: "call-write-package", name: "write_file", arguments: JSON.stringify({ path: "package.json", content: nextPackageJson() }) },
          { id: "call-write-config", name: "write_file", arguments: JSON.stringify({ path: "next.config.mjs", content: "export default {};\n" }) },
          { id: "call-write-tsconfig", name: "write_file", arguments: JSON.stringify({ path: "tsconfig.json", content: "{}" }) },
        ],
        finishReason: "tool_calls",
      };
    }
    return { content: "", toolCalls: [], finishReason: "stop" };
  }
}

class FakeRedundantSetupAfterProgressModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;

    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
          { id: "call-design-2", name: "use_design_skill", arguments: "{\"skill\":\"mobile-app-shell\"}" },
        ],
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: [
          { id: "call-write-package", name: "write_file", arguments: JSON.stringify({ path: "package.json", content: nextPackageJson() }) },
          { id: "call-install", name: "run_command", arguments: "{\"command\":[\"npm\",\"install\"]}" },
        ],
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 3) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference-repeat", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-repeat", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
          { id: "call-install-repeat", name: "run_command", arguments: "{\"command\":[\"npm\",\"install\"]}" },
          {
            id: "call-write-page",
            name: "write_file",
            arguments: JSON.stringify({
              path: "src/app/page.tsx",
              content: "export default function Page() { return <main><h1>Setup guard still writes work</h1><button>保存</button></main>; }\n",
            }),
          },
        ],
        finishReason: "tool_calls",
      };
    }

    return { content: "", toolCalls: [], finishReason: "stop" };
  }
}

class FakeRedundantInspectionAfterProgressModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;

    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design-1", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
        ],
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call-write-page",
            name: "write_file",
            arguments: JSON.stringify({
              path: "src/app/page.tsx",
              content: "export default function Page() { return <main><h1>Inspection guard</h1><button>保存</button></main>; }\n",
            }),
          },
        ],
        finishReason: "tool_calls",
      };
    }

    if (this.toolTurn === 3) {
      return {
        content: "",
        toolCalls: [
          { id: "call-read-page-1", name: "read_file", arguments: "{\"path\":\"src/app/page.tsx\"}" },
          { id: "call-read-page-2", name: "read_file", arguments: "{\"path\":\"src/app/page.tsx\"}" },
          { id: "call-read-page-3", name: "read_file", arguments: "{\"path\":\"src/app/page.tsx\"}" },
          { id: "call-list-1", name: "list_files", arguments: "{}" },
          { id: "call-list-2", name: "list_files", arguments: "{}" },
          { id: "call-list-3", name: "list_files", arguments: "{}" },
          {
            id: "call-write-css",
            name: "write_file",
            arguments: JSON.stringify({ path: "src/app/globals.css", content: "body { margin: 0; }\n" }),
          },
        ],
        finishReason: "tool_calls",
      };
    }

    return { content: "", toolCalls: [], finishReason: "stop" };
  }
}

class FakeStalledInspectionLoopModel extends FakeAgentToolBridgeModel {
  readonly toolRequests: ChatWithToolsRequest[] = [];

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.toolRequests.push(request);
    this.roles.push("coder");
    this.toolTurn += 1;

    if (this.toolTurn === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "call-reference", name: "inspect_reference_app", arguments: "{}" },
          { id: "call-design", name: "use_design_skill", arguments: "{\"skill\":\"frontend-design\"}" },
        ],
        finishReason: "tool_calls",
      };
    }

    const repeatedInspectionCalls = Array.from({ length: 6 }, (_, index) => {
      const slot = index % 3;
      return slot === 0
        ? { id: `call-list-${this.toolTurn}-${index}`, name: "list_files", arguments: "{}" }
        : slot === 1
          ? { id: `call-read-${this.toolTurn}-${index}`, name: "read_file", arguments: "{\"path\":\"src/app/page.tsx\"}" }
          : { id: `call-search-${this.toolTurn}-${index}`, name: "search_text", arguments: "{\"query\":\"export\"}" };
    });

    return { content: "", toolCalls: repeatedInspectionCalls, finishReason: "tool_calls" };
  }
}

class FakeIncompletePrismaSchemaModel extends FakePrismaSchemaWithoutCliModel {
  override async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    const response = await super.generateJson<T>(request);
    if (request.role !== "coder" && request.role !== "repairer") {
      return response;
    }
    const app = response as {
      files: Array<{ path: string; content: string }>;
    };
    return {
      ...app,
      summary: "包含缺失 datasource 的 Prisma schema 候选。",
      files: app.files.map((file) =>
        file.path === "prisma/schema.prisma"
          ? {
              ...file,
              content: [
                'generator client { provider = "prisma-client-js" }',
                "model TripDay { id String @id title String places Place[] }",
                "model Place { id String @id name String dayId String day TripDay @relation(fields: [dayId], references: [id]) }",
                "model Favorite { id String @id placeId String }",
              ].join("\n"),
            }
          : file,
      ),
    } as T;
  }
}

function testTools() {
  return new ToolRegistry()
    .register({
      name: "write_file",
      description: "write",
      permission: "write",
      sandboxOnly: true,
      validate: (input) => input as { path: string; content: string },
      summarizeInput: (input) => input.path,
      summarizeOutput: () => "ok",
      execute: async (input, context) => {
        await context.workspace.writeFile(input.path, input.content);
        return { ok: true };
      },
    })
    .register({
      name: "run_command",
      description: "run",
      permission: "execute",
      sandboxOnly: true,
      validate: (input) => input as { command: string[] },
      summarizeInput: (input) => input.command.join(" "),
      summarizeOutput: () => "ok",
      execute: async () => ({ exitCode: 0, output: "" }),
    })
    .register({
      name: "quality_audit",
      description: "audit",
      permission: "read",
      sandboxOnly: true,
      validate: () => ({}),
      summarizeInput: () => "audit",
      summarizeOutput: () => "passed",
      execute: async () => ({ status: "passed", blockingFailures: 0, checks: [] }),
    })
    .register({
      name: "submit_candidate",
      description: "submit",
      permission: "collaborate",
      sandboxOnly: true,
      validate: () => ({}),
      summarizeInput: () => "submit",
      summarizeOutput: () => "ok",
      execute: async () => ({ ok: true }),
    });
}

function buildSafetyTools() {
  return new ToolRegistry()
    .register({
      name: "write_file",
      description: "write",
      permission: "write",
      sandboxOnly: true,
      validate: (input) => input as { path: string; content: string },
      summarizeInput: (input) => input.path,
      summarizeOutput: () => "ok",
      execute: async (input, context) => {
        await context.workspace.writeFile(input.path, input.content);
        return { ok: true };
      },
    })
    .register({
      name: "run_command",
      description: "run",
      permission: "execute",
      sandboxOnly: true,
      validate: (input) => input as { command: string[] },
      summarizeInput: (input) => input.command.join(" "),
      summarizeOutput: () => "ok",
      execute: async (input, context) => {
        if (input.command.join(" ") === "npm run build") {
          const source = await context.workspace.readFile("src/app/page.tsx");
          let loadingSource = "";
          try {
            loadingSource = await context.workspace.readFile("src/app/loading.tsx");
          } catch {
            loadingSource = "";
          }
          let notFoundSource = "";
          try {
            notFoundSource = await context.workspace.readFile("src/app/not-found.tsx");
          } catch {
            notFoundSource = "";
          }
          if (loadingSource.includes("<style jsx>")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> vintage-journal@1.0.0 build\n> next build\n\nFailed to compile.\n\n./src/app/loading.tsx\n'client-only' cannot be imported from a Server Component module. The error was caused by using 'styled-jsx' in './src/app/loading.tsx'. It only works in a Client Component.",
            });
            throw error;
          }
          let resourceListSource = "";
          try {
            resourceListSource = await context.workspace.readFile("src/components/ResourceList.tsx");
          } catch {
            resourceListSource = "";
          }
          if (resourceListSource.includes("<style jsx>")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> tennis-planner@0.1.0 build\n> next build\n\nFailed to compile.\n\n./src/components/ResourceList.tsx\n'client-only' cannot be imported from a Server Component module. It should only be used from a Client Component.\n\nThe error was caused by using 'styled-jsx' in './src/components/ResourceList.tsx'. It only works in a Client Component.",
            });
            throw error;
          }
          let dataSource = "";
          try {
            dataSource = await context.workspace.readFile("src/lib/data.ts");
          } catch {
            dataSource = "";
          }
          if (
            dataSource.includes("missingRequiredPlaceFields") &&
            (!/\baddress\s*:/.test(dataSource) || !/\bopenHours\s*:/.test(dataSource))
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-travel-planner@1.0.0 build\n> next build\n\n./src/lib/data.ts:4:3\nType error: Type '{ id: string; name: string; budget: number; }' is missing the following properties from type 'Place': address, openHours\n\n  2 | export const marker = 'missingRequiredPlaceFields';\n  3 | export const places: Place[] = [\n> 4 |   {\n    |   ^\n  5 |     id: 'place-1',",
            });
            throw error;
          }
          if (/href=["']\/diary\/["']\s*\+/.test(notFoundSource)) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> journal-app@0.4.0 build\n> next build\n\nFailed to compile.\n\n./src/app/not-found.tsx\nError:   x Unexpected token `div`. Expected jsx identifier",
            });
            throw error;
          }
          if (source.includes("useState<'home' | 'trips' | 'settings' | 'tripDetail'>")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> travel-planner@1.0.0 build\n> next build\n\n./src/app/page.tsx:10:112\nType error: Argument of type 'string' is not assignable to parameter of type 'SetStateAction<\"home\" | \"trips\" | \"settings\" | \"tripDetail\">'.",
            });
            throw error;
          }
          let checklistFormSource = "";
          try {
            checklistFormSource = await context.workspace.readFile("src/components/checklist/AddChecklistItemForm.tsx");
          } catch {
            checklistFormSource = "";
          }
          if (checklistFormSource.includes("useState(defaultCategories[0])")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> travel-journal@3.0.0 build\n> next build\n\n./src/components/checklist/AddChecklistItemForm.tsx:76:38\nType error: Argument of type 'string' is not assignable to parameter of type 'SetStateAction<\"证件\">'.",
            });
            throw error;
          }
          if (source.includes(".filter(Boolean)") && source.includes("toggleMustGo(place!.id)")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> travel-favorites@1.0.0 build\n> next build\n\n./src/app/page.tsx:8:96\nType error: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.\n  Type 'undefined' is not assignable to type 'string'.",
            });
            throw error;
          }
          if (/^\s*<img\s+src=\{[A-Za-z_$][\w$]*\.image\}/m.test(source)) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> travel-inspiration@1.0.0 build\n> next build\n\n./src/app/page.tsx:6:12\nType error: Type 'string | undefined' is not assignable to type 'string | StaticImport'.\n  Type 'undefined' is not assignable to type 'string | StaticImport'.",
            });
            throw error;
          }
          let placePageSource = "";
          try {
            placePageSource = await context.workspace.readFile("src/app/place/[placeId]/page.tsx");
          } catch {
            placePageSource = "";
          }
          if (placePageSource.includes("value={place.address}")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-place-journal@1.0.0 build\n> next build\n\n./src/app/place/[placeId]/page.tsx:6:58\nType error: Type 'string | undefined' is not assignable to type 'string'.\n  Type 'undefined' is not assignable to type 'string'.\n\n  4 | export default function PlacePage({ params }: { params: { placeId: string } }) {\n  5 |   const place = places.find((item) => item.id === params.placeId) ?? places[0];\n> 6 |   return <main><h1>{place.name}</h1><InfoItem label=\"地址\" value={place.address} /><InfoItem label=\"开放时间\" value={place.openTime} /></main>;\n    |                                                          ^\n  7 | }",
            });
            throw error;
          }
          let prismaSource = "";
          try {
            prismaSource = await context.workspace.readFile("src/lib/prisma.ts");
          } catch {
            prismaSource = "";
          }
          if (prismaSource.includes("process.env.VERCEL?. !== '1'")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> restaurant-journal@1.0.0 build\n> next build\n\nFailed to compile.\n\n./src/lib/prisma.ts\nError:   x Expected ident\n   ,-[/tmp/sandbox/src/lib/prisma.ts:2:1]\n 2 |   return process.env.NODE_ENV !== 'production' || process.env.VERCEL?. !== '1';\n   :                                                                          ^^^\n   `----\nCaused by: Syntax Error",
            });
            throw error;
          }
          let favoriteItemSource = "";
          try {
            favoriteItemSource = await context.workspace.readFile("src/components/FavoriteItem.tsx");
          } catch {
            favoriteItemSource = "";
          }
          let favoriteListSource = "";
          try {
            favoriteListSource = await context.workspace.readFile("src/components/FavoriteList.tsx");
          } catch {
            favoriteListSource = "";
          }
          let relativeFavoritesSource = "";
          try {
            relativeFavoritesSource = await context.workspace.readFile("src/lib/favorites.ts");
          } catch {
            relativeFavoritesSource = "";
          }
          let relativeTypesSource = "";
          try {
            relativeTypesSource = await context.workspace.readFile("src/lib/types.ts");
          } catch {
            relativeTypesSource = "";
          }
          let serverDataSource = "";
          try {
            serverDataSource = await context.workspace.readFile("src/lib/server-data.ts");
          } catch {
            serverDataSource = "";
          }
          if (
            serverDataSource.includes("getPlacesByDay") &&
            serverDataSource.includes("from './data'") &&
            !/export\s+function\s+getPlacesByDay/.test(dataSource)
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-travel-planner@1.0.0 build\n> next build\n\n./src/lib/server-data.ts:1:31\nType error: '\"./data\"' has no exported member named 'getPlacesByDay'. Did you mean 'getDayById'?\n\n> 1 | export { getAllDays, getDayById, getPlacesByDay } from './data';\n    |                               ^",
            });
            throw error;
          }
          if (
            dataSource.includes("district: '闵行'") &&
            /\btype\s+District\s*=\s*'静安'\s*\|\s*'黄浦'\s*\|\s*'徐汇'\s*;/.test(relativeTypesSource)
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-districts@1.0.0 build\n> next build\n\n./src/lib/data.ts:4:41\nType error: Type '\"闵行\"' is not assignable to type '\"静安\" | \"黄浦\" | \"徐汇\"'.\n\n  2 | export const places: Place[] = [\n  3 |   { id: 'jing-an', name: '静安寺', district: '静安' },\n> 4 |   { id: 'powerlong', name: '上海宝龙美术馆', district: '闵行' },\n    |                                         ^\n  5 | ];",
            });
            throw error;
          }
          let favoriteButtonSource = "";
          try {
            favoriteButtonSource = await context.workspace.readFile("src/components/FavoriteButton.tsx");
          } catch {
            favoriteButtonSource = "";
          }
          if (favoriteButtonSource.includes("isFavorited(locationId)")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-favorites@1.0.0 build\n> next build\n\n./src/components/FavoriteButton.tsx:7:17\nType error: This expression is not callable.\n  Type 'Boolean' has no call signatures.\n\n> 7 |   const isFav = isFavorited(locationId);\n    |                 ^",
            });
            throw error;
          }
          if (
            relativeFavoritesSource.includes("import type { Favorite } from './types'") &&
            !/export\s+(?:interface|type)\s+Favorite\b/.test(relativeTypesSource)
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-handscroll@1.0.0 build\n> next build\n\n./src/lib/favorites.ts:3:15\nType error: Module '\"./types\"' has no exported member 'Favorite'.\n\n  1 | // LocalStorage favorites management\n  2 |\n> 3 | import type { Favorite } from './types';\n    |               ^",
            });
            throw error;
          }
          if (
            favoriteListSource.includes("import type { Favorite") &&
            favoriteListSource.includes("@/lib/data") &&
            !/export\s+(?:interface|type)\s+Favorite\b/.test(dataSource)
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-journal-planner@0.1.0 build\n> next build\n\n./src/components/FavoriteList.tsx:1:15\nType error: Module '\"@/lib/data\"' has no exported member 'Favorite'.\n\n> 1 | import type { Favorite, Location } from '@/lib/data';\n    |               ^",
            });
            throw error;
          }
          let locationDetailSource = "";
          try {
            locationDetailSource = await context.workspace.readFile("src/app/location/[locationId]/page.tsx");
          } catch {
            locationDetailSource = "";
          }
          if (locationDetailSource.includes("weatherAlt={displayAlt}")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-travel-journal@1.0.0 build\n> next build\n\n./src/app/location/[locationId]/page.tsx:60:9\nType error: Type 'Location | null | undefined' is not assignable to type 'Location | null'.\n  Type 'undefined' is not assignable to type 'Location | null'.\n\n  58 |       <LocationHero\n  59 |         location={location}\n> 60 |         weatherAlt={displayAlt}\n     |         ^\n  61 |       />",
            });
            throw error;
          }
          let dayDetailSource = "";
          try {
            dayDetailSource = await context.workspace.readFile("src/app/day/[dayId]/page.tsx");
          } catch {
            dayDetailSource = "";
          }
          if (dayDetailSource.includes("getPlacesForDay(dayWithWeather, places)")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-handscroll@1.0.0 build\n> next build\n\n./src/app/day/[dayId]/page.tsx:9:53\nType error: Argument of type 'Place[]' is not assignable to parameter of type '\"sunny\" | \"rainy\"'.\n\n   7 |   const [weather, setWeather] = useState<WeatherMode>('sunny');\n   8 |   const dayWithWeather = { ...day, weather };\n>  9 |   const dayPlaces = getPlacesForDay(dayWithWeather, places);\n     |                                                     ^",
            });
            throw error;
          }
          if (dayDetailSource.includes("day.weatherAlternatives[loc.id]")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-travel-journal@1.0.0 build\n> next build\n\n./src/app/day/[dayId]/page.tsx:43:56\nType error: Property 'id' does not exist on type 'string'.\n\n  41 |   // Compute display locations based on weather\n  42 |   const displayLocations = day.locations.map(loc => {\n> 43 |     if (weather === '雨' && day.weatherAlternatives[loc.id]) {\n     |                                                        ^\n  44 |       const alt = getLocationById(day.weatherAlternatives[loc.id]);\n  45 |       return alt || loc;\n  46 |     }",
            });
            throw error;
          }
          if (
            favoriteItemSource.includes("findLocationById") &&
            favoriteItemSource.includes("@/lib/data") &&
            !/export\s+function\s+findLocationById/.test(dataSource)
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-trip-planner@1.0.0 build\n> next build\n\n./src/components/FavoriteItem.tsx:4:10\nType error: Module '\"@/lib/data\"' has no exported member 'findLocationById'.\n\n  2 |\n  3 | import React from 'react';\n> 4 | import { findLocationById } from '@/lib/data';\n    |          ^",
            });
            throw error;
          }
          if (
            favoriteItemSource.includes("getPlacesByType") &&
            favoriteItemSource.includes("@/lib/data") &&
            !/export\s+function\s+getPlacesByType/.test(dataSource)
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-trip-planner@1.0.0 build\n> next build\n\n./src/components/FavoriteItem.tsx:1:28\nType error: Module '\"@/lib/data\"' has no exported member 'getPlacesByType'.\n\n> 1 | import { findLocationById, getPlacesByType } from '@/lib/data';\n    |                            ^",
            });
            throw error;
          }
          if (
            favoriteItemSource.includes("getAllPlaces") &&
            favoriteItemSource.includes("@/lib/data") &&
            !/export\s+function\s+getAllPlaces/.test(dataSource)
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-trip-planner@1.0.0 build\n> next build\n\n./src/components/FavoriteItem.tsx:1:28\nType error: Module '\"@/lib/data\"' has no exported member 'getAllPlaces'.\n\n> 1 | import { findLocationById, getAllPlaces, getPlacesByType } from '@/lib/data';\n    |                            ^",
            });
            throw error;
          }
          let favoritesSource = "";
          try {
            favoritesSource = await context.workspace.readFile("src/lib/favorites.ts");
          } catch {
            favoritesSource = "";
          }
          if (source.includes("seeded.length")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-travel-planner@1.0.0 build\n> next build\n\n./src/app/page.tsx:4:28\nType error: Property 'length' does not exist on type '8'.\n\n  2 | export default function Page() {\n  3 |   const seeded = 8;\n> 4 |   return <main>{seeded.length} 个精选推荐</main>;\n    |                            ^\n  5 | }",
            });
            throw error;
          }
          if (favoritesSource.includes("addedAt: Date.now()")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-trip-planner@1.0.0 build\n> next build\n\n./src/lib/favorites.ts:24:5\nType error: Type 'number' is not assignable to type 'string'.\n\n  22 |     locationId,\n  23 |     isMustGo: false,\n> 24 |     addedAt: Date.now(),\n     |     ^",
            });
            throw error;
          }
          if (source.includes("import { records, Record } from '@/lib/data'") && /^\s*type\s+Record\s*=/.test(dataSource)) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> restaurant-history@1.0.0 build\n> next build\n\n./src/app/page.tsx:1:19\nType error: Module '\"@/lib/data\"' declares 'Record' locally, but it is not exported.\n\n> 1 | import { records, Record } from '@/lib/data';\n    |                   ^",
            });
            throw error;
          }
          let storageSource = "";
          try {
            storageSource = await context.workspace.readFile("src/lib/storage.ts");
          } catch {
            storageSource = "";
          }
          let feedbackSource = "";
          try {
            feedbackSource = await context.workspace.readFile("src/components/FeedbackList.tsx");
          } catch {
            feedbackSource = "";
          }
          if (
            feedbackSource.includes("import { getCompletions, Completion } from '@/lib/storage'") &&
            storageSource.includes("import { Completion } from './types'") &&
            !storageSource.includes("export type { Completion }")
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> tennis-planner@0.1.0 build\n> next build\n\n./src/components/FeedbackList.tsx:4:26\nType error: Module '\"@/lib/storage\"' declares 'Completion' locally, but it is not exported.\n\n> 4 | import { getCompletions, Completion } from '@/lib/storage';\n    |                          ^",
            });
            throw error;
          }
          let generatedHistorySource = "";
          try {
            generatedHistorySource = await context.workspace.readFile("src/components/HistoryView.tsx");
          } catch {
            generatedHistorySource = "";
          }
          if (
            generatedHistorySource.includes("const grouped = groupByMonth(filteredEntries);") &&
            generatedHistorySource.includes("entry.id")
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> restaurant-history@1.0.0 build\n> next build\n\n./src/components/HistoryView.tsx:9:74\nType error: Property 'id' does not exist on type '{ date: string; }'.\n\n\u001b[0m \u001b[90m  7 |\u001b[39m   const grouped = groupByMonth(filteredEntries);\n \u001b[90m  8 |\u001b[39m   return <section>{Array.from(grouped.entries()).map(([month, { entries }]) => (\n\u001b[31m>\u001b[39m\u001b[90m  9 |\u001b[39m     <div key={month}>{entries.map((entry) => <article key={entry.id}>{entry.title}</article>)}</div>",
            });
            throw error;
          }
          let tripDetailSource = "";
          try {
            tripDetailSource = await context.workspace.readFile("src/app/trips/[id]/page.tsx");
          } catch {
            tripDetailSource = "";
          }
          if (
            tripDetailSource.includes("import { Activity, Trip } from '@/lib/types'") &&
            tripDetailSource.includes("import { Activity } from 'lucide-react'")
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> solotrip@0.1.0 build\n> next build\n\n./src/app/trips/[id]/page.tsx:9:10\nType error: Duplicate identifier 'Activity'.",
            });
            throw error;
          }
          if (storageSource.includes("activity: Activity") && !storageSource.includes("Activity, Trip")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> solotrip@0.1.0 build\n> next build\n\n./src/lib/storage.ts:3:56\nType error: Cannot find name 'Activity'.",
            });
            throw error;
          }
          if (source.includes("<ChevronRight />") && !/import\s+\{[^}]*ChevronRight[^}]*\}\s+from\s+'lucide-react'/.test(source)) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-walk@1.0.0 build\n> next build\n\n./src/app/page.tsx:12:84\nType error: Cannot find name 'ChevronRight'.",
            });
            throw error;
          }
          if (/import\s+\{[^}]*ForkKnife[^}]*\}\s+from\s+'lucide-react'/.test(source)) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-walk@1.0.0 build\n> next build\n\n./src/app/page.tsx:3:10\nType error: Module '\"lucide-react\"' has no exported member 'ForkKnife'.",
            });
            throw error;
          }
          if (source.includes("places[0]?.name")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-walk@1.0.0 build\n> next build\n\n./src/app/page.tsx:12:96\nType error: Property 'name' does not exist on type '{ id: string; timeSlot: string; }'.",
            });
            throw error;
          }
          const files = await context.workspace.listFiles();
          if (files.includes("src/app/day/[day]/page.tsx") && files.includes("src/app/day/[dayId]/page.tsx")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-days@1.0.0 build\n> next build\n\nError: You cannot use different slug names for the same dynamic path ('dayId' !== 'day').\n    at handleSlug (node_modules/next/dist/shared/lib/router/utils/sorted-routes.js:94:31)\n    at getSortedRoutes (node_modules/next/dist/shared/lib/router/utils/sorted-routes.js:165:21)",
            });
            throw error;
          }
          if (files.includes("src/app/page.tsx") && files.includes("src/app/[[...slug]]/page.tsx")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shiji-app@0.1.0 build\n> next build\n\nError: You cannot define a route with the same specificity as a optional catch-all route (\"/\" and \"/[[...slug]]\").",
            });
            throw error;
          }
          let historySource = "";
          try {
            historySource = await context.workspace.readFile("src/app/history/page.tsx");
          } catch {
            historySource = "";
          }
          if (historySource.trim().startsWith("// Removed:")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-favorites@1.0.0 build\n> next build\n\nsrc/app/history/page.tsx\nType error: File '/tmp/sandbox/src/app/history/page.tsx' is not a module.",
            });
            throw error;
          }
          let budgetSource = "";
          try {
            budgetSource = await context.workspace.readFile("src/app/budget/page.tsx");
          } catch {
            budgetSource = "";
          }
          if (budgetSource.includes("saveBudgetAdjustments(budgets)")) {
            let typesIndexSource = "";
            try {
              typesIndexSource = await context.workspace.readFile("src/types/index.ts");
            } catch {
              typesIndexSource = "";
            }
            let libTypesSource = "";
            try {
              libTypesSource = await context.workspace.readFile("src/lib/types.ts");
            } catch {
              libTypesSource = "";
            }
            if (
              /\bcategories\s*:\s*Record\s*<\s*string\s*,\s*number\s*>/.test(typesIndexSource) &&
              /\bcategories\s*:\s*\{\s*餐饮\s*:\s*number\s*;\s*门票\s*:\s*number\s*;\s*交通\s*:\s*number\s*;\s*其他\s*:\s*number\s*;?\s*\}/.test(libTypesSource)
            ) {
              const error = new Error("Command failed: npm run build");
              Object.assign(error, {
                exitCode: 1,
                output:
                  "> plane-tree-guide@1.0.0 build\n> next build\n\n./src/app/budget/page.tsx:41:27\nType error: Argument of type 'import(\"/tmp/sandbox/src/types/index\").Budget[]' is not assignable to parameter of type 'import(\"/tmp/sandbox/src/lib/types\").Budget[]'.\n  Type 'import(\"/tmp/sandbox/src/types/index\").Budget' is not assignable to type 'import(\"/tmp/sandbox/src/lib/types\").Budget'.\n    Types of property 'categories' are incompatible.\n      Type 'Record<string, number>' is missing the following properties from type '{ 餐饮: number; 门票: number; 交通: number; 其他: number; }': '餐饮', '门票', '交通', '其他'\n\n  39 |\n  40 |   const handleSave = useCallback(() => {\n> 41 |     saveBudgetAdjustments(budgets);\n     |                           ^",
              });
              throw error;
            }
          }
          if (budgetSource.includes("budgetCategory")) {
            let demoDataSource = "";
            try {
              demoDataSource = await context.workspace.readFile("src/lib/demo-data.ts");
            } catch {
              demoDataSource = "";
            }
            if (!/budgetCategory\??\s*:/.test(demoDataSource)) {
              const error = new Error("Command failed: npm run build");
              Object.assign(error, {
                exitCode: 1,
                output:
                  "> journal-app@0.1.0 build\n> next build\n\n./src/app/budget/page.tsx:8:43\nType error: Property 'budgetCategory' does not exist on type 'DomainItem'.\n\n\u001b[0m \u001b[90m  6 |\u001b[39m   const rows = categories.map((category) => ({",
              });
              throw error;
            }
          }
          let demoDataSource = "";
          try {
            demoDataSource = await context.workspace.readFile("src/lib/demo-data.ts");
          } catch {
            demoDataSource = "";
          }
          let generatedTypesSource = "";
          try {
            generatedTypesSource = await context.workspace.readFile("src/lib/types.ts");
          } catch {
            generatedTypesSource = "";
          }
          if (/export\s*\{\s*TYPE_LABELS\s*\}/.test(demoDataSource)) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-budget@1.0.0 build\n> next build\n\nFailed to compile.\n\n./src/lib/demo-data.ts\nModule parse failed: Export 'TYPE_LABELS' is not defined (1:9)\nFile was processed with these loaders:\n * ./node_modules/next/dist/build/webpack/loaders/next-swc-loader.js\nYou may need an additional loader to handle the result of these loaders.\n> export { TYPE_LABELS };\n| const imageBase = 'https://images.unsplash.com/photo-';\n| export const places = [];",
            });
            throw error;
          }
          if (
            demoDataSource.includes("tips: '建议早上九点前到达。'") &&
            /export\s+interface\s+Place\b/.test(generatedTypesSource) &&
            !/\btips\??\s*:/.test(generatedTypesSource)
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-trip-planner@1.0.0 build\n> next build\n\n./src/lib/demo-data.ts:8:5\nType error: Object literal may only specify known properties, and 'tips' does not exist in type 'Place'.\n\n  6 |     name: '静安寺',\n  7 |     description: '闹市里的寺院和梧桐街景。',\n> 8 |     tips: '建议早上九点前到达。',\n    |     ^",
            });
            throw error;
          }
          if (demoDataSource.includes("budgetRange: { min: 40 }")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-travel-journal@1.0.0 build\n> next build\n\n./src/lib/demo-data.ts:7:5\nType error: Property 'max' is missing in type '{ min: number; }' but required in type '{ min: number; max: number; }'.\n\n  5 |     id: 'old-lane-noodle',\n  6 |     name: '弄堂面馆',\n> 7 |     budgetRange: { min: 40 },\n    |     ^",
            });
            throw error;
          }
          let tripDataSource = "";
          try {
            tripDataSource = await context.workspace.readFile("src/lib/trip-data.ts");
          } catch {
            tripDataSource = "";
          }
          let itineraryApiSource = "";
          try {
            itineraryApiSource = await context.workspace.readFile("src/app/api/itinerary/route.ts");
          } catch {
            itineraryApiSource = "";
          }
          if (
            (source.includes("demoDays") || itineraryApiSource.includes("demoDays")) &&
            tripDataSource.includes("export const tripDays") &&
            !/export\s+const\s+demoDays\b/.test(tripDataSource)
          ) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-trip-planner@1.0.0 build\n> next build\n\n./src/app/api/itinerary/route.ts:2:10\nType error: Module '\"@/lib/trip-data\"' has no exported member 'demoDays'.\n\n  1 | import { NextResponse } from 'next/server';\n> 2 | import { demoDays } from '@/lib/trip-data';\n    |          ^",
            });
            throw error;
          }
          let errorBoundarySource = "";
          try {
            errorBoundarySource = await context.workspace.readFile("src/app/error.tsx");
          } catch {
            errorBoundarySource = "";
          }
          let errorBannerSource = "";
          try {
            errorBannerSource = await context.workspace.readFile("src/components/ErrorBanner.tsx");
          } catch {
            errorBannerSource = "";
          }
          if (errorBoundarySource.includes("<ErrorBanner title=") && errorBannerSource.includes("interface ErrorBannerProps") && !/title\??\s*:/.test(errorBannerSource)) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-trip-planner@1.0.0 build\n> next build\n\n./src/app/error.tsx:6:23\nType error: Type '{ title: string; message: string; onRetry: () => void; }' is not assignable to type 'IntrinsicAttributes & ErrorBannerProps'.\n  Property 'title' does not exist on type 'IntrinsicAttributes & ErrorBannerProps'.",
            });
            throw error;
          }
          let routeSource = "";
          try {
            routeSource = await context.workspace.readFile("src/app/api/items/route.ts");
          } catch {
            routeSource = "";
          }
          if (routeSource.includes("getDomainItems")) {
            let dbSource = "";
            try {
              dbSource = await context.workspace.readFile("src/lib/db.ts");
            } catch {
              dbSource = "";
            }
            if (!/export\s+async\s+function\s+getDomainItems|export\s+function\s+getDomainItems|export\s+const\s+getDomainItems/.test(dbSource)) {
              const error = new Error("Command failed: npm run build");
              Object.assign(error, {
                exitCode: 1,
                output:
                  "> travel-journal@1.0.0 build\n> next build\n\n./src/app/api/items/route.ts:2:10\nType error: Module '\"@/lib/db\"' has no exported member 'getDomainItems'.",
              });
              throw error;
            }
          }
          let statsRouteSource = "";
          try {
            statsRouteSource = await context.workspace.readFile("src/app/api/entries/stats/route.ts");
          } catch {
            statsRouteSource = "";
          }
          if (statsRouteSource.includes("location: { not: null }, location: { not: '' }")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> travel-journal@0.1.0 build\n> next build\n\nFailed to compile.\n\n./src/app/api/entries/stats/route.ts:7:39\nType error: An object literal cannot have multiple properties with the same name.\n\n   5 |   const total = await prisma.entry.count();\n   6 |   const locations = await prisma.entry.count({\n>  7 |     where: { location: { not: null }, location: { not: '' } },\n     |                                       ^\n   8 |   });\n   9 |   return NextResponse.json({ total, locations });\n  10 | }",
            });
            throw error;
          }
          let entryDetailSource = "";
          try {
            entryDetailSource = await context.workspace.readFile("src/components/EntryDetail.tsx");
          } catch {
            entryDetailSource = "";
          }
          if (entryDetailSource.includes("date: string;")) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> travel-journal@0.1.0 build\n> next build\n\n./src/app/entry/[id]/page.tsx:7:23\nType error: Type '{ id: number; title: string; date: Date; createdAt: Date; updatedAt: Date; }' is not assignable to type 'Entry'.\n  Types of property 'date' are incompatible.\n    Type 'Date' is not assignable to type 'string'.\n\n> 7 |   return <EntryDetail entry={entry} />;\n    |                       ^",
            });
            throw error;
          }
        }
        if (input.command[0] === "npx") {
          throw new Error(`Unexpected Prisma command in unit test: ${input.command.join(" ")}`);
        }
        return { exitCode: 0, output: "ok" };
      },
    })
    .register({
      name: "quality_audit",
      description: "audit",
      permission: "read",
      sandboxOnly: true,
      validate: () => ({}),
      summarizeInput: () => "audit",
      summarizeOutput: () => "passed",
      execute: async () => ({ status: "passed", blockingFailures: 0, checks: [] }),
    })
    .register({
      name: "submit_candidate",
      description: "submit",
      permission: "collaborate",
      sandboxOnly: true,
      validate: () => ({}),
      summarizeInput: () => "submit",
      summarizeOutput: () => "ok",
      execute: async () => ({ ok: true }),
    });
}

test("QueryEngine stops for clarification on vague requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const result = await engine().run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "做一个旅游应用",
  });

  assert.equal(result.run.status, "awaiting_input");
  assert.equal(result.run.phase, "clarify");
  assert.ok(result.clarificationRequest?.questions.length);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine uses the model to generate content-specific clarification", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeClarifierModel();
  const result = await engineWithModel(model).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-model-clarify",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "做一个演唱会抢票 App",
  });

  assert.equal(result.run.status, "awaiting_input");
  assert.equal(model.requests[0]?.role, "clarifier");
  assert.match(model.requests[0]?.user ?? "", /演唱会抢票/);
  assert.equal(result.clarificationRequest?.questions[0]?.header, "抢票流程");
  assert.match(result.messages.at(-1)?.content ?? "", /抢票/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine lets the model decide that a first-round prompt is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeReadyClarifierModel();
  const result = await engineWithModel(model).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-ready-clarifier",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个高质感中文移动端旅行灵感 app，包含首页灵感流、路线详情、收藏状态和底部导航，视觉像旅行杂志。",
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.clarificationRequest, undefined);
  assert.deepEqual(model.roles, ["clarifier", "design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine can submit a candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const result = await engine().run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-2",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage:
      "生成一个移动优先的上海旅行规划应用，必须包含首页、按天行程、地点卡片、预算和收藏，视觉做成内容杂志感。",
    clarificationAnswers: [{ questionId: "scope", answer: "完整多页原型" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.ok(result.candidate);
  assert.ok(result.designBrief);
  assert.equal(result.run.designBrief?.runId, "run-2");
  assert.ok(result.run.tasks.some((task) => task.owner === "design_director" && task.status === "completed"));
  assert.ok(result.candidate.changedFiles.some((file) => file.path === "src/app/page.tsx"));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine can pause final acceptance and still submit a preview candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeReadyClarifierModel();
  const result = await previewFirstEngineWithModel(model).run({
    projectId: "project-preview-first",
    sessionId: "session-preview-first",
    runId: "run-preview-first",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个高质感中文移动端旅行灵感 app，包含首页灵感流、路线详情、收藏状态和底部导航。",
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.phase, "approval");
  assert.equal(result.candidate?.validation.status, "pending");
  assert.match(result.candidate?.validation.summary ?? "", /最终候选验收已暂停/);
  assert.ok(result.run.tasks.some((task) => task.title === "预览前构建与数据库验证" && task.status === "completed"));
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "npm run build"));
  assert.deepEqual(model.roles, ["clarifier", "design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine produces an architecture plan with tasks before generating", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const result = await engine().run({
    projectId: "project-architect",
    sessionId: "session-architect",
    runId: "run-architect",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage:
      "生成一个移动优先的多页旅行规划应用，包含首页探索、行程日历、地点详情、预算追踪和我的收藏，使用编辑感杂志视觉。",
    clarificationAnswers: [{ questionId: "scope", answer: "完整多页原型" }],
  });

  // Architect ran and produced a structured plan
  assert.ok(result.architecturePlan, "architecturePlan should be present");
  assert.ok(result.run.architecturePlan, "run.architecturePlan should be persisted");
  assert.equal(result.run.architecturePlan?.runId, "run-architect");
  assert.ok(result.architecturePlan!.tasks.length >= 3, "plan should contain at least 3 tasks");
  assert.ok(result.architecturePlan!.fileTree.length >= 4, "plan should include a meaningful file tree");
  // Architect task is visible in the run timeline
  assert.ok(
    result.run.tasks.some((task) => task.owner === "architect" && task.status === "completed"),
    "an architect task should be marked completed",
  );
  // Subsequent steps still produce a candidate (architect doesn't block the pipeline)
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.ok(result.candidate);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine completes missing Next.js TypeScript scaffold files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const result = await engineWithModel(new FakeCoderMissingTsConfigModel()).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-missing-tsconfig",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个移动优先的旅行规划应用，包含探索和我的行程。",
    clarificationAnswers: [{ questionId: "scope", answer: "solo explore mytrips" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.ok(result.candidate?.changedFiles.some((file) => file.path === "tsconfig.json"));
  assert.ok(result.candidate?.changedFiles.some((file) => file.path === "next-env.d.ts"));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine sanitizes placeholder content before submitting a candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakePlaceholderRepairModel();
  const result = await engineWithModel(model).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-placeholder-repair",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个移动优先的国内景点探索应用，服务独立旅行者。",
    clarificationAnswers: [{ questionId: "scope", answer: "attractions independent domestic" }],
  });

  assert.equal(result.run.status, "awaiting_approval");
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  assert.ok(result.candidate);
  const page = await readFile(join(root, ".agent", "sandboxes", "run-placeholder-repair", "src", "app", "page.tsx"), "utf8");
  assert.doesNotMatch(page, /Lorem ipsum|TODO|待实现|coming soon/i);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs string state setter build errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeBrokenStateSetterModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-build-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个旅行规划工具，包含首页、行程、设置和行程详情。",
    clarificationAnswers: [{ questionId: "scope", answer: "mobile itinerary planner" }],
  });

  const appSource = await readFile(join(root, ".agent", "sandboxes", "run-build-safety", "src", "app", "page.tsx"), "utf-8");
  const checklistFormSource = await readFile(
    join(root, ".agent", "sandboxes", "run-build-safety", "src", "components", "checklist", "AddChecklistItemForm.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(appSource, /useState<string>/);
  assert.match(checklistFormSource, /useState<string>\(defaultCategories\[0\]\)/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs contextual string union build errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeContextualStringUnionModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-district",
    sessionId: "session-district",
    runId: "run-district-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海区县旅行应用，包含多个行政区地点。",
    clarificationAnswers: [{ questionId: "scope", answer: "mobile district planner" }],
  });

  const typesSource = await readFile(join(root, ".agent", "sandboxes", "run-district-safety", "src", "lib", "types.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(typesSource, /export type District = '静安' \| '黄浦' \| '徐汇' \| '闵行';/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs styled-jsx in App Router loading files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeStyledJsxLoadingModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-styled-jsx-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个复古日记 App，包含今日记录、日历、历史和设置。",
    clarificationAnswers: [{ questionId: "scope", answer: "vintage journal mobile product" }],
  });

  const loadingSource = await readFile(join(root, ".agent", "sandboxes", "run-styled-jsx-safety", "src", "app", "loading.tsx"), "utf-8");
  const globalCss = await readFile(join(root, ".agent", "sandboxes", "run-styled-jsx-safety", "src", "app", "globals.css"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.doesNotMatch(loadingSource, /<style\s+jsx/);
  assert.match(globalCss, /journal-loading/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs styled-jsx in server-imported component files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeStyledJsxComponentModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-styled-jsx-component-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个网球训练资料 App，包含资料清单和今日训练。",
    clarificationAnswers: [{ questionId: "scope", answer: "tennis training resources mobile product" }],
  });

  const componentSource = await readFile(
    join(root, ".agent", "sandboxes", "run-styled-jsx-component-safety", "src", "components", "ResourceList.tsx"),
    "utf-8",
  );
  const globalCss = await readFile(join(root, ".agent", "sandboxes", "run-styled-jsx-component-safety", "src", "app", "globals.css"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.doesNotMatch(componentSource, /<style\s+jsx/);
  assert.match(globalCss, /resource-item/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs missing re-exported local types", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeReexportedLocalTypeModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-local-type-reexport-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个网球练习反馈 App，包含练习记录列表。",
    clarificationAnswers: [{ questionId: "scope", answer: "tennis feedback mobile product" }],
  });

  const storageSource = await readFile(join(root, ".agent", "sandboxes", "run-local-type-reexport-safety", "src", "lib", "storage.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(storageSource, /export type \{ Completion \} from '\.\/types';/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs duplicate local type and lucide icon imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeDuplicateImportedTypeAndIconModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-duplicate-imported-activity-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个独自旅行计划 App，包含行程详情和活动管理。",
    clarificationAnswers: [{ questionId: "scope", answer: "solo trip planner with activity management" }],
  });

  const sandboxRoot = join(root, ".agent", "sandboxes", "run-duplicate-imported-activity-safety");
  const tripDetailSource = await readFile(join(sandboxRoot, "src", "app", "trips", "[id]", "page.tsx"), "utf-8");
  const storageSource = await readFile(join(sandboxRoot, "src", "lib", "storage.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.doesNotMatch(tripDetailSource, /import \{ Activity \} from 'lucide-react';/);
  assert.match(tripDetailSource, /import \{ Activity, Trip \} from '@\/lib\/types';/);
  assert.match(storageSource, /import \{ Activity, Trip \} from '\.\/types';/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 3);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs conflicting same-name local type definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeConflictingBudgetTypeModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-conflicting-budget-type-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海慢旅行预算 App，包含预算保存。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai travel budget mobile product" }],
  });

  const sandboxRoot = join(root, ".agent", "sandboxes", "run-conflicting-budget-type-safety");
  const typesIndexSource = await readFile(join(sandboxRoot, "src", "types", "index.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(typesIndexSource, /categories:\s*\{\s*餐饮:\s*number;\s*门票:\s*number;\s*交通:\s*number;\s*其他:\s*number;?\s*\}/);
  assert.doesNotMatch(typesIndexSource, /categories:\s*Record<string,\s*number>/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 2);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs missing required object literal range properties", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeIncompleteBudgetRangeModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-incomplete-budget-range-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海文艺旅行 App，包含地点预算区间。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai travel journal with budget ranges" }],
  });

  const sandboxRoot = join(root, ".agent", "sandboxes", "run-incomplete-budget-range-safety");
  const demoDataSource = await readFile(join(sandboxRoot, "src", "lib", "demo-data.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(demoDataSource, /budgetRange:\s*\{\s*min:\s*40,\s*max:\s*60\s*\}/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 2);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs excess object literal fields by widening named types", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeExcessPlacePropertyModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-excess-place-property-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海寺庙慢旅行 App，地点卡片包含游玩建议。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai travel place tips app" }],
  });

  const sandboxRoot = join(root, ".agent", "sandboxes", "run-excess-place-property-safety");
  const typesSource = await readFile(join(sandboxRoot, "src", "lib", "types.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(typesSource, /tips\?: string;/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 2);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs missing local array alias exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeMissingArrayAliasExportModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-missing-array-alias-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海两日游 App，首页和接口都读取行程天数据。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai two day itinerary app" }],
  });

  const sandboxRoot = join(root, ".agent", "sandboxes", "run-missing-array-alias-safety");
  const tripDataSource = await readFile(join(sandboxRoot, "src", "lib", "trip-data.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(tripDataSource, /export const demoDays = tripDays;/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 2);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs unbraced JSX attribute concatenation before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeInvalidJsxAttributeModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-jsx-attribute-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个日记 App，404 页能回到今天的日记。",
    clarificationAnswers: [{ questionId: "scope", answer: "journal app with dated entries" }],
  });

  const notFoundSource = await readFile(
    join(root, ".agent", "sandboxes", "run-jsx-attribute-safety", "src", "app", "not-found.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(notFoundSource, /href=\{"\/diary\/" \+ new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}/);
  assert.doesNotMatch(notFoundSource, /href=["']\/diary\/["']\s*\+/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs loose truthy filters before id usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeLooseTruthyFilterModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-truthy-filter-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行收藏 App，包含收藏、筛选、必去标记和预算。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel favorites planner" }],
  });

  const appSource = await readFile(join(root, ".agent", "sandboxes", "run-truthy-filter-safety", "src", "app", "page.tsx"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.doesNotMatch(appSource, /\.filter\(\s*Boolean\s*\)/);
  assert.match(appSource, /item is NonNullable<typeof item>/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs optional image sources before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeOptionalImageSrcModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-optional-image-src-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个旅行灵感卡片 App，地点图片字段可能为空。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel inspiration cards" }],
  });

  const appSource = await readFile(join(root, ".agent", "sandboxes", "run-optional-image-src-safety", "src", "app", "page.tsx"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(appSource, /\{place\.image \? <img src=\{place\.image\} alt=\{place\.title\} \/> : null\}/);
  assert.doesNotMatch(appSource, /^\s*<img\s+src=\{place\.image\}/m);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs invalid optional env comparisons before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeInvalidOptionalEnvComparisonModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-optional-env-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个本地美食手帐 App，包含日期、餐厅记录、历史筛选和编辑删除。",
    clarificationAnswers: [{ questionId: "scope", answer: "restaurant journal with local storage" }],
  });

  const prismaSource = await readFile(
    join(root, ".agent", "sandboxes", "run-optional-env-safety", "src", "lib", "prisma.ts"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(prismaSource, /process\.env\.VERCEL !== '1'/);
  assert.doesNotMatch(prismaSource, /process\.env\.VERCEL\?\./);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs duplicate object literal keys before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeDuplicateObjectKeyModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-duplicate-key",
    sessionId: "session-duplicate-key",
    runId: "run-duplicate-key",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个中文旅行手帐 App，包含地点统计 API。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel journal with stats" }],
  });

  const routeSource = await readFile(
    join(root, ".agent", "sandboxes", "run-duplicate-key", "src", "app", "api", "entries", "stats", "route.ts"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(routeSource, /AND:\s*\[/);
  assert.doesNotMatch(routeSource, /location:\s*\{\s*not:\s*null\s*\},\s*location:/);
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "npm run build"));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs Prisma Date values passed into string-typed components", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakePrismaDateTypeMismatchModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-prisma-date",
    sessionId: "session-prisma-date",
    runId: "run-prisma-date",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个中文旅行手帐 App，详情页读取 Prisma 日期记录。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel journal detail with Prisma Date fields" }],
  });

  const detailSource = await readFile(
    join(root, ".agent", "sandboxes", "run-prisma-date", "src", "components", "EntryDetail.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(detailSource, /date: string \| Date;/);
  assert.match(detailSource, /createdAt\?: string \| Date;/);
  assert.doesNotMatch(detailSource, /date: string;/);
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "npm run build"));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs locally declared missing module exports before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeLocallyDeclaredMissingExportModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-local-export-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个餐厅历史手帐 App，包含历史记录、筛选和编辑。",
    clarificationAnswers: [{ questionId: "scope", answer: "restaurant journal history" }],
  });

  const dataSource = await readFile(join(root, ".agent", "sandboxes", "run-local-export-safety", "src", "lib", "data.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(dataSource, /^export type Record =/m);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs missing local lookup exports and timestamp string mismatches before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeMissingLookupExportAndTimestampModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-local-lookup-timestamp-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行收藏 App，包含地点查找和收藏时间。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai favorites with location lookup" }],
  });

  const sandboxRoot = join(root, ".agent", "sandboxes", "run-local-lookup-timestamp-safety");
  const dataSource = await readFile(join(sandboxRoot, "src", "lib", "data.ts"), "utf-8");
  const favoritesSource = await readFile(join(sandboxRoot, "src", "lib", "favorites.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(dataSource, /export function findLocationById\(id: string\): any/);
  assert.match(dataSource, /export function getAllPlaces\(\): any\[]/);
  assert.match(dataSource, /export function getPlacesByType\(type: string\): any\[]/);
  assert.match(dataSource, /item\?\.type \?\? item\?\.category \?\? item\?\.kind/);
  assert.match(dataSource, /collectGeneratedLookupRecords\(days\)/);
  assert.match(favoritesSource, /addedAt: new Date\(\)\.toISOString\(\),/);
  assert.doesNotMatch(favoritesSource, /Date\.now\(\)/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs missing relative lookup re-exports before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeMissingRelativeLookupReExportModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-relative-lookup-re-export-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海每日行程 App，server-data 重导出每日地点 lookup。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai itinerary with server data re-export" }],
  });

  const dataSource = await readFile(
    join(root, ".agent", "sandboxes", "run-relative-lookup-re-export-safety", "src", "lib", "data.ts"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(dataSource, /export function getPlacesByDay\(dayId: string \| number\): any\[]/);
  assert.match(dataSource, /collectGeneratedLookupRecords\(days\)/);
  assert.doesNotMatch(dataSource, /collectGeneratedLookupRecords\(records\)/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs missing local type exports before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeMissingLocalTypeExportModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-local-type-export-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行收藏 App，包含收藏筛选和必去标记。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai favorites list" }],
  });

  const dataSource = await readFile(
    join(root, ".agent", "sandboxes", "run-local-type-export-safety", "src", "lib", "data.ts"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(dataSource, /export interface Favorite/);
  assert.match(dataSource, /locationId: string/);
  assert.match(dataSource, /isMustGo\?: boolean/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs relative missing local type exports before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeRelativeMissingLocalTypeExportModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-relative-local-type-export-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行收藏 App，使用 lib/favorites 和 lib/types。",
    clarificationAnswers: [{ questionId: "scope", answer: "relative favorites types" }],
  });

  const typesSource = await readFile(
    join(root, ".agent", "sandboxes", "run-relative-local-type-export-safety", "src", "lib", "types.ts"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(typesSource, /export interface Favorite/);
  assert.match(typesSource, /locationId: string/);
  assert.match(typesSource, /isMustGo\?: boolean/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs undefined named re-exports before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeUndefinedNamedReExportModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-undefined-re-export-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行预算 App，包含地点图片和预算。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai travel budget" }],
  });

  const dataSource = await readFile(
    join(root, ".agent", "sandboxes", "run-undefined-re-export-safety", "src", "lib", "demo-data.ts"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.doesNotMatch(dataSource, /export\s*\{\s*TYPE_LABELS\s*\}/);
  assert.match(dataSource, /export const places/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs date grouping generic inference before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeDateGroupingGenericInferenceModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-date-grouping-generic-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个餐厅手帐历史 App，包含按月分组、筛选、编辑和删除。",
    clarificationAnswers: [{ questionId: "scope", answer: "restaurant journal grouped history" }],
  });

  const historySource = await readFile(
    join(root, ".agent", "sandboxes", "run-date-grouping-generic-safety", "src", "components", "HistoryView.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(historySource, /groupByMonth<RestaurantEntry>\(filteredEntries\)/);
  assert.doesNotMatch(historySource, /const grouped = groupByMonth\(filteredEntries\);/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine runs sequential build safety repairs for missing icons and reference lookups", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeSequentialBuildRepairModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-sequential-build-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海三天行程 App，首页推荐地点能进入详情。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai itinerary planner" }],
  });

  const appSource = await readFile(join(root, ".agent", "sandboxes", "run-sequential-build-safety", "src", "app", "page.tsx"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(appSource, /ChevronRight/);
  assert.match(appSource, /Utensils/);
  assert.doesNotMatch(appSource, /ForkKnife/);
  assert.match(appSource, /featuredPlace/);
  assert.doesNotMatch(appSource, /places\[0\]\?\.name/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs /api/items when db does not export getDomainItems", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeMissingDomainItemsModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-domain-items-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  const routeSource = await readFile(join(root, ".agent", "sandboxes", "run-domain-items-safety", "src", "app", "api", "items", "route.ts"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.doesNotMatch(routeSource, /getDomainItems/);
  assert.match(routeSource, /NextResponse\.json\(\{ items \}\)/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs conflicting App Router dynamic route names before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeConflictingDynamicRoutesModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-dynamic-route-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海每日路线 App，包含按天详情页。",
    clarificationAnswers: [{ questionId: "scope", answer: "shanghai daily itinerary routes" }],
  });

  const sandboxRoot = join(root, ".agent", "sandboxes", "run-dynamic-route-safety");
  const dayPage = await readFile(join(sandboxRoot, "src", "app", "day", "[day]", "page.tsx"), "utf-8");
  await assert.rejects(() => readFile(join(sandboxRoot, "src", "app", "day", "[dayId]", "page.tsx"), "utf-8"));
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(dayPage, /params\.day|params: \{ day: string \}/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs root optional catch-all conflicts before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeRootOptionalCatchAllConflictModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-optional-catch-all-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个餐厅手帐 App，包含首页和动态详情页。",
    clarificationAnswers: [{ questionId: "scope", answer: "restaurant journal with detail pages" }],
  });

  const sandboxRoot = join(root, ".agent", "sandboxes", "run-optional-catch-all-safety");
  const appSource = await readFile(join(sandboxRoot, "src", "app", "page.tsx"), "utf-8");
  await assert.rejects(() => readFile(join(sandboxRoot, "src", "app", "[[...slug]]", "page.tsx"), "utf-8"));
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(appSource, /今日食记/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs comment-only App Router route files before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeCommentOnlyRemovedRouteModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-comment-only-route-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行收藏清单 App，包含收藏筛选和预算。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel favorites with budget" }],
  });

  const sandboxRoot = join(root, ".agent", "sandboxes", "run-comment-only-route-safety");
  const favoritesPage = await readFile(join(sandboxRoot, "src", "app", "favorites", "page.tsx"), "utf-8");
  await assert.rejects(() => readFile(join(sandboxRoot, "src", "app", "history", "page.tsx"), "utf-8"));
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(favoritesPage, /FavoritesPage|我的收藏/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs missing named type properties before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeMissingNamedPropertyModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-missing-type-property-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人文字图片手帐 App，包含本地记录和分类统计。",
    clarificationAnswers: [{ questionId: "scope", answer: "text image journal with local category stats" }],
  });

  const demoDataSource = await readFile(
    join(root, ".agent", "sandboxes", "run-missing-type-property-safety", "src", "lib", "demo-data.ts"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(demoDataSource, /budgetCategory\?: string;/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs boolean favorite context calls before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeBooleanCallableFavoriteModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-boolean-favorite-context-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行收藏 App，包含地点收藏按钮。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel favorites with context state" }],
  });

  const favoriteButtonSource = await readFile(
    join(root, ".agent", "sandboxes", "run-boolean-favorite-context-safety", "src", "components", "FavoriteButton.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(favoriteButtonSource, /const \{ isFavorite, toggleFavorite, removeFavorite \} = useFavorites\(\);/);
  assert.match(favoriteButtonSource, /const isFav = isFavorite\(locationId\);/);
  assert.match(favoriteButtonSource, /toggleFavorite\(\{/);
  assert.doesNotMatch(favoriteButtonSource, /\bisFavorited\s*\(/);
  assert.doesNotMatch(favoriteButtonSource, /\baddFavorite\s*\(/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 2);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs undefined nullable JSX props before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeNullableJsxPropModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-nullable-jsx-prop-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行地点详情 App，包含雨天替代地点。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel location detail with weather alternative" }],
  });

  const locationPageSource = await readFile(
    join(root, ".agent", "sandboxes", "run-nullable-jsx-prop-safety", "src", "app", "location", "[locationId]", "page.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(locationPageSource, /weatherAlt=\{displayAlt \?\? null\}/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 2);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs undefined string JSX props before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeStringJsxPropModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-string-jsx-prop",
    sessionId: "session-string-jsx-prop",
    runId: "run-string-jsx-prop-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行地点详情 App，包含地址和开放时间。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel place detail with optional address fields" }],
  });

  const placePageSource = await readFile(
    join(root, ".agent", "sandboxes", "run-string-jsx-prop-safety", "src", "app", "place", "[placeId]", "page.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(placePageSource, /value=\{place\.address \?\? ""\}/);
  assert.match(placePageSource, /value=\{place\.openTime \?\? ""\}/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 2);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs string id map object access before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeStringIdObjectMapAccessModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-string-id-map-access-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行按天行程 App，包含晴雨天气切换。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel day itinerary with weather alternatives" }],
  });

  const dayPageSource = await readFile(
    join(root, ".agent", "sandboxes", "run-string-id-map-access-safety", "src", "app", "day", "[dayId]", "page.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(dayPageSource, /\.map\(\(locId\) => \{/);
  assert.match(dayPageSource, /const loc = getLocationById\(locId\)!;/);
  assert.match(dayPageSource, /day\.weatherAlternatives\[locId\]/);
  assert.doesNotMatch(dayPageSource, /day\.weatherAlternatives\[loc\.id\]/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 2);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs weather mode array arguments before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeWeatherModeArrayArgumentModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-weather-array-argument-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行按天行程 App，包含晴雨天气切换。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel day itinerary weather mode" }],
  });

  const dayPageSource = await readFile(
    join(root, ".agent", "sandboxes", "run-weather-array-argument-safety", "src", "app", "day", "[dayId]", "page.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(dayPageSource, /getPlacesForDay\(dayWithWeather, weather\)/);
  assert.doesNotMatch(dayPageSource, /getPlacesForDay\(dayWithWeather, places\)/);
  assert.ok(result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm run build").length >= 2);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs component prop type mismatches before build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeErrorBannerPropsModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-error-banner-props-safety",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行规划 App，包含错误恢复状态。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel planner with retryable error banner" }],
  });

  const errorBannerSource = await readFile(
    join(root, ".agent", "sandboxes", "run-error-banner-props-safety", "src", "components", "ErrorBanner.tsx"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(errorBannerSource, /title\?: string;/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine falls back when the agent tool loop model turn times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeHangingToolLoopModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools(), {}, undefined, {
    maxTurns: 1,
    maxToolCallsPerTurn: 2,
    maxToolCallsTotal: 2,
    modelTurnTimeoutMs: 25,
  });
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-tool-loop-timeout-fallback",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  const pageSource = await readFile(join(root, ".agent", "sandboxes", "run-tool-loop-timeout-fallback", "src", "app", "page.tsx"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(pageSource, /松弛但不松散|旅行/);
  assert.ok(result.run.tasks.some((task) => task.owner === "coder" && /0 次工具调用/.test(task.summary ?? "")));
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "coder"]);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine fails strict generation when the agent loop writes files but never finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeUnfinishedAgentLoopModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 3,
    maxToolCallsPerTurn: 6,
    maxToolCallsTotal: 24,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-unfinished-agent-loop",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  assert.equal(result.run.status, "failed");
  assert.match(result.run.error ?? "", /未显式调用 finish_app|生成已停止/);
  assert.ok(result.run.tasks.some((task) => task.owner === "coder" && task.status === "failed"));
  const secondTurnContext = model.toolRequests[1]?.messages.map((message) => ("content" in message ? message.content : "")).join("\n") ?? "";
  assert.match(secondTurnContext, /(?:PROGRESS|URGENT CLOSEOUT) CHECKPOINT/);
  assert.match(secondTurnContext, /Pending task ids:/);
  assert.match(secondTurnContext, /Pending task details:/);
  assert.match(secondTurnContext, /Acceptance:/);
  assert.match(secondTurnContext, /finish_app/);
  const thirdTurnPayload = JSON.stringify(model.toolRequests[2]?.messages ?? []);
  assert.match(thirdTurnPayload, /WORKSPACE STATE CHECKPOINT/);
  assert.match(thirdTurnPayload, /write_file src\/app\/page\.tsx/);
  assert.doesNotMatch(thirdTurnPayload, /半成品不应通过/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine strict generation auto-finishes completed loops after final build and audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeCompletedNoFinishAgentLoopModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    maxToolCallsTotal: 64,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-completed-no-finish",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  assert.ok(result.run.tasks.some((task) => task.owner === "coder" && task.status === "completed"));
  assert.ok(
    result.run.tasks.some(
      (task) => task.owner === "coder" && /完成 10\/10 个任务/.test(task.summary ?? "") && /工具调用/.test(task.summary ?? ""),
    ),
  );
  await readFile(join(root, ".agent", "sandboxes", "run-strict-completed-no-finish", "src", "app", "page.tsx"), "utf-8");
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine strict generation can close out with the functional starter scaffold", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeBaselineScaffoldCloseoutModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 4,
    maxToolCallsPerTurn: 14,
    maxToolCallsTotal: 48,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-functional-starter",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个移动端旅行行程规划 App，支持创建行程、排序、完成状态和本地保存。",
    clarificationAnswers: [{ questionId: "scope", answer: "mobile travel itinerary with local storage" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  const page = await readFile(join(root, ".agent", "sandboxes", "run-strict-functional-starter", "src", "app", "page.tsx"), "utf-8");
  assert.match(page, /localStorage/);
  assert.match(page, /cycleStatus/);
  assert.match(page, /moveItem/);
  assert.doesNotMatch(page, /replace this scaffold|Start the main flow|Product modules/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine strict auto-finish accepts functional starter input placeholders", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeBaselineScaffoldAutoFinishModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 4,
    maxToolCallsPerTurn: 8,
    maxToolCallsTotal: 32,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-starter-auto-finish",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个移动端旅行行程规划 App，支持创建行程、排序、完成状态和本地保存。",
    clarificationAnswers: [{ questionId: "scope", answer: "mobile travel itinerary with local storage" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  assert.ok(
    result.run.tasks.some(
      (task) => task.owner === "coder" && /完成 10\/10 个任务/.test(task.summary ?? "") && /工具调用/.test(task.summary ?? ""),
    ),
  );
  const page = await readFile(join(root, ".agent", "sandboxes", "run-strict-starter-auto-finish", "src", "app", "page.tsx"), "utf-8");
  assert.match(page, /placeholder="Add an item"/);
  assert.match(page, /placeholder="Details, next step, owner, or context"/);
  assert.match(page, /localStorage/);
  assert.doesNotMatch(result.run.error ?? "", /placeholder copy/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-marks declared file tasks before strict auto-finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeAutoMarkCompletedNoFinishAgentLoopModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    maxToolCallsTotal: 64,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-auto-mark-files",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  assert.equal(result.run.toolCalls.some((call) => call.toolName === "mark_task_done"), false);
  assert.ok(
    result.run.tasks.some(
      (task) => task.owner === "coder" && /完成 10\/10 个任务/.test(task.summary ?? "") && /工具调用/.test(task.summary ?? ""),
    ),
  );
  await readFile(join(root, ".agent", "sandboxes", "run-strict-auto-mark-files", "src", "app", "page.tsx"), "utf-8");
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine strict auto-finish closes pending bookkeeping tasks after clean build and audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeMostlyCompleteNoFinishAgentLoopModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    maxToolCallsTotal: 64,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-mostly-complete-no-finish",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个轻量本地日记 App，核心功能是记录、筛选和本地保存。",
    clarificationAnswers: [{ questionId: "scope", answer: "compact local diary" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  assert.ok(
    result.run.tasks.some(
      (task) => task.owner === "coder" && /完成 9\/9 个任务/.test(task.summary ?? "") && /工具调用/.test(task.summary ?? ""),
    ),
  );
  const appSource = await readFile(
    join(root, ".agent", "sandboxes", "run-strict-mostly-complete-no-finish", "src", "app", "page.tsx"),
    "utf-8",
  );
  assert.match(appSource, /七成任务已够收口/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine strict auto-finish repairs numeric length build errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeCompletedNoFinishNumericLengthModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), buildSafetyTools(), {}, undefined, {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    maxToolCallsTotal: 64,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-numeric-length",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  const appSource = await readFile(join(root, ".agent", "sandboxes", "run-strict-numeric-length", "src", "app", "page.tsx"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.doesNotMatch(appSource, /seeded\.length/);
  assert.match(appSource, /\{seeded\} 个精选推荐/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine strict auto-finish repairs missing object fields in final build", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeCompletedNoFinishMissingRequiredObjectFieldsModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), buildSafetyTools(), {}, undefined, {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    maxToolCallsTotal: 64,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-missing-object-fields",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行收藏 App，核心功能是地点收藏，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel favorites local storage" }],
  });

  const dataSource = await readFile(
    join(root, ".agent", "sandboxes", "run-strict-missing-object-fields", "src", "lib", "data.ts"),
    "utf-8",
  );
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(dataSource, /\baddress: ''/);
  assert.match(dataSource, /\bopenHours: ''/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine strict generation auto-finishes completed loops after final model timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeCompletedThenTimeoutNoFinishAgentLoopModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    maxToolCallsTotal: 64,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-completed-timeout-no-finish",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  assert.ok(result.run.tasks.some((task) => task.owner === "coder" && task.status === "completed"));
  assert.ok(
    result.run.tasks.some(
      (task) => task.owner === "coder" && /完成 10\/10 个任务/.test(task.summary ?? "") && /工具调用/.test(task.summary ?? ""),
    ),
  );
  await readFile(join(root, ".agent", "sandboxes", "run-strict-completed-timeout-no-finish", "src", "app", "page.tsx"), "utf-8");
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine strict generation gives timeout recovery an extra turn after partial progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakePartialThenTimeoutRecoveryAgentLoopModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 3,
    maxToolCallsPerTurn: 20,
    maxToolCallsTotal: 64,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-strict-partial-timeout-recovery",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  assert.equal(model.toolRequests.length, 4);
  assert.match(JSON.stringify(model.toolRequests[3]?.messages ?? []), /TIMEOUT RECOVERY CHECKPOINT/);
  await readFile(join(root, ".agent", "sandboxes", "run-strict-partial-timeout-recovery", "src", "app", "page.tsx"), "utf-8");
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine keeps agent tool-call history protocol valid when per-turn calls are truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeManyToolCallsProtocolModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 2,
    maxToolCallsPerTurn: 3,
    maxToolCallsTotal: 24,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-truncated-tool-call-protocol",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  assert.ok(["failed", "awaiting_approval"].includes(result.run.status));
  assert.doesNotMatch(result.run.error ?? "", /unanswered assistant tool calls|tool_call_id/);
  const secondRequestMessages = model.toolRequests[1]?.messages ?? [];
  const compacted = secondRequestMessages.some((message) => message.role === "user" && /WORKSPACE STATE CHECKPOINT/.test(message.content));
  const previousAssistant = [...secondRequestMessages].reverse().find((message) => message.role === "assistant" && message.toolCalls?.length);
  if (compacted) {
    assert.equal(previousAssistant, undefined);
  } else {
    assert.equal(previousAssistant?.role === "assistant" ? previousAssistant.toolCalls?.length : undefined, 3);
    assert.ok(secondRequestMessages.some((message) => message.role === "user" && /truncated to 3\/5 calls/.test(message.content)));
  }
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine steers redundant setup calls after discovery and install are complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeRedundantSetupAfterProgressModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 6,
    maxToolCallsPerTurn: 6,
    maxToolCallsTotal: 24,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-redundant-setup-steering",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  assert.equal(
    result.run.toolCalls.filter((call) => call.toolName === "run_command" && call.inputSummary === "npm install").length,
    1,
  );
  const page = await readFile(join(root, ".agent", "sandboxes", "run-redundant-setup-steering", "src", "app", "page.tsx"), "utf-8");
  assert.match(page, /localStorage/);
  assert.match(page, /cycleStatus/);
  const nextRequestPayload = JSON.stringify(model.toolRequests.at(-1)?.messages ?? []);
  assert.match(nextRequestPayload, /WORKSPACE STATE CHECKPOINT/);
  assert.match(nextRequestPayload, /DISCOVERY PHASE/);
  assert.match(nextRequestPayload, /no-op: reference already inspected/);
  assert.match(nextRequestPayload, /no-op: design guidance already complete/);
  assert.match(nextRequestPayload, /no-op: npm install already fresh/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine steers repeated unchanged file inspection toward progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeRedundantInspectionAfterProgressModel();
  const result = await new QueryEngine(new ExpertRouter(model, { strictGeneration: true }), testTools(), {}, undefined, {
    maxTurns: 6,
    maxToolCallsPerTurn: 10,
    maxToolCallsTotal: 32,
    modelTurnTimeoutMs: 90_000,
    strictGeneration: true,
  }).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-redundant-inspection-steering",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个个人旅游手帐 App，核心功能是 checklist，本地存储。",
    clarificationAnswers: [{ questionId: "scope", answer: "personal checklist local storage" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "write_file" && call.inputSummary === "src/app/globals.css"));
  const page = await readFile(join(root, ".agent", "sandboxes", "run-redundant-inspection-steering", "src", "app", "page.tsx"), "utf-8");
  assert.match(page, /localStorage/);
  assert.match(page, /cycleStatus/);
  const nextRequestPayload = JSON.stringify(model.toolRequests.at(-1)?.messages ?? []);
  assert.match(nextRequestPayload, /no-op: src\/app\/page\.tsx already read/);
  assert.match(nextRequestPayload, /no-op: workspace listing already fresh/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine supervisor auto-finishes after repeated read-only inspection stalls", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeStalledInspectionLoopModel();
  const logs: string[] = [];
  const result = await new QueryEngine(
    new ExpertRouter(model, { strictGeneration: true }),
    testTools(),
    { onLog: (message) => logs.push(message) },
    undefined,
    {
      maxTurns: 8,
      maxToolCallsPerTurn: 6,
      maxToolCallsTotal: 64,
      modelTurnTimeoutMs: 90_000,
      strictGeneration: true,
    },
  ).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-stalled-inspection-supervisor",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个移动端旅行行程规划 App，支持创建行程、排序、完成状态和本地保存。",
    clarificationAnswers: [{ questionId: "scope", answer: "mobile travel itinerary with local storage" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.run.failureKind, undefined);
  assert.ok(model.toolRequests.length < 8);
  assert.ok(logs.some((message) => /Agent loop supervisor: detected 3 consecutive read-only\/no-op turns/.test(message)));
  const page = await readFile(join(root, ".agent", "sandboxes", "run-stalled-inspection-supervisor", "src", "app", "page.tsx"), "utf-8");
  assert.match(page, /localStorage/);
  assert.match(page, /cycleStatus/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine injects tool runtime adapters into the agent loop and bridges tool tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeAgentToolBridgeModel();
  const observedTasks: string[] = [];
  const engine = new QueryEngine(
    new ExpertRouter(model),
    defaultToolsWithFakeRunCommand(),
    {
      onTask: (task) => {
        if (task.title === "Adapter subtask") {
          observedTasks.push(`${task.status}:${task.summary ?? ""}`);
        }
      },
    },
    undefined,
    {
      maxTurns: 4,
      maxToolCallsPerTurn: 6,
      maxToolCallsTotal: 24,
      modelTurnTimeoutMs: 90_000,
      skipAcceptance: true,
    },
    {
      policy: {
        allowedPermissions: ["read", "write", "execute", "collaborate", "network"],
        allowedSideEffects: ["none", "workspace", "process", "network"],
        allowedRiskLevels: ["low", "medium", "high"],
        allowNetwork: true,
      },
      capabilities: { network: true, subagents: true },
      webAdapter: {
        fetch: async (request) => ({ url: request.url, status: 200, contentType: "text/plain", text: "adapter body" }),
        search: async (request) => ({ query: request.query, results: [{ title: "Adapter Result", url: "https://example.com" }] }),
      },
      subAgentRunner: {
        run: async (request) => {
          assert.deepEqual(request.allowedTools, ["read_file", "web_search"]);
          assert.equal(request.context.capabilities?.network, true);
          assert.equal(Boolean(request.context.webAdapter), true);
          return {
            status: "completed",
            outputSummary: "Sub-agent used injected adapters.",
            messages: ["adapter-ok"],
          };
        },
      },
    },
  );

  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-adapter-bridge",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "验证 agent tool runtime adapter 注入。",
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  const bridgedTask = result.run.tasks.find((task) => task.title === "Adapter subtask");
  assert.equal(bridgedTask?.status, "completed");
  assert.equal(bridgedTask?.summary, "Sub-agent used injected adapters.");
  assert.ok(observedTasks.some((entry) => entry.startsWith("pending:")));
  assert.ok(observedTasks.some((entry) => entry.startsWith("running:")));
  assert.ok(observedTasks.some((entry) => entry === "completed:Sub-agent used injected adapters."));
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "agent_tool" && call.status === "completed"));

  await rm(root, { recursive: true, force: true });
});

test("QueryEngine validates Prisma locally without npx-installing Prisma", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakePrismaSchemaWithoutCliModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-prisma-no-cli",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行规划 App，静态数据即可，但可以带数据层 schema。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel data layer static first" }],
  });

  const envSource = await readFile(join(root, ".agent", "sandboxes", "run-prisma-no-cli", ".env"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(envSource, /DATABASE_URL="file:\.\/dev\.db"/);
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "npm run build"));
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "prisma validate"));
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "prisma generate"));
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "prisma db push"));
  assert.ok(!result.run.toolCalls.some((call) => call.toolName === "run_command" && /^npx prisma/.test(call.inputSummary ?? "")));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine normalizes incomplete Prisma schema before local validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeIncompletePrismaSchemaModel();
  const engine = new QueryEngine(new ExpertRouter(model), buildSafetyTools());
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-prisma-normalize-schema",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行规划 App，带 Prisma schema。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel data layer static first" }],
  });

  const schema = await readFile(join(root, ".agent", "sandboxes", "run-prisma-normalize-schema", "prisma", "schema.prisma"), "utf-8");
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(schema, /generator\s+client\s*\{/);
  assert.match(schema, /datasource\s+db\s*\{/);
  assert.match(schema, /provider\s*=\s*"sqlite"/);
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "prisma generate"));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine continues after empty Prisma schema engine db push errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakePrismaSchemaWithoutCliModel();
  const baseTools = buildSafetyTools();
  const originalRunCommand = baseTools.get("run_command");
  const tools = new ToolRegistry();
  for (const tool of baseTools.list()) {
    if (tool.name !== "run_command") {
      tools.register(tool);
    }
  }
  tools.register({
    name: originalRunCommand.name,
    description: originalRunCommand.description,
    permission: originalRunCommand.permission,
    sandboxOnly: originalRunCommand.sandboxOnly,
    validate: originalRunCommand.validate,
    summarizeInput: originalRunCommand.summarizeInput,
    summarizeOutput: originalRunCommand.summarizeOutput,
    execute: async (input, context) => {
      const commandInput = input as { command: string[] };
      if (commandInput.command.join(" ") === "prisma db push") {
        const error = new Error("Command failed: prisma db push");
        Object.assign(error, {
          exitCode: 1,
          output:
            'Environment variables loaded from .env\nPrisma schema loaded from prisma/schema.prisma\nDatasource "db": SQLite database "dev.db" at "file:./dev.db"\n\nError: Schema engine error:',
        });
        throw error;
      }
      return originalRunCommand.execute(input, context);
    },
  });
  const engine = new QueryEngine(new ExpertRouter(model), tools);
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-prisma-engine-empty",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行规划 App，静态数据即可，但可以带数据层 schema。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel data layer static first" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "npm run build"));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine tolerates false missing-datasource Prisma db push errors after validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakePrismaSchemaWithoutCliModel();
  const baseTools = buildSafetyTools();
  const originalRunCommand = baseTools.get("run_command");
  const tools = new ToolRegistry();
  for (const tool of baseTools.list()) {
    if (tool.name !== "run_command") {
      tools.register(tool);
    }
  }
  tools.register({
    name: originalRunCommand.name,
    description: originalRunCommand.description,
    permission: originalRunCommand.permission,
    sandboxOnly: originalRunCommand.sandboxOnly,
    validate: originalRunCommand.validate,
    summarizeInput: originalRunCommand.summarizeInput,
    summarizeOutput: originalRunCommand.summarizeOutput,
    execute: async (input, context) => {
      const commandInput = input as { command: string[] };
      if (commandInput.command.join(" ") === "prisma db push") {
        const error = new Error("Command failed: prisma db push");
        Object.assign(error, {
          exitCode: 1,
          output:
            "Environment variables loaded from .env\nPrisma schema loaded from prisma/schema.prisma\n\nError: A datasource block is missing in the Prisma schema file.",
        });
        throw error;
      }
      return originalRunCommand.execute(input, context);
    },
  });
  const engine = new QueryEngine(new ExpertRouter(model), tools);
  const result = await engine.run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-prisma-false-missing-datasource",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个上海旅行规划 App，静态数据即可，但可以带数据层 schema。",
    clarificationAnswers: [{ questionId: "scope", answer: "travel data layer static first" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.ok(result.run.toolCalls.some((call) => call.toolName === "run_command" && call.inputSummary === "npm run build"));
  await rm(root, { recursive: true, force: true });
});
