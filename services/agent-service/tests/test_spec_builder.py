from app.models import AgentSessionState, ReasoningMode, StructuredPlanOutput, StructuredSpecOutput
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
    assert spec.screens[0].purpose == "用于支撑Itinerary Overview的核心使用体验。"
    assert spec.core_flows[0].id == "create-itinerary"
    assert spec.core_flows[0].success == "用户可以顺利完成Create itinerary。"
    assert spec.data_model_needs[0].entity == "Location"
    assert spec.data_model_needs[0].fields == ["name", "district"]
    assert spec.data_model_needs[0].notes == "Top places in Shanghai"


def test_build_spec_accepts_object_shaped_data_model_fields(monkeypatch) -> None:
    builder = SpecBuilder()
    state = make_state()

    def fake_invoke_structured(**kwargs):
        return StructuredSpecOutput(
            title="Basketball Learning Plan",
            summary="A guided basketball study companion.",
            goal="Help beginners learn skills and drills.",
            targetUsers=["Beginner players"],
            screens=[],
            coreFlows=[],
            dataModelNeeds=[
                {
                    "entity": "Drill",
                    "fields": [
                        {"name": "title", "type": "string"},
                        {"name": "difficulty", "type": "enum"},
                    ],
                    "notes": "Practice library",
                }
            ],
            integrations=[],
            brandAndVisualDirection="Clean sports coaching board",
            constraints=[],
            successCriteria=[],
            assumptions=[],
        )

    monkeypatch.setattr(builder, "_invoke_structured", fake_invoke_structured)

    spec = builder.build_spec(state)

    assert spec.data_model_needs[0].fields == ["title (string)", "difficulty (enum)"]


def test_build_spec_accepts_string_shaped_data_model_needs(monkeypatch) -> None:
    builder = SpecBuilder()
    state = make_state()

    def fake_invoke_structured(**kwargs):
        return StructuredSpecOutput(
            title="Basketball Learning Plan",
            summary="A guided basketball study companion.",
            goal="Help beginners learn skills and drills.",
            targetUsers=["Beginner players"],
            screens=[],
            coreFlows=[],
            dataModelNeeds=[
                "Drill: title (string), difficulty (enum)",
                "PracticeNote",
            ],
            integrations=[],
            brandAndVisualDirection="Clean sports coaching board",
            constraints=[],
            successCriteria=[],
            assumptions=[],
        )

    monkeypatch.setattr(builder, "_invoke_structured", fake_invoke_structured)

    spec = builder.build_spec(state)

    assert spec.data_model_needs[0].entity == "Drill"
    assert spec.data_model_needs[0].fields == ["title (string)", "difficulty (enum)"]
    assert spec.data_model_needs[1].entity == "PracticeNote"


def test_build_spec_uses_stable_fallback_ids_for_chinese_names(monkeypatch) -> None:
    builder = SpecBuilder()
    state = make_state()

    def fake_invoke_structured(**kwargs):
        return StructuredSpecOutput(
            title="上海一日游助手",
            summary="帮助用户安排行程。",
            goal="帮助游客完成上海一日游规划。",
            targetUsers=["游客"],
            screens=[
                {
                    "name": "行程总览",
                    "elements": ["时间线", "预算卡片"],
                }
            ],
            coreFlows=[
                {
                    "title": "生成路线",
                    "steps": ["选择兴趣", "确认停靠点"],
                }
            ],
            dataModelNeeds=[],
            integrations=[],
            brandAndVisualDirection="轻松旅行杂志风",
            constraints=[],
            successCriteria=[],
            assumptions=[],
        )

    monkeypatch.setattr(builder, "_invoke_structured", fake_invoke_structured)

    spec = builder.build_spec(state)

    assert spec.app_name == "generated-app"
    assert spec.screens[0].id == "screen-1"
    assert spec.core_flows[0].id == "flow-1"


def test_structured_plan_output_accepts_object_shaped_steps() -> None:
    result = StructuredPlanOutput.model_validate(
        {
            "steps": [
                {"id": 1, "description": "先完成首页与导航结构"},
                {"title": "补齐训练计划模块", "detail": "支持创建与编辑训练计划"},
                "增加进度跟踪页面",
            ],
            "summary": "实现计划",
        }
    )

    assert result.steps == [
        "先完成首页与导航结构",
        "补齐训练计划模块: 支持创建与编辑训练计划",
        "增加进度跟踪页面",
    ]
