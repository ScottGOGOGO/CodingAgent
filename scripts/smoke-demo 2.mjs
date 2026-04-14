#!/usr/bin/env node

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:4100";
const REASONING_MODE = process.env.REASONING_MODE ?? "plan_solve";
const POLL_INTERVAL_MS = Number(process.env.SMOKE_POLL_INTERVAL_MS ?? 3000);
const TURN_TIMEOUT_MS = Number(process.env.SMOKE_TURN_TIMEOUT_MS ?? 420000);
const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 420000);
const SMOKE_CASE = process.env.SMOKE_CASE?.trim();

const CASES = [
  {
    name: "compat-user-message",
    body: {
      userMessage: "帮我生成一个面向中国大学生的校园二手交易 web 应用，需要商品发布、即时聊天、信用评分、订单管理和举报申诉。",
      reasoningMode: REASONING_MODE,
    },
  },
  {
    name: "ui-content-message",
    body: {
      content: "帮我生成一个针对零基础初学者的网球自学计划应用，面向18岁零基础用户，需要视频教学、练习计划制定、进度跟踪、动作纠正和社区交流功能。",
      reasoningMode: REASONING_MODE,
    },
  },
];

async function api(method, path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
  }

  return response.json();
}

async function waitForProject(projectId, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const payload = await api("GET", `/projects/${projectId}`);
    const project = payload.project;
    const previewStatus = project.preview?.status ?? "unknown";
    console.log(`poll project=${projectId} status=${project.status} preview=${previewStatus}`);
    if (statuses.has(project.status)) {
      return project;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for ${Array.from(statuses).join(", ")} on ${projectId}`);
}

function summarizeProject(stage, name, project) {
  return {
    stage,
    name,
    projectId: project.id,
    status: project.status,
    preview: project.preview,
    messageCount: project.session?.messages?.length ?? 0,
    lastAssistantMessage:
      project.session?.messages?.length
        ? project.session.messages[project.session.messages.length - 1].content
        : null,
    fileOps: project.session?.fileOperations?.length ?? 0,
  };
}

async function runCase(testCase) {
  const created = await api("POST", "/projects", {
    name: testCase.name,
    reasoningMode: REASONING_MODE,
  });
  const projectId = created.project.id;
  console.log(`created ${testCase.name} project_id=${projectId}`);

  await api("POST", `/projects/${projectId}/messages`, testCase.body);
  const afterTurn = await waitForProject(projectId, new Set(["awaiting_approval", "failed", "clarifying"]), TURN_TIMEOUT_MS);
  console.log(JSON.stringify(summarizeProject("after_turn", testCase.name, afterTurn), null, 2));

  if (afterTurn.status !== "awaiting_approval") {
    return summarizeProject("after_turn", testCase.name, afterTurn);
  }

  const approved = await api("POST", `/projects/${projectId}/confirm`, {});
  const readyProject = await waitForProject(approved.project.id, new Set(["ready", "failed"]), READY_TIMEOUT_MS);
  console.log(JSON.stringify(summarizeProject("after_confirm", testCase.name, readyProject), null, 2));
  return summarizeProject("after_confirm", testCase.name, readyProject);
}

async function main() {
  const activeCases = SMOKE_CASE ? CASES.filter((testCase) => testCase.name === SMOKE_CASE) : CASES;
  if (!activeCases.length) {
    throw new Error(`Unknown SMOKE_CASE: ${SMOKE_CASE}`);
  }

  const results = [];

  for (const testCase of activeCases) {
    results.push(await runCase(testCase));
  }

  console.log(`FINAL_RESULTS=${JSON.stringify(results)}`);

  const hasFailure = results.some((result) => result.status !== "ready");
  process.exitCode = hasFailure ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
