import { useEffect, useState } from "react";
import type { ProjectEvent, ProjectRecord } from "@vide/contracts";
import { api, getApiBase } from "./useApi.js";

const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "running"]);
const ACTIVE_PREVIEW_STATUSES = new Set(["starting", "running"]);

export function useProject() {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void createProject();
  }, []);

  useEffect(() => {
    if (!project) return;

    const source = new EventSource(`${getApiBase()}/projects/${project.id}/stream`);

    const handleProjectEvent = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as ProjectEvent;
      const maybeProject = payload.payload.project as ProjectRecord | undefined;
      const maybeMessage = payload.payload.message as string | undefined;

      if (maybeProject) setProject(maybeProject);
      if (maybeMessage) setLogs((current) => [...current.slice(-79), maybeMessage.trimEnd()]);
    };

    [
      "project.created",
      "project.updated",
      "project.preview_ready",
      "project.preview_log",
      "project.error",
      "run.updated",
      "run.approval_required",
      "run.failed",
      "run.completed",
    ].forEach((eventName) => source.addEventListener(eventName, handleProjectEvent as EventListener));

    source.onerror = () => {
      setLogs((current) => [...current.slice(-79), "SSE disconnected, waiting for reconnect..."]);
    };

    return () => { source.close(); };
  }, [project?.id]);

  useEffect(() => {
    if (!project?.id) {
      return;
    }

    const runStatus = project.latestRun?.status;
    const previewStatus = project.preview.status;
    const shouldPoll =
      (runStatus && ACTIVE_RUN_STATUSES.has(runStatus)) ||
      ACTIVE_PREVIEW_STATUSES.has(previewStatus) ||
      project.status === "running" ||
      project.status === "repairing";

    if (!shouldPoll) {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshProject(project.id);
    }, 3000);

    return () => window.clearInterval(interval);
  }, [project?.id, project?.latestRun?.status, project?.preview.status, project?.status]);

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

  async function refreshProject(projectId: string) {
    try {
      const response = await api<{ project: ProjectRecord }>(`/projects/${projectId}`);
      setProject(response.project);
    } catch {
      // SSE remains the primary sync path; polling is only a fallback.
    }
  }

  async function sendMessage(content: string) {
    if (!project || !content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ project: ProjectRecord }>(`/projects/${project.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: content.trim() }),
      });
      setProject(response.project);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Unable to send the message.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmGeneration() {
    if (!project) return;
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

  return {
    project,
    logs,
    error,
    busy,
    createProject,
    sendMessage,
    confirmGeneration,
  };
}
