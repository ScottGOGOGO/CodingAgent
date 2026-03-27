from __future__ import annotations

import re
from json import dumps, loads
from typing import Dict, List, Optional, Tuple

from langchain_core.messages import HumanMessage
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
from app.services.json_parser import EMPTY_JSON_RESPONSE_ERROR, parse_json_response
from app.services.local_scaffold import build_fresh_app_scaffold
from app.services.model_provider import ModelProvider


USER_FACING_LANGUAGE_RULE = (
    "除非用户明确要求其他语言，所有面向用户的自然语言内容都必须使用简体中文，"
    "包括 assistantSummary、operation summary、界面文案、示例内容和可见标签；"
    "保留 JSON key、文件路径和必要的代码标识符格式。"
)
EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 2


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
        prompt = ChatPromptTemplate.from_messages(
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
                    "When generating a fresh app, prefer a self-contained implementation if that is the most reliable way to return a complete, runnable project. "
                    "For a fresh app or empty workspace, do not stop after the first few config files. "
                    "In the same response you must also create complete app entry files such as src/main.tsx and src/App.tsx, plus any local modules they import. "
                    f"{USER_FACING_LANGUAGE_RULE}"
                    "Return valid JSON only with keys assistantSummary and operations. "
                    "Each operation must contain type, path, summary, and either content or hunks when required. "
                    "Patch hunks must contain search, replace, and optional occurrence. "
                    "The result must build with npm install && npm run build and run with npm run dev.",
                ),
                (
                    "human",
                    "Latest conversation:\n{messages}\n\n"
                    "Normalized app spec:\n{spec}\n\n"
                    "Selected implementation context:\n{workspace}\n\n"
                    "For a fresh app, prefer creating package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx, and src/App.tsx in the same response, plus any config or local modules your implementation depends on.\n"
                    "If you add external packages, include them in package.json in the same response.\n"
                    "Interpret spec.designTargets as the visual brief: the layout, styling system, component language, and motion choices should clearly embody it.\n"
                    "If the app uses multiple routes, each visible route must present substantive UI instead of route stubs.\n"
                    "Return only the operations needed for this turn.",
                ),
            ]
        )

        try:
            model = self.provider.require_chat_model("coder")
            messages = prompt.format_messages(
                messages=dumps([message.model_dump(mode="json", by_alias=True) for message in state.messages], ensure_ascii=False),
                spec=dumps(spec.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                workspace=dumps([item.model_dump(mode="json", by_alias=True) for item in context_snapshot], ensure_ascii=False),
            )
            return self._invoke_and_normalize(model, messages, context_snapshot)
        except Exception as exc:
            if self._should_use_fresh_app_scaffold_fallback(context_snapshot, exc):
                return build_fresh_app_scaffold(spec)
            if isinstance(exc, GenerationFailure):
                raise
            raise GenerationFailure(f"代码生成模型在生成代码时失败：{exc}") from exc

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
            model = self.provider.require_chat_model("coder")
            messages = prompt.format_messages(
                spec=dumps(spec.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                workspace=dumps([item.model_dump(mode="json", by_alias=True) for item in context_snapshot], ensure_ascii=False),
                category=repair_context.category,
                attempt=repair_context.attempt,
                failed_command=repair_context.failed_command,
                build_error=repair_context.build_error,
            )
            return self._invoke_and_normalize(model, messages, context_snapshot)
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise
            raise GenerationFailure(f"代码生成模型在修复项目时失败：{exc}") from exc

    def _invoke_and_normalize(
        self,
        model: object,
        messages: object,
        context_snapshot: List[WorkspaceFile],
    ) -> GeneratedCodeOutput:
        structured_error: Optional[Exception] = None

        try:
            structured_result = model.with_structured_output(StructuredGeneratedCodeOutput, method="json_mode").invoke(messages)
            return self._normalize_generation_output(structured_result, context_snapshot)
        except Exception as exc:
            structured_error = exc

        if structured_error is not None and self._is_transport_failure(structured_error):
            raise GenerationFailure(f"结构化输出失败：{structured_error}") from structured_error

        try:
            response = model.invoke(messages)
            return self._normalize_raw_generation_response(response, context_snapshot)
        except Exception as raw_exc:
            if self._is_empty_response_error(raw_exc):
                try:
                    return self._retry_empty_response(model, messages, context_snapshot)
                except Exception as retry_exc:
                    raw_exc = retry_exc
            if structured_error is not None:
                raise GenerationFailure(
                    f"结构化输出失败：{structured_error}；原始 JSON 回退也失败：{raw_exc}"
                ) from raw_exc
            if isinstance(raw_exc, GenerationFailure):
                raise
            raise GenerationFailure(f"原始 JSON 回退失败：{raw_exc}") from raw_exc

    @staticmethod
    def _should_use_fresh_app_scaffold_fallback(context_snapshot: List[WorkspaceFile], error: Exception) -> bool:
        if context_snapshot:
            return False
        return CodeGenerationService._is_transport_failure(error) or CodeGenerationService._is_structured_output_exhaustion(error)

    @staticmethod
    def _is_transport_failure(error: Exception) -> bool:
        message = str(error).lower()
        markers = (
            "connection error",
            "apiconnectionerror",
            "server disconnected",
            "remoteprotocolerror",
            "timed out",
            "timeout",
            "connection reset",
            "connection aborted",
            "unable to connect",
        )
        return any(marker in message for marker in markers)

    @staticmethod
    def _is_structured_output_exhaustion(error: Exception) -> bool:
        message = str(error)
        return EMPTY_JSON_RESPONSE_ERROR in message or "结构化输出失败" in message or "原始 JSON 回退失败" in message

    @staticmethod
    def _is_empty_response_error(error: Exception) -> bool:
        return EMPTY_JSON_RESPONSE_ERROR in str(error)

    def _retry_empty_response(
        self,
        model: object,
        messages: object,
        context_snapshot: List[WorkspaceFile],
    ) -> GeneratedCodeOutput:
        last_error: Exception | None = None

        for attempt in range(EMPTY_RESPONSE_RECOVERY_ATTEMPTS):
            retry_messages = list(messages)
            if attempt == EMPTY_RESPONSE_RECOVERY_ATTEMPTS - 1:
                retry_messages.append(HumanMessage(content=self._build_empty_response_retry_prompt()))
            try:
                response = model.invoke(retry_messages)
                return self._normalize_raw_generation_response(response, context_snapshot)
            except Exception as exc:
                last_error = exc
                if not self._is_empty_response_error(exc):
                    raise

        if last_error is None:
            last_error = GenerationFailure(EMPTY_JSON_RESPONSE_ERROR)
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
