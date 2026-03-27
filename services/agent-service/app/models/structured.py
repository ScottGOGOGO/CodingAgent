from __future__ import annotations

from typing import List, Optional

from pydantic import AliasChoices, Field, field_validator, model_validator

from .common import (
    AppBaseModel,
    _coerce_operation_content,
    _coerce_score_value,
    _coerce_step_list,
    _coerce_string_list,
    _ensure_list,
    _stringify_model_value,
)
from .execution import FileOperation
from .session import ClarificationQuestion
from .spec import DataModelNeed, FlowSpec, ScreenSpec, WorkingSpec


class StructuredClarifierOutput(AppBaseModel):
    action: Optional[str] = None
    summary: Optional[str] = None
    clarity_score: Optional[float] = Field(default=None, alias="clarityScore")
    missing_information: List[object] = Field(default_factory=list, alias="missingInformation")
    questions: List[ClarificationQuestion] = Field(default_factory=list)
    assumptions: List[object] = Field(default_factory=list)
    working_spec: WorkingSpec = Field(default_factory=WorkingSpec, alias="workingSpec")

    @field_validator("action", "summary", mode="before")
    @classmethod
    def _coerce_text(cls, value: object) -> Optional[str]:
        if value is None:
            return None
        return _stringify_model_value(value)

    @field_validator("clarity_score", mode="before")
    @classmethod
    def _coerce_score(cls, value: object) -> Optional[float]:
        return _coerce_score_value(value)

    @field_validator("missing_information", "questions", "assumptions", mode="before")
    @classmethod
    def _coerce_collections(cls, value: object) -> List[object]:
        return _ensure_list(value)

    @field_validator("working_spec", mode="before")
    @classmethod
    def _coerce_working_spec(cls, value: object) -> object:
        if isinstance(value, str):
            text = _stringify_model_value(value)
            return {"summary": text} if text else {}
        return value


class StructuredSpecOutput(AppBaseModel):
    title: str = ""
    summary: str = ""
    goal: str = ""
    target_users: List[str] = Field(default_factory=list, alias="targetUsers")
    screens: List[ScreenSpec] = Field(default_factory=list)
    core_flows: List[FlowSpec] = Field(default_factory=list, alias="coreFlows")
    data_model_needs: List[DataModelNeed] = Field(default_factory=list, alias="dataModelNeeds")
    integrations: List[object] = Field(default_factory=list)
    brand_and_visual_direction: object = Field(default="", alias="brandAndVisualDirection")
    constraints: List[str] = Field(default_factory=list)
    success_criteria: List[str] = Field(default_factory=list, alias="successCriteria")
    assumptions: List[str] = Field(default_factory=list)

    @field_validator("title", "summary", "goal", mode="before")
    @classmethod
    def _coerce_text(cls, value: object) -> str:
        return _stringify_model_value(value)

    @field_validator("target_users", "constraints", "success_criteria", "assumptions", mode="before")
    @classmethod
    def _coerce_string_lists(cls, value: object) -> List[str]:
        return _coerce_string_list(value)

    @field_validator("screens", "core_flows", "data_model_needs", "integrations", mode="before")
    @classmethod
    def _coerce_collection_fields(cls, value: object) -> List[object]:
        return _ensure_list(value)


class StructuredPlanOutput(AppBaseModel):
    steps: List[str]
    summary: str = ""

    @field_validator("steps", mode="before")
    @classmethod
    def _coerce_steps(cls, value: object) -> List[str]:
        return _coerce_step_list(value)


class StructuredCriticOutput(AppBaseModel):
    build_readiness_score: Optional[float] = Field(default=None, alias="buildReadinessScore")
    requirement_coverage_score: Optional[float] = Field(default=None, alias="requirementCoverageScore")
    design_quality_score: Optional[float] = Field(default=None, alias="designQualityScore")
    interaction_quality_score: Optional[float] = Field(default=None, alias="interactionQualityScore")
    summary: Optional[str] = None
    issues: List[object] = Field(default_factory=list)
    design_warnings: List[object] = Field(default_factory=list, alias="designWarnings")

    @field_validator(
        "build_readiness_score",
        "requirement_coverage_score",
        "design_quality_score",
        "interaction_quality_score",
        mode="before",
    )
    @classmethod
    def _coerce_scores(cls, value: object) -> Optional[float]:
        return _coerce_score_value(value)

    @field_validator("summary", mode="before")
    @classmethod
    def _coerce_summary(cls, value: object) -> Optional[str]:
        if value is None:
            return None
        return _stringify_model_value(value)

    @field_validator("issues", "design_warnings", mode="before")
    @classmethod
    def _coerce_issues(cls, value: object) -> List[object]:
        return _ensure_list(value)


class StructuredPatchHunkOutput(AppBaseModel):
    search: Optional[str] = Field(default=None, validation_alias=AliasChoices("search", "find", "old", "before"))
    replace: Optional[str] = Field(default=None, validation_alias=AliasChoices("replace", "replacement", "new", "after"))
    occurrence: Optional[int] = Field(default=1, validation_alias=AliasChoices("occurrence", "index"))

    @field_validator("search", "replace", mode="before")
    @classmethod
    def _coerce_patch_content(cls, value: object) -> object:
        return _coerce_operation_content(value)


class StructuredFileOperationOutput(AppBaseModel):
    type: Optional[str] = Field(default=None, validation_alias=AliasChoices("type", "op", "action", "operation"))
    path: Optional[str] = Field(default=None, validation_alias=AliasChoices("path", "file", "filePath", "filename", "target"))
    summary: Optional[str] = Field(default=None, validation_alias=AliasChoices("summary", "description", "reason", "title"))
    content: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("content", "code", "newContent", "text", "value"),
    )
    hunks: List[StructuredPatchHunkOutput] = Field(default_factory=list)
    fallback_content: Optional[str] = Field(
        default=None,
        alias="fallbackContent",
        validation_alias=AliasChoices("fallbackContent", "fallback_content", "fullContent"),
    )
    command: Optional[str] = Field(default=None, validation_alias=AliasChoices("command", "run", "script"))
    search: Optional[str] = Field(default=None, validation_alias=AliasChoices("search", "find", "old", "before"))
    replace: Optional[str] = Field(default=None, validation_alias=AliasChoices("replace", "replacement", "new", "after"))

    @model_validator(mode="before")
    @classmethod
    def _expand_before_after_content(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value

        raw_content = value.get("content")
        if not isinstance(raw_content, dict):
            return value

        before = _coerce_operation_content(raw_content.get("before"))
        after = _coerce_operation_content(raw_content.get("after"))
        has_explicit_patch = any(
            value.get(key) is not None
            for key in ("hunks", "search", "find", "old", "replace", "replacement", "new")
        )
        if not isinstance(before, str) or not isinstance(after, str) or has_explicit_patch:
            return value

        normalized = dict(value)
        normalized["type"] = "patch"
        normalized.setdefault("search", before)
        normalized.setdefault("replace", after)
        return normalized

    @field_validator("content", "fallback_content", mode="before")
    @classmethod
    def _coerce_content_fields(cls, value: object) -> object:
        return _coerce_operation_content(value)

    @field_validator("search", "replace", mode="before")
    @classmethod
    def _coerce_patch_fields(cls, value: object) -> object:
        return _coerce_operation_content(value)

    @field_validator("hunks", mode="before")
    @classmethod
    def _coerce_hunks(cls, value: object) -> List[object]:
        return _ensure_list(value)


class GeneratedCodeOutput(AppBaseModel):
    assistant_summary: Optional[str] = Field(default=None, alias="assistantSummary")
    operations: List[FileOperation]


class StructuredGeneratedCodeOutput(AppBaseModel):
    assistant_summary: Optional[str] = Field(default=None, alias="assistantSummary")
    operations: List[StructuredFileOperationOutput] = Field(default_factory=list)
