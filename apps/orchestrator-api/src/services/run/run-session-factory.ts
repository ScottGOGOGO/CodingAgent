import { randomUUID } from "node:crypto";

import type { AgentSessionState, ProjectRecord, ReasoningMode, RunRecord, SessionRecord } from "@vide/contracts";

import { now } from "./run-state.js";

export function initialSessionState(projectId: string, sessionId: string, reasoningMode: ReasoningMode): AgentSessionState {
  return {
    sessionId,
    projectId,
    reasoningMode,
    messages: [],
    workingSpec: {},
    planSteps: [],
    fileChangeSummary: [],
    fileOperations: [],
    executionManifest: [],
    versionNumber: 0,
    assumptions: [],
    lastContextPaths: [],
    status: "draft",
  };
}

export function createSessionRecord(project: ProjectRecord, reasoningMode: ReasoningMode): SessionRecord {
  const createdAt = now();
  const sessionId = randomUUID();
  return {
    id: sessionId,
    projectId: project.id,
    reasoningMode,
    createdAt,
    updatedAt: createdAt,
    state: initialSessionState(project.id, sessionId, reasoningMode),
  };
}

export function newRun(project: ProjectRecord, session: SessionRecord, reasoningMode: ReasoningMode): RunRecord {
  const createdAt = now();
  return {
    id: randomUUID(),
    projectId: project.id,
    sessionId: session.id,
    reasoningMode,
    action: "turn",
    status: "in_progress",
    phase: "intake",
    createdAt,
    updatedAt: createdAt,
    state: session.state,
  };
}
