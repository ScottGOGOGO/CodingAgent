import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { ProjectRecord } from "@vide/contracts";

import { CommandExecutionError } from "../../runner.js";
import { addDependenciesToPackageJson, addTailwindDependencies } from "./manifest-defaults.js";

export async function tryAutofix(project: ProjectRecord, error: unknown): Promise<boolean> {
  const fixedTailwindToolchain = await ensureTailwindToolchain(project, error);
  if (fixedTailwindToolchain) {
    return true;
  }

  const fixedReactRouterDependency = await ensureReactRouterDependency(project, error);
  if (fixedReactRouterDependency) {
    return true;
  }

  const fixedLucideDependency = await ensureRuntimeDependency(project, error, "lucide-react", "^0.511.0");
  if (fixedLucideDependency) {
    return true;
  }

  const fixedFramerMotionDependency = await ensureRuntimeDependency(project, error, "framer-motion", "^11.11.17");
  if (fixedFramerMotionDependency) {
    return true;
  }

  const relaxedBuildScript = await relaxBuildScriptForTypeErrors(project, error);
  if (relaxedBuildScript) {
    return true;
  }

  if (!(error instanceof CommandExecutionError)) {
    return false;
  }

  const fixedTsconfigNode = await ensureMissingTsconfigNode(project, error.output);
  const fixedUnusedImports = await removeUnusedImports(project, error.output);
  return fixedTsconfigNode || fixedUnusedImports;
}

export async function ensureTailwindToolchain(project: ProjectRecord, error: unknown): Promise<boolean> {
  const message = error instanceof Error ? error.message : "";
  if (!message.toLowerCase().includes("tailwind")) {
    return false;
  }

  const packageJsonPath = join(project.workspaceRoot, "package.json");
  let packageJsonContent: string;
  try {
    packageJsonContent = await readFile(packageJsonPath, "utf-8");
  } catch {
    return false;
  }

  const nextPackageJson = addTailwindDependencies(packageJsonContent);
  if (!nextPackageJson) {
    return false;
  }

  let changed = nextPackageJson !== packageJsonContent;
  if (changed) {
    await writeFile(packageJsonPath, nextPackageJson, "utf-8");
  }

  const tailwindConfigPath = join(project.workspaceRoot, "tailwind.config.js");
  try {
    await readFile(tailwindConfigPath, "utf-8");
  } catch {
    await writeFile(
      tailwindConfigPath,
      "export default {\n" +
        '  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],\n' +
        "  theme: {\n" +
        "    extend: {},\n" +
        "  },\n" +
        "  plugins: [],\n" +
        "};\n",
      "utf-8",
    );
    changed = true;
  }

  const postcssConfigPath = join(project.workspaceRoot, "postcss.config.js");
  try {
    await readFile(postcssConfigPath, "utf-8");
  } catch {
    await writeFile(
      postcssConfigPath,
      "export default {\n" +
        "  plugins: {\n" +
        "    tailwindcss: {},\n" +
        "    autoprefixer: {},\n" +
        "  },\n" +
        "};\n",
      "utf-8",
    );
    changed = true;
  }

  return changed;
}

export async function ensureReactRouterDependency(project: ProjectRecord, error: unknown): Promise<boolean> {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (!message.includes("react-router-dom") && !message.includes("react router")) {
    return false;
  }

  const packageJsonPath = join(project.workspaceRoot, "package.json");
  let packageJsonContent: string;
  try {
    packageJsonContent = await readFile(packageJsonPath, "utf-8");
  } catch {
    return false;
  }

  const nextPackageJson = addDependenciesToPackageJson(packageJsonContent, {
    "react-router-dom": "^6.30.1",
  });
  if (!nextPackageJson || nextPackageJson === packageJsonContent) {
    return false;
  }

  await writeFile(packageJsonPath, nextPackageJson, "utf-8");
  return true;
}

export async function ensureRuntimeDependency(
  project: ProjectRecord,
  error: unknown,
  packageName: string,
  version: string,
): Promise<boolean> {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (!message.includes(packageName.toLowerCase())) {
    return false;
  }

  const packageJsonPath = join(project.workspaceRoot, "package.json");
  let packageJsonContent: string;
  try {
    packageJsonContent = await readFile(packageJsonPath, "utf-8");
  } catch {
    return false;
  }

  const nextPackageJson = addDependenciesToPackageJson(packageJsonContent, {
    [packageName]: version,
  });
  if (!nextPackageJson || nextPackageJson === packageJsonContent) {
    return false;
  }

  await writeFile(packageJsonPath, nextPackageJson, "utf-8");
  return true;
}

export async function relaxBuildScriptForTypeErrors(project: ProjectRecord, error: unknown): Promise<boolean> {
  if (!(error instanceof CommandExecutionError)) {
    return false;
  }

  const lowered = error.output.toLowerCase();
  if (!lowered.includes("error ts")) {
    return false;
  }

  const packageJsonPath = join(project.workspaceRoot, "package.json");
  let packageJsonContent: string;
  try {
    packageJsonContent = await readFile(packageJsonPath, "utf-8");
  } catch {
    return false;
  }

  try {
    const data = JSON.parse(packageJsonContent) as Record<string, unknown>;
    const scripts =
      typeof data.scripts === "object" && data.scripts
        ? (data.scripts as Record<string, string>)
        : {};
    const buildScript = scripts.build;
    if (typeof buildScript !== "string" || !buildScript.includes("tsc && vite build")) {
      return false;
    }

    scripts.build = buildScript.replace("tsc && vite build", "vite build");
    data.scripts = scripts;
    await writeFile(packageJsonPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function ensureMissingTsconfigNode(project: ProjectRecord, output: string): Promise<boolean> {
  if (!output.includes("TS6053") || !output.includes("tsconfig.node.json")) {
    return false;
  }

  const targetPath = join(project.workspaceRoot, "tsconfig.node.json");
  try {
    await readFile(targetPath, "utf-8");
    return false;
  } catch {
    await writeFile(
      targetPath,
      JSON.stringify(
        {
          compilerOptions: {
            composite: true,
            skipLibCheck: true,
            module: "ESNext",
            moduleResolution: "bundler",
            allowSyntheticDefaultImports: true,
          },
          include: ["vite.config.ts"],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    return true;
  }
}

export async function removeUnusedImports(project: ProjectRecord, output: string): Promise<boolean> {
  const matches = Array.from(
    output.matchAll(/([^\s:(][^:(]*\.(?:ts|tsx|js|jsx))\(\d+,\d+\): error TS6133: '([^']+)' is declared but its value is never read\./g),
  );
  if (!matches.length) {
    return false;
  }

  let changed = false;
  for (const match of matches) {
    const [, filePath, identifier] = match;
    const absolutePath = isAbsolute(filePath) ? filePath : join(project.workspaceRoot, filePath);
    let content: string;
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    const next = removeUnusedIdentifierFromImports(content, identifier);
    if (next !== content) {
      await writeFile(absolutePath, next, "utf-8");
      changed = true;
    }
  }

  return changed;
}

export function removeUnusedIdentifierFromImports(content: string, identifier: string): string {
  const lines = content.split("\n");
  const nextLines = lines.flatMap((line) => {
    if (!line.trim().startsWith("import")) {
      return [line];
    }

    const trimmed = line.trim();

    const namespaceImport = trimmed.match(/^import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+(['"].+['"]);?$/);
    if (namespaceImport?.[1] === identifier) {
      return [];
    }

    const defaultAndNamed = trimmed.match(/^import\s+([A-Za-z0-9_$]+)\s*,\s*\{([^}]+)\}\s+from\s+(['"].+['"]);?$/);
    if (defaultAndNamed) {
      const [, defaultImport, namedBlock, source] = defaultAndNamed;
      const originalNamedImports = namedBlock.split(",").map((item) => item.trim()).filter(Boolean);
      const namedImports = originalNamedImports.filter((item) => item !== identifier);

      if (defaultImport === identifier) {
        if (namedImports.length) {
          return [`import { ${namedImports.join(", ")} } from ${source};`];
        }
        return [];
      }

      if (namedImports.length !== originalNamedImports.length) {
        return [`import ${defaultImport}, { ${namedImports.join(", ")} } from ${source};`];
      }
      return [line];
    }

    const namedOnly = trimmed.match(/^import\s+\{([^}]+)\}\s+from\s+(['"].+['"]);?$/);
    if (namedOnly) {
      const [, namedBlock, source] = namedOnly;
      const original = namedBlock.split(",").map((item) => item.trim()).filter(Boolean);
      const namedImports = original.filter((item) => item !== identifier);
      if (namedImports.length !== original.length) {
        if (!namedImports.length) {
          return [];
        }
        return [`import { ${namedImports.join(", ")} } from ${source};`];
      }
      return [line];
    }

    const defaultOnly = trimmed.match(/^import\s+([A-Za-z0-9_$]+)\s+from\s+(['"].+['"]);?$/);
    if (defaultOnly?.[1] === identifier) {
      return [];
    }

    return [line];
  });

  return nextLines.join("\n");
}
