from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import AliasChoices, Field, field_validator, model_validator

from .common import AppBaseModel, _coerce_string_list, _ensure_list, _stringify_model_value
from .execution import ApprovalRequest, EvaluationResult, ExecutionStep, FileOperation, ProviderRoute, RepairContext, UsageMetrics, WorkspaceFile
from .spec import AppSpec, PlanStep, WorkingSpec


class ReasoningMode(str, Enum):
    PLAN_SOLVE = "plan_solve"
    REACT = "react"


class ProjectStatus(str, Enum):
    DRAFT = "draft"
    CLARIFYING = "clarifying"
    PLANNING = "planning"
    AWAITING_APPROVAL = "awaiting_approval"
    RUNNING = "running"
    REPAIRING = "repairing"
    READY = "ready"
    FAILED = "failed"
    ERROR = "error"


class RunStatus(str, Enum):
    QUEUED = "queued"
    IN_PROGRESS = "in_progress"
    AWAITING_INPUT = "awaiting_input"
    AWAITING_APPROVAL = "awaiting_approval"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class RunAction(str, Enum):
    TURN = "turn"
    REPAIR = "repair"
    EXECUTE = "execute"


class RunPhase(str, Enum):
    INTAKE = "intake"
    DYNAMIC_CLARIFY = "dynamic_clarify"
    NORMALIZE_SPEC = "normalize_spec"
    PLANNING = "planning"
    CONTEXT_BUILD = "context_build"
    IMPLEMENT_LOOP = "implement_loop"
    VERIFY_LOOP = "verify_loop"
    APPROVAL_INTERRUPT = "approval_interrupt"
    EXECUTE_DISPATCH = "execute_dispatch"
    REPORT = "report"


class ChatRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class ChatMessage(AppBaseModel):
    id: str
    role: ChatRole
    content: str
    created_at: str = Field(alias="createdAt")


class ClarificationQuestion(AppBaseModel):
    id: str = ""
    question: str = ""
    placeholder: str = ""
    rationale: Optional[str] = None
    required: bool = True

    @model_validator(mode="before")
    @classmethod
    def _coerce_model(cls, value: object) -> object:
        if isinstance(value, str):
            text = _stringify_model_value(value)
            return {"question": text} if text else {}
        return value

    @field_validator("id", "question", "placeholder", "rationale", mode="before")
    @classmethod
    def _coerce_text(cls, value: object) -> object:
        if value is None:
            return value
        return _stringify_model_value(value)


class ClarificationAnswer(AppBaseModel):
    question_id: str = Field(alias="questionId")
    answer: str


class ClarificationDecision(AppBaseModel):
    action: Literal["ask", "ready", "assume_ready"]
    summary: str = ""
    clarity_score: float = Field(alias="clarityScore")
    missing_information: List[str] = Field(default_factory=list, alias="missingInformation")
    questions: List[ClarificationQuestion] = Field(default_factory=list)
    assumptions: List[str] = Field(default_factory=list)


class RunSnapshot(AppBaseModel):
    id: Optional[str] = None
    status: Optional[RunStatus] = None
    phase: Optional[RunPhase] = None
    approval_request: Optional[ApprovalRequest] = Field(default=None, alias="approvalRequest")
    provider_route: Optional[ProviderRoute] = Field(default=None, alias="providerRoute")
    evaluation: Optional[EvaluationResult] = None
    usage: Optional[UsageMetrics] = None
    error: Optional[str] = None


class AgentSessionState(AppBaseModel):
    session_id: str = Field(alias="sessionId")
    project_id: str = Field(alias="projectId")
    reasoning_mode: ReasoningMode = Field(alias="reasoningMode")
    messages: List[ChatMessage] = Field(default_factory=list)
    clarification_decision: Optional[ClarificationDecision] = Field(default=None, alias="clarificationDecision")
    working_spec: WorkingSpec = Field(default_factory=WorkingSpec, alias="workingSpec")
    app_spec: Optional[AppSpec] = Field(default=None, alias="appSpec")
    plan_steps: List[PlanStep] = Field(default_factory=list, alias="planSteps")
    assistant_summary: Optional[str] = Field(default=None, alias="assistantSummary")
    file_change_summary: List[str] = Field(default_factory=list, alias="fileChangeSummary")
    file_operations: List[FileOperation] = Field(default_factory=list, alias="fileOperations")
    execution_manifest: List[ExecutionStep] = Field(default_factory=list, alias="executionManifest")
    version_number: int = Field(default=0, alias="versionNumber")
    preview_url: Optional[str] = Field(default=None, alias="previewUrl")
    error: Optional[str] = None
    assumptions: List[str] = Field(default_factory=list)
    provider_route: Optional[ProviderRoute] = Field(default=None, alias="providerRoute")
    evaluation: Optional[EvaluationResult] = None
    last_context_paths: List[str] = Field(default_factory=list, alias="lastContextPaths")
    run_phase: Optional[RunPhase] = Field(default=None, alias="runPhase")
    status: ProjectStatus = ProjectStatus.DRAFT
    run: Optional[RunSnapshot] = None

    def as_contract(self) -> Dict[str, object]:
        return self.model_dump(mode="json", by_alias=True)


class SessionRecord(AppBaseModel):
    id: str
    project_id: str = Field(alias="projectId")
    reasoning_mode: ReasoningMode = Field(alias="reasoningMode")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    state: AgentSessionState


class RunRecord(AppBaseModel):
    id: str
    project_id: str = Field(alias="projectId")
    session_id: str = Field(alias="sessionId")
    reasoning_mode: ReasoningMode = Field(alias="reasoningMode")
    action: RunAction
    status: RunStatus
    phase: Optional[RunPhase] = None
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    state: AgentSessionState
    provider_route: Optional[ProviderRoute] = Field(default=None, alias="providerRoute")
    evaluation: Optional[EvaluationResult] = None
    usage: Optional[UsageMetrics] = None
    approval_request: Optional[ApprovalRequest] = Field(default=None, alias="approvalRequest")
    error: Optional[str] = None


class AgentTurnRequest(AppBaseModel):
    project_id: str = Field(alias="projectId")
    session_id: str = Field(alias="sessionId")
    reasoning_mode: ReasoningMode = Field(alias="reasoningMode")
    state: Optional[AgentSessionState] = None
    user_message: Optional[str] = Field(default=None, alias="userMessage")
    clarification_answers: List[ClarificationAnswer] = Field(default_factory=list, alias="clarificationAnswers")
    workspace_snapshot: List[WorkspaceFile] = Field(default_factory=list, alias="workspaceSnapshot")


class AgentTurnResponse(AppBaseModel):
    state: AgentSessionState


class AgentRepairRequest(AppBaseModel):
    project_id: str = Field(alias="projectId")
    session_id: str = Field(alias="sessionId")
    reasoning_mode: ReasoningMode = Field(alias="reasoningMode")
    state: AgentSessionState
    workspace_snapshot: List[WorkspaceFile] = Field(default_factory=list, alias="workspaceSnapshot")
    repair_context: RepairContext = Field(alias="repairContext")


class AgentRepairResponse(AppBaseModel):
    state: AgentSessionState
