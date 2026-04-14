from app.models import AgentSessionState, AppSpec, DesignTargets, ReasoningMode, StructuredPlanOutput, StructuredSpecOutput
from app.services.errors import GenerationFailure
from app.services.spec_builder import SpecBuilder
from langchain_core.prompts import ChatPromptTemplate
import pytest


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


def test_build_spec_calls_llm_after_clarification(monkeypatch) -> None:
    builder = SpecBuilder()
    state = AgentSessionState(
        sessionId="session-local-spec",
        projectId="project-local-spec",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        messages=[
            {"id": "u1", "role": "user", "content": "请帮我做一个面向中国雅思考生的三个月备考规划 Web 应用。", "createdAt": "2026-03-31T00:00:00Z"},
            {"id": "a1", "role": "assistant", "content": "请补充目标用户、核心任务和首版功能。", "createdAt": "2026-03-31T00:00:01Z"},
            {
                "id": "u2",
                "role": "user",
                "content": "目标用户是总分6到6.5想冲8分的中国考生，计划周期3个月，每天可以投入3小时。首版要有基础信息录入、12周计划、每日任务、打卡、每周复盘、错题记录和资料推荐，界面希望专业、清晰、偏浅色、支持移动端。",
                "createdAt": "2026-03-31T00:00:02Z",
            },
        ],
        clarificationDecision={
            "action": "assume_ready",
            "summary": "信息足够，继续推进。",
            "clarityScore": 0.82,
            "missingInformation": [],
            "questions": [],
            "assumptions": [],
        },
        workingSpec={},
        status="planning",
    )
    call_count = 0

    def fake_invoke_structured(**kwargs):
        nonlocal call_count
        call_count += 1
        return StructuredSpecOutput(
            title="雅思三个月备考规划应用",
            summary="帮助中国雅思考生生成并执行三个月备考计划。",
            goal="帮助总分6到6.5的考生冲刺8分。",
            targetUsers=["总分6到6.5、目标8分的中国雅思考生"],
            screens=[
                {"name": "基础信息录入", "purpose": "录入学习基础与目标分数", "elements": ["表单", "目标卡片"]},
                {"name": "12周计划", "purpose": "查看阶段目标与每周安排", "elements": ["时间线", "计划卡片"]},
            ],
            coreFlows=[
                {"name": "生成个性化计划", "steps": ["填写基础信息", "生成计划"], "success": "用户获得可执行的三个月计划"},
            ],
            dataModelNeeds=[],
            integrations=[],
            brandAndVisualDirection="专业、清晰、偏浅色、支持移动端",
            constraints=["支持移动端"],
            successCriteria=["用户可以获得一份可执行的 12 周备考计划"],
            assumptions=[],
        )

    monkeypatch.setattr(builder, "_invoke_structured", fake_invoke_structured)

    spec = builder.build_spec(state)

    assert call_count == 1
    assert "雅思" in spec.title or "备考" in spec.title
    assert spec.target_users
    assert any(screen.name == "基础信息录入" for screen in spec.screens)
    assert any(flow.name == "生成个性化计划" for flow in spec.core_flows)
    assert "移动端" in "".join(spec.success_criteria + spec.assumptions + spec.constraints)


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


def test_build_plan_calls_llm_when_spec_has_structure(monkeypatch) -> None:
    builder = SpecBuilder()
    spec = AppSpec(
        appName="ielts-planner",
        title="雅思备考规划应用",
        summary="帮助用户生成三个月备考计划。",
        goal="帮助考生生成并执行可落地的备考方案。",
        targetUsers=["中国雅思考生"],
        screens=[{"name": "基础信息录入", "purpose": "用于录入基础条件", "elements": []}],
        coreFlows=[{"name": "生成个性化计划", "steps": ["填写信息", "生成计划"], "success": "用户获得可执行计划"}],
        dataModelNeeds=[],
        integrations=[],
        brandAndVisualDirection="专业、清晰、偏浅色",
        designTargets=DesignTargets(
            visualMood="专业",
            layoutEnergy="清晰分层",
            colorStrategy="浅色",
            componentTone="现代卡片",
            motionIntensity="低到中",
            interactionFocus=["主路径引导"],
        ),
        constraints=[],
        successCriteria=[],
        assumptions=[],
    )
    call_count = 0

    def fake_invoke_structured(**kwargs):
        nonlocal call_count
        call_count += 1
        return StructuredPlanOutput.model_validate(
            {
                "steps": [
                    "搭建整体应用骨架与基础页面结构",
                    "实现基础信息录入与目标配置流程",
                    "生成并展示 12 周备考计划",
                    "补齐每日任务、打卡和复盘模块",
                    "完善响应式体验并完成构建自检",
                ],
                "summary": "实现计划",
            }
        )

    monkeypatch.setattr(builder, "_invoke_structured", fake_invoke_structured)

    steps = builder.build_plan(spec)

    assert call_count == 1
    assert len(steps) == 5
    assert "应用骨架" in steps[0].title
    assert "响应式" in steps[-1].title


def test_build_spec_raises_when_model_returns_empty_response(monkeypatch) -> None:
    builder = SpecBuilder()
    state = AgentSessionState(
        sessionId="session-3",
        projectId="project-3",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        workingSpec={
            "title": "AI学习助手",
            "summary": "一个面向高中生的学习产品。",
            "goal": "帮助用户完成每日学习计划、错题整理和复习提醒。",
            "targetUsers": ["中国高中生"],
            "screens": ["首页", "今日计划", "错题本", "学习进度"],
            "constraints": ["先用模拟数据", "不需要登录"],
            "brandAndVisualDirection": "清晰、现代、偏教育产品",
        },
    )

    def fail_invoke_structured(**kwargs):
        raise GenerationFailure("模型返回了空响应，未提供 JSON 结果。")

    monkeypatch.setattr(builder, "_invoke_structured", fail_invoke_structured)

    with pytest.raises(GenerationFailure, match="模型返回了空响应"):
        builder.build_spec(state)


def test_build_plan_raises_when_model_returns_empty_response(monkeypatch) -> None:
    builder = SpecBuilder()
    spec = AppSpec(
        appName="ai-study-assistant",
        title="AI学习助手",
        summary="一个面向高中生的学习产品。",
        goal="帮助用户完成每日学习计划、错题整理和复习提醒。",
        targetUsers=["中国高中生"],
        screens=[],
        coreFlows=[],
        dataModelNeeds=[],
        integrations=[],
        brandAndVisualDirection="清晰、现代、偏教育产品",
        designTargets=DesignTargets(
            visualMood="清晰、现代",
            layoutEnergy="分层清晰",
            colorStrategy="明亮教育风",
            componentTone="轻量内容卡",
            motionIntensity="低到中",
            interactionFocus=["学习主路径引导"],
        ),
        constraints=[],
        successCriteria=[],
        assumptions=[],
    )

    def fail_invoke_structured(**kwargs):
        raise GenerationFailure("模型返回了空响应，未提供 JSON 结果。")

    monkeypatch.setattr(builder, "_invoke_structured", fail_invoke_structured)

    with pytest.raises(GenerationFailure, match="模型返回了空响应"):
        builder.build_plan(spec)
