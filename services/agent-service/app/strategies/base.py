from __future__ import annotations

from abc import ABC, abstractmethod
import re
from typing import Any, Dict, List, Optional

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from app.models import (
    AgentSessionState,
    ClarificationAnswer,
    ProjectStatus,
    RepairContext,
    RunPhase,
    RunSnapshot,
    RunStatus,
    WorkspaceFile,
)
from app.services.clarifier import DynamicClarifier, append_assistant_message, append_user_message, apply_clarification_answers
from app.services.codegen import CodeGenerationService
from app.services.context_builder import ContextBuilder
from app.services.critic import CriticService
from app.services.spec_builder import SpecBuilder
from app.services.provider_router import ProviderRouter


class StrategyAdapter(ABC):
    PLACEHOLDER_MARKERS = (
        "待实现",
        "todo",
        "coming soon",
        "lorem ipsum",
        "tbd",
        "video placeholder",
        "placeholder screen",
        "placeholder route",
        "route stub",
        "screen stub",
        "in production, this would be",
    )
    BLOCKING_SUMMARY_MARKERS = (
        "待实现",
        "route-only skeleton",
        "routing stubs",
        "screen shells",
        "blank scaffolding",
        "placeholder ui",
        "stub ui",
        "todo ui",
        "coming soon",
    )
    BLOCKING_CRITIC_ISSUE_MARKERS = (
        "待实现",
        "route-only skeleton",
        "routing stubs",
        "screen shells",
        "blank scaffolding",
        "placeholder ui",
        "stub ui",
        "todo ui",
        "empty route shell",
        "placeholder route",
    )

    def __init__(self) -> None:
        self.router = ProviderRouter()
        self.clarifier = DynamicClarifier()
        self.spec_builder = SpecBuilder()
        self.context_builder = ContextBuilder()
        self.codegen = CodeGenerationService()
        self.critic = CriticService()
        self.graph = self.build_graph().compile(checkpointer=MemorySaver())

    @abstractmethod
    def build_graph(self) -> StateGraph:
        raise NotImplementedError

    def invoke_with_workspace(
        self,
        state: AgentSessionState,
        workspace_snapshot: Optional[List[WorkspaceFile]] = None,
        user_message: Optional[str] = None,
        clarification_answers: Optional[List[Any]] = None,
    ) -> AgentSessionState:
        if user_message:
            state = append_user_message(state, user_message)

        if clarification_answers:
            state = apply_clarification_answers(
                state,
                [
                    item if isinstance(item, ClarificationAnswer) else ClarificationAnswer.model_validate(item)
                    for item in clarification_answers
                ],
            )

        state.provider_route = self.router.resolve()
        state.run = RunSnapshot(status=RunStatus.IN_PROGRESS, phase=RunPhase.INTAKE, providerRoute=state.provider_route)
        state.error = None

        snapshot_data = [item.model_dump(mode="json", by_alias=True) for item in workspace_snapshot or []]

        try:
            result = self.graph.invoke(
                {"state": state.as_contract(), "workspace_snapshot": snapshot_data, "approved": False},
                config={"configurable": {"thread_id": state.session_id}},
            )
            return AgentSessionState.model_validate(result["state"])
        except Exception as exc:
            state.status = ProjectStatus.ERROR
            state.error = str(exc)
            state.assistant_summary = f"Generation failed: {state.error}"
            state.run_phase = RunPhase.REPORT
            state.run = RunSnapshot(
                status=RunStatus.FAILED,
                phase=RunPhase.REPORT,
                providerRoute=state.provider_route,
                error=state.error,
            )
            append_assistant_message(state, state.assistant_summary)
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

            state.status = ProjectStatus.REPAIRING
            state.run_phase = RunPhase.IMPLEMENT_LOOP
            context_snapshot = self.context_builder.select(state, workspace_snapshot)
            state = self.codegen.repair(state, state.app_spec, context_snapshot, repair_context)
            state.evaluation = self.critic.evaluate(state)
            state.run = RunSnapshot(
                status=RunStatus.RUNNING,
                phase=RunPhase.VERIFY_LOOP,
                providerRoute=state.provider_route,
                evaluation=state.evaluation,
            )
            state.error = None
            append_assistant_message(state, state.assistant_summary or "Prepared a repair patch.")
            return state
        except Exception as exc:
            state.status = ProjectStatus.ERROR
            state.error = str(exc)
            state.assistant_summary = f"Repair failed: {state.error}"
            state.run = RunSnapshot(
                status=RunStatus.FAILED,
                phase=RunPhase.REPORT,
                providerRoute=state.provider_route,
                error=state.error,
            )
            append_assistant_message(state, state.assistant_summary)
            return state

    def intake(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        self._set_run(state, RunPhase.INTAKE, RunStatus.IN_PROGRESS)
        return {"state": state.as_contract(), "workspace_snapshot": payload.get("workspace_snapshot", []), "approved": payload.get("approved", False)}

    def dynamic_clarify(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        self._set_run(state, RunPhase.DYNAMIC_CLARIFY, RunStatus.IN_PROGRESS)
        state = self.clarifier.decide(state)
        if state.status == ProjectStatus.CLARIFYING:
            self._set_run(state, RunPhase.DYNAMIC_CLARIFY, RunStatus.AWAITING_INPUT)
        return {"state": state.as_contract(), "workspace_snapshot": payload.get("workspace_snapshot", []), "approved": payload.get("approved", False)}

    def normalize_spec(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        self._set_run(state, RunPhase.NORMALIZE_SPEC, RunStatus.IN_PROGRESS)
        state.app_spec = self.spec_builder.build_spec(state)
        state.status = ProjectStatus.PLANNING
        return {"state": state.as_contract(), "workspace_snapshot": payload.get("workspace_snapshot", []), "approved": payload.get("approved", False)}

    def planning(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        self._set_run(state, RunPhase.PLANNING, RunStatus.IN_PROGRESS)
        state.plan_steps = self.spec_builder.build_plan(state.app_spec)
        state.assistant_summary = f"Prepared the implementation plan for {state.app_spec.title}."
        return {"state": state.as_contract(), "workspace_snapshot": payload.get("workspace_snapshot", []), "approved": payload.get("approved", False)}

    def context_build(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        workspace_snapshot = [WorkspaceFile.model_validate(item) for item in payload.get("workspace_snapshot", [])]
        self._set_run(state, RunPhase.CONTEXT_BUILD, RunStatus.IN_PROGRESS)
        context_snapshot = self.context_builder.select(state, workspace_snapshot)
        return {
            "state": state.as_contract(),
            "workspace_snapshot": payload.get("workspace_snapshot", []),
            "implementation_snapshot": [item.model_dump(mode="json", by_alias=True) for item in context_snapshot],
            "approved": payload.get("approved", False),
        }

    def implement_loop(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        implementation_snapshot = [WorkspaceFile.model_validate(item) for item in payload.get("implementation_snapshot", [])]
        self._set_run(state, RunPhase.IMPLEMENT_LOOP, RunStatus.IN_PROGRESS)
        state = self.codegen.generate(state, state.app_spec, implementation_snapshot)
        return {
            "state": state.as_contract(),
            "workspace_snapshot": payload.get("workspace_snapshot", []),
            "implementation_snapshot": payload.get("implementation_snapshot", []),
            "approved": payload.get("approved", False),
        }

    def verify_loop(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        workspace_snapshot = [WorkspaceFile.model_validate(item) for item in payload.get("workspace_snapshot", [])]
        self._set_run(state, RunPhase.VERIFY_LOOP, RunStatus.IN_PROGRESS)

        if not state.file_operations:
            state.status = ProjectStatus.ERROR
            state.error = "The coder returned no file operations."
        else:
            existing_paths = {item.path for item in workspace_snapshot}
            final_paths = set(existing_paths)
            for operation in state.file_operations:
                if operation.type in {"write", "patch"}:
                    final_paths.add(operation.path)
                elif operation.type == "delete":
                    final_paths.discard(operation.path)

            required_paths = {"package.json", "index.html", "src/main.tsx", "src/App.tsx"}
            if not required_paths.issubset(final_paths):
                state.status = ProjectStatus.ERROR
                state.error = "The generated operations do not produce a runnable React + Vite app."
            else:
                placeholder_paths = self._find_placeholder_paths(state.file_operations)
                if placeholder_paths:
                    state.status = ProjectStatus.ERROR
                    state.error = (
                        "The generated operations still contain placeholder or TODO UI content in "
                        f"{', '.join(placeholder_paths)}. Generate real user-facing screens before approval."
                    )

        if state.error:
            state.run = RunSnapshot(
                status=RunStatus.FAILED,
                phase=RunPhase.VERIFY_LOOP,
                providerRoute=state.provider_route,
                error=state.error,
            )
            return {"state": state.as_contract(), "approved": payload.get("approved", False)}

        state.evaluation = self.critic.evaluate(state)
        if self._critic_found_blocking_stub_feedback(state.evaluation.summary, state.evaluation.issues):
            state.status = ProjectStatus.ERROR
            state.error = (
                "The critic detected placeholder or unimplemented UI in the proposed app. "
                "Generate substantive screens before approval."
            )
            state.run = RunSnapshot(
                status=RunStatus.FAILED,
                phase=RunPhase.VERIFY_LOOP,
                providerRoute=state.provider_route,
                evaluation=state.evaluation,
                error=state.error,
            )
            return {"state": state.as_contract(), "approved": payload.get("approved", False)}

        if state.evaluation.build_readiness_score < 0.25:
            state.status = ProjectStatus.ERROR
            state.error = state.evaluation.summary
            state.run = RunSnapshot(
                status=RunStatus.FAILED,
                phase=RunPhase.VERIFY_LOOP,
                providerRoute=state.provider_route,
                evaluation=state.evaluation,
                error=state.error,
            )
            return {"state": state.as_contract(), "approved": payload.get("approved", False)}

        return {"state": state.as_contract(), "approved": payload.get("approved", False)}

    def approval_interrupt(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        approved = bool(payload.get("approved", False))
        self._set_run(state, RunPhase.APPROVAL_INTERRUPT, RunStatus.AWAITING_APPROVAL)

        if state.error:
            return {"state": state.as_contract(), "approved": approved}

        if approved:
            state.status = ProjectStatus.RUNNING
            self._set_run(state, RunPhase.EXECUTE_DISPATCH, RunStatus.RUNNING)
            return {"state": state.as_contract(), "approved": approved}

        state.status = ProjectStatus.AWAITING_APPROVAL
        state.assistant_summary = (
            f"{state.app_spec.title} is ready for approval. "
            "Confirm to apply the proposed file operations, run verification, and launch the preview."
        )
        append_assistant_message(state, state.assistant_summary)
        return {"state": state.as_contract(), "approved": approved}

    def execute_dispatch(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        self._set_run(state, RunPhase.EXECUTE_DISPATCH, RunStatus.RUNNING)
        state.status = ProjectStatus.RUNNING
        state.assistant_summary = "Execution has been dispatched to the worker."
        return {"state": state.as_contract()}

    def report(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        if state.error:
            state.status = ProjectStatus.ERROR
            self._set_run(state, RunPhase.REPORT, RunStatus.FAILED)
        elif state.status == ProjectStatus.AWAITING_APPROVAL:
            self._set_run(state, RunPhase.REPORT, RunStatus.AWAITING_APPROVAL)
        elif state.status == ProjectStatus.CLARIFYING:
            self._set_run(state, RunPhase.REPORT, RunStatus.AWAITING_INPUT)
        else:
            self._set_run(state, RunPhase.REPORT, RunStatus.COMPLETED)
        return {"state": state.as_contract()}

    @staticmethod
    def route_after_clarify(payload: Dict[str, Any]) -> str:
        state = AgentSessionState.model_validate(payload["state"])
        if state.status == ProjectStatus.CLARIFYING or state.error:
            return "report"
        return "normalize_spec"

    @staticmethod
    def route_after_approval(payload: Dict[str, Any]) -> str:
        state = AgentSessionState.model_validate(payload["state"])
        if state.error or state.status == ProjectStatus.AWAITING_APPROVAL:
            return "report"
        return "execute_dispatch"

    @staticmethod
    def _set_run(state: AgentSessionState, phase: RunPhase, status: RunStatus) -> None:
        state.run_phase = phase
        state.run = RunSnapshot(
            id=state.run.id if state.run else None,
            status=status,
            phase=phase,
            approvalRequest=state.run.approval_request if state.run else None,
            providerRoute=state.provider_route,
            evaluation=state.evaluation,
            usage=state.run.usage if state.run else None,
            error=state.error,
        )

    @classmethod
    def _find_placeholder_paths(cls, operations: List[Any]) -> List[str]:
        flagged_paths: List[str] = []
        seen = set()
        for operation in operations:
            path = getattr(operation, "path", "")
            if not path.endswith((".tsx", ".jsx", ".ts", ".js", ".html")):
                continue

            texts = cls._operation_text_fragments(operation)
            if any(marker in text for text in texts for marker in cls.PLACEHOLDER_MARKERS):
                if path not in seen:
                    seen.add(path)
                    flagged_paths.append(path)
        return flagged_paths

    @staticmethod
    def _operation_text_fragments(operation: Any) -> List[str]:
        texts: List[str] = []
        for value in (
            getattr(operation, "content", None),
            getattr(operation, "fallback_content", None),
            getattr(operation, "fallbackContent", None),
            getattr(operation, "search", None),
            getattr(operation, "replace", None),
        ):
            if isinstance(value, str) and value.strip():
                texts.append(StrategyAdapter._sanitize_operation_text(value))

        for hunk in getattr(operation, "hunks", []) or []:
            for value in (getattr(hunk, "search", None), getattr(hunk, "replace", None)):
                if isinstance(value, str) and value.strip():
                    texts.append(StrategyAdapter._sanitize_operation_text(value))
        return texts

    @classmethod
    def _critic_found_blocking_stub_feedback(cls, summary: str, issues: List[str]) -> bool:
        summary_text = (summary or "").lower()
        if any(marker in summary_text for marker in cls.BLOCKING_SUMMARY_MARKERS):
            return True

        for item in issues:
            text = (item or "").lower()
            if "[critical]" not in text and "[high]" not in text:
                continue
            if any(marker in text for marker in cls.BLOCKING_CRITIC_ISSUE_MARKERS):
                return True

        return False

    @staticmethod
    def _sanitize_operation_text(value: str) -> str:
        lowered = value.lower()
        lowered = re.sub(r"/\*.*?\*/", " ", lowered, flags=re.DOTALL)
        lowered = re.sub(r"^\s*//.*$", " ", lowered, flags=re.MULTILINE)
        for quote in ('"', "'", "{"):
            lowered = lowered.replace(f"placeholder={quote}", "placeholder_prop_removed=")
        return lowered
