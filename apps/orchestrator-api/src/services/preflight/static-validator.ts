import type { WorkspaceFile } from "@vide/contracts";

import { dependencyNames, getFile, hasFile, parsePackageJson } from "./manifest-defaults.js";

const TAILWIND_DIRECTIVE_RE = /@tailwind\b|@apply\b/;
const TAILWIND_UTILITY_RE =
  /(?:className|class)\s*=\s*["'`][^"'`]*(?:\b(?:bg|text|px|py|pt|pb|pl|pr|mt|mb|ml|mr|mx|my|w|h|min-h|max-w|grid-cols|gap|space-x|space-y|justify|items|rounded|shadow|font|tracking|leading|object|overflow|inset|top|bottom|left|right|z|col-span|row-span|from|to|via)-|(?:hover|focus|md|lg|xl):)/;
const REACT_ROUTER_IMPORT_RE = /from\s+["']react-router-dom["']|import\s+["']react-router-dom["']/;
const LUCIDE_IMPORT_RE = /from\s+["']lucide-react["']|import\s+["']lucide-react["']/;
const FRAMER_MOTION_IMPORT_RE = /from\s+["']framer-motion["']|import\s+["']framer-motion["']/;
const CRITICAL_JSON_FILES = ["package.json", "tsconfig.json", "tsconfig.node.json"] as const;

function isCodeLikeFile(path: string): boolean {
  return /\.(?:tsx|jsx|ts|js|css|html)$/i.test(path);
}

export function detectStaticValidationIssue(files: WorkspaceFile[]): string | null {
  for (const filename of CRITICAL_JSON_FILES) {
    const file = getFile(files, filename);
    if (!file) {
      continue;
    }

    try {
      JSON.parse(file.content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "JSON syntax error";
      return `${filename} 不是有效的 JSON，文件内容看起来已被截断或损坏：${detail}`;
    }
  }

  const indexHtml = getFile(files, "index.html");
  if (indexHtml) {
    const content = indexHtml.content.trim();
    const hasRoot = /<div[^>]+id=["']root["'][^>]*>/i.test(content);
    const hasEntryScript = /<script[^>]+src=["']\/?src\/main\.(?:tsx|jsx|ts|js)["']/i.test(content);
    const hasClosingHtml = /<\/html>\s*$/i.test(content);

    if (!hasRoot || !hasEntryScript || !hasClosingHtml) {
      return (
        "index.html 看起来不完整或已被截断。它至少需要包含根节点、" +
        "指向 /src/main.tsx 的入口脚本，以及闭合的 </html> 标签。"
      );
    }
  }

  const codeFiles = files.filter((file) => isCodeLikeFile(file.path));
  const combinedContent = codeFiles.map((file) => file.content).join("\n");
  const pkg = parsePackageJson(files);
  const deps = dependencyNames(pkg);
  const hasTailwindDeps = deps.has("tailwindcss") && deps.has("postcss") && deps.has("autoprefixer");
  const hasTailwindConfig =
    hasFile(files, "tailwind.config.js") ||
    hasFile(files, "tailwind.config.ts") ||
    hasFile(files, "postcss.config.js") ||
    hasFile(files, "postcss.config.cjs") ||
    hasFile(files, "postcss.config.mjs");

  if (TAILWIND_DIRECTIVE_RE.test(combinedContent) && (!hasTailwindDeps || !hasTailwindConfig)) {
    return (
      "Tailwind directives were generated without the full Tailwind toolchain. " +
      "Use plain CSS instead, or add tailwindcss, postcss, autoprefixer, and config files."
    );
  }

  if (TAILWIND_UTILITY_RE.test(combinedContent) && !hasTailwindDeps) {
    return (
      "Tailwind-style utility classes were generated without Tailwind dependencies. " +
      "Replace them with plain CSS classes or add a complete Tailwind setup."
    );
  }

  if (REACT_ROUTER_IMPORT_RE.test(combinedContent) && !deps.has("react-router-dom")) {
    return "React Router is imported in the generated app, but react-router-dom is missing from package.json.";
  }

  if (LUCIDE_IMPORT_RE.test(combinedContent) && !deps.has("lucide-react")) {
    return "lucide-react is imported in the generated app, but lucide-react is missing from package.json.";
  }

  if (FRAMER_MOTION_IMPORT_RE.test(combinedContent) && !deps.has("framer-motion")) {
    return "framer-motion is imported in the generated app, but framer-motion is missing from package.json.";
  }

  return null;
}
