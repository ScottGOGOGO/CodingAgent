from app.models import AgentSessionState, ReasoningMode, StructuredCriticOutput
from app.services.critic import CriticService


def make_state() -> AgentSessionState:
    return AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        appSpec={
            "appName": "shanghai-day-trip",
            "title": "Shanghai Day Trip",
            "summary": "One-day Shanghai itinerary helper.",
            "goal": "Help travelers plan one day in Shanghai.",
            "targetUsers": ["Travelers"],
            "screens": [],
            "coreFlows": [],
            "dataModelNeeds": [],
            "integrations": [],
            "brandAndVisualDirection": "Modern travel guide",
            "constraints": [],
            "successCriteria": [],
            "assumptions": [],
        },
        planSteps=[{"id": "step-1", "title": "Plan", "detail": "Plan", "status": "pending"}],
        fileOperations=[{"type": "write", "path": "src/App.tsx", "summary": "Write app", "content": "export default function App() { return null; }"}],
        lastContextPaths=["src/App.tsx"],
    )


def test_critic_normalizes_object_issues_and_missing_summary(monkeypatch) -> None:
    critic = CriticService()
    state = make_state()

    def fake_invoke(*args, **kwargs):
        return StructuredCriticOutput(
            buildReadinessScore=None,
            requirementCoverageScore=None,
            summary=None,
            issues=[
                {"title": "缺少核心页面", "severity": "critical"},
                {"title": "未集成地图服务", "severity": "high", "detail": "Need route support"},
            ],
        )

    monkeypatch.setattr(
        critic.provider,
        "require_chat_model",
        lambda role: type(
            "FakeModel",
            (),
            {
                "with_structured_output": lambda self, schema, method=None: type(
                    "Invoker", (), {"invoke": lambda self, messages: fake_invoke()}
                )()
            },
        )(),
    )

    result = critic.evaluate(state)

    assert result.summary == "Critic found 2 issue(s) to review before execution."
    assert result.issues == [
        "[critical] 缺少核心页面",
        "[high] 未集成地图服务: Need route support",
    ]
    assert 0.0 <= result.build_readiness_score <= 1.0
    assert 0.0 <= result.requirement_coverage_score <= 1.0
