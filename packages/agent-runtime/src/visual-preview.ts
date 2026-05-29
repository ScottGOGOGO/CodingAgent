import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Browser, Page } from "playwright";

import type { SandboxWorkspace } from "./sandbox.js";

export interface VisualSnapshot {
  screenshotPath?: string;
  summary: string;
  width: number;
  height: number;
}

export interface VisualPreviewer {
  capture(args: { workspace: SandboxWorkspace; runId: string; port?: number }): Promise<VisualSnapshot>;
}

type HomeEvidence = {
  title: string;
  text: string;
  textLength: number;
  headings: string[];
  controls: string[];
  images: Array<{ src: string; alt: string }>;
  backgroundImages: string[];
  bodyBackground: string;
  scrollWidth: number;
  scrollHeight: number;
  viewportWidth: number;
  viewportHeight: number;
};

export class NoopVisualPreviewer implements VisualPreviewer {
  async capture(): Promise<VisualSnapshot> {
    return {
      width: 390,
      height: 844,
      summary: "Screenshot capture unavailable in this runtime; visual review should rely on generated files only.",
    };
  }
}

export class PlaywrightVisualPreviewer implements VisualPreviewer {
  async capture(args: { workspace: SandboxWorkspace; runId: string; port?: number }): Promise<VisualSnapshot> {
    const port = args.port ?? (6100 + (hashId(args.runId) % 600));
    const screenshotPath = args.workspace.resolveSandboxPath(".agent/artifacts/visual-review.png");
    await mkdir(dirname(screenshotPath), { recursive: true });

    let server: ChildProcessWithoutNullStreams | undefined;
    let browser: Browser | undefined;
    let cleanup = async () => {
      if (browser) {
        await closeBrowser(browser);
      }
      killServer(server);
    };

    const capture = (async () => {
      try {
        server = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
          cwd: args.workspace.sandboxRoot,
          detached: true,
          env: { ...process.env, BROWSER: "none", DATABASE_URL: "file:./dev.db" },
        });
        server.stdout.resume();
        await waitForUrl(`http://127.0.0.1:${port}/`, server);

        const playwright = await import("playwright");
        browser = await playwright.chromium.launch({ headless: true, timeout: 15_000 });
        try {
          const page = await browser.newPage({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
          });
          await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
          const evidence = await page.evaluate<HomeEvidence>(() => {
            const text = document.body.innerText.replace(/\s+/g, " ").trim();
            const root = document.documentElement;
            const bodyStyle = window.getComputedStyle(document.body);
            const headings = [...document.querySelectorAll("h1,h2,h3")]
              .map((node) => node.textContent?.trim())
              .filter(Boolean)
              .slice(0, 8);
            const controls = [...document.querySelectorAll("button,a,input,textarea,select")]
              .map((node) => node.textContent?.trim() || node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.tagName.toLowerCase())
              .filter(Boolean)
              .slice(0, 12);
            const images = [...document.querySelectorAll("img")]
              .map((node) => ({
                src: node.getAttribute("src") || "",
                alt: node.getAttribute("alt") || "",
              }))
              .filter((item) => item.src || item.alt)
              .slice(0, 8);
            const backgroundImages = [...document.querySelectorAll<HTMLElement>("body, body *")]
              .map((node) => window.getComputedStyle(node).backgroundImage)
              .filter((value) => value && value !== "none")
              .slice(0, 8);
            return {
              title: document.title,
              text: text.slice(0, 1200),
              textLength: text.length,
              headings,
              controls,
              images,
              backgroundImages,
              bodyBackground: bodyStyle.backgroundColor,
              scrollWidth: root.scrollWidth,
              scrollHeight: root.scrollHeight,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
            };
          });
          const routeEvidence = await withTimeout(collectRouteEvidence(page, args.workspace), 30_000, []);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          await cleanup();

          return {
            screenshotPath,
            width: 390,
            height: 844,
            summary: [
              "Captured mobile screenshot at 390x844.",
              `Title: ${evidence.title || "(empty)"}`,
              `Text length: ${evidence.textLength}`,
              `Headings: ${evidence.headings.join(" | ") || "(none)"}`,
              `Controls: ${evidence.controls.join(" | ") || "(none)"}`,
              `Images: ${evidence.images.map((image) => `${image.alt || "(no alt)"} ${image.src}`).join(" | ") || "(none)"}`,
              `Background images: ${evidence.backgroundImages.join(" | ") || "(none)"}`,
              `Body background: ${evidence.bodyBackground}`,
              `Document size: ${evidence.scrollWidth}x${evidence.scrollHeight}`,
              `Route checks: ${routeEvidence.length ? routeEvidence.map((route) => `${route.path} status=${route.status} headings=${route.headings.join(" | ") || "(none)"} text=${route.textLength} controls=${route.controlCount}`).join(" ; ") : "(none)"}`,
              `Visible text excerpt: ${evidence.text || "(empty)"}`,
              evidence.scrollWidth > evidence.viewportWidth ? "Warning: horizontal overflow detected." : "",
            ]
              .filter(Boolean)
              .join("\n"),
          };
        } catch (error) {
          await cleanup();
          throw error;
        }
      } catch (error) {
        await cleanup();
        return {
          screenshotPath,
          width: 390,
          height: 844,
          summary: `Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    })();

    return withTimeoutFactory(capture, 75_000, async () => {
      await cleanup();
      return {
        screenshotPath,
        width: 390,
        height: 844,
        summary: "Screenshot capture timed out after 75s; continuing with generated-file and route evidence unavailable.",
      };
    });
  }
}

async function closeBrowser(browser: { close(): Promise<void> }): Promise<void> {
  await withTimeout(browser.close(), 3_000, undefined);
}

function killServer(server: ChildProcessWithoutNullStreams | undefined): void {
  if (!server || server.killed) {
    return;
  }
  if (server.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to killing the npm wrapper process below.
    }
  }
  server.kill("SIGTERM");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function withTimeoutFactory<T>(promise: Promise<T>, timeoutMs: number, fallback: () => Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => {
          fallback().then(resolve);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function collectRouteEvidence(
  page: Page,
  workspace: SandboxWorkspace,
): Promise<Array<{ path: string; status: number; headings: string[]; textLength: number; controlCount: number }>> {
  const discovered = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/") && !href.startsWith("//") && href !== "/"),
  );
  const inferred = await inferAppRoutes(workspace);
  const paths = [...new Set([...discovered, ...inferred])].slice(0, 6);
  const results: Array<{ path: string; status: number; headings: string[]; textLength: number; controlCount: number }> = [];
  const origin = new URL(page.url()).origin;

  for (const path of paths) {
    try {
      const response = await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded", timeout: 6_000 });
      const summary = await page.evaluate(() => {
        const text = document.body.innerText.replace(/\s+/g, " ").trim();
        return {
          headings: [...document.querySelectorAll("h1,h2,h3")]
            .map((node) => node.textContent?.trim() ?? "")
            .filter(Boolean)
            .slice(0, 4),
          textLength: text.length,
          controlCount: document.querySelectorAll("button,a,input,textarea,select").length,
        };
      });
      results.push({
        path,
        status: response?.status() ?? 0,
        ...summary,
      });
    } catch {
      results.push({ path, status: 0, headings: [], textLength: 0, controlCount: 0 });
    }
  }
  return results;
}

async function inferAppRoutes(workspace: SandboxWorkspace): Promise<string[]> {
  const files = await workspace.listFiles();
  return files
    .filter((path) => /^src\/app\/(?:.+\/)?page\.(?:tsx|jsx)$/.test(path))
    .map((path) => path.replace(/^src\/app\//, "").replace(/\/page\.(?:tsx|jsx)$/, ""))
    .map((segment) => segment === "page.tsx" ? "/" : segment)
    .map((segment) => `/${segment.replace(/\[(day|date|index)\]/gi, "1").replace(/\[(id|slug|placeId|itemId)\]/gi, "jing-an-temple").replace(/\[[^\]]+\]/g, "sample")}`)
    .filter((path) => path !== "/")
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, 10);
}

async function waitForUrl(url: string, server: ChildProcessWithoutNullStreams): Promise<void> {
  const startedAt = Date.now();
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  while (Date.now() - startedAt < 30_000) {
    if (server.exitCode !== null) {
      throw new Error(`preview server exited early: ${stderr.slice(-1000)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep waiting until the Next.js dev server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`preview server did not become ready: ${stderr.slice(-1000)}`);
}

function hashId(value: string): number {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}
