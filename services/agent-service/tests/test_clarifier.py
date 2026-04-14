from app.models import (
    AgentSessionState,
    ChatRole,
    ClarificationAnswer,
    ClarificationDecision,
    ClarificationQuestion,
    ReasoningMode,
    StructuredClarifierOutput,
    WorkingSpec,
)
from app.services.clarifier import DynamicClarifier, append_user_message, apply_clarification_answers
from app.services.errors import GenerationFailure
from langchain_core.prompts import ChatPromptTemplate
import pytest


def make_state() -> AgentSessionState:
    return AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
    )


def test_append_user_message_adds_message() -> None:
    state = append_user_message(make_state(), "Build an app for finance teams")
    assert len(state.messages) == 1
    assert state.messages[0].content == "Build an app for finance teams"


def test_apply_clarification_answers_appends_structured_follow_up() -> None:
    state = make_state()
    state.clarification_decision = ClarificationDecision(
        action="ask",
        summary="Need more detail.",
        clarityScore=0.4,
        missingInformation=["target users"],
        questions=[
            ClarificationQuestion(
                id="q-users",
                question="Who will use this product day to day?",
                placeholder="Describe the primary audience",
            )
        ],
        assumptions=[],
    )

    state = apply_clarification_answers(
        state,
        [ClarificationAnswer(questionId="q-users", answer="Internal finance operators")],
    )

    assert len(state.messages) == 1
    assert "Internal finance operators" in state.messages[0].content


def test_prompt_schema_description_does_not_create_fake_template_variables() -> None:
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "human",
                "Conversation:\n{messages}\n\n"
                "Current working spec:\n{working_spec}\n\n"
                "Existing assumptions:\n{assumptions}\n\n"
                "workingSpec must include these fields:\n"
                "- title: string or null\n"
                "- screens: array of objects with id, name, purpose, elements\n",
            )
        ]
    )

    rendered = prompt.format_messages(
        messages="[]",
        working_spec="{}",
        assumptions="None",
    )

    assert "title" in rendered[0].content


def test_clarifier_normalizes_nonstandard_action_and_clarity_score() -> None:
    clarifier = DynamicClarifier()

    action = clarifier._normalize_action("questions", [], ["budget"])
    clarity_score = clarifier._normalize_clarity_score(None, action, ["follow-up"])

    assert action == "ask"
    assert clarity_score == 0.45


def test_clarifier_raises_when_summary_is_missing() -> None:
    clarifier = DynamicClarifier()

    with pytest.raises(GenerationFailure, match="未返回 summary"):
        clarifier._normalize_summary(None)


def test_structured_clarifier_output_accepts_string_questions_and_scores() -> None:
    result = StructuredClarifierOutput.model_validate(
        {
            "action": {"label": "ready"},
            "summary": {"text": "信息足够，进入规划"},
            "clarityScore": "85%",
            "missingInformation": "预算范围",
            "questions": "你希望优先支持哪些功能？",
            "assumptions": {"label": "默认移动端优先"},
            "workingSpec": "一个帮助用户规划训练的应用",
        }
    )

    assert result.action == "ready"
    assert result.summary == "text: 信息足够，进入规划"
    assert result.clarity_score == 0.85
    assert result.missing_information == ["预算范围"]
    assert result.questions[0].question == "你希望优先支持哪些功能？"
    assert result.assumptions == [{"label": "默认移动端优先"}]
    assert result.working_spec.summary == "一个帮助用户规划训练的应用"


def test_clarifier_prefers_assume_ready_for_rich_prompt_with_non_blocking_gaps() -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(
        make_state(),
        "帮我生成一个针对零基础初学者的网球自学计划应用，面向18岁零基础用户，需要视频教学、练习计划制定、进度跟踪、动作纠正和社区交流功能。",
    )

    should_assume_ready = clarifier._should_assume_ready(
        state=state,
        working_spec=WorkingSpec(
            title="网球自学计划应用",
            summary="帮助零基础用户系统化学习网球。",
            targetUsers=["18岁零基础用户"],
            screens=["首页", "课程页"],
        ),
        questions=[
            ClarificationQuestion(question="您希望这个应用采用什么品牌调性和视觉风格？"),
            ClarificationQuestion(question="您对应用的成功标准有什么具体期望？"),
        ],
        missing_information=["品牌风格偏好", "成功标准指标"],
    )

    assert should_assume_ready


def test_clarifier_forces_initial_clarification_for_first_turn_by_default() -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(
        make_state(),
        "帮我生成一个针对零基础初学者的网球自学计划应用，面向18岁零基础用户，需要视频教学、练习计划制定、进度跟踪、动作纠正和社区交流功能。",
    )

    should_force = clarifier._should_force_initial_clarification(
        state,
        WorkingSpec(
            title="网球自学计划应用",
            summary="帮助零基础用户系统化学习网球。",
            targetUsers=["18岁零基础用户"],
            screens=["首页", "课程页"],
        ),
    )

    assert should_force is True


def test_clarifier_requires_multiple_llm_questions_for_initial_turn(monkeypatch) -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(make_state(), "帮我做一个学习应用")

    monkeypatch.setattr(clarifier.provider, "require_chat_model", lambda role, timeout_seconds=None: object())

    monkeypatch.setattr(
        "app.services.clarifier.invoke_structured_json",
        lambda **kwargs: StructuredClarifierOutput.model_validate(
            {
                "action": "ask",
                "summary": "我还需要补充一些信息。",
                "clarityScore": 0.4,
                "missingInformation": ["目标用户与使用场景"],
                "questions": [
                    {
                        "id": "q-1",
                        "question": "这款应用主要给谁用？",
                        "placeholder": "描述主要用户",
                    }
                ],
                "assumptions": [],
                "workingSpec": {},
            }
        ),
    )

    with pytest.raises(GenerationFailure, match="未返回足够的问题"):
        clarifier.decide(state)


def test_clarifier_assumes_ready_after_multiple_followups_when_only_boundary_gaps_remain() -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(make_state(), "帮我做一个学习类应用。")
    state = append_user_message(
        state,
        "面向准备考研的大学生，先做网页应用，核心是学习计划、刷题、错题本、进度统计和 AI 答疑。",
    )
    state = append_user_message(
        state,
        "首版覆盖英语和政治，计划自动生成也可手动调整，AI 先做题目追问和有限自由问答。",
    )

    should_assume_ready = clarifier._should_assume_ready(
        state=state,
        working_spec=WorkingSpec(
            title="考研学习网页应用",
            summary="帮助考研用户完成计划、练习、错题复盘和 AI 答疑。",
            goal="帮助用户连续学习和刷题。",
            targetUsers=["准备考研的大学生"],
            screens=["学习首页", "任务计划", "题库练习", "错题本", "进度统计"],
            coreFlows=["制定计划", "刷题练习", "错题复盘", "AI 追问"],
        ),
        questions=[
            ClarificationQuestion(question="首版题库准备怎么来？"),
            ClarificationQuestion(question="首版是否需要完整登录注册？"),
            ClarificationQuestion(question="AI 自由问答希望控制到什么边界？"),
        ],
        missing_information=["题库内容来源", "登录方式", "AI 使用限制"],
    )

    assert should_assume_ready is True


def test_clarifier_assumes_ready_after_two_rich_turns_when_only_planning_detail_gaps_remain() -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(
        make_state(),
        "请帮我生成一个面向中国雅思考生的三个月备考规划 Web 应用，需要基础信息录入、12周计划、每日任务、打卡、复盘、错题记录和资料推荐。",
    )
    state = append_user_message(
        state,
        "目标用户是总分6到6.5冲8分的人群，需要根据考试日期、四科分数、每周学习天数、每天投入时间和强弱项自动生成计划，界面专业清晰、偏浅色、支持移动端。",
    )

    should_assume_ready = clarifier._should_assume_ready(
        state=state,
        working_spec=WorkingSpec(
            title="雅思三个月备考规划 Web 应用",
            summary="帮助雅思考生生成12周计划并持续执行复盘。",
            goal="帮助总分6到6.5的考生冲刺8分。",
            targetUsers=["中国雅思考生", "总分6到6.5、目标8分的人群"],
            screens=["基础信息录入", "12周计划总览", "每日任务", "每周复盘", "错题记录", "资料推荐"],
            coreFlows=["录入信息", "生成计划", "执行打卡", "每周复盘", "记录错题"],
            dataModelNeeds=["用户档案", "周计划", "每日任务", "复盘记录", "错题记录"],
        ),
        questions=[
            ClarificationQuestion(question="你希望系统如何分配12周计划和每日任务？"),
            ClarificationQuestion(question="每日任务和复盘具体要记录哪些内容？"),
            ClarificationQuestion(question="资料推荐希望如何组织和推荐？"),
        ],
        missing_information=["计划分配逻辑", "任务粒度", "资料推荐方式"],
    )

    assert should_assume_ready is True


def test_clarifier_raises_when_model_returns_empty_response(monkeypatch) -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(make_state(), "帮我做一个学习应用")

    def fail_invoke(**kwargs):
        raise GenerationFailure("模型返回了空响应，未提供 JSON 结果。")

    monkeypatch.setattr("app.services.clarifier.invoke_structured_json", fail_invoke)
    monkeypatch.setattr(clarifier.provider, "require_chat_model", lambda role, timeout_seconds=None: object())

    with pytest.raises(GenerationFailure, match="模型返回了空响应"):
        clarifier.decide(state)


def test_clarifier_calls_model_for_initial_turn(monkeypatch) -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(make_state(), "帮我做一个学习应用")
    roles: list[str] = []

    def fake_require_chat_model(role: str, timeout_seconds=None):
        roles.append(role)
        return object()

    monkeypatch.setattr(clarifier.provider, "require_chat_model", fake_require_chat_model)
    monkeypatch.setattr(
        "app.services.clarifier.invoke_structured_json",
        lambda **kwargs: StructuredClarifierOutput.model_validate(
            {
                "action": "ask",
                "summary": "开始生成前我想先把需求补准确，还需要你补充几项关键细节。",
                "clarityScore": 0.42,
                "missingInformation": ["目标用户与使用场景", "核心任务与产品目标"],
                "questions": [
                    {
                        "id": "q-1",
                        "question": "这款应用主要给谁用？他们通常会在什么场景下打开它？",
                        "placeholder": "描述用户画像和使用场景",
                    },
                    {
                        "id": "q-2",
                        "question": "你最希望用户来到应用后先完成什么核心任务？",
                        "placeholder": "描述第一优先级任务",
                    },
                ],
                "assumptions": [],
                "workingSpec": {},
            }
        ),
    )

    updated = clarifier.decide(state)

    assert roles == ["clarifier"]
    assert updated.status.value == "clarifying"
    assert updated.clarification_decision is not None
    assert updated.clarification_decision.action == "ask"
    assert len(updated.clarification_decision.questions) == 2


def test_clarifier_calls_model_for_substantive_followup(monkeypatch) -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(
        make_state(),
        "请帮我生成一个面向中国雅思考生的三个月备考规划 Web 应用，需要基础信息录入、12周计划、每日任务、打卡、复盘、错题记录和资料推荐。",
    )
    state.clarification_decision = ClarificationDecision(
        action="ask",
        summary="还需要补充细节。",
        clarityScore=0.45,
        missingInformation=["目标用户与使用场景", "成功标准与边界限制"],
        questions=[
            ClarificationQuestion(id="q-1", question="目标用户更具体是谁？", placeholder="描述人群"),
            ClarificationQuestion(id="q-2", question="你的目标分数和投入节奏是什么？", placeholder="描述目标"),
        ],
        assumptions=[],
    )
    state = append_user_message(
        state,
        "目标用户是总分6到6.5冲8分的人群，计划3个月，每天可以投入3小时，总分目标8分，界面专业清晰、偏浅色、支持移动端。",
    )
    roles: list[str] = []

    def fake_require_chat_model(role: str, timeout_seconds=None):
        roles.append(role)
        return object()

    monkeypatch.setattr(clarifier.provider, "require_chat_model", fake_require_chat_model)
    monkeypatch.setattr(
        "app.services.clarifier.invoke_structured_json",
        lambda **kwargs: StructuredClarifierOutput.model_validate(
            {
                "action": "assume_ready",
                "summary": "现有信息已经足够，我会基于少量明确假设继续推进。",
                "clarityScore": 0.84,
                "missingInformation": ["品牌视觉细节"],
                "questions": [],
                "assumptions": ["首版先使用模拟数据验证核心流程。"],
                "workingSpec": {
                    "title": "雅思三个月备考规划 Web 应用",
                    "goal": "帮助考生生成并执行三个月雅思备考计划。",
                    "targetUsers": ["总分6到6.5、目标8分的中国雅思考生"],
                },
            }
        ),
    )

    updated = clarifier.decide(state)

    assert roles == ["clarifier"]
    assert updated.status.value == "planning"
    assert updated.clarification_decision is not None
    assert updated.clarification_decision.action in {"ready", "assume_ready"}
    assert updated.clarification_decision.questions == []


def test_clarifier_promotes_exceptionally_complete_initial_brief_even_when_model_asks(monkeypatch) -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(
        make_state(),
        "帮我生成一个中文移动优先的上海三天两晚旅行规划 Web 应用，面向两位成年人在节假日出行，住在静安寺附近，节奏偏轻松休闲。"
        "首版必须包含这些页面和流程：首页概览、按天行程页、地点详情页、预算页、收藏清单页；核心流程是浏览三天行程、查看地点详情、按天气切换备选方案、收藏地点、查看预算汇总。"
        "推荐内容先用高质量静态精选数据做原型，不需要接真实接口。数据模型只需要行程日、地点卡片、预算条目和收藏项。"
        "整体视觉做成文艺旅行手帐风，主色偏米白、墨绿和一点暖金，动效保持轻微。预算只统计餐饮、门票和市内交通，不含住宿。"
        "收藏清单只需要浏览器本地保存，不要登录、支付或后台管理。成功标准是用户能在 3 分钟内看完三天路线并完成收藏。"
        "重点区域默认静安、黄浦、徐汇，内容风格实用攻略和氛围种草均衡，每天默认安排 2 个核心景点和 2 个餐饮点，收藏页支持按类型筛选和标记必去。",
    )

    monkeypatch.setattr(clarifier.provider, "require_chat_model", lambda role, timeout_seconds=None: object())
    monkeypatch.setattr(
        "app.services.clarifier.invoke_structured_json",
        lambda **kwargs: StructuredClarifierOutput.model_validate(
            {
                "action": "ask",
                "summary": "开始生成前我还想先确认两点细节。",
                "clarityScore": 0.58,
                "missingInformation": ["品牌风格偏好", "成功标准指标"],
                "questions": [
                    {
                        "id": "q-1",
                        "question": "你希望整体品牌调性更偏文艺手帐还是实用攻略？",
                        "placeholder": "描述风格倾向",
                    },
                    {
                        "id": "q-2",
                        "question": "你更看重收藏完成率还是路线浏览效率？",
                        "placeholder": "描述主要成功标准",
                    },
                ],
                "assumptions": ["首版先使用静态精选数据完成核心体验验证。"],
                "workingSpec": {
                    "title": "上海三天两晚旅行规划 Web 应用",
                    "summary": "帮助节假日出行用户快速浏览三天路线并收藏意向地点。",
                    "goal": "让两位成年人在三分钟内完成路线浏览和收藏决策。",
                    "targetUsers": ["节假日来上海出行的两位成年人"],
                    "screens": ["首页概览", "按天行程页", "地点详情页", "预算页", "收藏清单页"],
                    "coreFlows": ["浏览三天行程", "查看地点详情", "切换天气备选方案", "收藏地点", "查看预算汇总"],
                    "dataModelNeeds": ["行程日", "地点卡片", "预算条目", "收藏项"],
                },
            }
        ),
    )

    updated = clarifier.decide(state)

    assert updated.status.value == "planning"
    assert updated.clarification_decision is not None
    assert updated.clarification_decision.action == "assume_ready"
    assert updated.clarification_decision.questions == []
    assert updated.clarification_decision.missing_information == []
    assert "继续推进规划" in updated.assistant_summary


def test_clarifier_does_not_assume_ready_when_model_returns_empty_response(monkeypatch) -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(make_state(), "帮我做一个AI学习助手")
    state.messages.append(
        state.messages[0].model_copy(
            update={
                "id": "assistant-1",
                "role": ChatRole.ASSISTANT,
                "content": "你希望这个AI学习助手主要给谁用？首版必须包含哪些功能？",
            }
        )
    )
    state = append_user_message(
        state,
        "面向中国高中生，核心是根据教材章节生成每日学习计划、错题整理和复习提醒。必须有首页、今日计划、错题本、学习进度。支持上传题目图片并给出讲解，先用模拟数据，不需要登录。风格希望清晰、现代、偏教育产品。",
    )
    state.working_spec = WorkingSpec(
        title="AI学习助手",
        summary="一个面向学习场景的AI助手产品，帮助用户更高效地完成学习任务，但具体目标用户、核心场景和功能边界仍待明确。",
        goal="通过AI能力提升学习效率与学习效果，具体目标需根据目标用户和学习场景进一步细化。",
    )

    def fail_invoke(**kwargs):
        raise GenerationFailure("模型返回了空响应，未提供 JSON 结果。")

    monkeypatch.setattr("app.services.clarifier.invoke_structured_json", fail_invoke)
    monkeypatch.setattr(clarifier.provider, "require_chat_model", lambda role, timeout_seconds=None: object())

    with pytest.raises(GenerationFailure, match="模型返回了空响应"):
        clarifier.decide(state)
