from __future__ import annotations

from typing import Sequence, Type, TypeVar

from langchain_core.messages import BaseMessage, HumanMessage
from pydantic import BaseModel

from app.services.errors import GenerationFailure
from app.services.json_parser import EMPTY_JSON_RESPONSE_ERROR, parse_json_response


SchemaT = TypeVar("SchemaT", bound=BaseModel)
EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 2


def invoke_structured_json(
    model: object,
    messages: Sequence[BaseMessage],
    output_schema: Type[SchemaT],
    repair_focus: str,
) -> SchemaT:
    message_list = list(messages)
    structured_error: Exception | None = None
    raw_error: Exception | None = None
    raw_response: object = None

    try:
        result = model.with_structured_output(output_schema, method="json_mode").invoke(message_list)
        return _coerce_result(result, output_schema)
    except Exception as exc:
        structured_error = exc

    try:
        response = model.invoke(message_list)
        raw_response = getattr(response, "content", response)
        parsed = parse_json_response(raw_response, output_schema)
        return _coerce_result(parsed, output_schema)
    except Exception as exc:
        if _is_empty_response_error(exc):
            try:
                parsed, raw_response = _retry_empty_response(
                    model=model,
                    messages=message_list,
                    output_schema=output_schema,
                    repair_focus=repair_focus,
                )
                return parsed
            except Exception as retry_exc:
                raw_error = retry_exc
        else:
            raw_error = exc

    repair_prompt = HumanMessage(
        content=_build_repair_prompt(
            output_schema=output_schema,
            repair_focus=repair_focus,
            structured_error=structured_error,
            raw_error=raw_error,
            raw_response=raw_response,
        )
    )

    try:
        repaired_response = model.invoke([*message_list, repair_prompt])
        repaired_content = getattr(repaired_response, "content", repaired_response)
        parsed = parse_json_response(repaired_content, output_schema)
        return _coerce_result(parsed, output_schema)
    except Exception as repair_exc:
        if _is_empty_response_error(repair_exc):
            try:
                parsed, _ = _retry_empty_response(
                    model=model,
                    messages=[*message_list, repair_prompt],
                    output_schema=output_schema,
                    repair_focus=repair_focus,
                )
                return parsed
            except Exception as retry_exc:
                repair_exc = retry_exc
        raise GenerationFailure(
            "结构化输出失败，原始 JSON 回退失败，自动纠错重试仍失败："
            f" structured={structured_error}; raw={raw_error}; repair={repair_exc}"
        ) from repair_exc


def _coerce_result(result: object, output_schema: Type[SchemaT]) -> SchemaT:
    if isinstance(result, output_schema):
        return result
    return output_schema.model_validate(result)


def _is_empty_response_error(error: Exception) -> bool:
    return EMPTY_JSON_RESPONSE_ERROR in str(error)


def _retry_empty_response(
    model: object,
    messages: Sequence[BaseMessage],
    output_schema: Type[SchemaT],
    repair_focus: str,
) -> tuple[SchemaT, object]:
    last_error: Exception | None = None
    last_response: object = None
    base_messages = list(messages)

    for attempt in range(EMPTY_RESPONSE_RECOVERY_ATTEMPTS):
        attempt_messages = list(base_messages)
        if attempt == EMPTY_RESPONSE_RECOVERY_ATTEMPTS - 1:
            attempt_messages.append(
                HumanMessage(content=_build_empty_response_retry_prompt(output_schema, repair_focus))
            )
        try:
            response = model.invoke(attempt_messages)
            last_response = getattr(response, "content", response)
            parsed = parse_json_response(last_response, output_schema)
            return _coerce_result(parsed, output_schema), last_response
        except Exception as exc:
            last_error = exc
            if not _is_empty_response_error(exc):
                raise

    if last_error is None:
        last_error = GenerationFailure(EMPTY_JSON_RESPONSE_ERROR)
    raise last_error


def _build_repair_prompt(
    output_schema: Type[BaseModel],
    repair_focus: str,
    structured_error: Exception | None,
    raw_error: Exception | None,
    raw_response: object,
) -> str:
    field_names = ", ".join(output_schema.model_fields.keys())
    previous = str(raw_response or "").strip()
    if len(previous) > 4000:
        previous = previous[:4000] + "\n...[truncated]"

    return (
        "你上一条回复没有通过 JSON schema 校验。请保持原意不变，只修正结构，并且只返回 JSON，不要附带解释、Markdown 或代码块。\n"
        f"目标 schema: {output_schema.__name__}\n"
        f"顶层字段: {field_names}\n"
        f"修正重点: {repair_focus}\n"
        f"结构化错误: {structured_error}\n"
        f"原始解析错误: {raw_error}\n"
        "上一条回复如下：\n"
        f"{previous}"
    )


def _build_empty_response_retry_prompt(output_schema: Type[BaseModel], repair_focus: str) -> str:
    field_names = ", ".join(output_schema.model_fields.keys())
    return (
        "你上一条回复是空的，没有返回任何 JSON 内容。"
        "请直接返回一个完整、可解析的 JSON 对象，不要附带解释、Markdown、代码块或空白文本。\n"
        f"目标 schema: {output_schema.__name__}\n"
        f"顶层字段: {field_names}\n"
        f"修正重点: {repair_focus}"
    )
