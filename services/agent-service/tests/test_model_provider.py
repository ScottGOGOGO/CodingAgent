from app.config import get_settings
from app.services.model_provider import ModelProvider


def test_model_provider_prefers_generic_openai_compatible_settings(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai_compatible")
    monkeypatch.setenv("MODEL_API_KEY", "generic-key")
    monkeypatch.setenv("MODEL_BASE_URL", "https://example.com/v1")
    monkeypatch.setenv("MODEL_NAME", "example-model")
    monkeypatch.setenv("CLARIFIER_MODEL", "")
    monkeypatch.setenv("PLANNER_MODEL", "")
    monkeypatch.setenv("CODER_MODEL", "")
    monkeypatch.setenv("CRITIC_MODEL", "")
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


def test_model_provider_enables_responses_api_when_base_url_targets_responses(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example.com/v1/responses")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.4")
    monkeypatch.setenv("MODEL_TIMEOUT_SECONDS", "0")
    get_settings.cache_clear()

    provider = ModelProvider()
    model = provider.require_chat_model("coder", timeout_seconds=45)

    assert getattr(model, "use_responses_api") is True
    assert getattr(model, "output_version") == "responses/v1"
    assert getattr(model, "openai_api_base") == "https://example.com/v1"
    assert getattr(model, "request_timeout") is None


def test_model_provider_enables_responses_api_for_wire_api_on_root_base_url(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example.com")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.4-mini")
    monkeypatch.setenv("MODEL_WIRE_API", "responses")
    get_settings.cache_clear()

    provider = ModelProvider()
    model = provider.require_chat_model("coder", timeout_seconds=45)

    assert getattr(model, "use_responses_api") is True
    assert getattr(model, "output_version") == "responses/v1"
    assert getattr(model, "openai_api_base") == "https://example.com/v1"


def test_model_provider_uses_json_schema_for_gpt5_structured_output(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example.com/v1/responses")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.4")
    get_settings.cache_clear()

    provider = ModelProvider()

    assert provider.preferred_structured_output_method("planner") == "json_schema"


def test_model_provider_passes_gpt5_reasoning_and_verbosity_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example.com/v1/responses")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.4")
    monkeypatch.setenv("MODEL_REASONING_EFFORT", "low")
    monkeypatch.setenv("MODEL_VERBOSITY", "low")
    get_settings.cache_clear()

    provider = ModelProvider()
    model = provider.require_chat_model("coder", timeout_seconds=45)

    assert getattr(model, "reasoning_effort") == "low"
    assert getattr(model, "verbosity") == "low"


def test_model_provider_disables_response_storage_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example.com")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.4-mini")
    monkeypatch.setenv("MODEL_WIRE_API", "responses")
    monkeypatch.setenv("MODEL_DISABLE_RESPONSE_STORAGE", "true")
    get_settings.cache_clear()

    provider = ModelProvider()
    model = provider.require_chat_model("coder", timeout_seconds=45)

    assert getattr(model, "store") is False
