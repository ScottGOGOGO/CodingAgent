from __future__ import annotations

import logging
import time
from typing import Sequence, Type, TypeVar

from langchain_core.messages import BaseMessage, HumanMessage
from pydantic import BaseModel

from app.services.errors import GenerationFailure
from app.services.invoke_timeout import ModelInvokeTimeoutError, invoke_with_hard_timeout
from app.services.json_parser import EMPTY_JSON_RESPONSE_ERROR, parse_json_response


SchemaT = TypeVar("SchemaT", bound=BaseModel)
EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 2
TRANSPORT_RECOVERY_ATTEMPTS = 2
logger = logging.getLogger("vide.agent.stages")


def invoke_structured_json(
    model: object,
    messages: Sequence[BaseMessage],
    output_schema: Type[SchemaT],
    repair_focus: str,
    structured_output_method: str = "json_mode",
    timeout_seconds: float | None = None,
    invocation_name: str | None = None,
) -> SchemaT:
    message_list = list(messages)
    schema_name = output_schema.__name__
    stage_name = invocation_name or schema_name
    structured_error: Exception | None = None
    raw_error: Exception | None = None
    raw_response: object = None

    for attempt in range(1, TRANSPORT_RECOVERY_ATTEMPTS + 1):
        started_at = time.perf_counter()
        try:
            prepared_model, prepared_messages = _prepare_structured_model_for_invoke(
                model,
                message_list,
                output_schema=output_schema,
                structured_output_method=structured_output_method,
            )
            result = invoke_with_hard_timeout(
                lambda: prepared_model.invoke(prepared_messages),
                timeout_seconds=timeout_seconds,
                timeout_message=f"{stage_name} 结构化调用在 {timeout_seconds} 秒内没有返回。",
            )
            parsed = _coerce_result(result, output_schema)
            _log_event(
                "structured_success",
                schema_name=schema_name,
                invocation_name=stage_name,
                attempt=attempt,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
            )
            return parsed
        except Exception as exc:
            structured_error = exc
            transport = _is_transport_failure(exc)
            _log_event(
                "structured_failed",
                schema_name=schema_name,
                invocation_name=stage_name,
                attempt=attempt,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                transport=transport,
                error=_compact_error(exc),
            )
            if not transport or attempt >= TRANSPORT_RECOVERY_ATTEMPTS:
                break

    for attempt in range(1, TRANSPORT_RECOVERY_ATTEMPTS + 1):
        started_at = time.perf_counter()
        try:
            prepared_model, prepared_messages = _prepare_raw_model_for_invoke(model, message_list)
            response = invoke_with_hard_timeout(
                lambda: prepared_model.invoke(prepared_messages),
                timeout_seconds=timeout_seconds,
                timeout_message=f"{stage_name} 原始 JSON 调用在 {timeout_seconds} 秒内没有返回。",
            )
            raw_response = getattr(response, "content", response)
            parsed = parse_json_response(raw_response, output_schema)
            normalized = _coerce_result(parsed, output_schema)
            _log_event(
                "raw_success",
                schema_name=schema_name,
                invocation_name=stage_name,
                attempt=attempt,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
            )
            return normalized
        except Exception as exc:
            raw_error = exc
            transport = _is_transport_failure(exc)
            empty_response = _is_empty_response_error(exc)
            _log_event(
                "raw_failed",
                schema_name=schema_name,
                invocation_name=stage_name,
                attempt=attempt,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                transport=transport,
                empty_response=empty_response,
                error=_compact_error(exc),
            )
            if empty_response:
                try:
                    parsed, raw_response = _retry_empty_response(
                        model=model,
                        messages=message_list,
                        output_schema=output_schema,
                        repair_focus=repair_focus,
                        schema_name=schema_name,
                        timeout_seconds=timeout_seconds,
                        invocation_name=stage_name,
                    )
                    _log_event("raw_empty_response_recovered", schema_name=schema_name, invocation_name=stage_name, attempt=attempt)
                    return parsed
                except Exception as retry_exc:
                    raw_error = retry_exc
                    _log_event(
                        "raw_empty_response_recovery_failed",
                        schema_name=schema_name,
                        invocation_name=stage_name,
                        attempt=attempt,
                        error=_compact_error(retry_exc),
                    )
            if not transport or attempt >= TRANSPORT_RECOVERY_ATTEMPTS:
                break

    repair_prompt = HumanMessage(
        content=_build_repair_prompt(
            output_schema=output_schema,
            repair_focus=repair_focus,
            structured_error=structured_error,
            raw_error=raw_error,
            raw_response=raw_response,
        )
    )

    repair_exc: Exception | None = None
    for attempt in range(1, TRANSPORT_RECOVERY_ATTEMPTS + 1):
        started_at = time.perf_counter()
        try:
            repair_messages = [*message_list, repair_prompt]
            prepared_model, prepared_messages = _prepare_raw_model_for_invoke(model, repair_messages)
            repaired_response = invoke_with_hard_timeout(
                lambda: prepared_model.invoke(prepared_messages),
                timeout_seconds=timeout_seconds,
                timeout_message=f"{stage_name} 修复提示调用在 {timeout_seconds} 秒内没有返回。",
            )
            repaired_content = getattr(repaired_response, "content", repaired_response)
            parsed = parse_json_response(repaired_content, output_schema)
            normalized = _coerce_result(parsed, output_schema)
            _log_event(
                "repair_success",
                schema_name=schema_name,
                invocation_name=stage_name,
                attempt=attempt,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
            )
            return normalized
        except Exception as exc:
            repair_exc = exc
            transport = _is_transport_failure(exc)
            empty_response = _is_empty_response_error(exc)
            _log_event(
                "repair_failed",
                schema_name=schema_name,
                invocation_name=stage_name,
                attempt=attempt,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                transport=transport,
                empty_response=empty_response,
                error=_compact_error(exc),
            )
            if empty_response:
                try:
                    parsed, _ = _retry_empty_response(
                        model=model,
                        messages=[*message_list, repair_prompt],
                        output_schema=output_schema,
                        repair_focus=repair_focus,
                        schema_name=schema_name,
                        timeout_seconds=timeout_seconds,
                        invocation_name=stage_name,
                    )
                    _log_event("repair_empty_response_recovered", schema_name=schema_name, invocation_name=stage_name, attempt=attempt)
                    return parsed
                except Exception as retry_exc:
                    repair_exc = retry_exc
                    _log_event(
                        "repair_empty_response_recovery_failed",
                        schema_name=schema_name,
                        invocation_name=stage_name,
                        attempt=attempt,
                        error=_compact_error(retry_exc),
                    )
            if not transport or attempt >= TRANSPORT_RECOVERY_ATTEMPTS:
                break

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


def _is_transport_failure(error: Exception) -> bool:
    if isinstance(error, ModelInvokeTimeoutError):
        return True

    message = str(error).lower()
    markers = (
        "connection error",
        "apiconnectionerror",
        "server disconnected",
        "remoteprotocolerror",
        "timed out",
        "timeout error",
        "read timeout",
        "connect timeout",
        "headers timeout",
        "body timeout",
        "connection reset",
        "connection aborted",
        "unable to connect",
    )
    return any(marker in message for marker in markers)


def _retry_empty_response(
    model: object,
    messages: Sequence[BaseMessage],
    output_schema: Type[SchemaT],
    repair_focus: str,
    schema_name: str,
    timeout_seconds: float | None,
    invocation_name: str,
) -> tuple[SchemaT, object]:
    last_error: Exception | None = None
    last_response: object = None
    base_messages = list(messages)

    for attempt in range(EMPTY_RESPONSE_RECOVERY_ATTEMPTS):
        started_at = time.perf_counter()
        attempt_messages = list(base_messages)
        if attempt == EMPTY_RESPONSE_RECOVERY_ATTEMPTS - 1:
            attempt_messages.append(
                HumanMessage(content=_build_empty_response_retry_prompt(output_schema, repair_focus))
            )
        try:
            prepared_model, prepared_messages = _prepare_raw_model_for_invoke(model, attempt_messages)
            response = invoke_with_hard_timeout(
                lambda: prepared_model.invoke(prepared_messages),
                timeout_seconds=timeout_seconds,
                timeout_message=f"{invocation_name} 空响应重试在 {timeout_seconds} 秒内没有返回。",
            )
            last_response = getattr(response, "content", response)
            parsed = parse_json_response(last_response, output_schema)
            normalized = _coerce_result(parsed, output_schema)
            _log_event(
                "empty_retry_success",
                schema_name=schema_name,
                invocation_name=invocation_name,
                attempt=attempt + 1,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
            )
            return normalized, last_response
        except Exception as exc:
            last_error = exc
            _log_event(
                "empty_retry_failed",
                schema_name=schema_name,
                invocation_name=invocation_name,
                attempt=attempt + 1,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                transport=_is_transport_failure(exc),
                error=_compact_error(exc),
            )
            if not _is_empty_response_error(exc):
                raise

    if last_error is None:
        last_error = GenerationFailure(EMPTY_JSON_RESPONSE_ERROR)
    raise last_error


def _compact_error(error: Exception | None) -> str:
    text = str(error or "").strip()
    if len(text) > 240:
        return text[:240] + "...[truncated]"
    return text


def _prepare_structured_model_for_invoke(
    model: object,
    messages: Sequence[BaseMessage],
    output_schema: Type[SchemaT],
    structured_output_method: str,
) -> tuple[object, list[BaseMessage]]:
    message_list = list(messages)
    structured_model = model.with_structured_output(output_schema, method=structured_output_method)
    if not _uses_responses_api(model):
        return structured_model, message_list

    instructions, remaining_messages = _extract_responses_instructions(message_list)
    if not instructions or not remaining_messages:
        return structured_model, message_list

    bind = getattr(structured_model, "bind", None)
    if not callable(bind):
        model_bind = getattr(model, "bind", None)
        if not callable(model_bind):
            return structured_model, message_list
        bound_model = model_bind(instructions=instructions)
        return bound_model.with_structured_output(output_schema, method=structured_output_method), remaining_messages

    return bind(instructions=instructions), remaining_messages


def _prepare_raw_model_for_invoke(model: object, messages: Sequence[BaseMessage]) -> tuple[object, list[BaseMessage]]:
    message_list = list(messages)
    cloned_model = _clone_without_responses_api(model)
    if cloned_model is not model:
        return cloned_model, message_list

    if not _uses_responses_api(model):
        return model, message_list

    instructions, remaining_messages = _extract_responses_instructions(message_list)
    if not instructions or not remaining_messages:
        return model, message_list

    bind = getattr(model, "bind", None)
    if not callable(bind):
        return model, message_list

    return bind(instructions=instructions), remaining_messages


def _clone_without_responses_api(model: object) -> object:
    if not _uses_responses_api(model):
        return model

    model_copy = getattr(model, "model_copy", None)
    if not callable(model_copy):
        return model

    try:
        return model_copy(update={"use_responses_api": False, "output_version": "v0"})
    except TypeError:
        return model


def _uses_responses_api(model: object) -> bool:
    checker = getattr(model, "_use_responses_api", None)
    if callable(checker):
        try:
            return bool(checker({}))
        except TypeError:
            try:
                return bool(checker())
            except TypeError:
                pass
    configured = getattr(model, "use_responses_api", None)
    if isinstance(configured, bool):
        return configured
    return getattr(model, "output_version", None) == "responses/v1"


def _extract_responses_instructions(messages: Sequence[BaseMessage]) -> tuple[str, list[BaseMessage]]:
    instructions_parts: list[str] = []
    remaining_messages: list[BaseMessage] = []
    still_collecting = True

    for message in messages:
        role = _message_role(message)
        if still_collecting and role in {"system", "developer"}:
            text = _message_text_content(message)
            if text:
                instructions_parts.append(text)
            continue

        still_collecting = False
        remaining_messages.append(message)

    return "\n\n".join(instructions_parts).strip(), remaining_messages


def _message_role(message: BaseMessage) -> str:
    role = getattr(message, "role", None)
    if isinstance(role, str) and role:
        return role.strip().lower()

    message_type = getattr(message, "type", None)
    if message_type == "human":
        return "user"
    if message_type == "ai":
        return "assistant"
    if isinstance(message_type, str):
        return message_type.strip().lower()
    return ""


def _message_text_content(message: BaseMessage) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                normalized = block.strip()
                if normalized:
                    parts.append(normalized)
                continue
            if isinstance(block, dict):
                text = block.get("text")
                if text:
                    parts.append(str(text).strip())
        return "\n".join(part for part in parts if part).strip()
    return str(content).strip()


def _log_event(stage: str, **fields: object) -> None:
    payload = {
        "stage": f"structured_output_{stage}",
        **{key: value for key, value in fields.items() if value is not None},
    }
    logger.info(" ".join(f"{key}={value}" for key, value in payload.items()))


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
