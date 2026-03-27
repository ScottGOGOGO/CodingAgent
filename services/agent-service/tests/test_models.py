from app.models import AgentSessionState, ReasoningMode, StructuredSpecOutput


def test_app_models_barrel_keeps_alias_roundtrip_stable() -> None:
    state = AgentSessionState(
        sessionId="session-1",
        projectId="project-1",
        reasoningMode=ReasoningMode.PLAN_SOLVE,
        status="draft",
        lastContextPaths=["src/App.tsx"],
    )

    dumped = state.model_dump(mode="json", by_alias=True)

    assert dumped["sessionId"] == "session-1"
    assert dumped["projectId"] == "project-1"
    assert dumped["reasoningMode"] == "plan_solve"
    assert dumped["lastContextPaths"] == ["src/App.tsx"]

    restored = AgentSessionState.model_validate(dumped)

    assert restored.session_id == "session-1"
    assert restored.project_id == "project-1"
    assert restored.reasoning_mode == ReasoningMode.PLAN_SOLVE
    assert restored.last_context_paths == ["src/App.tsx"]


def test_structured_models_still_coerce_camel_case_inputs() -> None:
    structured = StructuredSpecOutput.model_validate(
        {
            "title": "Tennis Coach",
            "summary": "Personal trainer",
            "goal": "Help users practice",
            "targetUsers": "Beginners",
            "successCriteria": "Users complete weekly drills",
            "constraints": "No backend required",
        }
    )

    assert structured.target_users == ["Beginners"]
    assert structured.success_criteria == ["Users complete weekly drills"]
    assert structured.constraints == ["No backend required"]
