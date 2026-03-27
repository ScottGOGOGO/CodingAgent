import type { ProjectEvent, ProjectRecord, RunApproveResponse, RunRecord, SessionRecord } from "@vide/contracts";

import { ConflictError } from "../../errors.js";
import { ExecutionWorker } from "../execution-worker.js";
import { decorateStateWithRun, now } from "./run-state.js";

type RunPersistence = {
  persist(project: ProjectRecord, session: SessionRecord, run: RunRecord): Promise<void>;
  publish(event: ProjectEvent): void;
};

export class RunApprovalService {
  constructor(
    private readonly worker: ExecutionWorker,
    private readonly effects: RunPersistence,
  ) {}

  async approveRun(project: ProjectRecord, session: SessionRecord, run: RunRecord, approved: boolean): Promise<RunApproveResponse> {
    if (run.status !== "awaiting_approval") {
      throw new ConflictError("Run is not waiting for approval.");
    }

    if (!approved) {
      run.status = "cancelled";
      run.phase = "report";
      run.updatedAt = now();
      run.error = "Approval declined by user.";
      session.state.status = "failed";
      session.state.error = run.error;
      decorateStateWithRun(session.state, run);
      session.updatedAt = now();
      project.status = "failed";
      project.session = session.state;
      project.latestRun = run;
      project.updatedAt = now();
      await this.effects.persist(project, session, run);
      this.effects.publish({
        type: "run.failed",
        projectId: project.id,
        createdAt: now(),
        payload: { project, run, message: run.error },
      });
      return { project, session, run };
    }

    run.status = "queued";
    run.phase = "execute_dispatch";
    run.updatedAt = now();
    session.state.status = "running";
    session.state.runPhase = "execute_dispatch";
    decorateStateWithRun(session.state, run);
    session.updatedAt = now();
    project.status = "running";
    project.session = session.state;
    project.latestRun = run;
    project.updatedAt = now();

    await this.effects.persist(project, session, run);
    this.worker.enqueue(run.id);
    this.effects.publish({ type: "run.updated", projectId: project.id, createdAt: now(), payload: { project, run } });
    return { project, session, run };
  }
}
