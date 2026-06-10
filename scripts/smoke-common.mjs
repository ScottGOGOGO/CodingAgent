import { setTimeout as sleep } from "node:timers/promises";

export const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:4000";
export const REASONING_MODE = process.env.REASONING_MODE ?? "local_generator";
export const POLL_INTERVAL_MS = Number(process.env.SMOKE_POLL_INTERVAL_MS ?? 3000);
export const TURN_TIMEOUT_MS = Number(process.env.SMOKE_TURN_TIMEOUT_MS ?? 900000);
export const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 900000);
export const STRICT_SMOKE = /^(1|true|yes|on)$/i.test(process.env.SMOKE_STRICT_GENERATION ?? "");

const FALLBACK_MARKERS = [
  /switching to deterministic commercial fallback/i,
  /Agent loop fallback\. Original context unavailable/i,
  /commercial record fallback/i,
  /deterministic (?:architecture|design brief|design seed|repair|visual review|commercial) fallback/i,
  /切换稳定商业记录体验/,
  /回退到单次生成/,
  /暂停最终截图/,
  /visual acceptance skipped/i,
  /AGENT_SKIP_ACCEPTANCE/i,
];

const FAILURE_KINDS = {
  LOCAL_SERVICE: "local_service_unreachable_or_timeout",
  AGENT_MODEL: "agent_model_call_failed",
  PREVIEW_EXECUTION: "preview_build_or_execution_failed",
  GENERATION_INCOMPLETE: "generation_incomplete",
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
    const phase = lastProject.latestRun?.phase ?? "none";
    const runStatus = lastProject.latestRun?.status ?? "none";
    console.log(`poll project=${projectId} status=${lastProject.status} run=${runStatus} phase=${phase} preview=${previewStatus}`);
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
  const explicitKind = project?.latestRun?.failureKind ?? project?.session?.failureKind;
  if (explicitKind) {
    return explicitKind;
  }

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
    /vite|rollup|preview|build failed|health check|install_dependencies|preflight validation|repair loop|npm run build|next build/.test(text)
  ) {
    return FAILURE_KINDS.PREVIEW_EXECUTION;
  }

  if (/模型|connection error|structured=|raw=|repair=|api key|openrouter|responses|model_call_failed/.test(text)) {
    return FAILURE_KINDS.AGENT_MODEL;
  }

  if (/generation_incomplete|strict|严格生成模式|fallback|deterministic|未产出/.test(text)) {
    return FAILURE_KINDS.GENERATION_INCOMPLETE;
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
    failureKind: project?.latestRun?.failureKind ?? (project?.status === "failed" ? classifyFailure(project) : undefined),
    candidatePreviewUrl: project?.preview?.candidateUrl ?? null,
    providerRoute: resolveProviderRoute(project),
    lastAssistantMessage: latestAssistantMessage(project),
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

export function assertStrictProject(project, name) {
  if (!STRICT_SMOKE) {
    return;
  }

  if (project.latestRun?.failureKind) {
    throw new Error(`Strict smoke ${name} failed with failureKind=${project.latestRun.failureKind}: ${project.latestRun.error ?? ""}`);
  }

  const text = [
    project.latestRun?.error,
    project.session?.error,
    project.candidate?.validation?.summary,
    ...(project.candidate?.validation?.warnings ?? []),
    project.candidate?.validation?.command,
    ...(project.latestRun?.tasks ?? []).map((task) => `${task.title}\n${task.summary ?? ""}`),
    ...(project.latestRun?.toolCalls ?? []).map((tool) => `${tool.toolName}\n${tool.inputSummary ?? ""}\n${tool.outputSummary ?? ""}\n${tool.error ?? ""}`),
    ...(project.session?.messages ?? []).map((message) => message.content),
  ]
    .filter(Boolean)
    .join("\n");

  const marker = FALLBACK_MARKERS.find((pattern) => pattern.test(text));
  if (marker) {
    throw new Error(`Strict smoke ${name} detected forbidden fallback marker: ${marker}`);
  }
}

export function isPassingSmokeResult(result) {
  return result.stage === "after_confirm" && result.status === "ready" && result.previewStatus === "ready" && !result.error;
}
