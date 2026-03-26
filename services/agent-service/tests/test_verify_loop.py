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

    captured = {}

    def fake_repair(current_state, spec, context_snapshot, repair_context):
        captured["paths"] = [item.path for item in context_snapshot]
        captured["error"] = repair_context.build_error
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
    assert captured["error"] == "当前生成的文件操作还不能产出可运行的 React + Vite 应用。"
    assert "package.json" in captured["paths"]
    assert {operation.path for operation in next_state.file_operations} >= {
        "package.json",
        "index.html",
        "src/main.tsx",
        "src/App.tsx",
    }
