from app.config import get_settings
from app.main import AgentRuntime
from app.models import AgentRepairRequest, AgentTurnRequest, ProjectStatus, ReasoningMode
from app.strategies.plan_solve import PlanSolveStrategy


def test_runtime_routes_plan_solve_and_react_through_the_same_strategy_instance() -> None:
    runtime = AgentRuntime()

    plan_solve_strategy = runtime._strategy_for_mode(ReasoningMode.PLAN_SOLVE)
    react_strategy = runtime._strategy_for_mode(ReasoningMode.REACT)

    assert isinstance(plan_solve_strategy, PlanSolveStrategy)
    assert plan_solve_strategy is react_strategy


def test_runtime_returns_error_when_model_api_key_is_not_configured(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai_compatible")
    monkeypatch.setenv("MODEL_API_KEY", "")
    monkeypatch.setenv("MODEL_BASE_URL", "")
    monkeypatch.setenv("MODEL_NAME", "")
    monkeypatch.setenv("QWEN_API_KEY", "")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    monkeypatch.setenv("OPENAI_MODEL", "")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("GEMINI_BASE_URL", "")
    monkeypatch.setenv("GEMINI_MODEL", "")
    monkeypatch.setenv("CLAUDE_API_KEY", "")
    monkeypatch.setenv("CLAUDE_BASE_URL", "")
    monkeypatch.setenv("CLAUDE_MODEL", "")
    get_settings.cache_clear()

    runtime = AgentRuntime()
    request = AgentTurnRequest(
        projectId="project-1",
        sessionId="session-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        userMessage="Build a planning workspace for product teams with a calm editorial look.",
    )

    state = runtime.process_turn(request)

    assert state.status == ProjectStatus.ERROR
    assert state.error is not None
    assert "未配置模型 API Key" in state.error
    assert state.assistant_summary is not None
    assert state.assistant_summary.startswith("生成失败：")


def test_runtime_repair_returns_error_when_model_api_key_is_not_configured(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai_compatible")
    monkeypatch.setenv("MODEL_API_KEY", "")
    monkeypatch.setenv("MODEL_BASE_URL", "")
    monkeypatch.setenv("MODEL_NAME", "")
    monkeypatch.setenv("QWEN_API_KEY", "")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    monkeypatch.setenv("OPENAI_MODEL", "")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("GEMINI_BASE_URL", "")
    monkeypatch.setenv("GEMINI_MODEL", "")
    monkeypatch.setenv("CLAUDE_API_KEY", "")
    monkeypatch.setenv("CLAUDE_BASE_URL", "")
    monkeypatch.setenv("CLAUDE_MODEL", "")
    get_settings.cache_clear()

    runtime = AgentRuntime()
    request = AgentRepairRequest(
        projectId="project-1",
        sessionId="session-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        state={
            "sessionId": "session-1",
            "projectId": "project-1",
            "reasoningMode": "plan_solve",
            "messages": [],
            "workingSpec": {
                "goal": "Build a planning workspace",
                "targetUsers": ["Product teams"],
            },
            "status": "repairing",
            "appSpec": {
                "appName": "planning-workspace",
                "title": "Planning Workspace",
                "summary": "Collaborative planning app",
                "goal": "Help teams plan work",
                "targetUsers": ["Product teams"],
                "screens": [],
                "coreFlows": [],
                "dataModelNeeds": [],
                "integrations": [],
                "brandAndVisualDirection": "Calm editorial interface",
                "constraints": [],
                "successCriteria": [],
                "assumptions": [],
            },
            "planSteps": [],
            "fileChangeSummary": [],
            "fileOperations": [],
            "executionManifest": [],
            "versionNumber": 0,
            "assumptions": [],
            "lastContextPaths": [],
        },
        workspaceSnapshot=[
            {
                "path": "src/App.tsx",
                "content": "export default function App() { return <div>Hello</div>; }",
            }
        ],
        repairContext={
            "attempt": 1,
            "category": "type_build",
            "failedCommand": "npm run build",
            "buildError": "src/App.tsx:1 unused variable",
        },
    )

    state = runtime.process_repair(request)

    assert state.status == ProjectStatus.ERROR
    assert state.error is not None
    assert "未配置模型 API Key" in state.error
