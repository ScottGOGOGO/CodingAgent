import test from "node:test";
import assert from "node:assert/strict";

import type { AgentSessionState, ProjectRecord, ReasoningMode } from "@vide/contracts";

import { AgentClient, resolveTransportTimeoutOptions } from "./agent-client.js";

function makeSessionState(): AgentSessionState {
  return {
    sessionId: "session-1",
    projectId: "project-1",
    reasoningMode: "plan_solve",
    messages: [],
    workingSpec: {},
    status: "draft",
    planSteps: [],
    fileChangeSummary: [],
    fileOperations: [],
    executionManifest: [],
    versionNumber: 0,
    assumptions: [],
    lastContextPaths: [],
  };
}

function makeProject(): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: "project-1",
    name: "Agent Client Test",
    createdAt: now,
    updatedAt: now,
    workspaceRoot: "/tmp/project-1",
    reasoningMode: "plan_solve",
    status: "draft",
    preview: {
      status: "idle",
      updatedAt: now,
    },
    session: makeSessionState(),
    currentSessionId: "session-1",
    versions: [],
  };
}

function makeFetchFailed(code: string, message = "fetch failed"): Error {
  const error = new TypeError(message) as Error & { cause?: unknown };
  error.cause = Object.assign(new Error(code), { code });
  return error;
}

test("resolveTransportTimeoutOptions disables Undici transport timeouts when timeout is disabled", () => {
  assert.deepEqual(resolveTransportTimeoutOptions(0), {
    headersTimeout: 0,
    bodyTimeout: 0,
  });
});

test("resolveTransportTimeoutOptions preserves timeoutMs plus transport buffer when enabled", () => {
  assert.deepEqual(resolveTransportTimeoutOptions(420_000), {
    headersTimeout: 425_000,
    bodyTimeout: 425_000,
  });
});

test("AgentClient retries once after a transient transport fetch failure", async () => {
  const client = new AgentClient("http://127.0.0.1:8001", 1_000, 0);
  const project = makeProject();
  const originalFetch = globalThis.fetch;

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      throw makeFetchFailed("ECONNRESET");
    }

    return new Response(
      JSON.stringify({
        state: {
          ...project.session,
          status: "clarifying",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await client.runTurn({
      project,
      reasoningMode: project.reasoningMode as ReasoningMode,
      workspaceSnapshot: [],
      userMessage: "帮我做一个旅行攻略",
    });

    assert.equal(attempts, 2);
    assert.equal(response.state.status, "clarifying");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AgentClient surfaces connection refused errors with a clear message", async () => {
  const client = new AgentClient("http://127.0.0.1:8001", 1_000, 0);
  const project = makeProject();
  const originalFetch = globalThis.fetch;

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw makeFetchFailed("ECONNREFUSED");
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        client.runTurn({
          project,
          reasoningMode: project.reasoningMode as ReasoningMode,
          workspaceSnapshot: [],
          userMessage: "帮我做一个旅行攻略",
        }),
      /无法连接本地 agent 服务/,
    );
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AgentClient surfaces timeout errors without retrying", async () => {
  const client = new AgentClient("http://127.0.0.1:8001", 2_000, 0);
  const project = makeProject();
  const originalFetch = globalThis.fetch;

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw new DOMException("The operation was aborted", "AbortError");
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        client.runTurn({
          project,
          reasoningMode: project.reasoningMode as ReasoningMode,
          workspaceSnapshot: [],
          userMessage: "帮我做一个旅行攻略",
        }),
      /在 2 秒内没有返回/,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AgentClient does not install a local abort window when timeout is disabled", async () => {
  const client = new AgentClient("http://127.0.0.1:8001", 0, 0);
  const project = makeProject();
  const originalFetch = globalThis.fetch;

  let aborted = false;
  globalThis.fetch = (async (_input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    aborted = init?.signal?.aborted ?? false;
    return new Response(
      JSON.stringify({
        state: {
          ...project.session,
          status: "clarifying",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await client.runTurn({
      project,
      reasoningMode: project.reasoningMode as ReasoningMode,
      workspaceSnapshot: [],
      userMessage: "帮我做一个旅行攻略",
    });

    assert.equal(response.state.status, "clarifying");
    assert.equal(aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
