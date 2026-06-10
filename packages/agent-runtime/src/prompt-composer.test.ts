import test from "node:test";
import assert from "node:assert/strict";

import {
  composeAgentCoderSystem,
  composeArchitectPrompt,
  composeCoderPrompt,
  composeDesignDirectorPrompt,
  composeRepairPrompt,
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
  assert.match(prompt.system, /Interaction model is mandatory/);
  assert.match(prompt.system, /date\/month switching/);
  assert.match(prompt.system, /save\/edit\/delete or revise actions/);
  assert.match(prompt.system, /self-check the interaction model/);
  assert.match(prompt.system, /Bloom Planner, My Season, or Brain Spin/);
  assert.match(prompt.system, /Render destination\/place media with actual <img> elements/);
  assert.match(prompt.system, /do not rely only on background-color divs/);
  assert.match(prompt.system, /role="img" and data-visual/);
  assert.match(prompt.system, /stable dimensions and painted foreground details/);
  assert.match(prompt.system, /at least 3 product modules/);
  assert.match(prompt.system, /No TODO, lorem ipsum, coming soon/);
  assert.match(prompt.system, /static curated data, local-only personal use/);
  assert.match(prompt.system, /Use Route Handlers, Server Actions, Prisma/);
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
  assert.match(prompt.system, /Plan the interaction model as an executable contract/);
  assert.match(prompt.system, /at least three distinct domain interactions/);
  assert.match(prompt.system, /interaction-model-completeness/);
  assert.match(prompt.system, /DiaryComposer/);
  assert.match(prompt.system, /By default, choose provider=memory and orm=none/);
  assert.match(prompt.system, /src\/lib\/demo-data\.ts should export typed models/);
  assert.match(prompt.system, /externalCapabilities/);
  assert.match(prompt.system, /qualityChecks/);
  assert.match(prompt.schemaHint, /"qualityChecks"/);
  assert.match(prompt.schemaHint, /"externalCapabilities"/);
  assert.match(prompt.system, /Acceptance criteria must be user-visible flow outcomes/);
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
  assert.match(system, /Business flows must expose visible state changes/);
  assert.match(system, /interaction-model-depth/);
  assert.match(system, /domain-interaction-affordances/);
  assert.match(system, /The interaction model must be testable/);
  assert.match(system, /focus-visible styling/);
  assert.match(system, /visible media/);
  assert.match(system, /role="img" data-visual CSS illustration/);
  assert.match(system, /Bloom Planner, My Season, and Brain Spin/);
  assert.match(system, /at least three domain-specific product modules/);
  assert.match(system, /use_design_skill/);
  assert.match(system, /inspect_reference_app/);
  assert.match(system, /quality_audit/);
  assert.match(system, /Follow the architecture plan's storage choice exactly/);
  assert.match(system, /skip it for local-first apps without prisma\/schema\.prisma/);
  assert.match(system, /For local-first or static-export plans, do not introduce Server Actions/);
  assert.match(system, /defensive browser storage when needed, typed src\/lib data modules/);
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
  assert.match(prompt.system, /Return full file contents for every file you changed or added/);
  assert.match(prompt.system, /unchanged files may be omitted/);
  assert.match(prompt.system, /Do not answer with prose-only analysis/);
  assert.doesNotMatch(prompt.system, /Return the complete corrected app, not a patch/);
  assert.match(prompt.system, /<frontend_design>/);
  assert.match(prompt.user, /生成结果仍包含占位内容/);
  assert.match(prompt.user, /src\/app\/page\.tsx/);
});
