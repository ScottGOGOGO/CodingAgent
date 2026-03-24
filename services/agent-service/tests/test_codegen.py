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
