class GenerationFailure(RuntimeError):
    """Raised when the Qwen-backed generation pipeline cannot complete."""


class ModelProviderError(GenerationFailure):
    """Raised when the configured model provider is unavailable."""
