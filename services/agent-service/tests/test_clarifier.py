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


def test_clarifier_normalizes_nonstandard_action_and_missing_summary() -> None:
    clarifier = DynamicClarifier()
    state = make_state()
    state = append_user_message(state, "帮我做一个，上海1天旅游攻略")

    action = clarifier._normalize_action("questions", [], ["budget"])
    summary = clarifier._normalize_summary(state, None, action, [], ["budget"])
    questions = clarifier._normalize_questions([], ["budget"])
    clarity_score = clarifier._normalize_clarity_score(None, action, questions)

    assert action == "ask"
    assert "budget" in summary
    assert questions[0].question.startswith("你可以再补充一些关于")
    assert clarity_score == 0.45


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


def test_clarifier_backfills_two_high_value_questions_for_initial_turn() -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(make_state(), "帮我做一个学习应用")

    questions = clarifier._ensure_question_budget(
        state,
        WorkingSpec(),
        questions=[],
        missing_information=["目标用户与使用场景"],
        minimum=2,
        maximum=4,
    )

    assert len(questions) >= 2
    assert any("主要给谁用" in question.question for question in questions)
    assert any("核心任务" in question.question or "首版必须包含哪些功能" in question.question for question in questions)


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


def test_clarifier_falls_back_to_default_questions_when_model_returns_empty_response(monkeypatch) -> None:
    clarifier = DynamicClarifier()
    state = append_user_message(make_state(), "帮我做一个学习应用")

    def fail_invoke(**kwargs):
        raise GenerationFailure("模型返回了空响应，未提供 JSON 结果。")

    monkeypatch.setattr("app.services.clarifier.invoke_structured_json", fail_invoke)

    result = clarifier.decide(state)

    assert result.status == "clarifying"
    assert result.clarification_decision is not None
    assert result.clarification_decision.action == "ask"
    assert len(result.clarification_decision.questions) >= 2


def test_clarifier_falls_back_to_assume_ready_for_rich_followup_when_model_returns_empty_response(monkeypatch) -> None:
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

    result = clarifier.decide(state)

    assert result.status == "planning"
    assert result.clarification_decision is not None
    assert result.clarification_decision.action == "assume_ready"
    assert result.working_spec.target_users == ["中国高中生"]
    assert [screen.name for screen in result.working_spec.screens][:4] == ["首页", "今日计划", "错题本", "学习进度"]
