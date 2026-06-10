import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ModelClient,
  type LLMMessage,
  type LLMToolCallRequest,
  type LLMToolDescriptor,
  type McpResourceSummary,
  type McpToolAdapter,
  type SubAgentRunRequest,
  type SubAgentRunResult,
  type SubAgentRunner,
  type ToolExecutionContext,
  type ToolRegistry,
  type ToolRuntimeAdapters,
  type WebFetchRequest,
  type WebFetchResult,
  type WebSearchResultItem,
  type WebToolAdapter,
} from "@vide/agent-runtime";

type FetchLike = typeof fetch;
type LookupHost = (hostname: string) => Promise<string[]>;

interface EnvLike {
  [key: string]: string | undefined;
}

export interface ToolRuntimeFactoryOptions {
  model: ModelClient;
  env?: EnvLike;
  fetchImpl?: FetchLike;
}

export function createToolRuntimeAdapters(options: ToolRuntimeFactoryOptions): ToolRuntimeAdapters {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const networkEnabled = booleanEnv(env, "AGENT_ENABLE_NETWORK_TOOLS", false);
  const subAgentsEnabled = booleanEnv(env, "AGENT_ENABLE_SUBAGENTS", true);

  const webAdapter = networkEnabled
    ? new SafeWebToolAdapter({
        fetchImpl,
        allowPrivateNetwork: booleanEnv(env, "AGENT_WEB_ALLOW_PRIVATE_NETWORK", false),
        allowedHosts: listEnv(env, "AGENT_WEB_ALLOWED_HOSTS"),
        blockedHosts: listEnv(env, "AGENT_WEB_BLOCKED_HOSTS"),
        maxResponseBytes: numberEnv(env, "AGENT_WEB_MAX_RESPONSE_BYTES", 160_000),
        timeoutMs: numberEnv(env, "AGENT_WEB_TIMEOUT_MS", 30_000),
      })
    : undefined;
  const mcpAdapter = createManifestMcpAdapterFromEnv(env, fetchImpl, webAdapter);
  const subAgentRunner = subAgentsEnabled
    ? new BoundedSubAgentRunner(options.model, {
        maxTurns: numberEnv(env, "AGENT_SUBAGENT_MAX_TURNS", 4),
        maxToolCallsPerTurn: numberEnv(env, "AGENT_SUBAGENT_MAX_TOOL_CALLS_PER_TURN", 4),
        maxToolCallsTotal: numberEnv(env, "AGENT_SUBAGENT_MAX_TOOL_CALLS_TOTAL", 12),
        modelTurnTimeoutMs: numberEnv(env, "AGENT_SUBAGENT_MODEL_TURN_TIMEOUT_MS", 60_000),
      })
    : undefined;

  const deniedTools = [
    ...(webAdapter ? [] : ["web_fetch", "web_search"]),
    ...(mcpAdapter ? [] : ["list_mcp_resources", "read_mcp_resource"]),
    ...(subAgentRunner ? [] : ["agent_tool"]),
  ];

  return {
    webAdapter,
    mcpAdapter,
    subAgentRunner,
    planMode: { active: false },
    capabilities: {
      network: Boolean(webAdapter),
      mcp: Boolean(mcpAdapter),
      subagents: Boolean(subAgentRunner),
    },
    policy: {
      allowedPermissions: webAdapter
        ? ["read", "write", "execute", "network", "collaborate"]
        : ["read", "write", "execute", "collaborate"],
      allowedSideEffects: webAdapter
        ? ["none", "workspace", "process", "network"]
        : ["none", "workspace", "process"],
      allowedRiskLevels: ["low", "medium", "high"],
      allowNetwork: Boolean(webAdapter),
      allowExternal: false,
      sandboxOnly: false,
      deniedTools,
    },
  };
}

export class SafeWebToolAdapter implements WebToolAdapter {
  constructor(
    private readonly options: {
      fetchImpl?: FetchLike;
      allowedHosts?: string[];
      blockedHosts?: string[];
      allowPrivateNetwork?: boolean;
      lookupHost?: LookupHost;
      maxResponseBytes?: number;
      timeoutMs?: number;
    } = {},
  ) {}

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    const url = await this.assertSafeUrl(request.url);
    const timeoutMs = Math.max(1, Math.min(request.timeoutMs ?? this.options.timeoutMs ?? 30_000, 120_000));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        method: request.method ?? "GET",
        headers: sanitizeRequestHeaders(request.headers),
        body: request.method === "POST" ? request.body : undefined,
        signal: controller.signal,
        redirect: "follow",
      });
      const text = await readResponseText(response, this.options.maxResponseBytes ?? 160_000);
      return {
        url: response.url || url,
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        text,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async search(request: { query: string; limit: number }): Promise<{ query: string; results: WebSearchResultItem[] }> {
    const limit = Math.max(1, Math.min(request.limit, 10));
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`;
    const response = await this.fetch({
      url,
      method: "GET",
      headers: { accept: "text/html" },
    });
    return {
      query: request.query,
      results: parseDuckDuckGoHtml(response.text).slice(0, limit),
    };
  }

  private async assertSafeUrl(rawUrl: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid URL: ${rawUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }
    const hostname = parsed.hostname.toLowerCase();
    const allowedHosts = this.options.allowedHosts ?? [];
    const blockedHosts = this.options.blockedHosts ?? [];
    if (hostMatches(hostname, blockedHosts)) {
      throw new Error(`Host is blocked for web tools: ${hostname}`);
    }
    if (allowedHosts.length > 0 && !hostMatches(hostname, allowedHosts)) {
      throw new Error(`Host is not in AGENT_WEB_ALLOWED_HOSTS: ${hostname}`);
    }
    if (!this.options.allowPrivateNetwork) {
      await assertPublicHost(hostname, this.options.lookupHost);
    }
    return parsed.toString();
  }
}

export class BoundedSubAgentRunner implements SubAgentRunner {
  constructor(
    private readonly model: ModelClient,
    private readonly options: {
      maxTurns: number;
      maxToolCallsPerTurn: number;
      maxToolCallsTotal: number;
      modelTurnTimeoutMs: number;
    },
  ) {}

  async run(request: SubAgentRunRequest): Promise<SubAgentRunResult> {
    if (!this.model.configured) {
      return {
        status: "blocked",
        outputSummary: "Sub-agent model is not configured.",
        messages: ["Sub-agent model is not configured."],
      };
    }

    const registry = request.context.registry;
    if (!registry) {
      return {
        status: "blocked",
        outputSummary: "Tool registry is not available in the sub-agent context.",
        messages: ["Tool registry is not available in the sub-agent context."],
      };
    }

    const subContext = createSubAgentContext(request, registry);
    const tools = registry.getCatalog(subContext).map((manifest) => toToolDescriptor(registry, manifest));
    const activeToolIds = tools.map((tool) => tool.name);
    if (!tools.length) {
      return {
        status: "blocked",
        outputSummary: "No tools are available to this sub-agent after policy filtering.",
        messages: [`Requested tools: ${request.allowedTools.join(", ") || "(none)"}`],
      };
    }

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: [
          "You are a bounded sub-agent working inside a larger product-generation run.",
          "Use only the tools provided to you. Do not request broader permissions.",
          "Return a concise final summary with findings, files touched, and any blockers.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Task: ${request.task.title}`,
          `Agent type: ${request.agentType}`,
          `Allowed tools: ${request.allowedTools.join(", ") || "(none)"}`,
          "",
          request.prompt,
        ].join("\n"),
      },
    ];

    const logs: string[] = [];
    let toolCallCount = 0;
    let finalContent = "";

    for (let turn = 0; turn < this.options.maxTurns; turn += 1) {
      const response = await this.model.chatWithTools({
        role: "coder",
        messages,
        tools,
        forceToolUse: false,
        temperature: 0,
        maxTokens: 1600,
        timeoutMs: this.options.modelTurnTimeoutMs,
      });
      finalContent = response.content?.trim() ?? finalContent;
      if (!response.toolCalls.length) {
        if (finalContent) {
          logs.push(`final: ${finalContent}`);
        }
        return {
          status: "completed",
          outputSummary: finalContent || "Sub-agent completed without additional output.",
          messages: logs,
        };
      }

      messages.push({
        role: "assistant",
        content: response.content || undefined,
        toolCalls: response.toolCalls,
      });

      for (const call of response.toolCalls.slice(0, this.options.maxToolCallsPerTurn)) {
        if (toolCallCount >= this.options.maxToolCallsTotal) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: `Sub-agent tool-call budget exhausted (${this.options.maxToolCallsTotal}).`,
          });
          logs.push("budget exhausted");
          continue;
        }
        toolCallCount += 1;
        const toolResult = await executeSubAgentTool(call, registry, subContext, activeToolIds);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: toolResult.content,
        });
        logs.push(toolResult.log);
      }
    }

    return {
      status: finalContent ? "completed" : "blocked",
      outputSummary: finalContent || `Sub-agent stopped after ${this.options.maxTurns} turns without a final summary.`,
      messages: logs,
    };
  }
}

function createManifestMcpAdapterFromEnv(env: EnvLike, fetchImpl: FetchLike, webAdapter?: WebToolAdapter): McpToolAdapter | undefined {
  const manifest = env.AGENT_MCP_RESOURCE_MANIFEST?.trim();
  if (!manifest) {
    return undefined;
  }
  return new ManifestMcpToolAdapter(manifest, fetchImpl, webAdapter);
}

class ManifestMcpToolAdapter implements McpToolAdapter {
  private cache?: { resources: ManifestResource[]; baseDir?: string };

  constructor(
    private readonly manifestLocation: string,
    private readonly fetchImpl: FetchLike,
    private readonly webAdapter?: WebToolAdapter,
  ) {}

  async listResources(): Promise<McpResourceSummary[]> {
    const manifest = await this.loadManifest();
    return manifest.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
  }

  async readResource(uri: string): Promise<{ uri: string; text?: string; blobBase64?: string; mimeType?: string }> {
    const manifest = await this.loadManifest();
    const resource = manifest.resources.find((item) => item.uri === uri);
    if (!resource) {
      throw new Error(`Unknown MCP resource: ${uri}`);
    }
    if (typeof resource.text === "string") {
      return { uri, text: resource.text, mimeType: resource.mimeType };
    }
    if (typeof resource.blobBase64 === "string") {
      return { uri, blobBase64: resource.blobBase64, mimeType: resource.mimeType };
    }
    if (typeof resource.path === "string") {
      const baseDir = manifest.baseDir ?? process.cwd();
      const path = isAbsolute(resource.path) ? resource.path : resolve(baseDir, resource.path);
      if (!path.startsWith(baseDir) && !isAbsolute(resource.path)) {
        throw new Error(`MCP resource path escapes manifest directory: ${resource.path}`);
      }
      return { uri, text: await readFile(path, "utf-8"), mimeType: resource.mimeType };
    }
    if (typeof resource.url === "string") {
      if (this.webAdapter) {
        const fetched = await this.webAdapter.fetch({ url: resource.url });
        return { uri, text: fetched.text, mimeType: fetched.contentType ?? resource.mimeType };
      }
      const fetched = await this.fetchImpl(resource.url);
      return { uri, text: await fetched.text(), mimeType: fetched.headers.get("content-type") ?? resource.mimeType };
    }
    return { uri, text: "", mimeType: resource.mimeType };
  }

  private async loadManifest(): Promise<{ resources: ManifestResource[]; baseDir?: string }> {
    if (this.cache) {
      return this.cache;
    }
    let text: string;
    let baseDir: string | undefined;
    if (/^https?:\/\//i.test(this.manifestLocation)) {
      const response = await this.fetchImpl(this.manifestLocation);
      if (!response.ok) {
        throw new Error(`Failed to load MCP resource manifest: ${response.status}`);
      }
      text = await response.text();
    } else {
      const path = this.manifestLocation.startsWith("file:")
        ? fileURLToPath(this.manifestLocation)
        : resolve(process.cwd(), this.manifestLocation);
      text = await readFile(path, "utf-8");
      baseDir = dirname(path);
    }
    const parsed = JSON.parse(text) as { resources?: ManifestResource[] };
    this.cache = {
      resources: Array.isArray(parsed.resources) ? parsed.resources.filter(isManifestResource) : [],
      baseDir,
    };
    return this.cache;
  }
}

interface ManifestResource extends McpResourceSummary {
  text?: string;
  blobBase64?: string;
  path?: string;
  url?: string;
}

function isManifestResource(value: unknown): value is ManifestResource {
  return Boolean(value && typeof value === "object" && typeof (value as ManifestResource).uri === "string");
}

async function executeSubAgentTool(
  call: LLMToolCallRequest,
  registry: ToolRegistry,
  context: ToolExecutionContext,
  allowedTools: string[],
): Promise<{ content: string; log: string }> {
  if (!allowedTools.includes(call.name)) {
    return {
      content: `Tool is not allowed for this sub-agent: ${call.name}`,
      log: `blocked ${call.name}: not allowed`,
    };
  }
  try {
    const output = await registry.execute(call.name, parseToolArgs(call.arguments), context);
    return {
      content: formatToolOutput(output),
      log: `tool ${call.name}: ok`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `Tool error (${call.name}): ${message}`,
      log: `tool ${call.name}: ${message}`,
    };
  }
}

function createSubAgentContext(request: SubAgentRunRequest, registry: ToolRegistry): ToolExecutionContext {
  const deniedTools = new Set([...(request.context.policy?.deniedTools ?? []), "agent_tool"]);
  return {
    ...request.context,
    registry,
    currentTaskId: request.task.id,
    policy: {
      ...request.context.policy,
      allowedTools: request.allowedTools,
      deniedTools: [...deniedTools],
    },
  };
}

function toToolDescriptor(registry: ToolRegistry, manifest: { id: string; inputSchema: Record<string, unknown> }): LLMToolDescriptor {
  const tool = registry.get(manifest.id);
  return {
    name: manifest.id,
    description: tool.description,
    inputSchema: manifest.inputSchema,
  };
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function formatToolOutput(output: unknown): string {
  if (output === undefined || output === null) {
    return "ok";
  }
  if (typeof output === "string") {
    return capText(output, 12_000);
  }
  try {
    return capText(JSON.stringify(output, null, 2), 12_000);
  } catch {
    return capText(String(output), 12_000);
  }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new Error(`Response is too large for web tools: ${contentLength} bytes.`);
  }
  if (!response.body) {
    return capText(await response.text(), maxBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Response exceeded web tool limit: ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(concatBytes(chunks, total));
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function sanitizeRequestHeaders(headers?: Record<string, string>): Headers {
  const sanitized = new Headers();
  sanitized.set("accept", headers?.accept ?? headers?.Accept ?? "text/html,application/json,text/plain;q=0.9,*/*;q=0.5");
  sanitized.set("user-agent", headers?.["user-agent"] ?? headers?.["User-Agent"] ?? "VideAgentTools/1.0");
  const contentType = headers?.["content-type"] ?? headers?.["Content-Type"];
  if (contentType) {
    sanitized.set("content-type", contentType);
  }
  return sanitized;
}

async function assertPublicHost(hostname: string, lookupHost: LookupHost = defaultLookupHost): Promise<void> {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Private host is not allowed for web tools: ${hostname}`);
  }
  const literalIp = isIP(hostname) ? hostname : undefined;
  if (literalIp) {
    if (isPrivateIp(literalIp)) {
      throw new Error(`Private IP is not allowed for web tools: ${hostname}`);
    }
    return;
  }
  const addresses = await lookupHost(hostname);
  if (addresses.some((address) => isPrivateIp(address))) {
    throw new Error(`Host resolves to a private network address: ${hostname}`);
  }
}

async function defaultLookupHost(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((address) => address.address);
}

function isPrivateIp(address: string): boolean {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  const parts = address.split(".").map((part) => Number(part));
  const [first, second] = parts;
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168 ||
    first === 100 && second >= 64 && second <= 127
  );
}

function hostMatches(hostname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(1);
      return hostname.endsWith(suffix);
    }
    return hostname === normalized;
  });
}

function parseDuckDuckGoHtml(html: string): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*result[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const anchor = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) {
      continue;
    }
    const snippet = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({
      title: decodeHtml(stripTags(anchor[2] ?? "")),
      url: unwrapDuckDuckGoUrl(decodeHtml(anchor[1] ?? "")),
      snippet: decodeHtml(stripTags(snippet?.[1] ?? snippet?.[2] ?? "")) || undefined,
    });
  }
  return results.filter((result) => result.title && result.url);
}

function unwrapDuckDuckGoUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return url;
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

function capText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n/* truncated, total length ${value.length} chars */` : value;
}

function booleanEnv(env: EnvLike, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined) {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function numberEnv(env: EnvLike, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function listEnv(env: EnvLike, key: string): string[] {
  return (env[key] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
