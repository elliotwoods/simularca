import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCopy } from "@fortawesome/free-solid-svg-icons";

export type StatsTone = "default" | "warning" | "error";

export interface StatsRow {
  label: string;
  value: string;
  tone?: StatsTone;
}

interface StatsBlockProps {
  title: string;
  rows: StatsRow[];
  className?: string;
  titleLevel?: "h3" | "h4";
  emptyText?: string;
  onCopySuccess?: (title: string) => void;
  onCopyError?: (title: string, message: string) => void;
}

async function copyToClipboard(text: string): Promise<void> {
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
}

export function StatsBlock(props: StatsBlockProps) {
  const HeadingTag = props.titleLevel ?? "h3";
  const copyPayload = [props.title, ...props.rows.map((row) => `${row.label}: ${row.value}`)].join("\n");

  return (
    <section className={`stats-block ${props.className ?? ""}`.trim()}>
      <header className="stats-block-header">
        <HeadingTag>{props.title}</HeadingTag>
        <button
          type="button"
          className="stats-block-copy"
          title="Copy panel contents"
          onClick={() => {
            void copyToClipboard(copyPayload)
              .then(() => {
                props.onCopySuccess?.(props.title);
              })
              .catch((error) => {
                const message = error instanceof Error ? error.message : "Clipboard write failed";
                props.onCopyError?.(props.title, message);
              });
          }}
        >
          <FontAwesomeIcon icon={faCopy} />
        </button>
      </header>
      {props.rows.length === 0 ? (
        <p className="panel-empty">{props.emptyText ?? "No stats available."}</p>
      ) : (
        <dl className="stats-list">
          {props.rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd
                className={
                  row.tone === "error"
                    ? "stats-value-error"
                    : row.tone === "warning"
                      ? "stats-value-warning"
                      : undefined
                }
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
