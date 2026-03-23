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
    qwen_api_key: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("QWEN_API_KEY", "DASHSCOPE_API_KEY"),
    )
    qwen_base_url: str = Field(
        default="https://dashscope.aliyuncs.com/compatible-mode/v1",
        alias="QWEN_BASE_URL",
    )
    qwen_model: str = Field(default="qwen3-coder-plus", alias="QWEN_MODEL")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
