import type { ProjectRecord, RepairContext } from "@vide/contracts";

import { CommandExecutionError } from "../../runner.js";
import type { WorkspaceService } from "../../workspace.js";

export class PreflightValidationError extends Error {
  constructor(
    public readonly category: RepairContext["category"],
    public readonly failedCommand: string,
    public readonly output: string,
  ) {
    super(output);
    this.name = "PreflightValidationError";
  }
}

export function categorizeCommandFailure(output: string): RepairContext["category"] {
  const lowered = output.toLowerCase();
  if (
    lowered.includes("cannot find module") ||
    lowered.includes("cannot find package") ||
    lowered.includes("failed to resolve import") ||
    lowered.includes("unknown at rule @tailwind") ||
    lowered.includes("tailwindcss") ||
    lowered.includes("postcss") ||
    lowered.includes("npm err!") ||
    lowered.includes("no matching version found")
  ) {
    return "dependency";
  }

  return "type_build";
}

export async function buildRepairContext(
  error: unknown,
  project: ProjectRecord,
  attempt: number,
  workspace: Pick<WorkspaceService, "readPreviewLogTail">,
): Promise<RepairContext> {
  if (error instanceof PreflightValidationError) {
    return {
      attempt,
      category: error.category,
      failedCommand: error.failedCommand,
      buildError: error.output,
    };
  }

  if (error instanceof CommandExecutionError) {
    return {
      attempt,
      category: categorizeCommandFailure(error.output),
      failedCommand: error.command.join(" "),
      buildError: error.output || (await workspace.readPreviewLogTail(project)) || error.message,
    };
  }

  const message = error instanceof Error ? error.message : "Unknown preflight validation error";
  return {
    attempt,
    category: "requirement_mismatch",
    failedCommand: "preflight validation",
    buildError: message,
  };
}
