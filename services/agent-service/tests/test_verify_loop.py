from app.models import AgentSessionState, ProjectStatus, ReasoningMode, RunStatus
from app.strategies.plan_solve import PlanSolveStrategy


def test_verify_loop_rejects_placeholder_app_content() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
            {
                "type": "write",
                "path": "src/App.tsx",
                "summary": "Render route shell",
                "content": "const Home = () => <div>行程概览页（待实现）</div>;\nexport default Home;\n",
            }
        ],
    )

    result = strategy.verify_loop(
        {
            "state": state.as_contract(),
            "workspace_snapshot": [
                {"path": "package.json", "content": "{}"},
                {"path": "index.html", "content": "<!doctype html>"},
                {"path": "src/main.tsx", "content": "import './App';"},
            ],
            "approved": False,
        }
    )

    next_state = AgentSessionState.model_validate(result["state"])

    assert next_state.status == ProjectStatus.ERROR
    assert next_state.error is not None
    assert "placeholder or TODO UI content" in next_state.error
    assert next_state.run is not None
    assert next_state.run.status == RunStatus.FAILED


def test_verify_loop_ignores_normal_input_placeholder_props() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
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
        ],
    )

    assert strategy._find_placeholder_paths(state.file_operations) == []


def test_verify_loop_ignores_placeholder_text_inside_code_comments() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
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
        ],
    )

    assert strategy._find_placeholder_paths(state.file_operations) == []


def test_critic_stub_feedback_ignores_warning_level_placeholder_data_notes() -> None:
    assert not PlanSolveStrategy._critic_found_blocking_stub_feedback(
        "The code is highly build-ready and nearly complete.",
        [
            "[warning] Step 2 is not implemented yet — only placeholder week1Plan is used for the demo.",
            "[info] Some sample drill data is still hardcoded for maintainability reasons.",
        ],
    )


def test_critic_stub_feedback_blocks_critical_placeholder_ui_findings() -> None:
    assert PlanSolveStrategy._critic_found_blocking_stub_feedback(
        "The app still contains route-only skeleton screens.",
        [
            "[critical] Placeholder UI remains in src/App.tsx with 待实现 labels.",
        ],
    )


def test_find_placeholder_paths_blocks_user_facing_video_placeholder_copy() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
            {
                "type": "write",
                "path": "src/pages/DrillDetail.tsx",
                "summary": "Render drill detail",
                "content": "export default function DrillDetail() { return <p>Video placeholder - in production, this would be a real drill video.</p>; }",
            }
        ],
    )

    assert strategy._find_placeholder_paths(state.file_operations) == ["src/pages/DrillDetail.tsx"]


def test_find_placeholder_paths_ignores_patch_search_when_replacement_removes_placeholder() -> None:
    strategy = PlanSolveStrategy()
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status=ProjectStatus.PLANNING,
        fileOperations=[
            {
                "type": "patch",
                "path": "src/App.tsx",
                "summary": "Replace placeholder copy",
                "hunks": [
                    {
                        "search": "[Video placeholder: Serve demo]",
                        "replace": "Video lesson focus: Serve demo",
                    }
                ],
            }
        ],
    )

    assert strategy._find_placeholder_paths(state.file_operations) == []
