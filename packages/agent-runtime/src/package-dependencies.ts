export type PackageJsonShape = {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export const CORE_DEPENDENCIES: Record<string, string> = {
  next: "14.2.25",
  react: "^18.3.1",
  "react-dom": "^18.3.1",
};

export const CORE_DEV_DEPENDENCIES: Record<string, string> = {
  "@types/node": "^22.10.0",
  "@types/react": "^18.3.12",
  "@types/react-dom": "^18.3.1",
  eslint: "^8.57.1",
  "eslint-config-next": "14.2.25",
  typescript: "^5.8.0",
};

export const IMPORT_DEPENDENCY_VERSIONS: Record<string, string> = {
  "@prisma/client": "^5.22.0",
  "@radix-ui/react-checkbox": "^1.1.3",
  "@radix-ui/react-dialog": "^1.1.4",
  "@radix-ui/react-dropdown-menu": "^2.1.4",
  "@radix-ui/react-label": "^2.1.1",
  "@radix-ui/react-popover": "^1.1.4",
  "@radix-ui/react-progress": "^1.1.1",
  "@radix-ui/react-select": "^2.1.4",
  "@radix-ui/react-separator": "^1.1.1",
  "@radix-ui/react-slot": "^1.1.1",
  "@radix-ui/react-switch": "^1.1.2",
  "@radix-ui/react-tabs": "^1.1.2",
  "class-variance-authority": "^0.7.1",
  clsx: "^2.1.1",
  "date-fns": "^3.6.0",
  "framer-motion": "^11.18.2",
  "lucide-react": "^0.468.0",
  nanoid: "^5.0.9",
  "server-only": "^0.0.1",
  sonner: "^1.7.1",
  "tailwind-merge": "^2.6.0",
  zod: "^3.24.1",
};

const NODE_BUILTIN_PREFIXES = new Set(["node:", "fs", "path", "crypto", "url", "util", "os", "stream", "buffer"]);
const FRAMEWORK_IMPLICIT_PACKAGES = new Set(["server-only"]);

export function normalizeCorePackageJson(packageJson: PackageJsonShape): PackageJsonShape {
  return {
    ...packageJson,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      ...(packageJson.scripts ?? {}),
    },
    dependencies: {
      ...CORE_DEPENDENCIES,
      ...(packageJson.dependencies ?? {}),
    },
    devDependencies: {
      ...CORE_DEV_DEPENDENCIES,
      ...(packageJson.devDependencies ?? {}),
    },
  };
}

export function normalizePackageJsonForImports(
  packageJson: PackageJsonShape,
  files: Array<{ path: string; content: string }>,
): PackageJsonShape {
  const normalized = normalizeCorePackageJson(packageJson);
  const dependencies = { ...(normalized.dependencies ?? {}) };
  const devDependencies = { ...(normalized.devDependencies ?? {}) };

  if (files.some((file) => file.path === "prisma/schema.prisma")) {
    dependencies["@prisma/client"] = dependencies["@prisma/client"] ?? IMPORT_DEPENDENCY_VERSIONS["@prisma/client"];
    devDependencies.prisma = devDependencies.prisma ?? "^5.22.0";
  }

  for (const packageName of collectImportedPackages(files)) {
    const version = IMPORT_DEPENDENCY_VERSIONS[packageName];
    if (!version || dependencies[packageName] || devDependencies[packageName]) {
      continue;
    }
    dependencies[packageName] = version;
  }

  return {
    ...normalized,
    dependencies,
    devDependencies,
  };
}

export function collectMissingImportDependencies(
  packageJson: PackageJsonShape,
  files: Array<{ path: string; content: string }>,
): string[] {
  const declared = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ]);
  return [...collectImportedPackages(files)]
    .filter((packageName) => Boolean(IMPORT_DEPENDENCY_VERSIONS[packageName]))
    .filter((packageName) => !FRAMEWORK_IMPLICIT_PACKAGES.has(packageName))
    .filter((packageName) => !declared.has(packageName))
    .sort();
}

export function collectImportedPackages(files: Array<{ path: string; content: string }>): Set<string> {
  const packages = new Set<string>();
  for (const file of files) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(file.path)) {
      continue;
    }
    for (const specifier of extractModuleSpecifiers(file.content)) {
      const packageName = toPackageName(specifier);
      if (packageName) {
        packages.add(packageName);
      }
    }
  }
  return packages;
}

function extractModuleSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function toPackageName(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("#") ||
    NODE_BUILTIN_PREFIXES.has(specifier) ||
    [...NODE_BUILTIN_PREFIXES].some((prefix) => specifier.startsWith(`${prefix}/`))
  ) {
    return undefined;
  }

  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : undefined;
  }

  return specifier.split("/")[0];
}
