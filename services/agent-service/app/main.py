from __future__ import annotations

import asyncio

from fastapi import FastAPI

from app.config import get_settings
from app.models import (
    AgentRepairRequest,
    AgentRepairResponse,
    AgentSessionState,
    AgentTurnRequest,
    AgentTurnResponse,
    ProjectStatus,
    ReasoningMode,
)
from app.strategies.plan_solve import PlanSolveStrategy
from app.strategies.react_mode import ReactStrategy

app = FastAPI(title="vide-agent-service", version="0.2.0")


class AgentRuntime:
    def __init__(self) -> None:
        self.plan_solve = PlanSolveStrategy()
        self.react = ReactStrategy()

    def process_turn(self, request: AgentTurnRequest) -> AgentSessionState:
        state = request.state or AgentSessionState(
            sessionId=request.session_id,
            projectId=request.project_id,
            reasoningMode=request.reasoning_mode,
            status=ProjectStatus.DRAFT,
        )
        state.reasoning_mode = request.reasoning_mode

        strategy = self.plan_solve if request.reasoning_mode == ReasoningMode.PLAN_SOLVE else self.react
        return strategy.invoke_with_workspace(
            state=state,
            workspace_snapshot=request.workspace_snapshot,
            user_message=request.user_message,
            clarification_answers=request.clarification_answers,
        )

    def process_repair(self, request: AgentRepairRequest) -> AgentSessionState:
        strategy = self.plan_solve if request.reasoning_mode == ReasoningMode.PLAN_SOLVE else self.react
        return strategy.repair_with_workspace(
            state=request.state,
            workspace_snapshot=request.workspace_snapshot,
            repair_context=request.repair_context,
        )


runtime = AgentRuntime()


@app.get("/health")
async def health() -> dict:
    settings = get_settings()
    return {
        "status": "ok",
        "modes": [ReasoningMode.PLAN_SOLVE.value, ReasoningMode.REACT.value],
        "qwenConfigured": bool(settings.qwen_api_key),
        "provider": settings.model_provider,
        "route": {
            "clarifierModel": settings.resolved_clarifier_model,
            "plannerModel": settings.resolved_planner_model,
            "coderModel": settings.resolved_coder_model,
            "criticModel": settings.resolved_critic_model,
        },
    }


@app.post("/agent/turn", response_model=AgentTurnResponse)
async def agent_turn(request: AgentTurnRequest) -> AgentTurnResponse:
    state = await asyncio.to_thread(runtime.process_turn, request)
    return AgentTurnResponse(state=state)


@app.post("/agent/repair", response_model=AgentRepairResponse)
async def agent_repair(request: AgentRepairRequest) -> AgentRepairResponse:
    state = await asyncio.to_thread(runtime.process_repair, request)
    return AgentRepairResponse(state=state)
