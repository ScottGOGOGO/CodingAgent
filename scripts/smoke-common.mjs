import { setTimeout as sleep } from "node:timers/promises";

export const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:4000";
export const REASONING_MODE = process.env.REASONING_MODE ?? "plan_solve";
export const POLL_INTERVAL_MS = Number(process.env.SMOKE_POLL_INTERVAL_MS ?? 3000);
export const TURN_TIMEOUT_MS = Number(process.env.SMOKE_TURN_TIMEOUT_MS ?? 420000);
export const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 420000);

const FAILURE_KINDS = {
  LOCAL_SERVICE: "local_service_unreachable_or_timeout",
  AGENT_MODEL: "agent_model_call_failed",
  PREVIEW_EXECUTION: "preview_build_or_execution_failed",
  UNKNOWN: "unknown_failure",
};

export async function api(method, path, body, { apiBase = API_BASE } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
  }

  return response.json();
}

export async function fetchProject(projectId, options) {
  const payload = await api("GET", `/projects/${projectId}`, undefined, options);
  return payload.project;
}

export async function waitForProject(projectId, statuses, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastProject = null;

  while (Date.now() < deadline) {
    lastProject = await fetchProject(projectId, options);
    const previewStatus = lastProject.preview?.status ?? "unknown";
    console.log(`poll project=${projectId} status=${lastProject.status} preview=${previewStatus}`);
    if (statuses.has(lastProject.status)) {
      return lastProject;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for ${Array.from(statuses).join(", ")} on ${projectId}. Last status=${lastProject?.status ?? "unknown"}`,
  );
}

export function latestAssistantMessage(project) {
  const messages = project?.session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return messages[index].content;
    }
  }
  return null;
}

export function resolveProviderRoute(project) {
  return project?.latestRun?.providerRoute ?? project?.session?.providerRoute ?? null;
}

export function classifyFailure(project, errorMessage = "") {
  const text = [
    errorMessage,
    project?.latestRun?.error,
    project?.session?.error,
    project?.preview?.lastLog,
    latestAssistantMessage(project),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  if (
    /本地 agent 服务|agent service|econnrefused|headers timeout|body timeout|couldn't connect|timed out waiting/.test(text)
  ) {
    return FAILURE_KINDS.LOCAL_SERVICE;
  }

  if (
    project?.preview?.status === "error" ||
    /vite|rollup|preview|build failed|health check|install_dependencies|preflight validation|repair loop/.test(text)
  ) {
    return FAILURE_KINDS.PREVIEW_EXECUTION;
  }

  if (/模型|connection error|structured=|raw=|repair=|api key|openrouter|responses/.test(text)) {
    return FAILURE_KINDS.AGENT_MODEL;
  }

  return FAILURE_KINDS.UNKNOWN;
}

export function summarizeProject(stage, name, project, extra = {}) {
  return {
    stage,
    name,
    projectId: project?.id ?? null,
    status: project?.status ?? "unknown",
    previewStatus: project?.preview?.status ?? "unknown",
    previewUrl: project?.preview?.url ?? null,
    latestRunStatus: project?.latestRun?.status ?? null,
    latestRunPhase: project?.latestRun?.phase ?? null,
    providerRoute: resolveProviderRoute(project),
    lastAssistantMessage: latestAssistantMessage(project),
    failureKind: project?.status === "failed" ? classifyFailure(project) : undefined,
    ...extra,
  };
}

export function assertProjectReady(project, name) {
  if (project.status !== "ready" || project.preview?.status !== "ready" || !project.preview?.url) {
    const summary = summarizeProject("ready_assertion_failed", name, project, {
      expectedStatus: "ready",
      expectedPreviewStatus: "ready",
    });
    throw new Error(`Smoke case did not finish ready: ${JSON.stringify(summary)}`);
  }
}
