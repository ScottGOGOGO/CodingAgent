from pydantic import BaseModel

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
