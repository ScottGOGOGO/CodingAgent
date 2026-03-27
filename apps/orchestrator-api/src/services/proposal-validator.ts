import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSessionState, ProjectRecord, RunRecord } from "@vide/contracts";

import type { WorkspaceService } from "../workspace.js";
import { tryAutofix } from "./preflight/autofixers.js";
import {
  cloneState,
  createValidationProject,
  snapshotToWriteOperations,
} from "./preflight/manifest-defaults.js";
import { PreflightValidationError } from "./preflight/repair-context.js";
import { detectStaticValidationIssue } from "./preflight/static-validator.js";

const MAX_PREFLIGHT_AUTOFIX_ATTEMPTS = 2;

export { detectStaticValidationIssue } from "./preflight/static-validator.js";

export class ProposalValidator {
  constructor(private readonly workspace: WorkspaceService) {}

  async validate(project: ProjectRecord, run: RunRecord): Promise<AgentSessionState> {
    const tempRoot = await mkdtemp(join(tmpdir(), "vide-preflight-"));
    const candidateState = cloneState(run.state);
    const preservedMessages = cloneState(run.state.messages);
    const validationProject = createValidationProject(project, tempRoot, candidateState);

    try {
      await this.workspace.ensureProjectWorkspace(validationProject);
      await this.workspace.resetPreviewLog(validationProject);
      await this.workspace.applyFileOperations(validationProject, candidateState.fileOperations);

      for (let attempt = 1; attempt <= MAX_PREFLIGHT_AUTOFIX_ATTEMPTS + 1; attempt += 1) {
        const startedAt = Date.now();
        const currentFiles = await this.workspace.readWorkspaceFiles(validationProject);
        const staticIssue = detectStaticValidationIssue(currentFiles);
        console.info(
          `[proposal-validator] stage=preflight_static_check projectId=${project.id} attempt=${attempt} durationMs=${Date.now() - startedAt} passed=${staticIssue ? "false" : "true"}`,
        );

        if (!staticIssue) {
          candidateState.fileOperations = snapshotToWriteOperations(currentFiles);
          candidateState.fileChangeSummary = candidateState.fileOperations.map(
            (operation) => operation.summary ?? operation.path,
          );
          candidateState.messages = preservedMessages;
          candidateState.error = undefined;
          candidateState.status = "awaiting_approval";
          candidateState.runPhase = "report";
          return candidateState;
        }

        const validationError = new PreflightValidationError(
          "requirement_mismatch",
          "preflight static validation",
          staticIssue,
        );
        if (attempt > MAX_PREFLIGHT_AUTOFIX_ATTEMPTS) {
          throw validationError;
        }

        const autofixStartedAt = Date.now();
        const autofixed = await tryAutofix(validationProject, validationError);
        console.info(
          `[proposal-validator] stage=preflight_autofix projectId=${project.id} attempt=${attempt} durationMs=${Date.now() - autofixStartedAt} changed=${autofixed ? "true" : "false"}`,
        );
        if (!autofixed) {
          throw validationError;
        }
      }

      throw new Error("Pre-approval validation exhausted its autofix budget.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}
