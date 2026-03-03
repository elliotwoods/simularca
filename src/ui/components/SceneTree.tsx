import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBullseye, faChevronDown, faChevronRight, faEye, faEyeSlash } from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { ActorNode, ActorVisibilityMode } from "@/core/types";

type SelectionEntry = { kind: string; id: string };

function isSelected(selection: SelectionEntry[], actorId: string): boolean {
  return selection.some((entry) => entry.kind === "actor" && entry.id === actorId);
}

function visibilityTitle(mode: ActorVisibilityMode): string {
  if (mode === "hidden") {
    return "Hidden (click to set visible when selected)";
  }
  if (mode === "selected") {
    return "Visible when selected (click to set always visible)";
  }
  return "Visible (click to hide)";
}

function nextVisibilityMode(mode: ActorVisibilityMode): ActorVisibilityMode {
  if (mode === "visible") {
    return "hidden";
  }
  if (mode === "hidden") {
    return "selected";
  }
  return "visible";
}

function visibilityIcon(mode: ActorVisibilityMode) {
  if (mode === "hidden") {
    return faEyeSlash;
  }
  if (mode === "selected") {
    return faBullseye;
  }
  return faEye;
}

function ActorItem(props: { actor: ActorNode; depth: number }) {
  const kernel = useKernel();
  const selection = useAppStore((store) => store.state.selection);
  const actors = useAppStore((store) => store.state.actors);
  const actorStatusByActorId = useAppStore((store) => store.state.actorStatusByActorId);
  const mode = useAppStore((store) => store.state.mode);
  const [expanded, setExpanded] = useState(true);
  const [isRenaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(props.actor.name);
  const isActive = isSelected(selection, props.actor.id);
  const runtimeStatus = actorStatusByActorId[props.actor.id];
  const loadState = typeof runtimeStatus?.values?.loadState === "string" ? runtimeStatus.values.loadState : undefined;
  const isLoading = loadState === "loading";
  const hasError = Boolean(runtimeStatus?.error);
  const readOnly = mode === "web-ro";
  const visibilityMode = props.actor.visibilityMode ?? "visible";

  useEffect(() => {
    if (!isRenaming) {
      setDraftName(props.actor.name);
    }
  }, [isRenaming, props.actor.name]);

  const onClickLabel = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isRenaming) {
      return;
    }
    const additive = event.metaKey || event.ctrlKey;
    kernel.store.getState().actions.select([{ kind: "actor", id: props.actor.id }], additive);
  };

  const commitRename = () => {
    const nextName = draftName.trim();
    setRenaming(false);
    if (!nextName || nextName === props.actor.name || readOnly) {
      setDraftName(props.actor.name);
      return;
    }
    kernel.store.getState().actions.renameNode({ kind: "actor", id: props.actor.id }, nextName);
  };

  const cancelRename = () => {
    setDraftName(props.actor.name);
    setRenaming(false);
  };

  const onDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    if (isRenaming) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.setData("text/plain", props.actor.id);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const actorId = event.dataTransfer.getData("text/plain");
    if (!actorId || actorId === props.actor.id) {
      return;
    }
    const targetChildren = props.actor.childActorIds.length;
    kernel.store.getState().actions.reorderActor(actorId, props.actor.id, targetChildren);
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="scene-tree-item" onDrop={onDrop} onDragOver={onDragOver}>
      <div className="scene-tree-item-row" draggable={!isRenaming} onDragStart={onDragStart} style={{ paddingLeft: `${8 + props.depth * 12}px` }}>
        <button
          className={`scene-tree-expand${props.actor.childActorIds.length === 0 ? " placeholder" : ""}`}
          type="button"
          disabled={props.actor.childActorIds.length === 0}
          title={props.actor.childActorIds.length > 0 ? (expanded ? "Collapse" : "Expand") : "No children"}
          onClick={() => setExpanded((value) => !value)}
        >
          <FontAwesomeIcon icon={expanded ? faChevronDown : faChevronRight} />
        </button>
        <button
          className={`scene-tree-visibility ${visibilityMode}`}
          type="button"
          disabled={readOnly}
          title={visibilityTitle(visibilityMode)}
          onClick={(event) => {
            event.stopPropagation();
            if (readOnly) {
              return;
            }
            kernel.store.getState().actions.setActorVisibilityMode(props.actor.id, nextVisibilityMode(visibilityMode));
          }}
        >
          <FontAwesomeIcon icon={visibilityIcon(visibilityMode)} />
        </button>
        {isRenaming ? (
          <input
            className="scene-tree-rename-input"
            value={draftName}
            autoFocus
            onFocus={(event) => {
              const end = event.target.value.length;
              event.target.setSelectionRange(0, end);
            }}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => {
              commitRename();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancelRename();
              }
            }}
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <button
            className={`scene-tree-label ${isActive ? "selected" : ""}`}
            type="button"
            onClick={onClickLabel}
            onDoubleClick={() => {
              if (!readOnly) {
                setRenaming(true);
              }
            }}
          >
            {props.actor.name}
          </button>
        )}
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
  const scene = useAppStore((store) => store.state.scene);
  const selection = useAppStore((store) => store.state.selection);
  const actorIds = useAppStore((store) => store.state.scene.actorIds);
  const actors = useAppStore((store) => store.state.actors);
  const [sceneExpanded, setSceneExpanded] = useState(true);
  const rootActors = actorIds.map((id) => actors[id]).filter((actor): actor is ActorNode => Boolean(actor));
  const sceneSelected = selection.length === 0;

  const onDropRoot = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
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
      <div className="scene-tree-item" onDrop={onDropRoot} onDragOver={(event) => event.preventDefault()}>
        <div className="scene-tree-item-row" style={{ paddingLeft: "8px" }}>
          <button
            className={`scene-tree-expand${rootActors.length === 0 ? " placeholder" : ""}`}
            type="button"
            disabled={rootActors.length === 0}
            title={rootActors.length > 0 ? (sceneExpanded ? "Collapse" : "Expand") : "No actors"}
            onClick={() => setSceneExpanded((value) => !value)}
          >
            <FontAwesomeIcon icon={sceneExpanded ? faChevronDown : faChevronRight} />
          </button>
          <button
            className={`scene-tree-label ${sceneSelected ? "selected" : ""}`}
            type="button"
            onClick={() => kernel.store.getState().actions.clearSelection()}
          >
            {scene.name}
          </button>
        </div>
        {sceneExpanded
          ? rootActors.map((actor) => <ActorItem key={actor.id} actor={actor} depth={1} />)
          : null}
      </div>
    </div>
  );
}
