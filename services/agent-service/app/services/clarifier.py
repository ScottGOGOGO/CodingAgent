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
from app.services.model_provider import ModelProvider
from app.services.structured_output import invoke_structured_json


USER_FACING_LANGUAGE_RULE = (
    "除非用户明确要求其他语言，所有面向用户的自然语言内容都必须使用简体中文。"
    "保留 JSON key 和 action 枚举值原样返回。"
)
CLARIFIER_TIMEOUT_SECONDS = 25.0


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
    NON_BLOCKING_GAP_MARKERS = (
        "品牌",
        "视觉",
        "风格",
        "调性",
        "预算",
        "成功标准",
        "指标",
        "优先级",
        "技术实现",
        "实现方式",
        "题库",
        "内容来源",
        "导入",
        "登录",
        "注册",
        "账号",
        "身份",
        "问答边界",
        "自由问答",
        "边界",
        "限制",
        "使用限制",
        "次数限制",
        "风控",
        "生成逻辑",
        "分配逻辑",
        "任务粒度",
        "如何分配",
        "如何组织",
        "记录哪些内容",
        "记录内容",
        "组织方式",
        "推荐方式",
        "推荐逻辑",
        "推荐内容",
        "资料推荐",
        "口径",
        "验收",
        "指标口径",
        "移动端适配",
        "部署方式",
    )
    CORE_GAP_MARKERS = (
        "目标用户",
        "用户是谁",
        "什么类型的产品",
        "产品类型",
        "基本用途",
        "主要目标",
        "核心功能",
        "关键任务",
        "页面",
        "流程",
        "数据模型",
    )

    def __init__(self) -> None:
        self.provider = ModelProvider()

    def decide(self, state: AgentSessionState) -> AgentSessionState:
        is_initial_request = self._is_initial_request(state)
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are the dynamic clarification subgraph for a commercial coding agent. "
                    "Your job is to understand the user's real intent, decide whether more information is needed, "
                    "and update a hierarchical product spec. "
                    "Do not use fixed slots or forms. "
                    "On the first user turn, default to action=ask and ask 2 to 4 high-leverage open-ended questions that reduce ambiguity around target users, core task, must-have features, and success criteria or boundaries. "
                    "Only return action=ready on the first user turn when the brief is already exceptionally complete. "
                    "After the user has answered follow-up questions, you may return action=ready or action=assume_ready if the remaining gaps are clearly non-blocking. "
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
            model = self.provider.require_chat_model("clarifier", timeout_seconds=CLARIFIER_TIMEOUT_SECONDS)
            messages = prompt.format_messages(
                messages=dumps([message.model_dump(mode="json", by_alias=True) for message in state.messages], ensure_ascii=False),
                working_spec=dumps(state.working_spec.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                assumptions="\n".join(state.assumptions) or "无",
            )
            result = invoke_structured_json(
                model=model,
                messages=messages,
                output_schema=StructuredClarifierOutput,
                repair_focus="重点修正 action、questions、missingInformation、assumptions 和 workingSpec 的 JSON 结构。",
                structured_output_method=self.provider.preferred_structured_output_method("clarifier"),
                timeout_seconds=CLARIFIER_TIMEOUT_SECONDS,
                invocation_name="clarifier",
            )
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise GenerationFailure(f"澄清阶段模型调用失败：{exc}") from exc
            raise GenerationFailure(f"澄清模型在完善需求时失败：{exc}") from exc

        merged_working_spec = _merge_working_spec(state.working_spec, result.working_spec)
        action = self._normalize_action(result.action, result.questions, result.missing_information)
        missing_information = _normalize_string_list(result.missing_information)
        assumptions = _normalize_string_list(result.assumptions)
        questions = self._normalize_questions(result.questions)
        promoted_to_assume_ready = False

        if self._should_force_initial_clarification(state, merged_working_spec):
            action = "ask"
        elif action == "ask" and self._should_continue_initial_rich_brief(
            state, merged_working_spec, questions, missing_information
        ):
            action = "assume_ready"
            questions = []
            missing_information = []
            promoted_to_assume_ready = True
        elif action == "ask" and self._should_assume_ready(state, merged_working_spec, questions, missing_information):
            action = "assume_ready"
            questions = []
            missing_information = []
            promoted_to_assume_ready = True

        question_limit = 4 if is_initial_request and action == "ask" else 3
        missing_information = missing_information[:question_limit]
        questions = questions[:question_limit]
        if action == "ask":
            minimum_questions = 2 if is_initial_request else 1
            if len(questions) < minimum_questions:
                raise GenerationFailure(f"澄清模型未返回足够的问题，当前仅返回 {len(questions)} 个。")
        else:
            questions = []
            missing_information = []
        summary = self._normalize_summary(result.summary)
        if promoted_to_assume_ready:
            summary = self._normalize_assume_ready_summary(summary)
        clarity_score = self._normalize_clarity_score(result.clarity_score, action, questions)

        return self._apply_decision(
            state,
            working_spec=merged_working_spec,
            action=action,
            summary=summary,
            missing_information=missing_information,
            questions=questions,
            assumptions=assumptions,
            clarity_score=clarity_score,
        )

    def _apply_decision(
        self,
        state: AgentSessionState,
        working_spec: WorkingSpec,
        action: str,
        summary: str,
        missing_information: List[str],
        questions: List[ClarificationQuestion],
        assumptions: List[str],
        clarity_score: float,
    ) -> AgentSessionState:
        question_limit = 4 if self._is_initial_request(state) and action == "ask" else 3

        state.working_spec = working_spec
        state.assumptions = _dedupe(state.assumptions + assumptions + state.working_spec.assumptions)
        state.clarification_decision = ClarificationDecision(
            action=action,
            summary=summary,
            clarityScore=clarity_score,
            missingInformation=missing_information,
            questions=questions[:question_limit],
            assumptions=assumptions,
        )
        state.assistant_summary = summary

        if action == "ask":
            state.status = ProjectStatus.CLARIFYING
            questions_text = "\n".join(f"{index + 1}. {item.question}" for index, item in enumerate(questions[:question_limit]))
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

    @staticmethod
    def _normalize_summary(summary: Optional[str]) -> str:
        normalized = (summary or "").strip()
        if normalized:
            return normalized
        raise GenerationFailure("澄清模型未返回 summary。")

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
    def _normalize_assume_ready_summary(summary: str) -> str:
        lowered = summary.strip().lower()
        ask_markers = ("还需要", "请补充", "补充", "确认", "澄清", "问题", "还想了解", "再提供")
        if lowered and not any(marker in lowered for marker in ask_markers):
            return summary
        return "现有信息已经足够，我会基于少量合理假设继续推进规划。"

    @staticmethod
    def _normalize_questions(questions: List[ClarificationQuestion]) -> List[ClarificationQuestion]:
        normalized: List[ClarificationQuestion] = []
        for index, item in enumerate(questions[:4]):
            question = item.question.strip()
            if not question:
                continue
            normalized.append(
                ClarificationQuestion(
                    id=item.id.strip() or f"q-{index + 1}",
                    question=question,
                    placeholder=item.placeholder.strip() or question,
                    rationale=item.rationale,
                    required=item.required,
                )
            )
        return normalized

    def _should_force_initial_clarification(self, state: AgentSessionState, working_spec: WorkingSpec) -> bool:
        return self._is_initial_request(state) and not self._is_exceptionally_complete_brief(state, working_spec)

    def _should_continue_initial_rich_brief(
        self,
        state: AgentSessionState,
        working_spec: WorkingSpec,
        questions: List[ClarificationQuestion],
        missing_information: List[str],
    ) -> bool:
        if not self._is_initial_request(state):
            return False
        if not self._is_exceptionally_complete_brief(state, working_spec):
            return False
        return self._can_continue_without_more_clarification(state, working_spec, questions, missing_information)

    @staticmethod
    def _is_initial_request(state: AgentSessionState) -> bool:
        return sum(1 for message in state.messages if message.role == ChatRole.USER) <= 1

    def _is_exceptionally_complete_brief(self, state: AgentSessionState, working_spec: WorkingSpec) -> bool:
        latest_user = self._latest_user_message(state)
        if not latest_user:
            return False

        richness_score = 0
        if len(latest_user) >= 180:
            richness_score += 1
        if any(token in latest_user for token in ("面向", "用户", "适合", "场景")):
            richness_score += 1
        if any(token in latest_user for token in ("需要", "包含", "支持", "功能", "模块")):
            richness_score += 1
        if any(token in latest_user for token in ("流程", "页面", "首页", "步骤")):
            richness_score += 1
        if any(token in latest_user for token in ("限制", "边界", "成功标准", "指标", "不要")):
            richness_score += 1
        if working_spec.goal or working_spec.summary or working_spec.title:
            richness_score += 1
        if working_spec.target_users:
            richness_score += 1
        if working_spec.screens or working_spec.core_flows or working_spec.data_model_needs:
            richness_score += 1

        return richness_score >= 6

    def _should_assume_ready(
        self,
        state: AgentSessionState,
        working_spec: WorkingSpec,
        questions: List[ClarificationQuestion],
        missing_information: List[str],
    ) -> bool:
        if not questions and not missing_information:
            return False

        all_topics = [item.question for item in questions] + list(missing_information)
        user_turns = self._user_message_count(state)
        if not all(self._looks_non_blocking_gap(topic) for topic in all_topics):
            if user_turns < 2 or not all(self._looks_assumable_followup_gap(topic) for topic in all_topics):
                return False

        latest_user = self._latest_user_message(state)
        if not latest_user:
            return False

        richness_score = 0
        if len(latest_user) >= 40:
            richness_score += 1
        if any(token in latest_user for token in ("需要", "包含", "支持", "功能", "面向", "用户", "应用")):
            richness_score += 1
        if any(token in latest_user for token in ("、", "，", ",", "\n")):
            richness_score += 1
        if working_spec.summary or working_spec.goal or working_spec.title:
            richness_score += 1
        if working_spec.target_users:
            richness_score += 1
        if working_spec.screens or working_spec.core_flows or working_spec.data_model_needs:
            richness_score += 1

        if user_turns >= 2:
            richness_score += 1

        return richness_score >= 4

    def _latest_user_message(self, state: AgentSessionState) -> str:
        for message in reversed(state.messages):
            if message.role == ChatRole.USER:
                return message.content.strip()
        return ""

    @staticmethod
    def _all_user_messages(state: AgentSessionState) -> str:
        return "\n".join(message.content.strip() for message in state.messages if message.role == ChatRole.USER and message.content.strip())

    @staticmethod
    def _user_message_count(state: AgentSessionState) -> int:
        return sum(1 for message in state.messages if message.role == ChatRole.USER)

    def _should_use_local_followup_path(self, state: AgentSessionState, working_spec: WorkingSpec) -> bool:
        if self._user_message_count(state) < 2:
            return False
        latest_user = self._latest_user_message(state)
        if self._looks_substantive_followup(latest_user):
            return True
        return self._has_sufficient_core_context(state, working_spec)

    def _can_continue_without_more_clarification(
        self,
        state: AgentSessionState,
        working_spec: WorkingSpec,
        questions: List[ClarificationQuestion],
        missing_information: List[str],
    ) -> bool:
        if self._should_assume_ready(state, working_spec, questions, missing_information):
            return True
        if not self._looks_substantive_followup(self._latest_user_message(state)):
            return False
        return self._has_sufficient_core_context(state, working_spec)

    @staticmethod
    def _looks_substantive_followup(text: str) -> bool:
        normalized = text.strip()
        if len(normalized) >= 36:
            return True
        if normalized.count("\n") >= 1:
            return True
        if any(marker in normalized for marker in ("1.", "2.", "3.", "①", "②", "③", "；", ";", "、", "，", ",")):
            return True
        return False

    def _has_sufficient_core_context(self, state: AgentSessionState, working_spec: WorkingSpec) -> bool:
        transcript = self._all_user_messages(state)
        score = 0
        if working_spec.target_users or any(token in transcript for token in ("面向", "用户", "人群", "适合", "给")):
            score += 1
        if working_spec.goal or working_spec.summary or any(token in transcript for token in ("目标", "希望", "帮助", "用于", "想要", "生成")):
            score += 1
        if working_spec.screens or working_spec.core_flows or any(
            token in transcript for token in ("功能", "页面", "模块", "支持", "包含", "计划", "打卡", "记录", "生成", "复盘")
        ):
            score += 1
        if len(transcript) >= 80 or self._user_message_count(state) >= 2:
            score += 1
        return score >= 3

    @classmethod
    def _looks_non_blocking_gap(cls, text: str) -> bool:
        lowered = text.strip().lower()
        if not lowered:
            return False
        if any(marker.lower() in lowered for marker in cls.CORE_GAP_MARKERS):
            return False
        return any(marker.lower() in lowered for marker in cls.NON_BLOCKING_GAP_MARKERS)

    @classmethod
    def _looks_assumable_followup_gap(cls, text: str) -> bool:
        return cls._looks_non_blocking_gap(text)
