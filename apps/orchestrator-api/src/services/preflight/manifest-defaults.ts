import type { AgentSessionState, ExecutionStep, FileOperation, ProjectRecord, WorkspaceFile } from "@vide/contracts";

const RUNTIME_DEPENDENCY_NAMES = new Set([
  "react-router-dom",
  "lucide-react",
  "framer-motion",
  "zustand",
  "@tanstack/react-query",
  "clsx",
  "tailwind-merge",
  "class-variance-authority",
]);
const RUNTIME_DEPENDENCY_PREFIXES = ["@radix-ui/"];

export function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function defaultInstallStep(): ExecutionStep {
  return {
    type: "install_dependencies",
    description: "Install the app dependencies with npm.",
    packageManager: "npm",
  };
}

export function defaultBuildStep(): ExecutionStep {
  return {
    type: "build_web_app",
    description: "Run a production build as a verification step.",
    packageManager: "npm",
  };
}

export function parsePackageJson(files: WorkspaceFile[]): Record<string, unknown> | null {
  const packageJson = files.find((file) => file.path === "package.json");
  if (!packageJson) {
    return null;
  }

  try {
    return JSON.parse(packageJson.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function dependencyNames(pkg: Record<string, unknown> | null): Set<string> {
  if (!pkg) {
    return new Set();
  }

  const combined = {
    ...(typeof pkg.dependencies === "object" && pkg.dependencies ? (pkg.dependencies as Record<string, unknown>) : {}),
    ...(typeof pkg.devDependencies === "object" && pkg.devDependencies ? (pkg.devDependencies as Record<string, unknown>) : {}),
  };

  return new Set(Object.keys(combined));
}

export function hasFile(files: WorkspaceFile[], filename: string): boolean {
  return files.some((file) => file.path === filename);
}

export function getFile(files: WorkspaceFile[], filename: string): WorkspaceFile | undefined {
  return files.find((file) => file.path === filename);
}

export function addTailwindDependencies(packageJsonContent: string): string | null {
  return addDependenciesToPackageJson(packageJsonContent, {
    tailwindcss: "^3.4.17",
    postcss: "^8.4.49",
    autoprefixer: "^10.4.20",
  });
}

export function addDependenciesToPackageJson(
  packageJsonContent: string,
  dependenciesToAdd: Record<string, string>,
): string | null {
  try {
    const data = JSON.parse(packageJsonContent) as Record<string, unknown>;
    const devDependencies =
      typeof data.devDependencies === "object" && data.devDependencies
        ? (data.devDependencies as Record<string, string>)
        : {};

    data.devDependencies = { ...devDependencies };
    const runtimeDependencies =
      typeof data.dependencies === "object" && data.dependencies
        ? (data.dependencies as Record<string, string>)
        : {};
    data.dependencies = { ...runtimeDependencies };

    for (const [name, version] of Object.entries(dependenciesToAdd)) {
      if (isRuntimeDependencyName(name)) {
        (data.dependencies as Record<string, string>)[name] = runtimeDependencies[name] ?? version;
        continue;
      }

      (data.devDependencies as Record<string, string>)[name] = devDependencies[name] ?? version;
    }

    return JSON.stringify(data, null, 2) + "\n";
  } catch {
    return null;
  }
}

export function isRuntimeDependencyName(name: string): boolean {
  return RUNTIME_DEPENDENCY_NAMES.has(name) || RUNTIME_DEPENDENCY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function snapshotToWriteOperations(files: WorkspaceFile[]): FileOperation[] {
  return files.map((file) => ({
    type: "write",
    path: file.path,
    summary: `Write ${file.path}.`,
    content: file.content,
  }));
}

export function createValidationProject(
  project: ProjectRecord,
  workspaceRoot: string,
  session: AgentSessionState,
): ProjectRecord {
  return {
    ...project,
    workspaceRoot,
    session,
    latestRun: undefined,
    versions: [],
    preview: {
      status: "idle",
      updatedAt: new Date().toISOString(),
    },
  };
}
