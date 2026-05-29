import { useEffect, useState } from "react";
import type {
  AgentTask,
  ClarificationAnswer,
  ProjectEvent,
  ProjectRecord,
  RunRecord,
  ToolCallTrace,
} from "@vide/contracts";
import { ApiError, api, getApiBase } from "./useApi.js";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const ACTIVE_PREVIEW_STATUSES = new Set(["starting"]);
const ACTIVE_PROJECT_STORAGE_KEY = "vide.activeProjectId";
const RECOVERY_ATTEMPTS = 8;
const RECOVERY_DELAY_MS = 1000;
let initialProjectRequest: Promise<ProjectRecord> | null = null;
let recoveryProjectRequest: Promise<ProjectRecord> | null = null;

function readStoredProjectId() {
  try {
    return window.sessionStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeProjectId(projectId: string) {
  try {
    window.sessionStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Storage is an optimization for dev reloads; the app can continue without it.
  }
}

function clearStoredProjectId() {
  try {
    window.sessionStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

async function requestProject() {
  const response = await api<{ project: ProjectRecord }>("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "New local app" }),
  });
  return response.project;
}

async function fetchProject(projectId: string) {
  const response = await api<{ project: ProjectRecord }>(`/projects/${projectId}`);
  return response.project;
}

async function requestInitialProject() {
  initialProjectRequest ??= (async () => {
    const storedProjectId = readStoredProjectId();
    if (storedProjectId) {
      try {
        return await fetchProject(storedProjectId);
      } catch {
        clearStoredProjectId();
      }
    }

    const createdProject = await requestProject();
    storeProjectId(createdProject.id);
    return createdProject;
  })().catch((issue) => {
    initialProjectRequest = null;
    throw issue;
  });
  return initialProjectRequest;
}

function isMissingProject(issue: unknown) {
  return issue instanceof ApiError && issue.status === 404 && issue.message === "Project not found";
}

function getErrorMessage(issue: unknown, fallback: string) {
  return issue instanceof Error ? issue.message : fallback;
}

function isNetworkIssue(issue: unknown) {
  if (issue instanceof ApiError) {
    return false;
  }
  return issue instanceof Error && /failed to fetch|fetch failed|network|load failed/i.test(issue.message);
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function mergeRunRecord(current: RunRecord | undefined, incoming: RunRecord): RunRecord {
  return {
    ...(current ?? incoming),
    ...incoming,
    tasks: incoming.tasks.length ? incoming.tasks : current?.tasks ?? [],
    toolCalls: incoming.toolCalls.length ? incoming.toolCalls : current?.toolCalls ?? [],
  };
}

function upsertTask(tasks: AgentTask[], task: AgentTask) {
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index < 0) {
    return [...tasks, task];
  }
  return tasks.map((item, itemIndex) => (itemIndex === index ? task : item));
}

function upsertToolCall(toolCalls: ToolCallTrace[], toolCall: ToolCallTrace) {
  const index = toolCalls.findIndex((item) => item.id === toolCall.id);
  if (index < 0) {
    return [...toolCalls, toolCall];
  }
  return toolCalls.map((item, itemIndex) => (itemIndex === index ? toolCall : item));
}

function applyIncrementalEvent(current: ProjectRecord | null, event: ProjectEvent): ProjectRecord | null {
  const { project: incomingProject, run, task, toolCall, candidate } = event.payload;
  const base = incomingProject ?? current;
  if (!base) {
    return current;
  }

  let latestRun = base.latestRun;
  if (run) {
    latestRun = mergeRunRecord(latestRun, run);
  }
  if (task && latestRun && event.runId === latestRun.id) {
    latestRun = {
      ...latestRun,
      tasks: upsertTask(latestRun.tasks, task),
      updatedAt: task.updatedAt,
    };
  }
  if (toolCall && latestRun && toolCall.runId === latestRun.id) {
    latestRun = {
      ...latestRun,
      toolCalls: upsertToolCall(latestRun.toolCalls, toolCall),
      updatedAt: toolCall.finishedAt ?? toolCall.startedAt,
    };
  }

  const session = {
    ...base.session,
    tasks: task ? upsertTask(base.session.tasks, task) : base.session.tasks,
    toolCalls: toolCall ? upsertToolCall(base.session.toolCalls, toolCall) : base.session.toolCalls,
    candidate: candidate ?? base.session.candidate,
    updatedAt: event.createdAt,
  };

  return {
    ...base,
    latestRun,
    candidate: candidate ?? base.candidate,
    session,
    updatedAt: event.createdAt,
  };
}

export function useProject() {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    requestInitialProject()
      .then((createdProject) => {
        if (cancelled) return;
        setProject(createdProject);
        setLogs([]);
        setError(null);
      })
      .catch((issue) => {
        if (cancelled) return;
        setError(issue instanceof Error ? issue.message : "Unable to create a project.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!project?.id) return;

    const source = new EventSource(`${getApiBase()}/projects/${project.id}/stream`);

    const handleProjectEvent = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as ProjectEvent;
      const maybeMessage = payload.payload.message;

      setProject((current) => applyIncrementalEvent(current, payload));
      if (maybeMessage) setLogs((current) => [...current.slice(-99), maybeMessage.trimEnd()]);
    };

    [
      "project.created",
      "project.updated",
      "project.preview_ready",
      "project.preview_log",
      "project.error",
      "run.started",
      "run.updated",
      "run.awaiting_input",
      "run.approval_required",
      "run.failed",
      "run.completed",
      "run.cancelled",
      "candidate.created",
      "candidate.promoted",
      "tool.started",
      "tool.completed",
      "tool.failed",
      "task.updated",
    ].forEach((eventName) => source.addEventListener(eventName, handleProjectEvent as EventListener));

    source.onerror = () => {
      setLogs((current) => [...current.slice(-99), "SSE disconnected, waiting for reconnect..."]);
      void refreshProject(project.id);
    };

    return () => {
      source.close();
    };
  }, [project?.id]);

  useEffect(() => {
    if (!project?.id) {
      return;
    }
    const runStatus = project.latestRun?.status;
    const shouldPoll =
      (runStatus && ACTIVE_RUN_STATUSES.has(runStatus)) ||
      ACTIVE_PREVIEW_STATUSES.has(project.preview.status) ||
      project.status === "running" ||
      project.status === "promoting";
    if (!shouldPoll) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshProject(project.id);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [project?.id, project?.latestRun?.status, project?.preview.status, project?.status]);

  async function createFreshProject() {
    clearStoredProjectId();
    initialProjectRequest = null;
    const createdProject = await requestProject();
    storeProjectId(createdProject.id);
    initialProjectRequest = Promise.resolve(createdProject);
    setProject(createdProject);
    setLogs([]);
    setError(null);
    return createdProject;
  }

  async function recoverMissingProject() {
    recoveryProjectRequest ??= createFreshProject().finally(() => {
      recoveryProjectRequest = null;
    });
    return recoveryProjectRequest;
  }

  async function createProject() {
    try {
      await createFreshProject();
    } catch (issue) {
      setError(getErrorMessage(issue, "Unable to create a project."));
    }
  }

  async function refreshProject(projectId: string) {
    try {
      const response = await api<{ project: ProjectRecord }>(`/projects/${projectId}`);
      setProject(response.project);
    } catch (issue) {
      if (isMissingProject(issue)) {
        void recoverMissingProject();
      }
      // SSE remains the main sync path.
    }
  }

  async function recoverInterruptedMutation(projectId: string) {
    for (let attempt = 1; attempt <= RECOVERY_ATTEMPTS; attempt += 1) {
      await wait(RECOVERY_DELAY_MS);
      try {
        const latest = await fetchProject(projectId);
        setProject(latest);
        setError(null);
        return true;
      } catch (issue) {
        if (isMissingProject(issue)) {
          await recoverMissingProject();
          setError(null);
          return true;
        }
      }
    }
    return false;
  }

  async function startRun(content: string, clarificationAnswers?: ClarificationAnswer[]) {
    if (!project || (!content.trim() && !clarificationAnswers?.length)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ project: ProjectRecord; run: RunRecord }>(`/projects/${project.id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          userMessage: content.trim() || undefined,
          clarificationAnswers,
        }),
      });
      setProject(response.project);
    } catch (issue) {
      if (isMissingProject(issue)) {
        await recoverMissingProject();
        return;
      }
      if (isNetworkIssue(issue) && project.id && (await recoverInterruptedMutation(project.id))) {
        return;
      }
      setError(getErrorMessage(issue, "Unable to start the run."));
    } finally {
      setBusy(false);
    }
  }

  async function approveCandidate(approved: boolean, feedback?: string) {
    if (!project?.latestRun) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ project: ProjectRecord; run: RunRecord }>(`/runs/${project.latestRun.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ approved, feedback }),
      });
      setProject(response.project);
    } catch (issue) {
      if (issue instanceof ApiError && issue.status === 404) {
        await recoverMissingProject();
        return;
      }
      if (isNetworkIssue(issue) && project.id && (await recoverInterruptedMutation(project.id))) {
        return;
      }
      setError(getErrorMessage(issue, "Unable to update candidate approval."));
    } finally {
      setBusy(false);
    }
  }

  async function requestRevision(feedback: string) {
    const revision = feedback.trim();
    if (!project?.latestRun || !revision) return;
    setBusy(true);
    setError(null);
    try {
      const rejection = await api<{ project: ProjectRecord; run: RunRecord }>(`/runs/${project.latestRun.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ approved: false, feedback: revision }),
      });
      const response = await api<{ project: ProjectRecord; run: RunRecord }>(`/projects/${rejection.project.id}/runs`, {
        method: "POST",
        body: JSON.stringify({ userMessage: revision }),
      });
      setProject(response.project);
    } catch (issue) {
      if (issue instanceof ApiError && issue.status === 404) {
        await recoverMissingProject();
        return;
      }
      if (isNetworkIssue(issue) && project.id && (await recoverInterruptedMutation(project.id))) {
        return;
      }
      setError(getErrorMessage(issue, "Unable to request a revision."));
    } finally {
      setBusy(false);
    }
  }

  return {
    project,
    logs,
    error,
    busy,
    createProject,
    startRun,
    approveCandidate,
    requestRevision,
  };
}
