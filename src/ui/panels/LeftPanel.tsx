import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { SceneTree } from "@/ui/components/SceneTree";
import { AddActorMenu } from "@/ui/components/AddActorMenu";
import { GitDirtyBadge } from "@/ui/components/GitDirtyBadge";
import { getPluginGitDirtyBadge, useGitDirtyStatus } from "@/ui/useGitDirtyStatus";
import { usePluginRegistryRevision } from "@/features/plugins/usePluginRegistryRevision";
import { isPluginEnabled } from "@/features/plugins/pluginEnabled";

interface LeftPanelProps {
  pendingDropFileName?: string | null;
}

export function LeftPanel(props: LeftPanelProps) {
  const kernel = useKernel();
  usePluginRegistryRevision();
  const mode = useAppStore((store) => store.state.mode);
  const canCreateActors = useAppStore((store) => store.state.viewerPermissions?.canCreateActors ?? false);
  const selection = useAppStore((store) => store.state.selection);
  const pluginsEnabled = useAppStore((store) => store.state.pluginsEnabled);
  const readOnly = mode === "web-ro" && !canCreateActors;
  const plugins = kernel.pluginApi.listPlugins();
  const gitDirtyStatus = useGitDirtyStatus(plugins.map((entry) => entry.source?.modulePath));

  return (
    <div className="left-panel">
      <section className="panel-section">
        <header>
          <h3>Scene Graph</h3>
          <div className="inline-actions">
            <AddActorMenu disabled={readOnly} buttonTitle="Add actor" />
          </div>
        </header>
        <SceneTree pendingDropFileName={props.pendingDropFileName} />
      </section>

      <section className="panel-section">
        <header>
          <h3>Plugins</h3>
        </header>
        {plugins.length === 0 ? (
          <p className="panel-empty">No plugins loaded.</p>
        ) : (
          <ul className="plugin-list">
            {plugins.map((entry) => {
              const enabled = isPluginEnabled(pluginsEnabled, entry.definition.id);
              const isSelected =
                selection.length === 1 &&
                selection[0]?.kind === "plugin" &&
                selection[0].id === entry.definition.id;
              return (
                <li key={entry.definition.id}>
                  <button
                    type="button"
                    className={`plugin-list-button${isSelected ? " is-selected" : ""}${enabled ? "" : " is-disabled"}`}
                    onClick={() => kernel.store.getState().actions.select([{ kind: "plugin", id: entry.definition.id }], false)}
                  >
                    <span className="plugin-list-title">
                      <strong>{entry.manifest?.name ?? entry.definition.name}</strong>
                      <GitDirtyBadge count={getPluginGitDirtyBadge(gitDirtyStatus, entry.source?.modulePath)?.changedFileCount ?? 0} />
                    </span>
                    <span className="plugin-list-meta">
                      {entry.manifest?.version ?? "unknown version"}
                      {enabled ? null : <span className="plugin-list-disabled-tag"> (disabled)</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

