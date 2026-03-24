from __future__ import annotations

from app.strategies.plan_solve import PlanSolveStrategy


class ReactStrategy(PlanSolveStrategy):
    """Compatibility wrapper.

    The public API still accepts reasoningMode="react", but the runtime now
    routes both modes through the same LangGraph orchestration flow.
    """
