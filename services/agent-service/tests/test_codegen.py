from app.models import StructuredFileOperationOutput, StructuredGeneratedCodeOutput, WorkspaceFile
from app.services.codegen import CodeGenerationService


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
