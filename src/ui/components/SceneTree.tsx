import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBullseye,
  faChevronDown,
  faChevronRight,
  faEye,
  faEyeSlash,
  faTriangleExclamation
} from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { ActorNode, ActorVisibilityMode } from "@/core/types";

type SelectionEntry = { kind: string; id: string };
type DropTargetKind = "before-row" | "into-row" | "child-append" | "after-subtree" | "root-end";

interface DragDropTarget {
  kind: DropTargetKind;
  actorId: string | null;
  newParentId: string | null;
  index: number;
  indicatorDepth: number;
}

interface SceneTreeDropGapProps {
  target: DragDropTarget;
  previewTarget: (event: React.DragEvent<HTMLElement>, target: DragDropTarget) => void;
  commitDropTarget: (event: React.DragEvent<HTMLElement>, target: DragDropTarget) => void;
}

interface ActorItemProps {
  actor: ActorNode;
  depth: number;
  beginDragging: (actorId: string) => void;
  previewTarget: (event: React.DragEvent<HTMLElement>, target: DragDropTarget) => void;
  commitDropTarget: (event: React.DragEvent<HTMLElement>, target: DragDropTarget) => void;
  endDragging: () => void;
}

interface DropPreviewState {
  indicatorDepth: number;
  top: number;
}

function isSelected(selection: SelectionEntry[], actorId: string): boolean {
  return selection.some((entry) => entry.kind === "actor" && entry.id === actorId);
}

function visibilityTitle(mode: ActorVisibilityMode, isSelectedNow: boolean): string {
  if (mode === "hidden") {
    return "Hidden (click to set visible when selected)";
  }
  if (mode === "selected") {
    return isSelectedNow
      ? "Visible when selected (click to set hidden)"
      : "Visible when selected (click to set always visible)";
  }
  return "Visible (click to hide)";
}

function nextVisibilityMode(mode: ActorVisibilityMode, isSelectedNow: boolean): ActorVisibilityMode {
  if (mode === "selected") {
    return isSelectedNow ? "hidden" : "visible";
  }
  if (mode === "visible") {
    return "hidden";
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

function indentPx(depth: number): number {
  return 8 + depth * 12;
}

function resolveCommittedIndex(
  draggedActorId: string,
  target: DragDropTarget,
  actors: Record<string, ActorNode>,
  rootActorIds: string[]
): number | null {
  const draggedActor = actors[draggedActorId];
  if (!draggedActor) {
    return null;
  }
  const draggedSiblingIds = draggedActor.parentActorId ? (actors[draggedActor.parentActorId]?.childActorIds ?? []) : rootActorIds;
  const draggedSiblingIndex = draggedSiblingIds.indexOf(draggedActorId);
  let nextIndex = target.index;
  if ((draggedActor.parentActorId ?? null) === target.newParentId && draggedSiblingIndex !== -1 && draggedSiblingIndex < nextIndex) {
    nextIndex -= 1;
  }
  return nextIndex;
}

function canDropAtTarget(
  draggedActorId: string,
  target: DragDropTarget,
  actors: Record<string, ActorNode>,
  rootActorIds: string[]
): boolean {
  const draggedActor = actors[draggedActorId];
  if (!draggedActor) {
    return false;
  }
  if (target.kind === "into-row" && target.actorId === draggedActorId) {
    return false;
  }
  let cursor = target.newParentId;
  while (cursor) {
    if (cursor === draggedActorId) {
      return false;
    }
    cursor = actors[cursor]?.parentActorId ?? null;
  }
  const nextIndex = resolveCommittedIndex(draggedActorId, target, actors, rootActorIds);
  if (nextIndex === null) {
    return false;
  }
  const currentParentId = draggedActor.parentActorId ?? null;
  const currentSiblingIds = currentParentId ? (actors[currentParentId]?.childActorIds ?? []) : rootActorIds;
  const currentIndex = currentSiblingIds.indexOf(draggedActorId);
  return !(currentParentId === target.newParentId && currentIndex === nextIndex);
}

function SceneTreeDropGap(props: SceneTreeDropGapProps) {
  return (
    <div
      className="scene-tree-drop-gap"
      data-drop-kind={props.target.kind}
      data-drop-target-id={props.target.actorId ?? "root"}
      onDragOver={(event) => props.previewTarget(event, props.target)}
      onDrop={(event) => props.commitDropTarget(event, props.target)}
    />
  );
}

function ActorItem(props: ActorItemProps) {
  const kernel = useKernel();
  const selection = useAppStore((store) => store.state.selection);
  const actors = useAppStore((store) => store.state.actors);
  const rootActorIds = useAppStore((store) => store.state.scene.actorIds);
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
  const hasConflict = runtimeStatus?.values?.renderIncompatible === true;
  const hasPluginWarning = runtimeStatus?.values?.pluginMissing === true;
  const incompatibilityReason =
    typeof runtimeStatus?.values?.renderIncompatibleReason === "string"
      ? runtimeStatus.values.renderIncompatibleReason
      : "Incompatible with current render engine.";
  const pluginWarningReason =
    typeof runtimeStatus?.values?.pluginMissingReason === "string"
      ? runtimeStatus.values.pluginMissingReason
      : "Plugin actor type is unavailable.";
  const readOnly = mode === "web-ro";
  const visibilityMode = props.actor.visibilityMode ?? "visible";
  const siblingIds = props.actor.parentActorId ? (actors[props.actor.parentActorId]?.childActorIds ?? []) : rootActorIds;
  const siblingIndex = siblingIds.indexOf(props.actor.id);
  const visibleChildren = props.actor.childActorIds.map((childId) => actors[childId]).filter((actor): actor is ActorNode => Boolean(actor));
  const hasExpandedChildren = expanded && visibleChildren.length > 0;
  const rowIndent = indentPx(props.depth);
  const beforeTarget: DragDropTarget = {
    kind: "before-row",
    actorId: props.actor.id,
    newParentId: props.actor.parentActorId ?? null,
    index: Math.max(siblingIndex, 0),
    indicatorDepth: props.depth
  };
  const intoTarget: DragDropTarget = {
    kind: "into-row",
    actorId: props.actor.id,
    newParentId: props.actor.id,
    index: props.actor.childActorIds.length,
    indicatorDepth: props.depth + 1
  };
  const childAppendTarget: DragDropTarget = {
    kind: "child-append",
    actorId: props.actor.id,
    newParentId: props.actor.id,
    index: props.actor.childActorIds.length,
    indicatorDepth: props.depth + 1
  };
  const afterTarget: DragDropTarget = {
    kind: "after-subtree",
    actorId: props.actor.id,
    newParentId: props.actor.parentActorId ?? null,
    index: Math.max(siblingIndex + 1, 0),
    indicatorDepth: props.depth
  };

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
    props.beginDragging(props.actor.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", props.actor.id);
  };

  const onDragOverRow = (event: React.DragEvent<HTMLDivElement>) => {
    props.previewTarget(event, hasExpandedChildren ? childAppendTarget : intoTarget);
  };

  const onDropRow = (event: React.DragEvent<HTMLDivElement>) => {
    props.commitDropTarget(event, intoTarget);
  };

  return (
    <div className="scene-tree-item">
      <SceneTreeDropGap
        target={beforeTarget}
        previewTarget={props.previewTarget}
        commitDropTarget={props.commitDropTarget}
      />
      <div
        className="scene-tree-item-row"
        data-actor-row-id={props.actor.id}
        draggable={!isRenaming}
        onDragStart={onDragStart}
        onDragEnd={props.endDragging}
        onDragOver={onDragOverRow}
        onDrop={onDropRow}
        style={{ paddingLeft: `${rowIndent}px` }}
      >
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
          title={visibilityTitle(visibilityMode, isActive)}
          onClick={(event) => {
            event.stopPropagation();
            if (readOnly) {
              return;
            }
            kernel.store
              .getState()
              .actions.setActorVisibilityMode(props.actor.id, nextVisibilityMode(visibilityMode, isActive));
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
        {hasConflict ? (
          <span className="scene-tree-load-state conflict" title={incompatibilityReason}>
            <FontAwesomeIcon icon={faTriangleExclamation} />
          </span>
        ) : null}
        {!hasConflict && hasPluginWarning ? (
          <span className="scene-tree-load-state conflict" title={pluginWarningReason}>
            <FontAwesomeIcon icon={faTriangleExclamation} />
          </span>
        ) : null}
        {hasError ? <span className="scene-tree-load-state error" title={runtimeStatus?.error ?? "Load failed"} /> : null}
      </div>
      {expanded
        ? visibleChildren.map((child) => (
            <ActorItem
              key={child.id}
              actor={child}
              depth={props.depth + 1}
              beginDragging={props.beginDragging}
              previewTarget={props.previewTarget}
              commitDropTarget={props.commitDropTarget}
              endDragging={props.endDragging}
            />
          ))
        : null}
      {hasExpandedChildren ? (
        <>
          <SceneTreeDropGap
            target={childAppendTarget}
            previewTarget={props.previewTarget}
            commitDropTarget={props.commitDropTarget}
          />
          <SceneTreeDropGap
            target={afterTarget}
            previewTarget={props.previewTarget}
            commitDropTarget={props.commitDropTarget}
          />
        </>
      ) : null}
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
  const [activePreview, setActivePreview] = useState<DropPreviewState | null>(null);
  const draggedActorIdRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rootActors = actorIds.map((id) => actors[id]).filter((actor): actor is ActorNode => Boolean(actor));
  const sceneSelected = selection.length === 0;
  const rootEndTarget: DragDropTarget = {
    kind: "root-end",
    actorId: null,
    newParentId: null,
    index: rootActors.length,
    indicatorDepth: 1
  };

  const beginDragging = (actorId: string) => {
    draggedActorIdRef.current = actorId;
  };

  const endDragging = () => {
    setActivePreview(null);
    draggedActorIdRef.current = null;
  };

  const ensureDragSession = (event: React.DragEvent<HTMLElement>): string | null => {
    const nextDraggedActorId = draggedActorIdRef.current || event.dataTransfer.getData("text/plain");
    if (!nextDraggedActorId) {
      return null;
    }
    draggedActorIdRef.current = nextDraggedActorId;
    return nextDraggedActorId;
  };

  const getPreviewAnchor = (target: DragDropTarget, currentTarget: EventTarget | null): HTMLElement | null => {
    if (target.kind === "into-row") {
      return currentTarget instanceof HTMLElement ? currentTarget : null;
    }
    if (!rootRef.current) {
      return null;
    }
    return rootRef.current.querySelector(`[data-drop-kind="${target.kind}"][data-drop-target-id="${target.actorId ?? "root"}"]`);
  };

  const setPreviewFromTarget = (target: DragDropTarget, currentTarget: EventTarget | null) => {
    if (!rootRef.current) {
      setActivePreview(null);
      return;
    }
    const anchor = getPreviewAnchor(target, currentTarget);
    if (!(anchor instanceof HTMLElement)) {
      setActivePreview(null);
      return;
    }
    const rootRect = rootRef.current.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const top = target.kind === "into-row" ? anchorRect.bottom - rootRect.top : anchorRect.top + anchorRect.height / 2 - rootRect.top;
    setActivePreview({
      indicatorDepth: target.indicatorDepth,
      top
    });
  };

  const previewTarget = (event: React.DragEvent<HTMLElement>, target: DragDropTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedActorId = ensureDragSession(event);
    if (!draggedActorId || !canDropAtTarget(draggedActorId, target, actors, actorIds)) {
      setActivePreview(null);
      return;
    }
    setPreviewFromTarget(target, event.currentTarget);
  };

  const commitDropTarget = (event: React.DragEvent<HTMLElement>, target: DragDropTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const actorId = event.dataTransfer.getData("text/plain") || draggedActorIdRef.current;
    endDragging();
    if (!actorId || !canDropAtTarget(actorId, target, actors, actorIds)) {
      return;
    }
    const nextIndex = resolveCommittedIndex(actorId, target, actors, actorIds);
    if (nextIndex === null) {
      return;
    }
    kernel.store.getState().actions.reorderActor(actorId, target.newParentId, nextIndex);
  };

  return (
    <div
      className="scene-tree-root"
      ref={rootRef}
      onDrop={(event) => {
        event.preventDefault();
        endDragging();
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragEnd={endDragging}
    >
      {activePreview ? (
        <div
          className="scene-tree-drop-preview"
          data-scene-tree-drop-preview="true"
          style={{
            top: `${activePreview.top}px`,
            left: `${indentPx(activePreview.indicatorDepth)}px`
          }}
        />
      ) : null}
      {props.pendingDropFileName ? (
        <div className="scene-tree-import-placeholder" title="A file is currently being dragged for import.">
          <span className="scene-tree-import-dot">+</span>
          <span className="scene-tree-import-text">Pending Import: {props.pendingDropFileName}</span>
        </div>
      ) : null}
      <div className="scene-tree-item">
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
          ? rootActors.map((actor) => (
              <ActorItem
                key={actor.id}
                actor={actor}
                depth={1}
                beginDragging={beginDragging}
                previewTarget={previewTarget}
                commitDropTarget={commitDropTarget}
                endDragging={endDragging}
              />
            ))
          : null}
        {sceneExpanded ? (
          <SceneTreeDropGap
            target={rootEndTarget}
            previewTarget={previewTarget}
            commitDropTarget={commitDropTarget}
          />
        ) : null}
      </div>
    </div>
  );
}
