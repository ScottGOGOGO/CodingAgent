from __future__ import annotations

import json
from textwrap import dedent

from app.models import AppSpec, FileOperation, GeneratedCodeOutput


def build_fresh_app_scaffold(spec: AppSpec) -> GeneratedCodeOutput:
    screens = [
        {
            "id": screen.id or f"screen-{index + 1}",
            "name": screen.name or f"页面 {index + 1}",
            "purpose": screen.purpose or "承载当前阶段的核心体验。",
            "elements": [str(item).strip() for item in screen.elements if str(item).strip()] or ["核心内容区", "操作入口", "状态反馈"],
        }
        for index, screen in enumerate(spec.screens or [])
    ] or [
        {
            "id": "overview",
            "name": "概览页",
            "purpose": "帮助用户快速理解产品价值与核心流程。",
            "elements": ["亮点卡片", "主操作入口", "状态概览"],
        }
    ]
    flows = [
        {
            "id": flow.id or f"flow-{index + 1}",
            "name": flow.name or f"流程 {index + 1}",
            "steps": [step for step in flow.steps if step],
            "success": flow.success or "用户可以顺利完成这一关键任务。",
        }
        for index, flow in enumerate(spec.core_flows or [])
    ] or [
        {
            "id": "primary-flow",
            "name": "主流程",
            "steps": ["进入应用", "浏览重点内容", "完成核心操作"],
            "success": "用户可以快速完成一次完整体验。",
        }
    ]
    data_models = [
        {
            "entity": need.entity or f"实体 {index + 1}",
            "fields": need.fields or ["id (string)", "title (string)"],
            "notes": need.notes or "可先使用本地数据进行驱动。",
        }
        for index, need in enumerate(spec.data_model_needs or [])
    ] or [
        {
            "entity": "PrimaryRecord",
            "fields": ["id (string)", "title (string)", "status (string)"],
            "notes": "使用本地状态即可支撑演示。",
        }
    ]
    target_users = spec.target_users or ["核心使用者"]
    integrations = spec.integrations or ["当前版本不依赖外部集成"]
    constraints = spec.constraints or ["使用 React + Vite TypeScript 构建"]
    success_criteria = spec.success_criteria or ["用户可以完成一次端到端主流程"]
    highlight_tags = _dedupe_items(
        [
            spec.design_targets.visual_mood,
            spec.design_targets.layout_energy,
            spec.design_targets.color_strategy,
            spec.brand_and_visual_direction,
        ]
    )[:4]
    app_payload = {
        "title": spec.title,
        "summary": spec.summary,
        "goal": spec.goal,
        "targetUsers": target_users,
        "screens": screens,
        "flows": flows,
        "dataModels": data_models,
        "integrations": integrations,
        "constraints": constraints,
        "successCriteria": success_criteria,
        "highlightTags": highlight_tags or ["可运行首版", "品牌化界面", "真实交互反馈"],
    }

    operations = [
        FileOperation(
            type="write",
            path="package.json",
            summary="创建 Vite + React + Tailwind 项目清单。",
            content=_package_json(spec.app_name),
        ),
        FileOperation(
            type="write",
            path="tsconfig.json",
            summary="补充 TypeScript 编译配置。",
            content=_tsconfig_json(),
        ),
        FileOperation(
            type="write",
            path="tsconfig.node.json",
            summary="补充 Vite 节点侧 TypeScript 配置。",
            content=_tsconfig_node_json(),
        ),
        FileOperation(
            type="write",
            path="vite.config.ts",
            summary="创建 Vite 配置。",
            content=_vite_config(),
        ),
        FileOperation(
            type="write",
            path="tailwind.config.js",
            summary="建立 Tailwind 主题令牌。",
            content=_tailwind_config(),
        ),
        FileOperation(
            type="write",
            path="postcss.config.js",
            summary="启用 Tailwind PostCSS 管线。",
            content=_postcss_config(),
        ),
        FileOperation(
            type="write",
            path="index.html",
            summary="创建应用入口 HTML。",
            content=_index_html(spec.title),
        ),
        FileOperation(
            type="write",
            path="src/main.tsx",
            summary="创建 React 应用入口。",
            content=_main_tsx(),
        ),
        FileOperation(
            type="write",
            path="src/App.tsx",
            summary="生成首版多区块交互界面。",
            content=_app_tsx(app_payload),
        ),
        FileOperation(
            type="write",
            path="src/index.css",
            summary="补充全局样式与背景氛围层。",
            content=_index_css(),
        ),
    ]

    return GeneratedCodeOutput(
        assistantSummary="已基于当前规格生成可运行的首版应用骨架与完整界面。",
        operations=operations,
    )


def _dedupe_items(items: list[str]) -> list[str]:
    ordered: list[str] = []
    seen = set()
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        ordered.append(text)
    return ordered


def _package_json(app_name: str) -> str:
    payload = {
        "name": app_name or "generated-app",
        "private": True,
        "version": "0.0.0",
        "type": "module",
        "scripts": {
            "dev": "vite",
            "build": "vite build",
            "preview": "vite preview",
        },
        "dependencies": {
            "react": "^18.2.0",
            "react-dom": "^18.2.0",
        },
        "devDependencies": {
            "@types/react": "^18.2.43",
            "@types/react-dom": "^18.2.17",
            "@vitejs/plugin-react": "^4.2.1",
            "autoprefixer": "^10.4.20",
            "postcss": "^8.4.47",
            "tailwindcss": "^3.4.17",
            "typescript": "^5.2.2",
            "vite": "^5.0.8",
        },
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def _tsconfig_json() -> str:
    payload = {
        "compilerOptions": {
            "target": "ES2020",
            "useDefineForClassFields": True,
            "lib": ["DOM", "DOM.Iterable", "ES2020"],
            "allowJs": False,
            "skipLibCheck": True,
            "esModuleInterop": True,
            "allowSyntheticDefaultImports": True,
            "strict": True,
            "forceConsistentCasingInFileNames": True,
            "module": "ESNext",
            "moduleResolution": "Node",
            "resolveJsonModule": True,
            "isolatedModules": True,
            "noEmit": True,
            "jsx": "react-jsx",
        },
        "include": ["src"],
        "references": [{"path": "./tsconfig.node.json"}],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def _tsconfig_node_json() -> str:
    payload = {
        "compilerOptions": {
            "composite": True,
            "skipLibCheck": True,
            "module": "ESNext",
            "moduleResolution": "Node",
            "allowSyntheticDefaultImports": True,
        },
        "include": ["vite.config.ts"],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def _vite_config() -> str:
    return dedent(
        """\
        import { defineConfig } from "vite";
        import react from "@vitejs/plugin-react";

        export default defineConfig({
          plugins: [react()],
        });
        """
    )


def _tailwind_config() -> str:
    return dedent(
        """\
        /** @type {import('tailwindcss').Config} */
        export default {
          content: ["./index.html", "./src/**/*.{ts,tsx}"],
          theme: {
            extend: {
              colors: {
                brand: {
                  50: "#eef6ff",
                  100: "#d9ebff",
                  200: "#b8d8ff",
                  300: "#8abfff",
                  400: "#569cff",
                  500: "#2d79ff",
                  600: "#1c5fe6",
                  700: "#194cb5",
                  900: "#0d1730",
                },
                ink: "#ecf3ff",
                surface: {
                  900: "#07111f",
                  800: "#101d30",
                  700: "#18263c",
                },
                accent: "#5eead4",
                glow: "#f59e0b",
              },
              boxShadow: {
                halo: "0 28px 80px rgba(24, 95, 230, 0.30)",
                panel: "0 18px 50px rgba(4, 10, 26, 0.34)",
              },
              fontFamily: {
                sans: ["Avenir Next", "PingFang SC", "Noto Sans SC", "sans-serif"],
                display: ["Avenir Next", "PingFang SC", "Noto Sans SC", "sans-serif"],
              },
              backgroundImage: {
                "mesh-glow":
                  "radial-gradient(circle at top, rgba(45,121,255,0.28), transparent 42%), radial-gradient(circle at 20% 20%, rgba(94,234,212,0.18), transparent 24%), radial-gradient(circle at 80% 0%, rgba(245,158,11,0.18), transparent 22%)",
              },
            },
          },
          plugins: [],
        };
        """
    )


def _postcss_config() -> str:
    return dedent(
        """\
        export default {
          plugins: {
            tailwindcss: {},
            autoprefixer: {},
          },
        };
        """
    )


def _index_html(title: str) -> str:
    safe_title = title or "Generated App"
    return dedent(
        f"""\
        <!doctype html>
        <html lang="zh-CN">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>{safe_title}</title>
          </head>
          <body>
            <div id="root"></div>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>
        """
    )


def _main_tsx() -> str:
    return dedent(
        """\
        import ReactDOM from "react-dom/client";

        import App from "./App";
        import "./index.css";

        ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
        """
    )


def _app_tsx(payload: dict[str, object]) -> str:
    data_literal = json.dumps(payload, ensure_ascii=False, indent=2)
    return dedent(
        f"""\
        import {{ useState }} from "react";

        type Screen = {{
          id: string;
          name: string;
          purpose: string;
          elements: string[];
        }};

        type Flow = {{
          id: string;
          name: string;
          steps: string[];
          success: string;
        }};

        type DataModel = {{
          entity: string;
          fields: string[];
          notes: string;
        }};

        const appData = {data_literal} as {{
          title: string;
          summary: string;
          goal: string;
          targetUsers: string[];
          screens: Screen[];
          flows: Flow[];
          dataModels: DataModel[];
          integrations: string[];
          constraints: string[];
          successCriteria: string[];
          highlightTags: string[];
        }};

        export default function App() {{
          const [activeScreenId, setActiveScreenId] = useState(appData.screens[0]?.id ?? "");
          const [checkedCriteria, setCheckedCriteria] = useState<string[]>([]);

          const activeScreen = appData.screens.find((item) => item.id === activeScreenId) ?? appData.screens[0];

          const completion = appData.successCriteria.length
            ? Math.round((checkedCriteria.length / appData.successCriteria.length) * 100)
            : 100;

          const toggleCriterion = (criterion: string) => {{
            setCheckedCriteria((current) =>
              current.includes(criterion)
                ? current.filter((item) => item !== criterion)
                : [...current, criterion],
            );
          }};

          return (
            <div className="min-h-screen bg-surface-900 text-ink">
              <div className="pointer-events-none absolute inset-0 bg-mesh-glow opacity-90" />
              <main className="relative mx-auto flex max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
                <section className="overflow-hidden rounded-[32px] border border-white/10 bg-surface-800/85 p-6 shadow-halo backdrop-blur xl:p-10">
                  <div className="grid gap-8 xl:grid-cols-[1.35fr_0.85fr] xl:items-end">
                    <div className="space-y-6">
                      <div className="flex flex-wrap gap-3 text-xs uppercase tracking-[0.28em] text-brand-200/85">
                        {{appData.highlightTags.map((tag) => (
                          <span key={{tag}} className="rounded-full border border-brand-300/30 bg-brand-500/10 px-3 py-1">
                            {{tag}}
                          </span>
                        ))}}
                      </div>
                      <div className="space-y-4">
                        <p className="text-sm font-medium text-accent">可运行首版方案</p>
                        <h1 className="font-display text-4xl font-semibold leading-tight text-white sm:text-5xl">
                          {{appData.title}}
                        </h1>
                        <p className="max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
                          {{appData.summary}}
                        </p>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <MetricCard label="目标用户" value={{String(appData.targetUsers.length)}} detail={{appData.targetUsers[0] ?? "核心使用者"}} />
                        <MetricCard label="核心页面" value={{String(appData.screens.length)}} detail={{appData.screens[0]?.name ?? "概览页"}} />
                        <MetricCard label="关键流程" value={{String(appData.flows.length)}} detail={{appData.flows[0]?.name ?? "主流程"}} />
                      </div>
                    </div>
                    <div className="rounded-[28px] border border-white/10 bg-surface-900/80 p-5 shadow-panel">
                      <p className="text-sm font-medium text-brand-200">项目目标</p>
                      <p className="mt-3 text-2xl font-semibold text-white">{{appData.goal}}</p>
                      <div className="mt-6 flex flex-wrap gap-2">
                        {{appData.targetUsers.map((user) => (
                          <span
                            key={{user}}
                            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-slate-200"
                          >
                            {{user}}
                          </span>
                        ))}}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
                  <div className="rounded-[28px] border border-white/10 bg-surface-800/80 p-5 shadow-panel backdrop-blur">
                    <SectionTitle eyebrow="页面规划" title="关键页面与体验重点" />
                    <div className="mt-5 flex flex-col gap-3">
                      {{appData.screens.map((screen) => {{
                        const active = screen.id === activeScreen?.id;
                        return (
                          <button
                            key={{screen.id}}
                            type="button"
                            onClick={{() => setActiveScreenId(screen.id)}}
                            className={{
                              [
                                "w-full rounded-3xl border px-4 py-4 text-left transition duration-300",
                                active
                                  ? "border-brand-300/70 bg-brand-500/16 shadow-halo"
                                  : "border-white/8 bg-white/5 hover:-translate-y-0.5 hover:border-brand-300/30",
                              ].join(" ")
                            }}
                          >
                            <p className="text-lg font-semibold text-white">{{screen.name}}</p>
                            <p className="mt-2 text-sm leading-6 text-slate-300">{{screen.purpose}}</p>
                          </button>
                        );
                      }})}}
                    </div>
                  </div>

                  <div className="rounded-[28px] border border-white/10 bg-surface-800/80 p-5 shadow-panel backdrop-blur">
                    <SectionTitle eyebrow="体验展开" title={{activeScreen?.name ?? "页面详情"}} />
                    <div className="mt-5 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                      <div className="rounded-[28px] border border-white/10 bg-surface-900/80 p-5">
                        <p className="text-sm text-brand-200">页面目标</p>
                        <p className="mt-3 text-2xl font-semibold text-white">{{activeScreen?.purpose}}</p>
                        <div className="mt-6 grid gap-3">
                          {{(activeScreen?.elements ?? []).map((element) => (
                            <div key={{element}} className="rounded-2xl border border-white/8 bg-white/5 px-4 py-3">
                              <p className="text-sm font-medium text-slate-100">{{element}}</p>
                            </div>
                          ))}}
                        </div>
                      </div>
                      <div className="rounded-[28px] border border-brand-300/15 bg-gradient-to-b from-brand-500/12 to-transparent p-5">
                        <p className="text-sm text-brand-200">上线边界</p>
                        <div className="mt-4 space-y-3">
                          {{appData.constraints.map((constraint) => (
                            <div key={{constraint}} className="rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm text-slate-200">
                              {{constraint}}
                            </div>
                          ))}}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
                  <div className="rounded-[28px] border border-white/10 bg-surface-800/80 p-5 shadow-panel backdrop-blur">
                    <SectionTitle eyebrow="交付路径" title="核心流程节奏" />
                    <div className="mt-5 space-y-4">
                      {{appData.flows.map((flow, index) => (
                        <article key={{flow.id}} className="rounded-[26px] border border-white/8 bg-white/5 p-5">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <p className="text-xs uppercase tracking-[0.24em] text-brand-200/80">流程 {{index + 1}}</p>
                              <h3 className="mt-2 text-xl font-semibold text-white">{{flow.name}}</h3>
                            </div>
                            <span className="rounded-full bg-accent/12 px-3 py-1 text-xs font-medium text-accent">
                              结果导向
                            </span>
                          </div>
                          <div className="mt-5 grid gap-3 sm:grid-cols-3">
                            {{flow.steps.map((step, stepIndex) => (
                              <div key={{step}} className="rounded-2xl border border-white/8 bg-surface-900/70 px-4 py-4">
                                <p className="text-xs uppercase tracking-[0.24em] text-slate-400">步骤 {{stepIndex + 1}}</p>
                                <p className="mt-2 text-sm leading-6 text-slate-100">{{step}}</p>
                              </div>
                            ))}}
                          </div>
                          <p className="mt-4 text-sm leading-6 text-slate-300">{{flow.success}}</p>
                        </article>
                      ))}}
                    </div>
                  </div>

                  <div className="space-y-6">
                    <div className="rounded-[28px] border border-white/10 bg-surface-800/80 p-5 shadow-panel backdrop-blur">
                      <SectionTitle eyebrow="数据基础" title="演示数据与实体结构" />
                      <div className="mt-5 space-y-4">
                        {{appData.dataModels.map((model) => (
                          <article key={{model.entity}} className="rounded-[24px] border border-white/8 bg-surface-900/75 p-4">
                            <div className="flex items-center justify-between gap-3">
                              <h3 className="text-lg font-semibold text-white">{{model.entity}}</h3>
                              <span className="rounded-full border border-brand-300/30 px-3 py-1 text-xs text-brand-100">
                                {{model.fields.length}} 个字段
                              </span>
                            </div>
                            <div className="mt-4 flex flex-wrap gap-2">
                              {{model.fields.map((field) => (
                                <span key={{field}} className="rounded-full bg-white/6 px-3 py-1 text-sm text-slate-200">
                                  {{field}}
                                </span>
                              ))}}
                            </div>
                            <p className="mt-4 text-sm leading-6 text-slate-300">{{model.notes}}</p>
                          </article>
                        ))}}
                      </div>
                    </div>

                    <div className="rounded-[28px] border border-white/10 bg-surface-800/80 p-5 shadow-panel backdrop-blur">
                      <SectionTitle eyebrow="执行信号" title="验收清单与集成边界" />
                      <div className="mt-5 rounded-[24px] border border-brand-300/15 bg-brand-500/10 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="text-sm text-brand-100">当前准备度</p>
                            <p className="mt-2 text-3xl font-semibold text-white">{{completion}}%</p>
                          </div>
                          <div className="h-3 flex-1 rounded-full bg-white/10">
                            <div
                              className="h-3 rounded-full bg-gradient-to-r from-brand-400 via-accent to-glow transition-all duration-500"
                              style={{{{ width: `${{completion}}%` }}}}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="mt-5 space-y-3">
                        {{appData.successCriteria.map((criterion) => {{
                          const checked = checkedCriteria.includes(criterion);
                          return (
                            <button
                              key={{criterion}}
                              type="button"
                              onClick={{() => toggleCriterion(criterion)}}
                              className={{
                                [
                                  "flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition duration-300",
                                  checked
                                    ? "border-accent/50 bg-accent/12"
                                    : "border-white/8 bg-white/5 hover:border-brand-300/30",
                                ].join(" ")
                              }}
                            >
                              <span className="text-sm text-slate-100">{{criterion}}</span>
                              <span className="text-xs uppercase tracking-[0.2em] text-slate-400">
                                {{checked ? "已覆盖" : "待确认"}}
                              </span>
                            </button>
                          );
                        }})}}
                      </div>
                      <div className="mt-6 grid gap-3 sm:grid-cols-2">
                        <InfoList title="可选集成" items={{appData.integrations}} />
                        <InfoList title="工程约束" items={{appData.constraints}} />
                      </div>
                    </div>
                  </div>
                </section>
              </main>
            </div>
          );
        }}

        function MetricCard({{
          label,
          value,
          detail,
        }}: {{
          label: string;
          value: string;
          detail: string;
        }}) {{
          return (
            <div className="rounded-[24px] border border-white/10 bg-white/5 p-4">
              <p className="text-sm text-slate-400">{{label}}</p>
              <p className="mt-3 text-3xl font-semibold text-white">{{value}}</p>
              <p className="mt-2 text-sm text-slate-300">{{detail}}</p>
            </div>
          );
        }}

        function SectionTitle({{
          eyebrow,
          title,
        }}: {{
          eyebrow: string;
          title: string;
        }}) {{
          return (
            <div>
              <p className="text-xs uppercase tracking-[0.26em] text-brand-200/80">{{eyebrow}}</p>
              <h2 className="mt-3 text-2xl font-semibold text-white">{{title}}</h2>
            </div>
          );
        }}

        function InfoList({{
          title,
          items,
        }}: {{
          title: string;
          items: string[];
        }}) {{
          return (
            <div className="rounded-[24px] border border-white/8 bg-surface-900/70 p-4">
              <p className="text-sm font-medium text-brand-100">{{title}}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {{items.map((item) => (
                  <span key={{item}} className="rounded-full bg-white/6 px-3 py-1 text-sm text-slate-200">
                    {{item}}
                  </span>
                ))}}
              </div>
            </div>
          );
        }}
        """
    )


def _index_css() -> str:
    return dedent(
        """\
        @tailwind base;
        @tailwind components;
        @tailwind utilities;

        :root {
          color: #ecf3ff;
          background: #07111f;
          font-family: "Avenir Next", "PingFang SC", "Noto Sans SC", sans-serif;
          text-rendering: optimizeLegibility;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }

        * {
          box-sizing: border-box;
        }

        html {
          scroll-behavior: smooth;
        }

        body {
          margin: 0;
          min-width: 320px;
          min-height: 100vh;
          background:
            radial-gradient(circle at top, rgba(45, 121, 255, 0.18), transparent 38%),
            radial-gradient(circle at 20% 20%, rgba(94, 234, 212, 0.12), transparent 24%),
            linear-gradient(180deg, #091221 0%, #050b14 100%);
        }

        button {
          font: inherit;
        }

        ::selection {
          background: rgba(94, 234, 212, 0.3);
          color: #f8fbff;
        }
        """
    )
