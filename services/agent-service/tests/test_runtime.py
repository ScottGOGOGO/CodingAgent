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
        userMessage="Build a planning workspace for product teams with a calm editorial look.",
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
    assert "Qwen API key is not configured" in state.error
