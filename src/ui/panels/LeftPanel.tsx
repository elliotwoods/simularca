import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { SceneTree } from "@/ui/components/SceneTree";
import { AddActorMenu } from "@/ui/components/AddActorMenu";

interface LeftPanelProps {
  pendingDropFileName?: string | null;
}

export function LeftPanel(props: LeftPanelProps) {
  const kernel = useKernel();
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

