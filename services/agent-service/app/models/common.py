from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict


class AppBaseModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


def _stringify_model_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts = [_stringify_model_value(item) for item in value]
        return ", ".join(part for part in parts if part)
    if isinstance(value, dict):
        named_value = _stringify_named_mapping(value)
        if named_value:
            return named_value
        parts = []
        for key, item in value.items():
            text = _stringify_model_value(item)
            if text:
                parts.append(f"{key}: {text}")
        return "; ".join(parts)
    return str(value).strip()


def _stringify_named_mapping(value: Dict[str, Any]) -> str:
    name = _stringify_model_value(
        value.get("name")
        or value.get("title")
        or value.get("label")
        or value.get("field")
        or value.get("key")
        or value.get("id")
    )
    type_name = _stringify_model_value(value.get("type") or value.get("dataType"))
    description = _stringify_model_value(value.get("description") or value.get("summary") or value.get("notes"))

    if name and type_name:
        return f"{name} ({type_name})"
    if name and description:
        return f"{name}: {description}"
    if name:
        return name
    return ""


def _coerce_operation_content(value: object) -> object:
    if value is None or isinstance(value, str):
        return value

    if isinstance(value, dict):
        for key in (
            "after",
            "content",
            "newContent",
            "new",
            "updated",
            "replacement",
            "replace",
            "value",
            "code",
            "text",
            "fullContent",
            "body",
            "before",
        ):
            candidate = value.get(key)
            if candidate is None:
                continue
            if isinstance(candidate, str):
                return candidate
            nested = _coerce_operation_content(candidate)
            if isinstance(nested, str):
                return nested

    if isinstance(value, list):
        parts = [part for part in (_coerce_operation_content(item) for item in value) if isinstance(part, str) and part]
        if parts:
            return "\n".join(parts)

    return value


def _ensure_list(value: object) -> List[object]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _coerce_string_list(value: object) -> List[str]:
    normalized: List[str] = []
    for item in _ensure_list(value):
        text = _stringify_model_value(item)
        if text:
            normalized.append(text)
    return normalized


def _coerce_step_list(value: object) -> List[str]:
    normalized: List[str] = []

    for item in _ensure_list(value):
        if isinstance(item, dict):
            title = _stringify_model_value(item.get("title") or item.get("name") or item.get("step"))
            detail = _stringify_model_value(item.get("description") or item.get("detail") or item.get("summary"))
            if title and detail and detail != title:
                text = f"{title}: {detail}"
            else:
                text = title or detail or _stringify_model_value(item)
        else:
            text = _stringify_model_value(item)

        if text:
            normalized.append(text)

    return normalized


def _coerce_score_value(value: object) -> Optional[float]:
    if value is None:
        return None

    candidate = value
    if isinstance(value, dict):
        for key in (
            "score",
            "value",
            "rating",
            "buildReadinessScore",
            "requirementCoverageScore",
            "designQualityScore",
            "interactionQualityScore",
        ):
            nested = value.get(key)
            if nested is not None:
                candidate = nested
                break

    if isinstance(candidate, (int, float)):
        return float(candidate)

    text = _stringify_model_value(candidate)
    if not text:
        return None

    percent = text.endswith("%")
    if percent:
        text = text[:-1].strip()

    try:
        number = float(text)
    except (TypeError, ValueError):
        return None

    if percent or number > 1:
        number /= 100.0
    return number
