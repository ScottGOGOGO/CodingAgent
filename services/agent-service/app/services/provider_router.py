from __future__ import annotations

from app.models import ProviderRoute
from app.services.model_provider import ModelProvider


class ProviderRouter:
    def __init__(self) -> None:
        self.provider = ModelProvider()

    def resolve(self) -> ProviderRoute:
        return self.provider.resolve_route()
