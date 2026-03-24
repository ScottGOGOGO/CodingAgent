from app.models import AgentSessionState, ClarificationAnswer, ClarificationDecision, ClarificationQuestion, ReasoningMode
from app.services.clarifier import DynamicClarifier, append_user_message, apply_clarification_answers
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
    assert questions[0].question.startswith("Could you share a bit more detail")
    assert clarity_score == 0.45
