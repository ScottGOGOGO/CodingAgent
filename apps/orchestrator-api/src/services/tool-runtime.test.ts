import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ModelClient,
  SandboxWorkspace,
  createDefaultToolRegistry,
  type ChatWithToolsRequest,
  type ChatWithToolsResponse,
  type ToolExecutionContext,
} from "@vide/agent-runtime";
import type { ToolCallTrace } from "@vide/contracts";

import { BoundedSubAgentRunner, SafeWebToolAdapter, createToolRuntimeAdapters } from "./tool-runtime.js";

function response(text: string, init?: ResponseInit): Response {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

test("tool runtime keeps network tools disabled by default", () => {
  const model = new ModelClient({ provider: "test", timeoutMs: 1000, maxTurns: 1, agentMaxToolCallsPerTurn: 1, agentMaxToolCallsTotal: 1, buildAttempts: 1, previewPortBase: 4173, roleModels: {} });
  const runtime = createToolRuntimeAdapters({ model, env: {} });

  assert.equal(runtime.webAdapter, undefined);
  assert.equal(runtime.capabilities?.network, false);
  assert.equal(runtime.policy?.allowNetwork, false);
  assert(runtime.policy?.deniedTools?.includes("web_fetch"));
  assert(runtime.policy?.deniedTools?.includes("web_search"));
});

test("safe web adapter fetches and parses search results through injected fetch", async () => {
  const requestedUrls: string[] = [];
  const adapter = new SafeWebToolAdapter({
    allowPrivateNetwork: true,
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes("duckduckgo.com")) {
        return response(`
          <div class="result">
            <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
            <div class="result__snippet">Useful documentation snippet.</div>
          </div>
        `);
      }
      return response("hello web", { headers: { "content-type": "text/plain" } });
    },
  });

  const fetched = await adapter.fetch({ url: "https://example.com/page" });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.text, "hello web");

  const search = await adapter.search({ query: "agent tools", limit: 1 });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0]?.title, "Example Docs");
  assert.equal(search.results[0]?.url, "https://example.com/docs");
  assert.equal(requestedUrls.length, 2);
});

test("safe web adapter blocks private hosts unless explicitly allowed", async () => {
  const adapter = new SafeWebToolAdapter({
    fetchImpl: async () => response("should not fetch"),
  });

  await assert.rejects(
    adapter.fetch({ url: "http://127.0.0.1:5173/" }),
    /Private IP is not allowed|Private host is not allowed/,
  );
});

test("safe web adapter allows benchmark-net DNS mappings used by local network proxies", async () => {
  const adapter = new SafeWebToolAdapter({
    fetchImpl: async () => response("proxied internet"),
    lookupHost: async () => ["198.18.8.49"],
  });

  const fetched = await adapter.fetch({ url: "https://example.com" });

  assert.equal(fetched.status, 200);
  assert.equal(fetched.text, "proxied internet");
});

test("bounded sub-agent runner executes only the filtered tool catalog", async () => {
  const model = new ScriptedToolModel([
    {
      content: "",
      toolCalls: [
        { id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) },
        { id: "call-2", name: "write_file", arguments: JSON.stringify({ path: "blocked.txt", content: "nope" }) },
      ],
      finishReason: "tool_calls",
    },
    {
      content: "Read notes.txt and confirmed the seed content.",
      toolCalls: [],
      finishReason: "stop",
    },
  ]);
  const registry = createDefaultToolRegistry();
  const root = await mkdtemp(join(tmpdir(), "vide-subagent-"));
  const sandbox = await SandboxWorkspace.create(root, "run-1");
  await sandbox.writeFile("notes.txt", "seed content");

  const traces: ToolCallTrace[] = [];
  const context: ToolExecutionContext = {
    runId: "run-1",
    workspace: sandbox,
    registry,
    policy: {
      allowedPermissions: ["read", "collaborate"],
      allowedSideEffects: ["none"],
      allowedRiskLevels: ["low"],
      allowedTools: ["read_file", "write_file"],
    },
    capabilities: {},
    emitTrace: (trace: ToolCallTrace) => traces.push(trace),
    emitLog: () => undefined,
  };
  const runner = new BoundedSubAgentRunner(model, {
    maxTurns: 3,
    maxToolCallsPerTurn: 4,
    maxToolCallsTotal: 6,
    modelTurnTimeoutMs: 1000,
  });

  const taskRecord = {
    id: "task-1",
    title: "Inspect notes",
    status: "running" as const,
    agentType: "context_scout",
    input: {},
    artifactIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [],
  };
  const result = await runner.run({
    task: taskRecord,
    prompt: "Read notes.txt.",
    agentType: "context_scout",
    allowedTools: ["read_file", "write_file"],
    context,
  });

  assert.equal(result.status, "completed");
  assert.match(result.outputSummary, /confirmed/);
  assert.equal(model.seenTools[0]?.includes("read_file"), true);
  assert.equal(model.seenTools[0]?.includes("write_file"), false);
  assert(traces.some((trace) => trace.toolName === "read_file" && trace.status === "completed"));
  assert(result.messages?.some((message) => message.includes("blocked write_file")));
});

class ScriptedToolModel extends ModelClient {
  public readonly seenTools: string[][] = [];
  private index = 0;

  constructor(private readonly responses: ChatWithToolsResponse[]) {
    super({
      provider: "test",
      apiKey: "test",
      baseUrl: "http://model.local",
      modelName: "test",
      timeoutMs: 1000,
      maxTurns: 1,
      agentMaxToolCallsPerTurn: 1,
      agentMaxToolCallsTotal: 1,
      buildAttempts: 1,
      previewPortBase: 4173,
      roleModels: {},
    });
  }

  override get configured(): boolean {
    return true;
  }

  override async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
    this.seenTools.push(request.tools.map((tool) => tool.name));
    return this.responses[this.index++] ?? { content: "done", toolCalls: [] };
  }

  override async generateJson<T>(): Promise<T> {
    throw new Error("not used");
  }
}
