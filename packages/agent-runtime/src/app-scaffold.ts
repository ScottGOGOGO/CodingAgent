import type {
  ArchitectureComponent,
  ArchitectureFileNode,
  ArchitecturePlan,
  ArchitectureQualityCheck,
  ArchitectureRoute,
  BuildTask,
  DesignBrief,
} from "@vide/contracts";

import { normalizeCorePackageJson, type PackageJsonShape } from "./package-dependencies.js";
import type { SandboxWorkspace } from "./sandbox.js";

export type ArchitecturePlanDraft = Omit<ArchitecturePlan, "id" | "runId" | "createdAt">;

export const BASELINE_REQUIRED_FILES = [
  "package.json",
  "next.config.mjs",
  "tsconfig.json",
  "next-env.d.ts",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/globals.css",
] as const;

type BaselineRequiredFile = (typeof BASELINE_REQUIRED_FILES)[number];

const BASELINE_FILE_PURPOSES: Record<BaselineRequiredFile, string> = {
  "package.json": "Next.js 14 App Router project manifest with install/build/preview scripts.",
  "next.config.mjs": "Minimal Next.js configuration for a Vercel-compatible build.",
  "tsconfig.json": "Strict TypeScript configuration with @/* path alias.",
  "next-env.d.ts": "Next.js ambient type declarations required by TypeScript builds.",
  "src/app/layout.tsx": "Root App Router layout, metadata, viewport, and global stylesheet import.",
  "src/app/page.tsx": "Mobile-first primary route; safe fallback product surface until richer UI replaces it.",
  "src/app/globals.css": "Mobile preview-safe global CSS, reset, tokens, and baseline responsive layout.",
};

export function enforceArchitectureBaseline(
  plan: ArchitecturePlanDraft,
  brief?: Pick<DesignBrief, "summary" | "screens" | "interactionModel">,
): ArchitecturePlanDraft {
  const fileTree = mergeFileTree(plan.fileTree, baselineFileTree());
  const routes = mergeRoutes(plan.routes, baselineRoutes());
  const components = mergeComponents(plan.components, baselineComponents());
  const qualityChecks = mergeQualityChecks(plan.qualityChecks ?? [], baselineQualityChecks(brief));
  const tasks = mergeTasks(plan.tasks, baselineTasks(brief));

  return {
    ...plan,
    techStack: normalizeTechStack(plan.techStack),
    dataStore: {
      ...plan.dataStore,
      provider: plan.dataStore?.provider ?? "memory",
      orm: plan.dataStore?.orm ?? "none",
    },
    fileTree,
    routes,
    components,
    qualityChecks,
    tasks,
    deployment:
      plan.deployment?.trim() ||
      "Run npm install, npm run build, then npm run start or next dev/preview in the sandbox. The app is Vercel-compatible.",
  };
}

export async function ensureSandboxBaselineScaffold(
  sandbox: SandboxWorkspace,
  args: {
    appName?: string;
    title?: string;
    summary?: string;
    emitLog?: (message: string) => void;
  } = {},
): Promise<string[]> {
  const existing = new Set(await sandbox.listFiles());
  const written: string[] = [];
  for (const filePath of BASELINE_REQUIRED_FILES) {
    if (existing.has(filePath)) {
      continue;
    }
    await sandbox.writeFile(filePath, baselineFileContent(filePath, args));
    written.push(filePath);
  }
  if (existing.has("src/app/page.tsx")) {
    const page = await sandbox.readFile("src/app/page.tsx");
    if (isLegacyBaselineScaffoldSource(page)) {
      await sandbox.writeFile("src/app/page.tsx", baselineFileContent("src/app/page.tsx", args));
      written.push("src/app/page.tsx");
      const css = existing.has("src/app/globals.css") ? await sandbox.readFile("src/app/globals.css") : "";
      if (!css || /app-shell|hero-panel|module-list|module-card/.test(css)) {
        await sandbox.writeFile("src/app/globals.css", baselineFileContent("src/app/globals.css", args));
        written.push("src/app/globals.css");
      }
    }
  }
  if (written.length) {
    args.emitLog?.(`Baseline Next.js scaffold preloaded: ${written.join(", ")}.`);
  }
  return written;
}

export function createBaselineFiles(args: {
  appName?: string;
  title?: string;
  summary?: string;
} = {}): Array<{ path: string; content: string }> {
  return BASELINE_REQUIRED_FILES.map((path) => ({
    path,
    content: baselineFileContent(path, args),
  }));
}

export function missingBaselineFiles(files: Array<{ path: string }>): string[] {
  const paths = new Set(files.map((file) => file.path));
  return BASELINE_REQUIRED_FILES.filter((path) => !paths.has(path));
}

export function isLegacyBaselineScaffoldSource(page: string): boolean {
  return (
    /Start the main flow|replace this scaffold|Product modules|MOBILE APP/.test(page) &&
    /module-list|module-card/.test(page)
  );
}

function baselineFileTree(): ArchitectureFileNode[] {
  return BASELINE_REQUIRED_FILES.map((path) => ({
    path,
    purpose: BASELINE_FILE_PURPOSES[path],
  }));
}

function baselineRoutes(): ArchitectureRoute[] {
  return [
    {
      path: "/",
      component: "HomePage",
      description: "Primary mobile app route with product-specific modules and interaction entry points.",
      filePath: "src/app/page.tsx",
      rendering: "server",
    },
  ];
}

function baselineComponents(): ArchitectureComponent[] {
  return [
    {
      name: "HomePage",
      filePath: "src/app/page.tsx",
      purpose: "Mobile-first primary product route; may compose richer client components when the plan needs interaction.",
    },
    {
      name: "MobileAppShell",
      filePath: "src/components/MobileAppShell.tsx",
      purpose: "Optional shell component for app header, safe-area spacing, navigation, and mobile preview layout.",
    },
    {
      name: "ProductModuleList",
      filePath: "src/components/ProductModuleList.tsx",
      purpose: "Optional route-equivalent module list for primary, action/detail, and history/progress surfaces.",
    },
  ];
}

function baselineQualityChecks(brief?: Pick<DesignBrief, "summary" | "interactionModel">): ArchitectureQualityCheck[] {
  const interactionHint = brief?.interactionModel?.length
    ? ` It must cover: ${brief.interactionModel.slice(0, 4).join("; ")}.`
    : "";
  return [
    {
      id: "baseline-nextjs-scaffold",
      category: "deployment",
      requirement:
        "The sandbox contains package.json, next.config.mjs, tsconfig.json, next-env.d.ts, src/app/layout.tsx, src/app/page.tsx, and src/app/globals.css.",
      evidence: "File tree and npm run build output.",
      blocking: true,
    },
    {
      id: "mobile-preview-readiness",
      category: "frontend",
      requirement:
        "The first route is readable and usable inside a 390px-wide iPhone preview, with no horizontal overflow or hidden primary action.",
      evidence: "src/app/page.tsx and src/app/globals.css define mobile-first structure and responsive bounds.",
      blocking: true,
    },
    {
      id: "interaction-model-completeness",
      category: "interaction",
      requirement:
        `The generated app implements visible state changes for the planned interaction model, not just static buttons.${interactionHint}`,
      evidence: "Client state, form handlers, active states, saved/completed feedback, or server/local mutation boundaries in source.",
      blocking: true,
    },
  ];
}

function baselineTasks(brief?: Pick<DesignBrief, "summary" | "screens">): BuildTask[] {
  const title = brief?.summary?.trim() || "the requested app";
  const surfaces = brief?.screens?.length ? brief.screens.slice(0, 4).join(", ") : "primary, detail/action, history/progress";
  return [
    {
      id: "task-baseline-scaffold",
      title: "Create buildable mobile Next.js scaffold",
      description:
        "category: scaffold. Ensure the fixed architecture contract exists before product implementation: package/config/types/layout/page/styles.",
      files: [...BASELINE_REQUIRED_FILES],
      acceptance: "npm run build can find a Next.js App Router entrypoint and the iPhone preview has a styled first route.",
    },
    {
      id: "task-mobile-product-surface",
      title: "Implement the mobile product surface",
      description:
        `category: route-surface/app-shell. Replace the scaffold page with product-specific modules for ${title}; include these route-equivalent surfaces: ${surfaces}.`,
      files: ["src/app/page.tsx", "src/app/globals.css"],
      dependsOn: ["task-baseline-scaffold"],
      acceptance: "The first viewport shows domain content, a meaningful action or inspection path, and responsive mobile layout.",
    },
    {
      id: "task-build-verify",
      title: "Verify build and close out",
      description:
        "category: build-verify. Run build, fix missing files/imports/type errors, run quality_audit, then finish.",
      files: [],
      dependsOn: ["task-mobile-product-surface"],
      acceptance: "npm run build exits 0, quality_audit has no blocking engineering failures, and finish_app is called or auto-completed.",
    },
  ];
}

function mergeFileTree(primary: ArchitectureFileNode[], required: ArchitectureFileNode[]): ArchitectureFileNode[] {
  const byPath = new Map<string, ArchitectureFileNode>();
  for (const node of required) byPath.set(node.path, node);
  for (const node of primary) byPath.set(node.path, node);
  return [...byPath.values()];
}

function mergeRoutes(primary: ArchitectureRoute[], required: ArchitectureRoute[]): ArchitectureRoute[] {
  const byPath = new Map<string, ArchitectureRoute>();
  for (const route of required) byPath.set(route.path, route);
  for (const route of primary) byPath.set(route.path, route);
  return [...byPath.values()];
}

function mergeComponents(primary: ArchitectureComponent[], required: ArchitectureComponent[]): ArchitectureComponent[] {
  const byPath = new Map<string, ArchitectureComponent>();
  for (const component of required) byPath.set(component.filePath, component);
  for (const component of primary) byPath.set(component.filePath, component);
  return [...byPath.values()];
}

function mergeQualityChecks(primary: ArchitectureQualityCheck[], required: ArchitectureQualityCheck[]): ArchitectureQualityCheck[] {
  const byId = new Map<string, ArchitectureQualityCheck>();
  for (const check of required) byId.set(check.id, check);
  for (const check of primary) byId.set(check.id, check);
  return [...byId.values()].slice(0, 16);
}

function mergeTasks(primary: BuildTask[], required: BuildTask[]): BuildTask[] {
  if (primary.length >= 4) {
    return primary;
  }
  const byId = new Map<string, BuildTask>();
  for (const task of required) byId.set(task.id, task);
  for (const task of primary) byId.set(task.id, task);
  return [...byId.values()];
}

function normalizeTechStack(value: string[]): string[] {
  const required = ["Next.js 14 App Router", "React 18", "TypeScript strict", "mobile-first CSS"];
  const seen = new Set<string>();
  return [...required, ...(value ?? [])]
    .map((item) => item.trim())
    .filter((item) => item && !seen.has(item.toLowerCase()) && seen.add(item.toLowerCase()))
    .slice(0, 14);
}

function baselineFileContent(
  path: BaselineRequiredFile,
  args: { appName?: string; title?: string; summary?: string },
): string {
  switch (path) {
    case "package.json":
      return `${JSON.stringify(baselinePackageJson(args.appName), null, 2)}\n`;
    case "next.config.mjs":
      return `/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
`;
    case "tsconfig.json":
      return `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
`;
    case "next-env.d.ts":
      return `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// This file is generated by Next.js and kept in generated sandboxes for build tooling.
`;
    case "src/app/layout.tsx":
      return `import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "${escapeForDoubleQuotedString(args.title || "Generated app")}",
  description: "${escapeForDoubleQuotedString(args.summary || "A mobile-first generated product surface.")}",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;
    case "src/app/page.tsx":
      return functionalStarterPageSource(args);
    case "src/app/globals.css":
      return functionalStarterCssSource();
  }
}

function functionalStarterPageSource(args: { appName?: string; title?: string; summary?: string }): string {
  const title = escapeJsxText(args.title || "Generated app");
  const summary = escapeJsxText(args.summary || "A mobile-first local app for planning, tracking, and reviewing work.");
  const copy = starterDomainCopy(`${args.title || ""} ${args.summary || ""}`);
  const storageKey = `${slugifyPackageName(args.appName || args.title || "generated-mobile-app")}-starter-state-v1`;

  return `"use client";

import { useEffect, useMemo, useState } from "react";

type ItemStatus = "planned" | "active" | "done";
type Priority = "High" | "Normal" | "Low";
type ViewKey = "today" | "history" | "settings";

type WorkItem = {
  id: string;
  title: string;
  note: string;
  status: ItemStatus;
  priority: Priority;
};

const storageKey = ${tsString(storageKey)};

const statusLabels: Record<ItemStatus, string> = {
  planned: "Planned",
  active: "Active",
  done: "Done",
};

const seedItems: WorkItem[] = [
  {
    id: "item-1",
    title: ${tsString(copy.seedTitleA)},
    note: ${tsString(copy.seedNoteA)},
    status: "active",
    priority: "High",
  },
  {
    id: "item-2",
    title: ${tsString(copy.seedTitleB)},
    note: ${tsString(copy.seedNoteB)},
    status: "planned",
    priority: "Normal",
  },
  {
    id: "item-3",
    title: ${tsString(copy.seedTitleC)},
    note: ${tsString(copy.seedNoteC)},
    status: "done",
    priority: "Low",
  },
];

export default function HomePage() {
  const [items, setItems] = useState<WorkItem[]>(seedItems);
  const [view, setView] = useState<ViewKey>("today");
  const [filter, setFilter] = useState<ItemStatus | "all">("all");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [savedAt, setSavedAt] = useState("Not saved yet");

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as WorkItem[];
        if (Array.isArray(parsed) && parsed.length) {
          setItems(parsed);
        }
      }
    } catch {
      setItems(seedItems);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(items));
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
    } catch {
      setSavedAt("Local save unavailable");
    }
  }, [items]);

  const visibleItems = useMemo(
    () => (filter === "all" ? items : items.filter((item) => item.status === filter)),
    [filter, items],
  );
  const doneCount = items.filter((item) => item.status === "done").length;
  const activeItem = items.find((item) => item.status === "active") ?? items[0];
  const progress = items.length ? Math.round((doneCount / items.length) * 100) : 0;

  function addItem() {
    const title = draftTitle.trim();
    if (!title) return;
    setItems((current) => [
      {
        id: \`item-\${Date.now()}\`,
        title,
        note: draftNote.trim() || ${tsString(copy.defaultNote)},
        status: "planned",
        priority: "Normal",
      },
      ...current,
    ]);
    setDraftTitle("");
    setDraftNote("");
  }

  function cycleStatus(id: string) {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        const status = item.status === "planned" ? "active" : item.status === "active" ? "done" : "planned";
        return { ...item, status };
      }),
    );
  }

  function moveItem(id: string, direction: -1 | 1) {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function removeDone() {
    setItems((current) => current.filter((item) => item.status !== "done"));
  }

  return (
    <main className="starter-shell">
      <section className="starter-hero" aria-label="Current focus">
        <p className="eyebrow">${copy.eyebrow}</p>
        <h1>${title}</h1>
        <p>${summary}</p>
        <div className="hero-actions">
          <button type="button" onClick={() => setView("today")}>${copy.primaryAction}</button>
          <button type="button" className="ghost-button" onClick={() => setView("history")}>Review</button>
        </div>
      </section>

      <section className="metric-grid" aria-label="Progress overview">
        <article>
          <span>{items.length}</span>
          <p>Total</p>
        </article>
        <article>
          <span>{doneCount}</span>
          <p>Done</p>
        </article>
        <article>
          <span>{progress}%</span>
          <p>Progress</p>
        </article>
      </section>

      <nav className="view-tabs" aria-label="App views">
        {(["today", "history", "settings"] as ViewKey[]).map((key) => (
          <button
            type="button"
            key={key}
            className={view === key ? "active" : ""}
            onClick={() => setView(key)}
          >
            {key === "today" ? "${copy.todayLabel}" : key === "history" ? "History" : "Settings"}
          </button>
        ))}
      </nav>

      {view === "today" ? (
        <>
          <section className="focus-card" aria-label="Active item">
            <span>{activeItem ? statusLabels[activeItem.status] : "Ready"}</span>
            <h2>{activeItem?.title ?? ${tsString(copy.emptyTitle)}}</h2>
            <p>{activeItem?.note ?? ${tsString(copy.emptyNote)}}</p>
          </section>

          <section className="composer" aria-label="Add item">
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder=${tsString(copy.inputPlaceholder)}
            />
            <textarea
              value={draftNote}
              onChange={(event) => setDraftNote(event.target.value)}
              placeholder=${tsString(copy.notePlaceholder)}
              rows={3}
            />
            <button type="button" onClick={addItem}>Add</button>
          </section>

          <section className="filter-row" aria-label="Filters">
            {(["all", "planned", "active", "done"] as Array<ItemStatus | "all">).map((key) => (
              <button
                type="button"
                key={key}
                className={filter === key ? "active" : ""}
                onClick={() => setFilter(key)}
              >
                {key === "all" ? "All" : statusLabels[key]}
              </button>
            ))}
          </section>

          <section className="item-list" aria-label="${copy.listLabel}">
            {visibleItems.map((item, index) => (
              <article className="item-card" key={item.id}>
                <div>
                  <span className={\`status-pill \${item.status}\`}>{statusLabels[item.status]}</span>
                  <h2>{item.title}</h2>
                  <p>{item.note}</p>
                </div>
                <div className="card-actions">
                  <button type="button" onClick={() => cycleStatus(item.id)}>Status</button>
                  <button type="button" onClick={() => moveItem(item.id, -1)} disabled={index === 0}>Up</button>
                  <button type="button" onClick={() => moveItem(item.id, 1)} disabled={index === visibleItems.length - 1}>Down</button>
                </div>
              </article>
            ))}
          </section>
        </>
      ) : null}

      {view === "history" ? (
        <section className="panel-list" aria-label="History">
          <article>
            <h2>Completion trail</h2>
            <p>{doneCount ? \`\${doneCount} completed items are saved on this device.\` : "No completed items yet."}</p>
            <button type="button" onClick={removeDone} disabled={!doneCount}>Clear done</button>
          </article>
          <article>
            <h2>Current order</h2>
            <p>{items.map((item) => item.title).join(" -> ") || "Add the first item to start."}</p>
          </article>
        </section>
      ) : null}

      {view === "settings" ? (
        <section className="panel-list" aria-label="Settings">
          <article>
            <h2>Local storage</h2>
            <p>Saved at {savedAt}. Data stays in this browser preview.</p>
            <button type="button" onClick={() => setItems(seedItems)}>Reset demo data</button>
          </article>
          <article>
            <h2>${copy.settingsTitle}</h2>
            <p>${copy.settingsNote}</p>
          </article>
        </section>
      ) : null}
    </main>
  );
}
`;
}

function functionalStarterCssSource(): string {
  return `:root {
  color-scheme: light;
  --surface: #f7f3ea;
  --paper: #fffdf7;
  --ink: #171412;
  --muted: #756e64;
  --line: #ded5c7;
  --primary: #8d4f37;
  --accent: #2e6b5d;
  --active: #315d8f;
  --done: #3b7d55;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
  margin: 0;
}

body {
  background: var(--surface);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button,
input,
textarea {
  font: inherit;
}

button {
  min-height: 42px;
  border: 1px solid var(--ink);
  border-radius: 12px;
  background: var(--ink);
  color: #fffaf1;
  font-weight: 800;
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

input,
textarea {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px 14px;
  background: #fffaf1;
  color: var(--ink);
}

.starter-shell {
  width: min(100%, 430px);
  min-height: 100vh;
  margin: 0 auto;
  padding: 18px 14px 92px;
}

.starter-hero,
.focus-card,
.composer,
.item-card,
.panel-list article,
.metric-grid article {
  display: grid;
  gap: 12px;
  border: 1px solid var(--line);
  background: var(--paper);
}

.starter-hero {
  padding: 22px;
  border-radius: 20px;
}

.eyebrow {
  margin: 0;
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: 2.2rem;
  line-height: 0.98;
}

h2 {
  font-size: 1rem;
}

.starter-hero p:not(.eyebrow),
.focus-card p,
.item-card p,
.panel-list p,
.metric-grid p {
  color: var(--muted);
  line-height: 1.5;
}

.hero-actions,
.filter-row,
.view-tabs,
.card-actions {
  display: flex;
  gap: 8px;
}

.hero-actions button,
.filter-row button,
.view-tabs button,
.card-actions button,
.panel-list button {
  flex: 1;
}

.ghost-button,
.filter-row button,
.view-tabs button,
.card-actions button,
.panel-list button {
  border-color: var(--line);
  background: #fffaf1;
  color: var(--ink);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.metric-grid article {
  min-height: 82px;
  align-content: center;
  padding: 14px;
  border-radius: 16px;
}

.metric-grid span {
  font-size: 1.45rem;
  font-weight: 900;
}

.view-tabs,
.filter-row {
  margin-top: 12px;
}

.view-tabs button.active,
.filter-row button.active {
  border-color: var(--accent);
  background: rgba(46, 107, 93, 0.12);
  color: var(--accent);
}

.focus-card,
.composer,
.item-list,
.panel-list {
  margin-top: 12px;
}

.focus-card,
.composer,
.panel-list article {
  padding: 16px;
  border-radius: 16px;
}

.focus-card span,
.status-pill {
  width: fit-content;
  border-radius: 999px;
  padding: 5px 10px;
  font-size: 0.74rem;
  font-weight: 900;
}

.focus-card span,
.status-pill.active {
  background: rgba(49, 93, 143, 0.12);
  color: var(--active);
}

.status-pill.planned {
  background: rgba(141, 79, 55, 0.12);
  color: var(--primary);
}

.status-pill.done {
  background: rgba(59, 125, 85, 0.14);
  color: var(--done);
}

.item-list,
.panel-list {
  display: grid;
  gap: 12px;
}

.item-card {
  grid-template-columns: 1fr;
  min-height: 152px;
  padding: 16px;
  border-radius: 16px;
}

.card-actions {
  flex-wrap: wrap;
}

.card-actions button {
  min-width: 76px;
}

@media (min-width: 760px) {
  .starter-shell {
    width: min(100%, 920px);
  }

  .item-list,
  .panel-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
`;
}

function starterDomainCopy(source: string): {
  eyebrow: string;
  primaryAction: string;
  todayLabel: string;
  listLabel: string;
  inputPlaceholder: string;
  notePlaceholder: string;
  defaultNote: string;
  emptyTitle: string;
  emptyNote: string;
  settingsTitle: string;
  settingsNote: string;
  seedTitleA: string;
  seedNoteA: string;
  seedTitleB: string;
  seedNoteB: string;
  seedTitleC: string;
  seedNoteC: string;
} {
  if (/travel|trip|journey|itinerary|tour|旅行|行程|旅程|景点|城市/i.test(source)) {
    return {
      eyebrow: "Travel planner",
      primaryAction: "Plan day",
      todayLabel: "Today",
      listLabel: "Itinerary items",
      inputPlaceholder: "Add a city, place, meal, or transfer",
      notePlaceholder: "Time, address, booking note, or rainy-day option",
      defaultNote: "Add timing, location, and backup details before departure.",
      emptyTitle: "Build the first itinerary item",
      emptyNote: "Add places, meals, transfers, and notes to shape the trip.",
      settingsTitle: "Trip mode",
      settingsNote: "Use the list order and status controls to keep the mobile itinerary ready offline.",
      seedTitleA: "Morning route and first stop",
      seedNoteA: "Confirm opening hours, travel time, and a nearby backup option.",
      seedTitleB: "Lunch and neighborhood walk",
      seedNoteB: "Keep reservation notes, transit details, and must-try dishes together.",
      seedTitleC: "Evening review",
      seedNoteC: "Mark completed activities and keep the next day clear.",
    };
  }
  if (/food|restaurant|meal|餐|饭|咖啡|美食|餐厅/i.test(source)) {
    return {
      eyebrow: "Food journal",
      primaryAction: "Add meal",
      todayLabel: "Today",
      listLabel: "Meal notes",
      inputPlaceholder: "Add a restaurant, dish, or tasting note",
      notePlaceholder: "Address, price, rating, or what to try next",
      defaultNote: "Record taste, price, context, and next action.",
      emptyTitle: "Capture the first meal",
      emptyNote: "Add a restaurant, dish, rating, and follow-up note.",
      settingsTitle: "Journal mode",
      settingsNote: "Track planned spots, active visits, and completed tasting notes locally.",
      seedTitleA: "Dinner reservation",
      seedNoteA: "Confirm time, address, and must-order dishes.",
      seedTitleB: "Coffee shortlist",
      seedNoteB: "Compare nearby options and save opening hours.",
      seedTitleC: "Taste review",
      seedNoteC: "Mark favorites and keep the notes searchable.",
    };
  }
  return {
    eyebrow: "Mobile workspace",
    primaryAction: "Start",
    todayLabel: "Today",
    listLabel: "Work items",
    inputPlaceholder: "Add an item",
    notePlaceholder: "Details, next step, owner, or context",
    defaultNote: "Add the next concrete step and review it later.",
    emptyTitle: "Add the first item",
    emptyNote: "Create a task, move it through statuses, and keep progress saved locally.",
    settingsTitle: "Workspace mode",
    settingsNote: "This local-first starter supports creation, status changes, ordering, review, and reset.",
    seedTitleA: "Define the main flow",
    seedNoteA: "Capture the primary action, edge state, and success feedback.",
    seedTitleB: "Prepare supporting detail",
    seedNoteB: "Add fields, notes, and ordering so the mobile view is useful.",
    seedTitleC: "Review completion",
    seedNoteC: "Move finished items to done and keep the history clean.",
  };
}

function baselinePackageJson(appName?: string): PackageJsonShape {
  return normalizeCorePackageJson({
    name: slugifyPackageName(appName || "generated-mobile-app"),
    version: "0.1.0",
    private: true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
    },
  });
}

function slugifyPackageName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "generated-mobile-app";
}

function escapeForDoubleQuotedString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function escapeJsxText(value: string): string {
  return value.replace(/[{}<>]/g, "").replace(/\s+/g, " ").trim();
}

function tsString(value: string): string {
  return JSON.stringify(value);
}
