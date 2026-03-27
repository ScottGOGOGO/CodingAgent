from app.models import AgentSessionState, ReasoningMode, StructuredCriticOutput
from app.services.errors import GenerationFailure
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

    assert result.summary == "评审发现 2 个问题，执行前需要先处理。"
    assert result.issues == [
        "[critical] 缺少核心页面",
        "[high] 未集成地图服务: Need route support",
    ]
    assert 0.0 <= result.build_readiness_score <= 1.0
    assert 0.0 <= result.requirement_coverage_score <= 1.0
    assert 0.0 <= result.design_quality_score <= 1.0
    assert 0.0 <= result.interaction_quality_score <= 1.0
    assert result.design_warnings


def test_structured_critic_output_accepts_string_scores_and_single_issue() -> None:
    result = StructuredCriticOutput.model_validate(
        {
            "buildReadinessScore": "80%",
            "requirementCoverageScore": "0.65",
            "designQualityScore": {"value": "72%"},
            "interactionQualityScore": "0.61",
            "summary": {"text": "基本可执行"},
            "issues": {"severity": "high", "title": "功能覆盖不足"},
            "designWarnings": {"title": "视觉层级偏弱"},
        }
    )

    assert result.build_readiness_score == 0.8
    assert result.requirement_coverage_score == 0.65
    assert result.design_quality_score == 0.72
    assert result.interaction_quality_score == 0.61
    assert result.summary == "text: 基本可执行"
    assert result.issues == [{"severity": "high", "title": "功能覆盖不足"}]
    assert result.design_warnings == [{"title": "视觉层级偏弱"}]


def test_critic_falls_back_to_heuristics_when_model_returns_empty_response(monkeypatch) -> None:
    critic = CriticService()
    state = make_state()

    monkeypatch.setattr(
        critic.provider,
        "require_chat_model",
        lambda role: type(
            "FakeModel",
            (),
            {
                "with_structured_output": lambda self, schema, method=None: type(
                    "Invoker", (), {"invoke": lambda self, messages: (_ for _ in ()).throw(GenerationFailure("模型返回了空响应，未提供 JSON 结果。"))}
                )()
            },
        )(),
    )

    result = critic.evaluate(state)

    assert result.issues
    assert any("[critical]" in issue.lower() or "[high]" in issue.lower() for issue in result.issues)
    assert 0.0 <= result.build_readiness_score <= 1.0
