from app.models import FileOperation, PatchHunk, WorkspaceFile
from app.services.generation_guard import GenerationGuardService


def test_generation_guard_ignores_normal_input_placeholder_props() -> None:
    guard = GenerationGuardService()
    operations = [
        FileOperation.model_validate(
            {
                "type": "write",
                "path": "src/App.tsx",
                "summary": "Render app shell",
                "content": (
                    "export default function App() {\n"
                    "  return <input placeholder=\"Type your goal\" />;\n"
                    "}\n"
                ),
            }
        )
    ]

    assert guard.find_placeholder_paths(operations) == []


def test_generation_guard_ignores_placeholder_text_inside_comments() -> None:
    guard = GenerationGuardService()
    operations = [
        FileOperation.model_validate(
            {
                "type": "write",
                "path": "src/pages/Lesson.tsx",
                "summary": "Render lesson page",
                "content": (
                    "export default function Lesson() {\n"
                    "  /* Video Placeholder */\n"
                    "  return <img alt='Demo' src='https://placehold.co/600x340' />;\n"
                    "}\n"
                ),
            }
        )
    ]

    assert guard.find_placeholder_paths(operations) == []


def test_generation_guard_flags_user_facing_placeholder_copy() -> None:
    guard = GenerationGuardService()
    operations = [
        FileOperation.model_validate(
            {
                "type": "write",
                "path": "src/pages/DrillDetail.tsx",
                "summary": "Render drill detail",
                "content": "export default function DrillDetail() { return <p>Video placeholder - in production, this would be a real drill video.</p>; }",
            }
        )
    ]

    assert guard.find_placeholder_paths(operations) == ["src/pages/DrillDetail.tsx"]


def test_generation_guard_allows_real_todo_domain_identifiers() -> None:
    guard = GenerationGuardService()
    operations = [
        FileOperation(
            type="write",
            path="src/App.tsx",
            summary="Write todo app.",
            content=(
                "type Todo = { id: string; text: string; completed: boolean };\n"
                "export default function App() {\n"
                "  return <input placeholder=\"输入待办内容\" aria-label=\"待办输入框\" />;\n"
                "}\n"
            ),
        )
    ]

    assert guard.find_placeholder_paths(operations) == []


def test_generation_guard_detects_missing_local_import_targets() -> None:
    guard = GenerationGuardService()
    operations = [
        FileOperation.model_validate(
            {
                "type": "write",
                "path": "src/App.tsx",
                "summary": "Render routed app",
                "content": "import Home from './components/Home';\nexport default function App() { return <Home />; }\n",
            }
        )
    ]

    assert guard.find_missing_local_imports(operations, {"src/App.tsx"}) == ["src/App.tsx -> ./components/Home"]


def test_generation_guard_materializes_workspace_snapshot_with_patch_hunks() -> None:
    guard = GenerationGuardService()
    snapshot = [WorkspaceFile(path="src/App.tsx", content="export const title = 'Draft';\n")]
    operations = [
        FileOperation(
            type="patch",
            path="src/App.tsx",
            summary="Replace title",
            hunks=[PatchHunk(search="Draft", replace="Ready", occurrence=1)],
        )
    ]

    materialized = guard.materialize_workspace_snapshot(snapshot, operations)

    assert materialized[0].content == "export const title = 'Ready';\n"


def test_generation_guard_blocks_only_critical_placeholder_ui_feedback() -> None:
    assert not GenerationGuardService.critic_found_blocking_stub_feedback(
        "The code is highly build-ready and nearly complete.",
        [
            "[warning] Step 2 is not implemented yet — only placeholder week1Plan is used for the demo.",
            "[info] Some sample drill data is still hardcoded for maintainability reasons.",
        ],
    )
    assert GenerationGuardService.critic_found_blocking_stub_feedback(
        "The app still contains route-only skeleton screens.",
        [
            "[critical] Placeholder UI remains in src/App.tsx with 待实现 labels.",
        ],
    )
