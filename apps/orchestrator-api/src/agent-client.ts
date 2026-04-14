import type {
  AgentRepairRequest,
  AgentRepairResponse,
  AgentTurnRequest,
  AgentTurnResponse,
  ClarificationAnswer,
  ProjectRecord,
  ReasoningMode,
  RepairContext,
  WorkspaceFile,
} from "@vide/contracts";

import { performance } from "node:perf_hooks";
import { Agent } from "undici";

const DEFAULT_TIMEOUT_MS = 420_000;
const DEFAULT_RETRY_DELAY_MS = 350;
const MAX_TRANSPORT_ATTEMPTS = 2;
const RETRYABLE_AGENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

type ErrorWithCause = Error & {
  cause?: unknown;
  code?: string;
};

type AgentLogContext = {
  projectId?: string;
  sessionId?: string;
  reasoningMode?: ReasoningMode;
};

export function resolveTransportTimeoutOptions(timeoutMs: number): {
  headersTimeout: number;
  bodyTimeout: number;
} {
  if (timeoutMs > 0) {
    const transportTimeoutMs = timeoutMs + 5_000;
    return {
      headersTimeout: transportTimeoutMs,
      bodyTimeout: transportTimeoutMs,
    };
  }

  return {
    headersTimeout: 0,
    bodyTimeout: 0,
  };
}

export class AgentClient {
  private readonly dispatcher: Agent;
  private closed = false;
  private readonly timeoutEnabled: boolean;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  ) {
    this.timeoutEnabled = this.timeoutMs > 0;
    this.dispatcher = new Agent(resolveTransportTimeoutOptions(this.timeoutMs));
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;
    const context = this.extractLogContext(payload);

    for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt += 1) {
      const startedAt = performance.now();
      this.log("agent_request_started", {
        path,
        url,
        attempt,
        timeoutMs: this.timeoutEnabled ? this.timeoutMs : "disabled",
        ...context,
      });

      try {
        const response = await this.performPost<T>(url, path, payload);
        this.log("agent_request_succeeded", {
          path,
          url,
          attempt,
          durationMs: Math.round(performance.now() - startedAt),
          ...context,
        });
        return response;
      } catch (error) {
        const normalized = this.normalizeAgentError(path, url, error);
        lastError = normalized;
        const code = this.extractErrorCode(error);
        this.log("agent_request_failed", {
          path,
          url,
          attempt,
          durationMs: Math.round(performance.now() - startedAt),
          code: code || undefined,
          rawError: this.describeError(error),
          normalizedError: normalized.message,
          retryable: this.shouldRetryTransportError(error),
          ...context,
        });

        if (attempt >= MAX_TRANSPORT_ATTEMPTS || !this.shouldRetryTransportError(error)) {
          throw normalized;
        }

        await this.sleep(this.retryDelayMs);
      }
    }

    throw lastError ?? new Error(`本地 agent 服务 ${path} 请求失败。`);
  }

  private async performPost<T>(url: string, path: string, payload: unknown): Promise<T> {
    const controller = this.timeoutEnabled ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;

    try {
      const requestInit: RequestInit & { dispatcher: Agent } = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller?.signal,
        dispatcher: this.dispatcher,
      };
      const response = await fetch(url, requestInit);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Agent service ${path} failed: ${response.status} ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private shouldRetryTransportError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === "AbortError") {
      return false;
    }

    const code = this.extractErrorCode(error);
    if (code && RETRYABLE_AGENT_ERROR_CODES.has(code)) {
      return true;
    }

    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return (
      message.includes("fetch failed") ||
      message.includes("socket hang up") ||
      message.includes("other side closed") ||
      message.includes("connection closed")
    );
  }

  private normalizeAgentError(path: string, url: string, error: unknown): Error {
    if (error instanceof DOMException && error.name === "AbortError") {
      const timeoutLabel = this.timeoutEnabled ? `${Math.round(this.timeoutMs / 1000)} 秒` : "配置的等待窗口";
      return new Error(
        `本地 agent 服务 ${path} 在 ${timeoutLabel}内没有返回。请检查模型调用是否卡住，或稍后重试。`,
      );
    }

    const code = this.extractErrorCode(error);
    if (code === "ECONNREFUSED") {
      return new Error(`无法连接本地 agent 服务（${url}）。请确认 agent 进程仍在运行。`);
    }

    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
      return new Error(`连接本地 agent 服务超时（${url}）。请确认 agent 服务地址可访问。`);
    }

    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
      return new Error(
        `本地 agent 服务响应超时（${url}）。agent 处理耗时超过本地传输窗口，请检查生成阶段是否卡住或适当提高超时时间。`,
      );
    }

    if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET" || code === "ECONNABORTED") {
      return new Error(`本地 agent 服务连接在处理中断开（${url}）。请重试，必要时重启本地服务。`);
    }

    if (error instanceof Error && error.message.toLowerCase().includes("fetch failed")) {
      return new Error(`本地 agent 服务请求失败（${url}）。请确认 agent 在线，并检查本地网络或代理配置。`);
    }

    return error instanceof Error ? error : new Error(`本地 agent 服务 ${path} 请求失败。`);
  }

  private extractErrorCode(error: unknown): string {
    if (!(error instanceof Error)) {
      return "";
    }

    const directCode = typeof (error as ErrorWithCause).code === "string" ? (error as ErrorWithCause).code : "";
    if (directCode) {
      return directCode;
    }

    const cause = (error as ErrorWithCause).cause;
    if (cause && typeof cause === "object" && "code" in cause && typeof (cause as { code?: unknown }).code === "string") {
      return (cause as { code: string }).code;
    }

    return "";
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async runTurn(args: {
    project: ProjectRecord;
    userMessage?: string;
    clarificationAnswers?: ClarificationAnswer[];
    reasoningMode: ReasoningMode;
    workspaceSnapshot: WorkspaceFile[];
  }): Promise<AgentTurnResponse> {
    const payload: AgentTurnRequest = {
      projectId: args.project.id,
      sessionId: args.project.currentSessionId,
      reasoningMode: args.reasoningMode,
      state: args.project.session,
      userMessage: args.userMessage,
      clarificationAnswers: args.clarificationAnswers,
      workspaceSnapshot: args.workspaceSnapshot,
    };

    return this.post<AgentTurnResponse>("/agent/turn", payload);
  }

  async runRepair(args: {
    project: ProjectRecord;
    reasoningMode: ReasoningMode;
    workspaceSnapshot: WorkspaceFile[];
    repairContext: RepairContext;
  }): Promise<AgentRepairResponse> {
    const payload: AgentRepairRequest = {
      projectId: args.project.id,
      sessionId: args.project.currentSessionId,
      reasoningMode: args.reasoningMode,
      state: args.project.session,
      workspaceSnapshot: args.workspaceSnapshot,
      repairContext: args.repairContext,
    };

    return this.post<AgentRepairResponse>("/agent/repair", payload);
  }

  private extractLogContext(payload: unknown): AgentLogContext {
    if (!payload || typeof payload !== "object") {
      return {};
    }

    const candidate = payload as {
      projectId?: unknown;
      sessionId?: unknown;
      reasoningMode?: unknown;
    };

    return {
      projectId: typeof candidate.projectId === "string" ? candidate.projectId : undefined,
      sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
      reasoningMode: typeof candidate.reasoningMode === "string" ? (candidate.reasoningMode as ReasoningMode) : undefined,
    };
  }

  private describeError(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }

    const code = this.extractErrorCode(error);
    const cause =
      error.cause instanceof Error
        ? error.cause.message
        : typeof error.cause === "string"
          ? error.cause
          : undefined;

    return JSON.stringify({
      name: error.name,
      message: error.message,
      code: code || undefined,
      cause,
    });
  }

  private log(event: string, fields: Record<string, unknown>) {
    const payload = Object.entries({ event, ...fields })
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    console.info(payload);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.dispatcher.close();
    } catch (error) {
      if (this.extractErrorCode(error) === "UND_ERR_DESTROYED") {
        return;
      }
      throw error;
    }
  }
}
