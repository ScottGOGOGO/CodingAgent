from __future__ import annotations

from datetime import datetime
from json import dumps
from typing import Dict, List, Optional
from uuid import uuid4

from langchain_core.prompts import ChatPromptTemplate

from app.models import (
    AgentSessionState,
    ChatMessage,
    ChatRole,
    ClarificationAnswer,
    ClarificationDecision,
    ClarificationQuestion,
    ProjectStatus,
    StructuredClarifierOutput,
    WorkingSpec,
)
from app.services.errors import GenerationFailure
from app.services.json_parser import parse_json_response
from app.services.model_provider import ModelProvider


USER_FACING_LANGUAGE_RULE = (
    "除非用户明确要求其他语言，所有面向用户的自然语言内容都必须使用简体中文。"
    "保留 JSON key 和 action 枚举值原样返回。"
)


def _message(role: ChatRole, content: str) -> ChatMessage:
    return ChatMessage(id=str(uuid4()), role=role, content=content, createdAt=datetime.utcnow().isoformat())


def append_user_message(state: AgentSessionState, content: str) -> AgentSessionState:
    normalized = content.strip()
    if normalized:
        state.messages.append(_message(ChatRole.USER, normalized))
    return state


def append_assistant_message(state: AgentSessionState, content: str) -> AgentSessionState:
    normalized = content.strip()
    if normalized:
        state.messages.append(_message(ChatRole.ASSISTANT, normalized))
    return state


def apply_clarification_answers(
    state: AgentSessionState, answers: List[ClarificationAnswer]
) -> AgentSessionState:
    if not answers:
        return state

    question_lookup: Dict[str, str] = {}
    if state.clarification_decision:
        question_lookup = {item.id: item.question for item in state.clarification_decision.questions}

    lines = ["用户补充说明："]
    for answer in answers:
        normalized = answer.answer.strip()
        if not normalized:
            continue
        question = question_lookup.get(answer.question_id, f"澄清问题 {answer.question_id}")
        lines.append(f"问题：{question}")
        lines.append(f"回答：{normalized}")

    if len(lines) > 1:
        state.messages.append(_message(ChatRole.USER, "\n".join(lines)))
    return state


def _merge_working_spec(current: WorkingSpec, updated: WorkingSpec) -> WorkingSpec:
    merged = current.model_copy(deep=True)

    scalar_fields = ("title", "summary", "goal", "brand_and_visual_direction")
    for field_name in scalar_fields:
        value = getattr(updated, field_name)
        if value:
            setattr(merged, field_name, value)

    list_fields = (
        "target_users",
        "screens",
        "core_flows",
        "data_model_needs",
        "integrations",
        "constraints",
        "success_criteria",
        "assumptions",
    )
    for field_name in list_fields:
        value = getattr(updated, field_name)
        if value:
            setattr(merged, field_name, value)

    return merged


def _dedupe(items: List[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for item in items:
        normalized = item.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def _normalize_string_list(items: List[object]) -> List[str]:
    normalized: List[str] = []
    for item in items or []:
        if isinstance(item, dict):
            value = item.get("name") or item.get("title") or item.get("label") or item.get("summary") or item.get("description")
        else:
            value = item
        if value is None:
            continue
        text = str(value).strip()
        if text:
            normalized.append(text)
    return _dedupe(normalized)


class DynamicClarifier:
    def __init__(self) -> None:
        self.provider = ModelProvider()

    def decide(self, state: AgentSessionState) -> AgentSessionState:
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are the dynamic clarification subgraph for a commercial coding agent. "
                    "Your job is to understand the user's real intent, decide whether more information is needed, "
                    "and update a hierarchical product spec. "
                    "Do not use fixed slots or forms. Ask at most 3 high-leverage open-ended questions. "
                    "If the spec is good enough to plan, return action=ready. "
                    "If a few assumptions are acceptable, return action=assume_ready and list them. "
                    f"{USER_FACING_LANGUAGE_RULE}"
                    "Return valid JSON only.",
                ),
                (
                    "human",
                    "Conversation:\n{messages}\n\n"
                    "Current working spec:\n{working_spec}\n\n"
                    "Existing assumptions:\n{assumptions}\n\n"
                    "Return a JSON object with keys: action, summary, clarityScore, missingInformation, questions, assumptions, workingSpec.\n"
                    "The values for summary, missingInformation, assumptions, questions, placeholders, rationales, and all natural-language fields in workingSpec must be in Simplified Chinese.\n"
                    "workingSpec must include these fields:\n"
                    "- title: string or null\n"
                    "- summary: string or null\n"
                    "- goal: string or null\n"
                    "- targetUsers: string[]\n"
                    "- screens: array of objects with id, name, purpose, elements\n"
                    "- coreFlows: array of objects with id, name, steps, success\n"
                    "- dataModelNeeds: array of objects with entity, fields, notes\n"
                    "  fields must be string[] and not objects. Example: [\"title (string)\", \"level (enum)\"]\n"
                    "- integrations: string[]\n"
                    "- brandAndVisualDirection: string or null\n"
                    "- constraints: string[]\n"
                    "- successCriteria: string[]\n"
                    "- assumptions: string[]\n"
                    "Each question must include id, question, placeholder, and optional rationale.",
                ),
            ]
        )

        try:
            model = self.provider.require_chat_model("clarifier")
            messages = prompt.format_messages(
                messages=dumps([message.model_dump(mode="json", by_alias=True) for message in state.messages], ensure_ascii=False),
                working_spec=dumps(state.working_spec.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                assumptions="\n".join(state.assumptions) or "无",
            )
            try:
                result = model.with_structured_output(
                    StructuredClarifierOutput,
                    method="json_mode",
                ).invoke(messages)
            except Exception:
                response = model.invoke(messages)
                result = parse_json_response(response.content, StructuredClarifierOutput)
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise
            raise GenerationFailure(f"澄清模型在完善需求时失败：{exc}") from exc

        action = self._normalize_action(result.action, result.questions, result.missing_information)
        summary = self._normalize_summary(state, result.summary, action, result.questions, result.missing_information)
        missing_information = _normalize_string_list(result.missing_information)
        assumptions = _normalize_string_list(result.assumptions)
        questions = self._normalize_questions(result.questions, missing_information)
        clarity_score = self._normalize_clarity_score(result.clarity_score, action, questions)

        state.working_spec = _merge_working_spec(state.working_spec, result.working_spec)
        state.assumptions = _dedupe(state.assumptions + assumptions + state.working_spec.assumptions)
        state.clarification_decision = ClarificationDecision(
            action=action,
            summary=summary,
            clarityScore=clarity_score,
            missingInformation=missing_information,
            questions=questions[:3],
            assumptions=assumptions,
        )
        state.assistant_summary = summary

        if action == "ask":
            state.status = ProjectStatus.CLARIFYING
            questions_text = "\n".join(f"{index + 1}. {item.question}" for index, item in enumerate(questions[:3]))
            append_assistant_message(state, f"{summary}\n\n{questions_text}")
            return state

        state.status = ProjectStatus.PLANNING
        append_assistant_message(state, summary)
        return state

    @staticmethod
    def _normalize_action(action: str | None, questions: List[object], missing_information: List[object]) -> str:
        normalized = (action or "").strip().lower().replace("-", "_").replace(" ", "_")
        if normalized in {"ask", "ready", "assume_ready"}:
            return normalized
        if normalized in {"question", "questions", "clarify", "clarifying", "needs_clarification", "need_more_info"}:
            return "ask"
        if normalized in {"plan", "planning", "ready_to_plan", "done", "complete", "completed"}:
            return "ready"
        if normalized in {"assume", "assumed_ready", "assumptions", "assume_ready_to_plan"}:
            return "assume_ready"
        if questions or missing_information:
            return "ask"
        return "assume_ready"

    def _normalize_summary(
        self,
        state: AgentSessionState,
        summary: Optional[str],
        action: str,
        questions: List[object],
        missing_information: List[object],
    ) -> str:
        normalized = (summary or "").strip()
        if normalized:
            return normalized

        if action == "ask":
            if missing_information:
                return f"开始规划前我还需要补充一些信息，尤其是 {', '.join(_normalize_string_list(missing_information)[:2])} 这部分。"
            if questions:
                return "为了更准确地规划应用，我还需要你补充一点信息。"
            return "为了更准确地规划应用，我还需要你补充一点信息。"

        if action == "assume_ready":
            return "现有信息已经足够，我会基于少量明确假设继续推进。"

        latest_request = state.messages[-1].content if state.messages else "当前需求"
        return f"我已经掌握足够信息，可以开始围绕“{latest_request}”进入规划。"

    @staticmethod
    def _normalize_clarity_score(score: Optional[float], action: str, questions: List[object]) -> float:
        if isinstance(score, (int, float)):
            return max(0.0, min(1.0, float(score)))
        if action == "ask" or questions:
            return 0.45
        if action == "assume_ready":
            return 0.72
        return 0.9

    @staticmethod
    def _normalize_questions(questions: List[ClarificationQuestion], missing_information: List[str]) -> List[ClarificationQuestion]:
        normalized: List[ClarificationQuestion] = []
        for index, item in enumerate(questions[:3]):
            question = item.question.strip()
            if not question:
                continue
            normalized.append(
                ClarificationQuestion(
                    id=item.id.strip() or f"q-{index + 1}",
                    question=question,
                    placeholder=item.placeholder.strip() or "补充任何有助于我完善结果的细节",
                    rationale=item.rationale,
                    required=item.required,
                )
            )

        if normalized:
            return normalized

        for index, item in enumerate(missing_information[:3]):
            topic = item.strip()
            if not topic:
                continue
            normalized.append(
                ClarificationQuestion(
                    id=f"q-{index + 1}",
                    question=f"你可以再补充一些关于“{topic}”的细节吗？",
                    placeholder=f"请写下你对“{topic}”的偏好、限制或特殊要求",
                )
            )

        if normalized:
            return normalized

        return [
            ClarificationQuestion(
                id="q-1",
                question="你最希望我生成结果时优先满足什么？",
                placeholder="请告诉我最重要的目标、优先级或限制条件",
            )
        ]
