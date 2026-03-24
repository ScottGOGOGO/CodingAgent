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

    model_provider: str = Field(default="qwen", alias="MODEL_PROVIDER")
    qwen_api_key: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("QWEN_API_KEY", "DASHSCOPE_API_KEY"),
    )
    qwen_base_url: str = Field(default="https://dashscope.aliyuncs.com/compatible-mode/v1", alias="QWEN_BASE_URL")
    qwen_model: str = Field(default="qwen3-coder-plus", alias="QWEN_MODEL")
    clarifier_model: Optional[str] = Field(default=None, alias="CLARIFIER_MODEL")
    planner_model: Optional[str] = Field(default=None, alias="PLANNER_MODEL")
    coder_model: Optional[str] = Field(default=None, alias="CODER_MODEL")
    critic_model: Optional[str] = Field(default=None, alias="CRITIC_MODEL")
    model_temperature: float = Field(default=0.0, alias="MODEL_TEMPERATURE")
    approval_round_budget: int = Field(default=3, alias="APPROVAL_ROUND_BUDGET")

    @property
    def resolved_clarifier_model(self) -> str:
        return self.clarifier_model or self.qwen_model

    @property
    def resolved_planner_model(self) -> str:
        return self.planner_model or self.qwen_model

    @property
    def resolved_coder_model(self) -> str:
        return self.coder_model or self.qwen_model

    @property
    def resolved_critic_model(self) -> str:
        return self.critic_model or self.qwen_model


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
