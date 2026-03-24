import type { ProjectRecord, ReasoningMode } from "@vide/contracts";

interface Props {
  project: ProjectRecord | null;
  mode: ReasoningMode;
  onNewProject: () => void;
  onChangeMode: (mode: ReasoningMode) => void;
}

export function ControlPanel({ project, mode, onNewProject, onChangeMode }: Props) {
  return (
    <section className="panel">
      <div className="section-title">
        <h2>Session</h2>
        <button type="button" className="ghost" onClick={onNewProject}>
          New Project
        </button>
      </div>
      <label className="stacked">
        <span>Reasoning mode</span>
        <select value={mode} onChange={(e) => onChangeMode(e.target.value as ReasoningMode)}>
          <option value="plan_solve">plan_solve</option>
          <option value="react">react</option>
        </select>
      </label>
      <div className="meta-grid">
        <div>
          <span>Status</span>
          <strong>{project?.status ?? "booting"}</strong>
        </div>
        <div>
          <span>Version</span>
          <strong>v{project?.session.versionNumber ?? 0}</strong>
        </div>
      </div>
      {project?.session.assistantSummary ? (
        <p className="summary">{project.session.assistantSummary}</p>
      ) : null}
    </section>
  );
}
