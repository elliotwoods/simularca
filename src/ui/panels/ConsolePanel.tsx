import { useMemo, useState } from "react";
import { useAppStore } from "@/app/useAppStore";
import { useKernel } from "@/app/useKernel";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

export function ConsolePanel() {
  const kernel = useKernel();
  const logs = useAppStore((store) => store.state.consoleLogs);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const orderedLogs = useMemo(() => [...logs].reverse(), [logs]);

  const copyToClipboard = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-99999px";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
    }
  };

  return (
    <section className="console-panel">
      <header>
        <button
          type="button"
          title="Clear console logs"
          onClick={() => {
            kernel.store.getState().actions.clearLogs();
          }}
        >
          Clear
        </button>
      </header>
      <div className="console-log-list">
        {orderedLogs.length === 0 ? (
          <p className="console-empty">No log messages.</p>
        ) : (
          orderedLogs.map((entry) => (
            <article key={entry.id} className={`console-log-entry ${entry.level}`}>
              <button
                type="button"
                className="console-log-summary"
                title="Copy log entry"
                onClick={() => {
                  const payload = [
                    `[${entry.timestampIso}] ${entry.level.toUpperCase()}: ${entry.message}`,
                    entry.details ?? ""
                  ]
                    .filter((line) => line.length > 0)
                    .join("\n");
                  void copyToClipboard(payload).then(() => {
                    setCopiedId(entry.id);
                    window.setTimeout(() => {
                      setCopiedId((current) => (current === entry.id ? null : current));
                    }, 1200);
                  });
                }}
              >
                <span>{formatTime(entry.timestampIso)}</span>
                <strong>{entry.level.toUpperCase()}</strong>
                <span>{copiedId === entry.id ? "Copied to clipboard" : entry.message}</span>
              </button>
              {entry.details ? (
                <div className="console-log-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setExpandedId((current) => (current === entry.id ? null : entry.id));
                    }}
                  >
                    {expandedId === entry.id ? "Hide details" : "Show details"}
                  </button>
                </div>
              ) : null}
              {expandedId === entry.id && entry.details ? (
                <pre className="console-log-details">{entry.details}</pre>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
