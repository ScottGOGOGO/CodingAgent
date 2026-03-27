from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, List, Optional

from app.models import AgentSessionState, ProjectStatus, RepairContext, RunPhase, RunSnapshot, RunStatus, WorkspaceFile
from app.services.codegen import CodeGenerationService
from app.services.context_builder import ContextBuilder
from app.services.critic import CriticService
from app.services.generation_guard import GenerationGuardService

logger = logging.getLogger("vide.agent.stages")
logger.setLevel(logging.INFO)


class VerifyLoopService:
    def __init__(
        self,
        context_builder: ContextBuilder,
        codegen: CodeGenerationService,
        critic: CriticService,
        generation_guard: GenerationGuardService,
        set_run: Callable[[AgentSessionState, RunPhase, RunStatus], None],
    ) -> None:
        self.context_builder = context_builder
        self.codegen = codegen
        self.critic = critic
        self.generation_guard = generation_guard
        self._set_run = set_run

    def verify_loop(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        state = AgentSessionState.model_validate(payload["state"])
        workspace_snapshot = [WorkspaceFile.model_validate(item) for item in payload.get("workspace_snapshot", [])]
        self._set_run(state, RunPhase.VERIFY_LOOP, RunStatus.IN_PROGRESS)

        guard_started_at = time.perf_counter()
        verification_error = self.generation_guard.preflight_generation_error(state, workspace_snapshot)
        logger.info(
            "stage=preflight_generation_check duration_ms=%d project_id=%s session_id=%s passed=%s",
            round((time.perf_counter() - guard_started_at) * 1000),
            state.project_id,
            state.session_id,
            "false" if verification_error else "true",
        )
        if verification_error:
            repaired_state = self._attempt_preflight_repair(state, workspace_snapshot, verification_error)
            if repaired_state is not None:
                state = repaired_state
                recheck_started_at = time.perf_counter()
                verification_error = self.generation_guard.preflight_generation_error(state, workspace_snapshot)
                logger.info(
                    "stage=preflight_generation_recheck duration_ms=%d project_id=%s session_id=%s passed=%s",
                    round((time.perf_counter() - recheck_started_at) * 1000),
                    state.project_id,
                    state.session_id,
                    "false" if verification_error else "true",
                )

        if verification_error:
            state.status = ProjectStatus.ERROR
            state.error = verification_error

        if state.error:
            state.run = RunSnapshot(
                status=RunStatus.FAILED,
                phase=RunPhase.VERIFY_LOOP,
                providerRoute=state.provider_route,
                error=state.error,
            )
            return {"state": state.as_contract(), "approved": payload.get("approved", False)}

        critic_started_at = time.perf_counter()
        state.evaluation = self.critic.evaluate(state)
        logger.info(
            "stage=critic duration_ms=%d project_id=%s session_id=%s",
            round((time.perf_counter() - critic_started_at) * 1000),
            state.project_id,
            state.session_id,
        )
        if self.generation_guard.critic_found_blocking_stub_feedback(state.evaluation.summary, state.evaluation.issues):
            state.status = ProjectStatus.ERROR
            state.error = (
                "评审检测到当前方案里仍有占位或未实现界面。"
                "请先生成完整且真实可用的页面，再进入审批。"
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

    def _attempt_preflight_repair(
        self,
        state: AgentSessionState,
        workspace_snapshot: List[WorkspaceFile],
        error: str,
    ) -> Optional[AgentSessionState]:
        if state.app_spec is None or not state.file_operations:
            return None

        merged_snapshot = self.generation_guard.materialize_workspace_snapshot(workspace_snapshot, state.file_operations)
        context_snapshot = self.context_builder.select(state, merged_snapshot)

        try:
            repair_started_at = time.perf_counter()
            repaired_state = self.codegen.repair(
                state,
                state.app_spec,
                context_snapshot,
                RepairContext(
                    attempt=1,
                    category="requirement_mismatch",
                    failedCommand="preflight validation",
                    buildError=error,
                ),
            )
            full_snapshot = self.generation_guard.materialize_workspace_snapshot(merged_snapshot, repaired_state.file_operations)
            repaired_state.file_operations = self.generation_guard.snapshot_to_write_operations(full_snapshot)
            repaired_state.file_change_summary = [operation.summary for operation in repaired_state.file_operations]
            logger.info(
                "stage=preflight_repair duration_ms=%d project_id=%s session_id=%s category=%s",
                round((time.perf_counter() - repair_started_at) * 1000),
                state.project_id,
                state.session_id,
                "requirement_mismatch",
            )
            return repaired_state
        except Exception:
            return None
