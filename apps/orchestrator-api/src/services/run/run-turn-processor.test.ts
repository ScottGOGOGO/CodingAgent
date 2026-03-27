import test from "node:test";
import assert from "node:assert/strict";

import type { AgentSessionState, ProjectEvent, ProjectRecord, RunRecord, SessionRecord, WorkspaceFile } from "@vide/contracts";

import { RunTurnProcessor } from "./run-turn-processor.js";

function makeState(overrides: Partial<AgentSessionState> = {}): AgentSessionState {
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
    ...overrides,
  };
}

function makeSession(state: AgentSessionState): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: "session-1",
    projectId: "project-1",
    reasoningMode: "plan_solve",
    createdAt: now,
    updatedAt: now,
    state,
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
    status: "in_progress",
    phase: "intake",
    createdAt: now,
    updatedAt: now,
    state,
  };
}

function makeProject(state: AgentSessionState, run?: RunRecord): ProjectRecord {
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
    session: state,
    latestRun: run,
    versions: [],
  };
}

function makeProcessor(deps?: {
  responseState?: AgentSessionState;
  validationState?: AgentSessionState;
  agentError?: unknown;
  validationError?: unknown;
}) {
  const events: ProjectEvent[] = [];
  const approvals: object[] = [];
  const persists: Array<{ project: ProjectRecord; session: SessionRecord; run: RunRecord }> = [];
  const workspaceSnapshot: WorkspaceFile[] = [{ path: "package.json", content: "{}" }];

  const processor = new RunTurnProcessor(
    {
      async saveApproval(approval: object) {
        approvals.push(approval);
      },
    } as never,
    {
      async readWorkspaceSnapshot() {
        return workspaceSnapshot;
      },
    } as never,
    {
      async runTurn() {
        if (deps?.agentError) {
          throw deps.agentError;
        }
        return {
          state: deps?.responseState ?? makeState({ status: "ready", runPhase: "report" }),
        };
      },
    } as never,
    {
      async validate() {
        if (deps?.validationError) {
          throw deps.validationError;
        }
        return deps?.validationState ?? deps?.responseState ?? makeState({ status: "awaiting_approval", runPhase: "report" });
      },
    } as never,
    {
      async persist(project, session, run) {
        persists.push({ project, session, run });
      },
      publish(event) {
        events.push(event);
      },
    },
  );

  return { processor, events, approvals, persists };
}

test("RunTurnProcessor moves clarifying turns to awaiting_input", async () => {
  const responseState = makeState({ status: "clarifying", runPhase: "dynamic_clarify" });
  const { processor, events, approvals } = makeProcessor({ responseState });
  const session = makeSession(makeState());
  const run = makeRun(session.state);
  const project = makeProject(session.state, run);

  const result = await processor.processTurn(project, session, run, "Need a fitness app");

  assert.equal(result.run.status, "awaiting_input");
  assert.equal(result.project.status, "clarifying");
  assert.equal(approvals.length, 0);
  assert.deepEqual(events.map((event) => event.type), ["run.updated", "project.updated"]);
});

test("RunTurnProcessor requests approval after preflight validation succeeds", async () => {
  const responseState = makeState({
    status: "awaiting_approval",
    runPhase: "report",
    assistantSummary: "Ready for approval.",
  });
  const validatedState = makeState({
    ...responseState,
    fileOperations: [{ type: "write", path: "src/App.tsx", summary: "Write App", content: "export default function App() { return null; }" }],
  });
  const { processor, approvals, events } = makeProcessor({ responseState, validationState: validatedState });
  const session = makeSession(makeState());
  const run = makeRun(session.state);
  const project = makeProject(session.state, run);

  const result = await processor.processTurn(project, session, run, "Build a dashboard");

  assert.equal(result.run.status, "awaiting_approval");
  assert.equal(result.run.approvalRequest?.summary, "Ready for approval.");
  assert.equal(approvals.length, 1);
  assert.deepEqual(events.map((event) => event.type), ["run.approval_required", "project.updated"]);
});

test("RunTurnProcessor marks explicit agent failures as failed", async () => {
  const responseState = makeState({
    status: "failed",
    runPhase: "report",
    error: "The generated app is incomplete.",
  });
  const { processor, events } = makeProcessor({ responseState });
  const session = makeSession(makeState());
  const run = makeRun(session.state);
  const project = makeProject(session.state, run);

  const result = await processor.processTurn(project, session, run, "Build a shopping list");

  assert.equal(result.run.status, "failed");
  assert.equal(result.run.error, "The generated app is incomplete.");
  assert.equal(result.project.status, "failed");
  assert.deepEqual(events.map((event) => event.type), ["run.failed", "project.updated"]);
});

test("RunTurnProcessor captures agent transport failures", async () => {
  const { processor, events } = makeProcessor({ agentError: new Error("network timeout") });
  const session = makeSession(makeState());
  const run = makeRun(session.state);
  const project = makeProject(session.state, run);

  const result = await processor.processTurn(project, session, run, "Build a tennis planner");

  assert.equal(result.run.status, "failed");
  assert.equal(result.session.state.status, "failed");
  assert.match(result.session.state.assistantSummary ?? "", /生成失败：network timeout/);
  assert.equal(result.session.state.messages[0]?.role, "user");
  assert.equal(result.session.state.messages[1]?.role, "assistant");
  assert.deepEqual(events.map((event) => event.type), ["run.failed", "project.updated"]);
});

test("RunTurnProcessor reports proposal validation failures as resolved turn failures", async () => {
  const responseState = makeState({
    status: "awaiting_approval",
    runPhase: "report",
    assistantSummary: "Ready for approval.",
  });
  const { processor, events, approvals } = makeProcessor({
    responseState,
    validationError: new Error("index.html 看起来不完整或已被截断。"),
  });
  const session = makeSession(makeState());
  const run = makeRun(session.state);
  const project = makeProject(session.state, run);

  const result = await processor.processTurn(project, session, run, "Build a notes app");

  assert.equal(result.run.status, "failed");
  assert.equal(result.session.state.status, "failed");
  assert.match(result.session.state.assistantSummary ?? "", /生成失败：index\.html/);
  assert.equal(approvals.length, 0);
  assert.deepEqual(events.map((event) => event.type), ["run.failed", "project.updated"]);
});
