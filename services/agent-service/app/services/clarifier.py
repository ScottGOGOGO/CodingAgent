from __future__ import annotations

from datetime import datetime
from json import dumps
import logging
import re
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
    ScreenSpec,
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
logger = logging.getLogger(__name__)


def _should_use_heuristic_fallback(error: Exception) -> bool:
    message = str(error)
    markers = (
        "模型返回了空响应",
        "结构化输出失败",
        "原始 JSON 回退失败",
        "Connection error",
        "Invalid json output",
    )
    return any(marker in message for marker in markers)


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
            model = self.provider.require_chat_model("clarifier")
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
            )
        except GenerationFailure as exc:
            if not _should_use_heuristic_fallback(exc):
                raise
            logger.warning("clarifier structured output failed, using heuristic fallback: %s", exc)
            return self._fallback_decide(state)
        except Exception as exc:
            raise GenerationFailure(f"澄清模型在完善需求时失败：{exc}") from exc

        merged_working_spec = _merge_working_spec(state.working_spec, result.working_spec)
        action = self._normalize_action(result.action, result.questions, result.missing_information)
        missing_information = _normalize_string_list(result.missing_information)
        assumptions = _normalize_string_list(result.assumptions)
        questions = self._normalize_questions(result.questions, missing_information)

        if self._should_force_initial_clarification(state, merged_working_spec):
            action = "ask"
        elif action == "ask" and self._should_assume_ready(state, merged_working_spec, questions, missing_information):
            action = "assume_ready"
            questions = []
            missing_information = []

        question_limit = 4 if is_initial_request and action == "ask" else 3
        missing_information = self._ensure_missing_information(state, merged_working_spec, missing_information, question_limit)
        minimum_questions = 2 if is_initial_request and action == "ask" else 1
        questions = self._ensure_question_budget(state, merged_working_spec, questions, missing_information, minimum_questions, question_limit)
        summary = self._normalize_summary(state, result.summary, action, questions, missing_information)
        clarity_score = self._normalize_clarity_score(result.clarity_score, action, questions)

        state.working_spec = merged_working_spec
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

    def _fallback_decide(self, state: AgentSessionState) -> AgentSessionState:
        is_initial_request = self._is_initial_request(state)
        working_spec = self._hydrate_working_spec_from_messages(state, state.working_spec)
        action = "ask"
        missing_information: List[str] = []
        questions: List[ClarificationQuestion] = []

        if not is_initial_request and self._should_progress_without_model(state, working_spec):
            action = "assume_ready"
        else:
            question_limit = 4 if is_initial_request else 3
            missing_information = self._ensure_missing_information(state, working_spec, [], question_limit)
            minimum_questions = 2 if is_initial_request else 1
            questions = self._ensure_question_budget(state, working_spec, [], missing_information, minimum_questions, question_limit)

        assumptions = _dedupe(state.assumptions + working_spec.assumptions)
        if action == "assume_ready":
            assumptions = _dedupe(assumptions + ["其余未明确细节将按常见产品模式做保守假设。"])

        summary = self._normalize_summary(state, None, action, questions, missing_information)
        clarity_score = self._normalize_clarity_score(None, action, questions)

        state.working_spec = working_spec
        state.assumptions = assumptions
        state.clarification_decision = ClarificationDecision(
            action=action,
            summary=summary,
            clarityScore=clarity_score,
            missingInformation=missing_information,
            questions=questions,
            assumptions=assumptions,
        )
        state.assistant_summary = summary

        if action == "ask":
            state.status = ProjectStatus.CLARIFYING
            questions_text = "\n".join(f"{index + 1}. {item.question}" for index, item in enumerate(questions))
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
                return f"开始生成前我想先把需求补准确，尤其还需要确认 {', '.join(_normalize_string_list(missing_information)[:2])} 这些关键信息。"
            if questions:
                return "开始生成前我想先把需求补准确，还需要你补充几项关键细节。"
            return "开始生成前我想先把需求补准确，还需要你补充几项关键细节。"

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
        for index, item in enumerate(questions[:4]):
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

        for index, item in enumerate(missing_information[:4]):
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

    def _ensure_missing_information(
        self,
        state: AgentSessionState,
        working_spec: WorkingSpec,
        missing_information: List[str],
        limit: int,
    ) -> List[str]:
        topics = _dedupe(missing_information)
        for topic in self._default_missing_topics(state, working_spec):
            if len(topics) >= limit:
                break
            if topic not in topics:
                topics.append(topic)
        return topics[:limit]

    def _ensure_question_budget(
        self,
        state: AgentSessionState,
        working_spec: WorkingSpec,
        questions: List[ClarificationQuestion],
        missing_information: List[str],
        minimum: int,
        maximum: int,
    ) -> List[ClarificationQuestion]:
        normalized = list(questions[:maximum])
        existing_texts = {item.question.strip() for item in normalized}

        for topic in missing_information:
            if len(normalized) >= maximum:
                break
            candidate = self._question_for_topic(topic, len(normalized))
            if candidate.question.strip() in existing_texts:
                continue
            existing_texts.add(candidate.question.strip())
            normalized.append(candidate)

        for topic in self._default_missing_topics(state, working_spec):
            if len(normalized) >= maximum or len(normalized) >= minimum:
                break
            candidate = self._question_for_topic(topic, len(normalized))
            if candidate.question.strip() in existing_texts:
                continue
            existing_texts.add(candidate.question.strip())
            normalized.append(candidate)

        return normalized[:maximum]

    @staticmethod
    def _question_for_topic(topic: str, index: int) -> ClarificationQuestion:
        lowered = topic.strip().lower()
        if "目标用户" in topic or "用户" in topic:
            return ClarificationQuestion(
                id=f"q-{index + 1}",
                question="这款应用主要给谁用？他们通常会在什么场景下打开它？",
                placeholder="比如年龄、身份、熟练度、使用场景或动机",
            )
        if "核心任务" in topic or "产品目标" in topic or "用途" in topic or "goal" in lowered:
            return ClarificationQuestion(
                id=f"q-{index + 1}",
                question="你最希望用户来到应用后先完成什么核心任务？",
                placeholder="描述第一优先级的使用目标或关键结果",
            )
        if "功能" in topic or "流程" in topic or "页面" in topic:
            return ClarificationQuestion(
                id=f"q-{index + 1}",
                question="首版必须包含哪些功能或页面？哪些可以暂时不做？",
                placeholder="按必须有、最好有、可以后续再做来补充也可以",
            )
        if "成功标准" in topic or "边界" in topic or "限制" in topic or "约束" in topic:
            return ClarificationQuestion(
                id=f"q-{index + 1}",
                question="你怎么判断这次结果算成功？有没有必须遵守的边界或限制？",
                placeholder="比如内容范围、品牌要求、技术限制、不能出现的元素等",
            )
        return ClarificationQuestion(
            id=f"q-{index + 1}",
            question=f"你可以再补充一些关于“{topic}”的细节吗？",
            placeholder=f"请说明你对“{topic}”的偏好、限制或特殊要求",
        )

    def _default_missing_topics(self, state: AgentSessionState, working_spec: WorkingSpec) -> List[str]:
        topics: List[str] = []
        latest_user = self._latest_user_message(state)
        if not working_spec.target_users and not any(token in latest_user for token in ("用户", "面向", "适合", "给")):
            topics.append("目标用户与使用场景")
        if not working_spec.goal and not working_spec.summary:
            topics.append("核心任务与产品目标")
        if not working_spec.screens and not working_spec.core_flows and not any(
            token in latest_user for token in ("首页", "页面", "模块", "功能", "支持", "必须有", "包含")
        ):
            topics.append("必须功能与关键流程")
        if not working_spec.success_criteria:
            topics.append("成功标准与边界限制")
        if not topics:
            topics.extend(["目标用户与使用场景", "必须功能与关键流程"])
        return _dedupe(topics)

    def _should_force_initial_clarification(self, state: AgentSessionState, working_spec: WorkingSpec) -> bool:
        return self._is_initial_request(state) and not self._is_exceptionally_complete_brief(state, working_spec)

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
            if user_turns < 3 or not all(self._looks_assumable_followup_gap(topic) for topic in all_topics):
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

        if user_turns >= 3:
            richness_score += 1

        return richness_score >= 4

    def _latest_user_message(self, state: AgentSessionState) -> str:
        for message in reversed(state.messages):
            if message.role == ChatRole.USER:
                return message.content.strip()
        return ""

    @staticmethod
    def _user_message_count(state: AgentSessionState) -> int:
        return sum(1 for message in state.messages if message.role == ChatRole.USER)

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

    def _should_progress_without_model(self, state: AgentSessionState, working_spec: WorkingSpec) -> bool:
        latest_user = self._latest_user_message(state)
        if not latest_user:
            return False

        richness_score = 0
        if len(latest_user) >= 80:
            richness_score += 1
        if working_spec.target_users or any(token in latest_user for token in ("面向", "适合", "给")):
            richness_score += 1
        if working_spec.goal or working_spec.summary or any(token in latest_user for token in ("核心", "功能", "支持", "必须有")):
            richness_score += 1
        if working_spec.screens or working_spec.core_flows or any(token in latest_user for token in ("首页", "页面", "模块", "错题", "计划", "进度")):
            richness_score += 1
        if working_spec.constraints or working_spec.brand_and_visual_direction or any(
            token in latest_user for token in ("不需要", "不要", "限制", "边界", "先用", "模拟数据", "风格")
        ):
            richness_score += 1
        if self._user_message_count(state) >= 2:
            richness_score += 1
        return richness_score >= 4

    def _hydrate_working_spec_from_messages(self, state: AgentSessionState, current: WorkingSpec) -> WorkingSpec:
        latest_user = self._latest_user_message(state)
        merged = current.model_copy(deep=True)
        if not latest_user:
            return merged

        if not merged.title:
            merged.title = self._infer_title(latest_user)
        if not merged.target_users:
            target_user = self._extract_target_user(latest_user)
            if target_user:
                merged.target_users = [target_user]
        if not merged.goal:
            goal = self._extract_goal(latest_user)
            if goal:
                merged.goal = goal
        if not merged.summary:
            merged.summary = self._build_summary(latest_user, merged)
        if not merged.screens:
            merged.screens = [ScreenSpec(name=name, purpose=f"承载{name}相关的核心学习任务和信息。") for name in self._extract_screen_names(latest_user)]
        if not merged.constraints:
            merged.constraints = self._extract_constraints(latest_user)
        if not merged.brand_and_visual_direction:
            visual_direction = self._extract_visual_direction(latest_user)
            if visual_direction:
                merged.brand_and_visual_direction = visual_direction
        return merged

    @staticmethod
    def _infer_title(text: str) -> str:
        if "学习助手" in text:
            return "AI学习助手"
        if "应用" in text:
            return "生成的应用"
        return (text.strip()[:16] or "生成的应用").rstrip("，。；;")

    @staticmethod
    def _extract_target_user(text: str) -> Optional[str]:
        patterns = (
            r"面向([^，。；\n]+)",
            r"适合([^，。；\n]+)",
            r"给([^，。；\n]+)用",
        )
        for pattern in patterns:
            match = re.search(pattern, text)
            if match:
                candidate = match.group(1).strip("：: ，,。；;")
                if candidate:
                    return candidate
        return None

    @staticmethod
    def _extract_goal(text: str) -> Optional[str]:
        patterns = (
            r"核心是([^。；\n]+)",
            r"核心要([^。；\n]+)",
            r"主要是([^。；\n]+)",
        )
        for pattern in patterns:
            match = re.search(pattern, text)
            if match:
                candidate = match.group(1).strip("：: ，,。；;")
                if candidate:
                    return candidate
        return None

    @staticmethod
    def _build_summary(text: str, working_spec: WorkingSpec) -> str:
        target = working_spec.target_users[0] if working_spec.target_users else "目标用户"
        goal = working_spec.goal or "核心学习任务"
        return f"一个面向{target}的学习产品，重点帮助用户完成{goal}。"

    @staticmethod
    def _extract_screen_names(text: str) -> List[str]:
        patterns = (
            r"(?:必须有|需要有|包含|包括)([^。；\n]+)",
            r"(?:首页、?)([^。；\n]+)",
        )
        candidates: List[str] = []
        for pattern in patterns:
            match = re.search(pattern, text)
            if not match:
                continue
            chunk = match.group(1)
            parts = re.split(r"[、,，和及/]", chunk)
            candidates.extend(part.strip("：:  ") for part in parts)
            if candidates:
                break

        normalized = []
        for item in candidates:
            if not item:
                continue
            if len(item) > 18:
                continue
            normalized.append(item)
        if "首页" in text and "首页" not in normalized:
            normalized.insert(0, "首页")
        return _dedupe(normalized[:6])

    @staticmethod
    def _extract_constraints(text: str) -> List[str]:
        constraints: List[str] = []
        for snippet in ("先用模拟数据", "不需要登录", "不做登录", "无需登录", "先做网页端", "仅做网页端"):
            if snippet in text:
                constraints.append(snippet)
        return _dedupe(constraints)

    @staticmethod
    def _extract_visual_direction(text: str) -> Optional[str]:
        patterns = (
            r"风格希望([^。；\n]+)",
            r"风格是([^。；\n]+)",
            r"视觉上([^。；\n]+)",
        )
        for pattern in patterns:
            match = re.search(pattern, text)
            if match:
                candidate = match.group(1).strip("：: ，,。；;")
                if candidate:
                    return candidate
        return None
