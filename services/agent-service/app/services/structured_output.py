from __future__ import annotations

from typing import Sequence, Type, TypeVar

from langchain_core.messages import BaseMessage, HumanMessage
from pydantic import BaseModel

from app.services.errors import GenerationFailure
from app.services.json_parser import parse_json_response


SchemaT = TypeVar("SchemaT", bound=BaseModel)


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
        if isinstance(result, output_schema):
            return result
        return output_schema.model_validate(result)
    except Exception as exc:
        structured_error = exc

    try:
        response = model.invoke(message_list)
        raw_response = getattr(response, "content", response)
        parsed = parse_json_response(raw_response, output_schema)
        if isinstance(parsed, output_schema):
            return parsed
        return output_schema.model_validate(parsed)
    except Exception as exc:
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
        if isinstance(parsed, output_schema):
            return parsed
        return output_schema.model_validate(parsed)
    except Exception as repair_exc:
        raise GenerationFailure(
            "结构化输出失败，原始 JSON 回退失败，自动纠错重试仍失败："
            f" structured={structured_error}; raw={raw_error}; repair={repair_exc}"
        ) from repair_exc


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
