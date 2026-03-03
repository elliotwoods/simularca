import type { RegisteredPlugin } from "@/features/plugins/pluginApi";

interface PluginsModalProps {
  open: boolean;
  plugins: RegisteredPlugin[];
  loading: boolean;
  lastRefreshSummary: string | null;
  onRefresh: () => void;
  onClose: () => void;
}

export function PluginsModal(props: PluginsModalProps) {
  if (!props.open) {
    return null;
  }

  return (
    <div className="plugins-modal-backdrop" onClick={props.onClose}>
      <div className="plugins-modal" onClick={(event) => event.stopPropagation()}>
        <h3>Plugins</h3>
        <div className="plugins-modal-actions">
          <button type="button" onClick={props.onRefresh} disabled={props.loading}>
            {props.loading ? "Refreshing..." : "Refresh"}
          </button>
          <button type="button" onClick={props.onClose}>
            Close
          </button>
        </div>
        {props.lastRefreshSummary ? <p className="plugins-modal-summary">{props.lastRefreshSummary}</p> : null}
        {props.plugins.length === 0 ? (
          <p className="panel-empty">No plugins loaded.</p>
        ) : (
          <ul className="plugin-list">
            {props.plugins.map((entry) => (
              <li key={entry.definition.id} className="plugins-modal-item">
                <div className="plugins-modal-item-main">
                  <strong>{entry.manifest?.name ?? entry.definition.name}</strong>
                  <span>{entry.manifest?.version ?? "unknown version"}</span>
                </div>
                <small>{entry.source?.modulePath ?? "unknown path"}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

