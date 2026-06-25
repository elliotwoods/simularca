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

type PreviewEdge = "top" | "bottom";

interface RowTargetContext {
  actor: ActorNode;
  depth: number;
  parentId: string | null;
  siblingIndex: number;
  expanded: boolean;
  hasVisibleChildren: boolean;
}

interface ResolvedRowTarget {
  target: DragDropTarget;
  edge: PreviewEdge;
}

interface ActorItemProps {
  actor: ActorNode;
  depth: number;
  beginDragging: (actorId: string) => void;
  previewTarget: (event: React.DragEvent<HTMLElement>, target: DragDropTarget, edge: PreviewEdge) => void;
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

// Each row is split into three vertical drop zones: the top band inserts BEFORE the row,
// the bottom band inserts AFTER it (both at the row's own depth), and the middle band drops
// INTO it as a child. Comparing the pointer against the band edges (rather than computing a
// 0..1 ratio) means a zero-height row — as in jsdom tests, where getBoundingClientRect is all
// zeros — classifies purely by the sign of (clientY - rowTop): below -> after, above ->
// before, exactly on it -> into.
const ZONE_BEFORE_MAX = 0.3;
const ZONE_AFTER_MIN = 0.7;

function resolveRowTarget(rowEl: HTMLElement, clientY: number, ctx: RowTargetContext): ResolvedRowTarget {
  const rect = rowEl.getBoundingClientRect();
  const beforeEdge = rect.top + rect.height * ZONE_BEFORE_MAX;
  const afterEdge = rect.top + rect.height * ZONE_AFTER_MIN;
  const safeSiblingIndex = Math.max(ctx.siblingIndex, 0);
  if (clientY < beforeEdge) {
    return {
      edge: "top",
      target: {
        kind: "before-row",
        actorId: ctx.actor.id,
        newParentId: ctx.parentId,
        index: safeSiblingIndex,
        indicatorDepth: ctx.depth
      }
    };
  }
  if (clientY > afterEdge) {
    return {
      edge: "bottom",
      target: {
        kind: "after-subtree",
        actorId: ctx.actor.id,
        newParentId: ctx.parentId,
        index: safeSiblingIndex + 1,
        indicatorDepth: ctx.depth
      }
    };
  }
  return {
    edge: "bottom",
    target: {
      kind: "into-row",
      actorId: ctx.actor.id,
      newParentId: ctx.actor.id,
      // The into-line is drawn at the row's bottom edge indented to depth+1. On an expanded
      // group that visually reads as "before the first child", so insert at 0 to match what
      // the line shows; appending stays reachable via the last child's after-band. Collapsed
      // or leaf rows hide their children, so append at the end (matching the old intoTarget).
      index: ctx.expanded && ctx.hasVisibleChildren ? 0 : ctx.actor.childActorIds.length,
      indicatorDepth: ctx.depth + 1
    }
  };
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

function ActorItem(props: ActorItemProps) {
  const kernel = useKernel();
  const selection = useAppStore((store) => store.state.selection);
  const actors = useAppStore((store) => store.state.actors);
  const rootActorIds = useAppStore((store) => store.state.scene.actorIds);
  const actorStatusByActorId = useAppStore((store) => store.state.actorStatusByActorId);
  const actorFrameTimingsMs = useAppStore((store) => store.state.actorFrameTimingsMs);
  const statsFrameMs = useAppStore((store) => store.state.stats.frameMs);
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
  // Visibility is the one mutation the publisher can selectively unlock for
  // viewers (`permissions.canToggleVisibility`). The eye button is enabled
  // either in the editor or when that flag is on; the store-level
  // `mutationAllowed` gate still backstops if the permission isn't set.
  const viewerPermissions = useAppStore((store) => store.state.viewerPermissions);
  const visibilityLocked = readOnly && !viewerPermissions?.canToggleVisibility;
  const frameTimingMs = actorFrameTimingsMs[props.actor.id];
  const frameMs = statsFrameMs > 0 ? statsFrameMs : 1000 / 60;
  const timingWarning = frameTimingMs != null && frameTimingMs > frameMs ? frameTimingMs : null;
  const visibilityMode = props.actor.visibilityMode ?? "visible";
  const siblingIds = props.actor.parentActorId ? (actors[props.actor.parentActorId]?.childActorIds ?? []) : rootActorIds;
  const siblingIndex = siblingIds.indexOf(props.actor.id);
  const childActors = props.actor.childActorIds
    .map((childId) => actors[childId])
    .filter((actor): actor is ActorNode => Boolean(actor));
  // Generated Array-instance actors are shown read-only in a collapsed group, not
  // as individually editable rows.
  const visibleChildren = childActors.filter((actor) => !actor.generatedByActorId);
  const generatedChildren = childActors.filter((actor) => actor.generatedByActorId);
  const rowIndent = indentPx(props.depth);
  const rowTargetCtx: RowTargetContext = {
    actor: props.actor,
    depth: props.depth,
    parentId: props.actor.parentActorId ?? null,
    siblingIndex,
    expanded,
    hasVisibleChildren: visibleChildren.length > 0
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
    const { target, edge } = resolveRowTarget(event.currentTarget, event.clientY, rowTargetCtx);
    props.previewTarget(event, target, edge);
  };

  const onDropRow = (event: React.DragEvent<HTMLDivElement>) => {
    const { target } = resolveRowTarget(event.currentTarget, event.clientY, rowTargetCtx);
    props.commitDropTarget(event, target);
  };

  return (
    <div className="scene-tree-item">
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
          disabled={visibilityLocked}
          title={visibilityTitle(visibilityMode, isActive)}
          onClick={(event) => {
            event.stopPropagation();
            if (visibilityLocked) {
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
        {timingWarning != null ? (
          <span
            className="scene-tree-timing-warning"
            title={`CPU time: ${timingWarning.toFixed(1)}ms — frame budget: ${frameMs.toFixed(1)}ms`}
          >
            {timingWarning.toFixed(1)}ms
          </span>
        ) : null}
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
      {expanded && generatedChildren.length > 0 ? (
        <GeneratedInstancesGroup
          ownerActorId={props.actor.id}
          instances={generatedChildren}
          depth={props.depth + 1}
        />
      ) : null}
    </div>
  );
}

function GeneratedInstancesGroup(props: { ownerActorId: string; instances: ActorNode[]; depth: number }) {
  const kernel = useKernel();
  const [open, setOpen] = useState(false);
  const selectOwner = () => {
    kernel.store.getState().actions.select([{ kind: "actor", id: props.ownerActorId }]);
  };
  return (
    <div className="scene-tree-item scene-tree-generated">
      <div
        className="scene-tree-item-row scene-tree-generated-group"
        style={{ paddingLeft: `${indentPx(props.depth)}px`, opacity: 0.6 }}
      >
        <button
          className="scene-tree-expand"
          type="button"
          title={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((value) => !value)}
        >
          <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} />
        </button>
        <button
          className="scene-tree-label"
          type="button"
          title="Generated array instances (read-only)"
          onClick={selectOwner}
        >
          {props.instances.length} instance{props.instances.length === 1 ? "" : "s"}
        </button>
      </div>
      {open
        ? props.instances.map((instance) => (
            <div
              key={instance.id}
              className="scene-tree-item-row scene-tree-generated-instance"
              style={{ paddingLeft: `${indentPx(props.depth + 1)}px`, opacity: 0.5 }}
            >
              <span className="scene-tree-expand placeholder" />
              <button
                className="scene-tree-label"
                type="button"
                title="Generated instance (read-only)"
                onClick={selectOwner}
              >
                {instance.name}
              </button>
            </div>
          ))
        : null}
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
  const lastTargetKeyRef = useRef<string | null>(null);
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
    lastTargetKeyRef.current = null;
  };

  const ensureDragSession = (event: React.DragEvent<HTMLElement>): string | null => {
    const nextDraggedActorId = draggedActorIdRef.current || event.dataTransfer.getData("text/plain");
    if (!nextDraggedActorId) {
      return null;
    }
    draggedActorIdRef.current = nextDraggedActorId;
    return nextDraggedActorId;
  };

  const targetKey = (target: DragDropTarget): string =>
    `${target.kind}|${target.actorId ?? ""}|${target.newParentId ?? ""}|${target.index}|${target.indicatorDepth}`;

  const setPreviewFromTarget = (anchorEl: HTMLElement, edge: PreviewEdge, target: DragDropTarget) => {
    if (!rootRef.current) {
      setActivePreview(null);
      return;
    }
    const rootRect = rootRef.current.getBoundingClientRect();
    const rect = anchorEl.getBoundingClientRect();
    const anchorY = edge === "top" ? rect.top : rect.bottom;
    // `.scene-tree-drop-preview` is absolutely positioned inside `.scene-tree-root` — its
    // positioned offset parent, whose content scrolls. Convert the viewport anchor into the
    // container's content coordinates by adding scrollTop; without this the line drifts
    // upward by the scroll amount when the tree is scrolled.
    const top = anchorY - rootRect.top + rootRef.current.scrollTop;
    setActivePreview({ indicatorDepth: target.indicatorDepth, top });
  };

  const previewTarget = (event: React.DragEvent<HTMLElement>, target: DragDropTarget, edge: PreviewEdge) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedActorId = ensureDragSession(event);
    if (!draggedActorId || !canDropAtTarget(draggedActorId, target, actors, actorIds)) {
      setActivePreview(null);
      lastTargetKeyRef.current = null;
      return;
    }
    // Skip the re-render when the resolved zone hasn't changed — dragover fires ~60Hz but the
    // insertion line only moves when the target zone does.
    const key = targetKey(target);
    if (key === lastTargetKeyRef.current) {
      return;
    }
    lastTargetKeyRef.current = key;
    setPreviewFromTarget(event.currentTarget, edge, target);
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

  // Dragging over the empty area below the tree (or an empty scene) drops at the end of the
  // root list. Rows handle their own dragover and stopPropagation, so this only fires when the
  // pointer is over the container itself or a non-draggable child (e.g. the scene header).
  const onRootContainerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget) {
      if (lastTargetKeyRef.current !== null) {
        setActivePreview(null);
        lastTargetKeyRef.current = null;
      }
      return;
    }
    const draggedActorId = ensureDragSession(event);
    if (!draggedActorId || !canDropAtTarget(draggedActorId, rootEndTarget, actors, actorIds)) {
      setActivePreview(null);
      lastTargetKeyRef.current = null;
      return;
    }
    const key = targetKey(rootEndTarget);
    if (key === lastTargetKeyRef.current) {
      return;
    }
    lastTargetKeyRef.current = key;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>("[data-actor-row-id]");
    const lastRow = rows && rows.length > 0 ? rows[rows.length - 1] : null;
    if (lastRow) {
      setPreviewFromTarget(lastRow, "bottom", rootEndTarget);
    } else {
      setActivePreview({ indicatorDepth: rootEndTarget.indicatorDepth, top: 0 });
    }
  };

  const onRootContainerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      commitDropTarget(event, rootEndTarget);
      return;
    }
    event.preventDefault();
    endDragging();
  };

  return (
    <div
      className="scene-tree-root"
      ref={rootRef}
      onDrop={onRootContainerDrop}
      onDragOver={onRootContainerDragOver}
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
      </div>
    </div>
  );
}
