from app.models import AgentSessionState, ReasoningMode, StructuredSpecOutput
from app.services.spec_builder import SpecBuilder


def make_state() -> AgentSessionState:
    return AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        workingSpec={
            "title": "Shanghai Day Trip",
            "summary": "A one-day Shanghai itinerary planner.",
            "goal": "Help travelers plan a full day in Shanghai.",
            "targetUsers": ["First-time visitors"],
            "brandAndVisualDirection": "Warm travel magazine style",
        },
    )


def test_build_spec_backfills_missing_screen_purpose_flow_success_and_ids(monkeypatch) -> None:
    builder = SpecBuilder()
    state = make_state()

    def fake_invoke_structured(**kwargs):
        return StructuredSpecOutput(
            title="",
            summary="",
            goal="",
            targetUsers=["Weekend travelers"],
            screens=[
                {
                    "name": "Itinerary Overview",
                    "elements": ["Budget summary", "Timeline"],
                }
            ],
            coreFlows=[
                {
                    "title": "Create itinerary",
                    "steps": ["Choose interests", "Select stops"],
                }
            ],
            dataModelNeeds=[
                {
                    "name": "Location",
                    "fields": ["name", "district"],
                    "description": "Top places in Shanghai",
                }
            ],
            integrations=[],
            brandAndVisualDirection={"tone": "Warm", "layout": "Card-based"},
            constraints=[],
            successCriteria=[],
            assumptions=[],
        )

    monkeypatch.setattr(builder, "_invoke_structured", fake_invoke_structured)

    spec = builder.build_spec(state)

    assert spec.title == "Shanghai Day Trip"
    assert spec.summary == "A one-day Shanghai itinerary planner."
    assert spec.goal == "Help travelers plan a full day in Shanghai."
    assert spec.brand_and_visual_direction == "tone: Warm; layout: Card-based"
    assert spec.screens[0].id == "itinerary-overview"
    assert spec.screens[0].purpose == "Support the itinerary overview experience."
    assert spec.core_flows[0].id == "create-itinerary"
    assert spec.core_flows[0].success == "Users can successfully complete create itinerary."
    assert spec.data_model_needs[0].entity == "Location"
    assert spec.data_model_needs[0].notes == "Top places in Shanghai"
