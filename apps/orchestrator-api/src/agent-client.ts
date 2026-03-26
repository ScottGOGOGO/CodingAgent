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
]);

type ErrorWithCause = Error & {
  cause?: unknown;
  code?: string;
};

export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  ) {}

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt += 1) {
      try {
        return await this.performPost<T>(url, path, payload);
      } catch (error) {
        const normalized = this.normalizeAgentError(path, url, error);
        lastError = normalized;

        if (attempt >= MAX_TRANSPORT_ATTEMPTS || !this.shouldRetryTransportError(error)) {
          throw normalized;
        }

        await this.sleep(this.retryDelayMs);
      }
    }

    throw lastError ?? new Error(`本地 agent 服务 ${path} 请求失败。`);
  }

  private async performPost<T>(url: string, path: string, payload: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

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
      clearTimeout(timeout);
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
      return new Error(
        `本地 agent 服务 ${path} 在 ${Math.round(this.timeoutMs / 1000)} 秒内没有返回。请检查模型调用是否卡住，或稍后重试。`,
      );
    }

    const code = this.extractErrorCode(error);
    if (code === "ECONNREFUSED") {
      return new Error(`无法连接本地 agent 服务（${url}）。请确认 agent 进程仍在运行。`);
    }

    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
      return new Error(`连接本地 agent 服务超时（${url}）。请确认 agent 服务地址可访问。`);
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
}
