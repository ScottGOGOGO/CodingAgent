interface Props {
  previewUrl?: string;
  logs: string[];
}

export function PreviewPanel({ previewUrl, logs }: Props) {
  return (
    <>
      <section className="panel preview-panel">
        <div className="section-title">
          <h2>Preview</h2>
          <span>{previewUrl ?? "No preview running"}</span>
        </div>
        {previewUrl ? (
          <iframe title="Generated preview" src={previewUrl} />
        ) : (
          <div className="preview-empty">
            Preview output will appear here after confirmation and runner startup.
          </div>
        )}
      </section>

      <section className="panel logs-panel">
        <div className="section-title">
          <h2>Runner logs</h2>
        </div>
        <pre>{logs.length ? logs.join("\n") : "No runner logs yet."}</pre>
      </section>
    </>
  );
}
