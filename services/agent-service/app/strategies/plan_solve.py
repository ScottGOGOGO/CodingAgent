from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.strategies.base import StrategyAdapter


class PlanSolveStrategy(StrategyAdapter):
    def build_graph(self) -> StateGraph:
        builder = StateGraph(dict)
        builder.add_node("clarify", self.clarify)
        builder.add_node("spec_normalize", self.spec_normalize)
        builder.add_node("plan", self.plan)
        builder.add_node("generate", self.generate)
        builder.add_node("review", self.review)
        builder.add_node("verify", self.verify)
        builder.add_node("propose_run", self.propose_run)
        builder.add_node("wait_for_confirmation", self.wait_for_confirmation)
        builder.add_node("run", self.run)
        builder.add_node("report", self.report)

        builder.add_edge(START, "clarify")
        builder.add_conditional_edges("clarify", self.route_after_clarify)
        builder.add_edge("spec_normalize", "plan")
        builder.add_edge("plan", "generate")
        builder.add_edge("generate", "review")
        builder.add_edge("review", "verify")
        builder.add_edge("verify", "propose_run")
        builder.add_edge("propose_run", "wait_for_confirmation")
        builder.add_conditional_edges("wait_for_confirmation", self.route_after_wait, {"report": "report", "run": "run"})
        builder.add_edge("run", "report")
        builder.add_edge("report", END)

        return builder
