import type { RegisteredPlugin } from "@/features/plugins/pluginApi";
import { GitDirtyBadge } from "@/ui/components/GitDirtyBadge";
import { getPluginGitDirtyBadge, useGitDirtyStatus } from "@/ui/useGitDirtyStatus";

interface PluginsModalProps {
  open: boolean;
  plugins: RegisteredPlugin[];
  loading: boolean;
  lastRefreshSummary: string | null;
  onRefresh: () => void;
  onRefreshPlugin: (pluginId: string) => void;
  onClose: () => void;
}

export function PluginsModal(props: PluginsModalProps) {
  const gitDirtyStatus = useGitDirtyStatus(props.plugins.map((entry) => entry.source?.modulePath));

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
                  <div className="plugins-modal-item-copy">
                    <span className="plugin-list-title">
                      <strong>{entry.manifest?.name ?? entry.definition.name}</strong>
                      <GitDirtyBadge
                        count={getPluginGitDirtyBadge(gitDirtyStatus, entry.source?.modulePath)?.changedFileCount ?? 0}
                      />
                    </span>
                    <span className="plugin-list-meta">
                      {entry.manifest?.version ?? "unknown version"}
                    </span>
                  </div>
                  <div className="plugins-modal-item-actions">
                    {Date.now() - Date.parse(entry.lastLoadedAtIso) < 15000 ? (
                      <span className="plugins-modal-rebuilt-indicator">Just rebuilt</span>
                    ) : null}
                    <button
                      type="button"
                      className="plugins-modal-refresh"
                      title="Reload this plugin"
                      onClick={() => props.onRefreshPlugin(entry.definition.id)}
                    >
                      Refresh
                    </button>
                  </div>
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
