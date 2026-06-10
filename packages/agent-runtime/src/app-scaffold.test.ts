import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BASELINE_REQUIRED_FILES, ensureSandboxBaselineScaffold } from "./app-scaffold.js";
import { SandboxWorkspace } from "./sandbox.js";

test("ensureSandboxBaselineScaffold writes the fixed buildable Next.js contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "vide-scaffold-"));
  const sandboxRoot = join(root, "sandbox");
  const workspace = new SandboxWorkspace(root, sandboxRoot);
  try {
    const written = await ensureSandboxBaselineScaffold(workspace, {
      appName: "Travel Journal",
      title: "Travel Journal",
      summary: "Mobile travel journal.",
    });

    assert.deepEqual(written, [...BASELINE_REQUIRED_FILES]);
    const files = await workspace.listFiles();
    for (const path of BASELINE_REQUIRED_FILES) {
      assert.ok(files.includes(path), `expected ${path}`);
    }

    const packageJson = JSON.parse(await workspace.readFile("package.json")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    assert.equal(packageJson.scripts?.build, "next build");
    assert.equal(packageJson.dependencies?.next, "14.2.25");
    assert.match(await workspace.readFile("src/app/globals.css"), /430px/);
    const page = await workspace.readFile("src/app/page.tsx");
    assert.match(page, /localStorage/);
    assert.match(page, /cycleStatus/);
    assert.match(page, /moveItem/);
    assert.doesNotMatch(page, /replace this scaffold|Start the main flow|Product modules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureSandboxBaselineScaffold upgrades legacy placeholder pages into a functional starter", async () => {
  const root = await mkdtemp(join(tmpdir(), "vide-scaffold-"));
  const sandboxRoot = join(root, "sandbox");
  const workspace = new SandboxWorkspace(root, sandboxRoot);
  try {
    await workspace.writeFile(
      "src/app/page.tsx",
      `const modules = [
  { label: "Today", title: "Start the main flow", detail: "The generated app will replace this scaffold with domain-specific content and controls." },
];
export default function HomePage() {
  return <main className="app-shell"><section className="module-list"><article className="module-card">MOBILE APP</article></section></main>;
}
`,
    );
    await workspace.writeFile("src/app/globals.css", ".app-shell {} .module-list {} .module-card {}\n");

    const written = await ensureSandboxBaselineScaffold(workspace, {
      appName: "Travel Planner",
      title: "Travel Planner",
      summary: "Mobile travel itinerary.",
    });

    assert.ok(written.includes("src/app/page.tsx"));
    assert.ok(written.includes("src/app/globals.css"));
    const page = await workspace.readFile("src/app/page.tsx");
    assert.match(page, /localStorage/);
    assert.match(page, /Travel planner/);
    assert.doesNotMatch(page, /replace this scaffold|Start the main flow|Product modules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
