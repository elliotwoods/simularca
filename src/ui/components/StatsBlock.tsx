import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCopy } from "@fortawesome/free-solid-svg-icons";

export type StatsTone = "default" | "warning" | "error";

export interface StatsRow {
  label: string;
  value: string;
  tone?: StatsTone;
}

export interface StatsGroup {
  label: string;
  rows: StatsRow[];
}

interface StatsBlockProps {
  title: string;
  rows: StatsRow[];
  groups?: StatsGroup[];
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

function schemaLine(label: string, value: string, indent: string): string {
  const cleanLabel = String(label ?? "").replace(/\r?\n/g, " ").trim();
  const cleanValue = String(value ?? "").replace(/\r?\n/g, " | ").trim();
  return `${indent}${cleanLabel}: ${cleanValue}`;
}

function buildSchemaPayload(title: string, rows: StatsRow[], groups?: StatsGroup[]): string {
  if (!groups || groups.length === 0) {
    return [`# ${title}`, ...rows.map((row) => schemaLine(row.label, row.value, ""))].join("\n");
  }
  const lines: string[] = [`# ${title}`];
  for (const group of groups) {
    lines.push(`${group.label}:`);
    if (group.rows.length === 0) {
      lines.push("  (empty)");
      continue;
    }
    for (const row of group.rows) {
      lines.push(schemaLine(row.label, row.value, "  "));
    }
  }
  return lines.join("\n");
}

export function StatsBlock(props: StatsBlockProps) {
  const HeadingTag = props.titleLevel ?? "h3";
  const groups = props.groups?.filter((group) => group.rows.length > 0) ?? [];
  const hasGroups = groups.length > 0;
  const copyPayload = buildSchemaPayload(props.title, props.rows, hasGroups ? groups : undefined);
  const hasRows = props.rows.length > 0;

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
      {!hasRows && !hasGroups ? (
        <p className="panel-empty">{props.emptyText ?? "No stats available."}</p>
      ) : hasGroups ? (
        <div className="stats-groups">
          {groups.map((group) => (
            <details key={group.label} className="stats-group" open>
              <summary>{group.label}</summary>
              <dl className="stats-list stats-list-group">
                {group.rows.map((row) => (
                  <div key={`${group.label}-${row.label}`}>
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
            </details>
          ))}
        </div>
      ) : (
        <dl className="stats-list stats-list-flat">
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
