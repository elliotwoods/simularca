import { useMemo, useRef, useState } from "react";
import { useAppStore } from "@/app/useAppStore";
import { useKernel } from "@/app/useKernel";
import { executeConsoleSource, getConsoleCompletions } from "@/core/console/runtime";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

export function ConsolePanel() {
  const kernel = useKernel();
  const entries = useAppStore((store) => store.state.consoleEntries);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [cursor, setCursor] = useState(0);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const orderedEntries = useMemo(() => [...entries].reverse(), [entries]);
  const completionState = useMemo(() => getConsoleCompletions(source, cursor), [source, cursor]);
  const suggestions = completionState.items;
  const activeSuggestion = suggestions[activeSuggestionIndex];
  const activeDoc = useMemo(() => {
    if (completionState.activeDoc) {
      return completionState.activeDoc;
    }
    if (!activeSuggestion) {
      return undefined;
    }
    const detail = activeSuggestion.detail;
    const documentation = activeSuggestion.documentation;
    return {
      path: activeSuggestion.label,
      signature: detail,
      description: documentation ?? "",
      examples: []
    };
  }, [activeSuggestion, completionState.activeDoc]);

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

  const applyCompletion = (insertText: string): void => {
    const selectionStart = inputRef.current?.selectionStart ?? cursor;
    const prefix = source.slice(0, selectionStart);
    const tokenMatch = prefix.match(/[a-zA-Z_$][\w$.]*$/);
    const tokenStart = tokenMatch ? selectionStart - tokenMatch[0].length : selectionStart;
    const next = `${source.slice(0, tokenStart)}${insertText}${source.slice(selectionStart)}`;
    setSource(next);
    setShowSuggestions(true);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const nextCursor = tokenStart + insertText.length;
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
      setCursor(nextCursor);
    });
  };

  const runCommand = async (): Promise<void> => {
    const trimmed = source.trim();
    if (!trimmed) {
      return;
    }
    const commandId = kernel.store.getState().actions.appendCommandEntry({
      source: trimmed,
      status: "running"
    });
    setHistory((current) => [trimmed, ...current.slice(0, 99)]);
    setHistoryIndex(-1);
    setSource("");
    setCursor(0);
    setShowSuggestions(false);

    const result = await executeConsoleSource(kernel, trimmed);
    if (result.ok) {
      kernel.store.getState().actions.updateCommandEntry(commandId, {
        status: "success",
        summary: result.summary,
        result: result.result,
        details: result.details,
        finishedAtIso: new Date().toISOString()
      });
      return;
    }
    kernel.store.getState().actions.updateCommandEntry(commandId, {
      status: "error",
      summary: result.summary,
      error: result.error,
      details: result.details,
      finishedAtIso: new Date().toISOString()
    });
  };

  return (
    <section className="console-panel">
      <header>
        <div className="console-command-box">
          <textarea
            ref={inputRef}
            className="console-command-input"
            placeholder="Type JavaScript command... (e.g. actor.list())"
            value={source}
            rows={1}
            onFocus={() => {
              setCursor(inputRef.current?.selectionStart ?? source.length);
              setShowSuggestions(true);
            }}
            onBlur={() => {
              window.setTimeout(() => {
                setShowSuggestions(false);
              }, 120);
            }}
            onChange={(event) => {
              setSource(event.target.value);
              setCursor(event.target.selectionStart ?? event.target.value.length);
              setShowSuggestions(true);
              setActiveSuggestionIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void runCommand();
                return;
              }
              if (event.key === "Tab" && suggestions.length > 0) {
                event.preventDefault();
                const selected = suggestions[activeSuggestionIndex] ?? suggestions[0];
                if (selected) {
                  applyCompletion(selected.insertText);
                }
                return;
              }
              if (event.key === "ArrowDown" && showSuggestions && suggestions.length > 0) {
                event.preventDefault();
                setActiveSuggestionIndex((current) => (current + 1) % suggestions.length);
                return;
              }
              if (event.key === "ArrowUp" && showSuggestions && suggestions.length > 0) {
                event.preventDefault();
                setActiveSuggestionIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === "ArrowUp" && !showSuggestions) {
                event.preventDefault();
                if (history.length === 0) {
                  return;
                }
                const nextIndex = Math.min(history.length - 1, historyIndex + 1);
                setHistoryIndex(nextIndex);
                setSource(history[nextIndex] ?? "");
                window.requestAnimationFrame(() => {
                  const end = (history[nextIndex] ?? "").length;
                  inputRef.current?.setSelectionRange(end, end);
                  setCursor(end);
                });
                return;
              }
              if (event.key === "ArrowDown" && !showSuggestions && historyIndex >= 0) {
                event.preventDefault();
                const nextIndex = historyIndex - 1;
                if (nextIndex < 0) {
                  setHistoryIndex(-1);
                  setSource("");
                  return;
                }
                setHistoryIndex(nextIndex);
                setSource(history[nextIndex] ?? "");
                return;
              }
              if (event.key === "Escape") {
                setShowSuggestions(false);
                return;
              }
              if (event.ctrlKey && event.key === " ") {
                event.preventDefault();
                setShowSuggestions(true);
              }
            }}
            onClick={(event) => {
              setCursor((event.target as HTMLTextAreaElement).selectionStart ?? 0);
            }}
            onKeyUp={(event) => {
              setCursor((event.target as HTMLTextAreaElement).selectionStart ?? 0);
            }}
          />
          {showSuggestions && suggestions.length > 0 ? (
            <div className="console-complete-popover">
              <div className="console-complete-list">
                {suggestions.map((item, index) => (
                  <button
                    key={`${item.label}:${String(index)}`}
                    type="button"
                    className={`console-complete-item ${index === activeSuggestionIndex ? "active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyCompletion(item.insertText);
                    }}
                    onMouseEnter={() => {
                      setActiveSuggestionIndex(index);
                    }}
                  >
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                  </button>
                ))}
              </div>
              {activeDoc ? (
                <aside className="console-complete-doc">
                  <h4>{activeDoc.path}</h4>
                  <code>{activeDoc.signature}</code>
                  <p>{activeDoc.description}</p>
                  {activeDoc.examples.length > 0 ? <pre>{activeDoc.examples[0]}</pre> : null}
                </aside>
              ) : null}
            </div>
          ) : null}
        </div>
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
        {orderedEntries.length === 0 ? (
          <p className="console-empty">No log messages.</p>
        ) : (
          orderedEntries.map((entry) => {
            if (entry.kind === "command") {
              const payload = [
                `[${entry.timestampIso}] COMMAND: ${entry.source}`,
                entry.summary ?? "",
                entry.error ?? "",
                entry.details ?? ""
              ]
                .filter((line) => line.length > 0)
                .join("\n");
              return (
                <article key={entry.id} className={`console-log-entry command ${entry.status}`}>
                  <button
                    type="button"
                    className="console-log-summary"
                    title="Copy command result"
                    onClick={() => {
                      void copyToClipboard(payload).then(() => {
                        setCopiedId(entry.id);
                        window.setTimeout(() => {
                          setCopiedId((current) => (current === entry.id ? null : current));
                        }, 1200);
                      });
                    }}
                  >
                    <span>{formatTime(entry.timestampIso)}</span>
                    <strong>{entry.status.toUpperCase()}</strong>
                    <span>{copiedId === entry.id ? "Copied to clipboard" : entry.source}</span>
                  </button>
                  <div className="console-command-summary">
                    {entry.summary ?? (entry.status === "running" ? "Running..." : "")}
                    {entry.error ? <span className="console-command-error">{entry.error}</span> : null}
                  </div>
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
                  {expandedId === entry.id && entry.details ? <pre className="console-log-details">{entry.details}</pre> : null}
                </article>
              );
            }

            const payload = [`[${entry.timestampIso}] ${entry.level.toUpperCase()}: ${entry.message}`, entry.details ?? ""]
              .filter((line) => line.length > 0)
              .join("\n");
            return (
              <article key={entry.id} className={`console-log-entry ${entry.level}`}>
                <button
                  type="button"
                  className="console-log-summary"
                  title="Copy log entry"
                  onClick={() => {
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
                {expandedId === entry.id && entry.details ? <pre className="console-log-details">{entry.details}</pre> : null}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
