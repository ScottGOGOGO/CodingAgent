from __future__ import annotations

import json
import re
from typing import Type

from pydantic import BaseModel

from app.services.errors import GenerationFailure


def parse_json_response(text: str, schema: Type[BaseModel]) -> BaseModel:
    cleaned = text.strip()
    cleaned = re.sub(r"^```json\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^```\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    cleaned = cleaned.strip()

    if not cleaned:
        raise GenerationFailure("Qwen returned an empty response instead of JSON.")

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise GenerationFailure(f"Qwen returned invalid JSON: {exc}") from exc

    try:
        return schema.model_validate(parsed)
    except Exception as exc:
        raise GenerationFailure(f"Qwen returned JSON that did not match the expected schema: {exc}") from exc
