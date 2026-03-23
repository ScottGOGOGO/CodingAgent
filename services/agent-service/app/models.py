from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


class AppBaseModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class ReasoningMode(str, Enum):
    PLAN_SOLVE = "plan_solve"
    REACT = "react"


class ProjectStatus(str, Enum):
    DRAFT = "draft"
    CLARIFYING = "clarifying"
    PLANNING = "planning"
    READY_FOR_CONFIRMATION = "ready_for_confirmation"
    APPLYING_CHANGES = "applying_changes"
    RUNNING = "running"
    READY = "ready"
    ERROR = "error"


class ChatRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class SlotKey(str, Enum):
    PRODUCT_GOAL = "product_goal"
    TARGET_USERS = "target_users"
    CORE_PAGES = "core_pages"
    KEY_INTERACTIONS = "key_interactions"
    VISUAL_STYLE = "visual_style"
    EXTERNAL_INTEGRATIONS = "external_integrations"


class ChatMessage(AppBaseModel):
    id: str
    role: ChatRole
    content: str
    created_at: str = Field(alias="createdAt")


class RequirementSlots(AppBaseModel):
    product_goal: Optional[str] = None
    target_users: Optional[str] = None
    core_pages: Optional[str] = None
    key_interactions: Optional[str] = None
    visual_style: Optional[str] = None
    external_integrations: Optional[str] = None


class ClarificationQuestion(AppBaseModel):
    key: SlotKey
    question: str
    placeholder: str


class AppSpec(AppBaseModel):
    app_name: str = Field(alias="appName")
    title: str
    summary: str
    target_users: str = Field(alias="targetUsers")
    pages: List[str]
    key_interactions: List[str] = Field(alias="keyInteractions")
    visual_style: str = Field(alias="visualStyle")
    integrations: List[str]
    assumptions: List[str]


class PlanStep(AppBaseModel):
    id: str
    title: str
    detail: str
    status: Literal["pending", "done"]


class FileChange(AppBaseModel):
    path: str
    action: Literal["write", "delete"]
    content: Optional[str] = None
    summary: str


class WorkspaceFile(AppBaseModel):
    path: str
    content: str


class InstallDependenciesStep(AppBaseModel):
    type: Literal["install_dependencies"]
    description: str
    package_manager: Literal["npm"] = Field(alias="packageManager")


class BuildWebAppStep(AppBaseModel):
    type: Literal["build_web_app"]
    description: str
    package_manager: Literal["npm"] = Field(alias="packageManager")


class StartPreviewStep(AppBaseModel):
    type: Literal["start_vite_preview"]
    description: str
    package_manager: Literal["npm"] = Field(alias="packageManager")
    port: int


class StopPreviewStep(AppBaseModel):
    type: Literal["stop_preview"]
    description: str


class GitSnapshotStep(AppBaseModel):
    type: Literal["git_snapshot"]
    description: str
    message: str


ExecutionStep = Union[
    InstallDependenciesStep,
    BuildWebAppStep,
    StartPreviewStep,
    StopPreviewStep,
    GitSnapshotStep,
]


class AgentSessionState(AppBaseModel):
    session_id: str = Field(alias="sessionId")
    project_id: str = Field(alias="projectId")
    reasoning_mode: ReasoningMode = Field(alias="reasoningMode")
    messages: List[ChatMessage] = Field(default_factory=list)
    requirement_slots: RequirementSlots = Field(default_factory=RequirementSlots, alias="requirementSlots")
    clarity_score: float = Field(default=0.0, alias="clarityScore")
    clarification_rounds: int = Field(default=0, alias="clarificationRounds")
    missing_slots: List[SlotKey] = Field(default_factory=list, alias="missingSlots")
    clarification_questions: List[ClarificationQuestion] = Field(
        default_factory=list, alias="clarificationQuestions"
    )
    status: ProjectStatus = ProjectStatus.DRAFT
    app_spec: Optional[AppSpec] = Field(default=None, alias="appSpec")
    plan_steps: List[PlanStep] = Field(default_factory=list, alias="planSteps")
    assistant_summary: Optional[str] = Field(default=None, alias="assistantSummary")
    file_change_summary: List[str] = Field(default_factory=list, alias="fileChangeSummary")
    file_changes: List[FileChange] = Field(default_factory=list, alias="fileChanges")
    execution_manifest: List[ExecutionStep] = Field(default_factory=list, alias="executionManifest")
    version_number: int = Field(default=0, alias="versionNumber")
    preview_url: Optional[str] = Field(default=None, alias="previewUrl")
    error: Optional[str] = None
    assumptions: List[str] = Field(default_factory=list)

    def as_contract(self) -> Dict[str, object]:
        return self.model_dump(mode="json", by_alias=True)


class AgentTurnRequest(AppBaseModel):
    project_id: str = Field(alias="projectId")
    session_id: str = Field(alias="sessionId")
    reasoning_mode: ReasoningMode = Field(alias="reasoningMode")
    state: Optional[AgentSessionState] = None
    user_message: Optional[str] = Field(default=None, alias="userMessage")
    clarification_answers: Dict[SlotKey, str] = Field(default_factory=dict, alias="clarificationAnswers")
    workspace_snapshot: List[WorkspaceFile] = Field(default_factory=list, alias="workspaceSnapshot")


class AgentTurnResponse(AppBaseModel):
    state: AgentSessionState


class RepairContext(AppBaseModel):
    attempt: int
    failed_command: str = Field(alias="failedCommand")
    build_error: str = Field(alias="buildError")


class AgentRepairRequest(AppBaseModel):
    project_id: str = Field(alias="projectId")
    session_id: str = Field(alias="sessionId")
    reasoning_mode: ReasoningMode = Field(alias="reasoningMode")
    state: AgentSessionState
    workspace_snapshot: List[WorkspaceFile] = Field(default_factory=list, alias="workspaceSnapshot")
    repair_context: RepairContext = Field(alias="repairContext")


class AgentRepairResponse(AppBaseModel):
    state: AgentSessionState


class StructuredSpecOutput(AppBaseModel):
    title: str
    summary: str
    target_users: Union[str, List[str]]
    pages: List[Union[str, Dict[str, Any]]]
    key_interactions: List[Union[str, Dict[str, Any]]]
    visual_style: Union[str, Dict[str, Any]]
    integrations: Union[List[Union[str, Dict[str, Any]]], Dict[str, Any]]
    assumptions: List[str]


class StructuredPlanOutput(AppBaseModel):
    steps: List[str]
    summary: str


class GeneratedCodeFile(AppBaseModel):
    path: str
    content: str
    summary: Optional[str] = None


class GeneratedCodeOutput(AppBaseModel):
    assistant_summary: str = Field(alias="assistantSummary")
    files: List[GeneratedCodeFile]
    delete_paths: List[str] = Field(default_factory=list, alias="deletePaths")
