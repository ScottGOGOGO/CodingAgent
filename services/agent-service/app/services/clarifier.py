from __future__ import annotations

import re
from datetime import datetime
from typing import Dict, Iterable, List, Optional, Union
from uuid import uuid4

from app.models import (
    AgentSessionState,
    ChatMessage,
    ChatRole,
    ClarificationQuestion,
    ProjectStatus,
    RequirementSlots,
    SlotKey,
)

REQUIRED_SLOTS: List[SlotKey] = [
    SlotKey.PRODUCT_GOAL,
    SlotKey.TARGET_USERS,
    SlotKey.CORE_PAGES,
    SlotKey.KEY_INTERACTIONS,
    SlotKey.VISUAL_STYLE,
    SlotKey.EXTERNAL_INTEGRATIONS,
]

SLOT_QUESTIONS: Dict[SlotKey, ClarificationQuestion] = {
    SlotKey.PRODUCT_GOAL: ClarificationQuestion(
        key=SlotKey.PRODUCT_GOAL,
        question="这个 app 最核心要解决什么问题？",
        placeholder="例如：帮助独立创作者管理赞助订单和交付进度",
    ),
    SlotKey.TARGET_USERS: ClarificationQuestion(
        key=SlotKey.TARGET_USERS,
        question="这个 app 主要给谁使用？",
        placeholder="例如：自由职业设计师、小型电商运营、内部财务团队",
    ),
    SlotKey.CORE_PAGES: ClarificationQuestion(
        key=SlotKey.CORE_PAGES,
        question="你最希望包含哪些核心页面或模块？",
        placeholder="例如：首页概览、项目列表、详情页、设置页",
    ),
    SlotKey.KEY_INTERACTIONS: ClarificationQuestion(
        key=SlotKey.KEY_INTERACTIONS,
        question="用户最关键的操作或数据流是什么？",
        placeholder="例如：创建项目、筛选数据、查看指标、导出报表",
    ),
    SlotKey.VISUAL_STYLE: ClarificationQuestion(
        key=SlotKey.VISUAL_STYLE,
        question="界面风格希望偏什么方向？",
        placeholder="例如：极简黑白、暖色 editorial、未来感仪表盘",
    ),
    SlotKey.EXTERNAL_INTEGRATIONS: ClarificationQuestion(
        key=SlotKey.EXTERNAL_INTEGRATIONS,
        question="首版是否需要任何外部集成或后端能力？",
        placeholder="例如：不需要、只要本地假数据、接 Stripe 或 Supabase",
    ),
}

STYLE_KEYWORDS = ("minimal", "极简", "黑白", "warm", "未来", "editorial", "dashboard", "dark")
PAGE_KEYWORDS = ("page", "dashboard", "首页", "列表", "详情", "设置", "workspace")
INTEGRATION_KEYWORDS = ("stripe", "supabase", "auth", "api", "数据库", "payment", "支付", "登录")


def _message(role: ChatRole, content: str) -> ChatMessage:
    return ChatMessage(id=str(uuid4()), role=role, content=content, createdAt=datetime.utcnow().isoformat())


def _slot_value(slots: RequirementSlots, key: SlotKey) -> Optional[str]:
    return getattr(slots, key.value)


def _set_slot(slots: RequirementSlots, key: SlotKey, value: str) -> None:
    if value and not _slot_value(slots, key):
        setattr(slots, key.value, value.strip())


def infer_slots_from_text(slots: RequirementSlots, text: str) -> RequirementSlots:
    normalized = text.strip()
    if not normalized:
        return slots

    _set_slot(slots, SlotKey.PRODUCT_GOAL, normalized)

    if not slots.target_users:
        audience_match = re.search(r"(?:for|给|面向)([^,.，。]+)", normalized, flags=re.IGNORECASE)
        if audience_match:
            _set_slot(slots, SlotKey.TARGET_USERS, audience_match.group(1).strip())

    if not slots.visual_style and any(keyword.lower() in normalized.lower() for keyword in STYLE_KEYWORDS):
        _set_slot(slots, SlotKey.VISUAL_STYLE, normalized)

    if not slots.core_pages and any(keyword.lower() in normalized.lower() for keyword in PAGE_KEYWORDS):
        _set_slot(slots, SlotKey.CORE_PAGES, normalized)

    if not slots.external_integrations and any(keyword.lower() in normalized.lower() for keyword in INTEGRATION_KEYWORDS):
        _set_slot(slots, SlotKey.EXTERNAL_INTEGRATIONS, normalized)

    return slots


def apply_clarification_answers(
    slots: RequirementSlots, answers: Dict[Union[SlotKey, str], str]
) -> RequirementSlots:
    for key, value in answers.items():
        if value:
            slot_key = SlotKey(key) if isinstance(key, str) else key
            setattr(slots, slot_key.value, value.strip())
    return slots


def missing_slots(slots: RequirementSlots) -> List[SlotKey]:
    return [key for key in REQUIRED_SLOTS if not _slot_value(slots, key)]


def clarity_score(slots: RequirementSlots) -> float:
    missing = len(missing_slots(slots))
    score = (len(REQUIRED_SLOTS) - missing) / len(REQUIRED_SLOTS)
    return round(score, 2)


def build_clarification_questions(keys: Iterable[SlotKey], max_questions: int = 3) -> List[ClarificationQuestion]:
    questions: List[ClarificationQuestion] = []
    for key in keys:
        questions.append(SLOT_QUESTIONS[key])
        if len(questions) == max_questions:
            break
    return questions


def apply_default_assumptions(state: AgentSessionState) -> AgentSessionState:
    slots = state.requirement_slots
    assumptions: List[str] = []

    defaults = {
        SlotKey.TARGET_USERS: "General web users who need a focused productivity experience.",
        SlotKey.CORE_PAGES: "Landing page, overview dashboard, and a detail section for primary actions.",
        SlotKey.KEY_INTERACTIONS: "Browse highlights, filter content, and trigger one primary call to action.",
        SlotKey.VISUAL_STYLE: "A confident modern editorial UI with clear hierarchy and subtle motion.",
        SlotKey.EXTERNAL_INTEGRATIONS: "No external integrations for v1; use local demo data only.",
    }

    for key, default_value in defaults.items():
        if not getattr(slots, key.value):
            setattr(slots, key.value, default_value)
            assumptions.append(f"Assumed {key.value.replace('_', ' ')}: {default_value}")

    state.assumptions.extend(assumptions)
    return state


def append_user_message(state: AgentSessionState, content: str) -> AgentSessionState:
    state.messages.append(_message(ChatRole.USER, content))
    state.requirement_slots = infer_slots_from_text(state.requirement_slots, content)
    return state


def append_assistant_message(state: AgentSessionState, content: str) -> AgentSessionState:
    state.messages.append(_message(ChatRole.ASSISTANT, content))
    return state


def next_clarification_state(state: AgentSessionState) -> AgentSessionState:
    state.missing_slots = missing_slots(state.requirement_slots)
    state.clarity_score = clarity_score(state.requirement_slots)

    if not state.missing_slots:
        state.status = ProjectStatus.PLANNING
        state.clarification_questions = []
        return state

    if state.clarification_rounds >= 3:
        state = apply_default_assumptions(state)
        state.missing_slots = missing_slots(state.requirement_slots)
        state.clarity_score = clarity_score(state.requirement_slots)
        state.clarification_questions = []
        state.status = ProjectStatus.PLANNING
        return state

    questions = build_clarification_questions(state.missing_slots)
    state.clarification_questions = questions
    state.clarification_rounds += 1
    state.status = ProjectStatus.CLARIFYING
    return state
