#!/usr/bin/env node

import { buildClarificationAnswers, SMOKE_CASES } from "./smoke-cases.mjs";
import {
  api,
  assertProjectReady,
  classifyFailure,
  fetchProject,
  READY_TIMEOUT_MS,
  REASONING_MODE,
  summarizeProject,
  TURN_TIMEOUT_MS,
  waitForProject,
} from "./smoke-common.mjs";

const SMOKE_CASE = process.env.SMOKE_CASE?.trim();
const MAX_CLARIFICATION_ROUNDS = Number(process.env.SMOKE_MAX_CLARIFICATION_ROUNDS ?? 2);

async function completeClarification(projectId, initialProject, testCase) {
  let currentProject = initialProject;

  for (let round = 1; round <= MAX_CLARIFICATION_ROUNDS; round += 1) {
    if (currentProject.status !== "clarifying") {
      return currentProject;
    }

    const questions = currentProject.session?.clarificationDecision?.questions ?? [];
    const clarificationAnswers = buildClarificationAnswers(questions);
    if (!clarificationAnswers.length) {
      throw new Error(`Clarifying project ${projectId} returned no questions to answer.`);
    }

    console.log(
      JSON.stringify(
        summarizeProject("clarification_round_start", testCase.name, currentProject, {
          round,
          questionCount: clarificationAnswers.length,
        }),
        null,
        2,
      ),
    );

    await api("POST", `/projects/${projectId}/messages`, {
      clarificationAnswers,
      reasoningMode: REASONING_MODE,
    });

    currentProject = await waitForProject(
      projectId,
      new Set(["clarifying", "awaiting_approval", "failed"]),
      TURN_TIMEOUT_MS,
    );

    console.log(JSON.stringify(summarizeProject("after_clarification_round", testCase.name, currentProject, { round }), null, 2));
  }

  return currentProject;
}

async function runCase(testCase) {
  let projectId = null;

  try {
    const created = await api("POST", "/projects", {
      name: testCase.name,
      reasoningMode: REASONING_MODE,
    });
    projectId = created.project.id;
    console.log(`created ${testCase.name} project_id=${projectId}`);

    await api("POST", `/projects/${projectId}/messages`, {
      content: testCase.prompt,
      reasoningMode: REASONING_MODE,
    });

    const initialProject = await waitForProject(
      projectId,
      new Set(["awaiting_approval", "failed", "clarifying"]),
      TURN_TIMEOUT_MS,
    );
    console.log(JSON.stringify(summarizeProject("after_turn", testCase.name, initialProject), null, 2));

    if (initialProject.status !== testCase.expectedInitialStatus) {
      return summarizeProject("after_turn", testCase.name, initialProject, {
        expectedInitialStatus: testCase.expectedInitialStatus,
        failureKind: classifyFailure(initialProject, "unexpected initial status"),
      });
    }

    const approvalProject =
      initialProject.status === "clarifying"
        ? await completeClarification(projectId, initialProject, testCase)
        : initialProject;

    if (approvalProject.status !== "awaiting_approval") {
      return summarizeProject("before_confirm", testCase.name, approvalProject, {
        expectedStatus: "awaiting_approval",
        failureKind: classifyFailure(approvalProject, "did not reach awaiting_approval"),
      });
    }

    const approved = await api("POST", `/projects/${projectId}/confirm`, {});
    const readyProject = await waitForProject(
      approved.project.id,
      new Set(["ready", "failed"]),
      READY_TIMEOUT_MS,
    );
    assertProjectReady(readyProject, testCase.name);
    console.log(JSON.stringify(summarizeProject("after_confirm", testCase.name, readyProject), null, 2));
    return summarizeProject("after_confirm", testCase.name, readyProject);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const project = projectId ? await fetchProject(projectId).catch(() => null) : null;
    if (project) {
      console.error(`FAILURE_PROJECT_${testCase.name}=${JSON.stringify(project, null, 2)}`);
      return summarizeProject("failed", testCase.name, project, {
        error: message,
        failureKind: classifyFailure(project, message),
      });
    }

    return {
      stage: "failed",
      name: testCase.name,
      projectId,
      status: "failed",
      previewStatus: "unknown",
      latestRunStatus: null,
      latestRunPhase: null,
      providerRoute: null,
      lastAssistantMessage: null,
      error: message,
      failureKind: "local_service_unreachable_or_timeout",
    };
  }
}

async function main() {
  const activeCases = SMOKE_CASE ? SMOKE_CASES.filter((testCase) => testCase.name === SMOKE_CASE) : SMOKE_CASES;
  if (!activeCases.length) {
    throw new Error(`Unknown SMOKE_CASE: ${SMOKE_CASE}`);
  }

  const results = [];
  for (const testCase of activeCases) {
    results.push(await runCase(testCase));
  }

  console.log(`FINAL_RESULTS=${JSON.stringify(results)}`);
  const hasFailure = results.some((result) => result.status !== "ready" || result.previewStatus !== "ready");
  process.exitCode = hasFailure ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
