from __future__ import annotations

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
PLANNER_SPEC_TIMEOUT_SECONDS = 30.0
PLANNER_PLAN_TIMEOUT_SECONDS = 20.0

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
                timeout_seconds=PLANNER_SPEC_TIMEOUT_SECONDS,
                invocation_name="planner_spec",
            )
            return self._build_app_spec_from_structured_result(state, result)
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise GenerationFailure(f"规格整理阶段模型调用失败：{exc}") from exc
            raise GenerationFailure(f"规划模型在整理应用规格时失败：{exc}") from exc

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
                timeout_seconds=PLANNER_PLAN_TIMEOUT_SECONDS,
                invocation_name="planner_plan",
            )
            return [
                PlanStep(id=f"step-{index + 1}", title=step, detail=step, status="pending")
                for index, step in enumerate(result.steps[:5])
            ]
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise GenerationFailure(f"实现计划阶段模型调用失败：{exc}") from exc
            raise GenerationFailure(f"规划模型在生成实现计划时失败：{exc}") from exc

    def _build_spec_locally(self, state: AgentSessionState) -> AppSpec | None:
        if not self._should_use_local_spec_path(state):
            return None

        transcript = self._collect_user_transcript(state)
        working_spec = state.working_spec
        target_users = self._normalize_string_list(working_spec.target_users or self._infer_target_users(transcript))
        raw_screens = working_spec.screens or [ScreenSpec.model_validate(item) for item in self._infer_screens(transcript)]
        raw_flows = working_spec.core_flows or [FlowSpec.model_validate(item) for item in self._infer_flows(transcript)]
        raw_data_model_needs = working_spec.data_model_needs or [
            DataModelNeed.model_validate(item) for item in self._infer_data_model_needs(transcript)
        ]
        screens = self._normalize_screens(raw_screens)
        flows = self._normalize_flows(raw_flows)
        data_model_needs = self._normalize_data_model_needs(raw_data_model_needs)
        constraints = self._normalize_string_list(working_spec.constraints or self._infer_constraints(transcript))
        integrations = self._normalize_string_list(working_spec.integrations or self._infer_integrations(transcript))
        assumptions = self._normalize_string_list(working_spec.assumptions or self._infer_assumptions(transcript, constraints))
        success_criteria = self._normalize_string_list(working_spec.success_criteria or self._infer_success_criteria(transcript))
        title = self._coalesce_text(working_spec.title, self._infer_title(transcript), "生成的应用")
        goal = self._coalesce_text(working_spec.goal, self._infer_goal(transcript), "构建一个符合用户需求、可直接实现的 Web 应用。")
        summary = self._coalesce_text(
            working_spec.summary,
            self._infer_summary(title, target_users, screens, transcript),
            goal,
        )
        brand_and_visual_direction = self._coalesce_text(
            working_spec.brand_and_visual_direction,
            self._infer_visual_direction(transcript),
            "简洁现代、可直接落地的界面风格方向。",
        )

        return AppSpec(
            appName=slugify(title, fallback="generated-app"),
            title=title,
            summary=summary,
            goal=goal,
            targetUsers=target_users,
            screens=screens,
            coreFlows=flows,
            dataModelNeeds=data_model_needs,
            integrations=integrations,
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
            constraints=constraints,
            successCriteria=success_criteria,
            assumptions=assumptions,
        )

    @staticmethod
    def _should_use_local_spec_path(state: AgentSessionState) -> bool:
        user_turns = sum(1 for message in state.messages if message.role.value == "user")
        if user_turns < 2:
            return False
        decision = state.clarification_decision
        return decision is None or decision.action in {"ready", "assume_ready"}

    @staticmethod
    def _collect_user_transcript(state: AgentSessionState) -> str:
        return "\n".join(message.content.strip() for message in state.messages if message.role.value == "user" and message.content.strip())

    @staticmethod
    def _infer_title(transcript: str) -> str:
        match = re.search(r"(面向.+?的)(.+?)(Web|网页|应用|助手|平台)", transcript)
        if match:
            return f"{match.group(2).strip()}{match.group(3).strip()}"
        for keyword in ("应用", "助手", "平台", "规划"):
            if keyword in transcript:
                snippet = transcript.split("。", 1)[0].strip()
                return snippet[:24]
        return ""

    @staticmethod
    def _infer_goal(transcript: str) -> str:
        for marker in ("核心是", "目标是", "希望", "用于", "帮助"):
            if marker in transcript:
                fragment = transcript.split(marker, 1)[1].split("。", 1)[0].strip("：:，, ")
                if fragment:
                    if marker == "帮助":
                        return f"帮助用户{fragment}"
                    return fragment
        return transcript.split("。", 1)[0].strip()

    @staticmethod
    def _infer_summary(title: str, target_users: List[str], screens: List[ScreenSpec], transcript: str) -> str:
        target = target_users[0] if target_users else "目标用户"
        screen_count = len(screens)
        return f"{title} 是一个面向{target}的 React + Vite Web 应用，围绕核心任务提供 {screen_count or 3} 个关键页面与清晰的使用流程。"

    @staticmethod
    def _infer_visual_direction(transcript: str) -> str:
        for marker in ("界面希望", "风格希望", "视觉希望", "风格", "界面风格"):
            if marker in transcript:
                fragment = transcript.split(marker, 1)[1].split("。", 1)[0].strip("：:，, ")
                if fragment:
                    return fragment
        if "偏浅色" in transcript:
            return "专业、清晰、偏浅色"
        return ""

    @staticmethod
    def _infer_target_users(transcript: str) -> List[str]:
        patterns = [
            r"面向([^，。；\n]+)",
            r"目标用户是([^，。；\n]+)",
            r"给([^，。；\n]+)用",
        ]
        results: List[str] = []
        for pattern in patterns:
            for match in re.findall(pattern, transcript):
                cleaned = match.strip()
                if cleaned:
                    results.append(cleaned)
        return list(dict.fromkeys(results))

    @staticmethod
    def _infer_screens(transcript: str) -> List[dict]:
        screen_catalog = [
            ("基础信息录入", ("基础信息", "信息录入", "录入")),
            ("计划总览", ("计划", "12周计划", "路线图", "总览")),
            ("每日任务", ("每日任务", "今日任务", "任务")),
            ("打卡记录", ("打卡", "完成记录")),
            ("每周复盘", ("复盘", "周总结")),
            ("错题记录", ("错题", "错题本")),
            ("资料推荐", ("资料推荐", "推荐", "资料")),
            ("学习进度", ("进度", "统计", "仪表盘")),
        ]
        screens: List[dict] = []
        for name, keywords in screen_catalog:
            if any(keyword in transcript for keyword in keywords):
                screens.append({"name": name, "purpose": f"用于支撑{name}的核心使用体验。", "elements": []})
        if not screens:
            screens = [
                {"name": "首页", "purpose": "用于承接主要信息与主任务入口。", "elements": []},
                {"name": "核心工作台", "purpose": "用于完成主要操作与查看结果。", "elements": []},
                {"name": "结果页", "purpose": "用于展示生成结果与后续建议。", "elements": []},
            ]
        return screens[:6]

    @staticmethod
    def _infer_flows(transcript: str) -> List[dict]:
        flows: List[dict] = []
        if any(keyword in transcript for keyword in ("录入", "基础信息", "问卷")):
            flows.append({"name": "录入基础信息", "steps": ["填写基础信息", "确认目标"], "success": "用户成功提交生成所需的基础信息。"})
        if any(keyword in transcript for keyword in ("计划", "生成", "推荐")):
            flows.append({"name": "生成个性化计划", "steps": ["分析输入条件", "输出可执行结果"], "success": "系统生成可执行的个性化方案。"})
        if any(keyword in transcript for keyword in ("任务", "打卡", "复盘", "记录")):
            flows.append({"name": "执行与记录进度", "steps": ["查看当日任务", "完成打卡或记录", "进入复盘"], "success": "用户可以持续执行并记录进度。"})
        if not flows:
            flows.append({"name": "完成主任务", "steps": ["进入应用", "完成核心操作", "查看结果"], "success": "用户完成主要目标。"})
        return flows[:4]

    @staticmethod
    def _infer_data_model_needs(transcript: str) -> List[dict]:
        needs: List[dict] = []
        if any(keyword in transcript for keyword in ("用户", "考生", "学生", "游客")):
            needs.append({"entity": "用户档案", "fields": ["姓名或昵称 (string)", "目标 (string)", "偏好设置 (string)"], "notes": "用于承接基础画像与目标。"})
        if "计划" in transcript:
            needs.append({"entity": "计划", "fields": ["标题 (string)", "周期 (string)", "目标说明 (string)"], "notes": "用于承接主方案或路线图。"})
        if any(keyword in transcript for keyword in ("任务", "打卡")):
            needs.append({"entity": "任务记录", "fields": ["任务标题 (string)", "状态 (enum)", "日期 (string)"], "notes": "用于跟踪每日执行情况。"})
        if "复盘" in transcript:
            needs.append({"entity": "复盘记录", "fields": ["日期 (string)", "总结 (string)", "问题点 (string)"], "notes": "用于沉淀阶段性复盘。"})
        if "错题" in transcript:
            needs.append({"entity": "错题条目", "fields": ["题目标题 (string)", "标签 (string)", "讲解 (string)"], "notes": "用于记录错题与解析。"})
        return needs[:5]

    @staticmethod
    def _infer_constraints(transcript: str) -> List[str]:
        constraints: List[str] = []
        mapping = (
            ("移动端", "需要兼顾移动端体验"),
            ("网页", "首版以 Web 应用为主"),
            ("Web", "首版以 Web 应用为主"),
            ("模拟数据", "首版允许使用模拟数据"),
            ("不需要登录", "首版暂不要求登录注册"),
        )
        for keyword, constraint in mapping:
            if keyword in transcript:
                constraints.append(constraint)
        return constraints

    @staticmethod
    def _infer_integrations(transcript: str) -> List[str]:
        integrations: List[str] = []
        if any(keyword in transcript for keyword in ("上传图片", "图片上传", "拍照")):
            integrations.append("图片上传")
        if any(keyword in transcript for keyword in ("视频", "视频教学")):
            integrations.append("视频内容展示")
        if any(keyword in transcript for keyword in ("聊天", "AI", "问答")):
            integrations.append("AI 对话能力")
        return integrations

    @staticmethod
    def _infer_assumptions(transcript: str, constraints: List[str]) -> List[str]:
        assumptions: List[str] = []
        if any("模拟数据" in item for item in constraints):
            assumptions.append("首版使用本地或模拟数据完成核心流程验证。")
        if "移动端" in transcript:
            assumptions.append("桌面端与移动端共享同一套响应式页面结构。")
        return assumptions

    @staticmethod
    def _infer_success_criteria(transcript: str) -> List[str]:
        criteria: List[str] = []
        if "计划" in transcript:
            criteria.append("用户可以在输入基础信息后获得一份可执行的完整计划。")
        if any(keyword in transcript for keyword in ("任务", "打卡", "复盘")):
            criteria.append("用户可以持续记录执行情况并查看阶段性反馈。")
        if "移动端" in transcript:
            criteria.append("核心页面在移动端也能保持可读和可操作。")
        return criteria

    def _build_plan_locally(self, spec: AppSpec) -> List[PlanStep] | None:
        if not spec.screens and not spec.core_flows:
            return None

        focus_screen = spec.screens[0].name if spec.screens else "首页"
        focus_flow = spec.core_flows[0].name if spec.core_flows else "主流程"
        steps = [
            f"搭建 {spec.title} 的整体应用骨架、路由结构和基础样式变量",
            f"实现 {focus_screen} 及关键页面区块，先把主要信息层级和交互入口建立起来",
            f"串联 {focus_flow} 等核心流程，补齐表单、状态与主要结果展示",
            "加入示例数据、必要校验和关键反馈，让主路径可以完整跑通",
            "完成响应式细节、视觉润色和构建前自检，确保可以进入审批和执行阶段",
        ]
        return [PlanStep(id=f"step-{index + 1}", title=step, detail=step, status="pending") for index, step in enumerate(steps)]

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

    def _invoke_structured(
        self,
        role: str,
        output_schema,
        prompt: ChatPromptTemplate,
        payload: dict,
        timeout_seconds: float,
        invocation_name: str,
    ):
        try:
            model = self.provider.require_chat_model(role, timeout_seconds=timeout_seconds)  # type: ignore[arg-type]
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
                structured_output_method=self.provider.preferred_structured_output_method(role),
                timeout_seconds=timeout_seconds,
                invocation_name=invocation_name,
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
