import type { PlanStep } from "@vide/contracts";

interface Props {
  steps: PlanStep[];
  fileChangeSummary: string[];
  versions: { id: string; number: number; summary: string }[];
}

export function PlanPanel({ steps, fileChangeSummary, versions }: Props) {
  return (
    <>
      <article className="panel">
        <div className="section-title">
          <h2>Plan</h2>
        </div>
        <ul className="bullets">
          {steps.length ? (
            steps.map((step) => (
              <li key={step.id}>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </li>
            ))
          ) : (
            <li>
              <strong>Waiting for a prompt</strong>
              <span>The agent will surface the normalized plan here.</span>
            </li>
          )}
        </ul>
      </article>

      <article className="panel">
        <div className="section-title">
          <h2>File changes</h2>
        </div>
        <ul className="bullets">
          {fileChangeSummary.length ? (
            fileChangeSummary.map((item) => (
              <li key={item}>
                <strong>Pending write</strong>
                <span>{item}</span>
              </li>
            ))
          ) : (
            <li>
              <strong>No pending file changes</strong>
              <span>Once the agent prepares a version, the summary shows up here.</span>
            </li>
          )}
        </ul>
      </article>

      <article className="panel">
        <div className="section-title">
          <h2>Versions</h2>
        </div>
        <ul className="bullets">
          {versions.length ? (
            versions
              .slice()
              .reverse()
              .map((v) => (
                <li key={v.id}>
                  <strong>v{v.number}</strong>
                  <span>{v.summary}</span>
                </li>
              ))
          ) : (
            <li>
              <strong>No snapshots yet</strong>
              <span>Approving a generated plan creates the first workspace version.</span>
            </li>
          )}
        </ul>
      </article>
    </>
  );
}
