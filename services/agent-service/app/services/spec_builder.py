from __future__ import annotations

import re
from json import dumps
from typing import List

from langchain_core.prompts import ChatPromptTemplate

from app.models import AgentSessionState, AppSpec, DataModelNeed, FlowSpec, PlanStep, ScreenSpec, StructuredPlanOutput, StructuredSpecOutput
from app.services.errors import GenerationFailure
from app.services.json_parser import parse_json_response
from app.services.model_provider import ModelProvider


USER_FACING_LANGUAGE_RULE = (
    "除非用户明确要求其他语言，所有面向用户的自然语言字段都必须使用简体中文，"
    "保留 JSON key、文件路径和代码标识符的必要格式。"
)


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
                    "For dataModelNeeds.fields, return an array of strings, not objects. "
                    'Example: ["title (string)", "skillLevel (enum)"].',
                ),
            ]
        )
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
        return AppSpec(
            appName=slugify(self._coalesce_text(result.title, working_spec.title, working_spec.goal, "generated-app"), fallback="generated-app"),
            title=self._coalesce_text(result.title, working_spec.title, working_spec.goal, "生成的应用"),
            summary=self._coalesce_text(
                result.summary,
                working_spec.summary,
                result.goal,
                working_spec.goal,
                "根据最新对话整理出的可实施 Web 应用方案。",
            ),
            goal=self._coalesce_text(
                result.goal,
                working_spec.goal,
                working_spec.summary,
                state.messages[-1].content if state.messages else None,
                "构建一个符合用户需求、可直接实现的 Web 应用。",
            ),
            targetUsers=self._normalize_string_list(result.target_users or working_spec.target_users),
            screens=self._normalize_screens(result.screens),
            coreFlows=self._normalize_flows(result.core_flows),
            dataModelNeeds=self._normalize_data_model_needs(result.data_model_needs),
            integrations=self._normalize_string_list(result.integrations),
            brandAndVisualDirection=self._coalesce_text(
                result.brand_and_visual_direction,
                working_spec.brand_and_visual_direction,
                "简洁现代、可直接落地的界面风格方向。",
            ),
            constraints=self._normalize_string_list(result.constraints),
            successCriteria=self._normalize_string_list(result.success_criteria),
            assumptions=self._normalize_string_list(result.assumptions),
        )

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

    def _invoke_structured(self, role: str, output_schema, prompt: ChatPromptTemplate, payload: dict):
        try:
            model = self.provider.require_chat_model(role)  # type: ignore[arg-type]
            messages = prompt.format_messages(**payload)
            try:
                return model.with_structured_output(output_schema, method="json_mode").invoke(messages)
            except Exception:
                response = model.invoke(messages)
                return parse_json_response(response.content, output_schema)
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
