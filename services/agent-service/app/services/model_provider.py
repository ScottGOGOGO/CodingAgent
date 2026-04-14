from __future__ import annotations

from typing import Literal, Optional
from urllib.parse import urlsplit, urlunsplit

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_openai import ChatOpenAI

from app.config import get_settings
from app.models import ProviderRoute
from app.services.errors import ModelProviderError


ModelRole = Literal["clarifier", "planner", "coder", "critic"]
StructuredOutputMethod = Literal["json_mode", "json_schema"]


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

    def get_chat_model(self, role: ModelRole, timeout_seconds: Optional[float] = None) -> Optional[BaseChatModel]:
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

        wire_api = self._normalize_optional_text(settings.model_wire_api)
        base_url, use_responses_api = self._resolve_base_url(settings.resolved_base_url, wire_api=wire_api)
        request_timeout = self._resolve_timeout_seconds(settings, timeout_seconds)
        kwargs = {}
        if request_timeout is not None:
            kwargs["timeout"] = request_timeout
        if use_responses_api:
            kwargs["use_responses_api"] = True
            kwargs["output_version"] = "responses/v1"
        if settings.model_disable_response_storage:
            kwargs["store"] = False
        if self._is_gpt5_model(model_name):
            reasoning_effort = self._normalize_optional_text(settings.model_reasoning_effort)
            verbosity = self._normalize_optional_text(settings.model_verbosity)
            if reasoning_effort:
                kwargs["reasoning_effort"] = reasoning_effort
            if verbosity:
                kwargs["verbosity"] = verbosity

        return ChatOpenAI(
            model=model_name,
            api_key=settings.resolved_api_key,
            base_url=base_url,
            temperature=settings.model_temperature,
            max_retries=settings.model_max_retries,
            **kwargs,
        )

    def require_chat_model(self, role: ModelRole, timeout_seconds: Optional[float] = None) -> BaseChatModel:
        model = self.get_chat_model(role, timeout_seconds=timeout_seconds)
        if model is None:
            raise ModelProviderError(
                "未配置模型 API Key。请在启动 agent 前设置 MODEL_API_KEY，或为当前提供方设置对应的 API Key。"
            )
        return model

    def preferred_structured_output_method(self, role: ModelRole) -> StructuredOutputMethod:
        route = self.resolve_route()
        model_name = {
            "clarifier": route.clarifier_model,
            "planner": route.planner_model,
            "coder": route.coder_model,
            "critic": route.critic_model,
        }[role]
        if self._is_gpt5_model(model_name):
            return "json_schema"
        return "json_mode"

    @staticmethod
    def _resolve_base_url(base_url: Optional[str], wire_api: Optional[str] = None) -> tuple[Optional[str], bool]:
        if not base_url:
            return base_url, wire_api == "responses"

        normalized = base_url.rstrip("/")
        use_responses_api = wire_api == "responses"
        if normalized.endswith("/responses"):
            normalized = normalized[: -len("/responses")]
            use_responses_api = True

        if not use_responses_api:
            return normalized, False

        parsed = urlsplit(normalized)
        path = parsed.path.rstrip("/")
        if not path:
            path = "/v1"
        normalized = urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))
        return normalized, True

    @staticmethod
    def _resolve_timeout_seconds(settings: object, timeout_seconds: Optional[float]) -> Optional[float]:
        configured_timeout = getattr(settings, "model_timeout_seconds", None)
        if configured_timeout is None or configured_timeout <= 0:
            return None
        if timeout_seconds is not None and timeout_seconds > 0:
            return timeout_seconds
        return configured_timeout

    @staticmethod
    def _normalize_optional_text(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip().lower()
        return normalized or None

    @staticmethod
    def _is_gpt5_model(model_name: str) -> bool:
        return (model_name or "").strip().lower().startswith("gpt-5")
