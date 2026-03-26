from __future__ import annotations

from abc import ABC, abstractmethod
import posixpath
import re
from typing import Any, Dict, List, Optional

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from app.models import (
    AgentSessionState,
    ClarificationAnswer,
    FileOperation,
    PatchHunk,
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
from app.services.model_provider import ModelProvider
from app.services.spec_builder import SpecBuilder


class StrategyAdapter(ABC):
    LOCAL_IMPORT_FROM_RE = re.compile(r"""from\s+["'](\.{1,2}/[^"']+)["']""")
    LOCAL_IMPORT_SIDE_EFFECT_RE = re.compile(r"""import\s+["'](\.{1,2}/[^"']+)["']""")
    LOCAL_REQUIRE_RE = re.compile(r"""require\(\s*["'](\.{1,2}/[^"']+)["']\s*\)""")
    PLACEHOLDER_MARKERS = (
        "待实现",
        "未实现",
        "占位",
        "占位符",
        "todo",
        "coming soon",
        "敬请期待",
        "稍后上线",
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
        "未实现界面",
        "占位界面",
        "占位符界面",
        "空白脚手架",
        "页面骨架",
        "路由骨架",
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
        "未实现界面",
        "占位界面",
        "占位符界面",
        "空白脚手架",
        "页面骨架",
        "路由骨架",
        "占位路由",
        "空页面",
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
        self.model_provider = ModelProvider()
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

        verification_error = self._preflight_generation_error(state, workspace_snapshot)
        if verification_error:
            repaired_state = self._attempt_preflight_repair(state, workspace_snapshot, verification_error)
            if repaired_state is not None:
                state = repaired_state
                verification_error = self._preflight_generation_error(state, workspace_snapshot)

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

        state.evaluation = self.critic.evaluate(state)
        if self._critic_found_blocking_stub_feedback(state.evaluation.summary, state.evaluation.issues):
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

        design_polish_applied = False
        if self._should_attempt_design_polish(state):
            polished_state = self._attempt_design_polish(state, workspace_snapshot)
            if polished_state is not None:
                state = polished_state
                state.evaluation = self.critic.evaluate(state)
                design_polish_applied = True

                if self._critic_found_blocking_stub_feedback(state.evaluation.summary, state.evaluation.issues):
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

        if design_polish_applied and state.evaluation is not None:
            state.evaluation.design_warnings = self._decorate_design_warnings_after_polish(state.evaluation)

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

    def _preflight_generation_error(
        self,
        state: AgentSessionState,
        workspace_snapshot: List[WorkspaceFile],
    ) -> Optional[str]:
        if not state.file_operations:
            return "代码生成器没有返回任何文件操作。"

        existing_paths = {item.path for item in workspace_snapshot}
        final_paths = set(existing_paths)
        for operation in state.file_operations:
            if operation.type in {"write", "patch"}:
                final_paths.add(operation.path)
            elif operation.type == "delete":
                final_paths.discard(operation.path)

        required_paths = {"package.json", "index.html", "src/main.tsx", "src/App.tsx"}
        if not required_paths.issubset(final_paths):
            return "当前生成的文件操作还不能产出可运行的 React + Vite 应用。"

        placeholder_paths = self._find_placeholder_paths(state.file_operations)
        if placeholder_paths:
            return (
                "生成的文件操作中仍包含占位或 TODO 界面内容，涉及 "
                f"{', '.join(placeholder_paths)}。请先生成真实可用的用户页面，再进入审批。"
            )

        missing_imports = self._find_missing_local_imports(state.file_operations, final_paths)
        if missing_imports:
            return (
                "生成的文件操作中引用了尚未生成的本地文件："
                f"{', '.join(missing_imports)}。请补齐所有被引用的本地模块后再进入审批。"
            )

        return None

    def _attempt_preflight_repair(
        self,
        state: AgentSessionState,
        workspace_snapshot: List[WorkspaceFile],
        error: str,
    ) -> Optional[AgentSessionState]:
        if state.app_spec is None or not state.file_operations:
            return None

        merged_snapshot = self._materialize_workspace_snapshot(workspace_snapshot, state.file_operations)
        context_snapshot = self.context_builder.select(state, merged_snapshot)

        try:
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
            full_snapshot = self._materialize_workspace_snapshot(merged_snapshot, repaired_state.file_operations)
            repaired_state.file_operations = self._snapshot_to_write_operations(full_snapshot)
            repaired_state.file_change_summary = [operation.summary for operation in repaired_state.file_operations]
            return repaired_state
        except Exception:
            return None

    def _attempt_design_polish(
        self,
        state: AgentSessionState,
        workspace_snapshot: List[WorkspaceFile],
    ) -> Optional[AgentSessionState]:
        if state.app_spec is None or not state.file_operations or state.evaluation is None:
            return None

        merged_snapshot = self._materialize_workspace_snapshot(workspace_snapshot, state.file_operations)
        context_snapshot = self.context_builder.select(state, merged_snapshot)
        polish_brief = "\n".join(
            [
                state.evaluation.summary,
                *(f"- {warning}" for warning in state.evaluation.design_warnings),
                "请在不改变核心功能路径和数据结构的前提下，提升 Tailwind 主题系统、视觉层级、响应式布局与关键交互反馈。",
            ]
        ).strip()

        try:
            polished_state = self.codegen.repair(
                state,
                state.app_spec,
                context_snapshot,
                RepairContext(
                    attempt=1,
                    category="design_polish",
                    failedCommand="design quality review",
                    buildError=polish_brief,
                ),
            )
            full_snapshot = self._materialize_workspace_snapshot(merged_snapshot, polished_state.file_operations)
            polished_state.file_operations = self._snapshot_to_write_operations(full_snapshot)
            polished_state.file_change_summary = [operation.summary for operation in polished_state.file_operations]
            return polished_state
        except Exception:
            return None

    def _materialize_workspace_snapshot(
        self,
        workspace_snapshot: List[WorkspaceFile],
        file_operations: List[FileOperation],
    ) -> List[WorkspaceFile]:
        lookup = {item.path: item.content for item in workspace_snapshot}

        for operation in file_operations:
            if operation.type == "delete":
                lookup.pop(operation.path, None)
                continue

            if operation.type == "write":
                lookup[operation.path] = operation.content or ""
                continue

            if operation.type == "patch":
                base_content = lookup.get(operation.path, "")
                lookup[operation.path] = self._apply_patch_hunks(base_content, operation.hunks, operation.fallback_content)

        return [WorkspaceFile(path=path, content=content) for path, content in sorted(lookup.items())]

    @staticmethod
    def _snapshot_to_write_operations(files: List[WorkspaceFile]) -> List[FileOperation]:
        return [
            FileOperation(
                type="write",
                path=file.path,
                summary=f"Write {file.path}.",
                content=file.content,
            )
            for file in files
        ]

    @staticmethod
    def _apply_patch_hunks(content: str, hunks: List[PatchHunk], fallback_content: Optional[str]) -> str:
        updated = content

        for hunk in hunks:
            occurrence = max(1, hunk.occurrence)
            start = -1
            search_from = 0
            for _ in range(occurrence):
                start = updated.find(hunk.search, search_from)
                if start == -1:
                    break
                search_from = start + len(hunk.search)

            if start == -1:
                if fallback_content is not None:
                    return fallback_content
                continue

            updated = updated[:start] + hunk.replace + updated[start + len(hunk.search) :]

        return updated

    @staticmethod
    def _should_attempt_design_polish(state: AgentSessionState) -> bool:
        if state.evaluation is None:
            return False
        return (
            state.evaluation.design_quality_score < 0.70
            or state.evaluation.interaction_quality_score < 0.65
        )

    @staticmethod
    def _decorate_design_warnings_after_polish(evaluation) -> List[str]:
        warnings = list(evaluation.design_warnings)
        note = "已执行一轮 Tailwind 视觉增强。"
        if (
            evaluation.design_quality_score < 0.70
            or evaluation.interaction_quality_score < 0.65
        ):
            note = "已执行一轮 Tailwind 视觉增强，当前结果仍建议人工审阅视觉层级与交互细节。"

        if note not in warnings:
            warnings.insert(0, note)
        return warnings

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
            getattr(operation, "replace", None),
        ):
            if isinstance(value, str) and value.strip():
                texts.append(StrategyAdapter._sanitize_operation_text(value))

        for hunk in getattr(operation, "hunks", []) or []:
            for value in (getattr(hunk, "replace", None),):
                if isinstance(value, str) and value.strip():
                    texts.append(StrategyAdapter._sanitize_operation_text(value))
        return texts

    @classmethod
    def _find_missing_local_imports(cls, operations: List[Any], final_paths: set[str]) -> List[str]:
        missing: List[str] = []
        seen = set()

        for operation in operations:
            path = getattr(operation, "path", "")
            if not path.endswith((".tsx", ".jsx", ".ts", ".js")):
                continue

            text_fragments = []
            for value in (
                getattr(operation, "content", None),
                getattr(operation, "fallback_content", None),
                getattr(operation, "fallbackContent", None),
                getattr(operation, "replace", None),
            ):
                if isinstance(value, str) and value.strip():
                    text_fragments.append(value)

            for hunk in getattr(operation, "hunks", []) or []:
                replace = getattr(hunk, "replace", None)
                if isinstance(replace, str) and replace.strip():
                    text_fragments.append(replace)

            for text in text_fragments:
                for import_path in cls._extract_local_imports(text):
                    if cls._has_matching_local_import_target(path, import_path, final_paths):
                        continue
                    key = f"{path} -> {import_path}"
                    if key not in seen:
                        seen.add(key)
                        missing.append(key)

        return missing

    @classmethod
    def _extract_local_imports(cls, text: str) -> List[str]:
        matches = []
        for pattern in (cls.LOCAL_IMPORT_FROM_RE, cls.LOCAL_IMPORT_SIDE_EFFECT_RE, cls.LOCAL_REQUIRE_RE):
            matches.extend(pattern.findall(text))
        return matches

    @staticmethod
    def _has_matching_local_import_target(source_path: str, import_path: str, final_paths: set[str]) -> bool:
        source_dir = posixpath.dirname(source_path)
        base_path = posixpath.normpath(posixpath.join(source_dir, import_path))
        candidates = [base_path]

        known_extensions = (".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".sass", ".less", ".json")
        if not base_path.endswith(known_extensions):
            for extension in known_extensions:
                candidates.append(f"{base_path}{extension}")
            for extension in (".ts", ".tsx", ".js", ".jsx"):
                candidates.append(posixpath.join(base_path, f"index{extension}"))

        return any(candidate in final_paths for candidate in candidates)

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
