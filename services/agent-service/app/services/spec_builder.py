from __future__ import annotations

import logging
import re
from json import dumps
from typing import List

from langchain_core.prompts import ChatPromptTemplate

from app.models import (
    AgentSessionState,
    AppSpec,
    DataModelNeed,
    DesignTargets,
    FlowSpec,
    PlanStep,
    ScreenSpec,
    StructuredPlanOutput,
    StructuredSpecOutput,
)
from app.services.errors import GenerationFailure
from app.services.model_provider import ModelProvider
from app.services.structured_output import invoke_structured_json


USER_FACING_LANGUAGE_RULE = (
    "除非用户明确要求其他语言，所有面向用户的自然语言字段都必须使用简体中文，"
    "保留 JSON key、文件路径和代码标识符的必要格式。"
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

DESIGN_PROFILES = {
    "sports": {
        "visualMood": "高能、进取、带有运动品牌海报感",
        "layoutEnergy": "首屏要有强冲击力，版面节奏偏纵向叙事并突出关键训练动作",
        "colorStrategy": "使用高对比主色与大面积深色底，辅以醒目荧光强调训练状态和 CTA",
        "componentTone": "组件要利落、紧凑，数据卡片和训练模块带一点竞技仪表感",
        "motionIntensity": "中到偏高，重点强化切换、悬停和关键指标反馈",
        "interactionFocus": ["训练路径引导", "进度反馈强化", "关键动作卡片的交互聚焦"],
    },
    "education": {
        "visualMood": "专业、启发式、面向成长型用户的学习产品气质",
        "layoutEnergy": "通过清晰的首屏引导和层次分明的内容区块，降低理解门槛",
        "colorStrategy": "主色偏理性蓝绿系，辅以明亮高光色强调学习进度和重点模块",
        "componentTone": "组件应兼顾可信度与亲和力，卡片和面板有明显层次但不过度装饰",
        "motionIntensity": "低到中，重点用于反馈、状态切换和内容揭示",
        "interactionFocus": ["学习主路径引导", "阶段进度反馈", "课程与练习模块的聚焦切换"],
    },
    "community": {
        "visualMood": "开放、热闹、具有人际互动氛围的内容社区感",
        "layoutEnergy": "采用高密度但有呼吸感的信息流布局，并突出互动区与创作入口",
        "colorStrategy": "在中性色底上加入鲜明品牌色点缀，保证内容层级和互动提示足够清晰",
        "componentTone": "组件更偏内容卡片和互动模块，强调头像、标签和状态反馈",
        "motionIntensity": "中等，重点用于内容切换、评论互动和悬停反馈",
        "interactionFocus": ["内容流浏览节奏", "创作与发布入口", "评论点赞等互动反馈"],
    },
    "commerce": {
        "visualMood": "精致、可信、兼顾转化效率的品牌化零售气质",
        "layoutEnergy": "采用强视觉橱窗和清晰的转化路径，重要 CTA 必须显眼",
        "colorStrategy": "以克制的中性色为底，搭配一到两个高识别品牌色塑造商品聚焦区",
        "componentTone": "组件更偏商品陈列、筛选和购买辅助，细节需有高级感",
        "motionIntensity": "低到中，重点用于商品切换、悬停和购买反馈",
        "interactionFocus": ["首屏商品聚焦", "筛选与比较反馈", "转化路径的连续引导"],
    },
    "travel": {
        "visualMood": "沉浸、编辑感、具备目的地氛围和故事性的旅行杂志风",
        "layoutEnergy": "强调首屏场景感和内容层层展开的阅读节奏",
        "colorStrategy": "用有氛围感的渐变和图片底色，搭配干净文字层级和局部高亮",
        "componentTone": "组件偏编辑式信息卡和时间线，整体更轻盈有呼吸感",
        "motionIntensity": "低到中，突出滚动节奏和卡片浮层反馈",
        "interactionFocus": ["首屏目的地氛围", "行程节奏展示", "内容卡片与地图信息切换"],
    },
    "productivity": {
        "visualMood": "克制、精密、具备现代 SaaS 质感的专业产品风格",
        "layoutEnergy": "强调信息分区、工具效率和主任务聚焦，避免页面松散",
        "colorStrategy": "以中性深浅层次为主，配合少量品牌强调色提升专业感",
        "componentTone": "组件偏面板、表格、数据卡和操作条，要求整齐且有细节",
        "motionIntensity": "低到中，重点用于状态过渡和数据反馈",
        "interactionFocus": ["主任务流聚焦", "数据反馈清晰化", "复杂操作的渐进式引导"],
    },
    "generic": {
        "visualMood": "现代、清晰、具备品牌识别度的产品设计气质",
        "layoutEnergy": "通过强首屏与分层 section 建立清晰的阅读和操作路径",
        "colorStrategy": "建立明确主题色、背景层次和强调色，避免单一白底卡片堆叠",
        "componentTone": "组件需要统一、有层次，并在细节上体现成体系的视觉语言",
        "motionIntensity": "中等，重点用于首屏进入、区块切换和悬停反馈",
        "interactionFocus": ["首屏主任务引导", "核心内容层级组织", "CTA 与状态反馈增强"],
    },
}


def slugify(value: str, fallback: str = "generated-app") -> str:
    lowered = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    return lowered.strip("-") or fallback


class SpecBuilder:
    def __init__(self) -> None:
        self.provider = ModelProvider()

    def build_spec(self, state: AgentSessionState) -> AppSpec:
        working_spec = state.working_spec
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You normalize a hierarchical product brief into an implementation-ready React + Vite web app spec. "
                    "Preserve the user's intent, make missing details explicit as assumptions, and return valid JSON only. "
                    f"{USER_FACING_LANGUAGE_RULE}",
                ),
                (
                    "human",
                    "Conversation:\n{messages}\n\n"
                    "Working spec:\n{working_spec}\n\n"
                    "Known assumptions:\n{assumptions}\n\n"
                    "Return a JSON object with keys: title, summary, goal, targetUsers, screens, coreFlows, "
                    "dataModelNeeds, integrations, brandAndVisualDirection, constraints, successCriteria, assumptions.\n"
                    "All natural-language values in the JSON must be in Simplified Chinese.\n"
                    'For screens, every item must be an object like {{"name": "首页", "purpose": "说明该页面的核心作用", "elements": ["按钮", "卡片"]}}. Do not return bare strings.\n'
                    'For coreFlows, every item must be an object like {{"name": "注册流程", "steps": ["填写资料", "确认目标"], "success": "用户成功完成注册"}}. Do not return bare strings.\n'
                    'For targetUsers, constraints, successCriteria, and assumptions, always return arrays of strings.\n'
                    "For dataModelNeeds.fields, return an array of strings, not objects. "
                    'Example: ["title (string)", "skillLevel (enum)"].',
                ),
            ]
        )
        try:
            result = self._invoke_structured(
                role="planner",
                output_schema=StructuredSpecOutput,
                prompt=prompt,
                payload={
                    "messages": dumps([message.model_dump(mode="json", by_alias=True) for message in state.messages], ensure_ascii=False),
                    "working_spec": dumps(state.working_spec.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                    "assumptions": "\n".join(state.assumptions) or "无",
                },
            )
            return self._build_app_spec_from_structured_result(state, result)
        except GenerationFailure as exc:
            if not _should_use_heuristic_fallback(exc):
                raise
            logger.warning("spec builder structured output failed, using heuristic fallback: %s", exc)
            return self._build_fallback_spec(state)

    def build_plan(self, spec: AppSpec) -> List[PlanStep]:
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You write short execution plans for a commercial coding agent. "
                    "Return valid JSON only with keys: steps and summary. "
                    "Unless the user explicitly requests another language, all step text and summary text must be in Simplified Chinese.",
                ),
                (
                    "human",
                    "Create 5 concise implementation steps for this spec:\n{spec}",
                ),
            ]
        )
        try:
            result = self._invoke_structured(
                role="planner",
                output_schema=StructuredPlanOutput,
                prompt=prompt,
                payload={"spec": dumps(spec.model_dump(mode="json", by_alias=True), ensure_ascii=False)},
            )
            return [
                PlanStep(id=f"step-{index + 1}", title=step, detail=step, status="pending")
                for index, step in enumerate(result.steps[:5])
            ]
        except GenerationFailure as exc:
            if not _should_use_heuristic_fallback(exc):
                raise
            logger.warning("plan builder structured output failed, using heuristic fallback: %s", exc)
            return self._build_fallback_plan(spec)

    def _build_app_spec_from_structured_result(self, state: AgentSessionState, result: StructuredSpecOutput) -> AppSpec:
        working_spec = state.working_spec
        title = self._coalesce_text(result.title, working_spec.title, working_spec.goal, "生成的应用")
        summary = self._coalesce_text(
            result.summary,
            working_spec.summary,
            result.goal,
            working_spec.goal,
            "根据最新对话整理出的可实施 Web 应用方案。",
        )
        goal = self._coalesce_text(
            result.goal,
            working_spec.goal,
            working_spec.summary,
            state.messages[-1].content if state.messages else None,
            "构建一个符合用户需求、可直接实现的 Web 应用。",
        )
        target_users = self._normalize_string_list(result.target_users or working_spec.target_users)
        screens = self._normalize_screens(result.screens)
        flows = self._normalize_flows(result.core_flows)
        brand_and_visual_direction = self._coalesce_text(
            result.brand_and_visual_direction,
            working_spec.brand_and_visual_direction,
            "简洁现代、可直接落地的界面风格方向。",
        )
        return AppSpec(
            appName=slugify(self._coalesce_text(result.title, working_spec.title, working_spec.goal, "generated-app"), fallback="generated-app"),
            title=title,
            summary=summary,
            goal=goal,
            targetUsers=target_users,
            screens=screens,
            coreFlows=flows,
            dataModelNeeds=self._normalize_data_model_needs(result.data_model_needs),
            integrations=self._normalize_string_list(result.integrations),
            brandAndVisualDirection=brand_and_visual_direction,
            designTargets=self._derive_design_targets(
                title=title,
                summary=summary,
                goal=goal,
                target_users=target_users,
                screens=screens,
                flows=flows,
                brand_and_visual_direction=brand_and_visual_direction,
            ),
            constraints=self._normalize_string_list(result.constraints),
            successCriteria=self._normalize_string_list(result.success_criteria),
            assumptions=self._normalize_string_list(result.assumptions),
        )

    def _build_fallback_spec(self, state: AgentSessionState) -> AppSpec:
        working_spec = state.working_spec
        title = self._coalesce_text(working_spec.title, working_spec.goal, "生成的应用")
        summary = self._coalesce_text(
            working_spec.summary,
            working_spec.goal,
            "根据最新对话整理出的可实施 Web 应用方案。",
        )
        goal = self._coalesce_text(
            working_spec.goal,
            working_spec.summary,
            state.messages[-1].content if state.messages else None,
            "构建一个符合用户需求、可直接实现的 Web 应用。",
        )
        target_users = self._normalize_string_list(working_spec.target_users)
        screens = self._normalize_screens(working_spec.screens)
        flows = self._normalize_flows(working_spec.core_flows) or self._fallback_flows_from_screens(screens)
        brand_and_visual_direction = self._coalesce_text(
            working_spec.brand_and_visual_direction,
            "简洁现代、可直接落地的界面风格方向。",
        )
        assumptions = self._normalize_string_list(working_spec.assumptions + ["规格整理阶段使用了本地兜底推断。"])
        return AppSpec(
            appName=slugify(self._coalesce_text(working_spec.title, working_spec.goal, "generated-app"), fallback="generated-app"),
            title=title,
            summary=summary,
            goal=goal,
            targetUsers=target_users,
            screens=screens or self._normalize_screens([ScreenSpec(name="首页"), ScreenSpec(name="核心功能页")]),
            coreFlows=flows,
            dataModelNeeds=self._normalize_data_model_needs(working_spec.data_model_needs),
            integrations=self._normalize_string_list(working_spec.integrations),
            brandAndVisualDirection=brand_and_visual_direction,
            designTargets=self._derive_design_targets(
                title=title,
                summary=summary,
                goal=goal,
                target_users=target_users,
                screens=screens or self._normalize_screens([ScreenSpec(name="首页"), ScreenSpec(name="核心功能页")]),
                flows=flows,
                brand_and_visual_direction=brand_and_visual_direction,
            ),
            constraints=self._normalize_string_list(working_spec.constraints),
            successCriteria=self._normalize_string_list(working_spec.success_criteria) or ["用户可以顺利完成一次核心学习流程"],
            assumptions=assumptions,
        )

    @staticmethod
    def _build_fallback_plan(spec: AppSpec) -> List[PlanStep]:
        screen_names = [screen.name for screen in spec.screens[:3]]
        focus = "、".join(screen_names) if screen_names else "核心页面"
        steps = [
            f"初始化 {spec.title} 的 React + Vite 页面骨架与全局样式基线。",
            f"完成 {focus} 的主界面布局与核心信息分区。",
            "补齐关键交互、示例数据状态和主要组件的可视反馈。",
            "整理路由、状态管理与必要的数据模型展示逻辑。",
            "执行构建校验并修复可见问题，确保可以进入审批与预览。",
        ]
        return [PlanStep(id=f"step-{index + 1}", title=step, detail=step, status="pending") for index, step in enumerate(steps)]

    def _fallback_flows_from_screens(self, screens: List[ScreenSpec]) -> List[FlowSpec]:
        if not screens:
            return []
        first_screen = screens[0].name
        return [
            FlowSpec(
                id="flow-primary",
                name=f"{first_screen}核心流程",
                steps=[f"进入{first_screen}", "浏览关键内容", "完成主要操作"],
                success="用户可以顺利完成一次核心任务。",
            )
        ]

    def _invoke_structured(self, role: str, output_schema, prompt: ChatPromptTemplate, payload: dict):
        try:
            model = self.provider.require_chat_model(role)  # type: ignore[arg-type]
            messages = prompt.format_messages(**payload)
            repair_focus = (
                "重点修正 screens、coreFlows、dataModelNeeds 的对象结构，"
                "并确保 targetUsers、constraints、successCriteria、assumptions 返回字符串数组。"
            )
            return invoke_structured_json(
                model=model,
                messages=messages,
                output_schema=output_schema,
                repair_focus=repair_focus,
            )
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise
            raise GenerationFailure(f"规划模型在整理应用规格时失败：{exc}") from exc

    @staticmethod
    def _normalize_string_list(items) -> List[str]:
        if items is None:
            return []
        if not isinstance(items, list):
            items = [items]

        normalized: List[str] = []
        for item in items:
            if isinstance(item, dict):
                name = item.get("name") or item.get("title") or item.get("label")
                detail = item.get("description") or item.get("summary") or item.get("purpose")
                if name and detail:
                    normalized.append(f"{name}: {detail}")
                elif name:
                    normalized.append(str(name).strip())
                elif detail:
                    normalized.append(str(detail).strip())
                else:
                    text = SpecBuilder._stringify_value(item)
                    if text:
                        normalized.append(text)
            else:
                text = SpecBuilder._stringify_value(item)
                if text:
                    normalized.append(text)

        return [item for item in normalized if item]

    @staticmethod
    def _coalesce_text(*values: object) -> str:
        for value in values:
            text = SpecBuilder._stringify_value(value)
            if text:
                return text
        return ""

    @staticmethod
    def _stringify_value(value: object) -> str:
        if value is None:
            return ""
        if isinstance(value, dict):
            parts = []
            for key, item in value.items():
                text = SpecBuilder._stringify_value(item)
                if text:
                    parts.append(f"{key}: {text}")
            return "; ".join(parts).strip()
        if isinstance(value, list):
            parts = [SpecBuilder._stringify_value(item) for item in value]
            return ", ".join([part for part in parts if part]).strip()
        return str(value).strip()

    def _normalize_screens(self, screens: List[ScreenSpec]) -> List[ScreenSpec]:
        normalized: List[ScreenSpec] = []
        for index, screen in enumerate(screens or []):
            name = self._coalesce_text(screen.name, screen.id, f"页面 {index + 1}")
            screen_id = slugify(self._coalesce_text(screen.id, name, f"screen-{index + 1}"), fallback=f"screen-{index + 1}")
            purpose = self._coalesce_text(
                screen.purpose,
                f"用于支撑{name}的核心使用体验。",
            )
            elements = screen.elements if isinstance(screen.elements, list) else [screen.elements]
            normalized.append(
                ScreenSpec(
                    id=screen_id,
                    name=name,
                    purpose=purpose,
                    elements=[item for item in elements if item is not None],
                )
            )
        return normalized

    def _normalize_flows(self, flows: List[FlowSpec]) -> List[FlowSpec]:
        normalized: List[FlowSpec] = []
        for index, flow in enumerate(flows or []):
            name = self._coalesce_text(flow.name, flow.id, f"流程 {index + 1}")
            flow_id = slugify(self._coalesce_text(flow.id, name, f"flow-{index + 1}"), fallback=f"flow-{index + 1}")
            steps = [str(step).strip() for step in flow.steps if str(step).strip()]
            success = self._coalesce_text(
                flow.success,
                f"用户可以顺利完成{name}。",
            )
            normalized.append(
                FlowSpec(
                    id=flow_id,
                    name=name,
                    steps=steps,
                    success=success,
                )
            )
        return normalized

    def _normalize_data_model_needs(self, items: List[DataModelNeed]) -> List[DataModelNeed]:
        normalized: List[DataModelNeed] = []
        for index, item in enumerate(items or []):
            entity = self._coalesce_text(item.entity, f"实体 {index + 1}")
            fields = [str(field).strip() for field in item.fields if str(field).strip()]
            notes = self._coalesce_text(item.notes)
            normalized.append(
                DataModelNeed(
                    entity=entity,
                    fields=fields,
                    notes=notes or None,
                )
            )
        return normalized

    def _derive_design_targets(
        self,
        title: str,
        summary: str,
        goal: str,
        target_users: List[str],
        screens: List[ScreenSpec],
        flows: List[FlowSpec],
        brand_and_visual_direction: str,
    ) -> DesignTargets:
        fingerprint = " ".join(
            [
                title,
                summary,
                goal,
                brand_and_visual_direction,
                " ".join(target_users),
                " ".join(screen.name for screen in screens),
                " ".join(flow.name for flow in flows),
            ]
        ).lower()

        profile = DESIGN_PROFILES[self._match_design_profile(fingerprint)]
        audience_hint = self._derive_audience_hint(fingerprint, target_users)
        motion_intensity = profile["motionIntensity"]
        if audience_hint and "年轻" in audience_hint and motion_intensity == "低到中":
            motion_intensity = "中等，重点在关键区域加入更鲜明的入场与反馈动效"

        component_tone = profile["componentTone"]
        if audience_hint:
            component_tone = f"{component_tone}，并照顾{audience_hint}的理解与操作节奏"

        interaction_focus = profile["interactionFocus"] + self._derive_interaction_focus(screens, flows, fingerprint)
        deduped_focus = list(dict.fromkeys([item for item in interaction_focus if item]))

        visual_mood = profile["visualMood"]
        if brand_and_visual_direction:
            visual_mood = f"{brand_and_visual_direction}，整体气质保持{profile['visualMood']}"

        layout_energy = profile["layoutEnergy"]
        if len(screens) >= 4 or len(flows) >= 3:
            layout_energy = f"{layout_energy}，同时确保复杂信息在桌面端和移动端都能分层展开。"

        return DesignTargets(
            visualMood=visual_mood,
            layoutEnergy=layout_energy,
            colorStrategy=profile["colorStrategy"],
            componentTone=component_tone,
            motionIntensity=motion_intensity,
            interactionFocus=deduped_focus[:4] or profile["interactionFocus"],
        )

    @staticmethod
    def _match_design_profile(fingerprint: str) -> str:
        keyword_map = [
            ("sports", ("网球", "篮球", "足球", "羽毛球", "健身", "运动", "训练", "workout", "training", "coach")),
            ("education", ("学习", "教育", "课程", "教学", "练习", "lesson", "study", "learning", "academy")),
            ("community", ("社区", "社交", "论坛", "聊天", "动态", "community", "social", "forum", "feed")),
            ("commerce", ("商城", "电商", "商品", "购物", "下单", "shop", "store", "commerce", "checkout")),
            ("travel", ("旅行", "旅游", "行程", "景点", "trip", "travel", "itinerary", "hotel")),
            ("productivity", ("任务", "项目", "效率", "协作", "dashboard", "workspace", "project", "crm", "管理")),
        ]
        for profile, keywords in keyword_map:
            if any(keyword in fingerprint for keyword in keywords):
                return profile
        return "generic"

    @staticmethod
    def _derive_audience_hint(fingerprint: str, target_users: List[str]) -> str:
        audience_text = " ".join(target_users).lower() or fingerprint
        if any(keyword in audience_text for keyword in ("18岁", "大学生", "学生", "年轻", "青年", "teen", "beginner")):
            return "年轻和初学者用户"
        if any(keyword in audience_text for keyword in ("团队", "企业", "运营", "销售", "professional")):
            return "专业场景用户"
        return ""

    @staticmethod
    def _derive_interaction_focus(screens: List[ScreenSpec], flows: List[FlowSpec], fingerprint: str) -> List[str]:
        focus: List[str] = []
        screen_names = " ".join(screen.name for screen in screens)
        flow_names = " ".join(flow.name for flow in flows)
        combined = f"{fingerprint} {screen_names} {flow_names}"

        if any(keyword in combined for keyword in ("注册", "onboard", "登录", "开始", "setup")):
            focus.append("引导式 onboarding 与首个关键动作的即时反馈")
        if any(keyword in combined for keyword in ("进度", "仪表盘", "dashboard", "跟踪", "数据")):
            focus.append("数据卡片、进度条和关键指标的层级强化")
        if any(keyword in combined for keyword in ("社区", "动态", "评论", "交流", "feed")):
            focus.append("社区卡片、评论互动和悬停状态反馈")
        if any(keyword in combined for keyword in ("视频", "课程", "训练", "lesson", "drill")):
            focus.append("内容切换、训练卡片和媒体区域的强主次关系")
        if len(flows) >= 2:
            focus.append("多步骤流程中的当前状态、下一步和完成反馈")

        return focus
