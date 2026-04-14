from langchain_core.messages import HumanMessage, SystemMessage

from app.models import (
    AgentSessionState,
    AppSpec,
    ChatMessage,
    ChatRole,
    DataModelNeed,
    DesignTargets,
    FileOperation,
    FlowSpec,
    GeneratedCodeOutput,
    ProjectStatus,
    ReasoningMode,
    ScreenSpec,
    StructuredFileOperationOutput,
    StructuredGeneratedCodeOutput,
    WorkspaceFile,
)
from app.services.codegen import CodeGenerationService
from app.services.errors import GenerationFailure
import pytest


def _build_codegen_state() -> AgentSessionState:
    return AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        messages=[
            ChatMessage(
                id="m1",
                role=ChatRole.USER,
                content="帮我生成一个最简单的待办清单 web 应用",
                createdAt="2026-03-26T00:00:00Z",
            )
        ],
    )


def _build_codegen_spec() -> AppSpec:
    return AppSpec(
        appName="todo-lite",
        title="待办清单",
        summary="一个最简单的待办清单 Web 应用",
        goal="让用户添加、勾选和删除待办事项",
        targetUsers=["个人用户"],
        screens=[ScreenSpec(id="home", name="首页", purpose="管理待办事项", elements=["输入框", "列表", "筛选"])],
        coreFlows=[FlowSpec(id="todo-flow", name="待办管理", steps=["添加待办", "完成待办"], success="用户可以顺利管理任务")],
        dataModelNeeds=[
            DataModelNeed(entity="Todo", fields=["id (string)", "title (string)", "completed (boolean)"], notes="使用本地状态"),
        ],
        integrations=[],
        brandAndVisualDirection="简洁现代",
        designTargets=DesignTargets(
            visualMood="简洁现代",
            layoutEnergy="聚焦单任务",
            colorStrategy="清爽蓝白",
            componentTone="轻量卡片",
            motionIntensity="低",
            interactionFocus=["任务输入", "状态反馈"],
        ),
        constraints=["使用 React + Vite TypeScript"],
        successCriteria=["可以添加、勾选和删除待办"],
        assumptions=["使用本地状态管理"],
    )


def test_codegen_normalizes_patch_alias_and_run_dependency_command() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="package.json",
            content='{\n  "name": "demo",\n  "dependencies": {\n    "react": "^18.3.1"\n  }\n}\n',
        ),
        WorkspaceFile(
            path="src/App.tsx",
            content="export default function App() { return <div>Hello</div>; }\n",
        ),
    ]

    generation = StructuredGeneratedCodeOutput(
        assistantSummary="Repair dependencies and update the app.",
        operations=[
            StructuredFileOperationOutput(
                op="patch",
                path="src/App.tsx",
                summary="Update the app component.",
                content="export default function App() { return <div>Updated</div>; }\n",
            ),
            StructuredFileOperationOutput(
                op="run",
                command="npm install react-router-dom",
            ),
        ],
    )

    normalized = service._normalize_generation_output(generation, context_snapshot)

    assert normalized.assistant_summary == "Repair dependencies and update the app."
    assert normalized.operations[0].type == "write"
    assert normalized.operations[0].path == "src/App.tsx"
    assert "Updated" in (normalized.operations[0].content or "")
    assert normalized.operations[1].path == "package.json"
    assert '"react-router-dom": "latest"' in (normalized.operations[1].content or "")


def test_codegen_infers_operation_types_from_common_aliases() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="package.json",
            content='{\n  "name": "demo",\n  "dependencies": {\n    "react": "^18.3.1"\n  }\n}\n',
        ),
        WorkspaceFile(
            path="src/App.tsx",
            content="export default function App() { return <div>Hello</div>; }\n",
        ),
    ]

    generation = StructuredGeneratedCodeOutput.model_validate(
        {
            "assistantSummary": "Fix syntax and install routing.",
            "operations": [
                {
                    "action": "rewrite",
                    "file": "src/App.tsx",
                    "description": "Rewrite the broken app component.",
                    "code": "export default function App() { return <div>Fixed</div>; }\n",
                },
                {
                    "script": "npm install react-router-dom",
                },
            ],
        }
    )

    normalized = service._normalize_generation_output(generation, context_snapshot)

    assert normalized.operations[0].type == "write"
    assert normalized.operations[0].path == "src/App.tsx"
    assert "Fixed" in (normalized.operations[0].content or "")
    assert normalized.operations[1].path == "package.json"
    assert '"react-router-dom": "latest"' in (normalized.operations[1].content or "")


def test_codegen_polishes_video_placeholder_copy() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/App.tsx",
            content="export default function App() { return <div>Hello</div>; }\n",
        ),
    ]

    generation = StructuredGeneratedCodeOutput.model_validate(
        {
            "operations": [
                {
                    "type": "write",
                    "path": "src/App.tsx",
                    "content": "export default function App() { return <p>[Video placeholder: Serve demo]</p>; }\n",
                }
            ],
        }
    )

    normalized = service._normalize_generation_output(generation, context_snapshot)

    assert "视频课程重点" in (normalized.operations[0].content or "")
    assert "placeholder" not in (normalized.operations[0].content or "").lower()


def test_codegen_accepts_value_alias_for_full_file_rewrites() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/pages/Home.tsx",
            content="export default function Home() { return <div>Old</div>; }\n",
        ),
    ]

    generation = StructuredGeneratedCodeOutput.model_validate(
        {
            "assistantSummary": "修复 Home 页面中的未使用状态 setter。",
            "operations": [
                {
                    "op": "modify",
                    "path": "src/pages/Home.tsx",
                    "value": "export default function Home() { return <div>Fixed</div>; }\n",
                }
            ],
        }
    )

    normalized = service._normalize_generation_output(generation, context_snapshot)

    assert normalized.operations[0].type == "write"
    assert normalized.operations[0].path == "src/pages/Home.tsx"
    assert "Fixed" in (normalized.operations[0].content or "")


def test_codegen_converts_unified_diff_content_into_patch() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/pages/Home.tsx",
            content=(
                "import { useState } from 'react';\n\n"
                "const Home = () => {\n"
                "  const [learningProgress, setLearningProgress] = useState(65);\n"
                "  return <div>{learningProgress}</div>;\n"
                "};\n"
            ),
        ),
    ]

    generation = StructuredGeneratedCodeOutput.model_validate(
        {
            "assistantSummary": "修复未使用的 setter。",
            "operations": [
                {
                    "op": "modify",
                    "path": "src/pages/Home.tsx",
                    "value": (
                        "@@ -3,3 +3,3 @@\n"
                        " const Home = () => {\n"
                        "-  const [learningProgress, setLearningProgress] = useState(65);\n"
                        "+  const [learningProgress] = useState(65);\n"
                        "   return <div>{learningProgress}</div>;\n"
                        " };\n"
                    ),
                }
            ],
        }
    )

    normalized = service._normalize_generation_output(generation, context_snapshot)

    assert normalized.operations[0].type == "patch"
    assert normalized.operations[0].path == "src/pages/Home.tsx"
    assert normalized.operations[0].hunks[0].search == (
        "const Home = () => {\n"
        "  const [learningProgress, setLearningProgress] = useState(65);\n"
        "  return <div>{learningProgress}</div>;\n"
        "};\n"
    )
    assert normalized.operations[0].hunks[0].replace == (
        "const Home = () => {\n"
        "  const [learningProgress] = useState(65);\n"
        "  return <div>{learningProgress}</div>;\n"
        "};\n"
    )


def test_codegen_accepts_object_shaped_content_payloads() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/pages/Home.tsx",
            content="export default function Home() { return <div>Old</div>; }\n",
        ),
    ]

    generation = StructuredGeneratedCodeOutput.model_validate(
        {
            "operations": [
                {
                    "op": "modify",
                    "path": "src/pages/Home.tsx",
                    "content": {
                        "before": "export default function Home() { return <div>Old</div>; }\n",
                        "after": "export default function Home() { return <div>New</div>; }\n",
                    },
                }
            ],
        }
    )

    normalized = service._normalize_generation_output(generation, context_snapshot)

    assert normalized.operations[0].type == "patch"
    assert normalized.operations[0].path == "src/pages/Home.tsx"
    assert normalized.operations[0].hunks[0].search == "export default function Home() { return <div>Old</div>; }\n"
    assert normalized.operations[0].hunks[0].replace == "export default function Home() { return <div>New</div>; }\n"


def test_codegen_accepts_list_shaped_before_after_patch_hunks() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/pages/Home.tsx",
            content=(
                "export default function Home() {\n"
                "  return <div>Old</div>;\n"
                "}\n"
            ),
        ),
    ]

    generation = StructuredGeneratedCodeOutput.model_validate(
        {
            "operations": [
                {
                    "op": "patch",
                    "path": "src/pages/Home.tsx",
                    "hunks": {
                        "before": [
                            "export default function Home() {",
                            "  return <div>Old</div>;",
                            "}",
                        ],
                        "after": [
                            "export default function Home() {",
                            "  return <div>New</div>;",
                            "}",
                        ],
                    },
                }
            ],
        }
    )

    normalized = service._normalize_generation_output(generation, context_snapshot)

    assert normalized.operations[0].type == "patch"
    assert normalized.operations[0].path == "src/pages/Home.tsx"
    assert normalized.operations[0].hunks[0].search == (
        "export default function Home() {\n"
        "  return <div>Old</div>;\n"
        "}"
    )
    assert normalized.operations[0].hunks[0].replace == (
        "export default function Home() {\n"
        "  return <div>New</div>;\n"
        "}"
    )


def test_codegen_falls_back_to_raw_json_when_structured_output_normalizes_to_noop() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/pages/Home.tsx",
            content="export default function Home() { return <div>Old</div>; }\n",
        ),
    ]

    class FakeStructuredInvoker:
        def invoke(self, messages: object) -> StructuredGeneratedCodeOutput:
            return StructuredGeneratedCodeOutput.model_validate(
                {
                    "assistantSummary": "结构化输出丢失了关键信息。",
                    "operations": [
                        {
                            "type": "patch",
                            "path": "src/pages/Home.tsx",
                        }
                    ],
                }
            )

    class FakeModel:
        def with_structured_output(self, schema: object, method: str = "json_mode") -> FakeStructuredInvoker:
            return FakeStructuredInvoker()

        def invoke(self, messages: object) -> object:
            return type(
                "FakeResponse",
                (),
                {
                    "content": (
                        '{"assistantSummary":"原始 JSON 回退成功。","operations":'
                        '[{"op":"patch","path":"src/pages/Home.tsx","before":"export default function Home() { return <div>Old</div>; }\\n","after":"export default function Home() { return <div>Fixed</div>; }\\n"}]}'
                    )
                },
            )()

    normalized = service._invoke_and_normalize(FakeModel(), messages=[], context_snapshot=context_snapshot)

    assert normalized.assistant_summary == "原始 JSON 回退成功。"
    assert normalized.operations[0].type == "patch"
    assert normalized.operations[0].path == "src/pages/Home.tsx"
    assert normalized.operations[0].hunks[0].search == "export default function Home() { return <div>Old</div>; }\n"
    assert normalized.operations[0].hunks[0].replace == "export default function Home() { return <div>Fixed</div>; }\n"


def test_codegen_retries_after_empty_raw_json_response() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/pages/Home.tsx",
            content="export default function Home() { return <div>Old</div>; }\n",
        ),
    ]

    class FakeStructuredInvoker:
        def invoke(self, messages: object) -> StructuredGeneratedCodeOutput:
            return StructuredGeneratedCodeOutput.model_validate(
                {
                    "assistantSummary": "结构化输出丢失了关键信息。",
                    "operations": [
                        {
                            "type": "patch",
                            "path": "src/pages/Home.tsx",
                        }
                    ],
                }
            )

    class FakeModel:
        def __init__(self) -> None:
            self.raw_calls = 0

        def with_structured_output(self, schema: object, method: str = "json_mode") -> FakeStructuredInvoker:
            return FakeStructuredInvoker()

        def invoke(self, messages: object) -> object:
            self.raw_calls += 1
            if self.raw_calls == 1:
                return type("FakeResponse", (), {"content": ""})()
            return type(
                "FakeResponse",
                (),
                {
                    "content": (
                        '{"assistantSummary":"空响应后恢复。","operations":'
                        '[{"op":"patch","path":"src/pages/Home.tsx","before":"export default function Home() { return <div>Old</div>; }\\n","after":"export default function Home() { return <div>Fixed</div>; }\\n"}]}'
                    )
                },
            )()

    normalized = service._invoke_and_normalize(FakeModel(), messages=[], context_snapshot=context_snapshot)

    assert normalized.assistant_summary == "空响应后恢复。"
    assert normalized.operations[0].type == "patch"
    assert normalized.operations[0].hunks[0].replace == "export default function Home() { return <div>Fixed</div>; }\n"


def test_codegen_uses_raw_json_fallback_when_structured_transport_fails() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/App.tsx",
            content="export default function App() { return <div>Old</div>; }\n",
        ),
    ]

    class FakeStructuredInvoker:
        def invoke(self, messages: object) -> StructuredGeneratedCodeOutput:
            raise RuntimeError("Connection error.")

    class FakeModel:
        def with_structured_output(self, schema: object, method: str = "json_mode") -> FakeStructuredInvoker:
            return FakeStructuredInvoker()

        def invoke(self, messages: object) -> object:
            return type(
                "FakeResponse",
                (),
                {
                    "content": (
                        '{"assistantSummary":"raw 回退成功。","operations":'
                        '[{"op":"patch","path":"src/App.tsx","before":"export default function App() { return <div>Old</div>; }\\n","after":"export default function App() { return <div>Recovered</div>; }\\n"}]}'
                    )
                },
            )()

    normalized = service._invoke_and_normalize(FakeModel(), messages=[], context_snapshot=context_snapshot)

    assert normalized.assistant_summary == "raw 回退成功。"
    assert normalized.operations[0].type == "patch"
    assert normalized.operations[0].hunks[0].replace == "export default function App() { return <div>Recovered</div>; }\n"


def test_codegen_retries_raw_json_after_transport_failure() -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/App.tsx",
            content="export default function App() { return <div>Old</div>; }\n",
        ),
    ]

    class FakeStructuredInvoker:
        def invoke(self, messages: object) -> StructuredGeneratedCodeOutput:
            raise RuntimeError("Connection error.")

    class FakeModel:
        def __init__(self) -> None:
            self.raw_calls = 0

        def with_structured_output(self, schema: object, method: str = "json_mode") -> FakeStructuredInvoker:
            return FakeStructuredInvoker()

        def invoke(self, messages: object) -> object:
            self.raw_calls += 1
            if self.raw_calls == 1:
                raise RuntimeError("Connection error.")
            return type(
                "FakeResponse",
                (),
                {
                    "content": (
                        '{"assistantSummary":"transport 重试后恢复。","operations":'
                        '[{"op":"patch","path":"src/App.tsx","before":"export default function App() { return <div>Old</div>; }\\n","after":"export default function App() { return <div>Retried</div>; }\\n"}]}'
                    )
                },
            )()

    model = FakeModel()
    normalized = service._invoke_and_normalize(model, messages=[], context_snapshot=context_snapshot)

    assert model.raw_calls == 2
    assert normalized.assistant_summary == "transport 重试后恢复。"
    assert normalized.operations[0].hunks[0].replace == "export default function App() { return <div>Retried</div>; }\n"


def test_codegen_retries_structured_output_after_transport_failure(monkeypatch) -> None:
    service = CodeGenerationService()
    context_snapshot = [
        WorkspaceFile(
            path="src/App.tsx",
            content="export default function App() { return <div>Old</div>; }\n",
        ),
    ]
    monkeypatch.setattr(service, "_sleep_before_transport_retry", lambda *args, **kwargs: None)

    class FakeStructuredInvoker:
        def __init__(self, model: "FakeModel") -> None:
            self.model = model

        def invoke(self, messages: object) -> StructuredGeneratedCodeOutput:
            self.model.structured_calls += 1
            if self.model.structured_calls == 1:
                raise RuntimeError("Connection error.")
            return StructuredGeneratedCodeOutput.model_validate(
                {
                    "assistantSummary": "structured 重试后恢复。",
                    "operations": [
                        {
                            "type": "patch",
                            "path": "src/App.tsx",
                            "before": "export default function App() { return <div>Old</div>; }\n",
                            "after": "export default function App() { return <div>Structured</div>; }\n",
                        }
                    ],
                }
            )

    class FakeModel:
        def __init__(self) -> None:
            self.structured_calls = 0

        def with_structured_output(self, schema: object, method: str = "json_mode") -> FakeStructuredInvoker:
            return FakeStructuredInvoker(self)

        def invoke(self, messages: object) -> object:
            raise AssertionError("raw fallback should not be used when structured retry succeeds")

    model = FakeModel()
    normalized = service._invoke_and_normalize(model, messages=[], context_snapshot=context_snapshot)

    assert model.structured_calls == 2
    assert normalized.assistant_summary == "structured 重试后恢复。"
    assert normalized.operations[0].hunks[0].replace == "export default function App() { return <div>Structured</div>; }\n"


def test_bootstrap_generation_phase_delegates_to_generation_phase(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()
    captured: dict[str, object] = {}

    def fake_generation_phase(*, state, spec, context_snapshot, phase_name, phase_brief, conversation_limit, spec_payload=None):
        captured["phase_name"] = phase_name
        captured["context_paths"] = [item.path for item in context_snapshot]
        captured["conversation_limit"] = conversation_limit
        captured["spec_payload"] = spec_payload
        return GeneratedCodeOutput(
            assistantSummary="阶段一完成。",
            operations=[
                FileOperation(
                    type="write",
                    path="package.json",
                    summary="写入依赖配置",
                    content='{"name":"todo-lite"}\n',
                )
            ],
        )

    monkeypatch.setattr(service, "_invoke_generation_phase", fake_generation_phase)

    generation = service._invoke_bootstrap_generation_phase(
        state=state,
        spec=spec,
        context_snapshot=[],
        phase_name="bootstrap",
        phase_brief="生成首版可运行骨架。",
        conversation_limit=4,
        spec_payload=service._serialize_spec_for_bootstrap(spec),
    )

    assert generation.assistant_summary == "阶段一完成。"
    assert [operation.path for operation in generation.operations] == ["package.json"]
    assert captured["phase_name"] == "bootstrap"
    assert captured["context_paths"] == []
    assert captured["conversation_limit"] == 4
    assert captured["spec_payload"] == service._serialize_spec_for_bootstrap(spec)


def test_codegen_uses_replace_as_fallback_for_full_file_before_after_patch() -> None:
    service = CodeGenerationService()
    existing = (
        "import React from 'react';\n\n"
        "const Home = () => {\n"
        "  const [learningProgress, setLearningProgress] = React.useState(35);\n"
        "  return <div>{learningProgress}</div>;\n"
        "};\n\n"
        "export default Home;\n"
    )
    before = (
        "import { useState } from 'react';\n\n"
        "const Home = () => {\n"
        "  const [learningProgress, setLearningProgress] = useState(0);\n"
        "  return <div>{learningProgress}</div>;\n"
        "};\n\n"
        "export default Home;\n"
    )
    after = (
        "import { useState } from 'react';\n\n"
        "const Home = () => {\n"
        "  const [learningProgress] = useState(0);\n"
        "  return <div>{learningProgress}</div>;\n"
        "};\n\n"
        "export default Home;\n"
    )

    generation = StructuredGeneratedCodeOutput.model_validate(
        {
            "operations": [
                {
                    "op": "patch",
                    "path": "src/pages/Home.tsx",
                    "before": before,
                    "after": after,
                }
            ],
        }
    )

    normalized = service._normalize_generation_output(
        generation,
        [WorkspaceFile(path="src/pages/Home.tsx", content=existing)],
    )

    assert normalized.operations[0].type == "patch"
    assert normalized.operations[0].hunks[0].search == before
    assert normalized.operations[0].hunks[0].replace == after
    assert normalized.operations[0].fallback_content == after


def test_codegen_raises_on_transport_failure_for_fresh_app(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()

    def fail_bootstrap(*args, **kwargs):
        raise GenerationFailure("代码生成阶段调用模型失败：Connection error.")

    monkeypatch.setattr(service, "_invoke_bootstrap_phase", fail_bootstrap)

    with pytest.raises(GenerationFailure, match="Connection error"):
        service._invoke_generation(state, spec, [])


def test_codegen_raises_on_structured_output_exhaustion_for_fresh_app(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()

    def fail_bootstrap(*args, **kwargs):
        raise GenerationFailure("代码生成阶段调用模型失败：模型返回了空响应。")

    monkeypatch.setattr(service, "_invoke_bootstrap_phase", fail_bootstrap)

    with pytest.raises(GenerationFailure, match="空响应"):
        service._invoke_generation(state, spec, [])


def test_codegen_preserves_model_output_for_fresh_app_when_transport_succeeds(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state().model_copy(update={"sessionId": "session-2", "projectId": "project-2"})
    spec = _build_codegen_spec()

    def fake_generation(*args, **kwargs):
        return GeneratedCodeOutput(
            assistantSummary="只返回了一个不完整的占位页面。",
            operations=[
                FileOperation(
                    type="write",
                    path="src/App.tsx",
                    summary="写入占位页面。",
                    content="export default function App() { return <div>待实现</div>; }\n",
                )
            ],
        )

    monkeypatch.setattr(service, "_invoke_generation", fake_generation)

    next_state = service.generate(state, spec, [])

    assert [operation.path for operation in next_state.file_operations] == ["src/App.tsx"]
    assert next_state.file_operations[0].content == "export default function App() { return <div>待实现</div>; }\n"
    assert next_state.assistant_summary == "只返回了一个不完整的占位页面。"


def test_codegen_uses_staged_generation_for_fresh_app(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()
    bootstrap_calls: list[list[str]] = []
    enrichment_calls: list[list[str]] = []

    def fake_bootstrap_phase(*args, **kwargs):
        context_snapshot = kwargs.get("context_snapshot", args[2])
        bootstrap_calls.append([item.path for item in context_snapshot])
        return GeneratedCodeOutput(
            assistantSummary="基础骨架已完成。",
            operations=[
                FileOperation(
                    type="write",
                    path="package.json",
                    summary="写入依赖配置",
                    content='{"name":"todo-lite"}\n',
                ),
                FileOperation(
                    type="write",
                    path="index.html",
                    summary="写入 HTML 入口",
                    content="<html><body><div id='root'></div></body></html>\n",
                ),
                FileOperation(
                    type="write",
                    path="src/main.tsx",
                    summary="写入 React 入口",
                    content="export {};\n",
                ),
                FileOperation(
                    type="write",
                    path="src/index.css",
                    summary="写入全局样式",
                    content="body { margin: 0; }\n",
                ),
                FileOperation(
                    type="write",
                    path="src/App.tsx",
                    summary="写入初始页面",
                    content="export default function App() { return <main>基础骨架</main>; }\n",
                ),
            ],
        )

    def fake_feature_enrichment_phase(*args, **kwargs):
        context_snapshot = kwargs.get("context_snapshot", args[2])
        enrichment_calls.append([item.path for item in context_snapshot])
        return GeneratedCodeOutput(
            assistantSummary="功能完善已完成。",
            operations=[
                FileOperation(
                    type="write",
                    path="src/App.tsx",
                    summary="完善首页体验",
                    content="export default function App() { return <main>功能完善</main>; }\n",
                )
            ],
        )

    monkeypatch.setattr(service, "_invoke_bootstrap_phase", fake_bootstrap_phase)
    monkeypatch.setattr(service, "_invoke_feature_enrichment_phase", fake_feature_enrichment_phase)

    result = service._invoke_generation(state, spec, [])

    assert bootstrap_calls == [[]]
    assert enrichment_calls == [["index.html", "package.json", "src/App.tsx", "src/index.css", "src/main.tsx"]]
    assert result.assistant_summary == "功能完善已完成。"
    assert [operation.path for operation in result.operations] == [
        "package.json",
        "index.html",
        "src/main.tsx",
        "src/index.css",
        "src/App.tsx",
        "src/App.tsx",
    ]


def test_codegen_retries_with_minimal_bootstrap_after_transport_failure(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()
    calls: list[str] = []

    def fake_bootstrap_phase(*, state, spec, context_snapshot, phase_name, phase_brief, conversation_limit, spec_payload):
        calls.append(phase_name)
        if phase_name == "bootstrap":
            raise GenerationFailure("代码生成阶段调用模型失败。 structured=Connection error.; raw=Connection error.")
        if phase_name == "bootstrap_minimal":
            return GeneratedCodeOutput(
                assistantSummary="极简骨架已完成。",
                operations=[
                    FileOperation(
                        type="write",
                        path="src/App.tsx",
                        summary="写入初始页面",
                        content="export default function App() { return <main>极简骨架</main>; }\n",
                    ),
                ],
            )

    monkeypatch.setattr(service, "_invoke_bootstrap_generation_phase", fake_bootstrap_phase)

    result = service._invoke_bootstrap_phase(state, spec, [])

    assert calls == ["bootstrap", "bootstrap_minimal"]
    assert result.assistant_summary == "极简骨架已完成。"


def test_codegen_retries_with_minimal_bootstrap_after_wrapped_timeout_message(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()
    calls: list[str] = []

    def fake_bootstrap_phase(*, state, spec, context_snapshot, phase_name, phase_brief, conversation_limit, spec_payload):
        calls.append(phase_name)
        if phase_name == "bootstrap":
            raise GenerationFailure(
                "代码生成阶段调用模型失败。 structured=generate_bootstrap 结构化代码生成在 45.0 秒内没有返回。;"
                " raw=generate_bootstrap 原始 JSON 代码生成在 45.0 秒内没有返回。"
            )
        if phase_name == "bootstrap_minimal":
            return GeneratedCodeOutput(
                assistantSummary="极简骨架已完成。",
                operations=[
                    FileOperation(type="write", path="src/App.tsx", summary="写入初始页面", content="export default function App() { return <main>极简骨架</main>; }\n"),
                ],
            )

    monkeypatch.setattr(service, "_invoke_bootstrap_generation_phase", fake_bootstrap_phase)

    result = service._invoke_bootstrap_phase(state, spec, [])

    assert calls == ["bootstrap", "bootstrap_minimal"]
    assert result.assistant_summary == "极简骨架已完成。"


def test_codegen_uses_single_pass_rescue_after_bootstrap_transport_exhaustion(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()
    bootstrap_calls: list[str] = []
    rescue_reasons: list[str] = []

    def fail_bootstrap_phase(*, state, spec, context_snapshot, phase_name, phase_brief, conversation_limit, spec_payload):
        bootstrap_calls.append(phase_name)
        raise GenerationFailure(f"{phase_name} Connection error.")

    def fake_rescue(state, spec, context_snapshot, rescue_reason):
        rescue_reasons.append(rescue_reason)
        return GeneratedCodeOutput(
            assistantSummary="single-pass rescue 成功。",
            operations=[
                FileOperation(
                    type="write",
                    path="src/App.tsx",
                    summary="写入 rescue 结果",
                    content="export default function App() { return <main>Rescue</main>; }\n",
                )
            ],
        )

    monkeypatch.setattr(service, "_invoke_bootstrap_generation_phase", fail_bootstrap_phase)
    monkeypatch.setattr(service, "_invoke_single_pass_rescue", fake_rescue)

    result = service._invoke_staged_generation(state, spec, [])

    assert bootstrap_calls == ["bootstrap", "bootstrap_minimal"]
    assert rescue_reasons == ["bootstrap_transport_failure"]
    assert result.assistant_summary == "single-pass rescue 成功。"
    assert [operation.path for operation in result.operations] == ["src/App.tsx"]


def test_codegen_uses_single_pass_rescue_after_feature_enrichment_transport_failure(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()
    rescue_reasons: list[str] = []
    rescue_contexts: list[list[str]] = []

    def fake_bootstrap_phase(*args, **kwargs):
        return GeneratedCodeOutput(
            assistantSummary="基础骨架已完成。",
            operations=[
                FileOperation(
                    type="write",
                    path="package.json",
                    summary="写入依赖配置",
                    content='{"name":"todo-lite"}\n',
                ),
                FileOperation(
                    type="write",
                    path="src/App.tsx",
                    summary="写入初始页面",
                    content="export default function App() { return <main>基础骨架</main>; }\n",
                ),
            ],
        )

    def fail_feature_enrichment(*args, **kwargs):
        raise GenerationFailure("feature_enrichment Connection error.")

    def fake_rescue(state, spec, context_snapshot, rescue_reason):
        rescue_reasons.append(rescue_reason)
        rescue_contexts.append([item.path for item in context_snapshot])
        return GeneratedCodeOutput(
            assistantSummary="功能完善 rescue 成功。",
            operations=[
                FileOperation(
                    type="write",
                    path="src/App.tsx",
                    summary="补齐最终页面",
                    content="export default function App() { return <main>Rescue 完成</main>; }\n",
                )
            ],
        )

    monkeypatch.setattr(service, "_invoke_bootstrap_phase", fake_bootstrap_phase)
    monkeypatch.setattr(service, "_invoke_feature_enrichment_phase", fail_feature_enrichment)
    monkeypatch.setattr(service, "_invoke_single_pass_rescue", fake_rescue)

    result = service._invoke_staged_generation(state, spec, [])

    assert rescue_reasons == ["feature_enrichment_transport_failure"]
    assert rescue_contexts == [["package.json", "src/App.tsx"]]
    assert result.assistant_summary == "功能完善 rescue 成功。"
    assert [operation.path for operation in result.operations] == ["package.json", "src/App.tsx", "src/App.tsx"]


def test_codegen_uses_text_file_rescue_after_single_pass_rescue_transport_failure(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()
    bootstrap_calls: list[str] = []
    single_pass_rescue_reasons: list[str] = []
    text_rescue_reasons: list[str] = []

    def fail_bootstrap_phase(*, state, spec, context_snapshot, phase_name, phase_brief, conversation_limit, spec_payload):
        bootstrap_calls.append(phase_name)
        raise GenerationFailure(f"{phase_name} Connection error.")

    def fail_single_pass_rescue(*, state, spec, context_snapshot, rescue_reason):
        single_pass_rescue_reasons.append(rescue_reason)
        raise GenerationFailure("single_pass_rescue Connection error.")

    def fake_text_rescue(*, state, spec, context_snapshot, rescue_reason):
        text_rescue_reasons.append(rescue_reason)
        return GeneratedCodeOutput(
            assistantSummary="逐文件 rescue 成功。",
            operations=[
                FileOperation(
                    type="write",
                    path="package.json",
                    summary="写入依赖配置",
                    content='{"name":"todo-lite","scripts":{"dev":"vite","build":"vite build","preview":"vite preview"},"dependencies":{"react":"^19.1.0","react-dom":"^19.1.0"},"devDependencies":{"vite":"^7.1.3","typescript":"^5.9.2","@vitejs/plugin-react":"^4.3.4"}}\n',
                )
            ],
        )

    monkeypatch.setattr(service, "_invoke_bootstrap_generation_phase", fail_bootstrap_phase)
    monkeypatch.setattr(service, "_invoke_single_pass_rescue", fail_single_pass_rescue)
    monkeypatch.setattr(service, "_invoke_file_by_file_bootstrap_rescue", fake_text_rescue)

    result = service._invoke_staged_generation(state, spec, [])

    assert bootstrap_calls == ["bootstrap", "bootstrap_minimal"]
    assert single_pass_rescue_reasons == ["bootstrap_transport_failure"]
    assert text_rescue_reasons == ["bootstrap_transport_failure"]
    assert result.assistant_summary == "逐文件 rescue 成功。"
    assert [operation.path for operation in result.operations] == ["package.json"]


def test_codegen_file_by_file_bootstrap_rescue_generates_required_files(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()
    requested_paths: list[str] = []
    file_contents = {
        "package.json": '{\n  "name": "todo-lite",\n  "private": true,\n  "version": "0.0.0",\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build",\n    "preview": "vite preview"\n  },\n  "dependencies": {\n    "react": "^19.1.0",\n    "react-dom": "^19.1.0"\n  },\n  "devDependencies": {\n    "@vitejs/plugin-react": "^4.3.4",\n    "typescript": "^5.9.2",\n    "vite": "^7.1.3"\n  }\n}\n',
        "tsconfig.json": '{\n  "compilerOptions": {\n    "target": "ES2020",\n    "useDefineForClassFields": true,\n    "lib": ["ES2020", "DOM", "DOM.Iterable"],\n    "module": "ESNext",\n    "skipLibCheck": true,\n    "moduleResolution": "Bundler",\n    "allowImportingTsExtensions": false,\n    "resolveJsonModule": true,\n    "isolatedModules": true,\n    "noEmit": true,\n    "jsx": "react-jsx",\n    "strict": true\n  },\n  "include": ["src"]\n}\n',
        "vite.config.ts": "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n",
        "index.html": "<!doctype html>\n<html lang=\"zh-CN\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <title>待办清单</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <script type=\"module\" src=\"/src/main.tsx\"></script>\n  </body>\n</html>\n",
        "src/main.tsx": "import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n",
        "src/index.css": ":root {\n  font-family: 'Noto Sans SC', system-ui, sans-serif;\n  color: #122033;\n  background: linear-gradient(180deg, #f7fbff 0%, #eef5ff 100%);\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n}\n",
        "src/App.tsx": "import { useState } from 'react';\n\nconst initialTodos = [\n  { id: '1', title: '确认行程', done: false },\n  { id: '2', title: '预订住宿', done: true },\n];\n\nexport default function App() {\n  const [todos, setTodos] = useState(initialTodos);\n\n  return (\n    <main>\n      <h1>待办清单</h1>\n      <ul>\n        {todos.map((todo) => (\n          <li key={todo.id}>{todo.title}</li>\n        ))}\n      </ul>\n      <button type=\"button\" onClick={() => setTodos(todos)}>保持状态</button>\n    </main>\n  );\n}\n",
    }

    monkeypatch.setattr(service.provider, "require_chat_model", lambda *args, **kwargs: object())

    def fake_text_invoke(*, model, messages, state, invocation_kind, timeout_seconds, target_path):
        requested_paths.append(target_path)
        return file_contents[target_path]

    monkeypatch.setattr(service, "_invoke_text_file_with_transport_retries", fake_text_invoke)

    result = service._invoke_file_by_file_bootstrap_rescue(
        state=state,
        spec=spec,
        context_snapshot=[],
        rescue_reason="bootstrap_transport_failure",
    )

    assert requested_paths == [
        "package.json",
        "tsconfig.json",
        "vite.config.ts",
        "index.html",
        "src/main.tsx",
        "src/index.css",
        "src/App.tsx",
    ]
    assert [operation.path for operation in result.operations] == requested_paths
    assert result.assistant_summary == "已通过逐文件 LLM rescue 生成最小可运行版本。"


def test_codegen_uses_single_pass_when_foundational_files_exist(monkeypatch) -> None:
    service = CodeGenerationService()
    state = _build_codegen_state()
    spec = _build_codegen_spec()
    calls: list[str] = []
    context_snapshot = [
        WorkspaceFile(path="package.json", content='{"name":"demo"}\n'),
        WorkspaceFile(path="index.html", content="<html></html>\n"),
        WorkspaceFile(path="src/main.tsx", content="export {};\n"),
        WorkspaceFile(path="src/App.tsx", content="export default function App() { return null; }\n"),
    ]

    def fake_phase(*, state, spec, context_snapshot, phase_name, phase_brief, conversation_limit, spec_payload=None):
        calls.append(phase_name)
        return GeneratedCodeOutput(
            assistantSummary="单轮生成完成。",
            operations=[
                FileOperation(
                    type="write",
                    path="src/App.tsx",
                    summary="更新页面",
                    content="export default function App() { return <main>单轮生成</main>; }\n",
                )
            ],
        )

    monkeypatch.setattr(service, "_invoke_generation_phase", fake_phase)

    result = service._invoke_generation(state, spec, context_snapshot)

    assert calls == ["single_pass"]
    assert result.assistant_summary == "单轮生成完成。"


def test_codegen_can_use_json_schema_for_gpt5_structured_output() -> None:
    service = CodeGenerationService()
    captured_methods: list[str] = []

    class FakeStructuredInvoker:
        def invoke(self, messages: object) -> StructuredGeneratedCodeOutput:
            return StructuredGeneratedCodeOutput.model_validate(
                {
                    "assistantSummary": "json_schema 成功。",
                    "operations": [
                        {
                            "type": "write",
                            "path": "src/App.tsx",
                            "summary": "写入页面",
                            "content": "export default function App() { return <main>OK</main>; }\n",
                        }
                    ],
                }
            )

    class FakeModel:
        def with_structured_output(self, schema: object, method: str = "json_mode") -> FakeStructuredInvoker:
            captured_methods.append(method)
            return FakeStructuredInvoker()

        def invoke(self, messages: object) -> object:
            raise AssertionError("structured output should not fall back")

    normalized = service._invoke_and_normalize(
        FakeModel(),
        messages=[],
        context_snapshot=[],
        structured_output_method="json_schema",
    )

    assert normalized.assistant_summary == "json_schema 成功。"
    assert captured_methods == ["json_schema"]


def test_codegen_extracts_responses_instructions_for_structured_calls() -> None:
    service = CodeGenerationService()

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
                    return StructuredGeneratedCodeOutput.model_validate(
                        {
                            "assistantSummary": "structured 成功",
                            "operations": [
                                {
                                    "type": "write",
                                    "path": "src/App.tsx",
                                    "summary": "写入页面",
                                    "content": "export default function App() { return <main>Ready</main>; }\n",
                                }
                            ],
                        }
                    )

            return Invoker()

    model = ResponsesStructuredModel()
    messages = [
        SystemMessage(content="所有输出都必须是 JSON。"),
        HumanMessage(content="生成首页。"),
    ]

    result = service._invoke_structured_with_transport_retries(
        model=model,
        messages=messages,
        context_snapshot=[],
        state=None,
        invocation_kind="test_codegen",
        timeout_seconds=1,
        structured_output_method="json_schema",
    )

    assert result.assistant_summary == "structured 成功"
    assert model.bound_kwargs == [{"instructions": "所有输出都必须是 JSON。"}]
    assert [message.content for message in model.structured_messages[0]] == ["生成首页。"]


def test_codegen_prefers_chat_completion_clone_for_raw_responses_fallback() -> None:
    service = CodeGenerationService()

    class FakeGeneratedResponse:
        def __init__(self, content: str) -> None:
            self.content = content

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
            return FakeGeneratedResponse(
                '{"assistantSummary":"chat fallback 成功","operations":[{"type":"write","path":"src/App.tsx","summary":"写入页面","content":"export default function App() { return <main>Ready</main>; }\\n"}]}'
            )

    model = ChatFallbackModel()
    messages = [
        SystemMessage(content="保持 JSON 输出。"),
        HumanMessage(content="生成首页。"),
    ]

    result = service._invoke_raw_json_with_transport_retries(
        model=model,
        messages=messages,
        context_snapshot=[],
        state=None,
        invocation_kind="test_codegen",
        timeout_seconds=1,
    )

    assert result.assistant_summary == "chat fallback 成功"
    assert model.fallback_model is not None
    assert model.fallback_model.use_responses_api is False
    assert model.fallback_model.output_version == "v0"
    assert [message.content for message in model.fallback_model.invoke_messages[0]] == ["保持 JSON 输出。", "生成首页。"]


def test_codegen_prefers_chat_completion_clone_for_text_rescue_fallback() -> None:
    service = CodeGenerationService()

    class FakeTextResponse:
        def __init__(self, content: str) -> None:
            self.content = content

    class ChatFallbackModel:
        def __init__(self, use_responses_api=True, output_version="responses/v1") -> None:
            self.use_responses_api = use_responses_api
            self.output_version = output_version
            self.fallback_model = None
            self.invoke_messages = []

        def bind(self, **kwargs):
            raise AssertionError("text rescue should clone away from responses before binding instructions")

        def model_copy(self, update):
            clone = ChatFallbackModel(
                use_responses_api=update.get("use_responses_api", self.use_responses_api),
                output_version=update.get("output_version", self.output_version),
            )
            self.fallback_model = clone
            return clone

        def invoke(self, messages):
            if self.use_responses_api:
                raise AssertionError("responses model should not be used for text rescue fallback")
            self.invoke_messages.append(messages)
            return FakeTextResponse("export default function App() { return <main>Ready</main>; }\n")

    model = ChatFallbackModel()
    messages = [
        SystemMessage(content="保持输出为完整文件内容。"),
        HumanMessage(content="生成 src/App.tsx。"),
    ]

    content = service._invoke_text_file_with_transport_retries(
        model=model,
        messages=messages,
        state=None,
        invocation_kind="text_rescue_src_app_tsx",
        timeout_seconds=1,
        target_path="src/App.tsx",
    )

    assert "export default function App" in content
    assert model.fallback_model is not None
    assert model.fallback_model.use_responses_api is False
    assert model.fallback_model.output_version == "v0"
    assert [message.content for message in model.fallback_model.invoke_messages[0]] == ["保持输出为完整文件内容。", "生成 src/App.tsx。"]
