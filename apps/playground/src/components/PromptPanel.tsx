import { useState } from "react";

interface Props {
  busy: boolean;
  onSend: (content: string) => void;
}

export function PromptPanel({ busy, onSend }: Props) {
  const [draft, setDraft] = useState("");

  function handleSend() {
    if (!draft.trim()) return;
    onSend(draft.trim());
    setDraft("");
  }

  return (
    <section className="panel">
      <div className="section-title">
        <h2>Prompt</h2>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Describe the app you want to generate or the change you want to make."
        rows={7}
      />
      <button type="button" onClick={handleSend} disabled={busy || !draft.trim()}>
        Send to agent
      </button>
    </section>
  );
}
