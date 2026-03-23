import { useEffect, useMemo, useState } from "react";

import type { ProjectEvent, ProjectRecord, ReasoningMode, SlotKey } from "@vide/contracts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:4000";

type ClarificationDrafts = Partial<Record<SlotKey, string>>;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

export default function App() {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [clarificationDrafts, setClarificationDrafts] = useState<ClarificationDrafts>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void createProject();
  }, []);

  useEffect(() => {
    if (!project) {
      return;
    }

    const source = new EventSource(`${API_BASE}/projects/${project.id}/stream`);

    const handleProjectEvent = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as ProjectEvent;
      const maybeProject = payload.payload.project as ProjectRecord | undefined;
      const maybeMessage = payload.payload.message as string | undefined;

      if (maybeProject) {
        setProject(maybeProject);
      }
      if (maybeMessage) {
        setLogs((current) => [...current.slice(-79), maybeMessage.trimEnd()]);
      }
    };

    [
      "project.created",
      "project.updated",
      "project.plan_ready",
      "project.preview_ready",
      "project.preview_log",
      "project.error",
    ].forEach((eventName) => source.addEventListener(eventName, handleProjectEvent as EventListener));

    source.onerror = () => {
      setLogs((current) => [...current.slice(-79), "SSE disconnected, waiting for reconnect..."]);
    };

    return () => {
      source.close();
    };
  }, [project?.id]);

  const currentQuestions = project?.session.clarificationQuestions ?? [];
  const readyToConfirm = project?.status === "ready_for_confirmation";
  const previewUrl = project?.preview.url;
  const lastAssistantSummary = project?.session.assistantSummary;
  const mode = project?.reasoningMode ?? "plan_solve";

  const timeline = useMemo(() => {
    if (!project) {
      return [];
    }
    return [...project.session.messages].slice(-12);
  }, [project]);

  async function createProject() {
    try {
      const response = await api<{ project: ProjectRecord }>("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "New vibe project" }),
      });
      setProject(response.project);
      setLogs([]);
      setError(null);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Unable to create a project.");
    }
  }

  async function sendMessage() {
    if (!project || !messageDraft.trim()) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await api<{ project: ProjectRecord }>(`/projects/${project.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: messageDraft.trim(),
          reasoningMode: mode,
        }),
      });
      setProject(response.project);
      setMessageDraft("");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Unable to send the message.");
    } finally {
      setBusy(false);
    }
  }

  async function submitClarifications() {
    if (!project) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await api<{ project: ProjectRecord }>(`/projects/${project.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          clarificationAnswers: clarificationDrafts,
          reasoningMode: mode,
        }),
      });
      setProject(response.project);
      setClarificationDrafts({});
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Unable to submit clarification answers.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmGeneration() {
    if (!project) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await api<{ project: ProjectRecord }>(`/projects/${project.id}/confirm`, {
        method: "POST",
      });
      setProject(response.project);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Unable to confirm generation.");
    } finally {
      setBusy(false);
    }
  }

  async function changeMode(nextMode: ReasoningMode) {
    if (!project) {
      return;
    }

    const response = await api<{ project: ProjectRecord }>(`/projects/${project.id}/mode`, {
      method: "POST",
      body: JSON.stringify({ reasoningMode: nextMode }),
    });
    setProject(response.project);
  }

  return (
    <div className="app-shell">
      <aside className="control-panel">
        <div className="hero-block">
          <p className="eyebrow">Vide coding playground</p>
          <h1>Plan, clarify, generate, approve, preview.</h1>
          <p className="hero-copy">
            This console surfaces the full state of the vibe coding agent so we can inspect every step of the
            generation pipeline.
          </p>
        </div>

        <section className="panel">
          <div className="section-title">
            <h2>Session</h2>
            <button type="button" className="ghost" onClick={() => void createProject()}>
              New Project
            </button>
          </div>
          <label className="stacked">
            <span>Reasoning mode</span>
            <select value={mode} onChange={(event) => void changeMode(event.target.value as ReasoningMode)}>
              <option value="plan_solve">plan_solve</option>
              <option value="react">react</option>
            </select>
          </label>
          <div className="meta-grid">
            <div>
              <span>Status</span>
              <strong>{project?.status ?? "booting"}</strong>
            </div>
            <div>
              <span>Version</span>
              <strong>v{project?.session.versionNumber ?? 0}</strong>
            </div>
          </div>
          {lastAssistantSummary ? <p className="summary">{lastAssistantSummary}</p> : null}
        </section>

        <section className="panel">
          <div className="section-title">
            <h2>Prompt</h2>
          </div>
          <textarea
            value={messageDraft}
            onChange={(event) => setMessageDraft(event.target.value)}
            placeholder="Describe the app you want to generate or the change you want to make."
            rows={7}
          />
          <button type="button" onClick={() => void sendMessage()} disabled={busy || !messageDraft.trim()}>
            Send to agent
          </button>
        </section>

        {currentQuestions.length ? (
          <section className="panel accent">
            <div className="section-title">
              <h2>Clarifications</h2>
            </div>
            {currentQuestions.map((question) => (
              <label key={question.key} className="stacked">
                <span>{question.question}</span>
                <input
                  value={clarificationDrafts[question.key] ?? ""}
                  placeholder={question.placeholder}
                  onChange={(event) =>
                    setClarificationDrafts((current) => ({
                      ...current,
                      [question.key]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
            <button type="button" onClick={() => void submitClarifications()} disabled={busy}>
              Submit answers
            </button>
          </section>
        ) : null}

        {readyToConfirm ? (
          <section className="panel success">
            <div className="section-title">
              <h2>Approval gate</h2>
            </div>
            <p>The agent has prepared file changes and an execution manifest. Confirm to write files and run preview.</p>
            <button type="button" onClick={() => void confirmGeneration()} disabled={busy}>
              Confirm generation
            </button>
          </section>
        ) : null}

        {error ? <section className="panel error-panel">{error}</section> : null}
      </aside>

      <main className="workspace">
        <section className="workspace-grid">
          <article className="panel feed">
            <div className="section-title">
              <h2>Conversation</h2>
            </div>
            <div className="message-list">
              {timeline.map((item) => (
                <div key={item.id} className={`message ${item.role}`}>
                  <span>{item.role}</span>
                  <p>{item.content}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="panel">
            <div className="section-title">
              <h2>Plan</h2>
            </div>
            <ul className="bullets">
              {project?.session.planSteps.length ? (
                project.session.planSteps.map((step) => (
                  <li key={step.id}>
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                  </li>
                ))
              ) : (
                <li>
                  <strong>Waiting for a prompt</strong>
                  <span>The agent will surface the normalized plan here.</span>
                </li>
              )}
            </ul>
          </article>

          <article className="panel">
            <div className="section-title">
              <h2>File changes</h2>
            </div>
            <ul className="bullets">
              {project?.session.fileChangeSummary.length ? (
                project.session.fileChangeSummary.map((item) => (
                  <li key={item}>
                    <strong>Pending write</strong>
                    <span>{item}</span>
                  </li>
                ))
              ) : (
                <li>
                  <strong>No pending file changes</strong>
                  <span>Once the agent prepares a version, the summary shows up here.</span>
                </li>
              )}
            </ul>
          </article>

          <article className="panel">
            <div className="section-title">
              <h2>Versions</h2>
            </div>
            <ul className="bullets">
              {project?.versions.length ? (
                project.versions
                  .slice()
                  .reverse()
                  .map((version) => (
                    <li key={version.id}>
                      <strong>v{version.number}</strong>
                      <span>{version.summary}</span>
                    </li>
                  ))
              ) : (
                <li>
                  <strong>No snapshots yet</strong>
                  <span>Approving a generated plan creates the first workspace version.</span>
                </li>
              )}
            </ul>
          </article>
        </section>

        <section className="panel preview-panel">
          <div className="section-title">
            <h2>Preview</h2>
            <span>{previewUrl ?? "No preview running"}</span>
          </div>
          {previewUrl ? <iframe title="Generated preview" src={previewUrl} /> : <div className="preview-empty">Preview output will appear here after confirmation and runner startup.</div>}
        </section>

        <section className="panel logs-panel">
          <div className="section-title">
            <h2>Runner logs</h2>
          </div>
          <pre>{logs.length ? logs.join("\n") : "No runner logs yet."}</pre>
        </section>
      </main>
    </div>
  );
}
