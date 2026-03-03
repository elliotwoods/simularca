import { useState } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { ActorNode } from "@/core/types";

type SelectionEntry = { kind: string; id: string };

function isSelected(selection: SelectionEntry[], actorId: string): boolean {
  return selection.some((entry) => entry.kind === "actor" && entry.id === actorId);
}

function ActorItem(props: { actor: ActorNode; depth: number }) {
  const kernel = useKernel();
  const selection = useAppStore((store) => store.state.selection);
  const actors = useAppStore((store) => store.state.actors);
  const actorStatusByActorId = useAppStore((store) => store.state.actorStatusByActorId);
  const [expanded, setExpanded] = useState(true);
  const isActive = isSelected(selection, props.actor.id);
  const runtimeStatus = actorStatusByActorId[props.actor.id];
  const loadState = typeof runtimeStatus?.values?.loadState === "string" ? runtimeStatus.values.loadState : undefined;
  const isLoading = loadState === "loading";
  const hasError = Boolean(runtimeStatus?.error);

  const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const additive = event.metaKey || event.ctrlKey;
    kernel.store.getState().actions.select([{ kind: "actor", id: props.actor.id }], additive);
  };

  const onDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData("text/plain", props.actor.id);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const actorId = event.dataTransfer.getData("text/plain");
    if (!actorId || actorId === props.actor.id) {
      return;
    }
    const targetChildren = props.actor.childActorIds.length;
    kernel.store.getState().actions.reorderActor(actorId, props.actor.id, targetChildren);
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  return (
    <div className="scene-tree-item" draggable onDragStart={onDragStart} onDrop={onDrop} onDragOver={onDragOver}>
      <div className="scene-tree-item-row" style={{ paddingLeft: `${8 + props.depth * 12}px` }}>
        <button className="scene-tree-expand" type="button" onClick={() => setExpanded((value) => !value)}>
          {props.actor.childActorIds.length > 0 ? (expanded ? "▾" : "▸") : "•"}
        </button>
        <button className={`scene-tree-label ${isActive ? "selected" : ""}`} type="button" onClick={onClick}>
          {props.actor.name}
        </button>
        {isLoading ? <span className="scene-tree-load-state loading" title="Loading asset..." /> : null}
        {hasError ? <span className="scene-tree-load-state error" title={runtimeStatus?.error ?? "Load failed"} /> : null}
      </div>
      {expanded &&
        props.actor.childActorIds.map((childId) => {
          const child = actors[childId];
          if (!child) {
            return null;
          }
          return <ActorItem key={child.id} actor={child} depth={props.depth + 1} />;
        })}
    </div>
  );
}

interface SceneTreeProps {
  pendingDropFileName?: string | null;
}

export function SceneTree(props: SceneTreeProps) {
  const kernel = useKernel();
  const actorIds = useAppStore((store) => store.state.scene.actorIds);
  const actors = useAppStore((store) => store.state.actors);
  const rootActors = actorIds.map((id) => actors[id]).filter((actor): actor is ActorNode => Boolean(actor));

  const onDropRoot = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const actorId = event.dataTransfer.getData("text/plain");
    if (!actorId) {
      return;
    }
    kernel.store.getState().actions.reorderActor(actorId, null, rootActors.length);
  };

  return (
    <div className="scene-tree-root" onDrop={onDropRoot} onDragOver={(event) => event.preventDefault()}>
      {props.pendingDropFileName ? (
        <div className="scene-tree-import-placeholder" title="A file is currently being dragged for import.">
          <span className="scene-tree-import-dot">+</span>
          <span className="scene-tree-import-text">Pending Import: {props.pendingDropFileName}</span>
        </div>
      ) : null}
      {rootActors.map((actor) => (
        <ActorItem key={actor.id} actor={actor} depth={0} />
      ))}
    </div>
  );
}
