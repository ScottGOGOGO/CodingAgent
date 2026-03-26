from app.config import get_settings
from app.services.model_provider import ModelProvider


def test_model_provider_prefers_generic_openai_compatible_settings(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai_compatible")
    monkeypatch.setenv("MODEL_API_KEY", "generic-key")
    monkeypatch.setenv("MODEL_BASE_URL", "https://example.com/v1")
    monkeypatch.setenv("MODEL_NAME", "example-model")
    monkeypatch.setenv("QWEN_API_KEY", "")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    get_settings.cache_clear()

    provider = ModelProvider()
    route = provider.resolve_route()
    settings = get_settings()

    assert settings.resolved_runtime_provider == "openai_compatible"
    assert settings.resolved_api_key == "generic-key"
    assert settings.resolved_base_url == "https://example.com/v1"
    assert settings.resolved_model_name == "example-model"
    assert route.coder_model == "example-model"


def test_model_provider_keeps_legacy_qwen_env_working(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "qwen")
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    monkeypatch.delenv("MODEL_BASE_URL", raising=False)
    monkeypatch.delenv("MODEL_NAME", raising=False)
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    monkeypatch.setenv("QWEN_MODEL", "qwen3-coder-plus")
    get_settings.cache_clear()

    provider = ModelProvider()
    route = provider.resolve_route()
    settings = get_settings()

    assert settings.resolved_runtime_provider == "qwen"
    assert settings.resolved_api_key == "qwen-key"
    assert settings.resolved_base_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert settings.resolved_model_name == "qwen3-coder-plus"
    assert route.planner_model == "qwen3-coder-plus"


def test_openai_compatible_prefers_complete_provider_block_over_partial_one(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai_compatible")
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    monkeypatch.delenv("MODEL_BASE_URL", raising=False)
    monkeypatch.delenv("MODEL_NAME", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_MODEL", "")
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    monkeypatch.setenv("QWEN_MODEL", "qwen3-coder-plus")
    get_settings.cache_clear()

    settings = get_settings()

    assert settings.resolved_runtime_provider == "qwen"
    assert settings.resolved_api_key == "qwen-key"
    assert settings.resolved_model_name == "qwen3-coder-plus"
