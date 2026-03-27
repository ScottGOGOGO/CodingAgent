from __future__ import annotations

from abc import ABC, abstractmethod
import logging
import time
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
from app.services.generation_guard import GenerationGuardService
from app.services.model_provider import ModelProvider
from app.services.spec_builder import SpecBuilder
from app.services.verify_loop import VerifyLoopService

logger = logging.getLogger("vide.agent.stages")
logger.setLevel(logging.INFO)


class StrategyAdapter(ABC):
    def __init__(self) -> None:
        self.model_provider = ModelProvider()
        self.clarifier = DynamicClarifier()
        self.spec_builder = SpecBuilder()
        self.context_builder = ContextBuilder()
        self.codegen = CodeGenerationService()
        self.critic = CriticService()
        self.generation_guard = GenerationGuardService()
        self.verify_loop_service = VerifyLoopService(
            self.context_builder,
            self.codegen,
            self.critic,
            self.generation_guard,
            self._set_run,
        )
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

        state.provider_route = self.model_provider.resolve_route()
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
            state.assistant_summary = f"生成失败：{state.error}"
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
                raise RuntimeError("必须先生成应用规格，才能开始修复项目。")

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
            append_assistant_message(state, state.assistant_summary or "已准备好修复补丁。")
            return state
        except Exception as exc:
            state.status = ProjectStatus.ERROR
            state.error = str(exc)
            state.assistant_summary = f"修复失败：{state.error}"
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
        started_at = time.perf_counter()
        state = self.clarifier.decide(state)
        self._log_stage_duration("clarifier", started_at, state)
        if state.status == ProjectStatus.CLARIFYING:
            self._set_run(state, RunPhase.DYNAMIC_CLARIFY, RunStatus.AWAITING_INPUT)
        return {"state": state.as_contract(), "workspace_snapshot": payload.get("workspace_snapshot", []), "approved": payload.get("approved", False)}

    def normalize_spec(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        self._set_run(state, RunPhase.NORMALIZE_SPEC, RunStatus.IN_PROGRESS)
        started_at = time.perf_counter()
        state.app_spec = self.spec_builder.build_spec(state)
        self._log_stage_duration("spec", started_at, state)
        state.status = ProjectStatus.PLANNING
        return {"state": state.as_contract(), "workspace_snapshot": payload.get("workspace_snapshot", []), "approved": payload.get("approved", False)}

    def planning(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        self._set_run(state, RunPhase.PLANNING, RunStatus.IN_PROGRESS)
        started_at = time.perf_counter()
        state.plan_steps = self.spec_builder.build_plan(state.app_spec)
        self._log_stage_duration("plan", started_at, state)
        state.assistant_summary = f"已为 {state.app_spec.title} 准备好实现计划。"
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
        started_at = time.perf_counter()
        state = self.codegen.generate(state, state.app_spec, implementation_snapshot)
        self._log_stage_duration("codegen", started_at, state)
        return {
            "state": state.as_contract(),
            "workspace_snapshot": payload.get("workspace_snapshot", []),
            "implementation_snapshot": payload.get("implementation_snapshot", []),
            "approved": payload.get("approved", False),
        }

    def verify_loop(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self.verify_loop_service.verify_loop(payload)

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
        state.assistant_summary = self._build_approval_summary(state)
        append_assistant_message(state, state.assistant_summary)
        return {"state": state.as_contract(), "approved": approved}

    def execute_dispatch(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        self._set_run(state, RunPhase.EXECUTE_DISPATCH, RunStatus.RUNNING)
        state.status = ProjectStatus.RUNNING
        state.assistant_summary = "执行任务已分发给工作进程。"
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
    def _build_approval_summary(state: AgentSessionState) -> str:
        return (
            f"{state.app_spec.title} 已准备好进入审批。"
            "确认后将应用提议的文件改动、执行验证，并启动预览。"
        )

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

    @staticmethod
    def _log_stage_duration(stage: str, started_at: float, state: AgentSessionState) -> None:
        logger.info(
            "stage=%s duration_ms=%d project_id=%s session_id=%s",
            stage,
            round((time.perf_counter() - started_at) * 1000),
            state.project_id,
            state.session_id,
        )
