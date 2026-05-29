import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExpertRouter } from "./expert-router.js";
import { ModelClient } from "./model-client.js";
import type { ChatWithToolsRequest, ChatWithToolsResponse, JsonGenerationRequest } from "./model-client.js";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tools.js";

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
    {
      path: "src/app/layout.tsx",
      content: `import "./globals.css";\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }\n`,
    },
    { path: "src/app/page.tsx", content: args.page },
    { path: "src/app/globals.css", content: args.css ?? "body { margin: 0; } main { padding: 24px; }\n" },
  ];
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
      files: nextAppFiles({
        title: "旅行计划",
        page: "export default function HomePage() { return <main>旅行计划</main>; }",
      }),
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
        score: 91,
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
      summary: "包含一个常见的字面量 state setter 类型错误。",
      files: nextAppFiles({
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
          "import { Sun } from 'lucide-react';",
          "const trips = [{ day: 1, places: [{ id: 'bund', timeSlot: '下午' }] }];",
          "function getPlaceById(id: string): { id: string; name: string; shortDesc: string } | undefined { return id ? { id, name: '外滩', shortDesc: '黄浦江边的城市名片' } : undefined; }",
          "export default function HomePage() {",
          "  const router = useRouter();",
          "  const [weather] = useState<'sunny' | 'rainy'>('sunny');",
          "  const dayData = trips[0];",
          "  const places = weather === 'sunny' ? dayData.places : dayData.places;",
          "  return <main><button onClick={() => router.push(`/detail/${places[0].id}`)}><Sun /><ChevronRight />{places[0]?.name} · {places[0]?.shortDesc || '探索上海魅力'}</button></main>;",
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
    throw new Error(`Unexpected JSON role ${request.role}`);
  }

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.roles.push(request.role);
    await new Promise((resolve) => setTimeout(resolve, (request.timeoutMs ?? 0) + 25));
    throw new Error(`Model tool-use request (${request.role}) timed out after ${request.timeoutMs}ms`);
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
          if (source.includes("<ChevronRight />") && !/import\s+\{[^}]*ChevronRight[^}]*\}\s+from\s+'lucide-react'/.test(source)) {
            const error = new Error("Command failed: npm run build");
            Object.assign(error, {
              exitCode: 1,
              output:
                "> shanghai-walk@1.0.0 build\n> next build\n\n./src/app/page.tsx:12:84\nType error: Cannot find name 'ChevronRight'.",
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
        }
        if (input.command[0] === "npx") {
          throw new Error(`Unexpected Prisma command in unit test: ${input.command.join(" ")}`);
        }
        return { exitCode: 0, output: "ok" };
      },
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
  assert.deepEqual(model.roles, ["clarifier", "design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.ok(result.run.visualReview);
  assert.equal(result.run.visualReview?.status, "passed");
  assert.ok(result.candidate.changedFiles.some((file) => file.path === "src/app/page.tsx"));
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

test("QueryEngine repairs placeholder content before submitting a candidate", async () => {
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "repairer", "visual_critic"]);
  assert.ok(result.candidate);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine sends visual critic failures through the repairer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeVisualRepairModel();
  const result = await engineWithModel(model).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-visual-repair",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个高质感移动端旅行灵感 app，必须像旅行杂志而不是普通卡片列表。",
    clarificationAnswers: [{ questionId: "scope", answer: "editorial mobile travel" }],
  });

  assert.equal(result.run.status, "awaiting_approval");
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic", "repairer", "visual_critic"]);
  assert.equal(result.run.visualReview?.status, "passed");
  assert.ok(result.run.tasks.some((task) => task.owner === "repairer" && task.status === "completed"));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine treats minor visual issues as candidate warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeMinorVisualIssueModel();
  const result = await engineWithModel(model).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-minor-visual-warning",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个温暖纸感的本地日记 app，包含心情选择、本地存储和历史记录。",
    clarificationAnswers: [{ questionId: "scope", answer: "diary storage local" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
  assert.equal(result.run.visualReview?.status, "passed");
  assert.deepEqual(result.run.visualReview?.blockingIssues, []);
  assert.match(result.run.visualReview?.warnings?.join("\n") ?? "", /Minor polish issue/);
  assert.match(result.candidate?.validation.warnings?.join("\n") ?? "", /Minor polish issue/);
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine removes blocking loading states after a failed visual repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeLoadingRepairSafetyModel();
  const result = await engineWithModel(model).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-loading-safety-repair",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "生成一个商务旅行 App，包含行程、探索和个人页，首屏要快速传达今日安排。",
    clarificationAnswers: [{ questionId: "scope", answer: "business itinerary explore profile" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic", "repairer", "visual_critic", "visual_critic"]);
  assert.equal(result.run.visualReview?.status, "passed");
  assert.match(result.candidate?.validation.summary ?? "", /首屏核心内容已直接呈现/);
  assert.ok(result.run.tasks.some((task) => task.owner === "repairer" && task.status === "completed"));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine auto-repairs product completeness visual failures instead of asking the user", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeProductCompletenessRepairModel();
  const result = await engineWithModel(model).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-product-completeness-repair",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage:
      "生成一个中文移动优先的上海三天两晚旅行规划 App，必须包含首页、按天行程、地点详情、预算和收藏清单。",
    clarificationAnswers: [{ questionId: "scope", answer: "full product flow" }],
  });

  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.equal(result.clarificationRequest, undefined);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic", "repairer", "visual_critic"]);
  assert.equal(result.run.visualReview?.status, "passed");
  assert.ok(result.candidate?.changedFiles.some((file) => file.path === "src/app/budget/page.tsx"));
  assert.ok(result.candidate?.changedFiles.some((file) => file.path === "src/app/favorites/page.tsx"));
  await rm(root, { recursive: true, force: true });
});

test("QueryEngine blocks cross-domain travel candidates for tennis learning requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const model = new FakeCrossDomainTravelModel();
  const result = await engineWithModel(model).run({
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-cross-domain",
    projectRoot: root,
    baseVersion: 0,
    messages: [],
    userMessage: "帮我生成网球学习的 app",
    clarificationAnswers: [{ questionId: "scope", answer: "今日训练、课程进度、练习记录和教练反馈" }],
  });

  assert.equal(result.run.status, "failed");
  assert.equal(result.candidate, undefined);
  assert.match(result.run.error ?? "", /网球学习|上海旅行规划|领域错误/);
  assert.ok(result.run.tasks.some((task) => task.owner === "visual_critic" && task.status === "failed"));
  assert.ok(model.roles.includes("repairer"), "the engine should try repair before failing");
  assert.equal(model.roles.at(-1), "visual_critic");
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
  assert.equal(result.run.status, "awaiting_approval", result.run.error);
  assert.match(appSource, /useState<string>/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.match(appSource, /featuredPlace/);
  assert.doesNotMatch(appSource, /places\[0\]\?\.name/);
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
  assert.deepEqual(model.roles, ["design_director", "design_seed_smith", "architect", "coder", "visual_critic"]);
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
