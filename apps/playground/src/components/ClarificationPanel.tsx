import { useState } from "react";
import type { ClarificationQuestion } from "@vide/contracts";

type Drafts = Record<string, string>;

interface Props {
  questions: ClarificationQuestion[];
  busy: boolean;
  onSubmit: (drafts: Drafts) => void;
}

export function ClarificationPanel({ questions, busy, onSubmit }: Props) {
  const [drafts, setDrafts] = useState<Drafts>({});

  if (!questions.length) return null;

  function handleSubmit() {
    onSubmit(drafts);
    setDrafts({});
  }

  return (
    <section className="panel accent">
      <div className="section-title">
        <h2>Clarifications</h2>
      </div>
      {questions.map((q) => (
        <label key={q.id} className="stacked">
          <span>{q.question}</span>
          <input
            value={drafts[q.id] ?? ""}
            placeholder={q.placeholder}
            onChange={(e) => setDrafts((cur) => ({ ...cur, [q.id]: e.target.value }))}
          />
        </label>
      ))}
      <button type="button" onClick={handleSubmit} disabled={busy}>
        Submit answers
      </button>
    </section>
  );
}
