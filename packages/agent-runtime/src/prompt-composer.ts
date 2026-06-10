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
  experienceBlueprint?: string;
  /** Optional rendered design seed text — drives concrete file planning. */
  designSeed?: string;
  overrides?: PromptOverrides;
}

export interface AgentCoderSystemInput {
  userBrief: string;
  clarificationText: string;
  designBrief: string;
  experienceBlueprint?: string;
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
        "The agent builds local Next.js 14 App Router applications with real server routes, typed data boundaries, local-first options when requested, and deployable Vercel-compatible structure.",
        "Your job is to decide whether the user brief is clear enough to generate, and only ask when ambiguity would materially change the product.",
      ].join(" "),
    ),
    section(
      "role_mission",
      "Clarifier Mission",
      [
        "Return action=ready with an empty questions array when the user already specified product type, target users or scenario, core screens/flows, content/data direction, and visual direction well enough for a first candidate.",
        "Return action=ask only when missing information would materially change visible UX, screens, flows, data persistence, user/auth needs, integrations, content, or mobile interaction choices.",
        "If the brief names a feature but not its exact UI mechanics, choose a sensible first-version pattern instead of asking; implementation details can be decided by the design and architecture agents.",
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
        "Generate a lightweight but complete Next.js 14 App Router + TypeScript application that can be installed, built, run locally, and deployed to Vercel.",
        "Return the complete file set needed by the app, not a patch or explanation.",
      ].join(" "),
    ),
    section(
      "runtime_constraints",
      "Runtime Constraints",
      [
        "Use Next.js 14 App Router, React 18, TypeScript strict, Server Components by default, and CSS Modules or src/app/globals.css for styling.",
        "Include package.json, next.config.mjs, tsconfig.json, next-env.d.ts, src/app/layout.tsx, src/app/page.tsx, src/app/globals.css, and every imported component, lib, data, action, route handler, database, or env file.",
        "Default to a compact Vercel-ready file tree like the reference apps: one primary route, optional route-equivalent tab/surface components, typed src/lib/demo-data.ts, and browser/local component state for user-owned drafts or saved items.",
        "Keep package.json lean: next, react, react-dom, TypeScript/types, and only small helpers that materially help the brief such as lucide-react, zod, clsx, or date-fns.",
        "Use 'use client' only for interactive leaf components. Keep data loading, persistence, and secrets on the server side.",
        "Dynamic App Router page files should stay Server Components that accept params and pass data into client children. Do not call notFound() from a 'use client' page; render a client fallback state instead if the page itself must be client-side.",
        "When the user requests static curated data, local-only personal use, no login/backend/API, or browser localStorage, use typed domain models in src/lib/demo-data.ts, optional route handlers for reads, and localStorage/IndexedDB only for user-owned saved records.",
        "Use Route Handlers, Server Actions, Prisma, SQLite/Postgres, auth, or external SDKs only when the brief explicitly requires server persistence, multi-user data, admin/backend workflows, real integrations, or login.",
        "If database clients or service SDKs require env vars, initialize them lazily inside getter functions so next build does not fail when deployment-only variables are absent.",
        "The app is viewed inside an iPhone-like preview, so design mobile-first for a 390px wide viewport before expanding to desktop.",
        "TypeScript must compile in strict mode: when mapping navigation tabs, filters, or page ids into useState setters, type ids with explicit unions/as const or keep the state type compatible with string.",
        "TypeScript strict also means array indexing and optional data must be narrowed: avoid returning (T | undefined)[] from maps, use typed filters, fallback values, or data structures whose elements are known present.",
        "When renaming or adding domain fields during repair, update the type/interface, seed data, and every component access together. For travel place details, fields such as whyGo, bestTime, transport, photoTip, nearby, address, openTime, duration, and rainyTip must exist on the Place type and in seed data before any component reads place.<field>. For travel budgets, choose one field name such as costPerPerson or cost and use it consistently; do not leave components reading place.cost when data only defines costPerPerson.",
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
        "Interaction model is mandatory, not decorative: implement a real control set for the domain such as date/month switching, segmented filters, editable records, swipe/scroll or carousel navigation, long-press/context actions, auto-focus on primary input, and grouped history/progress views when the product implies them.",
        "For diary, journal, tracker, checklist, planner, habit, mood, note, or local-input products, the first candidate must include text entry with focus treatment, save/edit/delete or revise actions, date navigation, grouped history, and a visible saved/completed state.",
        "Every interaction in the design brief must map to code-level evidence: useState/useReducer state, form action or event handler, selected/active styling, ARIA label when appropriate, and a visible before/after state.",
        "Use lucide-react icons when helpful, and make controls feel like product controls rather than text blocks.",
        "For travel/lifestyle apps, prefer editorial mobile composition, destination-specific content, bottom navigation or thumb-friendly controls, saved states, itinerary/story details, and image treatments that feel intentional. Render destination/place media with actual <img> elements using local SVG/data URLs or stable remote URLs with alt text; do not rely only on background-color divs for required images.",
        "For travel itineraries, links like /itinerary/1, /itinerary/2, /itinerary/3 and /location/{id} must resolve to working detail routes with visible content, media, and controls. If you link numeric day URLs, implement src/app/itinerary/[day]/page.tsx so numeric params work.",
        "For static travel seed data, use deterministic ids/slugs such as day-1 and jingan-temple; do not generate route ids with nanoid, randomUUID, Math.random, Date.now, or runtime counters because dynamic routes and static params must remain stable.",
        "For multi-day travel itineraries, each default day should carry at least four concrete stops/places, rainy/alternate plans should still have at least three useful stops, and place detail pages need deeper fields such as whyGo, bestTime, transport, photoTip, nearby, booking/reservation, or rainyTip rather than only reusing a one-sentence card description.",
        "For travel apps with favorites/saved routes, implement first-load saved items plus localStorage persistence, segmented type filters, remove controls, and a separate must-visit/star toggle on both place detail and saved/favorites cards.",
        "For travel budget pages, show daily subtotals and category totals for food, tickets, and local transport with at least one visible filter or expand/collapse state.",
        "For travel place visuals, key visuals by place id/slug/name or per-place image fields. A single generic scenic/dining illustration reused for every place is not enough, even if it technically renders role=\"img\".",
        "For media-heavy products such as travel, dining, venues, portfolios, galleries, catalogs, or product showcases, prefer visible source-declared media: either <img>/<Image> with src+alt, or CSS-only illustrated blocks marked with role=\"img\" and data-visual plus a descriptive aria-label. Give those blocks stable dimensions and painted foreground details, not just page background gradients.",
        "For media-heavy products, the home/first route should contain visible media on repeated cards or hero content; media only on detail routes is weaker but not an engineering blocker.",
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
        "The app must have at least 3 product modules or route-equivalent surfaces in the code and UI, such as Today, Plan, Detail, Log, Progress, Feedback, History, Saved, or Settings, adapted to the domain.",
        "A single App Router page is acceptable for lightweight apps when it contains real tab/segment/detail/history surfaces with useful content and visible state changes; add extra routes only when the product flow benefits from addressable URLs.",
        "Use product-specific component names, copy, and data that match the domain. Avoid generic sections like 需求澄清, 全栈架构, 沙箱验证, Candidate, Demo, Sample, or Tech Stack.",
        "If the user asks for software that plans, teaches, tracks, sells, books, coordinates, or analyzes something, include one end-to-end primary flow with realistic state changes and server-backed data boundaries.",
        "If the product centers on user input or local records, missing edit/revise, date switching, history grouping, focus treatment, or filter/sort controls is a blocking product failure.",
      ].join(" "),
    ),
    section(
      "quality_gate",
      "Quality Gate",
      [
        "The result must feel like a product candidate, not a tutorial sample.",
        "Use production-like copy and seed/demo data through typed src/lib data modules, server-side modules, Prisma seed data when a database is intentionally used, or route handlers. Do not describe it as static sample data in the UI.",
        "Expose server-side capabilities only when the product calls for them: route handler, Server Action, auth/session boundary, database read/write, webhook placeholder, or external API integration facade.",
        "No TODO, lorem ipsum, coming soon, placeholder descriptions, empty states without useful guidance, or broken imports.",
        "Every primary control shown should have a visible state change, filtering, tab switch, selection, or navigation effect when reasonable.",
        "If the domain naturally involves places, photos, products, food, venues, artwork, or cards to inspect, repeated cards should include a visible media/illustration treatment that source and preview inspection can recognize as media, not just descriptive text.",
        "For travel itineraries, under-filled day plans and shallow detail routes are blocking failures: each visible day plan needs enough stops to be useful, and every linked place/detail route must contain itinerary-specific advice, logistics, and media.",
        "If the app includes favorites/saved/bookmarks routes, seed them with visible saved items from the domain data plus filters and remove/star actions; do not make the saved route only an empty state on first load, and do not hide all populated cards behind empty localStorage.",
        "Before returning files, self-check the interaction model: primary input focuses visually, save/submit has pending and success states, records can be revisited, edited or filtered, date/time/history views can change, and the UI shows the result of those changes.",
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

export function composeRepairPrompt(input: RepairPromptInput): ComposedPrompt {
  const base = composeCoderPrompt(input);
  const repairSections = [
    section(
      "role_mission",
      "Repairer Mission",
      [
        "You are the repairer. Fix the current generated app so it passes validation, build, and blocking engineering checks. Product-quality findings are advisory unless explicitly marked blocking.",
        "Return full file contents for every file you changed or added; unchanged files may be omitted because the runtime merges them with the current app.",
        "When repair requires broad product changes, prioritize source files that own data, routing, visible cards, detail views, navigation, and CSS over generated build artifacts.",
        "If validation says pages are thin, media is missing, controls are not functional, or routes have placeholder/detail gaps, you must return concrete source-file changes that add the missing content, media evidence, and state transitions. Do not answer with prose-only analysis.",
        "Keep the user's requested product and data, but rewrite weak UI, generic composition, placeholder copy, and broken code aggressively.",
        "When a build error reports a missing property, fix the data contract at the source: inspect the interface, seed records, and component usage, then make the field name consistent everywhere rather than adding another mismatched alias.",
        "When strict TypeScript reports possibly undefined values or arrays such as (T | undefined)[], narrow with typed filters, guard clauses, fallback values, or keyed maps whose lookups are proven before render; do not weaken tsconfig or silence the error.",
      ].join(" "),
    ),
    section(
      "dynamic_context",
      "Repair Context",
      `Validation issues:\n${input.issues}\n\nBuild log:\n${input.buildLog || "(none)"}\n\nCurrent files:\n${input.currentFiles}`,
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
    userBlock("Current Files", input.currentFiles),
    input.overrides?.appendUser ? userBlock("Additional User Instructions", input.overrides.appendUser) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { role: "repairer", system, user, schemaHint: GENERATED_APP_SCHEMA, sections };
}

export function formatDesignBriefForPrompt(brief: DesignBrief, experienceBlueprint?: { domain: string } | string): string {
  const lines = [
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
  ];
  if (experienceBlueprint) {
    lines.push("");
    lines.push("Experience blueprint:");
    lines.push(typeof experienceBlueprint === "string" ? experienceBlueprint : `Domain: ${experienceBlueprint.domain}`);
  }
  return lines.join("\n");
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
        "Translate the design brief into an executable engineering plan for a mobile-first lightweight Next.js 14 App Router + TypeScript app.",
        "Decide the smallest complete file tree, route or route-equivalent surfaces, data models, storage plan, optional API route handlers or Server Actions, component decomposition, client/server boundaries, state architecture, env vars, deployment notes, and ordered task list.",
        "Each task must be a small, verifiable unit: typically 1 to 4 files, with explicit acceptance criteria.",
        "Plan from user-visible product flows backwards. Name at least two primary user flows in the tasks and connect each to UI, data, mutation, and validation work.",
        "Plan compact app structure explicitly: app shell/navigation or segmented controls, home/current-state surface, detail/action surface, and progress/history or saved surface when appropriate.",
        "Plan the interaction model as an executable contract, not prose: list the state variables, events, mutations, active/selected visual states, and before/after UI evidence for each primary flow.",
        "For diary, journal, tracker, checklist, planner, habit, mood, note, or local-input products, include tasks for primary input focus, save pending/success, edit/revise/delete affordances, date/month navigation, grouped history, and filters or sort controls.",
        "Order tasks by dependency: project config and env/storage contract first, typed data/seed/server libs next, route handlers or Server Actions, UI primitives, route pages, integration wiring, then build verification.",
        "Plan for product depth without unnecessary scaffold: real interactions, typed data contracts, compact surfaces, deployment-aware boundaries, and server-side read/mutation surfaces only when the brief calls for them.",
        "Include externalCapabilities for any controlled tool or skill guidance the coder should consult, such as use_design_skill for frontend systems and inspect_reference_app for Bloom Planner or My Season patterns.",
        "Include qualityChecks that prove the app is closed-loop: visible product modules, data schema, read/write APIs or Server Actions, mutation validation, visual/mobile evidence, and deployment/env readiness.",
        "Aim for 3 to 4 tasks total. Lightweight local-first apps should prefer 3 tasks: scaffold/data, compact app surface, and build verification. Merge product polish into those tasks instead of creating extra bookkeeping tasks.",
      ].join(" "),
    ),
    section(
      "runtime_constraints",
      "Runtime Constraints",
      [
        "Stack: Next.js 14 App Router, React 18, TypeScript strict, Server Components by default, CSS Modules or globals.css. No Vite, no Pages Router, no React Router.",
        "Use Next.js file-system routing under src/app. Use route.ts for public APIs/webhooks and Server Actions for in-app form mutations only when server behavior is explicitly needed.",
        "Do not put <style jsx> in App Router convention files such as page.tsx, layout.tsx, loading.tsx, or error.tsx unless the file is explicitly a Client Component. Prefer src/app/globals.css or CSS Modules.",
        "By default, choose provider=memory and orm=none: typed src/lib/demo-data.ts for domain records, browser storage for user-owned saved/checklist/journal state, and no DATABASE_URL.",
        "Use Prisma with SQLite/Postgres only when true server persistence is explicitly required; include prisma/schema.prisma and migration/seed notes only when database persistence is planned.",
        "You MAY use lightweight libraries that materially help complexity, declared in package.json: lucide-react for icons, zod for validation, clsx for classes, date-fns for date math. Add prisma/@prisma/client only for explicit database plans.",
        "Never invent private SDK package names such as @训练档案/client, @data/client, or @domain/client. Data access must import from @prisma/client, local files under @/lib/*, or a real dependency explicitly listed in package.json.",
        "Mobile-first 390px viewport, designed to also adapt up to desktop.",
        "Do not reject browser localStorage when the user explicitly asks for local-only personal persistence. In that case, keep curated product data in typed modules and use browser storage for user-owned records with defensive parsing and visible offline/local-save states.",
        "File tree must include: package.json, next.config.mjs, tsconfig.json, next-env.d.ts, src/app/layout.tsx, src/app/page.tsx, src/app/globals.css, plus only the components/lib/storage/api/db files you actually plan.",
        "Treat the returned JSON as a machine-readable architecture contract. The orchestrator will preload the fixed scaffold files and will augment missing baseline entries, so your plan should declare how product code replaces or extends that scaffold.",
      ].join(" "),
    ),
    section(
      "quality_gate",
      "Plan Quality Bar (HARD MINIMUMS — orchestrator augments missing items)",
      [
        "Tasks must be specific enough that an LLM coder cannot misinterpret them.",
        "The first task must satisfy the baseline scaffold contract, and the final task must run build/quality_audit and close the app. Keep those tasks even for tiny apps.",
        "Each task lists exactly the files it touches and what 'done' means. Acceptance criteria must be user-visible flow outcomes, not only 'file exists', 'component renders', or 'build passes'.",
        "File tree paths are real (e.g. src/app/trips/page.tsx, src/app/api/trips/route.ts, src/lib/db.ts, prisma/schema.prisma), not placeholders.",
        "HARD MINIMUM — surfaces: plan one strong primary route plus at least 3 route-equivalent product surfaces through tabs, segmented controls, detail panels, history/progress modules, or saved lists. Prefer in-page surfaces for lightweight local-first apps; add extra routes only when addressable URLs materially help the product.",
        "HARD MINIMUM — components: plan the smallest useful component set, typically 1 to 4 files under src/components. A single large client workbench is acceptable when it keeps the app lighter and clearer.",
        "HARD MINIMUM — data: define at least 1 typed domain model. For local-first apps, src/lib/demo-data.ts should export typed models and realistic records that cover visible entities. For Prisma apps, schema depth should match the requested persistence, not an arbitrary model count.",
        "HARD MINIMUM — mutation: when the product has user-owned state, plan a real mutation boundary. For local-first apps, client event handlers plus browser storage are enough; for server-persisted apps, use Server Actions or Route Handlers.",
        "HARD MINIMUM — states: plan visible empty, loading or pending, error/recovery, and success/completed states inline or as small components. Add loading.tsx/error.tsx only when route-level boundaries are useful.",
        "HARD MINIMUM — interaction model: plan at least three distinct domain interactions beyond plain navigation, such as save/submit, edit/revise/delete, filter/sort, date/month switch, expand/collapse, carousel/swipe/scroll selection, long-press/context action, focus-on-input, accept/dismiss/revise, or status toggle. Each interaction must name the component, state/mutation boundary, and visible outcome.",
        "MEDIA GUIDANCE — media-heavy domains: for travel, dining, venues, portfolios, galleries, catalogs, or product showcases, plan imageAlt/visualLabel data and a reusable visual component that renders <img>/<Image> media or role=\"img\" data-visual CSS illustrations on repeated cards and detail surfaces.",
        "HARD MINIMUM — travel itineraries: if planning a multi-day trip, plan at least 3 day records with at least 4 default place ids/stops per day, at least 3 rainy/alternate stops where alternates are offered, a dynamic day route, a dynamic place/location route, and per-place detail fields beyond description/tips.",
        "MEDIA GUIDANCE — travel visuals: plan place-specific media fields or a visual map keyed by place id/slug/name. Avoid one type-only scenic/dining/default illustration for all places when the brief cares about place inspection.",
        "Each task must declare which architecture-plan slot it fulfills using a 'category' tag in its description, drawn from: 'scaffold', 'data-model', 'server-mutation', 'api-route', 'app-shell', 'route-surface', 'component-primitive', 'state-empty-loading-error', 'integration-wire', 'build-verify'.",
        "Add a blocking qualityCheck named interaction-model-completeness that verifies the design brief's interactionModel is implemented with visible state changes, not just buttons or static copy.",
        "If the user brief mentions AI / suggestion / recommendation / generation, plan AT LEAST one AI flow: a route handler under src/app/api/ai/.../route.ts with accept/dismiss/revise UI affordances and a local-fallback path.",
        "Decide an auth strategy explicitly: NextAuth, Lucia, signed cookie via Server Action, OR a written justification in 'risks' explaining why no auth is needed. Do not silently skip auth.",
        "Components are named clearly and tied to screens / interactions from the design brief, with Server vs Client component boundaries obvious.",
        "Include domain-named components for app shell/navigation, the signature interaction, product detail, progress/history, and next-action feedback. Avoid generic component names as the main UI surface.",
        "Include domain-named client components for the main interaction controls: e.g. DiaryComposer, MoodSelector, MonthSwitcher, HistoryGroupList, EditEntrySheet, FilterRail, SwipeDateStrip, or equivalents for the user's domain.",
        "Data models cover every entity the UI displays and mutates. Include id, primary fields, relationships or references, and which route/action/client storage flow reads or writes them.",
        "State architecture explains what lives in Server Components, what is mutated by Server Actions/API routes or local storage when explicitly requested, and what ephemeral UI state stays in Client Components.",
        "Env vars list must include any required DATABASE_URL, auth, external API, or Vercel storage values; client-exposed vars must be prefixed NEXT_PUBLIC_.",
        "Quality checks must be blocking when failure would make the app feel like a static mock, a generic template, or a frontend-only demo.",
        "Aim for 3 to 4 tasks. More than 4 should be merged to keep the output lightweight and finishable within one agent loop.",
      ].join(" "),
    ),
    section("design_brief", "Design Brief", input.designBrief),
    input.experienceBlueprint
      ? section(
          "dynamic_context",
          "Experience Blueprint",
          [
            "This blueprint is mandatory and user-visible. It defines the real content, flows, states, and acceptance scenarios the product must implement.",
            "Treat it as the bridge between design strategy and code. Architecture tasks must map to these records, controls, state changes, and scenarios.",
            input.experienceBlueprint,
          ].join("\n\n"),
        )
      : undefined,
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
    input.experienceBlueprint ? userBlock("Experience Blueprint", input.experienceBlueprint) : "",
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
        "A functional mobile starter scaffold is already preloaded in the sandbox: package.json, next.config.mjs, tsconfig.json, next-env.d.ts, src/app/layout.tsx, src/app/page.tsx, and src/app/globals.css. It includes local state, add/status/order/review controls, localStorage, and mobile CSS. Treat it as the minimum product floor: extend or rewrite it so the user's requested domain flows are complete, but do not delete these baseline files.",
        "MANDATORY DISCOVERY PHASE — before writing files, call inspect_reference_app with the closest match (bloom-planner / my-season / brain-spin / compact-consumer-app), then use_design_skill('frontend-design'). The orchestrator hard-blocks write_file / edit_file / delete_file until discovery is complete.",
        "After discovery, you MAY call additional use_design_skill (mobile-app-shell, fullstack-product, ai-assisted-flow) only if the product needs that extra guidance.",
        "After completing each task, call mark_task_done with that task id so the orchestrator can track progress.",
        "FINISH GATE — finish_app automatically re-runs quality_audit and BLOCKS the finish call only when hard engineering checks fail, such as missing Next.js scaffold, broken imports, deploy-contract issues, strict TypeScript hazards, or App Router client-boundary problems. Static audit may treat product depth as advisory, but architecture tasks are not complete until the visible user flows, state changes, and mobile preview surface requested by the brief are implemented.",
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
        "Keep the baseline scaffold contract intact. If you move UI into components, src/app/page.tsx must still import/render it, src/app/layout.tsx must still import globals.css, and package.json must keep dev/build/start scripts.",
        "Write COMPLETE file contents on write_file (no partial writes, no diffs). edit_file is for targeted replacements.",
        "TypeScript strict mode: explicitly type state setters, props, and reducer actions. Use `as const` and explicit unions when narrowing.",
        "When filtering nullable results, never use bare `.filter(Boolean)` before reading properties or passing ids to typed functions. Use a typed predicate: `.filter((item): item is NonNullable<typeof item> => Boolean(item))`.",
        "If you add or rename fields in typed domain data, update all component props and all usages in the same pass. For travel place details, do not read place.bestTime, place.transport, place.photoTip, place.nearby, place.address, or similar fields unless the Place interface/type and every seed place object define them. For travel costs, use either costPerPerson everywhere or cost everywhere; never mix costPerPerson data with place.cost UI reads.",
        "Server Components are the default. Put 'use client' only in interactive leaf components and never import server-only modules into client files.",
        "Keep dynamic src/app/**/[param]/page.tsx files as Server Components that receive params and render or pass typed data into client children. Never call notFound() inside a 'use client' page; use a server wrapper or render a client fallback state.",
        "Do not use styled-jsx (<style jsx>) inside src/app/page.tsx, src/app/layout.tsx, src/app/loading.tsx, or other Server Component route files. Put route/loading/error styles in src/app/globals.css or CSS Modules so next build does not import client-only from Server Components.",
        "Use Route Handlers under src/app/api/**/route.ts for public APIs/webhooks and Server Actions for in-app mutations only when the plan asks for server behavior. Validate mutation inputs with zod when useful.",
        "Follow the architecture plan's storage choice exactly. For local-first plans, do not add Prisma or DATABASE_URL; implement typed data modules, local storage helpers, and optional read-only route handlers. For database plans, use Prisma + SQLite unless the architecture plan explicitly chooses Postgres.",
        "For local-first or static-export plans, do not introduce Server Actions, revalidatePath, Prisma, DATABASE_URL, or mutable API routes while fixing quality_audit. Satisfy mutation and persistence gates with client state, defensive browser storage when needed, typed src/lib data modules, visible saved/saving/error states, and optional read-only GET routes.",
        "Initialize database clients and SDKs lazily in getter functions so next build does not require deployment-only env vars at module import time.",
        "Never invent private SDK package names such as @训练档案/client, @data/client, or @domain/client. Data access must import from @prisma/client, local files under @/lib/*, or a real dependency explicitly listed in package.json.",
        "Mobile-first 390px viewport. Design must adapt cleanly up to desktop.",
        "Use the libraries declared in the architecture plan and listed in package.json. Do not introduce new dependencies on the fly without updating package.json.",
        "Use server-side persistence for user-modifiable product data when the architecture plan calls for durable server storage. When the user explicitly requested local-only/browser storage, browser storage is the real persistence layer for user-owned records and must have defensive loading, save/delete/edit flows, and visible saved/offline state.",
        "No TODO, lorem ipsum, placeholder copy, or 'coming soon'. Every screen must look like a real product surface.",
      ].join(" "),
    ),
    section(
      "quality_gate",
      "Product Fidelity Contract",
      [
        "Build a usable product, not a visible explanation of the stack. No visible copy may mention Next.js, App Router, React, Prisma, Server Components, Server Actions, API routes, full-stack, sandbox, generated app, architecture plan, prompt, build, prototype, demo, or sample data.",
        "The first viewport must contain product-specific objects and at least one meaningful action or inspection path tied to the user's domain.",
        "Business flows must expose visible state changes: choose, filter, log, save, submit, schedule, compare, analyze, or progress something with source-visible controls and outcomes.",
        "The interaction model must be testable from source and preview-visible state: active/selected states, edit/revise/delete or equivalent secondary actions, filter/sort or date/month switching when relevant, grouped history/progress, focus styling on primary inputs, and visible before/after outcomes.",
        "Match compact app ambition similar to Bloom Planner, My Season, and Brain Spin: a named product identity, immersive theme, app shell/navigation, signature interaction, and a progress/history/next-action loop.",
        "Make the result commercially credible: real product vocabulary, believable seed data, useful error/empty/loading states, and multiple surfaces that a user could return to.",
        "Write at least three domain-specific product modules or route-equivalent surfaces, not just one hero and a list.",
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
        "For travel, dining, venue, portfolio, gallery, catalog, product, or other media-heavy apps, prefer visible media on the first screen and repeated cards: use <img>/<Image> with src+alt, or a role=\"img\" data-visual CSS illustration with stable dimensions, foreground shapes, and a meaningful aria-label.",
        "For travel itineraries, homepage and itinerary links such as /itinerary/1, /itinerary/2, /itinerary/3 and /location/{id} must land on working detail pages with their own headings, destination media, weather/favorite/detail controls, and non-empty text. Numeric day links require numeric param support.",
        "For multi-day travel itineraries, each default day must include at least four concrete stops/places; rainy/alternate plans must remain useful with at least three stops; place/location detail pages must render specific logistics and story fields such as whyGo, bestTime, transport, nearby, photoTip, reservation, and rainyTip.",
        "For travel visuals, use per-place image/visual data or a visual map keyed by place id/slug/name. Do not satisfy media gates with one generic illustration that only switches by scenic/dining/type.",
        "For favorites/saved/bookmarks routes, render populated saved-item cards by default from typed seed data, plus visible filters and remove/star/must-go controls; an empty-state-only route or a route that hides all cards until localStorage has user data is a blocking failure.",
        "Every interactive control must produce a visible state change. No dead buttons.",
        "For input-heavy apps, include focus-visible styling, autoFocus or an obvious primary input affordance, editing/revision affordances, date or period navigation, and grouped record/history controls. A static list plus save button is not enough.",
        "Seed/demo data must feel real and specific to the product domain, and should flow through typed data modules, server-side modules, or database seed logic when a database is intentionally used.",
      ].join(" "),
    ),
    section("design_brief", "Design Brief", input.designBrief),
    input.experienceBlueprint
      ? section(
          "dynamic_context",
          "Experience Blueprint (mandatory)",
          [
            "The architect prepared this experience blueprint before coding. Implement it concretely.",
            "Use the seed records as product data, wire the primary flow, and make every listed interaction state visible.",
            "The acceptance scenarios are not optional; quality_audit should be able to find source evidence for them.",
            input.experienceBlueprint,
          ].join("\n\n"),
        )
      : undefined,
    input.designSeed
      ? section(
          "frontend_design",
          "Design Seed (apply verbatim)",
          [
            "A design_seed has been resolved BEFORE this loop. Custom SVG components and CSS token files have already been written to the sandbox — you do not need to invent them.",
            "Treat the palette colors, typography stacks, motion language, and anti-patterns as binding constraints, while prioritizing a buildable and usable app over subjective polish.",
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
        "- run_command may run npm install, npm run build, next build, next dev, and prisma migrate dev only when needed.",
        "- db_migrate validates Prisma/database migrations in the sandbox. Use it only after schema or migration changes; skip it for local-first apps without prisma/schema.prisma.",
        "- vercel_env_set records required Vercel env vars when deployment needs secrets or managed storage values.",
        "- use_design_skill returns compact guidance from built-in design/product skills. Use it before writing the app shell or visual system.",
        "- inspect_reference_app returns safe reference-app profiles for Bloom Planner, My Season, Brain Spin, or compact consumer app patterns.",
        "- quality_audit scans the current sandbox for engineering blockers and advisory product/frontend/backend/persistence risks. Run it before finish_app.",
        "- If quality_audit reports interaction-model-depth, domain-interaction-affordances, visual, or product-depth findings, treat them as guidance unless the check is marked blocking. Do not keep expanding the app after all architecture tasks, build, and blocking engineering checks are complete.",
        "- For local-first/static-export apps, fix quality_audit without adding Prisma, Server Actions, revalidatePath, DATABASE_URL, or mutable API routes; use client state plus local storage and typed domain data instead.",
        "- run_build performs a scaffold preflight, dependency install, build, and limited automatic local repair. Use it after a meaningful chunk of work, not after every file.",
        "- mark_task_done immediately after finishing each task.",
        "- finish_app at the very end with a short summary. Do NOT call finish_app while any task is still pending; if you forget it but files are complete, build passes, and quality_audit passes, the orchestrator may auto-complete closeout.",
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
  lines.push(`Tech stack: ${plan.techStack.slice(0, 8).join(", ") || "(none)"}`);
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
  for (const node of plan.fileTree.slice(0, 24)) {
    const deps = node.dependencies?.length ? ` (depends on: ${node.dependencies.join(", ")})` : "";
    lines.push(`  - ${node.path} — ${node.purpose}${deps}`);
  }
  if (plan.fileTree.length > 24) {
    lines.push(`  - ... ${plan.fileTree.length - 24} additional files omitted from coder prompt; keep following the task file lists.`);
  }

  if (plan.dataModels.length > 0) {
    lines.push("");
    lines.push("Data models:");
    for (const model of plan.dataModels.slice(0, 8)) {
      lines.push(`  - ${model.name}: ${model.description}`);
      for (const field of model.fields.slice(0, 10)) {
        const desc = field.description ? ` (${field.description})` : "";
        lines.push(`      • ${field.name}: ${field.type}${desc}`);
      }
      if (model.fields.length > 10) {
        lines.push(`      • ... ${model.fields.length - 10} additional fields omitted`);
      }
    }
  }

  if (plan.components.length > 0) {
    lines.push("");
    lines.push("Components:");
    for (const component of plan.components.slice(0, 18)) {
      const props = component.props?.length ? ` props=[${component.props.join(", ")}]` : "";
      const uses = component.uses?.length ? ` uses=[${component.uses.join(", ")}]` : "";
      lines.push(`  - ${component.name} (${component.filePath}) — ${component.purpose}${props}${uses}`);
    }
    if (plan.components.length > 18) {
      lines.push(`  - ... ${plan.components.length - 18} additional components omitted; implement only if required by pending tasks or quality_audit.`);
    }
  }

  if (plan.routes.length > 0) {
    lines.push("");
    lines.push("Routes:");
    for (const route of plan.routes.slice(0, 8)) {
      const file = route.filePath ? ` (${route.filePath})` : "";
      const rendering = route.rendering ? ` [${route.rendering}]` : "";
      lines.push(`  - ${route.path} → ${route.component}${file}${rendering}: ${route.description}`);
    }
    if (plan.routes.length > 8) {
      lines.push(`  - ... ${plan.routes.length - 8} additional routes omitted; prefer completing core routes before adding optional surfaces.`);
    }
  }

  if (plan.apiEndpoints.length > 0) {
    lines.push("");
    lines.push("API endpoints:");
    for (const endpoint of plan.apiEndpoints.slice(0, 6)) {
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
    for (const action of plan.serverActions.slice(0, 6)) {
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
    for (const envVar of plan.envVars.slice(0, 8)) {
      const required = envVar.required ? "required" : "optional";
      const scope = envVar.scope ? `, ${envVar.scope}` : "";
      const example = envVar.example ? `, example=${envVar.example}` : "";
      lines.push(`  - ${envVar.name} (${required}${scope}${example}): ${envVar.purpose}`);
    }
  }

  if (plan.integrations.length > 0) {
    lines.push("");
    lines.push("Integrations:");
    for (const integration of plan.integrations.slice(0, 4)) {
      const envVars = integration.envVars?.length ? ` env=[${integration.envVars.join(", ")}]` : "";
      const serverFiles = integration.serverFiles?.length ? ` files=[${integration.serverFiles.join(", ")}]` : "";
      lines.push(`  - ${integration.name}: ${integration.purpose}${envVars}${serverFiles}`);
    }
  }

  if (plan.externalCapabilities?.length) {
    lines.push("");
    lines.push("External capabilities to consult:");
    for (const capability of plan.externalCapabilities.slice(0, 3)) {
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
    for (const check of plan.qualityChecks.slice(0, 8)) {
      const blocking = check.blocking ? "blocking" : "advisory";
      lines.push(`  - ${check.id} [${check.category}, ${blocking}]: ${check.requirement}`);
    }
    if (plan.qualityChecks.length > 8) {
      lines.push(`  - ... ${plan.qualityChecks.length - 8} additional checks omitted; quality_audit remains authoritative before finish_app.`);
    }
  }

  lines.push("");
  lines.push("Tasks (in execution order):");
  for (const task of plan.tasks.slice(0, 14)) {
    const deps = task.dependsOn?.length ? ` [after: ${task.dependsOn.join(", ")}]` : "";
    lines.push(`  • ${task.id}: ${task.title}${deps}`);
    lines.push(`      files: ${task.files.join(", ") || "(none)"}`);
    lines.push(`      acceptance: ${task.acceptance}`);
  }
  if (plan.tasks.length > 14) {
    lines.push(`  • ... ${plan.tasks.length - 14} additional tasks omitted; progress checkpoints will surface pending task details when needed.`);
  }

  if (plan.risks?.length) {
    lines.push("");
    lines.push("Risks:");
    for (const risk of plan.risks.slice(0, 4)) {
      lines.push(`  ! ${risk}`);
    }
  }

  return lines.join("\n");
}
