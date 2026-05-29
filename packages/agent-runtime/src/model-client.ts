import type { ModelRole, RuntimeConfig } from "./config.js";

export interface JsonGenerationRequest {
  role: ModelRole;
  system: string;
  user: string;
  schemaHint: string;
}

/** Single tool exposed to the model as part of a tool-use call. */
export interface LLMToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

/** Chat message used in the tool-use loop. */
export type LLMMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content?: string;
      toolCalls?: LLMToolCallRequest[];
    }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      content: string;
    };

export interface LLMToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON arguments string returned by the model. */
  arguments: string;
}

export interface ChatWithToolsRequest {
  role: ModelRole;
  messages: LLMMessage[];
  tools: LLMToolDescriptor[];
  /** If true, model is forced to call a tool. Defaults to "auto". */
  forceToolUse?: boolean;
  /** Override per-request temperature. */
  temperature?: number;
  /** Max tokens to keep the loop bounded. */
  maxTokens?: number;
  /** Hard per-call timeout override in milliseconds. Uses runtime timeout when omitted. */
  timeoutMs?: number;
}

export interface ChatWithToolsResponse {
  /** Plain assistant content, may be empty if only tool calls were returned. */
  content: string;
  /** Tool calls the model wants to execute. Empty array if the model produced a final answer. */
  toolCalls: LLMToolCallRequest[];
  /** Reason the model stopped: "tool_calls" | "stop" | "length" | "..." */
  finishReason?: string;
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
};

type ModelClientConfig = Omit<RuntimeConfig, "agentModelTurnTimeoutMs"> &
  Partial<Pick<RuntimeConfig, "agentModelTurnTimeoutMs">>;

export class ModelClient {
  private readonly config: RuntimeConfig;

  constructor(config: ModelClientConfig) {
    this.config = {
      ...config,
      agentModelTurnTimeoutMs: config.agentModelTurnTimeoutMs ?? 90_000,
    };
  }

  get configured(): boolean {
    return Boolean(this.config.apiKey && this.config.baseUrl && this.config.modelName);
  }

  async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
    if (!this.config.apiKey || !this.config.baseUrl) {
      throw new Error("Model is not configured.");
    }

    const apiKey = this.config.apiKey;
    const baseUrl = this.config.baseUrl;
    const model = this.config.roleModels[request.role] ?? this.config.modelName;
    if (!model) {
      throw new Error(`No model configured for role ${request.role}.`);
    }

    const controller = this.config.timeoutMs > 0 ? new AbortController() : undefined;
    return withModelTimeout(async () => {
      const response = await fetch(`${this.normalizeBaseUrl(baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        signal: controller?.signal,
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `${request.system}\nReturn valid JSON only. ${request.schemaHint}` },
            { role: "user", content: request.user },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Model request failed: ${response.status} ${await response.text()}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("Model returned an empty response.");
      }
      return JSON.parse(extractJson(content)) as T;
    }, this.config.timeoutMs, () => controller?.abort(), `Model request (${request.role})`);
  }

  /**
   * Run a chat completion with tool-use enabled. Returns the model's tool calls
   * or final assistant content. The caller is responsible for executing tool
   * calls, appending the results as tool messages, and looping.
   */
  async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    if (!this.config.apiKey || !this.config.baseUrl) {
      throw new Error("Model is not configured.");
    }

    const apiKey = this.config.apiKey;
    const baseUrl = this.config.baseUrl;
    const model = this.config.roleModels[request.role] ?? this.config.modelName;
    if (!model) {
      throw new Error(`No model configured for role ${request.role}.`);
    }

    const timeoutMs = typeof request.timeoutMs === "number" ? request.timeoutMs : this.config.timeoutMs;
    const controller = timeoutMs > 0 ? new AbortController() : undefined;

    const body: Record<string, unknown> = {
      model,
      temperature: request.temperature ?? 0,
      messages: request.messages.map(toOpenAIMessage),
      tools: request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: request.forceToolUse ? "required" : "auto",
    };
    if (typeof request.maxTokens === "number") {
      body.max_tokens = request.maxTokens;
    }

    return withModelTimeout(async () => {
      const response = await fetch(`${this.normalizeBaseUrl(baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        signal: controller?.signal,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Model tool-use request failed: ${response.status} ${await response.text()}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const choice = payload.choices?.[0];
      const content = choice?.message?.content ?? "";
      const toolCalls = (choice?.message?.tool_calls ?? [])
        .filter((call) => call.type === "function" && call.function?.name)
        .map((call, index) => ({
          id: call.id ?? `call_${index}`,
          name: call.function!.name!,
          arguments: call.function!.arguments ?? "{}",
        }));
      return {
        content,
        toolCalls,
        finishReason: choice?.finish_reason,
      };
    }, timeoutMs, () => controller?.abort(), `Model tool-use request (${request.role})`);
  }

  private normalizeBaseUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "");
    if (normalized.endsWith("/chat/completions")) {
      return normalized.slice(0, -"/chat/completions".length);
    }
    if (normalized.endsWith("/v1")) {
      return normalized;
    }
    return `${normalized}/v1`;
  }
}

async function withModelTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  abort: () => void,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation();
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          abort();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function toOpenAIMessage(message: LLMMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.toolName,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    const result: Record<string, unknown> = { role: "assistant", content: message.content ?? "" };
    if (message.toolCalls?.length) {
      result.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return result;
  }
  return { role: message.role, content: message.content };
}

export function extractJson(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return trimmed;
}
