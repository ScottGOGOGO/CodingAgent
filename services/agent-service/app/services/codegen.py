from __future__ import annotations

import re
from json import dumps, loads
from typing import Dict, List, Optional, Tuple

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
from app.services.json_parser import parse_json_response
from app.services.model_provider import ModelProvider


class CodeGenerationService:
    def __init__(self) -> None:
        self.provider = ModelProvider()

    def generate(self, state: AgentSessionState, spec: AppSpec, context_snapshot: List[WorkspaceFile]) -> AgentSessionState:
        generation = self._invoke_generation(state, spec, context_snapshot)
        return self._apply_generation_result(state, generation, spec.title)

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
            default_summary_prefix=f"Repair {repair_context.attempt} for",
        )

    def _apply_generation_result(
        self,
        state: AgentSessionState,
        generation: GeneratedCodeOutput,
        title: str,
        default_summary_prefix: str = "Generate",
    ) -> AgentSessionState:
        operations = generation.operations
        state.file_operations = operations
        state.file_change_summary = [item.summary for item in operations]
        state.assistant_summary = generation.assistant_summary or f"{default_summary_prefix} {title}"
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
                    "Prefer plain CSS files for styling. Do not use Tailwind utility classes, @tailwind directives, or @apply unless you also add the complete Tailwind toolchain and config files. "
                    "Assume the automatic JSX runtime is enabled, so do not import React by default unless you need React namespace APIs such as React.useState. "
                    "Do not leave code comments that describe unfinished UI as placeholder or TODO. "
                    "At least one primary route must render a fully designed screen with real sections, realistic sample content, and clear visual styling that reflects the spec. "
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
                    "Required output files for a fresh app are package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx, and src/App.tsx.\n"
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
            try:
                result = model.with_structured_output(StructuredGeneratedCodeOutput, method="json_mode").invoke(messages)
            except Exception:
                response = model.invoke(messages)
                result = parse_json_response(response.content, StructuredGeneratedCodeOutput)
            return self._normalize_generation_output(result, context_snapshot)
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise
            raise GenerationFailure(f"Coder model failed while generating code: {exc}") from exc

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
                    "If the project uses plain React + Vite, prefer normal CSS over Tailwind unless you also install and configure the full Tailwind toolchain. "
                    "Remove unused React imports when the automatic JSX runtime is active. "
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
            try:
                result = model.with_structured_output(StructuredGeneratedCodeOutput, method="json_mode").invoke(messages)
            except Exception:
                response = model.invoke(messages)
                result = parse_json_response(response.content, StructuredGeneratedCodeOutput)
            return self._normalize_generation_output(result, context_snapshot)
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise
            raise GenerationFailure(f"Coder model failed while repairing the project: {exc}") from exc

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
            raise GenerationFailure("Coder model returned no executable file operations after normalization.")

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
        summary = (item.summary or "").strip() or f"Operation {index + 1}"

        if operation_type == "run":
            return self._normalize_run_operation(item, summary, workspace_lookup)

        if operation_type in {"write", "create"}:
            if not path:
                return None
            content = item.content if item.content is not None else item.fallback_content
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
                    fallbackContent=self._polish_generated_copy(item.fallback_content) if item.fallback_content is not None else None,
                )

            replacement = item.content if item.content is not None else item.fallback_content
            if replacement is not None:
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
            dependency_summary = f"Add dependency {', '.join(dependency_names)} to package.json."

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
            ExecutionStep(type="stop_preview", description="Stop any previous preview for this project."),
            ExecutionStep(
                type="install_dependencies",
                description="Install the app dependencies with npm.",
                packageManager="npm",
            ),
            ExecutionStep(
                type="build_web_app",
                description="Run a production build as a verification step.",
                packageManager="npm",
            ),
            ExecutionStep(
                type="start_vite_preview",
                description="Start the Vite development server for interactive preview.",
                packageManager="npm",
                port=4173,
            ),
            ExecutionStep(
                type="health_check",
                description="Probe the preview root URL until it becomes healthy.",
                url=preview_url,
            ),
            ExecutionStep(
                type="git_snapshot",
                description="Commit the generated version into the project workspace repository.",
                message=f"Generate version {state.version_number + 1}: {title}",
            ),
        ]

    @staticmethod
    def _polish_generated_copy(value: str) -> str:
        polished = re.sub(
            r"\[\s*video placeholder\s*:\s*([^\]]+)\]",
            r"Video lesson focus: \1",
            value,
            flags=re.IGNORECASE,
        )
        polished = re.sub(r"\bvideo placeholder\b", "video lesson", polished, flags=re.IGNORECASE)
        return polished
