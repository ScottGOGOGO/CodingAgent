import test from "node:test";
import assert from "node:assert/strict";

import {
  composeAgentCoderSystem,
  composeArchitectPrompt,
  composeCoderPrompt,
  composeDesignDirectorPrompt,
  composeRepairPrompt,
  composeVisualCriticPrompt,
} from "./prompt-composer.js";

test("composeCoderPrompt builds layered product-quality frontend instructions", () => {
  const prompt = composeCoderPrompt({
    userBrief: "帮我做一个旅游的 app",
    clarificationText: "core-feature: attractions",
    contextSummary: "Workspace files: 0",
    selectedFiles: "",
  });

  assert.equal(prompt.role, "coder");
  assert.match(prompt.system, /<frontend_design>/);
  assert.match(prompt.system, /Avoid generic AI demo aesthetics/);
  assert.match(prompt.system, /390px wide viewport/);
  assert.match(prompt.system, /The generated UI must be a real product surface/);
  assert.match(prompt.system, /Do not expose internal implementation details/);
  assert.match(prompt.system, /meaningful domain workflow/);
  assert.match(prompt.system, /Bloom Planner, My Season, or Brain Spin/);
  assert.match(prompt.system, /at least 4 product modules/);
  assert.match(prompt.system, /No TODO, lorem ipsum, coming soon/);
  assert.match(prompt.schemaHint, /"files"/);
});

test("composeDesignDirectorPrompt produces a structured mobile design brief contract", () => {
  const prompt = composeDesignDirectorPrompt({
    userBrief: "帮我做一个旅游的 app",
    clarificationText: "scene: city weekend",
    contextSummary: "Workspace files: 0",
  });

  assert.equal(prompt.role, "design_director");
  assert.match(prompt.system, /<frontend_design>/);
  assert.match(prompt.system, /390px iPhone viewport/);
  assert.match(prompt.system, /product screenplay/);
  assert.match(prompt.system, /Do not plan a technology showcase/);
  assert.match(prompt.system, /Bloom Planner, My Season, and Brain Spin/);
  assert.match(prompt.system, /signature interaction/);
  assert.match(prompt.schemaHint, /"visualDirection"/);
});

test("composeArchitectPrompt plans from user-visible product flows", () => {
  const prompt = composeArchitectPrompt({
    userBrief: "帮我做一个网球学习规划软件",
    clarificationText: "scene: beginner training",
    contextSummary: "Workspace files: 0",
    designBrief:
      "Summary: mobile tennis coaching planner\nTarget user: adult beginners\nProduct goal: create daily practice plans\nCore experience: choose a skill, log practice, review feedback",
  });

  assert.equal(prompt.role, "architect");
  assert.match(prompt.system, /Plan from user-visible product flows backwards/);
  assert.match(prompt.system, /Name at least two primary user flows/);
  assert.match(prompt.system, /app shell\/navigation/);
  assert.match(prompt.system, /externalCapabilities/);
  assert.match(prompt.system, /qualityChecks/);
  assert.match(prompt.schemaHint, /"qualityChecks"/);
  assert.match(prompt.schemaHint, /"externalCapabilities"/);
  assert.match(prompt.system, /Acceptance criteria must be user-visible flow outcomes/);
});

test("composeVisualCriticPrompt gates screenshot evidence against the design brief", () => {
  const prompt = composeVisualCriticPrompt({
    userBrief: "帮我做一个旅游的 app",
    clarificationText: "scene: city weekend",
    designBrief: "Visual direction: editorial mobile travel magazine",
    screenshotSummary: "Captured mobile screenshot at 390x844.",
    currentFiles: "--- src/app/page.tsx\nexport default function HomePage() { return <main /> }",
  });

  assert.equal(prompt.role, "visual_critic");
  assert.match(prompt.system, /<visual_evidence>/);
  assert.match(prompt.system, /Pass only if the score is 88 or higher/);
  assert.match(prompt.system, /tech demo, prompt summary, or HTML mockup/);
  assert.match(prompt.system, /compact app structure/);
  assert.match(prompt.system, /visible copy exposes internal implementation details/);
  assert.match(prompt.system, /Next\.js, App Router, React, Prisma/);
  assert.match(prompt.user, /Captured mobile screenshot/);
});

test("composeAgentCoderSystem forbids stack-explanation UI in the main model path", () => {
  const system = composeAgentCoderSystem({
    userBrief: "帮我做一个网球学习规划软件",
    clarificationText: "scene: beginner training",
    designBrief:
      "Summary: tennis learning planner\nTarget user: adult beginners\nCore experience: daily drills, practice logging, coach feedback",
    architecturePlan:
      "Tasks: implement curriculum, practice logging server action, progress dashboard, visual polish, build verification.",
    toolCatalog: "write_file, run_build, finish_app",
  });

  assert.match(system, /Build a usable product, not a visible explanation of the stack/);
  assert.match(system, /No visible copy may mention Next\.js/);
  assert.match(system, /curriculum\/progression/);
  assert.match(system, /Business flows must be complete enough to test visually/);
  assert.match(system, /Bloom Planner, My Season, and Brain Spin/);
  assert.match(system, /at least four domain-specific product modules/);
  assert.match(system, /use_design_skill/);
  assert.match(system, /inspect_reference_app/);
  assert.match(system, /quality_audit/);
});

test("composeRepairPrompt includes repair context and keeps design gate", () => {
  const prompt = composeRepairPrompt({
    userBrief: "做一个演唱会抢票 App",
    clarificationText: "flow: ticketing",
    contextSummary: "Workspace files: 0",
    selectedFiles: "",
    issues: "生成结果仍包含占位内容",
    buildLog: "npm run build passed",
    currentFiles: "--- src/app/page.tsx\nexport default function HomePage() { return <main /> }",
  });

  assert.equal(prompt.role, "repairer");
  assert.match(prompt.system, /<role_mission>/);
  assert.match(prompt.system, /Fix the current generated app/);
  assert.match(prompt.system, /<frontend_design>/);
  assert.match(prompt.user, /生成结果仍包含占位内容/);
  assert.match(prompt.user, /src\/app\/page\.tsx/);
});
