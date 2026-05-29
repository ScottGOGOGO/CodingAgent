import type { ArchitecturePlan, DesignBrief, DesignSeed } from "@vide/contracts";
import type { ModelRole } from "./config.js";

export type PromptSectionId =
  | "agent_contract"
  | "role_mission"
  | "runtime_constraints"
  | "frontend_design"
  | "design_brief"
  | "visual_evidence"
  | "quality_gate"
  | "output_contract"
  | "dynamic_context"
  | "override";

export interface PromptSection {
  id: PromptSectionId;
  title: string;
  body: string;
}

export interface PromptOverrides {
  replaceSystem?: string;
  appendSystem?: string;
  appendUser?: string;
}

export interface ClarifierPromptInput {
  userBrief: string;
  contextSummary: string;
  overrides?: PromptOverrides;
}

export interface DesignDirectorPromptInput {
  userBrief: string;
  clarificationText: string;
  contextSummary: string;
  overrides?: PromptOverrides;
}

export interface DesignSeedPromptInput {
  userBrief: string;
  clarificationText: string;
  contextSummary: string;
  designBrief: string;
  /** Optional reference profile shorthand, e.g. "bloom-planner" or "my-season". */
  referenceProfile?: string;
  overrides?: PromptOverrides;
}

export interface ArchitectPromptInput {
  userBrief: string;
  clarificationText: string;
  contextSummary: string;
  designBrief: string;
  /** Optional rendered design seed text — drives concrete file planning. */
  designSeed?: string;
  overrides?: PromptOverrides;
}

export interface AgentCoderSystemInput {
  userBrief: string;
  clarificationText: string;
  designBrief: string;
  /** Optional rendered design seed text — the coder must apply these colors/fonts/assets verbatim. */
  designSeed?: string;
  /** Sandbox-relative paths of design-seed assets already written before the loop starts. */
  preloadedAssets?: string[];
  architecturePlan: string;
  /** Tool catalog rendered for the model. */
  toolCatalog: string;
  overrides?: PromptOverrides;
}

export interface AppPromptInput {
  userBrief: string;
  clarificationText: string;
  contextSummary: string;
  selectedFiles: string;
  designBrief?: string;
  overrides?: PromptOverrides;
}

export interface RepairPromptInput extends AppPromptInput {
  issues: string;
  buildLog: string;
  currentFiles: string;
  visualReview?: string;
}

export interface VisualCriticPromptInput {
  userBrief: string;
  clarificationText: string;
  designBrief: string;
  screenshotSummary: string;
  currentFiles: string;
  overrides?: PromptOverrides;
}

export interface ComposedPrompt {
  role: ModelRole;
  system: string;
  user: string;
  schemaHint: string;
  sections: PromptSection[];
}

const GENERATED_APP_SCHEMA =
  'Schema: {"title": string, "summary": string, "files": [{"path": "package.json|next.config.mjs|tsconfig.json|src/app/layout.tsx|src/app/page.tsx|src/app/globals.css|...", "content": string}]}';

const CLARIFICATION_SCHEMA =
  'Schema: {"action": "ask|ready", "summary": string, "questions": [{"id": string, "header": string, "question": string, "options": [{"label": string, "value": string, "description": string}], "multiSelect": boolean, "required": boolean}]}';

const DESIGN_BRIEF_SCHEMA =
  'Schema: {"summary": string, "targetUser": string, "productGoal": string, "coreExperience": string, "screens": string[], "interactionModel": string[], "visualDirection": string[], "contentStrategy": string[], "qualityBar": string[], "antiPatterns": string[]}';

const VISUAL_REVIEW_SCHEMA =
  'Schema: {"status": "passed|failed", "score": number, "summary": string, "issues": string[], "blockingIssues": string[], "warnings": string[], "repairInstructions": string[]}';

const DESIGN_SEED_SCHEMA =
  'Schema: {"visualConcept": string, "palette": {"name": string, "primary": "#hexOrCSS", "surface": "#hexOrCSS", "ink": "#hexOrCSS", "accent": "#hexOrCSS", "muted": "#hexOrCSS", "gradient": "optional CSS gradient string"}, "typography": {"headingFamily": "CSS font stack", "headingWeight": "weight string", "bodyFamily": "CSS font stack", "monoFamily": "optional CSS font stack", "scale": "1-sentence type scale description"}, "motionLanguage": "1-2 sentence motion philosophy", "assets": [{"filename": "src/components/icons/Brand.tsx OR public/file.svg OR src/styles/tokens.css", "kind": "svg-component|static-svg|css-tokens", "content": "complete file body", "purpose": "why this exists"}], "antiPatterns": ["palette- or motion-specific things to avoid"]}';

const ARCHITECTURE_PLAN_SCHEMA =
  'Schema: {"summary": string, "techStack": string[], "stateArchitecture": string, "serverArchitecture": string, "dataStore": {"provider": "sqlite|postgres|vercel-postgres|kv|blob|memory|external", "orm": "prisma|drizzle|none", "schemaPath": string, "migrationStrategy": string, "seedStrategy": string, "persistenceNotes": string}, "fileTree": [{"path": string, "purpose": string, "dependencies": string[]}], "dataModels": [{"name": string, "description": string, "fields": [{"name": string, "type": string, "description": string}]}], "components": [{"name": string, "filePath": string, "purpose": string, "props": string[], "uses": string[]}], "routes": [{"path": string, "component": string, "description": string, "filePath": string, "rendering": "server|client|static|dynamic|isr"}], "apiEndpoints": [{"path": string, "method": "GET|POST|PUT|PATCH|DELETE", "purpose": string, "filePath": string, "request": string, "response": string, "auth": string, "runtime": "nodejs|edge"}], "serverActions": [{"name": string, "filePath": string, "purpose": string, "input": string, "effects": string[]}], "envVars": [{"name": string, "purpose": string, "required": boolean, "scope": "server|client", "example": string}], "integrations": [{"name": string, "purpose": string, "envVars": string[], "serverFiles": string[]}], "qualityChecks": [{"id": string, "category": "frontend|backend|data|interaction|deployment|accessibility", "requirement": string, "evidence": string, "blocking": boolean}], "externalCapabilities": [{"name": string, "purpose": string, "trigger": string, "expectedOutput": string, "constraints": string[]}], "deployment": string, "tasks": [{"id": string, "title": string, "description": string, "files": string[], "dependsOn": string[], "acceptance": string}], "risks": string[]}';

function section(id: PromptSectionId, title: string, body: string): PromptSection {
  return { id, title, body };
}

function renderSections(sections: PromptSection[]): string {
  return sections.map((item) => `<${item.id}>\n${item.body.trim()}\n</${item.id}>`).join("\n\n");
}

function withOverrides(system: string, overrides?: PromptOverrides): string {
  if (overrides?.replaceSystem?.trim()) {
    return overrides.replaceSystem.trim();
  }
  return [system, overrides?.appendSystem ? `<override>\n${overrides.appendSystem.trim()}\n</override>` : ""]
    .filter(Boolean)
    .join("\n\n");
}

function userBlock(label: string, value: string): string {
  return `## ${label}\n${value.trim() || "(empty)"}`;
}

export function composeClarifierPrompt(input: ClarifierPromptInput): ComposedPrompt {
  const sections = [
    section(
      "agent_contract",
      "Session Contract",
      [
        "You are the clarifier inside a session-level coding agent.",
        "The agent builds local Next.js 14 App Router applications with real server routes, durable data options, and deployable Vercel-compatible structure.",
        "Your job is to decide whether the user brief is clear enough to generate, and only ask when ambiguity would materially change the product.",
      ].join(" "),
    ),
    section(
      "role_mission",
      "Clarifier Mission",
      [
        "Return action=ready with an empty questions array when the user already specified product type, target users or scenario, core screens/flows, content/data direction, and visual direction well enough for a first candidate.",
        "Return action=ask only when missing information would materially change visible UX, screens, flows, data persistence, user/auth needs, integrations, content, or mobile interaction choices.",
        "Do not ask about high concurrency, anti-bot systems, real payment processing, or production compliance unless the user explicitly requested those.",
        "Do not use generic headings like 用户与目标, 首版范围, or 视觉方向 unless those exact details are uniquely necessary.",
        "When action=ask, ask 1 to 3 questions. Each question should have 2 to 4 concise option chips with useful descriptions.",
        "Use the same language as the user when possible.",
      ].join(" "),
    ),
    section("dynamic_context", "Dynamic Context", `User brief:\n${input.userBrief}\n\nProject context:\n${input.contextSummary}`),
    section("output_contract", "Output Contract", "Return valid JSON only. No markdown. No commentary outside the JSON object."),
  ];

  const system = withOverrides(renderSections(sections), input.overrides);
  const user = [
    userBlock("User Brief", input.userBrief),
    userBlock("Available Project Context", input.contextSummary),
    input.overrides?.appendUser ? userBlock("Additional User Instructions", input.overrides.appendUser) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { role: "clarifier", system, user, schemaHint: CLARIFICATION_SCHEMA, sections };
}

export function composeDesignDirectorPrompt(input: DesignDirectorPromptInput): ComposedPrompt {
  const sections = [
    section(
      "agent_contract",
      "Agent Contract",
      [
        "You are the design_director inside a session-level coding agent.",
        "The agent builds mobile-first full-stack Next.js product candidates in a sandbox.",
        "Your output is a concrete product and visual design brief that the coder must execute.",
      ].join(" "),
    ),
    section(
      "role_mission",
      "Design Director Mission",
      [
        "Translate the user's request and clarification answers into a sharp mobile product direction before any code is written.",
        "Make decisions. Do not ask more questions here.",
        "Define the target user, product goal, core experience, screen set, mobile interaction model, visual direction, content strategy, quality bar, and anti-patterns.",
        "Write the brief as a product screenplay: the user's job-to-be-done, the first five-minute experience, the signature interaction, the domain content inventory, and the states that make the app feel alive.",
        "The visual direction must choose a specific aesthetic point of view, not 'clean modern app'. Tie it to the product's audience, physical world, vocabulary, and emotional tone.",
        "Benchmark the ambition against compact consumer web apps like Bloom Planner, My Season, and Brain Spin: a named product identity, memorable theme, clear app shell, obvious navigation, and one delightful main loop.",
        "Treat those references as commercial-grade product patterns: they have a remembered brand signal, a restrained but opinionated visual system, real loading/empty/error states, and business objects that feel alive rather than placeholder content.",
        "Identify where reference-app guidance or design-skill guidance would materially improve the result, especially app shell, visual system, primary loop, persistence, and empty/error states.",
        "The brief should be specific enough that a coder cannot produce a generic white-card demo and still claim success.",
      ].join(" "),
    ),
    section(
      "frontend_design",
      "Design Quality Rules",
      [
        "Plan for a 390px iPhone viewport first.",
        "Tie color, typography, layout rhythm, controls, and product data/content to the product domain.",
        "Avoid generic AI demo aesthetics: centered title plus search box plus white cards; blue-gray gradients; stock card grids; generic dashboard spacing; placeholder copy.",
        "Do not plan a technology showcase. The user should see business objects, decisions, tasks, progress, and outcomes, never implementation labels.",
        "Prefer compact app structure over landing-page structure: app shell, bottom tabs or contextual nav, primary action panel, stateful content area, progress/history/next-action surfaces.",
        "Define a signature interaction such as plan, spin, log, save, check in, compare, schedule, or receive a recommendation; this interaction must be visible in the first viewport or immediately below it.",
        "Set a commercial quality bar: the result should look credible enough for a paying user's first review, with production-like copy, states, and workflows rather than a portfolio mockup.",
        "For learning, coaching, planning, or workflow products, require concrete modules such as curriculum/progression, today's plan, practice or task logging, feedback/corrections, history, and next action.",
        "The result should feel like a real product candidate that could be reviewed on a phone.",
      ].join(" "),
    ),
    section("dynamic_context", "Dynamic Context", `User brief:\n${input.userBrief}\n\nClarification answers:\n${input.clarificationText || "(none)"}\n\nProject context:\n${input.contextSummary}`),
    section("output_contract", "Output Contract", "Return valid JSON only. No markdown. No explanations outside the JSON object."),
  ];

  const system = withOverrides(renderSections(sections), input.overrides);
  const user = [
    userBlock("User Brief", input.userBrief),
    input.clarificationText ? userBlock("Clarification Answers", input.clarificationText) : "",
    userBlock("Context", input.contextSummary),
    input.overrides?.appendUser ? userBlock("Additional User Instructions", input.overrides.appendUser) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { role: "design_director", system, user, schemaHint: DESIGN_BRIEF_SCHEMA, sections };
}

export function composeCoderPrompt(input: AppPromptInput): ComposedPrompt {
  const sections = [
    section(
      "agent_contract",
      "Agent Contract",
      [
        "You are the coder inside a session-level local coding agent.",
        "Generate a complete Next.js 14 App Router + TypeScript application that can be installed, built, run locally, and deployed to Vercel.",
        "Return the complete file set needed by the app, not a patch or explanation.",
      ].join(" "),
    ),
    section(
      "runtime_constraints",
      "Runtime Constraints",
      [
        "Use Next.js 14 App Router, React 18, TypeScript strict, Server Components by default, Server Actions or Route Handlers for mutations, and CSS Modules or src/app/globals.css for styling.",
        "Include package.json, next.config.mjs, tsconfig.json, next-env.d.ts, src/app/layout.tsx, src/app/page.tsx, src/app/globals.css, and every imported component, lib, data, action, route handler, Prisma, or env file.",
        "Use 'use client' only for interactive leaf components. Keep data loading, persistence, and secrets on the server side.",
        "When persistence is useful, add a real data layer: Prisma with SQLite for sandbox validation by default, or Postgres-compatible Prisma when env vars are required. Avoid browser-only localStorage for durable product state.",
        "If database clients or service SDKs require env vars, initialize them lazily inside getter functions so next build does not fail when deployment-only variables are absent.",
        "The app is viewed inside an iPhone-like preview, so design mobile-first for a 390px wide viewport before expanding to desktop.",
        "TypeScript must compile in strict mode: when mapping navigation tabs, filters, or page ids into useState setters, type ids with explicit unions/as const or keep the state type compatible with string.",
      ].join(" "),
    ),
    section(
      "frontend_design",
      "Frontend Design Direction",
      [
        "Act like a principal product designer and senior front-end engineer, not a demo generator.",
        "Choose a strong domain-specific visual concept before coding, then execute it consistently in typography, color, layout, copy, motion, and interaction states.",
        "Avoid generic AI demo aesthetics: centered title plus search box plus white cards; Segoe UI/Tahoma/Arial/system-only typography; blue-gray gradients; plain card grids; generic shadows; stock dashboard spacing.",
        "Use CSS variables, purposeful type scale, rich mobile composition, tactile controls, real product states, and contextual details tied to the user's domain.",
        "Aim for compact app quality similar to Bloom Planner, My Season, or Brain Spin: named identity, immersive theme, clear shell/navigation, a memorable main interaction, and polished empty/loading/success states.",
        "Commercial-grade means the app has a complete product loop, credible microcopy, loading/empty/error/success states, and visual restraint. Decorative polish cannot compensate for missing workflow depth.",
        "Use lucide-react icons when helpful, and make controls feel like product controls rather than text blocks.",
        "For travel/lifestyle apps, prefer editorial mobile composition, destination-specific content, bottom navigation or thumb-friendly controls, saved states, itinerary/story details, and image treatments that feel intentional.",
        "For learning, coaching, planning, or workflow apps, build around curriculum/progression, today's plan, logging, feedback, history, and the user's next best action.",
        "For operational tools, prioritize dense but readable scanning, restrained color, predictable controls, and efficient workflows.",
        "No visible in-app text should explain implementation details or say that this is a prototype.",
      ].join(" "),
    ),
    section(
      "quality_gate",
      "Product Fidelity Contract",
      [
        "The generated UI must be a real product surface, not a technology demo, prompt response, scaffold, or landing page about the implementation.",
        "Do not expose internal implementation details in visible copy: Next.js, App Router, React, Prisma, Server Components, Server Actions, API routes, full-stack, sandbox, generated app, architecture plan, prompt, build, prototype.",
        "The first screen must let the target user start or inspect a meaningful domain workflow immediately. It should not merely restate the user's brief.",
        "The app must have at least 4 product modules/surfaces in the code and UI, such as Today, Plan, Detail, Log, Progress, Feedback, History, Profile, Saved, or Settings, adapted to the domain.",
        "Do not ship a single-screen illusion. Provide at least 3 distinct page routes or route-equivalent surfaces, and each one needs useful content plus a non-happy-path state.",
        "Use product-specific component names, copy, and data that match the domain. Avoid generic sections like 需求澄清, 全栈架构, 沙箱验证, Candidate, Demo, Sample, or Tech Stack.",
        "If the user asks for software that plans, teaches, tracks, sells, books, coordinates, or analyzes something, include one end-to-end primary flow with realistic state changes and server-backed data boundaries.",
      ].join(" "),
    ),
    section(
      "quality_gate",
      "Quality Gate",
      [
        "The result must feel like a product candidate, not a tutorial sample.",
        "Use production-like copy and seed/demo data only through server-side modules, Prisma seed data, or route handlers. Do not describe it as static sample data in the UI.",
        "Expose at least one meaningful server-side capability when the product calls for it: route handler, Server Action, auth/session boundary, database read/write, webhook placeholder, or external API integration facade.",
        "No TODO, lorem ipsum, coming soon, placeholder descriptions, empty states without useful guidance, or broken imports.",
        "Every primary control shown should have a visible state change, filtering, tab switch, selection, or navigation effect when reasonable.",
      ].join(" "),
    ),
    section("dynamic_context", "Dynamic Context", `User brief:\n${input.userBrief}\n\nClarification answers:\n${input.clarificationText || "(none)"}\n\nProject context:\n${input.contextSummary}`),
    input.designBrief
      ? section(
          "design_brief",
          "Design Brief",
          [
            "This design brief is mandatory. Implement it concretely in the generated code.",
            "If it conflicts with generic UI instincts, follow the brief.",
            input.designBrief,
          ].join("\n\n"),
        )
      : undefined,
    section("output_contract", "Output Contract", "Return valid JSON only. No markdown. No explanations outside the JSON object."),
  ].filter((item): item is PromptSection => Boolean(item));

  const system = withOverrides(renderSections(sections), input.overrides);
  const user = [
    userBlock("User Brief", input.userBrief),
    input.clarificationText ? userBlock("Clarification Answers", input.clarificationText) : "",
    userBlock("Context", input.contextSummary),
    input.designBrief ? userBlock("Design Brief", input.designBrief) : "",
    input.selectedFiles ? userBlock("Selected Files", input.selectedFiles) : "",
    input.overrides?.appendUser ? userBlock("Additional User Instructions", input.overrides.appendUser) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { role: "coder", system, user, schemaHint: GENERATED_APP_SCHEMA, sections };
}

export function composeVisualCriticPrompt(input: VisualCriticPromptInput): ComposedPrompt {
  const sections = [
    section(
      "agent_contract",
      "Agent Contract",
      [
        "You are the visual_critic inside a session-level coding agent.",
        "You review a generated mobile web candidate after build and screenshot capture.",
        "Your decision controls whether the repairer must rewrite the UI before the candidate can be submitted.",
      ].join(" "),
    ),
    section(
      "role_mission",
      "Visual Critic Mission",
      [
        "Judge whether the candidate satisfies the design brief and is visually credible inside a 390px iPhone preview.",
        "Focus on visible product quality: composition, hierarchy, spacing, typography, color, domain specificity, mobile ergonomics, product content, and interaction affordances.",
        "Be strict with generic or ugly output. Passing means a human reviewer would see an intentional mobile product, not a scaffold.",
        "Treat visible implementation language as a product failure, even when the code is technically correct.",
      ].join(" "),
    ),
    section(
      "quality_gate",
      "Pass/Fail Gate",
      [
        "Fail if the UI is mostly blank, mostly placeholder text, dominated by generic white cards, lacks domain-specific content, overflows the phone viewport, or ignores the design brief.",
        "Fail if the visible first screen does not communicate the product purpose quickly.",
        "Fail if the candidate reads like a landing page, tech demo, prompt summary, or HTML mockup instead of an app with a usable product workflow.",
        "Fail if it lacks compact app structure: no named identity, no app shell/navigation, no signature interaction, no progress/history/next-action surface, or fewer than four domain-specific modules.",
        "Fail if it feels like a demo rather than something a business could put in front of early customers: thin copy, fake metrics, one-route depth, missing loading/empty/error states, or buttons that do not lead to visible outcomes.",
        "Fail if visible copy exposes internal implementation details such as Next.js, App Router, React, Prisma, Server Components, Server Actions, API route, full-stack, sandbox, generated app, architecture, prompt, build, or prototype.",
        "Fail if the UI uses generic process labels like 需求澄清, 全栈架构, 沙箱验证, Candidate, Demo, Sample, or Tech Stack as product content.",
        "Fail if primary controls are decorative only or the app showcases data without letting the user make a decision, update state, filter, log, save, submit, or navigate a meaningful domain flow.",
        "Fail if primary media feels generic, unrelated to the stated place/product, or contradicts visible copy; request a domain-matched visual treatment or CSS-only fallback.",
        "If screenshot capture failed, review the generated files and do not fail solely because the capture tool was unavailable.",
        "Pass only if the score is 88 or higher.",
        "Set status=failed only for blocking issues that require another repair pass before submission.",
        "Put minor polish, subjective taste notes, and non-critical improvements in warnings, not blockingIssues.",
        "Return concise repair instructions only for blocking issues that a coder can apply directly.",
      ].join(" "),
    ),
    section("design_brief", "Design Brief", input.designBrief),
    section("visual_evidence", "Screenshot Evidence", input.screenshotSummary),
    section("dynamic_context", "Dynamic Context", `User brief:\n${input.userBrief}\n\nClarification answers:\n${input.clarificationText || "(none)"}`),
    section("output_contract", "Output Contract", "Return valid JSON only. No markdown. No explanations outside the JSON object."),
  ];

  const system = withOverrides(renderSections(sections), input.overrides);
  const user = [
    userBlock("User Brief", input.userBrief),
    input.clarificationText ? userBlock("Clarification Answers", input.clarificationText) : "",
    userBlock("Design Brief", input.designBrief),
    userBlock("Screenshot Evidence", input.screenshotSummary),
    userBlock("Current Files", input.currentFiles),
    input.overrides?.appendUser ? userBlock("Additional User Instructions", input.overrides.appendUser) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { role: "visual_critic", system, user, schemaHint: VISUAL_REVIEW_SCHEMA, sections };
}

export function composeRepairPrompt(input: RepairPromptInput): ComposedPrompt {
  const base = composeCoderPrompt(input);
  const repairSections = [
    section(
      "role_mission",
      "Repairer Mission",
      [
        "You are the repairer. Fix the current generated app so it passes validation, build, and product-quality expectations.",
        "Return the complete corrected app, not a patch.",
        "Keep the user's requested product and data, but rewrite weak UI, generic composition, placeholder copy, and broken code aggressively.",
      ].join(" "),
    ),
    section(
      "dynamic_context",
      "Repair Context",
      `Validation issues:\n${input.issues}\n\nVisual review:\n${input.visualReview || "(none)"}\n\nBuild log:\n${input.buildLog || "(none)"}\n\nCurrent files:\n${input.currentFiles}`,
    ),
  ];
  const sections = [
    base.sections[0],
    repairSections[0],
    ...base.sections.slice(1, -1),
    repairSections[1],
    base.sections.at(-1)!,
  ];
  const system = withOverrides(renderSections(sections), input.overrides);
  const user = [
    userBlock("User Brief", input.userBrief),
    input.clarificationText ? userBlock("Clarification Answers", input.clarificationText) : "",
    userBlock("Validation Issues", input.issues),
    input.buildLog ? userBlock("Build Log", input.buildLog.slice(-4000)) : "",
    input.visualReview ? userBlock("Visual Review", input.visualReview) : "",
    userBlock("Current Files", input.currentFiles),
    input.overrides?.appendUser ? userBlock("Additional User Instructions", input.overrides.appendUser) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { role: "repairer", system, user, schemaHint: GENERATED_APP_SCHEMA, sections };
}

export function formatDesignBriefForPrompt(brief: DesignBrief): string {
  return [
    `Summary: ${brief.summary}`,
    `Target user: ${brief.targetUser}`,
    `Product goal: ${brief.productGoal}`,
    `Core experience: ${brief.coreExperience}`,
    `Screens: ${brief.screens.join("; ")}`,
    `Interaction model: ${brief.interactionModel.join("; ")}`,
    `Visual direction: ${brief.visualDirection.join("; ")}`,
    `Content strategy: ${brief.contentStrategy.join("; ")}`,
    `Quality bar: ${brief.qualityBar.join("; ")}`,
    `Anti-patterns: ${brief.antiPatterns.join("; ")}`,
  ].join("\n");
}

export function composeDesignSeedPrompt(input: DesignSeedPromptInput): ComposedPrompt {
  const sections = [
    section(
      "agent_contract",
      "Agent Contract",
      [
        "You are the design_seed_smith inside a session-level coding agent.",
        "You run AFTER the design director (who set high-level direction) and BEFORE the architect (who plans files).",
        "Your output is the concrete visual identity the coder will execute. Picks here are final; the coder must apply them verbatim.",
      ].join(" "),
    ),
    section(
      "role_mission",
      "Design Seed Smith Mission",
      [
        "Convert the design brief into a specific, opinionated visual identity: palette, typography pair, motion language, and 1 to 2 small custom assets (SVG component or CSS token file).",
        "Do not be generic. 'Tailwind defaults', 'system-ui everywhere', 'Inter only', 'blue gradient' are failure modes.",
        "Match the product domain. Travel/lifestyle → editorial warm palette, serif heading, photo-friendly. Productivity → calmer accents, mono metadata. Game-like → high contrast, kinetic accents.",
        "Pick a NAMED palette concept ('warm-paper-amber', 'ember-plum-cinema', 'meadow-ink-mint') — the slug acts as a CSS token namespace.",
        "Typography MUST be a pair (heading + body) with distinct character. Lora/Inter, Playfair Display/Source Sans, Space Grotesk/IBM Plex Sans, Fraunces/Manrope. Never both 'system-ui'.",
        "Each custom asset must be product-specific (a companion mark, a domain icon, a section divider). Provide complete file contents — the orchestrator writes them verbatim into the sandbox before the coder starts.",
      ].join(" "),
    ),
    section(
      "runtime_constraints",
      "Runtime Constraints",
      [
        "Color values must be valid CSS (hex like '#c47a3a' or hsl/oklch). No 'tailwind-orange-500' style names.",
        "Typography stacks must be valid CSS font-family declarations including fallbacks, e.g. 'Lora, \"Source Serif Pro\", serif'.",
        "Custom assets must be one of: 'svg-component' (a React .tsx file under src/components/icons/), 'static-svg' (a .svg file under public/), or 'css-tokens' (a .css file under src/styles/ exposing the palette as CSS variables).",
        "Total asset count: 1 or 2. More than 2 is over-design at the seed stage.",
        "SVG components are React functional components returning JSX, with width/height props if applicable. They must not import other components — pure SVG output.",
        "css-tokens files must expose at minimum --color-primary, --color-surface, --color-ink, --color-accent, --color-muted as CSS variables under :root.",
      ].join(" "),
    ),
    section(
      "quality_gate",
      "Identity Quality Bar",
      [
        "The palette can be picked out from a moodboard — it is not interchangeable with another product.",
        "The typography pair signals the product category before any copy is read.",
        "Motion language commits to ONE philosophy (e.g. 'tactile micro-feedback only, no decorative motion') — not 'smooth modern transitions'.",
        "Anti-patterns list names what this identity REFUSES (e.g. 'no neon, no centered hero with search box, no shadow-heavy cards').",
      ].join(" "),
    ),
    section("design_brief", "Design Brief", input.designBrief),
    input.referenceProfile
      ? section(
          "dynamic_context",
          "Reference Profile Hint",
          `The architect chose '${input.referenceProfile}' as the closest reference profile. Use it for structural inspiration only — do NOT copy its branding, exact palette, or proprietary assets.`,
        )
      : undefined,
    section(
      "dynamic_context",
      "Dynamic Context",
      `User brief:\n${input.userBrief}\n\nClarification answers:\n${input.clarificationText || "(none)"}\n\nProject context:\n${input.contextSummary}`,
    ),
    section("output_contract", "Output Contract", "Return valid JSON only. No markdown. No commentary outside the JSON object."),
  ].filter((item): item is PromptSection => Boolean(item));

  const system = withOverrides(renderSections(sections), input.overrides);
  const user = [
    userBlock("User Brief", input.userBrief),
    input.clarificationText ? userBlock("Clarification Answers", input.clarificationText) : "",
    userBlock("Design Brief", input.designBrief),
    input.referenceProfile ? userBlock("Reference Profile", input.referenceProfile) : "",
    userBlock("Project Context", input.contextSummary),
    input.overrides?.appendUser ? userBlock("Additional User Instructions", input.overrides.appendUser) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { role: "design_seed_smith", system, user, schemaHint: DESIGN_SEED_SCHEMA, sections };
}

export function formatDesignSeedForPrompt(seed: DesignSeed): string {
  const lines: string[] = [];
  lines.push(`Visual concept: ${seed.visualConcept}`);
  lines.push("");
  lines.push("Palette:");
  lines.push(`  name: ${seed.palette.name}`);
  lines.push(`  --color-primary: ${seed.palette.primary}`);
  lines.push(`  --color-surface: ${seed.palette.surface}`);
  lines.push(`  --color-ink: ${seed.palette.ink}`);
  lines.push(`  --color-accent: ${seed.palette.accent}`);
  lines.push(`  --color-muted: ${seed.palette.muted}`);
  if (seed.palette.gradient) {
    lines.push(`  gradient: ${seed.palette.gradient}`);
  }
  lines.push("");
  lines.push("Typography:");
  lines.push(`  heading: ${seed.typography.headingFamily} (weight ${seed.typography.headingWeight})`);
  lines.push(`  body:    ${seed.typography.bodyFamily}`);
  if (seed.typography.monoFamily) {
    lines.push(`  mono:    ${seed.typography.monoFamily}`);
  }
  lines.push(`  scale:   ${seed.typography.scale}`);
  lines.push("");
  lines.push(`Motion language: ${seed.motionLanguage}`);
  if (seed.assets.length > 0) {
    lines.push("");
    lines.push("Preloaded assets (already written to the sandbox before the coder loop):");
    for (const asset of seed.assets) {
      lines.push(`  - ${asset.filename} [${asset.kind}] — ${asset.purpose}`);
    }
  }
  if (seed.antiPatterns?.length) {
    lines.push("");
    lines.push("Anti-patterns:");
    for (const item of seed.antiPatterns) {
      lines.push(`  ! ${item}`);
    }
  }
  return lines.join("\n");
}

export function composeArchitectPrompt(input: ArchitectPromptInput): ComposedPrompt {
  const sections = [
    section(
      "agent_contract",
      "Agent Contract",
      [
        "You are the architect inside a session-level coding agent.",
        "You operate AFTER the design director and BEFORE the coder agent loop.",
        "Your output drives a tool-using coder that will read, write, and verify files iteratively.",
        "Be concrete and decisive. The plan is the blueprint, not a brainstorm.",
      ].join(" "),
    ),
    section(
      "role_mission",
      "Architect Mission",
      [
        "Translate the design brief into an executable engineering plan for a mobile-first full-stack Next.js 14 App Router + TypeScript app.",
        "Decide the file tree, route segments, data models, database or durable storage plan, API route handlers, Server Actions, component decomposition, client/server boundaries, state architecture, env vars, deployment notes, and ordered task list.",
        "Each task must be a small, verifiable unit: typically 1 to 4 files, with explicit acceptance criteria.",
        "Plan from user-visible product flows backwards. Name at least two primary user flows in the tasks and connect each to UI, data, mutation, and validation work.",
        "Plan compact app structure explicitly: app shell/navigation, home/current-state surface, detail/action surface, progress/history surface, and settings/profile/collection surface when appropriate.",
        "Order tasks by dependency: project config and env contract first, database schema/seed/server libs next, route handlers or Server Actions, UI primitives, route pages, integration wiring, then build/migration verification.",
        "Plan for substantive product complexity: real server-side state, real interactions, real data contracts, multiple screens or route segments, and deployment-aware boundaries — not a single-page static demo.",
        "Include externalCapabilities for any controlled tool or skill guidance the coder should consult, such as use_design_skill for frontend systems and inspect_reference_app for Bloom Planner or My Season patterns.",
        "Include qualityChecks that prove the app is closed-loop: visible product modules, data schema, read/write APIs or Server Actions, mutation validation, visual/mobile evidence, and deployment/env readiness.",
        "Aim for 8 to 16 tasks total. Fewer than 8 is usually too coarse; more than 16 is usually over-planned.",
      ].join(" "),
    ),
    section(
      "runtime_constraints",
      "Runtime Constraints",
      [
        "Stack: Next.js 14 App Router, React 18, TypeScript strict, Server Components by default, CSS Modules or globals.css. No Vite, no Pages Router, no React Router.",
        "Use Next.js file-system routing under src/app. Use route.ts for public APIs/webhooks and Server Actions for in-app form mutations.",
        "Do not put <style jsx> in App Router convention files such as page.tsx, layout.tsx, loading.tsx, or error.tsx unless the file is explicitly a Client Component. Prefer src/app/globals.css or CSS Modules.",
        "Use Prisma with SQLite for sandbox-verifiable durable data by default; switch to Postgres-compatible Prisma when the app needs Vercel Postgres or DATABASE_URL. Include prisma/schema.prisma and migration/seed notes when persistence is planned.",
        "You MAY use lightweight libraries that materially help complexity, declared in package.json: zod for validation, date-fns for date math, nanoid for ids, prisma and @prisma/client for data. Pick only what the design actually needs.",
        "Mobile-first 390px viewport, designed to also adapt up to desktop.",
        "Do not plan browser-only localStorage as the primary persistence layer. Use server-side data access, route handlers, or Server Actions for durable state.",
        "File tree must include: package.json, next.config.mjs, tsconfig.json, next-env.d.ts, src/app/layout.tsx, src/app/page.tsx, src/app/globals.css, plus the components/lib/db/actions/api/prisma files you plan.",
      ].join(" "),
    ),
    section(
      "quality_gate",
      "Plan Quality Bar (HARD MINIMUMS — orchestrator augments missing items)",
      [
        "Tasks must be specific enough that an LLM coder cannot misinterpret them.",
        "Each task lists exactly the files it touches and what 'done' means. Acceptance criteria must be user-visible flow outcomes, not only 'file exists', 'component renders', or 'build passes'.",
        "File tree paths are real (e.g. src/app/trips/page.tsx, src/app/api/trips/route.ts, src/lib/db.ts, prisma/schema.prisma), not placeholders.",
        "HARD MINIMUM — routes: plan AT LEAST 3 distinct Next.js page routes under src/app (e.g. /, /[detail], /history, /profile). A single-page app is rejected as under-built; if the design brief only describes one screen, still derive 3 routes by splitting current/detail/history surfaces.",
        "HARD MINIMUM — components: plan AT LEAST 8 component files under src/components (mix of primitives, composites, and surface modules). 'AppShell' alone is not enough.",
        "HARD MINIMUM — data: prisma/schema.prisma MUST declare AT LEAST 3 models, with AT LEAST one @relation across them.",
        "HARD MINIMUM — mutation: plan AT LEAST one Server Action under src/app/**/actions.ts that a UI <form action={...}> actually calls, PLUS at least one route handler under src/app/api/.../route.ts. Both must be referenced by tasks that consume them.",
        "HARD MINIMUM — states: every primary route gets explicit empty/loading/error state tasks. Plan loading.tsx and error.tsx siblings where applicable, plus an EmptyState component.",
        "Each task must declare which architecture-plan slot it fulfills using a 'category' tag in its description, drawn from: 'scaffold', 'data-model', 'server-mutation', 'api-route', 'app-shell', 'route-surface', 'component-primitive', 'state-empty-loading-error', 'integration-wire', 'build-verify'.",
        "If the user brief mentions AI / suggestion / recommendation / generation, plan AT LEAST one AI flow: a route handler under src/app/api/ai/.../route.ts with accept/dismiss/revise UI affordances and a local-fallback path.",
        "Decide an auth strategy explicitly: NextAuth, Lucia, signed cookie via Server Action, OR a written justification in 'risks' explaining why no auth is needed. Do not silently skip auth.",
        "Components are named clearly and tied to screens / interactions from the design brief, with Server vs Client component boundaries obvious.",
        "Include domain-named components for app shell/navigation, the signature interaction, product detail, progress/history, and next-action feedback. Avoid generic component names as the main UI surface.",
        "Data models cover every entity the UI displays and mutates. Include id, primary fields, relationships, and which route/action reads or writes them.",
        "State architecture explains what lives in Server Components, what is mutated by Server Actions/API routes, and what ephemeral UI state stays in Client Components.",
        "Env vars list must include any required DATABASE_URL, auth, external API, or Vercel storage values; client-exposed vars must be prefixed NEXT_PUBLIC_.",
        "Quality checks must be blocking when failure would make the app feel like a static mock, a generic template, or a frontend-only demo.",
        "Aim for 10 to 18 tasks. Fewer than 10 is usually too coarse for a complete product.",
      ].join(" "),
    ),
    section("design_brief", "Design Brief", input.designBrief),
    input.designSeed
      ? section(
          "dynamic_context",
          "Design Seed (already applied to the sandbox)",
          [
            "The design seed step ran already. Custom assets and CSS tokens have been written into the sandbox before you plan.",
            "Plan files that IMPORT these assets — do not plan to re-create them. Reference the palette via the CSS variables exposed by the tokens file.",
            "",
            input.designSeed,
          ].join("\n"),
        )
      : undefined,
    section(
      "dynamic_context",
      "Dynamic Context",
      `User brief:\n${input.userBrief}\n\nClarification answers:\n${input.clarificationText || "(none)"}\n\nProject context:\n${input.contextSummary}`,
    ),
    section("output_contract", "Output Contract", "Return valid JSON only. No markdown. No explanations outside the JSON object."),
  ].filter((item): item is PromptSection => Boolean(item));

  const system = withOverrides(renderSections(sections), input.overrides);
  const user = [
    userBlock("User Brief", input.userBrief),
    input.clarificationText ? userBlock("Clarification Answers", input.clarificationText) : "",
    userBlock("Design Brief", input.designBrief),
    input.designSeed ? userBlock("Design Seed", input.designSeed) : "",
    userBlock("Project Context", input.contextSummary),
    input.overrides?.appendUser ? userBlock("Additional User Instructions", input.overrides.appendUser) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { role: "architect", system, user, schemaHint: ARCHITECTURE_PLAN_SCHEMA, sections };
}

/**
 * System prompt for the iterative tool-using coder. The coder is then driven
 * with chat messages and tool results in a loop.
 */
export function composeAgentCoderSystem(input: AgentCoderSystemInput): string {
  const sections = [
    section(
      "agent_contract",
      "Agent Contract",
      [
        "You are the coder inside a session-level coding agent.",
        "You work iteratively, one tool call at a time, until the architecture plan is fully implemented and the app builds.",
        "You operate inside an isolated sandbox workspace. Every file you write goes there. Only the sandbox is modified.",
        "Think before each tool call. Prefer small, verifiable steps over large speculative writes.",
      ].join(" "),
    ),
    section(
      "role_mission",
      "Coder Mission",
      [
        "Implement the architecture plan task by task, in dependency order.",
        "Preserve the product concept from the design brief. If a task is underspecified, choose the more product-real, workflow-oriented interpretation.",
        "MANDATORY DISCOVERY PHASE — your first three tool calls must be: (1) inspect_reference_app with the closest match (bloom-planner / my-season / brain-spin / compact-consumer-app); (2) use_design_skill('frontend-design'); (3) use_design_skill('mobile-app-shell'). The orchestrator hard-blocks write_file / edit_file / delete_file until discovery is complete.",
        "After discovery, you MAY call additional use_design_skill (fullstack-product, ai-assisted-flow) if the product needs them.",
        "After completing each task, call mark_task_done with that task id so the orchestrator can track progress.",
        "FINISH GATE — finish_app automatically re-runs quality_audit and BLOCKS the finish call if any blocking audit check is failing. You must keep iterating until every blocking check passes. Read the audit response carefully; failures include distinct-page-routes (≥3 page routes), component-library (≥8 components under src/components), multiple-models (≥3 Prisma models), model-relations (at least one relation when using Prisma), server-action-wired (any declared Server Action must be referenced via formAction/<form action={...}>), full-state-coverage (loading + empty + error states), and the existing scaffold/visual/durable-state checks.",
        "Before finish_app, also call run_build at least once and ensure it returned success.",
        "If a build fails, read the error, fix the offending files, and re-run build. Repeat until it passes.",
        "Read files before editing them when you are unsure of current content. Do not assume.",
      ].join(" "),
    ),
    section(
      "runtime_constraints",
      "Runtime Constraints",
      [
        "Stack: Next.js 14 App Router + React 18 + TypeScript strict. No Vite, no index.html, no src/main.tsx, no Pages Router.",
        "Write COMPLETE file contents on write_file (no partial writes, no diffs). edit_file is for targeted replacements.",
        "TypeScript strict mode: explicitly type state setters, props, and reducer actions. Use `as const` and explicit unions when narrowing.",
        "When filtering nullable results, never use bare `.filter(Boolean)` before reading properties or passing ids to typed functions. Use a typed predicate: `.filter((item): item is NonNullable<typeof item> => Boolean(item))`.",
        "Server Components are the default. Put 'use client' only in interactive leaf components and never import server-only modules into client files.",
        "Do not use styled-jsx (<style jsx>) inside src/app/page.tsx, src/app/layout.tsx, src/app/loading.tsx, or other Server Component route files. Put route/loading/error styles in src/app/globals.css or CSS Modules so next build does not import client-only from Server Components.",
        "Use Route Handlers under src/app/api/**/route.ts for public APIs/webhooks and Server Actions for in-app mutations. Validate mutation inputs with zod when useful.",
        "Use Prisma + SQLite for sandbox-verifiable persistence unless the architecture plan explicitly chooses Postgres. Include prisma/schema.prisma and a seed or migration path before calling db_migrate.",
        "Initialize database clients and SDKs lazily in getter functions so next build does not require deployment-only env vars at module import time.",
        "Mobile-first 390px viewport. Design must adapt cleanly up to desktop.",
        "Use the libraries declared in the architecture plan and listed in package.json. Do not introduce new dependencies on the fly without updating package.json.",
        "Use server-side persistence for user-modifiable product data. Browser state is only for ephemeral UI such as active tabs, filters, and optimistic controls.",
        "No TODO, lorem ipsum, placeholder copy, or 'coming soon'. Every screen must look like a real product surface.",
      ].join(" "),
    ),
    section(
      "quality_gate",
      "Product Fidelity Contract",
      [
        "Build a usable product, not a visible explanation of the stack. No visible copy may mention Next.js, App Router, React, Prisma, Server Components, Server Actions, API routes, full-stack, sandbox, generated app, architecture plan, prompt, build, prototype, demo, or sample data.",
        "The first viewport must contain product-specific objects and at least one meaningful action or inspection path tied to the user's domain.",
        "Business flows must be complete enough to test visually: choose, filter, log, save, submit, schedule, compare, analyze, or progress something, with visible state changes.",
        "Match compact app ambition similar to Bloom Planner, My Season, and Brain Spin: a named product identity, immersive theme, app shell/navigation, signature interaction, and a progress/history/next-action loop.",
        "Make the result commercially credible: real product vocabulary, believable seed data, useful error/empty/loading states, and multiple surfaces that a user could return to.",
        "Write at least four domain-specific product modules or surfaces, not just one hero and a list.",
        "For learning, coaching, planning, or workflow apps, include concrete curriculum/progression, today's plan, logging, feedback/corrections, history, and next-action surfaces where relevant.",
        "Use domain-specific component names and UI labels. Avoid generic process labels such as 需求澄清, 全栈架构, 沙箱验证, Candidate, Demo, Sample, or Tech Stack.",
      ].join(" "),
    ),
    section(
      "frontend_design",
      "Frontend Quality",
      [
        "Choose and execute a strong domain-specific visual concept. Typography, color, spacing, copy, motion, and interaction states all tie to the brief.",
        "Avoid generic AI demo aesthetics: centered title + search + white cards; Segoe UI / Tahoma / Arial; blue-gray gradients; plain card grids; generic dashboard shadows; stock spacing.",
        "Create a distinct app world: themed background, domain-specific controls, tactile cards or panels, purposeful icons, and responsive mobile composition.",
        "Every interactive control must produce a visible state change. No dead buttons.",
        "Seed/demo data must feel real and specific to the product domain, and should flow through server-side modules or database seed logic.",
      ].join(" "),
    ),
    section("design_brief", "Design Brief", input.designBrief),
    input.designSeed
      ? section(
          "frontend_design",
          "Design Seed (apply verbatim)",
          [
            "A design_seed has been resolved BEFORE this loop. Custom SVG components and CSS token files have already been written to the sandbox — you do not need to invent them.",
            "Treat the palette colors, typography stacks, motion language, and anti-patterns as binding constraints. The visual_critic will fail your candidate if you ignore them or substitute generic alternatives.",
            "Import the seeded assets directly. For example, import the brand mark from src/components/icons/* and import src/styles/design-tokens.css inside src/app/layout.tsx or src/app/globals.css so the CSS variables are available throughout.",
            input.preloadedAssets?.length
              ? `Preloaded asset paths (already in the sandbox): ${input.preloadedAssets.join(", ")}`
              : "",
            "",
            input.designSeed,
          ]
            .filter(Boolean)
            .join("\n"),
        )
      : undefined,
    section("dynamic_context", "Architecture Plan", input.architecturePlan),
    section(
      "dynamic_context",
      "Tool Catalog",
      [
        "Available tools (call by name with JSON arguments):",
        input.toolCatalog,
        "Best practices:",
        "- list_files first when you need a workspace overview.",
        "- read_file before edit_file. Never edit blind.",
        "- write_file for new files and full rewrites.",
        "- run_command may run npm install, npm run build, next build, next dev, and prisma migrate dev when needed.",
        "- db_migrate validates Prisma/database migrations in the sandbox. Use it after schema or migration changes.",
        "- vercel_env_set records required Vercel env vars when deployment needs secrets or managed storage values.",
        "- use_design_skill returns compact guidance from built-in design/product skills. Use it before writing the app shell or visual system.",
        "- inspect_reference_app returns safe reference-app profiles for Bloom Planner, My Season, Brain Spin, or compact consumer app patterns.",
        "- quality_audit scans the current sandbox for product, frontend, backend, and persistence risks. Run it before finish_app.",
        "- run_build only after a meaningful chunk of work, not after every file.",
        "- mark_task_done immediately after finishing each task.",
        "- finish_app at the very end with a short summary. Do NOT call finish_app while any task is still pending.",
      ].join("\n"),
    ),
    section(
      "dynamic_context",
      "User Intent",
      `User brief:\n${input.userBrief}\n\nClarification answers:\n${input.clarificationText || "(none)"}`,
    ),
    section(
      "output_contract",
      "Output Contract",
      "Always respond by calling exactly one tool. Reasoning may go into the tool arguments' description fields, but every assistant turn must end with a tool call until finish_app is invoked.",
    ),
  ].filter((item): item is PromptSection => Boolean(item));

  return withOverrides(renderSections(sections), input.overrides);
}

export function formatArchitecturePlanForPrompt(plan: ArchitecturePlan): string {
  const lines: string[] = [];
  lines.push(`Summary: ${plan.summary}`);
  lines.push(`Tech stack: ${plan.techStack.join(", ") || "(none)"}`);
  lines.push(`State architecture: ${plan.stateArchitecture}`);
  lines.push(`Server architecture: ${plan.serverArchitecture || "(none)"}`);
  lines.push(
    `Data store: ${[
      plan.dataStore?.provider,
      plan.dataStore?.orm ? `orm=${plan.dataStore.orm}` : "",
      plan.dataStore?.schemaPath ? `schema=${plan.dataStore.schemaPath}` : "",
    ]
      .filter(Boolean)
      .join(", ") || "(none)"}`,
  );
  if (plan.dataStore?.migrationStrategy || plan.dataStore?.seedStrategy || plan.dataStore?.persistenceNotes) {
    lines.push(
      `Data store notes: ${[
        plan.dataStore.migrationStrategy ? `migration=${plan.dataStore.migrationStrategy}` : "",
        plan.dataStore.seedStrategy ? `seed=${plan.dataStore.seedStrategy}` : "",
        plan.dataStore.persistenceNotes,
      ]
        .filter(Boolean)
        .join("; ")}`,
    );
  }
  if (plan.deployment) {
    lines.push(`Deployment: ${plan.deployment}`);
  }

  lines.push("");
  lines.push("File tree:");
  for (const node of plan.fileTree) {
    const deps = node.dependencies?.length ? ` (depends on: ${node.dependencies.join(", ")})` : "";
    lines.push(`  - ${node.path} — ${node.purpose}${deps}`);
  }

  if (plan.dataModels.length > 0) {
    lines.push("");
    lines.push("Data models:");
    for (const model of plan.dataModels) {
      lines.push(`  - ${model.name}: ${model.description}`);
      for (const field of model.fields) {
        const desc = field.description ? ` (${field.description})` : "";
        lines.push(`      • ${field.name}: ${field.type}${desc}`);
      }
    }
  }

  if (plan.components.length > 0) {
    lines.push("");
    lines.push("Components:");
    for (const component of plan.components) {
      const props = component.props?.length ? ` props=[${component.props.join(", ")}]` : "";
      const uses = component.uses?.length ? ` uses=[${component.uses.join(", ")}]` : "";
      lines.push(`  - ${component.name} (${component.filePath}) — ${component.purpose}${props}${uses}`);
    }
  }

  if (plan.routes.length > 0) {
    lines.push("");
    lines.push("Routes:");
    for (const route of plan.routes) {
      const file = route.filePath ? ` (${route.filePath})` : "";
      const rendering = route.rendering ? ` [${route.rendering}]` : "";
      lines.push(`  - ${route.path} → ${route.component}${file}${rendering}: ${route.description}`);
    }
  }

  if (plan.apiEndpoints.length > 0) {
    lines.push("");
    lines.push("API endpoints:");
    for (const endpoint of plan.apiEndpoints) {
      const runtime = endpoint.runtime ? ` runtime=${endpoint.runtime}` : "";
      lines.push(`  - ${endpoint.method} ${endpoint.path} (${endpoint.filePath})${runtime}: ${endpoint.purpose}`);
      if (endpoint.request || endpoint.response || endpoint.auth) {
        lines.push(
          `      contract: ${[
            endpoint.request ? `request=${endpoint.request}` : "",
            endpoint.response ? `response=${endpoint.response}` : "",
            endpoint.auth ? `auth=${endpoint.auth}` : "",
          ]
            .filter(Boolean)
            .join("; ")}`,
        );
      }
    }
  }

  if (plan.serverActions.length > 0) {
    lines.push("");
    lines.push("Server actions:");
    for (const action of plan.serverActions) {
      lines.push(`  - ${action.name} (${action.filePath}) — ${action.purpose}`);
      if (action.input || action.effects?.length) {
        lines.push(
          `      ${[
            action.input ? `input=${action.input}` : "",
            action.effects?.length ? `effects=${action.effects.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ")}`,
        );
      }
    }
  }

  if (plan.envVars.length > 0) {
    lines.push("");
    lines.push("Environment variables:");
    for (const envVar of plan.envVars) {
      const required = envVar.required ? "required" : "optional";
      const scope = envVar.scope ? `, ${envVar.scope}` : "";
      const example = envVar.example ? `, example=${envVar.example}` : "";
      lines.push(`  - ${envVar.name} (${required}${scope}${example}): ${envVar.purpose}`);
    }
  }

  if (plan.integrations.length > 0) {
    lines.push("");
    lines.push("Integrations:");
    for (const integration of plan.integrations) {
      const envVars = integration.envVars?.length ? ` env=[${integration.envVars.join(", ")}]` : "";
      const serverFiles = integration.serverFiles?.length ? ` files=[${integration.serverFiles.join(", ")}]` : "";
      lines.push(`  - ${integration.name}: ${integration.purpose}${envVars}${serverFiles}`);
    }
  }

  if (plan.externalCapabilities?.length) {
    lines.push("");
    lines.push("External capabilities to consult:");
    for (const capability of plan.externalCapabilities) {
      lines.push(`  - ${capability.name}: ${capability.purpose}`);
      lines.push(`      trigger: ${capability.trigger}`);
      lines.push(`      output: ${capability.expectedOutput}`);
      if (capability.constraints.length) {
        lines.push(`      constraints: ${capability.constraints.join("; ")}`);
      }
    }
  }

  if (plan.qualityChecks?.length) {
    lines.push("");
    lines.push("Blocking quality checks:");
    for (const check of plan.qualityChecks) {
      const blocking = check.blocking ? "blocking" : "advisory";
      lines.push(`  - ${check.id} [${check.category}, ${blocking}]: ${check.requirement}`);
      lines.push(`      evidence: ${check.evidence}`);
    }
  }

  lines.push("");
  lines.push("Tasks (in execution order):");
  for (const task of plan.tasks) {
    const deps = task.dependsOn?.length ? ` [after: ${task.dependsOn.join(", ")}]` : "";
    lines.push(`  • ${task.id}: ${task.title}${deps}`);
    lines.push(`      description: ${task.description}`);
    lines.push(`      files: ${task.files.join(", ") || "(none)"}`);
    lines.push(`      acceptance: ${task.acceptance}`);
  }

  if (plan.risks?.length) {
    lines.push("");
    lines.push("Risks:");
    for (const risk of plan.risks) {
      lines.push(`  ! ${risk}`);
    }
  }

  return lines.join("\n");
}
