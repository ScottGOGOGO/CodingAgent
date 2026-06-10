import test from "node:test";
import assert from "node:assert/strict";

import { ContextManager } from "./context-manager.js";

test("ContextManager prioritizes core files and relevant files", () => {
  const manager = new ContextManager(200);
  const selected = manager.selectFiles(
    [
      { path: "README.md", content: "travel guide" },
      { path: "package.json", content: "{}" },
      { path: "src/app/page.tsx", content: "export default function HomePage() { return null }" },
      { path: "src/travel-data.ts", content: "上海旅行 行程 预算" },
    ],
    "请生成上海旅行预算应用",
  );

  assert.deepEqual(
    selected.map((file) => file.path),
    ["package.json", "src/app/page.tsx", "src/travel-data.ts"],
  );
});
