from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from app.models import AgentSessionState, ProjectStatus, RepairContext, SlotKey, WorkspaceFile
from app.services.clarifier import (
    append_assistant_message,
    apply_clarification_answers,
    append_user_message,
    next_clarification_state,
)
from app.services.codegen import CodeGenerationService
from app.services.spec_builder import SpecBuilder


class StrategyAdapter(ABC):
    def __init__(self) -> None:
        self.spec_builder = SpecBuilder()
        self.codegen = CodeGenerationService()
        self.graph = self.build_graph().compile(checkpointer=MemorySaver())

    @abstractmethod
    def build_graph(self) -> StateGraph:
        raise NotImplementedError

    def invoke(
        self, state: AgentSessionState, user_message: str = None, clarification_answers: Dict[str, str] = None
    ) -> AgentSessionState:
        if user_message:
            state = append_user_message(state, user_message)

        if clarification_answers:
            state.requirement_slots = apply_clarification_answers(
                state.requirement_slots,
                {SlotKey(key): value for key, value in clarification_answers.items()},
            )

        try:
            result = self.graph.invoke(
                {"state": state.as_contract(), "workspace_snapshot": []},
                config={"configurable": {"thread_id": state.session_id}},
            )
            return AgentSessionState.model_validate(result["state"])
        except Exception as exc:
            state.status = ProjectStatus.ERROR
            state.error = str(exc)
            state.assistant_summary = f"Generation failed: {state.error}"
            state = append_assistant_message(state, state.assistant_summary)
            return state

    def invoke_with_workspace(
        self,
        state: AgentSessionState,
        workspace_snapshot: List[WorkspaceFile],
        user_message: str = None,
        clarification_answers: Dict[str, str] = None,
    ) -> AgentSessionState:
        if user_message:
            state = append_user_message(state, user_message)

        if clarification_answers:
            state.requirement_slots = apply_clarification_answers(
                state.requirement_slots,
                {SlotKey(key): value for key, value in clarification_answers.items()},
            )

        try:
            result = self.graph.invoke(
                {
                    "state": state.as_contract(),
                    "workspace_snapshot": [item.model_dump(mode="json") for item in workspace_snapshot],
                },
                config={"configurable": {"thread_id": state.session_id}},
            )
            return AgentSessionState.model_validate(result["state"])
        except Exception as exc:
            state.status = ProjectStatus.ERROR
            state.error = str(exc)
            state.assistant_summary = f"Generation failed: {state.error}"
            state = append_assistant_message(state, state.assistant_summary)
            return state

    def repair_with_workspace(
        self,
        state: AgentSessionState,
        workspace_snapshot: List[WorkspaceFile],
        repair_context: RepairContext,
    ) -> AgentSessionState:
        try:
            if state.app_spec is None:
                raise RuntimeError("Cannot repair a project before an app spec has been generated.")

            state = self.codegen.repair(state, state.app_spec, workspace_snapshot, repair_context)
            state.status = ProjectStatus.APPLYING_CHANGES
            state.error = None
            state = append_assistant_message(state, state.assistant_summary or "Prepared a repair patch.")
            return state
        except Exception as exc:
            state.status = ProjectStatus.ERROR
            state.error = str(exc)
            state.assistant_summary = f"Generation failed: {state.error}"
            state = append_assistant_message(state, state.assistant_summary)
            return state

    def clarify(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        state = next_clarification_state(state)
        if state.status.value == "clarifying":
            questions = "\n".join(
                [f"{index + 1}. {question.question}" for index, question in enumerate(state.clarification_questions)]
            )
            state.assistant_summary = "I need a bit more detail before generating the app."
            state = append_assistant_message(
                state,
                f"Before I generate the app, please help me fill these gaps:\n{questions}",
            )
        return {"state": state.as_contract()}

    def spec_normalize(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        state.app_spec = self.spec_builder.build_spec(state)
        return {"state": state.as_contract()}

    def plan(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        state.plan_steps = self.spec_builder.build_plan(state, state.app_spec)
        state.assistant_summary = f"Prepared a generation plan for {state.app_spec.title}."
        return {"state": state.as_contract()}

    def generate(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        workspace_snapshot = [WorkspaceFile.model_validate(item) for item in payload.get("workspace_snapshot", [])]
        state = self.codegen.generate(state, state.app_spec, workspace_snapshot)
        return {"state": state.as_contract()}

    def review(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        state.file_change_summary = state.file_change_summary[:10]
        return {"state": state.as_contract()}

    def verify(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        workspace_snapshot = [WorkspaceFile.model_validate(item) for item in payload.get("workspace_snapshot", [])]
        existing_paths = {item.path for item in workspace_snapshot}
        generated_paths = {change.path for change in state.file_changes if change.action == "write"}
        deleted_paths = {change.path for change in state.file_changes if change.action == "delete"}
        final_paths = (existing_paths | generated_paths) - deleted_paths
        required_paths = {"package.json", "index.html", "src/main.tsx", "src/App.tsx"}
        if not required_paths.issubset(final_paths):
            state.status = ProjectStatus.ERROR
            state.error = "Qwen generation did not produce a runnable React + Vite file set."
        return {"state": state.as_contract()}

    def propose_run(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        if state.error:
            return {"state": state.as_contract()}
        state.status = ProjectStatus.READY_FOR_CONFIRMATION
        summary_lines = "\n".join(f"- {item}" for item in state.file_change_summary[:6])
        state.assistant_summary = (
            f"{state.app_spec.title} is ready for generation.\n\n"
            f"Planned changes:\n{summary_lines}\n\n"
            "Confirm to write files, install dependencies, and start the preview."
        )
        state = append_assistant_message(state, state.assistant_summary)
        return {"state": state.as_contract()}

    def wait_for_confirmation(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return payload

    def run(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return payload

    def report(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return payload

    @staticmethod
    def route_after_clarify(payload: Dict[str, Any]) -> str:
        state = AgentSessionState.model_validate(payload["state"])
        return "report" if state.status.value == "clarifying" else "spec_normalize"

    @staticmethod
    def route_after_wait(payload: Dict[str, Any]) -> str:
        return "report"

    @staticmethod
    def _finalize(builder: StateGraph) -> StateGraph:
        builder.add_node("review", builder.nodes["review"])
        return builder
