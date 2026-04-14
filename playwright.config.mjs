import { defineConfig } from "@playwright/test";

const PLAYGROUND_BASE_URL = process.env.PLAYGROUND_BASE_URL ?? "http://127.0.0.1:5173";
const SMOKE_UI_TEST_TIMEOUT_MS = Number(process.env.SMOKE_UI_TEST_TIMEOUT_MS ?? 900000);

export default defineConfig({
  testDir: "./tests/smoke",
  timeout: SMOKE_UI_TEST_TIMEOUT_MS,
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  outputDir: "test-results/playwright",
  use: {
    baseURL: PLAYGROUND_BASE_URL,
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev:all",
    url: PLAYGROUND_BASE_URL,
    reuseExistingServer: true,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
  },
});
