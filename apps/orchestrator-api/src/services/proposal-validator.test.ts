import test from "node:test";
import assert from "node:assert/strict";

import type { WorkspaceFile } from "@vide/contracts";

import { detectStaticValidationIssue } from "./proposal-validator.js";

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
