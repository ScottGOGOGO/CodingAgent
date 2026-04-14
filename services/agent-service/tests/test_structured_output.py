import time

import pytest
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from app.config import get_settings
from app.services.structured_output import invoke_structured_json


class SampleSchema(BaseModel):
    action: str
    summary: str


class FakeResponse:
    def __init__(self, content):
        self.content = content


class FakeModel:
    def __init__(self) -> None:
        self.raw_calls = 0

    def with_structured_output(self, schema, method=None):
        class Invoker:
            def invoke(self_inner, messages):
                raise RuntimeError("structured output failed")

        return Invoker()

    def invoke(self, messages):
        self.raw_calls += 1
        if self.raw_calls == 1:
            return FakeResponse('{"action": "ready", "summary": {"text": "结构不对"}}')
        return FakeResponse('{"action": "ready", "summary": "自动纠错成功"}')


def test_invoke_structured_json_retries_with_repair_prompt() -> None:
    model = FakeModel()

    result = invoke_structured_json(
        model=model,
        messages=[],
        output_schema=SampleSchema,
        repair_focus="确保 summary 是字符串。",
    )

    assert result.action == "ready"
    assert result.summary == "自动纠错成功"
    assert model.raw_calls == 2


def test_invoke_structured_json_retries_after_empty_raw_response() -> None:
    class EmptyThenSuccessModel:
        def __init__(self) -> None:
            self.raw_calls = 0

        def with_structured_output(self, schema, method=None):
            class Invoker:
                def invoke(self_inner, messages):
                    raise RuntimeError("structured output failed")

            return Invoker()

        def invoke(self, messages):
            self.raw_calls += 1
            if self.raw_calls == 1:
                return FakeResponse("")
            return FakeResponse('{"action": "ready", "summary": "空响应后自动恢复"}')

    model = EmptyThenSuccessModel()

    result = invoke_structured_json(
        model=model,
        messages=[],
        output_schema=SampleSchema,
        repair_focus="确保 summary 是字符串。",
    )

    assert result.action == "ready"
    assert result.summary == "空响应后自动恢复"
    assert model.raw_calls == 2


def test_invoke_structured_json_retries_after_empty_repair_response() -> None:
    class RepairEmptyThenSuccessModel:
        def __init__(self) -> None:
            self.raw_calls = 0

        def with_structured_output(self, schema, method=None):
            class Invoker:
                def invoke(self_inner, messages):
                    raise RuntimeError("structured output failed")

            return Invoker()

        def invoke(self, messages):
            self.raw_calls += 1
            if self.raw_calls == 1:
                return FakeResponse('{"action": "ready", "summary": {"text": "结构不对"}}')
            if self.raw_calls == 2:
                return FakeResponse("")
            return FakeResponse('{"action": "ready", "summary": "修复阶段空响应后恢复"}')

    model = RepairEmptyThenSuccessModel()

    result = invoke_structured_json(
        model=model,
        messages=[],
        output_schema=SampleSchema,
        repair_focus="确保 summary 是字符串。",
    )

    assert result.action == "ready"
    assert result.summary == "修复阶段空响应后恢复"
    assert model.raw_calls == 3


def test_invoke_structured_json_retries_transport_failures_before_repair() -> None:
    class TransportThenSuccessModel:
        def __init__(self) -> None:
            self.structured_calls = 0
            self.raw_calls = 0

        def with_structured_output(self, schema, method=None):
            outer = self

            class Invoker:
                def invoke(self_inner, messages):
                    outer.structured_calls += 1
                    raise RuntimeError("Connection error.")

            return Invoker()

        def invoke(self, messages):
            self.raw_calls += 1
            if self.raw_calls == 1:
                raise RuntimeError("Connection error.")
            return FakeResponse('{"action": "ready", "summary": "传输重试后恢复"}')

    model = TransportThenSuccessModel()

    result = invoke_structured_json(
        model=model,
        messages=[],
        output_schema=SampleSchema,
        repair_focus="确保 summary 是字符串。",
    )

    assert result.action == "ready"
    assert result.summary == "传输重试后恢复"
    assert model.structured_calls == 2
    assert model.raw_calls == 2


def test_invoke_structured_json_fails_fast_on_hard_timeout(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_TIMEOUT_SECONDS", "90")
    get_settings.cache_clear()

    class HangingModel:
        def with_structured_output(self, schema, method=None):
            class Invoker:
                def invoke(self_inner, messages):
                    time.sleep(0.2)
                    return {"action": "ready", "summary": "不会返回"}

            return Invoker()

        def invoke(self, messages):
            time.sleep(0.2)
            return FakeResponse('{"action": "ready", "summary": "不会返回"}')

    started_at = time.perf_counter()
    with pytest.raises(Exception, match="没有返回"):
        invoke_structured_json(
            model=HangingModel(),
            messages=[],
            output_schema=SampleSchema,
            repair_focus="确保 summary 是字符串。",
            timeout_seconds=0.05,
            invocation_name="clarifier",
        )
    assert time.perf_counter() - started_at < 0.5


def test_invoke_structured_json_can_use_json_schema_for_gpt5_style_models() -> None:
    class JsonSchemaModel:
        def __init__(self) -> None:
            self.methods = []

        def with_structured_output(self, schema, method=None):
            self.methods.append(method)

            class Invoker:
                def invoke(self_inner, messages):
                    return {"action": "ready", "summary": "json_schema 可用"}

            return Invoker()

        def invoke(self, messages):
            raise AssertionError("structured path should have succeeded")

    model = JsonSchemaModel()

    result = invoke_structured_json(
        model=model,
        messages=[],
        output_schema=SampleSchema,
        repair_focus="确保 summary 是字符串。",
        structured_output_method="json_schema",
    )

    assert result.action == "ready"
    assert result.summary == "json_schema 可用"
    assert model.methods == ["json_schema"]


def test_invoke_structured_json_parses_responses_content_with_reasoning_blocks() -> None:
    class ResponsesContentModel:
        def with_structured_output(self, schema, method=None):
            class Invoker:
                def invoke(self_inner, messages):
                    raise RuntimeError("structured output failed")

            return Invoker()

        def invoke(self, messages):
            return FakeResponse(
                [
                    {
                        "id": "rs_reasoning",
                        "summary": [],
                        "type": "reasoning",
                    },
                    {
                        "type": "output_text",
                        "text": '{"action": "ask", "summary": "还需要确认旅行偏好"}',
                    },
                ]
            )

    result = invoke_structured_json(
        model=ResponsesContentModel(),
        messages=[],
        output_schema=SampleSchema,
        repair_focus="确保 summary 是字符串。",
    )

    assert result.action == "ask"
    assert result.summary == "还需要确认旅行偏好"


def test_invoke_structured_json_extracts_responses_instructions_for_structured_calls() -> None:
    class ResponsesStructuredModel:
        def __init__(self) -> None:
            self.bound_kwargs = []
            self.structured_messages = []
            self.use_responses_api = True
            self.output_version = "responses/v1"

        def bind(self, **kwargs):
            self.bound_kwargs.append(kwargs)
            return self

        def with_structured_output(self, schema, method=None):
            outer = self

            class Invoker:
                def invoke(self_inner, messages):
                    outer.structured_messages.append(messages)
                    return {"action": "ready", "summary": "structured 成功"}

            return Invoker()

        def invoke(self, messages):
            raise AssertionError("structured path should have succeeded")

    model = ResponsesStructuredModel()
    messages = [
        SystemMessage(content="你是一个严谨的规划助手。"),
        HumanMessage(content="帮我生成旅行规划。"),
    ]

    result = invoke_structured_json(
        model=model,
        messages=messages,
        output_schema=SampleSchema,
        repair_focus="确保 summary 是字符串。",
        structured_output_method="json_schema",
    )

    assert result.action == "ready"
    assert model.bound_kwargs == [{"instructions": "你是一个严谨的规划助手。"}]
    assert len(model.structured_messages) == 1
    assert [message.content for message in model.structured_messages[0]] == ["帮我生成旅行规划。"]


def test_invoke_structured_json_extracts_responses_instructions_for_raw_and_repair_calls() -> None:
    class ResponsesRepairModel:
        def __init__(self) -> None:
            self.bound_kwargs = []
            self.invoke_messages = []
            self.use_responses_api = True
            self.output_version = "responses/v1"
            self.raw_calls = 0

        def bind(self, **kwargs):
            self.bound_kwargs.append(kwargs)
            return self

        def with_structured_output(self, schema, method=None):
            class Invoker:
                def invoke(self_inner, messages):
                    raise RuntimeError("structured output failed")

            return Invoker()

        def invoke(self, messages):
            self.invoke_messages.append(messages)
            self.raw_calls += 1
            if self.raw_calls == 1:
                return FakeResponse('{"action": "ready", "summary": {"text": "结构不对"}}')
            return FakeResponse('{"action": "ready", "summary": "repair 成功"}')

    model = ResponsesRepairModel()
    messages = [
        SystemMessage(content="所有回复都要返回 JSON。"),
        HumanMessage(content="给我一个结果。"),
    ]

    result = invoke_structured_json(
        model=model,
        messages=messages,
        output_schema=SampleSchema,
        repair_focus="确保 summary 是字符串。",
    )

    assert result.summary == "repair 成功"
    assert model.bound_kwargs == [
        {"instructions": "所有回复都要返回 JSON。"},
        {"instructions": "所有回复都要返回 JSON。"},
        {"instructions": "所有回复都要返回 JSON。"},
    ]
    assert len(model.invoke_messages) == 2
    assert [message.content for message in model.invoke_messages[0]] == ["给我一个结果。"]
    assert isinstance(model.invoke_messages[1][-1], HumanMessage)
    assert "只返回 JSON" in model.invoke_messages[1][-1].content


def test_invoke_structured_json_prefers_chat_completion_clone_for_raw_responses_fallback() -> None:
    class ChatFallbackModel:
        def __init__(self, use_responses_api=True, output_version="responses/v1") -> None:
            self.use_responses_api = use_responses_api
            self.output_version = output_version
            self.fallback_model = None
            self.invoke_messages = []

        def with_structured_output(self, schema, method=None):
            class Invoker:
                def invoke(self_inner, messages):
                    raise RuntimeError("structured output failed")

            return Invoker()

        def bind(self, **kwargs):
            raise AssertionError("raw fallback should clone away from responses before binding instructions")

        def model_copy(self, update):
            clone = ChatFallbackModel(
                use_responses_api=update.get("use_responses_api", self.use_responses_api),
                output_version=update.get("output_version", self.output_version),
            )
            self.fallback_model = clone
            return clone

        def invoke(self, messages):
            if self.use_responses_api:
                raise AssertionError("responses model should not be used for raw fallback")
            self.invoke_messages.append(messages)
            return FakeResponse('{"action": "ready", "summary": "chat fallback 成功"}')

    model = ChatFallbackModel()
    messages = [
        SystemMessage(content="保持 JSON 输出。"),
        HumanMessage(content="生成结果。"),
    ]

    result = invoke_structured_json(
        model=model,
        messages=messages,
        output_schema=SampleSchema,
        repair_focus="确保 summary 是字符串。",
    )

    assert result.summary == "chat fallback 成功"
    assert model.fallback_model is not None
    assert model.fallback_model.use_responses_api is False
    assert model.fallback_model.output_version == "v0"
    assert len(model.fallback_model.invoke_messages) == 1
    assert [message.content for message in model.fallback_model.invoke_messages[0]] == ["保持 JSON 输出。", "生成结果。"]
