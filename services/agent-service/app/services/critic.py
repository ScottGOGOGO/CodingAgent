from __future__ import annotations

from json import dumps
from typing import List, Optional

from langchain_core.prompts import ChatPromptTemplate

from app.models import AgentSessionState, EvaluationResult, StructuredCriticOutput
from app.services.errors import GenerationFailure
from app.services.model_provider import ModelProvider
from app.services.structured_output import invoke_structured_json


class CriticService:
    def __init__(self) -> None:
        self.provider = ModelProvider()

    def evaluate(self, state: AgentSessionState) -> EvaluationResult:
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are the critic subgraph for a coding agent. "
                    "Judge whether the proposed code changes are likely to build and whether they satisfy the product requirements. "
                    "Placeholder routes, TODO text, 待实现 labels, lorem ipsum, blank scaffolding, or screen shells with no substantive UI are blocking failures and must be reported as critical issues. "
                    "A route-only skeleton is not approval-ready even if it technically builds. "
                    "Unless the user explicitly requests another language, summary and issues must be written in Simplified Chinese. "
                    "If you include severity values in issue objects, use critical/high/medium/low. "
                    "Return valid JSON only with keys: buildReadinessScore, requirementCoverageScore, summary, issues.",
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
            model = self.provider.require_chat_model("critic")
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
                repair_focus="重点修正 buildReadinessScore、requirementCoverageScore、summary 和 issues 的 JSON 结构。",
            )
            issues = self._normalize_issues(result.issues)
            build_readiness_score = self._normalize_score(result.build_readiness_score, issues, fallback=0.6)
            requirement_coverage_score = self._normalize_score(result.requirement_coverage_score, issues, fallback=0.65)
            summary = self._normalize_summary(result.summary, issues)
            return EvaluationResult(
                buildReadinessScore=build_readiness_score,
                requirementCoverageScore=requirement_coverage_score,
                summary=summary,
                issues=issues,
            )
        except Exception as exc:
            if isinstance(exc, GenerationFailure):
                raise
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
    def _normalize_summary(summary: Optional[str], issues: List[str]) -> str:
        normalized = (summary or "").strip()
        if normalized:
            return normalized
        if issues:
            return f"评审发现 {len(issues)} 个问题，执行前需要先处理。"
        return "评审未发现阻塞执行的问题。"
