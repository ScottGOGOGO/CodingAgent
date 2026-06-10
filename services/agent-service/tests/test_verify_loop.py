from app.models import AgentSessionState, EvaluationResult, FileOperation, ProjectStatus, ReasoningMode, RunStatus
from app.strategies.plan_solve import PlanSolveStrategy


def make_complete_state(**overrides) -> AgentSessionState:
    base = {
        "sessionId": "session-1",
        "projectId": "project-1",
        "reasoningMode": ReasoningMode.PLAN_SOLVE,
        "status": ProjectStatus.PLANNING,
        "fileOperations": [
            {
                "type": "write",
                "path": "package.json",
                "summary": "Write package",
                "content": "{\"name\":\"demo\",\"scripts\":{\"dev\":\"next dev\",\"build\":\"next build\"},\"dependencies\":{\"next\":\"^14.2.25\",\"react\":\"^18.3.1\",\"react-dom\":\"^18.3.1\"}}\n",
            },
            {
                "type": "write",
                "path": "src/app/layout.tsx",
                "summary": "Write root layout",
                "content": "import './globals.css';\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang=\"zh-CN\"><body>{children}</body></html>; }\n",
            },
            {
                "type": "write",
                "path": "src/app/globals.css",
                "summary": "Write global styles",
                "content": "body { margin: 0; }\n",
            },
            {
                "type": "write",
                "path": "src/app/page.tsx",
                "summary": "Write app shell",
                "content": "export default function App() {\n  return <main>Ready</main>;\n}\n",
            },
        ],
    }
    base.update(overrides)
    return AgentSessionState(**base)


def test_verify_loop_rejects_placeholder_app_content() -> None:
    strategy = PlanSolveStrategy()
    state = make_complete_state(
        fileOperations=[
            {
                "type": "write",
                "path": "src/app/page.tsx",
                "summary": "Render route shell",
                "content": "const Home = () => <div>行程概览页（待实现）</div>;\nexport default Home;\n",
            }
        ]
    )

    result = strategy.verify_loop(
        {
            "state": state.as_contract(),
            "workspace_snapshot": [
                {"path": "package.json", "content": "{}"},
                {"path": "src/app/layout.tsx", "content": "import './globals.css';\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n"},
                {"path": "src/app/globals.css", "content": "body { margin: 0; }"},
            ],
            "approved": False,
        }
    )

    next_state = AgentSessionState.model_validate(result["state"])

    assert next_state.status == ProjectStatus.ERROR
    assert next_state.error is not None
    assert "占位或 TODO 界面内容" in next_state.error
    assert next_state.run is not None
    assert next_state.run.status == RunStatus.FAILED


def test_verify_loop_rejects_missing_local_import_targets() -> None:
    strategy = PlanSolveStrategy()
    state = make_complete_state(
        fileOperations=[
            {
                "type": "write",
                "path": "package.json",
                "summary": "Write package",
                "content": "{\"name\":\"demo\"}\n",
            },
            {
                "type": "write",
                "path": "src/app/layout.tsx",
                "summary": "Write root layout",
                "content": "import './globals.css';\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
            },
            {
                "type": "write",
                "path": "src/app/globals.css",
                "summary": "Write global styles",
                "content": "body { margin: 0; }\n",
            },
            {
                "type": "write",
                "path": "src/app/page.tsx",
                "summary": "Render routed app",
                "content": (
                    "import Home from './components/Home';\n"
                    "export default function App() {\n"
                    "  return <Home />;\n"
                    "}\n"
                ),
            },
        ]
    )

    result = strategy.verify_loop(
        {
            "state": state.as_contract(),
            "workspace_snapshot": [],
            "approved": False,
        }
    )

    next_state = AgentSessionState.model_validate(result["state"])

    assert next_state.status == ProjectStatus.ERROR
    assert next_state.error is not None
    assert "引用了尚未生成的本地文件" in next_state.error
    assert "src/app/page.tsx -> ./components/Home" in next_state.error


def test_verify_loop_blocks_low_build_readiness_scores(monkeypatch) -> None:
    strategy = PlanSolveStrategy()
    state = make_complete_state()

    monkeypatch.setattr(
        strategy.critic,
        "evaluate",
        lambda current_state: EvaluationResult(
            buildReadinessScore=0.2,
            requirementCoverageScore=0.8,
            summary="构建稳定性不足，暂不建议进入审批。",
            issues=["[high] Build readiness is too low."],
        ),
    )

    result = strategy.verify_loop(
        {
            "state": state.as_contract(),
            "workspace_snapshot": [],
            "approved": False,
        }
    )

    next_state = AgentSessionState.model_validate(result["state"])

    assert next_state.status == ProjectStatus.ERROR
    assert next_state.error == "构建稳定性不足，暂不建议进入审批。"
    assert next_state.run is not None
    assert next_state.run.status == RunStatus.FAILED


def test_verify_loop_attempts_preflight_repair_for_incomplete_fresh_app(monkeypatch) -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        appSpec={
            "appName": "campus-market",
            "title": "校园二手市场",
            "summary": "二手交易平台",
            "goal": "帮助学生完成校园内交易",
            "targetUsers": ["大学生"],
            "screens": [],
            "coreFlows": [],
            "dataModelNeeds": [],
            "integrations": [],
            "brandAndVisualDirection": "青春活力",
            "constraints": [],
            "successCriteria": [],
            "assumptions": [],
        },
        fileOperations=[
            {
                "type": "write",
                "path": "package.json",
                "summary": "Write package manifest",
                "content": "{\"name\":\"campus-market\"}\n",
            },
            {
                "type": "write",
                "path": "src/app/globals.css",
                "summary": "Write incomplete global styles",
                "content": "body { margin: 0; }\n",
            },
        ],
    )

    captured = {"calls": []}

    def fake_repair(current_state, spec, context_snapshot, repair_context):
        captured["calls"].append(
            {
                "paths": [item.path for item in context_snapshot],
                "error": repair_context.build_error,
                "category": repair_context.category,
            }
        )
        current_state.file_operations = [
            FileOperation.model_validate({
                "type": "write",
                "path": "package.json",
                "summary": "Write package manifest",
                "content": "{\"name\":\"campus-market\"}\n",
            }),
            FileOperation.model_validate({
                "type": "write",
                "path": "src/app/layout.tsx",
                "summary": "Write root layout",
                "content": "import './globals.css';\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
            }),
            FileOperation.model_validate({
                "type": "write",
                "path": "src/app/globals.css",
                "summary": "Write global styles",
                "content": "body { margin: 0; }\n",
            }),
            FileOperation.model_validate({
                "type": "write",
                "path": "src/app/page.tsx",
                "summary": "Write app shell",
                "content": "export default function App() {\n  return <main>校园二手市场</main>;\n}\n",
            }),
        ]
        current_state.assistant_summary = "已自动补齐关键入口文件。"
        return current_state

    monkeypatch.setattr(strategy.codegen, "repair", fake_repair)
    monkeypatch.setattr(
        strategy.critic,
        "evaluate",
        lambda current_state: EvaluationResult(
            buildReadinessScore=0.9,
            requirementCoverageScore=0.8,
            summary="评审通过。",
            issues=[],
        ),
    )

    result = strategy.verify_loop(
        {
            "state": state.as_contract(),
            "workspace_snapshot": [],
            "approved": False,
        }
    )

    next_state = AgentSessionState.model_validate(result["state"])

    assert next_state.error is None
    assert captured["calls"][0]["error"] == "当前生成的文件操作还不能产出可运行的 Next.js App Router 应用。"
    assert captured["calls"][0]["category"] == "requirement_mismatch"
    assert "package.json" in captured["calls"][0]["paths"]
    assert {operation.path for operation in next_state.file_operations} >= {
        "package.json",
        "src/app/layout.tsx",
        "src/app/globals.css",
        "src/app/page.tsx",
    }


def test_verify_loop_does_not_run_design_polish_by_default(monkeypatch) -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-design",
        projectId="project-design",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        appSpec={
            "appName": "tennis-coach",
            "title": "网球训练助手",
            "summary": "帮助零基础用户训练。",
            "goal": "帮助用户完成训练计划、视频学习和进度跟踪。",
            "targetUsers": ["18岁零基础用户"],
            "screens": [],
            "coreFlows": [],
            "dataModelNeeds": [],
            "integrations": [],
            "brandAndVisualDirection": "年轻运动品牌风",
            "designTargets": {
                "visualMood": "年轻运动品牌风",
                "layoutEnergy": "强首屏与节奏感",
                "colorStrategy": "高对比动感配色",
                "componentTone": "紧凑训练卡片",
                "motionIntensity": "中到偏高",
                "interactionFocus": ["训练引导", "进度反馈"],
            },
            "constraints": [],
            "successCriteria": [],
            "assumptions": [],
        },
        fileOperations=make_complete_state().file_operations + [
            {
                "type": "write",
                "path": "src/app/polish.css",
                "summary": "Write app styles",
                "content": ".card { background: white; border-radius: 16px; }\n",
            },
        ],
    )

    repair_calls = {"count": 0}

    monkeypatch.setattr(
        strategy.critic,
        "evaluate",
        lambda current_state: EvaluationResult(
            buildReadinessScore=0.92,
            requirementCoverageScore=0.88,
            designQualityScore=0.54,
            interactionQualityScore=0.57,
            summary="构建与功能基本可用，但视觉完成度偏弱。",
            issues=[],
            designWarnings=["当前界面编排仍偏通用模板，和产品场景及设计目标的贴合度还可以更强。"],
        ),
    )

    def fake_repair(current_state, spec, context_snapshot, repair_context):
        repair_calls["count"] += 1
        current_state.file_operations = [
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "package.json",
                    "summary": "Write package",
                    "content": (
                        "{"
                        "\"name\":\"tennis-coach\","
                        "\"scripts\":{\"dev\":\"next dev\",\"build\":\"next build\"},"
                        "\"dependencies\":{\"next\":\"^14.2.25\",\"react\":\"^18.3.1\",\"react-dom\":\"^18.3.1\",\"lucide-react\":\"^0.511.0\",\"framer-motion\":\"^11.11.17\"},"
                        "\"devDependencies\":{\"tailwindcss\":\"^3.4.17\",\"postcss\":\"^8.4.49\",\"autoprefixer\":\"^10.4.20\"}"
                        "}\n"
                    ),
                }
            ),
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "tailwind.config.js",
                    "summary": "Write Tailwind config",
                    "content": "export default { content: ['./src/app/**/*.{js,ts,jsx,tsx}', './src/components/**/*.{js,ts,jsx,tsx}'], theme: { extend: {} }, plugins: [] };\n",
                }
            ),
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "postcss.config.js",
                    "summary": "Write PostCSS config",
                    "content": "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n",
                }
            ),
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "src/app/globals.css",
                    "summary": "Write base styles",
                    "content": "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
                }
            ),
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "src/app/layout.tsx",
                    "summary": "Write root layout",
                    "content": "import './globals.css';\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
                }
            ),
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "src/app/page.tsx",
                    "summary": "Write polished app",
                    "content": (
                        "import { motion } from 'framer-motion';\n"
                        "export default function App() {\n"
                        "  return <motion.main whileHover={{ scale: 1.01 }} className=\"min-h-screen bg-slate-950 text-white transition-colors\">训练计划</motion.main>;\n"
                        "}\n"
                    ),
                }
            ),
        ]
        current_state.assistant_summary = "已完成 Tailwind 视觉增强。"
        return current_state

    monkeypatch.setattr(strategy.codegen, "repair", fake_repair)

    result = strategy.verify_loop(
        {
            "state": state.as_contract(),
            "workspace_snapshot": [],
            "approved": False,
        }
    )

    next_state = AgentSessionState.model_validate(result["state"])

    assert repair_calls["count"] == 0
    assert next_state.error is None
    assert next_state.evaluation is not None
    assert next_state.evaluation.design_quality_score == 0.54
    assert next_state.evaluation.interaction_quality_score == 0.57
