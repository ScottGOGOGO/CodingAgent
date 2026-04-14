from __future__ import annotations

from json import dumps
from typing import List, Optional

from langchain_core.prompts import ChatPromptTemplate

from app.models import AgentSessionState, EvaluationResult, StructuredCriticOutput
from app.services.errors import GenerationFailure
from app.services.model_provider import ModelProvider
from app.services.structured_output import invoke_structured_json

CRITIC_TIMEOUT_SECONDS = 25.0


class CriticService:
    def __init__(self) -> None:
        self.provider = ModelProvider()

    def evaluate(self, state: AgentSessionState) -> EvaluationResult:
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are the critic subgraph for a coding agent. "
                    "Judge whether the proposed code changes are likely to build, whether they satisfy the product requirements, and whether the UI quality is strong enough for approval. "
                    "Placeholder routes, TODO text, 待实现 labels, lorem ipsum, blank scaffolding, or screen shells with no substantive UI are blocking failures and must be reported as critical issues. "
                    "A route-only skeleton is not approval-ready even if it technically builds. "
                    "Do not require Tailwind or any specific UI library. "
                    "Only reduce design quality when the result clearly ignores the supplied designTargets, feels obviously incomplete, or falls back to a generic template that does not fit the product domain. "
                    "Requirement coverage and build stability matter more than visual conformity to any house style. "
                    "Unless the user explicitly requests another language, summary and issues must be written in Simplified Chinese. "
                    "If you include severity values in issue objects, use critical/high/medium/low. "
                    "Return valid JSON only with keys: buildReadinessScore, requirementCoverageScore, designQualityScore, interactionQualityScore, summary, issues, designWarnings.",
                ),
                (
                    "human",
                    "App spec:\n{spec}\n\n"
                    "Plan steps:\n{plan}\n\n"
                    "File operations:\n{operations}\n\n"
                    "Selected context paths:\n{context_paths}",
                ),
            ]
        )
        try:
            model = self.provider.require_chat_model("critic", timeout_seconds=CRITIC_TIMEOUT_SECONDS)
            messages = prompt.format_messages(
                spec=dumps(state.app_spec.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                plan=dumps([step.model_dump(mode="json", by_alias=True) for step in state.plan_steps], ensure_ascii=False),
                operations=dumps([item.model_dump(mode="json", by_alias=True) for item in state.file_operations], ensure_ascii=False),
                context_paths="\n".join(state.last_context_paths) or "无",
            )
            result = invoke_structured_json(
                model=model,
                messages=messages,
                output_schema=StructuredCriticOutput,
                repair_focus=(
                    "重点修正 buildReadinessScore、requirementCoverageScore、designQualityScore、"
                    "interactionQualityScore、summary、issues 和 designWarnings 的 JSON 结构。"
                ),
                structured_output_method=self.provider.preferred_structured_output_method("critic"),
                timeout_seconds=CRITIC_TIMEOUT_SECONDS,
                invocation_name="critic",
            )
            issues = self._normalize_issues(result.issues)
            design_warnings = self._merge_design_warnings(
                self._normalize_text_items(result.design_warnings),
                self._infer_design_warnings(state),
            )
            build_readiness_score = self._normalize_score(result.build_readiness_score, issues, fallback=0.6)
            requirement_coverage_score = self._normalize_score(result.requirement_coverage_score, issues, fallback=0.65)
            design_quality_score = self._normalize_design_score(result.design_quality_score, design_warnings, fallback=0.74)
            interaction_quality_score = self._normalize_design_score(
                result.interaction_quality_score,
                self._interaction_warnings_only(design_warnings),
                fallback=0.7,
            )
            summary = self._normalize_summary(result.summary, issues, design_warnings)
            return EvaluationResult(
                buildReadinessScore=build_readiness_score,
                requirementCoverageScore=requirement_coverage_score,
                designQualityScore=design_quality_score,
                interactionQualityScore=interaction_quality_score,
                summary=summary,
                issues=issues,
                designWarnings=design_warnings,
            )
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise GenerationFailure(f"评审阶段模型调用失败：{exc}") from exc
            raise GenerationFailure(f"评审模型在检查生成结果时失败：{exc}") from exc

    @staticmethod
    def _normalize_issues(items: List[object]) -> List[str]:
        normalized: List[str] = []
        for item in items or []:
            if isinstance(item, dict):
                severity = CriticService._normalize_severity(str(item.get("severity", "")).strip())
                title = str(item.get("title") or item.get("issue") or "").strip()
                detail = str(item.get("detail") or item.get("description") or item.get("summary") or "").strip()
                parts = [part for part in [title, detail] if part]
                if not parts:
                    parts = [str(item).strip()]
                text = ": ".join(parts)
                if severity:
                    text = f"[{severity}] {text}"
                normalized.append(text)
                continue

            text = str(item).strip()
            if text:
                normalized.append(text)

        deduped: List[str] = []
        seen = set()
        for item in normalized:
            if item in seen:
                continue
            seen.add(item)
            deduped.append(item)
        return deduped

    @staticmethod
    def _normalize_text_items(items: List[object]) -> List[str]:
        normalized: List[str] = []
        for item in items or []:
            if isinstance(item, dict):
                title = str(item.get("title") or item.get("issue") or item.get("label") or "").strip()
                detail = str(item.get("detail") or item.get("description") or item.get("summary") or "").strip()
                text = ": ".join(part for part in (title, detail) if part) or str(item).strip()
            else:
                text = str(item).strip()
            if text:
                normalized.append(text)

        deduped: List[str] = []
        seen = set()
        for item in normalized:
            if item in seen:
                continue
            seen.add(item)
            deduped.append(item)
        return deduped

    @staticmethod
    def _merge_design_warnings(primary: List[str], inferred: List[str]) -> List[str]:
        merged: List[str] = []
        seen = set()
        for warning in [*primary, *inferred]:
            if not warning or warning in seen:
                continue
            seen.add(warning)
            merged.append(warning)
        return merged

    @staticmethod
    def _normalize_severity(value: str) -> str:
        normalized = value.strip().lower()
        if not normalized:
            return ""

        severity_aliases = {
            "critical": "critical",
            "严重": "critical",
            "致命": "critical",
            "关键": "critical",
            "high": "high",
            "高": "high",
            "较高": "high",
            "medium": "medium",
            "中": "medium",
            "中等": "medium",
            "low": "low",
            "低": "low",
            "较低": "low",
        }
        return severity_aliases.get(normalized, normalized)

    @staticmethod
    def _normalize_score(score: Optional[float], issues: List[str], fallback: float) -> float:
        try:
            if score is not None:
                value = float(score)
                return max(0.0, min(1.0, value))
        except (TypeError, ValueError):
            pass

        critical_count = sum(1 for item in issues if "[critical]" in item.lower())
        high_count = sum(1 for item in issues if "[high]" in item.lower())
        penalty = critical_count * 0.2 + high_count * 0.1
        return max(0.0, min(1.0, fallback - penalty))

    @staticmethod
    def _normalize_design_score(score: Optional[float], warnings: List[str], fallback: float) -> float:
        try:
            if score is not None:
                value = float(score)
                return max(0.0, min(1.0, value))
        except (TypeError, ValueError):
            pass

        penalty = min(0.32, len(warnings) * 0.08)
        return max(0.0, min(1.0, fallback - penalty))

    @staticmethod
    def _normalize_summary(summary: Optional[str], issues: List[str], design_warnings: List[str]) -> str:
        normalized = (summary or "").strip()
        if normalized:
            return normalized
        if issues:
            return f"评审发现 {len(issues)} 个问题，执行前需要先处理。"
        if design_warnings:
            return f"评审建议先补强 {len(design_warnings)} 项视觉或交互细节，以提升演示完成度。"
        return "评审未发现阻塞执行的问题。"

    @staticmethod
    def _interaction_warnings_only(warnings: List[str]) -> List[str]:
        interaction_markers = ("交互", "动效", "悬停", "反馈", "切换")
        return [warning for warning in warnings if any(marker in warning for marker in interaction_markers)]

    def _infer_design_warnings(self, state: AgentSessionState) -> List[str]:
        warnings: List[str] = []
        if not state.app_spec:
            return warnings

        if self._looks_minimal_ui(state):
            warnings.append("当前界面内容和层级还比较简略，建议在进入审批前补强关键版块与可见反馈。")

        if self._looks_generic_template(state):
            warnings.append("当前界面编排仍偏通用模板，和产品场景及设计目标的贴合度还可以更强。")

        motion_intensity = (state.app_spec.design_targets.motion_intensity or "").strip()
        if motion_intensity and "低" not in motion_intensity and not self._has_interaction_feedback(state):
            warnings.append("需求希望有更明显的动态或反馈，但当前关键页面的交互反馈仍偏弱。")

        return warnings

    @staticmethod
    def _looks_minimal_ui(state: AgentSessionState) -> bool:
        combined = "\n".join(CriticService._operation_text_fragments(state)).lower()
        minimal_markers = (
            "return null",
            "return <></>",
            "return <div></div>",
            "return <main></main>",
            "export default function app() { return null; }",
        )
        return any(marker in combined for marker in minimal_markers) or len(combined.strip()) < 120

    @staticmethod
    def _looks_generic_template(state: AgentSessionState) -> bool:
        combined = "\n".join(CriticService._operation_text_fragments(state))
        generic_markers = ("<header", "<nav", "className=\"card", "className='card", ".card {", "hero", "dashboard")
        marker_hits = sum(1 for marker in generic_markers if marker in combined)
        return marker_hits >= 2

    @staticmethod
    def _has_interaction_feedback(state: AgentSessionState) -> bool:
        combined = "\n".join(CriticService._operation_text_fragments(state))
        interaction_markers = (
            "framer-motion",
            "motion.",
            "whileHover",
            "whileInView",
            "animate-",
            "transition",
            "hover:",
            "group-hover",
        )
        return any(marker in combined for marker in interaction_markers)

    @staticmethod
    def _operation_text_fragments(state: AgentSessionState) -> List[str]:
        texts: List[str] = []
        for operation in state.file_operations:
            for value in (
                operation.content,
                operation.fallback_content,
                getattr(operation, "fallbackContent", None),
            ):
                if isinstance(value, str) and value.strip():
                    texts.append(value)
            for hunk in operation.hunks:
                if hunk.replace.strip():
                    texts.append(hunk.replace)
        return texts
