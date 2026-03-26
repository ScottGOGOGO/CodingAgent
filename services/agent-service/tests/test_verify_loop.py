from app.models import AgentSessionState, EvaluationResult, FileOperation, ProjectStatus, ReasoningMode, RunStatus
from app.strategies.plan_solve import PlanSolveStrategy


def test_verify_loop_rejects_placeholder_app_content() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
            {
                "type": "write",
                "path": "src/App.tsx",
                "summary": "Render route shell",
                "content": "const Home = () => <div>行程概览页（待实现）</div>;\nexport default Home;\n",
            }
        ],
    )

    result = strategy.verify_loop(
        {
            "state": state.as_contract(),
            "workspace_snapshot": [
                {"path": "package.json", "content": "{}"},
                {"path": "index.html", "content": "<!doctype html>"},
                {"path": "src/main.tsx", "content": "import './App';"},
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
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
            {
                "type": "write",
                "path": "src/App.tsx",
                "summary": "Render routed app",
                "content": (
                    "import Home from './components/Home';\n"
                    "export default function App() {\n"
                    "  return <Home />;\n"
                    "}\n"
                ),
            }
        ],
    )

    result = strategy.verify_loop(
        {
            "state": state.as_contract(),
            "workspace_snapshot": [
                {"path": "package.json", "content": "{}"},
                {"path": "index.html", "content": "<!doctype html>"},
                {"path": "src/main.tsx", "content": "import './App';"},
            ],
            "approved": False,
        }
    )

    next_state = AgentSessionState.model_validate(result["state"])

    assert next_state.status == ProjectStatus.ERROR
    assert next_state.error is not None
    assert "引用了尚未生成的本地文件" in next_state.error
    assert "src/App.tsx -> ./components/Home" in next_state.error


def test_verify_loop_ignores_normal_input_placeholder_props() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
            {
                "type": "write",
                "path": "src/App.tsx",
                "summary": "Render app shell",
                "content": (
                    "export default function App() {\n"
                    "  return <input placeholder=\"Type your goal\" />;\n"
                    "}\n"
                ),
            }
        ],
    )

    assert strategy._find_placeholder_paths(state.file_operations) == []


def test_verify_loop_ignores_placeholder_text_inside_code_comments() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
            {
                "type": "write",
                "path": "src/pages/Lesson.tsx",
                "summary": "Render lesson page",
                "content": (
                    "export default function Lesson() {\n"
                    "  /* Video Placeholder */\n"
                    "  return <img alt='Demo' src='https://placehold.co/600x340' />;\n"
                    "}\n"
                ),
            }
        ],
    )

    assert strategy._find_placeholder_paths(state.file_operations) == []


def test_critic_stub_feedback_ignores_warning_level_placeholder_data_notes() -> None:
    assert not PlanSolveStrategy._critic_found_blocking_stub_feedback(
        "The code is highly build-ready and nearly complete.",
        [
            "[warning] Step 2 is not implemented yet — only placeholder week1Plan is used for the demo.",
            "[info] Some sample drill data is still hardcoded for maintainability reasons.",
        ],
    )


def test_critic_stub_feedback_blocks_critical_placeholder_ui_findings() -> None:
    assert PlanSolveStrategy._critic_found_blocking_stub_feedback(
        "The app still contains route-only skeleton screens.",
        [
            "[critical] Placeholder UI remains in src/App.tsx with 待实现 labels.",
        ],
    )


def test_find_placeholder_paths_blocks_user_facing_video_placeholder_copy() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
            {
                "type": "write",
                "path": "src/pages/DrillDetail.tsx",
                "summary": "Render drill detail",
                "content": "export default function DrillDetail() { return <p>Video placeholder - in production, this would be a real drill video.</p>; }",
            }
        ],
    )

    assert strategy._find_placeholder_paths(state.file_operations) == ["src/pages/DrillDetail.tsx"]


def test_find_placeholder_paths_ignores_patch_search_when_replacement_removes_placeholder() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
            {
                "type": "patch",
                "path": "src/App.tsx",
                "summary": "Replace placeholder copy",
                "hunks": [
                    {
                        "search": "[Video placeholder: Serve demo]",
                        "replace": "Video lesson focus: Serve demo",
                    }
                ],
            }
        ],
    )

    assert strategy._find_placeholder_paths(state.file_operations) == []


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
                "path": "index.html",
                "summary": "Write html shell",
                "content": "<!doctype html><html><body><div id='root'></div></body></html>\n",
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
                "path": "index.html",
                "summary": "Write html shell",
                "content": "<!doctype html><html><body><div id='root'></div></body></html>\n",
            }),
            FileOperation.model_validate({
                "type": "write",
                "path": "src/main.tsx",
                "summary": "Write app entry",
                "content": "import ReactDOM from 'react-dom/client';\nimport App from './App';\nReactDOM.createRoot(document.getElementById('root')!).render(<App />);\n",
            }),
            FileOperation.model_validate({
                "type": "write",
                "path": "src/App.tsx",
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
        lambda state: EvaluationResult(
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
    assert captured["calls"][0]["error"] == "当前生成的文件操作还不能产出可运行的 React + Vite 应用。"
    assert captured["calls"][0]["category"] == "requirement_mismatch"
    assert "package.json" in captured["calls"][0]["paths"]
    assert {operation.path for operation in next_state.file_operations} >= {
        "package.json",
        "index.html",
        "src/main.tsx",
        "src/App.tsx",
    }


def test_verify_loop_runs_single_design_polish_pass_when_design_scores_are_low(monkeypatch) -> None:
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
        fileOperations=[
            {
                "type": "write",
                "path": "package.json",
                "summary": "Write package",
                "content": "{\"name\":\"tennis-coach\",\"dependencies\":{\"react\":\"^18.3.1\",\"react-dom\":\"^18.3.1\"},\"devDependencies\":{\"vite\":\"^5.4.5\"}}\n",
            },
            {
                "type": "write",
                "path": "index.html",
                "summary": "Write html",
                "content": "<!doctype html><html><body><div id='root'></div></body></html>\n",
            },
            {
                "type": "write",
                "path": "src/main.tsx",
                "summary": "Write main entry",
                "content": "import ReactDOM from 'react-dom/client';\nimport App from './App';\nReactDOM.createRoot(document.getElementById('root')!).render(<App />);\n",
            },
            {
                "type": "write",
                "path": "src/App.tsx",
                "summary": "Write generic app",
                "content": "export default function App() {\n  return <main><header>网球训练助手</header><section className='card'>训练计划</section></main>;\n}\n",
            },
            {
                "type": "write",
                "path": "src/App.css",
                "summary": "Write app styles",
                "content": ".card { background: white; border-radius: 16px; }\n",
            },
        ],
    )

    evaluations = iter(
        [
            EvaluationResult(
                buildReadinessScore=0.92,
                requirementCoverageScore=0.88,
                designQualityScore=0.54,
                interactionQualityScore=0.57,
                summary="构建与功能基本可用，但视觉完成度偏弱。",
                issues=[],
                designWarnings=["当前方案还没有建立 Tailwind 主题系统，视觉语言仍容易退回普通模板化页面。"],
            ),
            EvaluationResult(
                buildReadinessScore=0.94,
                requirementCoverageScore=0.9,
                designQualityScore=0.66,
                interactionQualityScore=0.63,
                summary="视觉和交互已补强，但仍建议人工审阅。",
                issues=[],
                designWarnings=["页面层级已增强，但移动端细节仍可继续优化。"],
            ),
        ]
    )
    repair_calls = {"count": 0, "category": None}

    monkeypatch.setattr(strategy.critic, "evaluate", lambda current_state: next(evaluations))

    def fake_repair(current_state, spec, context_snapshot, repair_context):
        repair_calls["count"] += 1
        repair_calls["category"] = repair_context.category
        current_state.file_operations = [
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "package.json",
                    "summary": "Write package",
                    "content": (
                        "{"
                        "\"name\":\"tennis-coach\","
                        "\"dependencies\":{\"react\":\"^18.3.1\",\"react-dom\":\"^18.3.1\",\"lucide-react\":\"^0.511.0\",\"framer-motion\":\"^11.11.17\"},"
                        "\"devDependencies\":{\"vite\":\"^5.4.5\",\"tailwindcss\":\"^3.4.17\",\"postcss\":\"^8.4.49\",\"autoprefixer\":\"^10.4.20\"}"
                        "}\n"
                    ),
                }
            ),
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "tailwind.config.js",
                    "summary": "Write Tailwind config",
                    "content": "export default { content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'], theme: { extend: {} }, plugins: [] };\n",
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
                    "path": "src/index.css",
                    "summary": "Write base styles",
                    "content": "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
                }
            ),
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "src/main.tsx",
                    "summary": "Write main entry",
                    "content": "import ReactDOM from 'react-dom/client';\nimport './index.css';\nimport App from './App';\nReactDOM.createRoot(document.getElementById('root')!).render(<App />);\n",
                }
            ),
            FileOperation.model_validate(
                {
                    "type": "write",
                    "path": "src/App.tsx",
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

    assert repair_calls["count"] == 1
    assert repair_calls["category"] == "design_polish"
    assert next_state.error is None
    assert next_state.evaluation is not None
    assert next_state.evaluation.design_quality_score == 0.66
    assert next_state.evaluation.interaction_quality_score == 0.63
    assert next_state.evaluation.design_warnings[0] == "已执行一轮 Tailwind 视觉增强，当前结果仍建议人工审阅视觉层级与交互细节。"
