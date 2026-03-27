from __future__ import annotations

from typing import List, Optional

from pydantic import AliasChoices, Field, field_validator, model_validator

from .common import (
    AppBaseModel,
    _coerce_step_list,
    _coerce_string_list,
    _ensure_list,
    _stringify_model_value,
    _stringify_named_mapping,
)


class ScreenSpec(AppBaseModel):
    id: str = ""
    name: str = Field(default="", validation_alias=AliasChoices("name", "title", "label"))
    purpose: str = Field(default="", validation_alias=AliasChoices("purpose", "summary", "description"))
    elements: List[object] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce_model(cls, value: object) -> object:
        if isinstance(value, str):
            text = _stringify_model_value(value)
            return {"name": text, "elements": []} if text else {"elements": []}

        if isinstance(value, list):
            text = _stringify_model_value(value)
            return {"name": text, "elements": []} if text else {"elements": []}

        if isinstance(value, dict):
            normalized = dict(value)
            if "elements" not in normalized:
                for alias in ("items", "sections", "features", "components"):
                    candidate = normalized.get(alias)
                    if candidate is not None:
                        normalized["elements"] = candidate
                        break
            return normalized

        return value

    @field_validator("id", "name", "purpose", mode="before")
    @classmethod
    def _coerce_text(cls, value: object) -> str:
        return _stringify_model_value(value)

    @field_validator("elements", mode="before")
    @classmethod
    def _coerce_elements(cls, value: object) -> List[object]:
        normalized: List[object] = []
        for item in _ensure_list(value):
            if item is None:
                continue
            if isinstance(item, dict):
                text = _stringify_named_mapping(item) or _stringify_model_value(item)
                normalized.append(text or item)
                continue
            if isinstance(item, list):
                text = _stringify_model_value(item)
                normalized.append(text or item)
                continue
            normalized.append(item)
        return normalized


class FlowSpec(AppBaseModel):
    id: str = ""
    name: str = Field(default="", validation_alias=AliasChoices("name", "title", "label"))
    steps: List[str] = Field(default_factory=list)
    success: str = Field(default="", validation_alias=AliasChoices("success", "outcome", "result"))

    @model_validator(mode="before")
    @classmethod
    def _coerce_model(cls, value: object) -> object:
        if isinstance(value, str):
            text = _stringify_model_value(value)
            return {"name": text, "steps": []} if text else {"steps": []}

        if isinstance(value, list):
            return {"steps": value}

        return value

    @field_validator("id", "name", "success", mode="before")
    @classmethod
    def _coerce_text(cls, value: object) -> str:
        return _stringify_model_value(value)

    @field_validator("steps", mode="before")
    @classmethod
    def _coerce_steps(cls, value: object) -> List[str]:
        return _coerce_step_list(value)


class DataModelNeed(AppBaseModel):
    entity: str = Field(default="", validation_alias=AliasChoices("entity", "name", "title"))
    fields: List[str] = Field(default_factory=list)
    notes: Optional[str] = Field(default=None, validation_alias=AliasChoices("notes", "description", "summary"))

    @model_validator(mode="before")
    @classmethod
    def _coerce_model(cls, value: object) -> object:
        if isinstance(value, str):
            text = _stringify_model_value(value)
            if not text:
                return {"entity": "", "fields": []}

            if ":" in text:
                entity, _, remainder = text.partition(":")
                fields = [item.strip() for item in remainder.split(",") if item.strip()]
                return {"entity": entity.strip(), "fields": fields}

            return {"entity": text, "fields": []}
        return value

    @field_validator("entity", "notes", mode="before")
    @classmethod
    def _coerce_text(cls, value: object) -> object:
        if value is None:
            return value
        return _stringify_model_value(value)

    @field_validator("fields", mode="before")
    @classmethod
    def _coerce_fields(cls, value: object) -> List[str]:
        return _coerce_string_list(value)


class DesignTargets(AppBaseModel):
    visual_mood: str = Field(default="", alias="visualMood")
    layout_energy: str = Field(default="", alias="layoutEnergy")
    color_strategy: str = Field(default="", alias="colorStrategy")
    component_tone: str = Field(default="", alias="componentTone")
    motion_intensity: str = Field(default="", alias="motionIntensity")
    interaction_focus: List[str] = Field(default_factory=list, alias="interactionFocus")

    @field_validator(
        "visual_mood",
        "layout_energy",
        "color_strategy",
        "component_tone",
        "motion_intensity",
        mode="before",
    )
    @classmethod
    def _coerce_text(cls, value: object) -> str:
        return _stringify_model_value(value)

    @field_validator("interaction_focus", mode="before")
    @classmethod
    def _coerce_focus_items(cls, value: object) -> List[str]:
        return _coerce_string_list(value)


class WorkingSpec(AppBaseModel):
    title: Optional[str] = None
    summary: Optional[str] = None
    goal: Optional[str] = None
    target_users: List[str] = Field(default_factory=list, alias="targetUsers")
    screens: List[ScreenSpec] = Field(default_factory=list)
    core_flows: List[FlowSpec] = Field(default_factory=list, alias="coreFlows")
    data_model_needs: List[DataModelNeed] = Field(default_factory=list, alias="dataModelNeeds")
    integrations: List[object] = Field(default_factory=list)
    brand_and_visual_direction: Optional[str] = Field(default=None, alias="brandAndVisualDirection")
    constraints: List[str] = Field(default_factory=list)
    success_criteria: List[str] = Field(default_factory=list, alias="successCriteria")
    assumptions: List[str] = Field(default_factory=list)

    @field_validator("title", "summary", "goal", mode="before")
    @classmethod
    def _coerce_text(cls, value: object) -> Optional[str]:
        if value is None:
            return None
        return _stringify_model_value(value)

    @field_validator("target_users", "constraints", "success_criteria", "assumptions", mode="before")
    @classmethod
    def _coerce_string_lists(cls, value: object) -> List[str]:
        return _coerce_string_list(value)

    @field_validator("screens", "core_flows", "data_model_needs", "integrations", mode="before")
    @classmethod
    def _coerce_collection_fields(cls, value: object) -> List[object]:
        return _ensure_list(value)


class AppSpec(AppBaseModel):
    app_name: str = Field(alias="appName")
    title: str
    summary: str
    goal: str
    target_users: List[str] = Field(default_factory=list, alias="targetUsers")
    screens: List[ScreenSpec] = Field(default_factory=list)
    core_flows: List[FlowSpec] = Field(default_factory=list, alias="coreFlows")
    data_model_needs: List[DataModelNeed] = Field(default_factory=list, alias="dataModelNeeds")
    integrations: List[str] = Field(default_factory=list)
    brand_and_visual_direction: str = Field(alias="brandAndVisualDirection")
    design_targets: DesignTargets = Field(default_factory=DesignTargets, alias="designTargets")
    constraints: List[str] = Field(default_factory=list)
    success_criteria: List[str] = Field(default_factory=list, alias="successCriteria")
    assumptions: List[str] = Field(default_factory=list)


class PlanStep(AppBaseModel):
    id: str
    title: str
    detail: str
    status: str
