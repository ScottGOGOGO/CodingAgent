from __future__ import annotations

import logging
import re
import time
from json import dumps, loads
from typing import Dict, List, Optional, Sequence, Tuple

from langchain_core.messages import BaseMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate

from app.models import (
    AgentSessionState,
    AppSpec,
    ExecutionStep,
    FileOperation,
    GeneratedCodeOutput,
    PatchHunk,
    RepairContext,
    StructuredFileOperationOutput,
    StructuredGeneratedCodeOutput,
    WorkspaceFile,
)
from app.services.errors import GenerationFailure
from app.services.invoke_timeout import ModelInvokeTimeoutError, invoke_with_hard_timeout
from app.services.json_parser import EMPTY_JSON_RESPONSE_ERROR, parse_json_response
from app.services.model_provider import ModelProvider


USER_FACING_LANGUAGE_RULE = (
    "除非用户明确要求其他语言，所有面向用户的自然语言内容都必须使用简体中文，"
    "包括 assistantSummary、operation summary、界面文案、示例内容和可见标签；"
    "保留 JSON key、文件路径和必要的代码标识符格式。"
)
EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 2
TRANSPORT_RECOVERY_ATTEMPTS = 2
TRANSPORT_RETRY_BACKOFF_SECONDS = 0.25
CODEGEN_PHASE_TIMEOUT_SECONDS = {
    "single_pass": 70.0,
    "single_pass_rescue": 65.0,
    "text_rescue": 40.0,
    "bootstrap": 90.0,
    "bootstrap_minimal": 75.0,
    "feature_enrichment": 45.0,
    "repair": 60.0,
}
logger = logging.getLogger("vide.agent.stages")


class CodeGenerationService:
    def __init__(self) -> None:
        self.provider = ModelProvider()

    def generate(self, state: AgentSessionState, spec: AppSpec, context_snapshot: List[WorkspaceFile]) -> AgentSessionState:
        return self._apply_generation_result(state, self._invoke_generation(state, spec, context_snapshot), spec.title)

    def repair(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
        repair_context: RepairContext,
    ) -> AgentSessionState:
        generation = self._invoke_repair(state, spec, context_snapshot, repair_context)
        return self._apply_generation_result(
            state,
            generation,
            spec.title,
            default_summary_prefix=f"已完成第 {repair_context.attempt} 轮修复",
        )

    def _apply_generation_result(
        self,
        state: AgentSessionState,
        generation: GeneratedCodeOutput,
        title: str,
        default_summary_prefix: str = "已生成",
    ) -> AgentSessionState:
        operations = generation.operations
        state.file_operations = operations
        state.file_change_summary = [item.summary for item in operations]
        state.assistant_summary = generation.assistant_summary or f"{default_summary_prefix}：{title}"
        state.execution_manifest = self._build_execution_manifest(state, title)
        return state

    def _invoke_generation(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
    ) -> GeneratedCodeOutput:
        try:
            if self._should_use_staged_generation(context_snapshot):
                return self._invoke_staged_generation(state, spec, context_snapshot)

            return self._invoke_generation_phase(
                state=state,
                spec=spec,
                context_snapshot=context_snapshot,
                phase_name="single_pass",
                phase_brief=(
                    "Generate the complete implementation in one pass. "
                    "Return the smallest set of operations that produces the fully realized app for this brief."
                ),
                conversation_limit=6,
            )
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise GenerationFailure(f"代码生成阶段模型调用失败：{exc}") from exc
            raise GenerationFailure(f"代码生成模型在生成代码时失败：{exc}") from exc

    def _invoke_staged_generation(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
    ) -> GeneratedCodeOutput:
        self._log_invoke_event(
            "staged_selected",
            state,
            workspace_files=len(context_snapshot),
        )

        try:
            bootstrap = self._invoke_bootstrap_phase(state, spec, context_snapshot)
        except Exception as exc:
            if isinstance(exc, GenerationFailure) and self._is_transport_failure(exc):
                return self._invoke_transport_rescue(
                    state=state,
                    spec=spec,
                    context_snapshot=context_snapshot,
                    rescue_reason="bootstrap_transport_failure",
                )
            if isinstance(exc, GenerationFailure):
                raise GenerationFailure(f"小步生成的基础骨架阶段失败：{exc}") from exc
            raise

        phase_one_snapshot = self._materialize_workspace_snapshot(context_snapshot, bootstrap.operations)
        self._log_invoke_event(
            "bootstrap_snapshot_ready",
            state,
            files=len(phase_one_snapshot),
            operations=len(bootstrap.operations),
        )
        try:
            enrichment = self._invoke_feature_enrichment_phase(state, spec, phase_one_snapshot)
        except Exception as exc:
            if isinstance(exc, GenerationFailure) and self._is_transport_failure(exc):
                rescue = self._invoke_transport_rescue(
                    state=state,
                    spec=spec,
                    context_snapshot=phase_one_snapshot,
                    rescue_reason="feature_enrichment_transport_failure",
                )
                return GeneratedCodeOutput(
                    assistantSummary=rescue.assistant_summary or bootstrap.assistant_summary,
                    operations=[*bootstrap.operations, *rescue.operations],
                )
            if isinstance(exc, GenerationFailure):
                raise GenerationFailure(f"小步生成的功能完善阶段失败：{exc}") from exc
            raise

        return GeneratedCodeOutput(
            assistantSummary=enrichment.assistant_summary or bootstrap.assistant_summary,
            operations=[*bootstrap.operations, *enrichment.operations],
        )

    def _invoke_generation_phase(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
        phase_name: str,
        phase_brief: str,
        conversation_limit: int,
        spec_payload: Optional[dict] = None,
    ) -> GeneratedCodeOutput:
        prompt = self._build_generation_prompt()

        model = self.provider.require_chat_model("coder", timeout_seconds=self._coder_timeout_for_phase(phase_name))
        messages = prompt.format_messages(
            messages=dumps(
                self._serialize_conversation_for_codegen(state, limit=conversation_limit),
                ensure_ascii=False,
            ),
            spec=dumps(spec_payload or self._serialize_spec_for_codegen(spec), ensure_ascii=False),
            workspace=dumps(self._serialize_workspace_for_codegen(context_snapshot), ensure_ascii=False),
            phase_name=phase_name,
            phase_brief=phase_brief,
        )
        return self._invoke_and_normalize(
            model,
            messages,
            context_snapshot,
            state=state,
            invocation_kind=f"generate_{phase_name}",
            timeout_seconds=self._coder_timeout_for_phase(phase_name),
            structured_output_method=self.provider.preferred_structured_output_method("coder"),
        )

    def _invoke_bootstrap_phase(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
    ) -> GeneratedCodeOutput:
        bootstrap_error: Exception | None = None
        try:
            return self._invoke_bootstrap_generation_phase(
                state=state,
                spec=spec,
                context_snapshot=context_snapshot,
                phase_name="bootstrap",
                phase_brief=(
                    "This is phase 1 of 2 for a fresh or incomplete app. "
                    "The selected workspace may be empty or missing foundational files. "
                    "Create every file required for a runnable React + Vite TypeScript app in this phase, including any missing package metadata, HTML entry, TypeScript config, React entry files, and the first polished user-facing screen. "
                    "Do not assume any scaffold already exists. "
                    "Keep the file set lean, but make sure npm install && npm run build can succeed after this phase."
                ),
                conversation_limit=4,
                spec_payload=self._serialize_spec_for_bootstrap(spec),
            )
        except Exception as exc:
            bootstrap_error = exc
            if not self._is_transport_failure_message(str(exc)):
                raise

            self._log_invoke_event(
                "bootstrap_minimal_retry",
                state,
                error=self._compact_error(exc),
            )
        try:
            return self._invoke_bootstrap_generation_phase(
                state=state,
                spec=spec,
                context_snapshot=context_snapshot,
                phase_name="bootstrap_minimal",
                phase_brief=(
                    "This is a retry for phase 1 after a transport failure. "
                    "Return the smallest complete React + Vite TypeScript app that can install and build successfully. "
                    "Include the minimal required foundation files plus one polished primary screen. "
                    "Avoid optional routes, utilities, hooks, stores, and extra dependencies unless they are essential."
                ),
                conversation_limit=3,
                spec_payload=self._serialize_spec_for_minimal_bootstrap(spec),
            )
        except Exception as retry_exc:
            if self._is_transport_failure(retry_exc):
                self._log_invoke_event(
                    "bootstrap_minimal_failed",
                    state,
                    error=self._compact_error(retry_exc),
                )
                raise GenerationFailure(
                    "小步生成的基础骨架阶段在 bootstrap 与 bootstrap_minimal 两次传输恢复后仍失败。"
                    f" bootstrap={self._compact_error(bootstrap_error or retry_exc)};"
                    f" bootstrap_minimal={self._compact_error(retry_exc)}"
                ) from retry_exc
            raise

    def _invoke_bootstrap_generation_phase(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
        phase_name: str,
        phase_brief: str,
        conversation_limit: int,
        spec_payload: dict,
    ) -> GeneratedCodeOutput:
        return self._invoke_generation_phase(
            state=state,
            spec=spec,
            context_snapshot=context_snapshot,
            phase_name=phase_name,
            phase_brief=phase_brief,
            conversation_limit=conversation_limit,
            spec_payload=spec_payload,
        )

    def _invoke_feature_enrichment_phase(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
    ) -> GeneratedCodeOutput:
        return self._invoke_generation_phase(
            state=state,
            spec=spec,
            context_snapshot=context_snapshot,
            phase_name="feature_enrichment",
            phase_brief=(
                "This is phase 2 of 2 for a fresh or incomplete app. "
                "A runnable foundation already exists in the workspace snapshot. "
                "Refine the generated implementation so the primary user flow feels complete, polished, and aligned with the full spec. "
                "Prefer patch operations and keep the delta focused on product depth, interaction quality, and visual finish."
            ),
            conversation_limit=6,
        )

    def _invoke_single_pass_rescue(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
        rescue_reason: str,
    ) -> GeneratedCodeOutput:
        return self._invoke_generation_phase(
            state=state,
            spec=spec,
            context_snapshot=context_snapshot,
            phase_name="single_pass_rescue",
            phase_brief=(
                "This is a rescue single-pass generation after staged transport failures. "
                f"Rescue reason: {rescue_reason}. "
                "Produce the smallest complete React + Vite TypeScript implementation that is runnable, visually coherent, and ready for verification. "
                "Prefer a compact operation set and avoid optional expansion unless it is required for a complete user flow."
            ),
            conversation_limit=4,
            spec_payload=self._serialize_spec_for_bootstrap(spec),
        )

    def _invoke_transport_rescue(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
        rescue_reason: str,
    ) -> GeneratedCodeOutput:
        self._log_invoke_event(
            "single_pass_rescue_selected",
            state,
            rescue_reason=rescue_reason,
            workspace_files=len(context_snapshot),
        )
        try:
            return self._invoke_single_pass_rescue(
                state=state,
                spec=spec,
                context_snapshot=context_snapshot,
                rescue_reason=rescue_reason,
            )
        except Exception as rescue_exc:
            if isinstance(rescue_exc, GenerationFailure) and self._is_transport_failure(rescue_exc):
                self._log_invoke_event(
                    "text_file_rescue_selected",
                    state,
                    rescue_reason=rescue_reason,
                    workspace_files=len(context_snapshot),
                    error=self._compact_error(rescue_exc),
                )
                try:
                    return self._invoke_file_by_file_bootstrap_rescue(
                        state=state,
                        spec=spec,
                        context_snapshot=context_snapshot,
                        rescue_reason=rescue_reason,
                    )
                except Exception as text_rescue_exc:
                    if isinstance(text_rescue_exc, GenerationFailure):
                        raise GenerationFailure(
                            "代码生成阶段在 single-pass rescue 与逐文件 text rescue 后仍失败。"
                            f" single_pass_rescue={self._compact_error(rescue_exc)};"
                            f" text_rescue={self._compact_error(text_rescue_exc)}"
                        ) from text_rescue_exc
                    raise
            if isinstance(rescue_exc, GenerationFailure):
                raise GenerationFailure(f"single-pass rescue 失败：{rescue_exc}") from rescue_exc
            raise

    @staticmethod
    def _build_generation_prompt() -> ChatPromptTemplate:
        return ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are generating production-ready React + Vite TypeScript code. "
                    "Prefer patch-first editing for existing files: use type=patch with small hunks whenever possible. "
                    "Use type=write for new files or when a patch would be unsafe. "
                    "Use type=delete only when a file is clearly obsolete. "
                    "Do not emit op=run or shell commands. Never ask the executor to run npm install manually. "
                    "Do not ship placeholder, stub, or TODO screens. Avoid text such as 待实现, placeholder, coming soon, lorem ipsum, or empty route shells. "
                    "If a real media asset is unavailable, render a styled poster, diagram, or descriptive card instead of telling the user it is a placeholder or would be implemented later. "
                    "You are free to choose the UI approach and component stack that best fits the brief. "
                    "Tailwind CSS, Radix UI primitives, shadcn/ui-style local components, Framer Motion, React Router, lucide-react, Zustand, TanStack Query, clsx, tailwind-merge, and similar lightweight React ecosystem tools are allowed when they materially improve the result. "
                    "Use the smallest dependency set that meaningfully helps the app. "
                    "If you use Tailwind utility classes, @tailwind directives, or @apply, you must also add the complete Tailwind toolchain and config files in the same response. "
                    "Assume the automatic JSX runtime is enabled, so do not import React by default unless you need React namespace APIs such as React.useState. "
                    "Avoid introducing unused imports, unused variables, unused functions, or unused useState setters. "
                    "If only the state value is used, destructure useState as [value] instead of [value, setValue]. "
                    "Do not leave code comments that describe unfinished UI as placeholder or TODO. "
                    "At least one primary route must render a fully designed screen with real sections, realistic sample content, clear hierarchy, and visible interaction feedback that reflect the spec and designTargets. "
                    "Avoid generic template output that ignores the actual product domain or designTargets, but do not force every app into one house style. "
                    "Let the visual language, layout rhythm, and component choices follow the brief rather than a fixed template recipe. "
                    "Do not introduce a framework or runtime outside React + Vite TypeScript. "
                    "Every local import you reference must either already exist in the selected workspace context or be created/updated in this same response. "
                    "Do not import missing local components, pages, hooks, utils, or stylesheets. "
                    "Do not return partial file fragments in content. "
                    "If you use type=write for an existing file, content must contain the complete final file from its first line to its last line. "
                    "If only part of an existing file changes, return patch hunks or before/after replacement data instead of a snippet. "
                    f"{USER_FACING_LANGUAGE_RULE}"
                    "Return valid JSON only with keys assistantSummary and operations. "
                    "Each operation must contain type, path, summary, and either content or hunks when required. "
                    "Patch hunks must contain search, replace, and optional occurrence. "
                    "The result must build with npm install && npm run build and run with npm run dev.",
                ),
                (
                    "human",
                    "Current generation phase: {phase_name}\n"
                    "Phase brief:\n{phase_brief}\n\n"
                    "Latest conversation:\n{messages}\n\n"
                    "Normalized app spec:\n{spec}\n\n"
                    "Selected implementation context:\n{workspace}\n\n"
                    "If you add external packages, include them in package.json in the same response.\n"
                    "Interpret spec.designTargets as the visual brief: the layout, styling system, component language, and motion choices should clearly embody it.\n"
                    "If the app uses multiple routes, each visible route must present substantive UI instead of route stubs.\n"
                    "Return only the operations needed for this phase.",
                ),
            ]
        )

    @staticmethod
    def _build_bootstrap_prompt() -> ChatPromptTemplate:
        return ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are a coding model. Return only the final TSX contents of src/App.tsx.",
                ),
                (
                    "human",
                    "Create a compact Chinese React app screen for {title}. "
                    "Requirements: {requirements}. "
                    "Single file only, use inline styles, no markdown, no explanation.",
                ),
            ]
        )

    @staticmethod
    def _build_text_rescue_file_prompt() -> ChatPromptTemplate:
        return ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are generating exactly one complete file for a React + Vite TypeScript app rescue. "
                    "Return only the final contents of the requested file. "
                    "Do not wrap the answer in Markdown fences, backticks, or explanations. "
                    "If the target file is JSON, return strict valid JSON only. "
                    f"{USER_FACING_LANGUAGE_RULE}",
                ),
                (
                    "human",
                    "Rescue reason: {rescue_reason}\n"
                    "Target file: {target_path}\n"
                    "File role: {file_role}\n"
                    "File requirements:\n{file_requirements}\n\n"
                    "Normalized app brief:\n{app_brief}\n\n"
                    "Current rescued workspace snapshot:\n{workspace}\n\n"
                    "Return only the full content for {target_path}.",
                ),
            ]
        )

    @staticmethod
    def _build_text_rescue_file_plan() -> List[Dict[str, str]]:
        return [
            {
                "path": "package.json",
                "summary": "写入最小依赖与脚本",
                "role": "Package manifest",
                "requirements": (
                    "Return a minimal valid package.json for a React + Vite TypeScript app. "
                    "Include scripts dev, build, and preview. "
                    "Include dependencies react and react-dom. "
                    "Include devDependencies vite, typescript, and @vitejs/plugin-react. "
                    "Keep versions modern and compatible."
                ),
            },
            {
                "path": "tsconfig.json",
                "summary": "写入 TypeScript 配置",
                "role": "TypeScript config",
                "requirements": (
                    "Return a minimal valid tsconfig.json suitable for a React + Vite TypeScript app. "
                    "Enable modern ES modules, JSX support, DOM libs, and bundler-style module resolution."
                ),
            },
            {
                "path": "vite.config.ts",
                "summary": "写入 Vite 配置",
                "role": "Vite config",
                "requirements": (
                    "Return a complete vite.config.ts that uses defineConfig and @vitejs/plugin-react. "
                    "Keep the config minimal."
                ),
            },
            {
                "path": "index.html",
                "summary": "写入 HTML 入口",
                "role": "HTML entry file",
                "requirements": (
                    "Return a complete index.html for a Vite app. "
                    "Include a root div with id root and a title aligned with the app brief."
                ),
            },
            {
                "path": "src/main.tsx",
                "summary": "写入 React 入口",
                "role": "React entry file",
                "requirements": (
                    "Return a complete src/main.tsx that imports App from ./App and ./index.css, "
                    "creates the React root, and renders the app."
                ),
            },
            {
                "path": "src/index.css",
                "summary": "写入全局样式",
                "role": "Global stylesheet",
                "requirements": (
                    "Return a complete src/index.css with polished global styles that support the app brief. "
                    "Keep it lean but visually intentional, mobile-friendly, and production-ready."
                ),
            },
            {
                "path": "src/App.tsx",
                "summary": "写入主界面",
                "role": "Primary app screen",
                "requirements": (
                    "Return a complete src/App.tsx implementing the primary user flow from the app brief. "
                    "Use React + TypeScript only. "
                    "The UI must feel complete, use simplified Chinese for visible copy, and avoid TODO or placeholder language. "
                    "Use local state and realistic sample data when needed."
                ),
            },
        ]

    def _invoke_file_by_file_bootstrap_rescue(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
        rescue_reason: str,
    ) -> GeneratedCodeOutput:
        model = self.provider.require_chat_model("coder", timeout_seconds=self._coder_timeout_for_phase("text_rescue"))
        prompt = self._build_text_rescue_file_prompt()
        spec_payload = self._serialize_spec_for_bootstrap(spec)
        app_brief = dumps(
            self._build_text_rescue_app_brief(state=state, spec=spec, spec_payload=spec_payload),
            ensure_ascii=False,
        )
        workspace_snapshot = list(context_snapshot)
        operations: List[FileOperation] = []

        for target in self._build_text_rescue_file_plan():
            messages = prompt.format_messages(
                rescue_reason=rescue_reason,
                target_path=target["path"],
                file_role=target["role"],
                file_requirements=target["requirements"],
                app_brief=app_brief,
                workspace=dumps(self._serialize_workspace_for_codegen(workspace_snapshot), ensure_ascii=False),
            )
            content = self._invoke_validated_text_rescue_file(
                model=model,
                messages=messages,
                state=state,
                target_path=target["path"],
                timeout_seconds=self._coder_timeout_for_phase("text_rescue"),
            )
            operation = FileOperation(
                type="write",
                path=target["path"],
                summary=target["summary"],
                content=content,
            )
            operations.append(operation)
            workspace_snapshot = self._materialize_workspace_snapshot(workspace_snapshot, [operation])

        self._log_invoke_event(
            "text_file_rescue_succeeded",
            state,
            rescue_reason=rescue_reason,
            files=len(operations),
        )
        return GeneratedCodeOutput(
            assistantSummary="已通过逐文件 LLM rescue 生成最小可运行版本。",
            operations=operations,
        )

    def _invoke_validated_text_rescue_file(
        self,
        model: object,
        messages: object,
        state: Optional[AgentSessionState],
        target_path: str,
        timeout_seconds: float | None,
    ) -> str:
        invocation_kind = f"text_rescue_{self._sanitize_path_for_log(target_path)}"
        content = self._invoke_text_file_with_transport_retries(
            model=model,
            messages=messages,
            state=state,
            invocation_kind=invocation_kind,
            timeout_seconds=timeout_seconds,
            target_path=target_path,
        )
        try:
            self._validate_text_rescue_file(target_path, content)
            return content
        except GenerationFailure as validation_exc:
            repair_messages = list(messages) + [
                HumanMessage(
                    content=(
                        f"你上一版 {target_path} 未通过校验：{validation_exc}。"
                        "请返回修正后的完整文件内容，不要附带解释或 Markdown。"
                    )
                )
            ]
            repaired = self._invoke_text_file_with_transport_retries(
                model=model,
                messages=repair_messages,
                state=state,
                invocation_kind=f"{invocation_kind}_repair",
                timeout_seconds=timeout_seconds,
                target_path=target_path,
            )
            self._validate_text_rescue_file(target_path, repaired)
            return repaired

    @staticmethod
    def _build_text_rescue_app_brief(state: AgentSessionState, spec: AppSpec, spec_payload: dict) -> dict:
        return {
            "title": spec.title,
            "summary": spec.summary,
            "goal": spec.goal,
            "targetUsers": spec.target_users[:2],
            "recentUserRequests": CodeGenerationService._build_bootstrap_transcript(state, 3),
            "primaryScreen": spec_payload.get("primaryScreen"),
            "primaryFlow": spec_payload.get("primaryFlow"),
            "successCriteria": spec_payload.get("successCriteria"),
            "designTargets": spec_payload.get("designTargets"),
            "brandAndVisualDirection": spec.brand_and_visual_direction,
            "constraints": spec.constraints[:4],
            "implementationHints": CodeGenerationService._build_bootstrap_requirements(state, spec, spec_payload),
        }

    @staticmethod
    def _sanitize_path_for_log(path: str) -> str:
        return re.sub(r"[^a-z0-9]+", "_", path.lower()).strip("_") or "file"

    @staticmethod
    def _validate_text_rescue_file(target_path: str, content: str) -> None:
        normalized = content.strip()
        if not normalized:
            raise GenerationFailure(f"{target_path} 返回了空内容。")

        if target_path.endswith(".json"):
            try:
                parsed = loads(normalized)
            except Exception as exc:
                raise GenerationFailure(f"{target_path} 不是合法 JSON：{exc}") from exc
            if not isinstance(parsed, dict):
                raise GenerationFailure(f"{target_path} 必须是 JSON 对象。")
            if target_path == "package.json":
                scripts = parsed.get("scripts") or {}
                dependencies = parsed.get("dependencies") or {}
                dev_dependencies = parsed.get("devDependencies") or {}
                required_scripts = {"dev", "build", "preview"}
                if not required_scripts.issubset(set(scripts.keys())):
                    raise GenerationFailure("package.json 缺少 dev/build/preview scripts。")
                if "react" not in dependencies or "react-dom" not in dependencies:
                    raise GenerationFailure("package.json 缺少 react 或 react-dom。")
                if "vite" not in dev_dependencies or "typescript" not in dev_dependencies or "@vitejs/plugin-react" not in dev_dependencies:
                    raise GenerationFailure("package.json 缺少 vite、typescript 或 @vitejs/plugin-react。")
            if target_path == "tsconfig.json" and "compilerOptions" not in parsed:
                raise GenerationFailure("tsconfig.json 缺少 compilerOptions。")
            return

        if target_path == "index.html":
            if 'id="root"' not in normalized and "id='root'" not in normalized:
                raise GenerationFailure("index.html 缺少 root 节点。")
            return

        if target_path == "vite.config.ts":
            if "defineConfig" not in normalized or "react(" not in normalized:
                raise GenerationFailure("vite.config.ts 缺少 defineConfig 或 react 插件。")
            return

        if target_path == "src/main.tsx":
            if "createRoot" not in normalized or "./App" not in normalized or "./index.css" not in normalized:
                raise GenerationFailure("src/main.tsx 缺少根渲染或必要导入。")
            return

        if target_path == "src/App.tsx" and "export default" not in normalized:
            raise GenerationFailure("src/App.tsx 缺少默认导出。")

    def _invoke_text_file_with_transport_retries(
        self,
        model: object,
        messages: object,
        state: Optional[AgentSessionState],
        invocation_kind: str,
        timeout_seconds: float | None,
        target_path: str,
    ) -> str:
        last_error: Exception | None = None

        for attempt in range(1, TRANSPORT_RECOVERY_ATTEMPTS + 1):
            attempt_started_at = time.perf_counter()
            try:
                prepared_model, prepared_messages = self._prepare_raw_model_for_invoke(model, messages)
                response = invoke_with_hard_timeout(
                    lambda: prepared_model.invoke(prepared_messages),
                    timeout_seconds=timeout_seconds,
                    timeout_message=f"{invocation_kind} 文本代码生成在 {timeout_seconds} 秒内没有返回。",
                )
                content = self._normalize_text_file_response(response, target_path)
                self._log_invoke_event(
                    "text_attempt_success",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt,
                    duration_ms=round((time.perf_counter() - attempt_started_at) * 1000),
                    path=target_path,
                    content_length=len(content),
                )
                return content
            except Exception as exc:
                last_error = exc
                self._log_invoke_event(
                    "text_attempt_failed",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt,
                    duration_ms=round((time.perf_counter() - attempt_started_at) * 1000),
                    transport=self._is_transport_failure(exc),
                    empty_response=self._is_empty_response_error(exc),
                    error=self._compact_error(exc),
                )
                if not self._is_transport_failure(exc) or attempt >= TRANSPORT_RECOVERY_ATTEMPTS:
                    break

        if last_error is None:
            last_error = GenerationFailure("代码生成阶段未获得模型响应。")
        raise GenerationFailure(f"代码生成阶段文本回退失败：{self._compact_error(last_error)}") from last_error

    def _normalize_text_file_response(self, response: object, target_path: str) -> str:
        content = self._coerce_response_text(getattr(response, "content", response))
        extracted = self._extract_code_from_response(content)
        normalized = extracted.strip()
        if not normalized:
            raise GenerationFailure(f"{target_path} 返回了空响应。")
        if "placeholder" in normalized.lower() or "todo" in normalized.lower():
            normalized = self._polish_generated_copy(normalized)
        if not normalized.endswith("\n"):
            normalized += "\n"
        return normalized

    @staticmethod
    def _coerce_response_text(content: object) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: List[str] = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    text = item.get("text")
                    if isinstance(text, str):
                        parts.append(text)
                else:
                    text = getattr(item, "text", None)
                    if isinstance(text, str):
                        parts.append(text)
            return "".join(parts)
        return str(content)

    @staticmethod
    def _extract_code_from_response(text: str) -> str:
        fence_match = re.search(r"```(?:tsx|typescript|jsx|ts)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
        if fence_match:
            return fence_match.group(1).strip()
        return text.strip()

    @staticmethod
    def _build_local_bootstrap_foundation(spec: AppSpec) -> List[FileOperation]:
        package_json = dumps(
            {
                "name": spec.app_name,
                "private": True,
                "version": "0.0.0",
                "type": "module",
                "scripts": {
                    "dev": "vite",
                    "build": "vite build",
                    "preview": "vite preview",
                },
                "dependencies": {
                    "react": "^19.1.0",
                    "react-dom": "^19.1.0",
                },
                "devDependencies": {
                    "typescript": "^5.9.2",
                    "vite": "^7.1.3",
                },
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n"

        return [
            FileOperation(type="write", path="package.json", summary="写入基础 package.json", content=package_json),
            FileOperation(
                type="write",
                path="index.html",
                summary="写入应用 HTML 入口",
                content=(
                    "<!doctype html>\n"
                    "<html lang=\"zh-CN\">\n"
                    "  <head>\n"
                    "    <meta charset=\"UTF-8\" />\n"
                    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n"
                    f"    <title>{spec.title}</title>\n"
                    "  </head>\n"
                    "  <body>\n"
                    "    <div id=\"root\"></div>\n"
                    "    <script type=\"module\" src=\"/src/main.tsx\"></script>\n"
                    "  </body>\n"
                    "</html>\n"
                ),
            ),
            FileOperation(
                type="write",
                path="src/main.tsx",
                summary="写入 React 入口文件",
                content=(
                    "import { StrictMode } from 'react';\n"
                    "import { createRoot } from 'react-dom/client';\n"
                    "import App from './App';\n"
                    "import './index.css';\n\n"
                    "createRoot(document.getElementById('root')!).render(\n"
                    "  <StrictMode>\n"
                    "    <App />\n"
                    "  </StrictMode>,\n"
                    ");\n"
                ),
            ),
            FileOperation(
                type="write",
                path="src/index.css",
                summary="写入基础全局样式",
                content=(
                    ":root {\n"
                    "  color: #111827;\n"
                    "  background: #f4f7fb;\n"
                    "  color-scheme: light;\n"
                    "  font-family: 'SF Pro Text', 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;\n"
                    "  line-height: 1.5;\n"
                    "  font-weight: 400;\n"
                    "}\n\n"
                    "* {\n"
                    "  box-sizing: border-box;\n"
                    "}\n\n"
                    "html,\n"
                    "body,\n"
                    "#root {\n"
                    "  min-height: 100%;\n"
                    "}\n\n"
                    "body {\n"
                    "  margin: 0;\n"
                    "  background: radial-gradient(circle at top, #ffffff 0%, #eef4ff 45%, #f7f9fc 100%);\n"
                    "}\n\n"
                    "button,\n"
                    "input,\n"
                    "textarea,\n"
                    "select {\n"
                    "  font: inherit;\n"
                    "}\n"
                ),
            ),
        ]

    @staticmethod
    def _build_bootstrap_transcript(state: AgentSessionState, conversation_limit: int) -> str:
        recent_messages = CodeGenerationService._serialize_conversation_for_codegen(state, limit=conversation_limit)
        lines: List[str] = []
        for item in recent_messages:
            role = item["role"]
            if role != "user":
                continue
            content = item["content"].strip()
            if not content:
                continue
            lines.append(content)
        return "；".join(lines)

    @staticmethod
    def _build_bootstrap_requirements(state: AgentSessionState, spec: AppSpec, spec_payload: dict) -> str:
        transcript = CodeGenerationService._build_bootstrap_transcript(state, 2)
        source_text = " ".join(
            part
            for part in [
                transcript,
                spec.goal,
                spec.summary,
                spec.brand_and_visual_direction,
                " ".join(spec_payload.get("successCriteria") or []),
                " ".join((spec_payload.get("primaryScreen") or {}).get("elements") or []),
            ]
            if part
        )

        requirements: List[str] = []
        for keywords, phrase in (
            (("新增", "添加", "create"), "add items"),
            (("编辑", "修改", "edit"), "edit items"),
            (("完成", "勾选", "toggle"), "toggle completion"),
            (("删除", "移除", "delete"), "delete items"),
            (("筛选", "过滤", "filter"), "filter items"),
            (("本地持久化", "本地存储", "localstorage", "persist"), "localStorage persistence"),
            (("清爽明亮", "浅色", "light"), "light clean visual style"),
            (("深色", "黑色", "dark"), "dark visual style"),
            (("手机", "移动端", "mobile"), "mobile-friendly layout"),
            (("桌面", "desktop"), "desktop-friendly layout"),
            (("搜索", "查找", "search"), "search"),
            (("表单", "输入框", "form"), "input flow"),
            (("列表", "list"), "clear list layout"),
            (("图表", "统计", "chart"), "simple data visualization"),
            (("日历", "calendar"), "calendar view"),
            (("通知", "提醒", "reminder"), "notification-ready information design"),
            (("登录", "注册", "auth"), "lightweight authentication UI"),
            (("聊天", "消息", "chat"), "chat-style interaction"),
            (("上传", "图片", "图片上传", "image"), "media upload presentation"),
        ):
            lowered = source_text.lower()
            if any(keyword.lower() in lowered for keyword in keywords):
                requirements.append(phrase)

        if not requirements:
            requirements.append("clear primary user flow")
            requirements.append("real sample content")
            requirements.append("light mobile-friendly layout")

        deduped: List[str] = []
        for item in requirements:
            if item not in deduped:
                deduped.append(item)

        return ", ".join(deduped[:8])

    def _invoke_repair(
        self,
        state: AgentSessionState,
        spec: AppSpec,
        context_snapshot: List[WorkspaceFile],
        repair_context: RepairContext,
    ) -> GeneratedCodeOutput:
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are repairing a React + Vite TypeScript project generated by a coding agent. "
                    "Prefer patch operations for existing files and keep the change set as small as possible. "
                    "Do not emit op=run or shell commands. Express dependency fixes as file edits, usually by updating package.json. "
                    "Do not leave placeholder, TODO, or stub UI behind after the repair. "
                    "Replace user-facing placeholder copy with finished UI, even if the content is backed by sample data. "
                    "Preserve the existing product scope and visual direction unless the repair context explicitly requires a broader change. "
                    "You may add or keep Tailwind CSS, Radix UI primitives, shadcn/ui-style local components, Framer Motion, React Router, lucide-react, Zustand, TanStack Query, clsx, tailwind-merge, and similar lightweight React ecosystem tools when they materially help resolve the issue. "
                    "Do not force the project back to a single preferred visual stack or house style. "
                    "Remove unused React imports when the automatic JSX runtime is active. "
                    "Fix TypeScript noUnusedLocals and noUnusedParameters issues by removing or using unused imports, variables, and useState setters. "
                    "If only the state value is used, destructure useState as [value] instead of [value, setValue]. "
                    "Every local import you reference must already exist in the workspace snapshot or be created/updated in this same response. "
                    "Do not leave the project in a state where source files import missing local modules. "
                    "Do not return partial file fragments in content. "
                    "If you use type=write for an existing file, content must contain the complete final file from its first line to its last line. "
                    "If only part of an existing file changes, return patch hunks or before/after replacement data instead of a snippet. "
                    f"{USER_FACING_LANGUAGE_RULE}"
                    "Return valid JSON only with keys assistantSummary and operations.",
                ),
                (
                    "human",
                    "App spec:\n{spec}\n\n"
                    "Relevant context:\n{workspace}\n\n"
                    "Repair context:\n"
                    "Category: {category}\n"
                    "Attempt: {attempt}\n"
                    "Failed command: {failed_command}\n"
                    "Build output:\n{build_error}\n\n"
                    "Fix every reported issue in the returned operations.",
                ),
            ]
        )

        try:
            model = self.provider.require_chat_model("coder", timeout_seconds=self._coder_timeout_for_phase("repair"))
            messages = prompt.format_messages(
                spec=dumps(self._serialize_spec_for_codegen(spec), ensure_ascii=False),
                workspace=dumps(self._serialize_workspace_for_codegen(context_snapshot), ensure_ascii=False),
                category=repair_context.category,
                attempt=repair_context.attempt,
                failed_command=repair_context.failed_command,
                build_error=repair_context.build_error,
            )
            return self._invoke_and_normalize(
                model,
                messages,
                context_snapshot,
                state=state,
                invocation_kind="repair",
                timeout_seconds=self._coder_timeout_for_phase("repair"),
                structured_output_method=self.provider.preferred_structured_output_method("coder"),
            )
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise GenerationFailure(f"修复阶段模型调用失败：{exc}") from exc
            raise GenerationFailure(f"代码生成模型在修复项目时失败：{exc}") from exc

    def _invoke_and_normalize(
        self,
        model: object,
        messages: object,
        context_snapshot: List[WorkspaceFile],
        state: Optional[AgentSessionState] = None,
        invocation_kind: str = "generate",
        timeout_seconds: float | None = None,
        structured_first: bool = True,
        structured_output_method: str = "json_mode",
    ) -> GeneratedCodeOutput:
        started_at = time.perf_counter()
        structured_error: Optional[Exception] = None
        raw_error: Optional[Exception] = None
        self._log_invoke_event(
            "start",
            state,
            invocation_kind=invocation_kind,
            workspace_files=len(context_snapshot),
            prompt_messages=len(messages) if isinstance(messages, list) else None,
        )

        if structured_first:
            try:
                normalized = self._invoke_structured_with_transport_retries(
                    model=model,
                    messages=messages,
                    context_snapshot=context_snapshot,
                    state=state,
                    invocation_kind=invocation_kind,
                    timeout_seconds=timeout_seconds,
                    structured_output_method=structured_output_method,
                )
                self._log_invoke_event(
                    "structured_success",
                    state,
                    invocation_kind=invocation_kind,
                    duration_ms=round((time.perf_counter() - started_at) * 1000),
                    operations=len(normalized.operations),
                )
                return normalized
            except Exception as exc:
                structured_error = exc
                self._log_invoke_event(
                    "structured_failed",
                    state,
                    invocation_kind=invocation_kind,
                    duration_ms=round((time.perf_counter() - started_at) * 1000),
                    transport=self._is_transport_failure(exc),
                    error=self._compact_error(exc),
                )

        try:
            normalized = self._invoke_raw_json_with_transport_retries(
                model=model,
                messages=messages,
                context_snapshot=context_snapshot,
                state=state,
                invocation_kind=invocation_kind,
                timeout_seconds=timeout_seconds,
            )
            self._log_invoke_event(
                "raw_success",
                state,
                invocation_kind=invocation_kind,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                operations=len(normalized.operations),
                recovered_from_structured_failure=structured_error is not None,
            )
            return normalized
        except Exception as raw_exc:
            raw_error = raw_exc
            self._log_invoke_event(
                "raw_failed",
                state,
                invocation_kind=invocation_kind,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                transport=self._is_transport_failure(raw_exc),
                error=self._compact_error(raw_exc),
            )
        repair_error: Exception | None = None
        try:
            normalized = self._invoke_repair_json_with_transport_retries(
                model=model,
                messages=messages,
                context_snapshot=context_snapshot,
                state=state,
                invocation_kind=invocation_kind,
                timeout_seconds=timeout_seconds,
                structured_error=structured_error,
                raw_error=raw_error,
            )
            self._log_invoke_event(
                "repair_success",
                state,
                invocation_kind=invocation_kind,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                operations=len(normalized.operations),
            )
            return normalized
        except Exception as repair_exc:
            repair_error = repair_exc
            self._log_invoke_event(
                "repair_failed",
                state,
                invocation_kind=invocation_kind,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                transport=self._is_transport_failure(repair_exc),
                error=self._compact_error(repair_exc),
            )

        structured_text = self._compact_error(structured_error) if structured_error is not None else "n/a"
        raw_text = self._compact_error(raw_error) if raw_error is not None else "n/a"
        repair_text = self._compact_error(repair_error) if repair_error is not None else "n/a"
        raise GenerationFailure(
            "代码生成阶段调用模型失败，已尝试 structured、raw JSON 和 repair JSON 恢复后仍失败。"
            f" structured={structured_text};"
            f" raw={raw_text};"
            f" repair={repair_text}"
        ) from (repair_error or raw_error or structured_error)

    def _invoke_structured_with_transport_retries(
        self,
        model: object,
        messages: object,
        context_snapshot: List[WorkspaceFile],
        state: Optional[AgentSessionState],
        invocation_kind: str,
        timeout_seconds: float | None,
        structured_output_method: str,
    ) -> GeneratedCodeOutput:
        last_error: Exception | None = None

        for attempt in range(1, TRANSPORT_RECOVERY_ATTEMPTS + 1):
            attempt_started_at = time.perf_counter()
            try:
                prepared_model, prepared_messages = self._prepare_structured_model_for_invoke(
                    model,
                    messages,
                    structured_output_method=structured_output_method,
                )
                structured_result = invoke_with_hard_timeout(
                    lambda: prepared_model.invoke(prepared_messages),
                    timeout_seconds=timeout_seconds,
                    timeout_message=f"{invocation_kind} 结构化代码生成在 {timeout_seconds} 秒内没有返回。",
                )
                normalized = self._normalize_generation_output(structured_result, context_snapshot)
                self._log_invoke_event(
                    "structured_attempt_success",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt,
                    duration_ms=round((time.perf_counter() - attempt_started_at) * 1000),
                    operations=len(normalized.operations),
                )
                return normalized
            except Exception as exc:
                last_error = exc
                is_transport = self._is_transport_failure(exc)
                self._log_invoke_event(
                    "structured_attempt_failed",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt,
                    duration_ms=round((time.perf_counter() - attempt_started_at) * 1000),
                    transport=is_transport,
                    error=self._compact_error(exc),
                )
                if not is_transport or attempt >= TRANSPORT_RECOVERY_ATTEMPTS:
                    raise exc
                self._sleep_before_transport_retry(state, invocation_kind, "structured", attempt)

        if last_error is None:
            last_error = GenerationFailure("代码生成阶段未获得模型响应。")
        raise last_error

    def _invoke_raw_json_with_transport_retries(
        self,
        model: object,
        messages: object,
        context_snapshot: List[WorkspaceFile],
        state: Optional[AgentSessionState],
        invocation_kind: str,
        timeout_seconds: float | None,
    ) -> GeneratedCodeOutput:
        last_error: Exception | None = None

        for attempt in range(1, TRANSPORT_RECOVERY_ATTEMPTS + 1):
            attempt_started_at = time.perf_counter()
            try:
                prepared_model, prepared_messages = self._prepare_raw_model_for_invoke(model, messages)
                response = invoke_with_hard_timeout(
                    lambda: prepared_model.invoke(prepared_messages),
                    timeout_seconds=timeout_seconds,
                    timeout_message=f"{invocation_kind} 原始 JSON 代码生成在 {timeout_seconds} 秒内没有返回。",
                )
                normalized = self._normalize_raw_generation_response(response, context_snapshot)
                self._log_invoke_event(
                    "raw_attempt_success",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt,
                    duration_ms=round((time.perf_counter() - attempt_started_at) * 1000),
                    operations=len(normalized.operations),
                )
                return normalized
            except Exception as exc:
                last_error = exc
                is_empty_response = self._is_empty_response_error(exc)
                is_transport = self._is_transport_failure(exc)
                self._log_invoke_event(
                    "raw_attempt_failed",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt,
                    duration_ms=round((time.perf_counter() - attempt_started_at) * 1000),
                    transport=is_transport,
                    empty_response=is_empty_response,
                    error=self._compact_error(exc),
                )

                if is_empty_response:
                    try:
                        return self._retry_empty_response(
                            model,
                            messages,
                            context_snapshot,
                            state,
                            invocation_kind,
                            timeout_seconds,
                        )
                    except Exception as retry_exc:
                        last_error = retry_exc
                        self._log_invoke_event(
                            "empty_response_retry_failed",
                            state,
                            invocation_kind=invocation_kind,
                            attempt=attempt,
                            error=self._compact_error(retry_exc),
                        )
                        raise retry_exc

                if not is_transport or attempt >= TRANSPORT_RECOVERY_ATTEMPTS:
                    raise exc
                self._sleep_before_transport_retry(state, invocation_kind, "raw", attempt)

        if last_error is None:
            last_error = GenerationFailure("代码生成阶段未获得模型响应。")
        raise last_error

    @staticmethod
    def _is_transport_failure_message(message: str) -> bool:
        message = message.lower()
        markers = (
            "connection error",
            "apiconnectionerror",
            "server disconnected",
            "remoteprotocolerror",
            "timed out",
            "timeout error",
            "read timeout",
            "connect timeout",
            "headers timeout",
            "body timeout",
            "connection reset",
            "connection aborted",
            "unable to connect",
            "秒内没有返回",
            "连接错误",
        )
        return any(marker in message for marker in markers)

    @classmethod
    def _is_transport_failure(cls, error: Exception) -> bool:
        if isinstance(error, ModelInvokeTimeoutError):
            return True
        return cls._is_transport_failure_message(str(error))

    @staticmethod
    def _is_empty_response_error(error: Exception) -> bool:
        return EMPTY_JSON_RESPONSE_ERROR in str(error)

    def _retry_empty_response(
        self,
        model: object,
        messages: object,
        context_snapshot: List[WorkspaceFile],
        state: Optional[AgentSessionState],
        invocation_kind: str,
        timeout_seconds: float | None,
    ) -> GeneratedCodeOutput:
        last_error: Exception | None = None

        for attempt in range(EMPTY_RESPONSE_RECOVERY_ATTEMPTS):
            retry_messages = list(messages)
            if attempt == EMPTY_RESPONSE_RECOVERY_ATTEMPTS - 1:
                retry_messages.append(HumanMessage(content=self._build_empty_response_retry_prompt()))
            try:
                prepared_model, prepared_messages = self._prepare_raw_model_for_invoke(model, retry_messages)
                response = invoke_with_hard_timeout(
                    lambda: prepared_model.invoke(prepared_messages),
                    timeout_seconds=timeout_seconds,
                    timeout_message=f"{invocation_kind} 空响应恢复在 {timeout_seconds} 秒内没有返回。",
                )
                normalized = self._normalize_raw_generation_response(response, context_snapshot)
                self._log_invoke_event(
                    "empty_response_retry_success",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt + 1,
                    operations=len(normalized.operations),
                )
                return normalized
            except Exception as exc:
                last_error = exc
                self._log_invoke_event(
                    "empty_response_retry_attempt_failed",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt + 1,
                    error=self._compact_error(exc),
                )
                if not self._is_empty_response_error(exc):
                    raise

        if last_error is None:
            last_error = GenerationFailure(EMPTY_JSON_RESPONSE_ERROR)
        raise last_error

    def _invoke_repair_json_with_transport_retries(
        self,
        model: object,
        messages: object,
        context_snapshot: List[WorkspaceFile],
        state: Optional[AgentSessionState],
        invocation_kind: str,
        timeout_seconds: float | None,
        structured_error: Exception | None,
        raw_error: Exception | None,
    ) -> GeneratedCodeOutput:
        last_error: Exception | None = None
        base_messages = list(messages) if isinstance(messages, list) else list(messages)
        repair_prompt = HumanMessage(
            content=self._build_generation_repair_prompt(
                invocation_kind=invocation_kind,
                structured_error=structured_error,
                raw_error=raw_error,
            )
        )

        for attempt in range(1, TRANSPORT_RECOVERY_ATTEMPTS + 1):
            attempt_started_at = time.perf_counter()
            try:
                prepared_model, prepared_messages = self._prepare_raw_model_for_invoke(
                    model,
                    [*base_messages, repair_prompt],
                )
                response = invoke_with_hard_timeout(
                    lambda: prepared_model.invoke(prepared_messages),
                    timeout_seconds=timeout_seconds,
                    timeout_message=f"{invocation_kind} 修复 JSON 代码生成在 {timeout_seconds} 秒内没有返回。",
                )
                normalized = self._normalize_raw_generation_response(response, context_snapshot)
                self._log_invoke_event(
                    "repair_attempt_success",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt,
                    duration_ms=round((time.perf_counter() - attempt_started_at) * 1000),
                    operations=len(normalized.operations),
                )
                return normalized
            except Exception as exc:
                last_error = exc
                is_transport = self._is_transport_failure(exc)
                is_empty_response = self._is_empty_response_error(exc)
                self._log_invoke_event(
                    "repair_attempt_failed",
                    state,
                    invocation_kind=invocation_kind,
                    attempt=attempt,
                    duration_ms=round((time.perf_counter() - attempt_started_at) * 1000),
                    transport=is_transport,
                    empty_response=is_empty_response,
                    error=self._compact_error(exc),
                )
                if is_empty_response:
                    try:
                        return self._retry_empty_response(
                            model=model,
                            messages=[*base_messages, repair_prompt],
                            context_snapshot=context_snapshot,
                            state=state,
                            invocation_kind=invocation_kind,
                            timeout_seconds=timeout_seconds,
                        )
                    except Exception as retry_exc:
                        last_error = retry_exc
                        self._log_invoke_event(
                            "repair_empty_response_recovery_failed",
                            state,
                            invocation_kind=invocation_kind,
                            attempt=attempt,
                            error=self._compact_error(retry_exc),
                        )
                        raise retry_exc
                if not is_transport or attempt >= TRANSPORT_RECOVERY_ATTEMPTS:
                    raise exc
                self._sleep_before_transport_retry(state, invocation_kind, "repair", attempt)

        if last_error is None:
            last_error = GenerationFailure("代码生成阶段未获得模型响应。")
        raise last_error

    def _normalize_raw_generation_response(
        self,
        response: object,
        context_snapshot: List[WorkspaceFile],
    ) -> GeneratedCodeOutput:
        content = getattr(response, "content", response)
        parsed_result = parse_json_response(content, StructuredGeneratedCodeOutput)
        return self._normalize_generation_output(parsed_result, context_snapshot)

    @staticmethod
    def _build_empty_response_retry_prompt() -> str:
        return (
            "你上一条回复为空，没有返回任何 JSON。"
            "请立即只返回一个完整的 JSON 对象，顶层必须包含 assistantSummary 和 operations，"
            "不要附带解释、Markdown、代码块或空白文本。"
        )

    @staticmethod
    def _build_generation_repair_prompt(
        invocation_kind: str,
        structured_error: Exception | None,
        raw_error: Exception | None,
    ) -> str:
        return (
            "你前面的代码生成结果未能返回可执行 JSON。"
            f" 当前阶段: {invocation_kind}。"
            f" structured_error={structured_error}; raw_error={raw_error}。"
            "请立即只返回一个完整的 JSON 对象，顶层必须包含 assistantSummary 和 operations。"
            "不要附带解释、Markdown、代码块或多余文本。"
            "operations 中每一项都必须包含 type、path、summary，并按需要包含 content 或 hunks。"
        )

    def _prepare_structured_model_for_invoke(
        self,
        model: object,
        messages: Sequence[BaseMessage],
        structured_output_method: str,
    ) -> tuple[object, list[BaseMessage]]:
        message_list = list(messages)
        structured_model = model.with_structured_output(
            StructuredGeneratedCodeOutput,
            method=structured_output_method,
        )
        if not self._uses_responses_api(model):
            return structured_model, message_list

        instructions, remaining_messages = self._extract_responses_instructions(message_list)
        if not instructions or not remaining_messages:
            return structured_model, message_list

        bind = getattr(structured_model, "bind", None)
        if callable(bind):
            return bind(instructions=instructions), remaining_messages

        model_bind = getattr(model, "bind", None)
        if callable(model_bind):
            bound_model = model_bind(instructions=instructions)
            return (
                bound_model.with_structured_output(
                    StructuredGeneratedCodeOutput,
                    method=structured_output_method,
                ),
                remaining_messages,
            )

        return structured_model, message_list

    def _prepare_raw_model_for_invoke(
        self,
        model: object,
        messages: Sequence[BaseMessage],
    ) -> tuple[object, list[BaseMessage]]:
        message_list = list(messages)
        cloned_model = self._clone_without_responses_api(model)
        if cloned_model is not model:
            return cloned_model, message_list

        if not self._uses_responses_api(model):
            return model, message_list

        instructions, remaining_messages = self._extract_responses_instructions(message_list)
        if not instructions or not remaining_messages:
            return model, message_list

        bind = getattr(model, "bind", None)
        if not callable(bind):
            return model, message_list

        return bind(instructions=instructions), remaining_messages

    def _clone_without_responses_api(self, model: object) -> object:
        if not self._uses_responses_api(model):
            return model

        model_copy = getattr(model, "model_copy", None)
        if not callable(model_copy):
            return model

        try:
            return model_copy(update={"use_responses_api": False, "output_version": "v0"})
        except TypeError:
            return model

    def _uses_responses_api(self, model: object) -> bool:
        checker = getattr(model, "_use_responses_api", None)
        if callable(checker):
            try:
                return bool(checker({}))
            except TypeError:
                try:
                    return bool(checker())
                except TypeError:
                    pass
        configured = getattr(model, "use_responses_api", None)
        if isinstance(configured, bool):
            return configured
        return getattr(model, "output_version", None) == "responses/v1"

    @staticmethod
    def _extract_responses_instructions(messages: Sequence[BaseMessage]) -> tuple[str, list[BaseMessage]]:
        instructions_parts: list[str] = []
        remaining_messages: list[BaseMessage] = []
        still_collecting = True

        for message in messages:
            role = CodeGenerationService._message_role(message)
            if still_collecting and role in {"system", "developer"}:
                text = CodeGenerationService._message_text_content(message)
                if text:
                    instructions_parts.append(text)
                continue

            still_collecting = False
            remaining_messages.append(message)

        return "\n\n".join(instructions_parts).strip(), remaining_messages

    @staticmethod
    def _message_role(message: BaseMessage) -> str:
        role = getattr(message, "role", None)
        if isinstance(role, str) and role:
            return role.strip().lower()

        message_type = getattr(message, "type", None)
        if message_type == "human":
            return "user"
        if message_type == "ai":
            return "assistant"
        if isinstance(message_type, str):
            return message_type.strip().lower()
        return ""

    @staticmethod
    def _message_text_content(message: BaseMessage) -> str:
        content = getattr(message, "content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    normalized = block.strip()
                    if normalized:
                        parts.append(normalized)
                    continue
                if isinstance(block, dict):
                    text = block.get("text")
                    if text:
                        parts.append(str(text).strip())
            return "\n".join(part for part in parts if part).strip()
        return str(content).strip()

    def _normalize_generation_output(
        self,
        generation: StructuredGeneratedCodeOutput,
        context_snapshot: List[WorkspaceFile],
    ) -> GeneratedCodeOutput:
        workspace_lookup: Dict[str, str] = {item.path: item.content for item in context_snapshot}
        operations: List[FileOperation] = []

        for index, item in enumerate(generation.operations):
            normalized = self._normalize_operation(item, index, workspace_lookup)
            if normalized is not None:
                operations.append(normalized)

        if not operations:
            raise GenerationFailure("代码生成模型在规范化后没有返回可执行的文件操作。")

        return GeneratedCodeOutput(
            assistantSummary=(generation.assistant_summary or "").strip() or None,
            operations=operations,
        )

    @staticmethod
    def _serialize_conversation_for_codegen(state: AgentSessionState, limit: int = 8) -> List[dict]:
        tail = state.messages[-max(1, limit) :]
        return [
            {
                "role": message.role.value if hasattr(message.role, "value") else str(message.role),
                "content": message.content,
            }
            for message in tail
        ]

    @staticmethod
    def _should_use_staged_generation(context_snapshot: List[WorkspaceFile]) -> bool:
        existing_paths = {item.path for item in context_snapshot}
        required_paths = {"package.json", "index.html", "src/main.tsx", "src/App.tsx"}
        return not required_paths.issubset(existing_paths)

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
                lookup[operation.path] = self._apply_patch_hunks(
                    lookup.get(operation.path, ""),
                    operation.hunks,
                    operation.fallback_content,
                )

        return [WorkspaceFile(path=path, content=content) for path, content in sorted(lookup.items())]

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
    def _serialize_spec_for_codegen(spec: AppSpec) -> dict:
        return {
            "appName": spec.app_name,
            "title": spec.title,
            "summary": spec.summary,
            "goal": spec.goal,
            "targetUsers": spec.target_users[:3],
            "screens": [
                {
                    "id": screen.id,
                    "name": screen.name,
                    "purpose": screen.purpose,
                    "elements": screen.elements[:6],
                }
                for screen in spec.screens[:5]
            ],
            "coreFlows": [
                {
                    "id": flow.id,
                    "name": flow.name,
                    "steps": flow.steps[:5],
                    "success": flow.success,
                }
                for flow in spec.core_flows[:4]
            ],
            "integrations": spec.integrations[:4],
            "constraints": spec.constraints[:6],
            "successCriteria": spec.success_criteria[:6],
            "designTargets": spec.design_targets.model_dump(mode="json", by_alias=True),
            "brandAndVisualDirection": spec.brand_and_visual_direction,
            "assumptions": spec.assumptions[:4],
        }

    @staticmethod
    def _serialize_spec_for_bootstrap(spec: AppSpec) -> dict:
        primary_screen = spec.screens[0] if spec.screens else None
        primary_flow = spec.core_flows[0] if spec.core_flows else None
        return {
            "appName": spec.app_name,
            "title": spec.title,
            "summary": spec.summary,
            "goal": spec.goal,
            "targetUsers": spec.target_users[:2],
            "primaryScreen": (
                {
                    "name": primary_screen.name,
                    "purpose": primary_screen.purpose,
                    "elements": primary_screen.elements[:4],
                }
                if primary_screen
                else None
            ),
            "primaryFlow": (
                {
                    "name": primary_flow.name,
                    "steps": primary_flow.steps[:4],
                    "success": primary_flow.success,
                }
                if primary_flow
                else None
            ),
            "constraints": spec.constraints[:4],
            "successCriteria": spec.success_criteria[:4],
            "designTargets": spec.design_targets.model_dump(mode="json", by_alias=True),
            "brandAndVisualDirection": spec.brand_and_visual_direction,
            "assumptions": spec.assumptions[:3],
        }

    @staticmethod
    def _serialize_spec_for_minimal_bootstrap(spec: AppSpec) -> dict:
        primary_screen = spec.screens[0] if spec.screens else None
        return {
            "appName": spec.app_name,
            "title": spec.title,
            "summary": spec.summary,
            "goal": spec.goal,
            "targetUsers": spec.target_users[:2],
            "primaryScreen": (
                {
                    "name": primary_screen.name,
                    "purpose": primary_screen.purpose,
                    "elements": primary_screen.elements[:3],
                }
                if primary_screen
                else None
            ),
            "constraints": spec.constraints[:3],
            "successCriteria": spec.success_criteria[:3],
            "designTargets": spec.design_targets.model_dump(mode="json", by_alias=True),
            "brandAndVisualDirection": spec.brand_and_visual_direction,
            "assumptions": spec.assumptions[:2],
        }

    @staticmethod
    def _serialize_workspace_for_codegen(context_snapshot: List[WorkspaceFile]) -> List[dict]:
        serialized: List[dict] = []
        for item in context_snapshot:
            content = item.content
            if len(content) > 8000:
                content = content[:8000] + "\n...[truncated]"
            serialized.append({"path": item.path, "content": content})
        return serialized

    @staticmethod
    def _compact_error(error: Exception) -> str:
        text = str(error).strip()
        if len(text) > 240:
            return text[:240] + "...[truncated]"
        return text

    def _log_invoke_event(
        self,
        stage: str,
        state: Optional[AgentSessionState],
        **fields: object,
    ) -> None:
        payload = {
            "stage": f"codegen_{stage}",
            "project_id": state.project_id if state else None,
            "session_id": state.session_id if state else None,
            **{key: value for key, value in fields.items() if value is not None},
        }
        parts = [f"{key}={value}" for key, value in payload.items()]
        logger.info(" ".join(parts))

    @staticmethod
    def _coder_timeout_for_phase(phase_name: str) -> float:
        return CODEGEN_PHASE_TIMEOUT_SECONDS.get(phase_name, 45.0)

    def _sleep_before_transport_retry(
        self,
        state: Optional[AgentSessionState],
        invocation_kind: str,
        retry_stage: str,
        attempt: int,
    ) -> None:
        delay_seconds = self._transport_retry_delay_seconds(attempt)
        self._log_invoke_event(
            "transport_retry_backoff",
            state,
            invocation_kind=invocation_kind,
            retry_stage=retry_stage,
            attempt=attempt,
            sleep_ms=round(delay_seconds * 1000),
        )
        time.sleep(delay_seconds)

    @staticmethod
    def _transport_retry_delay_seconds(attempt: int) -> float:
        return TRANSPORT_RETRY_BACKOFF_SECONDS * max(1, attempt)

    def _normalize_operation(
        self,
        item: StructuredFileOperationOutput,
        index: int,
        workspace_lookup: Dict[str, str],
    ) -> Optional[FileOperation]:
        operation_type = self._infer_operation_type(item)
        path = (item.path or "").strip()
        summary = (item.summary or "").strip() or f"操作 {index + 1}"

        if operation_type == "run":
            return self._normalize_run_operation(item, summary, workspace_lookup)

        if operation_type in {"write", "create"}:
            if not path:
                return None
            content = item.content if item.content is not None else item.fallback_content
            if path in workspace_lookup and content and self._looks_like_unified_diff(content):
                parsed_hunks = self._parse_unified_diff_hunks(content)
                if parsed_hunks:
                    return FileOperation(
                        type="patch",
                        path=path,
                        summary=summary,
                        hunks=parsed_hunks,
                    )
            return FileOperation(
                type="write",
                path=path,
                summary=summary,
                content=self._polish_generated_copy(content or ""),
            )

        if operation_type in {"patch", "edit", "update"}:
            if not path:
                return None

            hunks = [
                PatchHunk(search=hunk.search, replace=hunk.replace, occurrence=hunk.occurrence or 1)
                for hunk in item.hunks
                if hunk.search and hunk.replace is not None
            ]
            if item.search and item.replace is not None:
                hunks.append(PatchHunk(search=item.search, replace=item.replace, occurrence=1))

            if hunks:
                fallback_content = item.fallback_content
                if (
                    fallback_content is None
                    and path in workspace_lookup
                    and item.search
                    and item.replace is not None
                    and self._should_use_replace_as_patch_fallback(
                        workspace_lookup[path],
                        item.search,
                        item.replace,
                    )
                ):
                    fallback_content = item.replace
                return FileOperation(
                    type="patch",
                    path=path,
                    summary=summary,
                    hunks=[
                        PatchHunk(
                            search=hunk.search,
                            replace=self._polish_generated_copy(hunk.replace),
                            occurrence=hunk.occurrence or 1,
                        )
                        for hunk in hunks
                    ],
                    fallbackContent=self._polish_generated_copy(fallback_content) if fallback_content is not None else None,
                )

            replacement = item.content if item.content is not None else item.fallback_content
            if replacement is not None:
                if path in workspace_lookup and self._looks_like_unified_diff(replacement):
                    parsed_hunks = self._parse_unified_diff_hunks(replacement)
                    if parsed_hunks:
                        return FileOperation(
                            type="patch",
                            path=path,
                            summary=summary,
                            hunks=parsed_hunks,
                        )
                return FileOperation(
                    type="write",
                    path=path,
                    summary=summary,
                    content=self._polish_generated_copy(replacement),
                )
            return None

        if operation_type == "delete":
            if not path:
                return None
            return FileOperation(type="delete", path=path, summary=summary)

        return None

    @staticmethod
    def _infer_operation_type(item: StructuredFileOperationOutput) -> str:
        operation_type = (item.type or "").strip().lower()
        if operation_type in {"create", "add", "new", "rewrite", "overwrite", "replace_file"}:
            return "write"
        if operation_type in {"edit", "update", "modify", "fix", "rewrite_partial"}:
            return "patch" if item.hunks or item.search or item.replace is not None else "write"
        if operation_type in {"remove", "rm"}:
            return "delete"
        if operation_type:
            return operation_type

        if item.command:
            return "run"
        if item.path and (item.hunks or item.search or item.replace is not None):
            return "patch"
        if item.path and (item.content is not None or item.fallback_content is not None):
            return "write"
        return ""

    def _normalize_run_operation(
        self,
        item: StructuredFileOperationOutput,
        summary: str,
        workspace_lookup: Dict[str, str],
    ) -> Optional[FileOperation]:
        command = (item.command or "").strip()
        if not command:
            return None

        dependency_update = self._dependency_edit_from_command(command, workspace_lookup.get("package.json"))
        if dependency_update is None:
            return None

        package_json_content, dependency_names = dependency_update
        dependency_summary = summary
        if not item.summary:
            dependency_summary = f"将依赖 {', '.join(dependency_names)} 加入 package.json。"

        return FileOperation(
            type="write",
            path="package.json",
            summary=dependency_summary,
            content=package_json_content,
        )

    @staticmethod
    def _dependency_edit_from_command(command: str, package_json: Optional[str]) -> Optional[Tuple[str, List[str]]]:
        normalized = " ".join(command.split())
        dependency_segment: Optional[str] = None
        for prefix in ("npm install ", "npm i "):
            if normalized.startswith(prefix):
                dependency_segment = normalized[len(prefix) :].strip()
                break

        if not dependency_segment or package_json is None:
            return None

        dependency_names = [item for item in dependency_segment.split() if item and not item.startswith("-")]
        if not dependency_names:
            return None

        try:
            data = loads(package_json)
        except Exception:
            return None

        dependencies = data.setdefault("dependencies", {})
        if not isinstance(dependencies, dict):
            return None

        for dependency_name in dependency_names:
            dependencies.setdefault(dependency_name, "latest")

        return dumps(data, indent=2, ensure_ascii=False) + "\n", dependency_names

    @staticmethod
    def _build_execution_manifest(state: AgentSessionState, title: str) -> List[ExecutionStep]:
        preview_url = state.preview_url or "http://127.0.0.1:4173"
        return [
            ExecutionStep(type="stop_preview", description="停止这个项目之前可能仍在运行的预览进程。"),
            ExecutionStep(
                type="install_dependencies",
                description="使用 npm 安装应用依赖。",
                packageManager="npm",
            ),
            ExecutionStep(
                type="build_web_app",
                description="执行生产构建作为验证步骤。",
                packageManager="npm",
            ),
            ExecutionStep(
                type="start_vite_preview",
                description="启动 Vite 开发服务器以便交互预览。",
                packageManager="npm",
                port=4173,
            ),
            ExecutionStep(
                type="health_check",
                description="轮询预览首页地址，直到服务可用。",
                url=preview_url,
            ),
            ExecutionStep(
                type="git_snapshot",
                description="将本次生成结果提交到项目工作区仓库。",
                message=f"生成第 {state.version_number + 1} 个版本：{title}",
            ),
        ]

    @staticmethod
    def _polish_generated_copy(value: str) -> str:
        polished = re.sub(
            r"\[\s*video placeholder\s*:\s*([^\]]+)\]",
            r"视频课程重点：\1",
            value,
            flags=re.IGNORECASE,
        )
        polished = re.sub(r"\bvideo placeholder\b", "视频课程", polished, flags=re.IGNORECASE)
        return polished

    @staticmethod
    def _looks_like_unified_diff(value: str) -> bool:
        stripped = value.lstrip()
        if not stripped.startswith("@@"):
            return False
        return any(line.startswith((" ", "+", "-")) for line in stripped.splitlines()[1:])

    def _parse_unified_diff_hunks(self, value: str) -> List[PatchHunk]:
        hunks: List[PatchHunk] = []
        current_lines: List[str] = []
        in_hunk = False

        for line in value.splitlines(keepends=True):
            if line.startswith("@@"):
                if current_lines:
                    hunk = self._build_patch_hunk_from_diff_lines(current_lines)
                    if hunk is not None:
                        hunks.append(hunk)
                    current_lines = []
                in_hunk = True
                continue

            if not in_hunk:
                continue

            if line.startswith("\\ No newline at end of file"):
                continue

            if line.startswith((" ", "+", "-")):
                current_lines.append(line)

        if current_lines:
            hunk = self._build_patch_hunk_from_diff_lines(current_lines)
            if hunk is not None:
                hunks.append(hunk)

        return hunks

    def _build_patch_hunk_from_diff_lines(self, lines: List[str]) -> Optional[PatchHunk]:
        search_parts: List[str] = []
        replace_parts: List[str] = []

        for line in lines:
            prefix = line[:1]
            text = line[1:]
            if prefix in {" ", "-"}:
                search_parts.append(text)
            if prefix in {" ", "+"}:
                replace_parts.append(text)

        search = "".join(search_parts)
        replace = self._polish_generated_copy("".join(replace_parts))
        if not search and not replace:
            return None
        return PatchHunk(search=search, replace=replace, occurrence=1)

    @staticmethod
    def _should_use_replace_as_patch_fallback(existing: str, search: str, replace: str) -> bool:
        if not existing or not search or not replace:
            return False
        threshold = max(120, int(len(existing) * 0.6))
        return len(search) >= threshold and len(replace) >= threshold
