from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env.local", ".env", "../../.env.local", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "vide-agent-service"
    environment: str = Field(default="development", alias="ENVIRONMENT")
    database_url: Optional[str] = Field(default=None, alias="DATABASE_URL")
    object_storage_bucket: Optional[str] = Field(default=None, alias="OBJECT_STORAGE_BUCKET")
    object_storage_endpoint: Optional[str] = Field(default=None, alias="OBJECT_STORAGE_ENDPOINT")
    langsmith_api_key: Optional[str] = Field(default=None, alias="LANGSMITH_API_KEY")
    langsmith_tracing: bool = Field(default=False, alias="LANGSMITH_TRACING")
    langsmith_project: str = Field(default="vide-agent-service", alias="LANGSMITH_PROJECT")

    model_provider: str = Field(default="openai_compatible", alias="MODEL_PROVIDER")
    model_api_key: Optional[str] = Field(default=None, alias="MODEL_API_KEY")
    model_base_url: Optional[str] = Field(default=None, alias="MODEL_BASE_URL")
    model_name: Optional[str] = Field(default=None, alias="MODEL_NAME")

    qwen_api_key: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("QWEN_API_KEY", "DASHSCOPE_API_KEY"),
    )
    qwen_base_url: Optional[str] = Field(default="https://dashscope.aliyuncs.com/compatible-mode/v1", alias="QWEN_BASE_URL")
    qwen_model: Optional[str] = Field(default="qwen3-coder-plus", alias="QWEN_MODEL")
    openai_api_key: Optional[str] = Field(default=None, alias="OPENAI_API_KEY")
    openai_base_url: Optional[str] = Field(default="https://api.openai.com/v1", alias="OPENAI_BASE_URL")
    openai_model: Optional[str] = Field(default=None, alias="OPENAI_MODEL")
    gemini_api_key: Optional[str] = Field(default=None, alias="GEMINI_API_KEY")
    gemini_base_url: Optional[str] = Field(default=None, alias="GEMINI_BASE_URL")
    gemini_model: Optional[str] = Field(default=None, alias="GEMINI_MODEL")
    claude_api_key: Optional[str] = Field(default=None, alias="CLAUDE_API_KEY")
    claude_base_url: Optional[str] = Field(default=None, alias="CLAUDE_BASE_URL")
    claude_model: Optional[str] = Field(default=None, alias="CLAUDE_MODEL")
    clarifier_model: Optional[str] = Field(default=None, alias="CLARIFIER_MODEL")
    planner_model: Optional[str] = Field(default=None, alias="PLANNER_MODEL")
    coder_model: Optional[str] = Field(default=None, alias="CODER_MODEL")
    critic_model: Optional[str] = Field(default=None, alias="CRITIC_MODEL")
    model_temperature: float = Field(default=0.0, alias="MODEL_TEMPERATURE")
    model_timeout_seconds: float = Field(default=90.0, alias="MODEL_TIMEOUT_SECONDS")
    model_max_retries: int = Field(default=0, alias="MODEL_MAX_RETRIES")
    approval_round_budget: int = Field(default=3, alias="APPROVAL_ROUND_BUDGET")

    @property
    def normalized_model_provider(self) -> str:
        value = (self.model_provider or "openai_compatible").strip().lower().replace("-", "_")
        aliases = {
            "anthropic": "claude",
            "dashscope": "qwen",
        }
        return aliases.get(value, value)

    def _provider_credentials(self, provider: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
        normalized = provider.strip().lower().replace("-", "_")
        if normalized == "qwen":
            return self.qwen_api_key, self.qwen_base_url, self.qwen_model
        if normalized == "openai":
            return self.openai_api_key, self.openai_base_url, self.openai_model
        if normalized == "gemini":
            return self.gemini_api_key, self.gemini_base_url, self.gemini_model
        if normalized == "claude":
            return self.claude_api_key, self.claude_base_url, self.claude_model
        return None, None, None

    @property
    def resolved_runtime_provider(self) -> str:
        provider = self.normalized_model_provider
        if provider != "openai_compatible":
            return provider

        if self.model_api_key or self.model_base_url or self.model_name:
            return "openai_compatible"

        for candidate in ("openai", "qwen", "gemini", "claude"):
            api_key, base_url, model_name = self._provider_credentials(candidate)
            if api_key and model_name:
                return candidate

        for candidate in ("openai", "qwen", "gemini", "claude"):
            api_key, base_url, model_name = self._provider_credentials(candidate)
            if api_key or base_url or model_name:
                return candidate

        return "openai_compatible"

    @property
    def resolved_api_key(self) -> Optional[str]:
        if self.model_api_key:
            return self.model_api_key
        api_key, _, _ = self._provider_credentials(self.resolved_runtime_provider)
        return api_key

    @property
    def resolved_base_url(self) -> Optional[str]:
        if self.model_base_url:
            return self.model_base_url
        _, base_url, _ = self._provider_credentials(self.resolved_runtime_provider)
        return base_url

    @property
    def resolved_model_name(self) -> Optional[str]:
        if self.model_name:
            return self.model_name
        _, _, model_name = self._provider_credentials(self.resolved_runtime_provider)
        return model_name

    @property
    def resolved_clarifier_model(self) -> str:
        return self.clarifier_model or self.resolved_model_name or ""

    @property
    def resolved_planner_model(self) -> str:
        return self.planner_model or self.resolved_model_name or ""

    @property
    def resolved_coder_model(self) -> str:
        return self.coder_model or self.resolved_model_name or ""

    @property
    def resolved_critic_model(self) -> str:
        return self.critic_model or self.resolved_model_name or ""

    @property
    def model_is_configured(self) -> bool:
        return bool(self.resolved_api_key and self.resolved_model_name)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
