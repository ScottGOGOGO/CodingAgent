from __future__ import annotations

from enum import Enum
from typing import Dict, List, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class AppBaseModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


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


class ScreenSpec(AppBaseModel):
    id: str = ""
    name: str = Field(default="", validation_alias=AliasChoices("name", "title", "label"))
    purpose: str = Field(default="", validation_alias=AliasChoices("purpose", "summary", "description"))
    elements: List[object] = Field(default_factory=list)


class FlowSpec(AppBaseModel):
    id: str = ""
    name: str = Field(default="", validation_alias=AliasChoices("name", "title", "label"))
    steps: List[str] = Field(default_factory=list)
    success: str = Field(default="", validation_alias=AliasChoices("success", "outcome", "result"))


class DataModelNeed(AppBaseModel):
    entity: str = Field(default="", validation_alias=AliasChoices("entity", "name", "title"))
    fields: List[str] = Field(default_factory=list)
    notes: Optional[str] = Field(default=None, validation_alias=AliasChoices("notes", "description", "summary"))


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
    constraints: List[str] = Field(default_factory=list)
    success_criteria: List[str] = Field(default_factory=list, alias="successCriteria")
    assumptions: List[str] = Field(default_factory=list)


class PlanStep(AppBaseModel):
    id: str
    title: str
    detail: str
    status: Literal["pending", "done"]


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
    summary: str
    issues: List[str] = Field(default_factory=list)


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


class ToolCallTrace(AppBaseModel):
    id: str
    run_id: str = Field(alias="runId")
    tool: str
    started_at: str = Field(alias="startedAt")
    finished_at: Optional[str] = Field(default=None, alias="finishedAt")
    status: Literal["started", "completed", "failed"]
    input_summary: Optional[str] = Field(default=None, alias="inputSummary")
    output_summary: Optional[str] = Field(default=None, alias="outputSummary")


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


class RepairContext(AppBaseModel):
    attempt: int
    category: Literal["dependency", "type_build", "preview_boot", "requirement_mismatch"]
    failed_command: str = Field(alias="failedCommand")
    build_error: str = Field(alias="buildError")


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


class StructuredClarifierOutput(AppBaseModel):
    action: Optional[str] = None
    summary: Optional[str] = None
    clarity_score: Optional[float] = Field(default=None, alias="clarityScore")
    missing_information: List[object] = Field(default_factory=list, alias="missingInformation")
    questions: List[ClarificationQuestion] = Field(default_factory=list)
    assumptions: List[object] = Field(default_factory=list)
    working_spec: WorkingSpec = Field(default_factory=WorkingSpec, alias="workingSpec")


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


class StructuredPlanOutput(AppBaseModel):
    steps: List[str]
    summary: str


class StructuredCriticOutput(AppBaseModel):
    build_readiness_score: Optional[float] = Field(default=None, alias="buildReadinessScore")
    requirement_coverage_score: Optional[float] = Field(default=None, alias="requirementCoverageScore")
    summary: Optional[str] = None
    issues: List[object] = Field(default_factory=list)


class StructuredPatchHunkOutput(AppBaseModel):
    search: Optional[str] = None
    replace: Optional[str] = None
    occurrence: Optional[int] = 1


class StructuredFileOperationOutput(AppBaseModel):
    type: Optional[str] = Field(default=None, validation_alias=AliasChoices("type", "op"))
    path: Optional[str] = None
    summary: Optional[str] = None
    content: Optional[str] = None
    hunks: List[StructuredPatchHunkOutput] = Field(default_factory=list)
    fallback_content: Optional[str] = Field(default=None, alias="fallbackContent")
    command: Optional[str] = None
    search: Optional[str] = None
    replace: Optional[str] = None


class GeneratedCodeOutput(AppBaseModel):
    assistant_summary: Optional[str] = Field(default=None, alias="assistantSummary")
    operations: List[FileOperation]


class StructuredGeneratedCodeOutput(AppBaseModel):
    assistant_summary: Optional[str] = Field(default=None, alias="assistantSummary")
    operations: List[StructuredFileOperationOutput] = Field(default_factory=list)
