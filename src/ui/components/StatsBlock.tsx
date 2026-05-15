import { CopyContentsButton } from "@/ui/components/CopyContentsButton";

export type StatsTone = "default" | "warning" | "error";

export interface StatsRow {
  label: string;
  value: string;
  tone?: StatsTone;
  groupKey?: string;
  groupLabel?: string;
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
        <CopyContentsButton
          className="stats-block-copy"
          text={copyPayload}
          title="Copy panel contents"
          ariaLabel="Copy panel contents"
          onCopySuccess={() => {
            props.onCopySuccess?.(props.title);
          }}
          onCopyError={(message) => {
            props.onCopyError?.(props.title, message);
          }}
        />
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
