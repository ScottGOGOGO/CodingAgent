from __future__ import annotations

import re
from typing import Iterable, List, Set

from app.models import AgentSessionState, WorkspaceFile


CORE_CONTEXT_PATHS = (
    "package.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    "index.html",
    "src/main.tsx",
    "src/App.tsx",
    "src/styles.css",
)


def _tokens(values: Iterable[str]) -> Set[str]:
    tokens: Set[str] = set()
    for value in values:
        for token in re.split(r"[^a-zA-Z0-9]+", value.lower()):
            if len(token) >= 3:
                tokens.add(token)
    return tokens


class ContextBuilder:
    def select(self, state: AgentSessionState, workspace_snapshot: List[WorkspaceFile], limit: int = 12) -> List[WorkspaceFile]:
        if not workspace_snapshot:
            state.last_context_paths = []
            return []

        prioritized: List[WorkspaceFile] = []
        by_path = {item.path: item for item in workspace_snapshot}
        for path in CORE_CONTEXT_PATHS:
            if path in by_path:
                prioritized.append(by_path[path])

        terms = _tokens(
            [state.app_spec.title, state.app_spec.summary, state.app_spec.goal]
            + state.app_spec.integrations
            + [screen.name for screen in state.app_spec.screens]
            + [screen.purpose for screen in state.app_spec.screens]
            + [flow.name for flow in state.app_spec.core_flows]
            + [step for flow in state.app_spec.core_flows for step in flow.steps]
        )

        scored: List[tuple[int, WorkspaceFile]] = []
        for item in workspace_snapshot:
            if item.path in {selected.path for selected in prioritized}:
                continue
            haystack = f"{item.path}\n{item.content[:4000]}".lower()
            score = sum(1 for token in terms if token in haystack)
            if score > 0:
                scored.append((score, item))

        scored.sort(key=lambda item: (-item[0], item[1].path))
        selected = prioritized + [item for _, item in scored]
        trimmed = selected[:limit]
        state.last_context_paths = [item.path for item in trimmed]
        return trimmed
