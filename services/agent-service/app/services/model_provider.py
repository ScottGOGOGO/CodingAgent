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
            provider=settings.resolved_runtime_provider,
        )

    def get_chat_model(self, role: ModelRole) -> Optional[BaseChatModel]:
        settings = get_settings()
        if settings.normalized_model_provider not in {"openai_compatible", "openai", "qwen", "gemini", "claude"}:
            raise ModelProviderError(f"暂不支持的模型提供方：{settings.model_provider}")

        if not settings.resolved_api_key:
            return None

        route = self.resolve_route()
        model_name = {
            "clarifier": route.clarifier_model,
            "planner": route.planner_model,
            "coder": route.coder_model,
            "critic": route.critic_model,
        }[role]
        if not model_name:
            raise ModelProviderError("未配置模型名称。请在启动 agent 前设置 MODEL_NAME 或对应提供方的模型变量。")

        return ChatOpenAI(
            model=model_name,
            api_key=settings.resolved_api_key,
            base_url=settings.resolved_base_url,
            temperature=settings.model_temperature,
        )

    def require_chat_model(self, role: ModelRole) -> BaseChatModel:
        model = self.get_chat_model(role)
        if model is None:
            raise ModelProviderError(
                "未配置模型 API Key。请在启动 agent 前设置 MODEL_API_KEY，或为当前提供方设置对应的 API Key。"
            )
        return model
