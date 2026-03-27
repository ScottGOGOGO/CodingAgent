import { randomUUID } from "node:crypto";

import type {
  AgentSessionState,
  ApprovalRequest,
  ClarificationAnswer,
  ProjectRecord,
  RunRecord,
} from "@vide/contracts";

import { CommandExecutionError } from "../../runner.js";

export function now(): string {
  return new Date().toISOString();
}

export function appendMessage(
  state: AgentSessionState,
  role: "user" | "assistant",
  content?: string,
): void {
  const normalized = content?.trim();
  if (!normalized) {
    return;
  }

  state.messages.push({
    id: randomUUID(),
    role,
    content: normalized,
    createdAt: now(),
  });
}

export function normalizeProjectStatus(status: ProjectRecord["status"] | AgentSessionState["status"]): ProjectRecord["status"] {
  return status === "error" ? "failed" : status;
}

export function decorateStateWithRun(sessionState: AgentSessionState, run: RunRecord): void {
  sessionState.run = {
    id: run.id,
    status: run.status,
    phase: run.phase,
    approvalRequest: run.approvalRequest,
    providerRoute: run.providerRoute,
    evaluation: run.evaluation,
    usage: run.usage,
    error: run.error,
  };
}

export function buildApproval(project: ProjectRecord, run: RunRecord): ApprovalRequest {
  return {
    runId: run.id,
    projectId: project.id,
    summary: run.state.assistantSummary ?? "Review the proposed changes before execution.",
    createdAt: now(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
  };
}

export function formatClarificationAnswers(
  sessionState: AgentSessionState,
  clarificationAnswers?: ClarificationAnswer[],
): string | undefined {
  if (!clarificationAnswers?.length) {
    return undefined;
  }

  const questionLookup = new Map(
    (sessionState.clarificationDecision?.questions ?? []).map((item) => [item.id, item.question]),
  );
  const lines = ["Additional clarification from the user:"];

  for (const answer of clarificationAnswers) {
    const normalized = answer.answer.trim();
    if (!normalized) {
      continue;
    }
    lines.push(`Question: ${questionLookup.get(answer.questionId) ?? answer.questionId}`);
    lines.push(`Answer: ${normalized}`);
  }

  return lines.length > 1 ? lines.join("\n") : undefined;
}

function extractFailureExcerpt(output: string): string | undefined {
  const cleanedLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^> /.test(line))
    .filter((line) => !/^npm (notice|warn)/i.test(line));

  if (!cleanedLines.length) {
    return undefined;
  }

  const interestingLines = cleanedLines.filter((line) =>
    /error|failed|unexpected|invalid|parse|syntax|cannot|missing|ts\d+|vite|rollup|json|html|index\.html|tsconfig/i.test(line),
  );
  const excerpt = (interestingLines.length ? interestingLines : cleanedLines).slice(-4).join(" | ");
  return excerpt.length > 420 ? `${excerpt.slice(0, 417)}...` : excerpt;
}

export function summarizeRunFailure(error: unknown): string {
  if (error instanceof CommandExecutionError) {
    const command = error.command.join(" ");
    const excerpt = extractFailureExcerpt(error.output);
    return excerpt ? `${command} 失败：${excerpt}` : `命令执行失败：${command}`;
  }

  if (error instanceof Error) {
    return error.message || "Unknown validation error";
  }

  return "Unknown validation error";
}
