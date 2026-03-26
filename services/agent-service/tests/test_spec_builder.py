from app.models import AgentSessionState, ReasoningMode, StructuredPlanOutput, StructuredSpecOutput
from app.services.spec_builder import SpecBuilder
from langchain_core.prompts import ChatPromptTemplate


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


def test_spec_builder_prompt_examples_do_not_create_fake_template_variables() -> None:
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "human",
                "Conversation:\n{messages}\n\n"
                "Working spec:\n{working_spec}\n\n"
                "Known assumptions:\n{assumptions}\n\n"
                "Return a JSON object with keys: title, summary, goal, targetUsers, screens, coreFlows, "
                "dataModelNeeds, integrations, brandAndVisualDirection, constraints, successCriteria, assumptions.\n"
                'For screens, every item must be an object like {{"name": "首页", "purpose": "说明该页面的核心作用", "elements": ["按钮", "卡片"]}}.\n'
                'For coreFlows, every item must be an object like {{"name": "注册流程", "steps": ["填写资料", "确认目标"], "success": "用户成功完成注册"}}.\n',
            )
        ]
    )

    rendered = prompt.format_messages(
        messages="[]",
        working_spec="{}",
        assumptions="无",
    )

    assert '"name": "首页"' in rendered[0].content


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


def test_build_spec_accepts_string_shaped_screens_and_flows(monkeypatch) -> None:
    builder = SpecBuilder()
    state = make_state()

    def fake_invoke_structured(**kwargs):
        return StructuredSpecOutput(
            title="网球训练助手",
            summary="帮助新手开始训练。",
            goal="帮助用户建立基础训练习惯。",
            targetUsers="零基础用户",
            screens=["登录/注册页面", "个人仪表盘页面"],
            coreFlows=["完成注册", {"title": "开始训练", "steps": "选择训练目标"}],
            dataModelNeeds="用户: 昵称 (string)",
            integrations="视频服务",
            brandAndVisualDirection="清新运动风",
            constraints="移动端优先",
            successCriteria="完成首个训练任务",
            assumptions="用户具备联网能力",
        )

    monkeypatch.setattr(builder, "_invoke_structured", fake_invoke_structured)

    spec = builder.build_spec(state)

    assert spec.target_users == ["零基础用户"]
    assert spec.screens[0].name == "登录/注册页面"
    assert spec.screens[0].purpose == "用于支撑登录/注册页面的核心使用体验。"
    assert spec.screens[0].id == "screen-1"
    assert spec.screens[1].id == "screen-2"
    assert spec.core_flows[0].name == "完成注册"
    assert spec.core_flows[0].success == "用户可以顺利完成完成注册。"
    assert spec.core_flows[1].steps == ["选择训练目标"]
    assert spec.data_model_needs[0].entity == "用户"
    assert spec.integrations == ["视频服务"]
    assert spec.constraints == ["移动端优先"]
    assert spec.success_criteria == ["完成首个训练任务"]
    assert spec.assumptions == ["用户具备联网能力"]
    assert spec.design_targets.visual_mood
    assert spec.design_targets.layout_energy
    assert spec.design_targets.interaction_focus


def test_build_spec_derives_design_targets_for_sports_learning_apps(monkeypatch) -> None:
    builder = SpecBuilder()
    state = AgentSessionState(
        sessionId="session-2",
        projectId="project-2",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        workingSpec={
            "title": "网球训练助手",
            "summary": "帮助 18 岁零基础用户建立训练节奏。",
            "goal": "为网球初学者提供训练计划、视频学习和进度反馈。",
            "targetUsers": ["18岁零基础用户"],
            "brandAndVisualDirection": "清爽但有冲击力的运动品牌风",
        },
    )

    def fake_invoke_structured(**kwargs):
        return StructuredSpecOutput(
            title="网球训练助手",
            summary="帮助新手建立训练节奏。",
            goal="帮助用户学习基础动作、跟踪训练进度并完成每日练习。",
            targetUsers=["18岁零基础用户"],
            screens=["首页", "训练计划", "进度仪表盘", "社区交流"],
            coreFlows=["开始训练", "记录完成情况"],
            dataModelNeeds=[],
            integrations=[],
            brandAndVisualDirection="清爽但有冲击力的运动品牌风",
            constraints=[],
            successCriteria=[],
            assumptions=[],
        )

    monkeypatch.setattr(builder, "_invoke_structured", fake_invoke_structured)

    spec = builder.build_spec(state)

    assert "运动品牌" in spec.design_targets.visual_mood
    assert "训练" in "".join(spec.design_targets.interaction_focus)
    assert spec.design_targets.motion_intensity


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
