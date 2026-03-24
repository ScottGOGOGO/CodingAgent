from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.strategies.base import StrategyAdapter


class PlanSolveStrategy(StrategyAdapter):
    def build_graph(self) -> StateGraph:
        builder = StateGraph(dict)
        builder.add_node("intake", self.intake)
        builder.add_node("dynamic_clarify", self.dynamic_clarify)
        builder.add_node("normalize_spec", self.normalize_spec)
        builder.add_node("planning", self.planning)
        builder.add_node("context_build", self.context_build)
        builder.add_node("implement_loop", self.implement_loop)
        builder.add_node("verify_loop", self.verify_loop)
        builder.add_node("approval_interrupt", self.approval_interrupt)
        builder.add_node("execute_dispatch", self.execute_dispatch)
        builder.add_node("report", self.report)

        builder.add_edge(START, "intake")
        builder.add_edge("intake", "dynamic_clarify")
        builder.add_conditional_edges("dynamic_clarify", self.route_after_clarify)
        builder.add_edge("normalize_spec", "planning")
        builder.add_edge("planning", "context_build")
        builder.add_edge("context_build", "implement_loop")
        builder.add_edge("implement_loop", "verify_loop")
        builder.add_edge("verify_loop", "approval_interrupt")
        builder.add_conditional_edges("approval_interrupt", self.route_after_approval)
        builder.add_edge("execute_dispatch", "report")
        builder.add_edge("report", END)

        return builder
