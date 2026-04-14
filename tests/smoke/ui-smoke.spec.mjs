import { expect, test } from "@playwright/test";

import { buildClarificationReplyText, SMOKE_CASES } from "../../scripts/smoke-cases.mjs";
import {
  API_BASE,
  assertProjectReady,
  classifyFailure,
  POLL_INTERVAL_MS,
  READY_TIMEOUT_MS,
  summarizeProject,
  TURN_TIMEOUT_MS,
} from "../../scripts/smoke-common.mjs";

const STATUS_LABELS = {
  clarifying: "Needs details",
  awaiting_approval: "Awaiting approval",
  ready: "Preview live",
};

const MAX_CLARIFICATION_ROUNDS = Number(process.env.SMOKE_MAX_CLARIFICATION_ROUNDS ?? 2);
const TEST_TIMEOUT_MS = Number(process.env.SMOKE_UI_TEST_TIMEOUT_MS ?? TURN_TIMEOUT_MS + READY_TIMEOUT_MS + 120000);

test.describe.configure({ mode: "serial" });

async function fetchProjectSnapshot(request, projectId) {
  const response = await request.get(`${API_BASE}/projects/${projectId}`);
  if (!response.ok()) {
    throw new Error(`GET /projects/${projectId} failed with ${response.status()}: ${await response.text()}`);
  }
  const payload = await response.json();
  return payload.project;
}

async function waitForProjectStatus(request, projectId, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastProject = null;

  while (Date.now() < deadline) {
    lastProject = await fetchProjectSnapshot(request, projectId);
    console.log(
      JSON.stringify(
        summarizeProject("ui_poll", "poll", lastProject, {
          observedStatuses: Array.from(statuses),
        }),
        null,
        2,
      ),
    );
    if (statuses.has(lastProject.status)) {
      return lastProject;
    }
    await pageWait(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for ${Array.from(statuses).join(", ")} on ${projectId}. Last status=${lastProject?.status ?? "unknown"}`,
  );
}

function pageWait(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function attachDiagnostics(testInfo, request, page, projectId, caseName, stage, error) {
  const message = error instanceof Error ? error.message : String(error);

  if (projectId) {
    try {
      const project = await fetchProjectSnapshot(request, projectId);
      const summary = summarizeProject(stage, caseName, project, {
        error: message,
        failureKind: classifyFailure(project, message),
      });
      await testInfo.attach("project-summary.json", {
        body: Buffer.from(JSON.stringify(summary, null, 2)),
        contentType: "application/json",
      });
      await testInfo.attach("project-snapshot.json", {
        body: Buffer.from(JSON.stringify(project, null, 2)),
        contentType: "application/json",
      });
      console.error(JSON.stringify(summary, null, 2));
    } catch (snapshotError) {
      await testInfo.attach("project-snapshot-error.txt", {
        body: Buffer.from(snapshotError instanceof Error ? snapshotError.message : String(snapshotError)),
        contentType: "text/plain",
      });
    }
  }

  await testInfo.attach("ui-error.txt", {
    body: Buffer.from(message),
    contentType: "text/plain",
  });

  try {
    const html = await page.content();
    await testInfo.attach("page.html", {
      body: Buffer.from(html),
      contentType: "text/html",
    });
  } catch {
    // Ignore secondary capture failures.
  }
}

async function openPlayground(page) {
  const createProjectResponse = page.waitForResponse((response) => {
    try {
      const url = new URL(response.url());
      return url.pathname === "/projects" && response.request().method() === "POST";
    } catch {
      return false;
    }
  });

  await page.goto("/");
  const response = await createProjectResponse;
  const payload = await response.json();

  if (response.status() !== 201) {
    throw new Error(`Playground failed to create project: ${response.status()} ${JSON.stringify(payload)}`);
  }

  return payload.project.id;
}

async function sendComposerMessage(page, content) {
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeVisible();
  await composer.fill(content);
  await page.getByTestId("composer-send").click();
}

async function expectUiStatus(page, expectedLabel) {
  await expect
    .poll(async () => ((await page.getByTestId("project-status").textContent()) ?? "").trim(), {
      timeout: 15000,
    })
    .toBe(expectedLabel);
}

async function completeClarification(page, request, projectId, project, caseName) {
  let currentProject = project;

  for (let round = 1; round <= MAX_CLARIFICATION_ROUNDS; round += 1) {
    if (currentProject.status !== "clarifying") {
      return currentProject;
    }

    const questions = currentProject.session?.clarificationDecision?.questions ?? [];
    const replyText = buildClarificationReplyText(questions);
    await expectUiStatus(page, STATUS_LABELS.clarifying);
    await sendComposerMessage(page, replyText);

    currentProject = await waitForProjectStatus(
      request,
      projectId,
      new Set(["clarifying", "awaiting_approval", "failed"]),
      TURN_TIMEOUT_MS,
    );
    console.log(
      JSON.stringify(
        summarizeProject("ui_after_clarification_round", caseName, currentProject, {
          round,
          questionCount: questions.length,
        }),
        null,
        2,
      ),
    );
  }

  return currentProject;
}

async function runSmokeCase(page, request, testInfo, testCase) {
  let projectId = null;

  try {
    projectId = await openPlayground(page);
    await sendComposerMessage(page, testCase.prompt);

    const initialProject = await waitForProjectStatus(
      request,
      projectId,
      new Set(["clarifying", "awaiting_approval", "failed"]),
      TURN_TIMEOUT_MS,
    );
    console.log(JSON.stringify(summarizeProject("ui_after_turn", testCase.name, initialProject), null, 2));

    if (initialProject.status !== testCase.expectedInitialStatus) {
      throw new Error(
        `Expected initial status ${testCase.expectedInitialStatus}, received ${initialProject.status} for ${testCase.name}.`,
      );
    }

    let approvalProject =
      initialProject.status === "clarifying"
        ? await completeClarification(page, request, projectId, initialProject, testCase.name)
        : initialProject;

    if (approvalProject.status !== "awaiting_approval") {
      throw new Error(`Expected awaiting_approval before confirm, received ${approvalProject.status}.`);
    }

    await expectUiStatus(page, STATUS_LABELS.awaiting_approval);
    await expect(page.getByTestId("composer-send")).toHaveText("Confirm");
    await expect(page.getByTestId("composer-send")).toBeEnabled();
    await page.getByTestId("composer-send").click();

    const readyProject = await waitForProjectStatus(
      request,
      projectId,
      new Set(["ready", "failed"]),
      READY_TIMEOUT_MS,
    );
    assertProjectReady(readyProject, testCase.name);
    console.log(JSON.stringify(summarizeProject("ui_after_confirm", testCase.name, readyProject), null, 2));

    await expectUiStatus(page, STATUS_LABELS.ready);
    await expect(page.getByTestId("preview-badge")).toHaveText("ready");
    await expect(page.getByTestId("preview-frame")).toBeVisible();
    await expect(page.getByTestId("preview-frame")).toHaveAttribute("src", /http/);

    approvalProject = readyProject;
    return approvalProject;
  } catch (error) {
    await attachDiagnostics(testInfo, request, page, projectId, testCase.name, "ui_failed", error);
    throw error;
  }
}

for (const testCase of SMOKE_CASES) {
  test(`${testCase.name} reaches ready preview in Playground`, async ({ page, request }, testInfo) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await runSmokeCase(page, request, testInfo, testCase);
  });
}
