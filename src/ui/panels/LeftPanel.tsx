import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { SceneTree } from "@/ui/components/SceneTree";
import { AddActorMenu } from "@/ui/components/AddActorMenu";
import { StatsBlock } from "@/ui/components/StatsBlock";

interface LeftPanelProps {
  pendingDropFileName?: string | null;
}

function formatMegabytes(value: number): string {
  return `${value.toFixed(1)} MB`;
}

function formatInteger(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString();
}

export function LeftPanel(props: LeftPanelProps) {
  const kernel = useKernel();
  const stats = useAppStore((store) => store.state.stats);
  const selection = useAppStore((store) => store.state.selection);
  const mode = useAppStore((store) => store.state.mode);
  const actorIds = useAppStore((store) => store.state.scene.actorIds);
  const actors = useAppStore((store) => store.state.actors);
  const readOnly = mode === "web-ro";
  const plugins = kernel.pluginApi.listPlugins();
  const rootActorCount = actorIds.reduce((count, actorId) => (actors[actorId] ? count + 1 : count), 0);

  const onDropSceneGraphSection = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    const actorId = event.dataTransfer.getData("text/plain");
    if (!actorId) {
      return;
    }
    kernel.store.getState().actions.reorderActor(actorId, null, rootActorCount);
  };

  return (
    <div className="left-panel">
      <section className="panel-section" onDrop={onDropSceneGraphSection} onDragOver={(event) => event.preventDefault()}>
        <header>
          <h3>Scene Graph</h3>
          <div className="inline-actions">
            <AddActorMenu disabled={readOnly} />
          </div>
        </header>
        <SceneTree pendingDropFileName={props.pendingDropFileName} />
      </section>

      <section className="panel-section">
        <StatsBlock
          title="Scene Stats"
          className="stats-block-embedded"
          titleLevel="h3"
          rows={[
            { label: "FPS", value: `${stats.fps.toFixed(1)} (${stats.frameMs.toFixed(1)} ms)` },
            { label: "Draw Calls", value: formatInteger(stats.drawCalls) },
            { label: "Triangles", value: formatInteger(stats.triangles) },
            { label: "Splat Draw Calls", value: formatInteger(stats.splatDrawCalls) },
            { label: "Splat Triangles", value: formatInteger(stats.splatTriangles) },
            { label: "Splat Visible", value: formatInteger(stats.splatVisibleCount) },
            { label: "Memory MB", value: formatMegabytes(stats.memoryMb) },
            {
              label: "Memory Split",
              value: `heap ${stats.heapMb > 0 ? formatMegabytes(stats.heapMb) : "n/a"} / resource ${formatMegabytes(stats.resourceMb)}`
            },
            { label: "Actors", value: formatInteger(stats.actorCount) },
            { label: "Enabled", value: `${formatInteger(stats.actorCountEnabled)} / ${formatInteger(stats.actorCount)}` },
            { label: "Session Bytes", value: formatInteger(stats.sessionFileBytes) },
            { label: "Saved Bytes", value: formatInteger(stats.sessionFileBytesSaved) },
            { label: "Selection", value: String(selection.length) }
          ]}
          onCopySuccess={(label) => {
            kernel.store.getState().actions.setStatus(`${label} copied to clipboard.`);
          }}
          onCopyError={(label, message) => {
            kernel.store.getState().actions.setStatus(`Unable to copy ${label}: ${message}`);
          }}
        />
      </section>

      <section className="panel-section">
        <header>
          <h3>Plugins</h3>
        </header>
        {plugins.length === 0 ? (
          <p className="panel-empty">No plugins loaded.</p>
        ) : (
          <ul className="plugin-list">
            {plugins.map((entry) => (
              <li key={entry.definition.id}>
                <strong>{entry.manifest?.name ?? entry.definition.name}</strong>
                <span>{entry.manifest?.version ?? "unknown version"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

