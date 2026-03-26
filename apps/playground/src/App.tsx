import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatMessage, ProjectStatus } from "@vide/contracts";

import { useProject } from "./hooks/useProject.js";

const STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: "Ready",
  clarifying: "Needs details",
  planning: "Planning",
  awaiting_approval: "Awaiting approval",
  running: "Running preview",
  repairing: "Repairing",
  ready: "Preview live",
  failed: "Failed",
  error: "Action needed",
};

function formatMessageTime(timestamp: string) {
  try {
    return new Intl.DateTimeFormat("en", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

function summarizePreviewState(status?: string, lastLog?: string) {
  if (status === "ready") {
    return "Preview is live and synced with the latest confirmed version.";
  }
  if (status === "starting" || status === "running") {
    return "The runner is installing dependencies, fixing build issues, and preparing the app preview.";
  }
  if (status === "error") {
    return lastLog ?? "The last preview attempt failed.";
  }
  return "Send a prompt on the left, confirm the generated changes, and the preview will appear here.";
}

function formatPhaseLabel(phase?: string) {
  if (!phase) {
    return "Preparing the next step";
  }

  return phase
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <article className={`chat-bubble ${message.role === "user" ? "chat-bubble-user" : "chat-bubble-assistant"}`}>
      <div className="bubble-meta">
        <span className="bubble-role">{message.role === "user" ? "You" : "Agent"}</span>
        <span className="bubble-time">{formatMessageTime(message.createdAt)}</span>
      </div>
      <p>{message.content}</p>
    </article>
  );
}

export default function App() {
  const {
    project,
    logs,
    error,
    busy,
    createProject,
    sendMessage,
    confirmGeneration,
  } = useProject();

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const previewUrl = project?.preview.url;
  const readyToConfirm = project?.status === "awaiting_approval";
  const clarificationDecision = project?.session.clarificationDecision;
  const clarificationQuestions = clarificationDecision?.questions ?? [];
  const messages = project?.session.messages ?? [];
  const latestLog = logs[logs.length - 1];
  const latestRun = project?.latestRun;
  const isGenerating =
    latestRun?.status === "queued" ||
    latestRun?.status === "in_progress" ||
    latestRun?.status === "running" ||
    project?.status === "running" ||
    project?.status === "repairing";
  const showPreviewOverlay = isGenerating || (!previewUrl && busy);
  const composerButtonLabel = readyToConfirm ? "Confirm" : "Send";
  const composerHint = readyToConfirm
    ? "The draft is ready. Confirm to write files, verify the build, and launch the preview."
    : clarificationQuestions.length > 0
      ? "Reply naturally in chat with the missing details. No separate form is needed."
      : busy
        ? "Generating the app, verifying the build, or repairing the current run."
        : "Describe what you want to build in one natural prompt, then keep chatting normally.";
  const conversation = useMemo(() => {
    if (messages.length) {
      return messages;
    }

    return [
      {
        id: "welcome",
        role: "assistant" as const,
        content:
          "Describe the app you want to build, and I will clarify missing details, plan the work, generate the code, and prepare a preview for approval.",
        createdAt: new Date().toISOString(),
      },
    ];
  }, [messages]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [conversation, busy, latestRun?.status, latestRun?.phase, readyToConfirm]);

  function handleNewChat() {
    setDraft("");
    void createProject();
  }

  function handleSend() {
    if (readyToConfirm) {
      void confirmGeneration();
      return;
    }

    if (!draft.trim()) {
      return;
    }

    const content = draft.trim();
    setDraft("");
    void sendMessage(content);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="studio-shell">
      <section className="chat-column">
        <header className="chat-header">
          <div className="brand-lockup">
            <div className="brand-mark" />
            <div>
              <p className="brand-eyebrow">Coding Agent</p>
              <h1>Build with chat</h1>
            </div>
          </div>

          <div className="chat-header-actions">
            <span className={`status-chip status-${project?.status ?? "draft"}`}>
              {STATUS_LABELS[project?.status ?? "draft"]}
            </span>
            <button type="button" className="ghost-button" onClick={handleNewChat}>
              New chat
            </button>
          </div>
        </header>

        <div className="chat-scroll">
          <div className="chat-stream" ref={scrollRef}>
            {conversation.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}

            {error ? (
              <section className="workflow-card workflow-card-error">
                <div className="workflow-card-header">
                  <h2>Request failed</h2>
                </div>
                <p>{error}</p>
              </section>
            ) : null}
          </div>
        </div>

        <footer className="composer-panel">
          <div className="composer-meta">
            <span>{project ? `Project ${project.id.slice(0, 8)}` : "Preparing session"}</span>
            <span>{readyToConfirm ? "Ready for confirmation" : busy ? "Agent is working..." : "Press Enter to send"}</span>
          </div>

          <div className="composer-box">
            {latestRun ? (
              <div className={`composer-status ${showPreviewOverlay ? "composer-status-live" : ""}`}>
                <span className="composer-status-label">
                  {showPreviewOverlay ? "Generating" : readyToConfirm ? "Ready" : "Latest run"}
                </span>
                <strong>{formatPhaseLabel(latestRun.phase)}</strong>
              </div>
            ) : null}

            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                readyToConfirm
                  ? "Confirm the prepared draft to start writing files and launching the preview."
                  : "Describe the app you want to generate or reply with more details."
              }
              rows={4}
              disabled={readyToConfirm}
            />

            <div className="composer-actions">
              <p className="composer-hint">{composerHint}</p>
              <button type="button" onClick={handleSend} disabled={busy || (!readyToConfirm && !draft.trim())}>
                {composerButtonLabel}
              </button>
            </div>
          </div>
        </footer>
      </section>

      <section className="preview-column">
        <header className="preview-header">
          <div className="preview-tabs">
            <button type="button" className="preview-tab preview-tab-active">
              Preview
            </button>
          </div>

          <div className="preview-header-actions">
            <span className={`preview-badge preview-${project?.preview.status ?? "idle"}`}>
              {project?.preview.status ?? "idle"}
            </span>
            {previewUrl ? (
              <a href={previewUrl} target="_blank" rel="noreferrer" className="preview-link">
                Open
              </a>
            ) : null}
          </div>
        </header>

        <div className="preview-stage">
          <div className="preview-frame-shell">
            {previewUrl ? <iframe title="Generated preview" src={previewUrl} /> : null}

            {!previewUrl ? (
              <div className={`preview-placeholder ${showPreviewOverlay ? "preview-placeholder-live" : ""}`}>
                <div className="preview-placeholder-visual">
                  <div className="signal signal-left" />
                  <div className="signal signal-right" />
                  <div className="signal-card signal-card-back" />
                  <div className="signal-card signal-card-mid" />
                  <div className="signal-card signal-card-front" />
                </div>

                <div className="preview-placeholder-copy">
                  <span>{showPreviewOverlay ? "Generating preview" : "Live preview"}</span>
                  <h2>{showPreviewOverlay ? "Rendering the next version" : "Preview is standing by"}</h2>
                  <p>{summarizePreviewState(project?.preview.status, latestLog ?? project?.preview.lastLog)}</p>
                </div>
              </div>
            ) : null}

            {showPreviewOverlay ? (
              <div className="preview-overlay">
                <div className="preview-overlay-card">
                  <div className="preview-overlay-header">
                    <span className="preview-overlay-badge">Generating</span>
                    <strong>{formatPhaseLabel(latestRun?.phase)}</strong>
                  </div>

                  <div className="preview-overlay-bars" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>

                  <p>
                    {latestRun?.phase === "execute_dispatch"
                      ? "Writing files, verifying the build, and warming up the preview."
                      : "Planning, generating code, and preparing the preview in the background."}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
