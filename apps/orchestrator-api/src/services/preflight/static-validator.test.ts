import test from "node:test";
import assert from "node:assert/strict";

import type { WorkspaceFile } from "@vide/contracts";

import { detectStaticValidationIssue } from "./static-validator.js";

test("detectStaticValidationIssue flags tailwind directives without toolchain", () => {
  const files: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          typescript: "^5.6.2",
          vite: "^5.4.5",
        },
      }),
    },
    {
      path: "src/index.css",
      content: "@tailwind base;\n@tailwind components;\n.btn { @apply px-4 py-2; }\n",
    },
  ];

  assert.match(detectStaticValidationIssue(files) ?? "", /tailwind/i);
});

test("detectStaticValidationIssue ignores plain CSS apps without tailwind usage", () => {
  const files: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
      }),
    },
    {
      path: "src/index.css",
      content: ".hero { color: #123456; }\n",
    },
    {
      path: "src/App.tsx",
      content: "export default function App() { return <input placeholder=\"Type here\" className=\"hero\" />; }\n",
    },
  ];

  assert.equal(detectStaticValidationIssue(files), null);
});

test("detectStaticValidationIssue flags missing runtime dependencies", () => {
  const reactRouterFiles: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
      }),
    },
    {
      path: "src/App.tsx",
      content: "import { Routes, Route } from 'react-router-dom';\nexport default function App() { return <Routes />; }\n",
    },
  ];
  const lucideFiles: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
      }),
    },
    {
      path: "src/App.tsx",
      content: "import { Sparkles } from 'lucide-react';\nexport default function App() { return <Sparkles />; }\n",
    },
  ];

  assert.match(detectStaticValidationIssue(reactRouterFiles) ?? "", /react-router-dom/i);
  assert.match(detectStaticValidationIssue(lucideFiles) ?? "", /lucide-react/i);
});

test("detectStaticValidationIssue flags malformed json and truncated html", () => {
  const jsonFiles: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "demo",
        private: true,
      }),
    },
    {
      path: "tsconfig.json",
      content: '{\n  "compilerOptions": {\n    "target": "ES2020"\n  },\n  "include": ["src"]\n',
    },
  ];
  const htmlFiles: WorkspaceFile[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "demo",
        private: true,
      }),
    },
    {
      path: "index.html",
      content: "<!doctype html>\n<html>\n  <head>\n    <meta charset=\"UTF-8\" />\n    <link rel=",
    },
  ];

  assert.match(detectStaticValidationIssue(jsonFiles) ?? "", /tsconfig\.json/);
  assert.match(detectStaticValidationIssue(jsonFiles) ?? "", /JSON/);
  assert.match(detectStaticValidationIssue(htmlFiles) ?? "", /index\.html/);
  assert.match(detectStaticValidationIssue(htmlFiles) ?? "", /截断|不完整/);
});
