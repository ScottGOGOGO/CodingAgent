from app.models import AgentSessionState, ProjectStatus, ReasoningMode
from app.services.clarifier import (
    apply_clarification_answers,
    clarity_score,
    missing_slots,
    next_clarification_state,
)


def make_state() -> AgentSessionState:
    return AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
    )


def test_clarifier_requests_questions_for_missing_slots() -> None:
    state = next_clarification_state(make_state())
    assert state.status == ProjectStatus.CLARIFYING
    assert len(state.clarification_questions) == 3
    assert state.clarity_score == 0.0


def test_clarifier_applies_structured_answers() -> None:
    state = make_state()
    state.requirement_slots = apply_clarification_answers(
        state.requirement_slots,
        {
            "product_goal": "Build a creator dashboard",
            "target_users": "Independent creators",
            "core_pages": "Overview, sponsors, analytics",
        },
    )
    missing = missing_slots(state.requirement_slots)
    assert "product_goal" not in [item.value for item in missing]
    assert clarity_score(state.requirement_slots) == 0.5


def test_clarifier_stops_after_three_rounds() -> None:
    state = make_state()
    state.clarification_rounds = 3
    state = next_clarification_state(state)
    assert state.status == ProjectStatus.PLANNING
    assert state.requirement_slots.visual_style is not None
