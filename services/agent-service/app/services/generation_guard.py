from __future__ import annotations

import posixpath
import re
from typing import Any, List, Optional

from app.models import AgentSessionState, FileOperation, PatchHunk, WorkspaceFile


class GenerationGuardService:
    LOCAL_IMPORT_FROM_RE = re.compile(r"""from\s+["'](\.{1,2}/[^"']+)["']""")
    LOCAL_IMPORT_SIDE_EFFECT_RE = re.compile(r"""import\s+["'](\.{1,2}/[^"']+)["']""")
    LOCAL_REQUIRE_RE = re.compile(r"""require\(\s*["'](\.{1,2}/[^"']+)["']\s*\)""")
    PLACEHOLDER_MARKERS = (
        "待实现", "未实现", "占位", "占位符", "coming soon", "敬请期待", "稍后上线",
        "lorem ipsum", "tbd", "video placeholder", "placeholder screen", "placeholder route",
        "route stub", "screen stub", "in production, this would be",
    )
    BLOCKING_SUMMARY_MARKERS = (
        "待实现", "未实现界面", "占位界面", "占位符界面", "空白脚手架", "页面骨架", "路由骨架",
        "route-only skeleton", "routing stubs", "screen shells", "blank scaffolding",
        "placeholder ui", "stub ui", "todo ui", "coming soon",
    )
    BLOCKING_CRITIC_ISSUE_MARKERS = (
        "待实现", "未实现界面", "占位界面", "占位符界面", "空白脚手架", "页面骨架", "路由骨架",
        "占位路由", "空页面", "route-only skeleton", "routing stubs", "screen shells",
        "blank scaffolding", "placeholder ui", "stub ui", "todo ui", "empty route shell", "placeholder route",
    )

    def preflight_generation_error(
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

        placeholder_paths = self.find_placeholder_paths(state.file_operations)
        if placeholder_paths:
            return (
                "生成的文件操作中仍包含占位或 TODO 界面内容，涉及 "
                f"{', '.join(placeholder_paths)}。请先生成真实可用的用户页面，再进入审批。"
            )

        missing_imports = self.find_missing_local_imports(state.file_operations, final_paths)
        if missing_imports:
            return (
                "生成的文件操作中引用了尚未生成的本地文件："
                f"{', '.join(missing_imports)}。请补齐所有被引用的本地模块后再进入审批。"
            )

        return None

    def materialize_workspace_snapshot(
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
                lookup[operation.path] = self.apply_patch_hunks(base_content, operation.hunks, operation.fallback_content)

        return [WorkspaceFile(path=path, content=content) for path, content in sorted(lookup.items())]

    @staticmethod
    def snapshot_to_write_operations(files: List[WorkspaceFile]) -> List[FileOperation]:
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
    def apply_patch_hunks(content: str, hunks: List[PatchHunk], fallback_content: Optional[str]) -> str:
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

    @classmethod
    def find_placeholder_paths(cls, operations: List[Any]) -> List[str]:
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
                texts.append(GenerationGuardService._sanitize_operation_text(value))

        for hunk in getattr(operation, "hunks", []) or []:
            replace = getattr(hunk, "replace", None)
            if isinstance(replace, str) and replace.strip():
                texts.append(GenerationGuardService._sanitize_operation_text(replace))
        return texts

    @classmethod
    def find_missing_local_imports(cls, operations: List[Any], final_paths: set[str]) -> List[str]:
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
    def critic_found_blocking_stub_feedback(cls, summary: str, issues: List[str]) -> bool:
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
