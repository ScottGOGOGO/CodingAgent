from __future__ import annotations

import re
from json import dumps
from typing import List

from langchain_core.prompts import ChatPromptTemplate

from app.models import AgentSessionState, AppSpec, PlanStep, StructuredPlanOutput, StructuredSpecOutput
from app.services.errors import GenerationFailure
from app.services.json_parser import parse_json_response
from app.services.model_provider import ModelProvider


def slugify(value: str) -> str:
    lowered = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    return lowered.strip("-") or "generated-app"


class SpecBuilder:
    def __init__(self) -> None:
        self.provider = ModelProvider()

    def build_spec(self, state: AgentSessionState) -> AppSpec:
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You normalize product requirements into a concise React + Vite web-app spec. "
                    "You must rely on the provided Qwen model and return structured output only. "
                    "Your response must be valid JSON that matches the requested schema. "
                    "Do not wrap the JSON in markdown fences. "
                    "Return a JSON object with keys: title, summary, target_users, pages, key_interactions, visual_style, integrations, assumptions.",
                ),
                (
                    "human",
                    "Conversation:\n{messages}\n\n"
                    "Requirement slots:\n{slots}\n\n"
                    "Assumptions already made:\n{assumptions}\n\n"
                    "Generate a focused web-app spec for implementation.",
                ),
            ]
        )
        result = self._invoke_structured(
            output_schema=StructuredSpecOutput,
            prompt=prompt,
            payload={
                "messages": dumps([message.model_dump(mode="json") for message in state.messages], ensure_ascii=False),
                "slots": dumps(state.requirement_slots.model_dump(), ensure_ascii=False),
                "assumptions": "\n".join(state.assumptions) or "None",
            },
        )
        return AppSpec(
            appName=slugify(result.title),
            title=result.title,
            summary=result.summary,
            targetUsers=self._normalize_target_users(result.target_users),
            pages=self._normalize_named_list(result.pages),
            keyInteractions=self._normalize_named_list(result.key_interactions),
            visualStyle=self._normalize_visual_style(result.visual_style),
            integrations=self._normalize_named_list(result.integrations),
            assumptions=result.assumptions,
        )

    def build_plan(self, state: AgentSessionState, spec: AppSpec) -> List[PlanStep]:
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You write short execution plans for a Qwen-powered vibe coding agent. "
                    "Your response must be valid JSON that matches the requested schema. "
                    "Do not wrap the JSON in markdown fences. "
                    "Return a JSON object with keys: steps and summary.",
                ),
                (
                    "human",
                    "Create 4 concise implementation steps for this spec:\n{spec}",
                ),
            ]
        )
        result = self._invoke_structured(
            output_schema=StructuredPlanOutput,
            prompt=prompt,
            payload={"spec": dumps(spec.model_dump(mode="json", by_alias=True), ensure_ascii=False)},
        )
        return [
            PlanStep(id=f"step-{index+1}", title=step, detail=step, status="pending")
            for index, step in enumerate(result.steps[:4])
        ]

    def _invoke_structured(self, output_schema, prompt: ChatPromptTemplate, payload: dict):
        try:
            model = self.provider.require_chat_model()
            messages = prompt.format_messages(**payload)
            response = model.invoke(messages)
            return parse_json_response(response.content, output_schema)
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise
            raise GenerationFailure(f"Qwen request failed while preparing the app plan: {exc}") from exc

    @staticmethod
    def _normalize_target_users(value) -> str:
        if isinstance(value, list):
            return "、".join(str(item).strip() for item in value if str(item).strip())
        return str(value).strip()

    @staticmethod
    def _normalize_named_list(items) -> List[str]:
        if isinstance(items, dict):
            items = [items]
        normalized: List[str] = []
        for item in items:
            if isinstance(item, dict):
                name = item.get("name") or item.get("title") or item.get("label")
                detail = item.get("description") or item.get("summary")
                if name and detail:
                    normalized.append(f"{name}: {detail}")
                elif name:
                    normalized.append(str(name).strip())
                else:
                    normalized.append(str(item).strip())
            else:
                normalized.append(str(item).strip())
        return [item for item in normalized if item]

    @staticmethod
    def _normalize_visual_style(value) -> str:
        if isinstance(value, dict):
            parts: List[str] = []
            for key, item in value.items():
                if isinstance(item, list):
                    parts.append(f"{key}: {'、'.join(str(entry).strip() for entry in item if str(entry).strip())}")
                elif isinstance(item, dict):
                    parts.append(
                        f"{key}: "
                        + "、".join(f"{sub_key}={sub_value}" for sub_key, sub_value in item.items())
                    )
                else:
                    parts.append(f"{key}: {item}")
            return " | ".join(parts)
        return str(value).strip()
