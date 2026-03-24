from __future__ import annotations

from typing import Literal, Optional

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_openai import ChatOpenAI

from app.config import get_settings
from app.models import ProviderRoute
from app.services.errors import ModelProviderError


ModelRole = Literal["clarifier", "planner", "coder", "critic"]


class ModelProvider:
    def resolve_route(self) -> ProviderRoute:
        settings = get_settings()
        return ProviderRoute(
            clarifierModel=settings.resolved_clarifier_model,
            plannerModel=settings.resolved_planner_model,
            coderModel=settings.resolved_coder_model,
            criticModel=settings.resolved_critic_model,
            provider=settings.model_provider,
        )

    def get_chat_model(self, role: ModelRole) -> Optional[BaseChatModel]:
        settings = get_settings()
        if settings.model_provider != "qwen":
            raise ModelProviderError(f"Unsupported model provider: {settings.model_provider}")

        if not settings.qwen_api_key:
            return None

        route = self.resolve_route()
        model_name = {
            "clarifier": route.clarifier_model,
            "planner": route.planner_model,
            "coder": route.coder_model,
            "critic": route.critic_model,
        }[role]
        return ChatOpenAI(
            model=model_name,
            api_key=settings.qwen_api_key,
            base_url=settings.qwen_base_url,
            temperature=settings.model_temperature,
        )

    def require_chat_model(self, role: ModelRole) -> BaseChatModel:
        model = self.get_chat_model(role)
        if model is None:
            raise ModelProviderError(
                "Qwen API key is not configured. Set QWEN_API_KEY or DASHSCOPE_API_KEY before running the agent."
            )
        return model
