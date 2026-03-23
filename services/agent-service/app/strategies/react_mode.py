from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from app.models import AgentSessionState
from app.strategies.base import StrategyAdapter


class ReactStrategy(StrategyAdapter):
    def build_graph(self) -> StateGraph:
        builder = StateGraph(dict)
        builder.add_node("observe", self.observe)
        builder.add_node("act_tool_loop", self.act_tool_loop)
        builder.add_node("verify", self.verify)
        builder.add_node("propose_run", self.propose_run)
        builder.add_node("wait_for_confirmation", self.wait_for_confirmation)
        builder.add_node("run", self.run)
        builder.add_node("report", self.report)

        builder.add_edge(START, "observe")
        builder.add_edge("observe", "act_tool_loop")
        builder.add_edge("act_tool_loop", "verify")
        builder.add_edge("verify", "propose_run")
        builder.add_edge("propose_run", "wait_for_confirmation")
        builder.add_conditional_edges("wait_for_confirmation", self.route_after_wait, {"report": "report", "run": "run"})
        builder.add_edge("run", "report")
        builder.add_edge("report", END)
        return builder

    def observe(self, payload: dict) -> dict:
        state = AgentSessionState.model_validate(payload["state"])
        state = self.clarify({"state": state.as_contract()})["state"]
        return {"state": state}

    def act_tool_loop(self, payload: dict) -> dict:
        state = AgentSessionState.model_validate(payload["state"])
        if state.status.value == "clarifying":
            return {"state": state.as_contract()}
        workspace_snapshot = payload.get("workspace_snapshot", [])
        state.app_spec = self.spec_builder.build_spec(state)
        state.plan_steps = self.spec_builder.build_plan(state, state.app_spec)
        state = self.codegen.generate(state, state.app_spec, workspace_snapshot)
        state.assistant_summary = f"Prepared a ReAct-style execution package for {state.app_spec.title}."
        return {"state": state.as_contract()}
