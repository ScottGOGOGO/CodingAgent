from __future__ import annotations

import json
import re
import textwrap
from typing import Optional, Type

from pydantic import BaseModel
import yaml

from app.services.errors import GenerationFailure


def _extract_json_substring(text: str) -> str:
    """Try to find the outermost JSON object or array in *text*."""
    for open_char, close_char in [("{", "}"), ("[", "]")]:
        start = text.find(open_char)
        end = text.rfind(close_char)
        if start != -1 and end > start:
            return text[start : end + 1]
    return text


def _repair_common_json_escapes(text: str) -> str:
    # Models sometimes emit stray backslashes inside JSON strings, which makes
    # otherwise valid payloads fail to parse with `Invalid \escape`.
    return re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", text)


def _normalize_unicode_quotes(text: str) -> str:
    return (
        text.replace("“", '"')
        .replace("”", '"')
        .replace("‘", "'")
        .replace("’", "'")
    )


def _strip_trailing_commas(text: str) -> str:
    return re.sub(r",(\s*[}\]])", r"\1", text)


def _trim_blank_lines(text: str) -> str:
    lines = text.splitlines()
    while lines and not lines[0].strip():
        lines = lines[1:]
    while lines and not lines[-1].strip():
        lines = lines[:-1]
    return "\n".join(lines)


def _normalize_followup_indentation(text: str) -> str:
    lines = _trim_blank_lines(text).splitlines()
    if len(lines) < 2:
        return _trim_blank_lines(text)

    first_line = lines[0]
    if ":" not in first_line or first_line.strip().endswith(":"):
        return "\n".join(lines)

    remaining_lines = [line for line in lines[1:] if line.strip()]
    if not remaining_lines:
        return "\n".join(lines)

    indents = [len(line) - len(line.lstrip()) for line in remaining_lines]
    common_indent = min(indents)
    if common_indent <= 0:
        return "\n".join(lines)

    normalized = [first_line]
    for line in lines[1:]:
        if not line.strip():
            normalized.append("")
            continue
        normalized.append(line[common_indent:])
    return "\n".join(normalized)


def _build_error_excerpt(text: str, exc: json.JSONDecodeError) -> str:
    start = max(0, exc.pos - 80)
    end = min(len(text), exc.pos + 80)
    excerpt = text[start:end].replace("\n", "\\n")
    return excerpt


def _validate_parsed(parsed, schema: Type[BaseModel]) -> BaseModel:
    try:
        return schema.model_validate(parsed)
    except Exception as exc:
        raise GenerationFailure(f"Qwen 返回的 JSON 与预期 schema 不匹配：{exc}") from exc


def _try_json_variants(text: str, schema: Type[BaseModel]) -> Optional[BaseModel]:
    variants = []
    for value in (
        text,
        _normalize_unicode_quotes(text),
        _repair_common_json_escapes(text),
        _strip_trailing_commas(text),
        _strip_trailing_commas(_normalize_unicode_quotes(text)),
        _strip_trailing_commas(_repair_common_json_escapes(text)),
        _repair_common_json_escapes(_normalize_unicode_quotes(text)),
        _strip_trailing_commas(_repair_common_json_escapes(_normalize_unicode_quotes(text))),
    ):
        if value not in variants:
            variants.append(value)

    for candidate in variants:
        try:
            parsed = json.loads(candidate)
            return _validate_parsed(parsed, schema)
        except GenerationFailure:
            raise
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return None


def _try_yaml_fallback(text: str, schema: Type[BaseModel]) -> Optional[BaseModel]:
    variants = []
    base_variants = (
        text,
        _trim_blank_lines(text),
        textwrap.dedent(text),
        _trim_blank_lines(textwrap.dedent(text)),
        _normalize_followup_indentation(text),
        _normalize_followup_indentation(textwrap.dedent(text)),
    )

    for base in base_variants:
        for value in (
            base,
            _normalize_unicode_quotes(base),
            _strip_trailing_commas(base),
            _strip_trailing_commas(_normalize_unicode_quotes(base)),
        ):
            if value not in variants:
                variants.append(value)

    for candidate in variants:
        try:
            parsed = yaml.safe_load(candidate)
        except yaml.YAMLError:
            continue
        if parsed is None:
            continue
        return _validate_parsed(parsed, schema)
    return None


def parse_json_response(text: str, schema: Type[BaseModel]) -> BaseModel:
    cleaned = text.strip()

    if not cleaned:
        raise GenerationFailure("Qwen 返回了空响应，未提供 JSON 结果。")

    # Strategy 1: extract the outermost JSON object/array directly.
    candidate = _extract_json_substring(cleaned)
    parsed_candidate = _try_json_variants(candidate, schema)
    if parsed_candidate is not None:
        return parsed_candidate

    yaml_candidate = _try_yaml_fallback(candidate, schema)
    if yaml_candidate is not None:
        return yaml_candidate

    # Strategy 2 (fallback): strip markdown code fences then retry.
    fallback = re.sub(r"^```json\s*", "", cleaned, flags=re.IGNORECASE)
    fallback = re.sub(r"^```\s*", "", fallback)
    fallback = re.sub(r"\s*```$", "", fallback)
    fallback = fallback.strip()

    parsed_fallback = _try_json_variants(fallback, schema)
    if parsed_fallback is not None:
        return parsed_fallback

    yaml_fallback = _try_yaml_fallback(fallback, schema)
    if yaml_fallback is not None:
        return yaml_fallback

    try:
        parsed = json.loads(fallback)
    except json.JSONDecodeError as exc:
        excerpt = _build_error_excerpt(fallback, exc)
        raise GenerationFailure(f"Qwen 返回了无效 JSON：{exc}。片段={excerpt}") from exc

    return _validate_parsed(parsed, schema)
