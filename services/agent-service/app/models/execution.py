from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import Field

from .common import AppBaseModel


class PatchHunk(AppBaseModel):
    search: str
    replace: str
    occurrence: int = 1


class FileOperation(AppBaseModel):
    type: Literal["write", "patch", "delete"]
    path: str
    summary: str = ""
    content: Optional[str] = None
    hunks: List[PatchHunk] = Field(default_factory=list)
    fallback_content: Optional[str] = Field(default=None, alias="fallbackContent")


class WorkspaceFile(AppBaseModel):
    path: str
    content: str


class ExecutionStep(AppBaseModel):
    type: Literal[
        "install_dependencies",
        "build_web_app",
        "start_vite_preview",
        "stop_preview",
        "health_check",
        "git_snapshot",
    ]
    description: str
    package_manager: Optional[Literal["npm"]] = Field(default=None, alias="packageManager")
    port: Optional[int] = None
    message: Optional[str] = None
    url: Optional[str] = None


class ProviderRoute(AppBaseModel):
    clarifier_model: str = Field(alias="clarifierModel")
    planner_model: str = Field(alias="plannerModel")
    coder_model: str = Field(alias="coderModel")
    critic_model: str = Field(alias="criticModel")
    provider: str


class EvaluationResult(AppBaseModel):
    build_readiness_score: float = Field(alias="buildReadinessScore")
    requirement_coverage_score: float = Field(alias="requirementCoverageScore")
    design_quality_score: float = Field(default=0.0, alias="designQualityScore")
    interaction_quality_score: float = Field(default=0.0, alias="interactionQualityScore")
    summary: str
    issues: List[str] = Field(default_factory=list)
    design_warnings: List[str] = Field(default_factory=list, alias="designWarnings")


class UsageMetrics(AppBaseModel):
    input_tokens: Optional[int] = Field(default=None, alias="inputTokens")
    output_tokens: Optional[int] = Field(default=None, alias="outputTokens")
    total_tokens: Optional[int] = Field(default=None, alias="totalTokens")


class ApprovalRequest(AppBaseModel):
    run_id: str = Field(alias="runId")
    project_id: str = Field(alias="projectId")
    summary: str
    created_at: str = Field(alias="createdAt")
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")


class RepairContext(AppBaseModel):
    attempt: int
    category: Literal["dependency", "type_build", "preview_boot", "requirement_mismatch", "design_polish"]
    failed_command: str = Field(alias="failedCommand")
    build_error: str = Field(alias="buildError")
