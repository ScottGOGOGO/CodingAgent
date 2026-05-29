import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTask, ChatMessage, ClarificationAnswer, ProjectStatus, RunPhase, RunRecord, RunStatus } from "@vide/contracts";

import { useProject } from "./hooks/useProject.js";

const STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: "Ready",
  running: "Running",
  awaiting_input: "Needs input",
  awaiting_approval: "Candidate ready",
  promoting: "Promoting",
  ready: "Live",
  failed: "Failed",
};

const PHASE_LABELS: Record<RunPhase, string> = {
  intake: "Intake",
  context: "Context",
  clarify: "Clarify",
  plan: "Plan",
  design: "Design",
  design_seed: "Design seed",
  architect: "Architect",
  tool_loop: "Tool loop",
  sandbox_verify: "Verify",
  screenshot: "Screenshot",
  visual_review: "Visual review",
  repair: "Repair",
  approval: "Approval",
  promote: "Promote",
  preview: "Preview",
  report: "Report",
};

const RUN_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_input: "Waiting for input",
  awaiting_approval: "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(["queued", "running"]);

const PHASE_PROGRESS: Record<RunPhase, { title: string; detail: string }> = {
  intake: { title: "接收需求", detail: "正在整理这一轮输入和上下文入口。" },
  context: { title: "装配上下文", detail: "读取项目文件、历史消息和可用运行环境。" },
  clarify: { title: "判断澄清", detail: "检查需求是否足够明确，必要时生成追问。" },
  plan: { title: "规划候选方案", detail: "拆解产品方向、页面范围和生成策略。" },
  design: { title: "生成设计 brief", detail: "确定移动端信息架构、视觉方向和质量标准。" },
  design_seed: { title: "生成视觉身份种子", detail: "锁定配色、字体配对、动效语言，并把品牌资产写入沙箱。" },
  architect: { title: "规划工程架构", detail: "拆解文件结构、数据模型、组件树和按依赖排序的任务列表。" },
  tool_loop: { title: "迭代生成应用文件", detail: "Coder 按架构任务表逐步读写文件并校验构建，直至全部完成。" },
  sandbox_verify: { title: "沙箱构建验收", detail: "安装依赖并运行构建，拦截类型和打包问题。" },
  screenshot: { title: "捕获移动端截图", detail: "启动候选预览并记录手机视口证据。" },
  visual_review: { title: "视觉验收", detail: "检查首屏、布局、内容质量和移动端可用性。" },
  repair: { title: "修复候选版本", detail: "根据构建或视觉问题自动返工候选文件。" },
  approval: { title: "等待审批", detail: "候选版本已通过验收，可以预览和确认发布。" },
  promote: { title: "发布候选版本", detail: "把通过验收的沙箱快照推广到项目工作区。" },
  preview: { title: "启动正式预览", detail: "安装正式工作区依赖并启动可访问预览。" },
  report: { title: "生成结果报告", detail: "整理本轮结果、错误或发布状态。" },
};

const PHASE_ORDER: RunPhase[] = [
  "intake",
  "context",
  "clarify",
  "plan",
  "design",
  "design_seed",
  "architect",
  "tool_loop",
  "sandbox_verify",
  "repair",
  "screenshot",
  "visual_review",
  "approval",
  "promote",
  "preview",
  "report",
];

const PROGRESS_STEPS: Array<{ phase: RunPhase; label: string }> = [
  { phase: "context", label: "上下文" },
  { phase: "plan", label: "规划" },
  { phase: "design", label: "设计" },
  { phase: "design_seed", label: "视觉种子" },
  { phase: "architect", label: "架构" },
  { phase: "tool_loop", label: "生成" },
  { phase: "sandbox_verify", label: "构建" },
  { phase: "repair", label: "修复" },
  { phase: "visual_review", label: "验收" },
  { phase: "approval", label: "审批" },
];

const TASK_OWNER_PHASE: Record<AgentTask["owner"], RunPhase> = {
  clarifier: "clarify",
  planner: "plan",
  context_scout: "context",
  design_director: "design",
  design_seed_smith: "design_seed",
  architect: "architect",
  coder: "tool_loop",
  critic: "sandbox_verify",
  visual_critic: "visual_review",
  repairer: "repair",
  runtime: "screenshot",
};

function formatTime(timestamp: string) {
  try {
    return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function compactLogLine(log?: string) {
  return (log ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 140);
}

function phaseIndex(phase: RunPhase) {
  const index = PHASE_ORDER.indexOf(phase);
  return index < 0 ? PHASE_ORDER.length : index;
}

function latestTaskWithStatus(run: RunRecord, status: AgentTask["status"]) {
  return [...run.tasks].reverse().find((task) => task.status === status);
}

function stepState(stepPhase: RunPhase, run: RunRecord): "pending" | "active" | "completed" | "failed" {
  const failedTask = latestTaskWithStatus(run, "failed");
  const failedPhase = failedTask ? TASK_OWNER_PHASE[failedTask.owner] : run.status === "failed" ? run.phase : undefined;
  const currentIndex = phaseIndex(run.phase);
  const stepIndex = phaseIndex(stepPhase);

  if (run.status === "failed" && failedPhase) {
    const failedIndex = phaseIndex(failedPhase);
    if (stepPhase === failedPhase) return "failed";
    return stepIndex < failedIndex ? "completed" : "pending";
  }
  if (run.status === "awaiting_approval" || run.status === "completed") {
    return stepIndex <= phaseIndex("approval") ? "completed" : "pending";
  }
  if (stepPhase === run.phase) return "active";
  return stepIndex < currentIndex ? "completed" : "pending";
}

function useRunElapsedMs(run?: RunRecord) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!run || !ACTIVE_RUN_STATUSES.has(run.status)) {
      return;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  if (!run) {
    return 0;
  }

  const start = new Date(run.createdAt).getTime();
  const end = ACTIVE_RUN_STATUSES.has(run.status) ? nowMs : new Date(run.updatedAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <article className={`message message-${message.role}`} data-testid="chat-bubble">
      <div className="message-meta">
        <span>{message.role === "user" ? "You" : message.role === "tool" ? message.toolName ?? "Tool" : "Agent"}</span>
        <span>{formatTime(message.createdAt)}</span>
      </div>
      <p>{message.content}</p>
    </article>
  );
}

function RunProgressPanel({ run, logs }: { run?: RunRecord; logs: string[] }) {
  const elapsedMs = useRunElapsedMs(run);
  if (!run) {
    return null;
  }

  const phase = PHASE_PROGRESS[run.phase];
  const runningTask = latestTaskWithStatus(run, "running");
  const failedTask = latestTaskWithStatus(run, "failed");
  const recentTask = runningTask ?? failedTask ?? [...run.tasks].reverse().find((task) => task.status === "completed");
  const recentTool = run.toolCalls.at(-1);
  const latestLog = compactLogLine(logs.at(-1));
  const steps = PROGRESS_STEPS.filter((step) => step.phase !== "repair" || run.phase === "repair" || run.tasks.some((task) => task.owner === "repairer"));
  const detail = recentTask?.summary || phase.detail;

  return (
    <section className={`progress-panel progress-panel-${run.status}`} data-testid="run-progress-panel">
      <div className="progress-summary">
        <div className="progress-clock">
          <span>Elapsed</span>
          <strong data-testid="run-elapsed-time">{formatDuration(elapsedMs)}</strong>
        </div>
        <div className="progress-copy">
          <p className="eyebrow">Agent Thinking</p>
          <h2 data-testid="run-current-step">{phase.title}</h2>
          <p>{detail}</p>
        </div>
        <span className={`run-status-chip run-status-${run.status}`}>{RUN_LABELS[run.status]}</span>
      </div>

      <div className="progress-track" aria-label="Agent progress">
        {steps.map((step) => (
          <span key={step.phase} className={`progress-step progress-step-${stepState(step.phase, run)}`}>
            {step.label}
          </span>
        ))}
      </div>

      <div className="progress-footnotes">
        <span>{recentTask ? `${recentTask.title} · ${recentTask.status}` : phase.detail}</span>
        {recentTool ? <span>{`${recentTool.toolName} · ${recentTool.status}`}</span> : null}
        {latestLog ? <code>{latestLog}</code> : null}
      </div>
    </section>
  );
}

function ProductRail({ projectStatus, run }: { projectStatus: ProjectStatus; run?: RunRecord }) {
  return (
    <aside className="product-rail" aria-label="Workspace navigation">
      <div className="rail-brand">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <strong>Vide Studio</strong>
          <span>Commercial app builder</span>
        </div>
      </div>

      <nav className="rail-nav">
        <a className="active" href="#conversation">
          <span>01</span>
          Brief
        </a>
        <a href="#progress">
          <span>02</span>
          Build
        </a>
        <a href="#preview">
          <span>03</span>
          Preview
        </a>
      </nav>

      <div className="rail-status">
        <span>Current state</span>
        <strong>{STATUS_LABELS[projectStatus]}</strong>
        <p>{run ? `${PHASE_LABELS[run.phase]} · ${RUN_LABELS[run.status]}` : "Ready for a product brief"}</p>
      </div>
    </aside>
  );
}

interface ConversationRound {
  id: string;
  label: string;
  state: string;
  messages: ChatMessage[];
}

function buildRounds(messages: ChatMessage[], latestRun?: { status: RunStatus; phase: RunPhase }): ConversationRound[] {
  if (!messages.length) {
    return [];
  }

  const rounds: ConversationRound[] = [];
  let activeRound: ConversationRound | null = null;
  let turn = 0;

  for (const message of messages) {
    if (message.role === "user") {
      turn += 1;
      activeRound = {
        id: message.id,
        label: `Round ${turn}`,
        state: turn === 1 ? "New requirement" : "Follow-up",
        messages: [message],
      };
      rounds.push(activeRound);
      continue;
    }

    if (!activeRound) {
      activeRound = {
        id: `intro-${message.id}`,
        label: "Ready",
        state: "Listening",
        messages: [],
      };
      rounds.push(activeRound);
    }
    activeRound.messages.push(message);
  }

  const lastRound = rounds.at(-1);
  if (lastRound && latestRun) {
    lastRound.state = latestRun.status === "running" ? PHASE_LABELS[latestRun.phase] : RUN_LABELS[latestRun.status];
  }
  return rounds;
}

export default function App() {
  const { project, logs, error, busy, createProject, startRun, approveCandidate, requestRevision } = useProject();
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const latestRun = project?.latestRun;
  const candidate = project?.candidate ?? latestRun?.candidate;
  const questions = project?.session.clarificationRequest?.questions ?? [];
  const canApprove = project?.status === "awaiting_approval" && Boolean(candidate);
  const needsInput = project?.status === "awaiting_input" && questions.length > 0;
  const hasRevisionDraft = canApprove && draft.trim().length > 0;
  const previewUrl = candidate
    ? candidate.previewUrl ?? project?.preview.candidateUrl
    : project?.status === "ready"
      ? project.preview.url
      : undefined;

  const conversation = useMemo(() => {
    const messages = project?.session.messages ?? [];
    if (messages.length) {
      return messages;
    }
    return [
      {
        id: "welcome",
        role: "assistant" as const,
        content: "Tell me one product requirement at a time. I will ask follow-up questions when it is unclear, then update the mobile preview for review.",
        createdAt: new Date().toISOString(),
      },
    ];
  }, [project?.session.messages]);
  const rounds = useMemo(() => buildRounds(conversation, latestRun), [conversation, latestRun]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [conversation, latestRun?.phase, latestRun?.status]);

  function handleSubmit() {
    if (!draft.trim()) {
      return;
    }
    const content = draft.trim();
    setDraft("");
    if (canApprove) {
      void requestRevision(content);
      return;
    }
    void startRun(content);
  }

  function answerQuestionsWithDraft() {
    const answers: ClarificationAnswer[] = questions.map((question, index) => ({
      questionId: question.id,
      answer: (selectedAnswers[question.id] ?? draft.trim()) || question.options[0]?.value || `answer-${index + 1}`,
    }));
    setDraft("");
    setSelectedAnswers({});
    void startRun("", answers);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (needsInput) {
        answerQuestionsWithDraft();
      } else {
        handleSubmit();
      }
    }
  }

  return (
    <div className="agent-console">
      <ProductRail projectStatus={project?.status ?? "draft"} run={latestRun} />
      <section className="conversation-pane" id="conversation">
        <header className="topbar">
          <div>
            <p className="eyebrow">Product Generation</p>
            <h1>App review desk</h1>
          </div>
          <div className="topbar-actions">
            <span className={`status-pill status-${project?.status ?? "draft"}`} data-testid="project-status">
              {STATUS_LABELS[project?.status ?? "draft"]}
            </span>
            <button type="button" className="quiet-button" onClick={() => void createProject()}>
              New
            </button>
          </div>
        </header>

        <div id="progress">
          <RunProgressPanel run={latestRun} logs={logs} />
        </div>

        <div className="timeline" ref={scrollRef} data-testid="chat-stream">
          {rounds.map((round) => (
            <section key={round.id} className="round-card" data-testid="conversation-round">
              <div className="round-heading">
                <span>{round.label}</span>
                <strong>{round.state}</strong>
              </div>
              {round.messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
            </section>
          ))}

          {needsInput ? (
            <section className="question-set" data-testid="clarification-panel">
              <div className="section-heading">
                <span>Input</span>
                <strong>{questions.length} decisions</strong>
              </div>
              {questions.map((question) => (
                <article key={question.id} className="question-row">
                  <h2>{question.header}</h2>
                  <p>{question.question}</p>
                  <div>
                    {question.options.map((option) => (
                      <button
                        key={option.value}
                        className={selectedAnswers[question.id] === option.value ? "selected-option" : ""}
                        type="button"
                        onClick={() => {
                          setSelectedAnswers((current) => ({ ...current, [question.id]: option.value }));
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          {candidate ? (
            <section className="candidate-strip" data-testid="candidate-panel">
              <div className="section-heading">
                <span>Candidate</span>
                <strong>{candidate.validation.status}</strong>
              </div>
              <p>{candidate.validation.summary}</p>
              {candidate.validation.warnings?.length ? (
                <ul className="candidate-warnings" aria-label="Candidate warnings">
                  {candidate.validation.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              <pre>{candidate.diffSummary}</pre>
            </section>
          ) : null}

          {error ? <p className="error-line">{error}</p> : null}
        </div>

        <footer className="composer">
          {latestRun ? (
            <div className="run-meter">
              <span>{RUN_LABELS[latestRun.status]}</span>
              <strong data-testid="latest-run-phase">{PHASE_LABELS[latestRun.phase]}</strong>
              <span>{latestRun.toolCalls.length} tool calls</span>
            </div>
          ) : null}
          <textarea
            data-testid="composer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              needsInput
                ? "Answer the requested details, or click option chips above."
                : canApprove
                  ? "Type changes for the next round, or approve this candidate."
                  : "Describe the next requirement in one round."
            }
            rows={4}
            disabled={busy}
          />
          <div className="composer-actions">
            <p>{canApprove ? "Approve to publish, or type a revision to create the next round." : busy ? "Agent is working in a sandbox." : "One message creates one agent round."}</p>
            {canApprove ? (
              <div className="approval-actions">
                <input
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                  placeholder="Optional rejection note"
                  aria-label="Rejection feedback"
                />
                <button type="button" className="reject-button" onClick={() => void approveCandidate(false, feedback)}>
                  Reject
                </button>
                <button type="button" className="revision-button" disabled={!hasRevisionDraft || busy} onClick={handleSubmit}>
                  Send revision
                </button>
                <button data-testid="composer-send" type="button" onClick={() => void approveCandidate(true)}>
                  Approve candidate
                </button>
              </div>
            ) : (
              <button data-testid="composer-send" type="button" disabled={busy || (!draft.trim() && !needsInput)} onClick={needsInput ? answerQuestionsWithDraft : handleSubmit}>
                {needsInput ? "Submit input" : "Run agent"}
              </button>
            )}
          </div>
        </footer>
      </section>

      <section className="runtime-pane" id="preview">
        <header className="preview-header">
          <div>
            <p className="eyebrow">Mobile Review</p>
            <h2>{candidate ? "Candidate build" : project?.status === "ready" ? "Published app" : "iPhone preview"}</h2>
          </div>
          <span className={`preview-badge preview-${project?.preview.status ?? "idle"}`} data-testid="preview-badge">
            {project?.preview.status ?? "idle"}
          </span>
        </header>

        <div className="preview-frame-wrap">
          <div className="device-stage">
            <div className="iphone-frame" aria-label="iPhone preview frame">
              <div className="iphone-speaker" />
              <div className="iphone-screen">
                {previewUrl ? (
                  <iframe data-testid="preview-frame" title="Generated preview" src={previewUrl} />
                ) : (
                  <div className="preview-empty">
                    <span />
                    <strong>Ready for a candidate</strong>
                    <p>A clear product brief will generate a reviewed mobile app here.</p>
                  </div>
                )}
              </div>
              <div className="iphone-home-indicator" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
