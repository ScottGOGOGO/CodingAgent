from __future__ import annotations

from typing import Optional

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_openai import ChatOpenAI

from app.config import get_settings
from app.services.errors import ModelProviderError


class ModelProvider:
    def get_chat_model(self) -> Optional[BaseChatModel]:
        settings = get_settings()
        if not settings.qwen_api_key:
            return None

        return ChatOpenAI(
            model=settings.qwen_model,
            api_key=settings.qwen_api_key,
            base_url=settings.qwen_base_url,
            temperature=0.0,
        )

    def require_chat_model(self) -> BaseChatModel:
        model = self.get_chat_model()
        if model is None:
            raise ModelProviderError(
                "Qwen API key is not configured. Set QWEN_API_KEY or DASHSCOPE_API_KEY before generating code."
            )
        return model
