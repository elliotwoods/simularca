import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { SceneTree } from "@/ui/components/SceneTree";
import { AddActorMenu } from "@/ui/components/AddActorMenu";

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
        <header>
          <h3>Scene Stats</h3>
        </header>
        <dl className="stats-list">
          <div>
            <dt>FPS</dt>
            <dd>
              {stats.fps.toFixed(1)} ({stats.frameMs.toFixed(1)} ms)
            </dd>
          </div>
          <div>
            <dt>Draw Calls</dt>
            <dd>{formatInteger(stats.drawCalls)}</dd>
          </div>
          <div>
            <dt>Render Split</dt>
            <dd>
              main {formatInteger(stats.drawCallsMain)} / overlay {formatInteger(stats.drawCallsOverlay)} calls
            </dd>
          </div>
          <div>
            <dt>Triangles</dt>
            <dd>{formatInteger(stats.triangles)}</dd>
          </div>
          <div>
            <dt>Geo Split</dt>
            <dd>
              main {formatInteger(stats.trianglesMain)} / overlay {formatInteger(stats.trianglesOverlay)} tris
            </dd>
          </div>
          <div>
            <dt>Splat Points</dt>
            <dd>{formatInteger(stats.overlayPoints)}</dd>
          </div>
          <div>
            <dt>Memory MB</dt>
            <dd>{formatMegabytes(stats.memoryMb)}</dd>
          </div>
          <div>
            <dt>Memory Split</dt>
            <dd>
              heap {stats.heapMb > 0 ? formatMegabytes(stats.heapMb) : "n/a"} / resource {formatMegabytes(stats.resourceMb)}
            </dd>
          </div>
          <div>
            <dt>Actors</dt>
            <dd>{formatInteger(stats.actorCount)}</dd>
          </div>
          <div>
            <dt>Enabled</dt>
            <dd>
              {formatInteger(stats.actorCountEnabled)} / {formatInteger(stats.actorCount)}
            </dd>
          </div>
          <div>
            <dt>Session Bytes</dt>
            <dd>{formatInteger(stats.sessionFileBytes)}</dd>
          </div>
          <div>
            <dt>Saved Bytes</dt>
            <dd>{formatInteger(stats.sessionFileBytesSaved)}</dd>
          </div>
          <div>
            <dt>Selection</dt>
            <dd>{selection.length}</dd>
          </div>
        </dl>
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

