import test from "node:test";
import assert from "node:assert/strict";

import type { AgentSessionState, ProjectRecord, RunRecord } from "@vide/contracts";

import { CommandExecutionError } from "../../runner.js";
import { appendMessage, buildApproval, normalizeProjectStatus, summarizeRunFailure } from "./run-state.js";

function makeState(): AgentSessionState {
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
    name: "Demo",
    createdAt: now,
    updatedAt: now,
    workspaceRoot: "/tmp/demo",
    reasoningMode: "plan_solve",
    status: "draft",
    preview: {
      status: "idle",
      updatedAt: now,
    },
    currentSessionId: "session-1",
    session: makeState(),
    versions: [],
  };
}

function makeRun(state: AgentSessionState): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    projectId: "project-1",
    sessionId: "session-1",
    reasoningMode: "plan_solve",
    action: "turn",
    status: "awaiting_approval",
    phase: "report",
    createdAt: now,
    updatedAt: now,
    state,
  };
}

test("appendMessage records a trimmed chat turn", () => {
  const state = makeState();

  appendMessage(state, "assistant", "  Ready to review.  ");

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.role, "assistant");
  assert.equal(state.messages[0]?.content, "Ready to review.");
  assert.ok(state.messages[0]?.id);
  assert.ok(state.messages[0]?.createdAt);
});

test("buildApproval uses the assistant summary and expiry window", () => {
  const project = makeProject();
  const state = makeState();
  state.assistantSummary = "Review the proposed app changes.";
  const run = makeRun(state);

  const approval = buildApproval(project, run);

  assert.equal(approval.projectId, project.id);
  assert.equal(approval.runId, run.id);
  assert.equal(approval.summary, "Review the proposed app changes.");
  assert.ok(approval.createdAt);
  assert.ok(approval.expiresAt);
});

test("normalizeProjectStatus maps error states to failed", () => {
  assert.equal(normalizeProjectStatus("error"), "failed");
  assert.equal(normalizeProjectStatus("awaiting_approval"), "awaiting_approval");
});

test("summarizeRunFailure includes useful build output context", () => {
  const error = new CommandExecutionError(
    ["npm", "run", "build"],
    [
      "> demo@0.0.0 build",
      "> vite build",
      "error during build:",
      "Unexpected end of JSON input while parsing near '\"references\": [{\"path'",
      "failed to load /tmp/demo/tsconfig.json",
    ].join("\n"),
  );

  const message = summarizeRunFailure(error);

  assert.match(message, /npm run build 失败/);
  assert.match(message, /Unexpected end of JSON input/);
  assert.match(message, /tsconfig\.json/);
});

test("summarizeRunFailure falls back to a plain error message", () => {
  assert.equal(summarizeRunFailure(new Error("index.html 看起来不完整或已被截断。")), "index.html 看起来不完整或已被截断。");
});
