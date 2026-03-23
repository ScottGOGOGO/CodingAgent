from app.config import get_settings
from app.main import AgentRuntime
from app.models import AgentRepairRequest, AgentTurnRequest, ProjectStatus, ReasoningMode


def test_runtime_returns_error_when_qwen_is_not_configured(monkeypatch) -> None:
    monkeypatch.setenv("QWEN_API_KEY", "")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "")
    get_settings.cache_clear()

    runtime = AgentRuntime()
    request = AgentTurnRequest(
        projectId="project-1",
        sessionId="session-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        clarificationAnswers={
            "product_goal": "Build a portfolio manager for creators",
            "target_users": "Independent creators",
            "core_pages": "Dashboard, projects, detail page",
            "key_interactions": "Upload work, edit metadata, filter projects",
            "visual_style": "Minimal editorial black and white",
            "external_integrations": "No integrations, local mock data only",
        },
    )

    state = runtime.process_turn(request)

    assert state.status == ProjectStatus.ERROR
    assert state.error is not None
    assert "Qwen API key is not configured" in state.error
    assert state.assistant_summary is not None
    assert state.assistant_summary.startswith("Generation failed:")


def test_runtime_repair_returns_error_when_qwen_is_not_configured(monkeypatch) -> None:
    monkeypatch.setenv("QWEN_API_KEY", "")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "")
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
            "requirementSlots": {},
            "clarityScore": 1,
            "clarificationRounds": 0,
            "missingSlots": [],
            "clarificationQuestions": [],
            "status": "applying_changes",
            "appSpec": {
                "appName": "demo",
                "title": "Demo",
                "summary": "Demo",
                "targetUsers": "Users",
                "pages": ["Home"],
                "keyInteractions": ["Browse"],
                "visualStyle": "Minimal",
                "integrations": ["None"],
                "assumptions": [],
            },
            "planSteps": [],
            "fileChangeSummary": [],
            "fileChanges": [],
            "executionManifest": [],
            "versionNumber": 0,
        },
        workspaceSnapshot=[
            {
                "path": "src/App.tsx",
                "content": "export default function App() { return <div>Hello</div>; }",
            }
        ],
        repairContext={
            "attempt": 1,
            "failedCommand": "npm run build",
            "buildError": "src/App.tsx:1 unused variable",
        },
    )

    state = runtime.process_repair(request)

    assert state.status == ProjectStatus.ERROR
    assert state.error is not None
    assert "Qwen API key is not configured" in state.error
