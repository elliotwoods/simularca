import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode, AppState, DimensionAxis, DimensionSnapHover, DimensionSnapSettings, Landmark } from "@/core/types";
import {
  formatDistanceMeters,
  readLandmark,
  resolveDimensionUnits
} from "@/features/dimensions/model";
import {
  axisIndexOf,
  axisUnit,
  closestPointsBetweenSegments,
  computeDimensionWorldGeometry,
  resolveLandmarkLine as resolveLandmarkLineWorld,
  resolveLandmarkWorld as resolveLandmarkWorldShared,
  resolveMeasureEndpoints as resolveMeasureEndpointsShared
} from "@/features/dimensions/geometry";
import { computeActorObjectVisibility, type SceneController } from "@/render/sceneController";

const OVERLAY_RENDER_ORDER = 999;
const LABEL_RENDER_ORDER = 1000;
const SNAP_PIXEL_THRESHOLD = 18;
const HANDLE_PIXEL_THRESHOLD = 12;
const STATUS_THROTTLE_FRAMES = 15;
// Snap-point dot overlay: bound the candidate pool and how many dots show.
const SNAP_DOT_DISPLAY = 100; // dots shown (the N nearest the cursor)
const SNAP_DOT_POOL_CAP = 4000; // total candidate vertices considered
const SNAP_DOT_PER_ACTOR_CAP = 1000; // per-actor sampled vertices
const SNAP_DOT_REBUILD_FRAMES = 12; // pool rebuild throttle

interface DimensionVisual {
  root: THREE.Group;
  lines: THREE.Line[];
  label: THREE.Sprite;
  labelCanvas: HTMLCanvasElement;
  labelTexture: THREE.CanvasTexture;
  signature: string;
  labelAspect: number;
}

interface SnapResult {
  world: THREE.Vector3;
  landmark: Landmark;
  description: { actorName: string; pointName: string };
}

/**
 * A pre-resolved snap candidate from the landmark pool. `world` is the position
 * sampled at the last pool rebuild (used for screen-space proximity); `landmark`
 * carries provenance so the placed point live-follows its actor.
 */
/** Snap category, gated by the matching `dimensionSnap` toggle. */
type SnapCategory = "vertex" | "endpoint" | "midpoint" | "center";

interface SnapCandidate {
  world: THREE.Vector3;
  landmark: Landmark;
  /** Which snap toggle gates this candidate. */
  category: SnapCategory;
  /** Readout label for this candidate (defaults to "Landmark" for generic vertices). */
  name?: string;
}

/** A world-space DXF line segment, used for on-line and intersection snapping. */
interface EdgeCandidate {
  a: THREE.Vector3;
  b: THREE.Vector3;
  actorId: string;
}

interface DimensionGeometry {
  A: THREE.Vector3;
  B: THREE.Vector3;
  axis: DimensionAxis;
  m1: THREE.Vector3;
  m2: THREE.Vector3;
  distance: number;
  labelPos: THREE.Vector3;
  lineDir: THREE.Vector3;
}

function lineMaterial(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false
  });
}

function makeLine(color: number): THREE.Line {
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lineMaterial(color));
  line.frustumCulled = false;
  line.renderOrder = OVERLAY_RENDER_ORDER;
  return line;
}

function setLinePoints(line: THREE.Line, a: THREE.Vector3, b: THREE.Vector3): void {
  const positions = (line.geometry.getAttribute("position") as THREE.BufferAttribute | undefined);
  if (positions && positions.count >= 2) {
    positions.setXYZ(0, a.x, a.y, a.z);
    positions.setXYZ(1, b.x, b.y, b.z);
    positions.needsUpdate = true;
  } else {
    line.geometry.setFromPoints([a.clone(), b.clone()]);
  }
}

function hexToCss(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Black or white, whichever reads more clearly on the given fill colour. Used to
 * keep the value legible against the selection-highlight rectangle (which is the
 * user-chosen line colour, so it can be any brightness). Uses a perceptual
 * luminance on the sRGB components and a threshold biased towards dark text.
 */
function contrastingTextColor(cssHex: string): string {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(cssHex.trim());
  if (!match) {
    return "#ffffff";
  }
  const hex = match[1]!.length === 3 ? match[1]!.replace(/(.)/g, "$1$1") : match[1]!;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 0.55 ? "#000000" : "#ffffff";
}

/** True only if `node` and every ancestor up to and including `root` are visible. */
function isVisibleInSubtree(node: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = node;
  while (current) {
    if (!current.visible) {
      return false;
    }
    if (current === root) {
      break;
    }
    current = current.parent;
  }
  return true;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 2D distance from point (px,py) to the segment a→b (all in screen pixels). */
function segmentPointDistancePx(a: { x: number; y: number }, b: { x: number; y: number }, px: number, py: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) {
    return Math.hypot(px - a.x, py - a.y);
  }
  const t = clamp01(((px - a.x) * dx + (py - a.y) * dy) / lenSq);
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export class DimensionOverlayController {
  private readonly overlayRoot = new THREE.Group();
  private readonly placementGroup = new THREE.Group();
  private readonly hoverMarker: THREE.Mesh;
  private readonly hoverLine: THREE.Line;
  private readonly startMarker: THREE.Mesh;
  private readonly rubberLine: THREE.Line;
  private readonly previewLines: THREE.Line[];
  private readonly offsetHandle: THREE.Mesh;
  private readonly snapDots: THREE.Points;
  private snapDotPool: SnapCandidate[] = [];
  private edgePool: EdgeCandidate[] = [];
  private snapPoolSignature = "";
  private lastPointerPx: { x: number; y: number } | null = null;
  private shiftHeld = false;
  private axisOverride: DimensionAxis | null = null;
  private readonly visuals = new Map<string, DimensionVisual>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private currentCamera: any;
  private pendingStart: { landmark: Landmark; world: THREE.Vector3 } | null = null;
  private pendingEnd: { landmark: Landmark; world: THREE.Vector3; axis: DimensionAxis } | null = null;
  private placementOffset: { dir: THREE.Vector3; magnitude: number } | null = null;
  private draggingOffset: { actorId: string; A: THREE.Vector3; B: THREE.Vector3; axis: DimensionAxis } | null = null;
  // True when a single dimension is selected and its label rectangle acts as the
  // (invisible) offset-drag target; gates pointer handling without rendering a box.
  private offsetHandleActive = false;
  private hoverSnap: SnapResult | null = null;
  private lastHoverLabel: string | null = null;
  private frameCounter = 0;
  private readonly lastStatusDistance = new Map<string, number>();

  public constructor(
    private readonly kernel: AppKernel,
    private readonly sceneController: SceneController,
    private readonly orbitControls: OrbitControls,
    private readonly domElement: HTMLElement,
    initialCamera: any
  ) {
    this.currentCamera = initialCamera;
    this.overlayRoot.name = "dimension-overlay";
    this.overlayRoot.renderOrder = OVERLAY_RENDER_ORDER;
    this.placementGroup.name = "dimension-placement";
    this.placementGroup.visible = false;

    const markerGeometry = new THREE.SphereGeometry(0.5, 16, 12);
    this.hoverMarker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0x55ffcc, depthTest: false, depthWrite: false }));
    this.hoverMarker.renderOrder = LABEL_RENDER_ORDER;
    // Highlight for a hovered line landmark (the whole DXF segment).
    this.hoverLine = makeLine(0x55ffcc);
    this.hoverLine.visible = false;
    this.startMarker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false, depthWrite: false }));
    this.startMarker.renderOrder = LABEL_RENDER_ORDER;
    this.startMarker.visible = false;
    this.rubberLine = makeLine(0xffcc33);
    this.previewLines = [makeLine(0xffcc33), makeLine(0xffcc33), makeLine(0xffcc33)];
    for (const line of this.previewLines) {
      line.visible = false;
      this.placementGroup.add(line);
    }
    this.placementGroup.add(this.hoverMarker, this.hoverLine, this.startMarker, this.rubberLine);
    this.overlayRoot.add(this.placementGroup);

    // The offset drag handle lives outside placementGroup so it can show in
    // select mode (placementGroup is only visible while a tool is armed).
    this.offsetHandle = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 })
    );
    this.offsetHandle.renderOrder = LABEL_RENDER_ORDER;
    this.offsetHandle.visible = false;
    this.overlayRoot.add(this.offsetHandle);

    // Snap-point dot cloud: shows the nearest candidate landmark vertices.
    const dotGeometry = new THREE.BufferGeometry();
    dotGeometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(SNAP_DOT_DISPLAY * 3), 3));
    dotGeometry.setDrawRange(0, 0);
    this.snapDots = new THREE.Points(
      dotGeometry,
      new THREE.PointsMaterial({
        color: 0x55ffcc,
        size: 6,
        sizeAttenuation: false,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.9
      })
    );
    this.snapDots.frustumCulled = false;
    this.snapDots.renderOrder = LABEL_RENDER_ORDER;
    this.snapDots.visible = false;
    this.overlayRoot.add(this.snapDots);

    this.sceneController.scene.add(this.overlayRoot);

    this.domElement.addEventListener("pointerdown", this.onPointerDown, true);
    this.domElement.addEventListener("pointermove", this.onPointerMove, true);
    this.domElement.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
  }

  public dispose(): void {
    this.domElement.removeEventListener("pointerdown", this.onPointerDown, true);
    this.domElement.removeEventListener("pointermove", this.onPointerMove, true);
    this.domElement.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    for (const visual of this.visuals.values()) {
      this.disposeVisual(visual);
    }
    this.visuals.clear();
    this.hoverMarker.geometry.dispose();
    (this.hoverMarker.material as THREE.Material).dispose();
    this.hoverLine.geometry.dispose();
    (this.hoverLine.material as THREE.Material).dispose();
    (this.startMarker.material as THREE.Material).dispose();
    this.rubberLine.geometry.dispose();
    (this.rubberLine.material as THREE.Material).dispose();
    for (const line of this.previewLines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.offsetHandle.geometry.dispose();
    (this.offsetHandle.material as THREE.Material).dispose();
    this.snapDots.geometry.dispose();
    (this.snapDots.material as THREE.Material).dispose();
    this.overlayRoot.parent?.remove(this.overlayRoot);
    this.domElement.style.cursor = "";
  }

  public setCamera(camera: any): void {
    this.currentCamera = camera;
  }

  /**
   * Pointer-time picking/projection must use up-to-date camera matrices. Our
   * frame `update()` runs before the renderer refreshes world matrices (same
   * caveat documented in SceneGridController), and pointer events can fire after
   * camera moves, so refresh here before raycast/project to keep the snap cursor
   * exactly under the pointer.
   */
  private ensureCameraMatrices(): void {
    if (!this.currentCamera) {
      return;
    }
    this.currentCamera.updateMatrixWorld(true);
    if (typeof this.currentCamera.updateProjectionMatrix === "function") {
      this.currentCamera.updateProjectionMatrix();
    }
  }

  private get tool(): string {
    return this.kernel.store.getState().state.interactionTool;
  }

  public willHandlePointerDown(event: PointerEvent): boolean {
    if (event.button !== 0) {
      return false;
    }
    if (this.tool !== "select") {
      return true;
    }
    // In select mode we only claim the pointer when starting an offset-handle drag.
    return this.offsetHandleActive && this.pickHandle(event) !== null;
  }

  public update(): void {
    const visible = this.sceneController.getDebugHelpersVisible();
    this.overlayRoot.visible = visible;
    const placementActive = this.tool !== "select";
    this.placementGroup.visible = visible && placementActive;
    if (!visible) {
      this.offsetHandleActive = false;
      return;
    }
    this.frameCounter += 1;

    const state = this.kernel.store.getState().state;
    const selectedIds = new Set(state.selection.filter((entry) => entry.kind === "actor").map((entry) => entry.id));
    const liveIds = new Set<string>();

    for (const actor of Object.values(state.actors)) {
      if (actor.actorType !== "dimension" && actor.actorType !== "annotation") {
        continue;
      }
      liveIds.add(actor.id);
      const isSelected = selectedIds.has(actor.id);
      const shouldShow = computeActorObjectVisibility(actor, isSelected, visible);
      const visual = this.ensureVisual(actor);
      visual.root.visible = shouldShow;
      if (!shouldShow) {
        continue;
      }
      if (actor.actorType === "dimension") {
        this.updateDimensionVisual(actor, visual, isSelected);
      } else {
        this.updateAnnotationVisual(actor, visual);
      }
    }

    for (const [actorId, visual] of [...this.visuals.entries()]) {
      if (!liveIds.has(actorId)) {
        this.disposeVisual(visual);
        this.visuals.delete(actorId);
        this.lastStatusDistance.delete(actorId);
      }
    }

    this.updateOffsetHandle(state, selectedIds, placementActive);

    const snap = state.dimensionSnap;
    const anyLandmarkSnap = snap.vertex || snap.endpoint || snap.midpoint || snap.center;
    // The candidate pool now drives snapping (not just the dots), so build it
    // whenever a tool is armed and any landmark category is enabled.
    if (placementActive && anyLandmarkSnap) {
      this.maybeRebuildSnapPool(state, selectedIds);
    } else {
      this.snapDotPool = [];
      this.edgePool = [];
      this.snapPoolSignature = "";
    }
    // Hide the snap-point preview once both endpoints are placed: during the offset
    // step the cursor only sets the perpendicular offset, so the dots are noise.
    const showDots = placementActive && snap.showSnapPoints && anyLandmarkSnap && !this.pendingEnd;
    this.snapDots.visible = showDots;
    if (showDots) {
      this.updateSnapDots();
    } else {
      this.snapDots.geometry.setDrawRange(0, 0);
    }

    if (placementActive) {
      this.updatePlacementPreview();
    }
  }

  // ----- Snap-point dot overlay ----------------------------------------------

  private maybeRebuildSnapPool(state: AppState, selectedIds: Set<string>): void {
    const visibleActors = Object.values(state.actors).filter(
      (actor) =>
        actor.actorType !== "dimension" &&
        actor.actorType !== "annotation" &&
        computeActorObjectVisibility(actor, selectedIds.has(actor.id), true) &&
        (this.resolveActorObject(actor.id)?.visible ?? false)
    );
    const signature = visibleActors.map((actor) => actor.id).join(",");
    // Rebuild on actor-set change, or periodically so dots track moving actors.
    if (signature === this.snapPoolSignature && this.frameCounter % SNAP_DOT_REBUILD_FRAMES !== 0) {
      return;
    }
    this.snapPoolSignature = signature;
    this.rebuildSnapPool(visibleActors.map((actor) => actor.id));
  }

  private rebuildSnapPool(actorIds: string[]): void {
    const pool: SnapCandidate[] = [];
    const edges: EdgeCandidate[] = [];
    const seen = new Set<string>();
    const instanceMatrix = new THREE.Matrix4();
    const instancePos = new THREE.Vector3();
    for (const actorId of actorIds) {
      const root = this.sceneController.getActorObject(actorId);
      if (!(root instanceof THREE.Object3D)) {
        continue;
      }
      root.updateWorldMatrix(true, false);
      let perActor = 0;
      let perActorEdges = 0;
      // Candidates store an actor-relative landmark so a placed point live-follows
      // the actor; `world` is the sampled position for screen-space proximity.
      const addCandidate = (world: THREE.Vector3, category: SnapCategory = "vertex", name?: string): void => {
        if (pool.length >= SNAP_DOT_POOL_CAP || perActor >= SNAP_DOT_PER_ACTOR_CAP) {
          return;
        }
        const key = `${world.x.toFixed(2)},${world.y.toFixed(2)},${world.z.toFixed(2)}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        const local = root.worldToLocal(world.clone());
        pool.push({
          world,
          landmark: { kind: "actor", actorId, localOffset: [local.x, local.y, local.z] },
          category,
          name
        });
        perActor += 1;
      };

      // Authoritative snap points published by an actor/plugin (e.g. beam-emitter
      // arrays expose exact emitter positions). These replace geometry sampling,
      // whose vertices would be noise (beam volume verts, not emitter points).
      const authoritative = (root.userData as { dimensionSnapPointsWorld?: unknown }).dimensionSnapPointsWorld;
      if (Array.isArray(authoritative) && authoritative.length > 0) {
        for (const p of authoritative) {
          if (Array.isArray(p) && p.length >= 3 && typeof p[0] === "number" && typeof p[1] === "number" && typeof p[2] === "number") {
            addCandidate(new THREE.Vector3(p[0], p[1], p[2]));
          }
        }
        continue;
      }

      root.traverse((node) => {
        // Skip hidden geometry (e.g. toggled-off DXF layers): a node that isn't drawn
        // must not contribute snap points. `traverse` still descends, so each node is
        // checked against its own ancestor chain rather than relying on early-out.
        if (!isVisibleInSubtree(node, root)) {
          return;
        }
        // DXF straight lines: collect world-space segments for on-line and
        // intersection snapping (endpoints still flow into the vertex pool below).
        if (node instanceof THREE.LineSegments && (node.userData as { kind?: string }).kind === "dxf-lines") {
          node.updateWorldMatrix(true, false);
          // Precise per-entity snap points (endpoints / midpoints / centers) published
          // by the DXF builder. Added before the strided vertex sampling below so their
          // dedupe keys win, keeping these exact points out of the generic "vertex" bucket.
          const dxfSnap = node.userData as {
            dxfSnapEndpoints?: Float32Array;
            dxfSnapMidpoints?: Float32Array;
            dxfSnapCenters?: Float32Array;
          };
          const addDxfSnapPoints = (data: Float32Array | undefined, category: SnapCategory, name: string): void => {
            if (!data) {
              return;
            }
            for (let i = 0; i + 2 < data.length; i += 3) {
              if (pool.length >= SNAP_DOT_POOL_CAP || perActor >= SNAP_DOT_PER_ACTOR_CAP) {
                break;
              }
              addCandidate(node.localToWorld(new THREE.Vector3(data[i], data[i + 1], data[i + 2])), category, name);
            }
          };
          addDxfSnapPoints(dxfSnap.dxfSnapEndpoints, "endpoint", "Endpoint");
          addDxfSnapPoints(dxfSnap.dxfSnapMidpoints, "midpoint", "Midpoint");
          addDxfSnapPoints(dxfSnap.dxfSnapCenters, "center", "Center");
          const geom = node.geometry as THREE.BufferGeometry | undefined;
          const segPos = geom?.getAttribute?.("position") as THREE.BufferAttribute | undefined;
          if (segPos) {
            const segCount = Math.floor(segPos.count / 2);
            const segStride = Math.max(1, Math.floor(segCount / SNAP_DOT_PER_ACTOR_CAP));
            for (let s = 0; s < segCount; s += segStride) {
              if (edges.length >= SNAP_DOT_POOL_CAP || perActorEdges >= SNAP_DOT_PER_ACTOR_CAP) {
                break;
              }
              const i = s * 2;
              edges.push({
                a: node.localToWorld(new THREE.Vector3().fromBufferAttribute(segPos, i)),
                b: node.localToWorld(new THREE.Vector3().fromBufferAttribute(segPos, i + 1)),
                actorId
              });
              perActorEdges += 1;
            }
          }
        }
        if (pool.length >= SNAP_DOT_POOL_CAP || perActor >= SNAP_DOT_PER_ACTOR_CAP) {
          return;
        }
        if (this.isOverlayObject(node)) {
          return;
        }
        node.updateWorldMatrix(true, false);
        // InstancedMesh (e.g. beam-emitter arrays): one landmark per instance at
        // the instance's world translation. Checked before Mesh — it subclasses it.
        if (node instanceof THREE.InstancedMesh) {
          for (let i = 0; i < node.count; i += 1) {
            if (pool.length >= SNAP_DOT_POOL_CAP || perActor >= SNAP_DOT_PER_ACTOR_CAP) {
              break;
            }
            node.getMatrixAt(i, instanceMatrix);
            instancePos.setFromMatrixPosition(instanceMatrix).applyMatrix4(node.matrixWorld);
            addCandidate(instancePos.clone());
          }
          return;
        }
        if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.Line) && !(node instanceof THREE.Points)) {
          return;
        }
        const geometry = (node as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        const position = geometry?.getAttribute?.("position") as THREE.BufferAttribute | undefined;
        if (!position) {
          return;
        }
        // Evenly sample when the geometry is dense so one actor can't flood the pool.
        const stride = Math.max(1, Math.floor(position.count / SNAP_DOT_PER_ACTOR_CAP));
        for (let i = 0; i < position.count; i += stride) {
          if (pool.length >= SNAP_DOT_POOL_CAP || perActor >= SNAP_DOT_PER_ACTOR_CAP) {
            break;
          }
          addCandidate(node.localToWorld(new THREE.Vector3().fromBufferAttribute(position, i)));
        }
      });
    }
    this.snapDotPool = pool;
    this.edgePool = edges;
  }

  /** Whether a pool candidate's category is currently armed by the snap toggles. */
  private isSnapCategoryEnabled(category: SnapCategory, settings: DimensionSnapSettings): boolean {
    switch (category) {
      case "endpoint":
        return settings.endpoint;
      case "midpoint":
        return settings.midpoint;
      case "center":
        return settings.center;
      case "vertex":
      default:
        return settings.vertex;
    }
  }

  private updateSnapDots(): void {
    const attr = this.snapDots.geometry.getAttribute("position") as THREE.BufferAttribute;
    const cursor = this.lastPointerPx;
    if (!cursor || this.snapDotPool.length === 0) {
      this.snapDots.geometry.setDrawRange(0, 0);
      return;
    }
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.snapDots.geometry.setDrawRange(0, 0);
      return;
    }
    this.ensureCameraMatrices();
    const settings = this.kernel.store.getState().state.dimensionSnap;
    const scored: Array<{ p: THREE.Vector3; d: number }> = [];
    for (const entry of this.snapDotPool) {
      if (!this.isSnapCategoryEnabled(entry.category, settings)) {
        continue;
      }
      const screen = this.worldToScreenPx(entry.world, rect);
      if (!screen) {
        continue;
      }
      scored.push({ p: entry.world, d: Math.hypot(screen.x - cursor.x, screen.y - cursor.y) });
    }
    scored.sort((a, b) => a.d - b.d);
    const count = Math.min(SNAP_DOT_DISPLAY, scored.length);
    for (let i = 0; i < count; i += 1) {
      const p = scored[i]!.p;
      attr.setXYZ(i, p.x, p.y, p.z);
    }
    attr.needsUpdate = true;
    this.snapDots.geometry.setDrawRange(0, count);
  }

  // ----- Landmark / geometry resolution --------------------------------------
  // Delegated to the shared, render-agnostic `dimensions/geometry` module so the
  // live overlay and the vector print exporter derive identical geometry. The
  // resolver maps actor ids to scene objects for local→world landmark transforms.

  private readonly resolveActorObject = (actorId: string): THREE.Object3D | null => {
    const object = this.sceneController.getActorObject(actorId);
    return object instanceof THREE.Object3D ? object : null;
  };

  private resolveLandmarkWorld(landmark: Landmark | null): THREE.Vector3 | null {
    return resolveLandmarkWorldShared(landmark, this.resolveActorObject);
  }

  private resolveLandmarkLine(
    landmark: Landmark | null
  ): { p0: THREE.Vector3; dir: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3 } | null {
    return resolveLandmarkLineWorld(landmark, this.resolveActorObject);
  }

  private resolveMeasureEndpoints(
    start: Landmark | null,
    end: Landmark | null
  ): { A: THREE.Vector3; B: THREE.Vector3; perpendicular: boolean } | null {
    return resolveMeasureEndpointsShared(start, end, this.resolveActorObject);
  }

  private computeDimensionGeometry(actor: ActorNode): DimensionGeometry | null {
    return computeDimensionWorldGeometry(actor, this.resolveActorObject);
  }

  // ----- Per-actor visuals ---------------------------------------------------

  private ensureVisual(actor: ActorNode): DimensionVisual {
    const existing = this.visuals.get(actor.id);
    if (existing) {
      return existing;
    }
    const root = new THREE.Group();
    root.name = `${actor.actorType}-${actor.id}`;
    const labelCanvas = document.createElement("canvas");
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: labelTexture, depthTest: false, depthWrite: false, transparent: true })
    );
    label.renderOrder = LABEL_RENDER_ORDER;
    // Four lines: extension-at-start, extension-at-end, and the measure span
    // split into two segments so the label can break it (lines[2] + lines[3]).
    const lines = [makeLine(0xffcc33), makeLine(0xffcc33), makeLine(0xffcc33), makeLine(0xffcc33)];
    for (const line of lines) {
      root.add(line);
    }
    root.add(label);
    this.overlayRoot.add(root);
    const visual: DimensionVisual = {
      root,
      lines,
      label,
      labelCanvas,
      labelTexture,
      signature: "",
      labelAspect: 1
    };
    this.visuals.set(actor.id, visual);
    return visual;
  }

  private disposeVisual(visual: DimensionVisual): void {
    for (const line of visual.lines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    (visual.label.material as THREE.SpriteMaterial).dispose();
    visual.labelTexture.dispose();
    visual.root.parent?.remove(visual.root);
  }

  private updateDimensionVisual(actor: ActorNode, visual: DimensionVisual, isSelected: boolean): void {
    const geom = this.computeDimensionGeometry(actor);
    if (!geom) {
      visual.root.visible = false;
      return;
    }
    const units = resolveDimensionUnits(actor.params.units);
    const decimals = Number.isFinite(Number(actor.params.decimals)) ? Number(actor.params.decimals) : 2;
    const lineColor = hexToCss(actor.params.lineColor, "#ffcc33");
    const colorHex = new THREE.Color(lineColor).getHex();
    for (const line of visual.lines) {
      (line.material as THREE.LineBasicMaterial).color.setHex(colorHex);
    }

    setLinePoints(visual.lines[0]!, geom.A, geom.m1); // extension at start
    setLinePoints(visual.lines[1]!, geom.B, geom.m2); // extension at end
    visual.lines[0]!.visible = true;
    visual.lines[1]!.visible = true;

    const showValue = actor.params.showValue !== false;
    const text = showValue ? formatDistanceMeters(geom.distance, units, decimals) : "";
    const textColor = hexToCss(actor.params.textColor, "#ffffff");
    const textSizePx = Number.isFinite(Number(actor.params.textSizePx)) ? Number(actor.params.textSizePx) : 14;
    // Selection highlight: back the number with a filled rectangle in the line
    // colour. It bridges the measure line through the label so the dimension
    // reads as one continuous bar, marking selection without covering the text
    // (which renders on top of the fill). The text switches to whichever of
    // black/white stays legible against that fill.
    const background = isSelected ? lineColor : null;
    const effectiveTextColor = isSelected ? contrastingTextColor(lineColor) : textColor;
    const signature = `dim|${text}|${effectiveTextColor}|${textSizePx}|${background ?? ""}`;
    if (signature !== visual.signature) {
      this.renderLabel(visual, text, { textColor: effectiveTextColor, textSizePx, background });
      visual.signature = signature;
    }
    visual.label.visible = text.length > 0;
    visual.label.position.copy(geom.labelPos);
    this.scaleLabel(visual, textSizePx);

    // Selected: the fill covers the centre, so draw the span unbroken — it shows
    // through as a continuous line behind the rectangle. Unselected: break the
    // line around the number so it never crosses it.
    const breakForLabel = text.length > 0 && !isSelected;
    this.layoutSpanLine(geom, visual, breakForLabel ? textSizePx : 0);

    this.maybeWriteStatus(actor.id, geom.distance);
  }

  /**
   * Lay out the measure span as two segments (lines[2] + lines[3]) leaving a gap
   * around the centered label so the line doesn't run through the number. The gap
   * is sized from the label's on-screen bounding box, projected onto the line's
   * screen direction, so it stays correct at any orientation/zoom. Pass
   * `textSizePx = 0` (no visible label) to draw the span as a single unbroken line.
   */
  private layoutSpanLine(geom: DimensionGeometry, visual: DimensionVisual, textSizePx: number): void {
    const drawWhole = (): void => {
      setLinePoints(visual.lines[2]!, geom.m1, geom.m2);
      visual.lines[2]!.visible = true;
      visual.lines[3]!.visible = false;
    };
    if (textSizePx <= 0) {
      drawWhole();
      return;
    }
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      drawWhole();
      return;
    }
    this.ensureCameraMatrices();
    const s1 = this.worldToScreenPx(geom.m1, rect);
    const s2 = this.worldToScreenPx(geom.m2, rect);
    const worldLen = geom.m1.distanceTo(geom.m2);
    if (!s1 || !s2 || worldLen < 1e-6) {
      drawWhole();
      return;
    }
    const screenLen = Math.hypot(s2.x - s1.x, s2.y - s1.y);
    if (screenLen < 1e-3) {
      drawWhole();
      return;
    }
    // Label on-screen half-extents (height matches scaleLabel: textSizePx * 1.6).
    const heightPx = textSizePx * 1.6;
    const pad = Math.max(2, textSizePx * 0.2);
    const halfW = (heightPx * visual.labelAspect) / 2 + pad;
    const halfH = heightPx / 2 + pad;
    // Distance along the screen line, from the label centre, to where it leaves
    // the label's bounding box (the line passes through the centre).
    const dx = (s2.x - s1.x) / screenLen;
    const dy = (s2.y - s1.y) / screenLen;
    const tx = Math.abs(dx) > 1e-6 ? halfW / Math.abs(dx) : Infinity;
    const ty = Math.abs(dy) > 1e-6 ? halfH / Math.abs(dy) : Infinity;
    const gapPx = Math.min(tx, ty);
    const gapWorld = Number.isFinite(gapPx) ? gapPx * (worldLen / screenLen) : 0;
    if (gapWorld <= 0 || gapWorld * 2 >= worldLen) {
      // Label covers the whole span (or no usable gap): hide the line so it
      // never crosses the number; very short dims just show the value.
      if (gapWorld * 2 >= worldLen) {
        visual.lines[2]!.visible = false;
        visual.lines[3]!.visible = false;
        return;
      }
      drawWhole();
      return;
    }
    const spanDir = geom.m2.clone().sub(geom.m1).normalize();
    const breakA = geom.labelPos.clone().addScaledVector(spanDir, -gapWorld);
    const breakB = geom.labelPos.clone().addScaledVector(spanDir, gapWorld);
    setLinePoints(visual.lines[2]!, geom.m1, breakA);
    setLinePoints(visual.lines[3]!, breakB, geom.m2);
    visual.lines[2]!.visible = true;
    visual.lines[3]!.visible = true;
  }

  private updateAnnotationVisual(actor: ActorNode, visual: DimensionVisual): void {
    const anchor = this.resolveLandmarkWorld(readLandmark(actor.params.anchor));
    if (!anchor) {
      visual.root.visible = false;
      return;
    }
    visual.lines[1]!.visible = false;
    visual.lines[2]!.visible = false;
    visual.lines[3]!.visible = false;

    const text = typeof actor.params.text === "string" ? actor.params.text : "Note";
    const textColor = hexToCss(actor.params.textColor, "#ffffff");
    const background = hexToCss(actor.params.backgroundColor, "#000000cc");
    const textSizePx = Number.isFinite(Number(actor.params.textSizePx)) ? Number(actor.params.textSizePx) : 14;
    const leader = actor.params.leader !== false;

    const signature = `note|${text}|${textColor}|${background}|${textSizePx}`;
    if (signature !== visual.signature) {
      this.renderLabel(visual, text, { textColor, textSizePx, background });
      visual.signature = signature;
    }

    const labelPos = anchor.clone();
    const worldPerPixel = this.worldUnitsPerPixel(anchor);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.currentCamera.quaternion);
    labelPos.addScaledVector(up, worldPerPixel * (textSizePx * 2));
    visual.label.position.copy(labelPos);
    visual.label.visible = true;
    this.scaleLabel(visual, textSizePx);

    if (leader) {
      const lineColorHex = new THREE.Color(textColor).getHex();
      (visual.lines[0]!.material as THREE.LineBasicMaterial).color.setHex(lineColorHex);
      setLinePoints(visual.lines[0]!, anchor, labelPos);
      visual.lines[0]!.visible = true;
    } else {
      visual.lines[0]!.visible = false;
    }
  }

  private maybeWriteStatus(actorId: string, distanceMeters: number): void {
    const previous = this.lastStatusDistance.get(actorId);
    const changed = previous === undefined || Math.abs(previous - distanceMeters) > 1e-5;
    if (!changed || this.frameCounter % STATUS_THROTTLE_FRAMES !== 0) {
      return;
    }
    this.lastStatusDistance.set(actorId, distanceMeters);
    this.kernel.store.getState().actions.setActorStatus(actorId, {
      values: { distanceMeters },
      updatedAtIso: new Date().toISOString()
    });
  }

  // ----- Label rendering / screen-space sizing -------------------------------

  private renderLabel(
    visual: DimensionVisual,
    text: string,
    opts: { textColor: string; textSizePx: number; background: string | null }
  ): void {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const fontPx = Math.max(8, opts.textSizePx);
    const canvas = visual.labelCanvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const font = `600 ${fontPx}px system-ui, sans-serif`;
    ctx.font = font;
    const metrics = ctx.measureText(text || " ");
    const padX = fontPx * 0.4;
    const padY = fontPx * 0.3;
    const textWidth = Math.max(1, metrics.width);
    const cssWidth = textWidth + padX * 2;
    const cssHeight = fontPx + padY * 2;
    const prevW = canvas.width;
    const prevH = canvas.height;
    const nextW = Math.ceil(cssWidth * dpr);
    const nextH = Math.ceil(cssHeight * dpr);
    canvas.width = nextW;
    canvas.height = nextH;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (opts.background) {
      ctx.fillStyle = opts.background;
      const r = Math.min(6, cssHeight / 3);
      roundRect(ctx, 0, 0, cssWidth, cssHeight, r);
      ctx.fill();
    }
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    if (!opts.background) {
      ctx.lineWidth = Math.max(2, fontPx * 0.18);
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(text, cssWidth / 2, cssHeight / 2);
    }
    ctx.fillStyle = opts.textColor;
    ctx.fillText(text, cssWidth / 2, cssHeight / 2);
    visual.labelAspect = cssWidth / cssHeight;
    if (nextW !== prevW || nextH !== prevH) {
      // WebGPU does not reallocate a CanvasTexture's GPU storage when the backing
      // canvas resizes, so needsUpdate alone reuploads into a stale-sized texture
      // and the label freezes (the number stops tracking the geometry). Recreate
      // the texture so the backend allocates correctly-sized storage.
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      visual.labelTexture.dispose();
      visual.labelTexture = tex;
      const mat = visual.label.material as THREE.SpriteMaterial;
      mat.map = tex;
      mat.needsUpdate = true;
    } else {
      visual.labelTexture.needsUpdate = true;
    }
  }

  private scaleLabel(visual: DimensionVisual, textSizePx: number): void {
    const worldPerPixel = this.worldUnitsPerPixel(visual.label.position);
    const heightPx = textSizePx * 1.6;
    const worldHeight = Math.max(1e-4, heightPx * worldPerPixel);
    visual.label.scale.set(worldHeight * visual.labelAspect, worldHeight, 1);
  }

  private worldUnitsPerPixel(worldPoint: THREE.Vector3): number {
    const heightPx = Math.max(1, this.domElement.clientHeight);
    const camera = this.currentCamera;
    if (camera?.isOrthographicCamera) {
      const frustumHeight = (camera.top - camera.bottom) / (camera.zoom || 1);
      return frustumHeight / heightPx;
    }
    const fov = ((camera?.fov ?? 50) * Math.PI) / 180;
    const distance = camera ? camera.position.distanceTo(worldPoint) : 1;
    return (2 * Math.tan(fov / 2) * Math.max(0.001, distance)) / heightPx;
  }

  private markerScale(worldPoint: THREE.Vector3, px: number): number {
    return Math.max(1e-4, px * this.worldUnitsPerPixel(worldPoint));
  }

  // ----- Offset handle (select mode) -----------------------------------------

  private updateOffsetHandle(
    state: AppState,
    selectedIds: Set<string>,
    placementActive: boolean
  ): void {
    if (placementActive || selectedIds.size !== 1) {
      this.offsetHandleActive = false;
      return;
    }
    const actorId = [...selectedIds][0]!;
    const actor = state.actors[actorId];
    if (!actor || actor.actorType !== "dimension") {
      this.offsetHandleActive = false;
      return;
    }
    const geom = this.computeDimensionGeometry(actor);
    if (!geom) {
      this.offsetHandleActive = false;
      return;
    }
    // The selection-highlight rectangle drawn behind the number is the drag
    // affordance; keep an invisible pick proxy at its centre so dragging the
    // label still adjusts the offset. The box mesh itself is never rendered.
    this.offsetHandleActive = true;
    this.offsetHandle.position.copy(geom.labelPos);
    this.offsetHandle.userData.actorId = actorId;
  }

  // ----- Placement preview ---------------------------------------------------

  private updatePlacementPreview(): void {
    const annotation = this.tool === "annotation";
    if (this.pendingEnd && this.placementOffset) {
      // Offset step: preview the measure line at the candidate offset.
      this.hoverMarker.visible = false;
      this.hoverLine.visible = false;
      this.startMarker.visible = false;
      this.rubberLine.visible = false;
      // Derive the measured endpoints (perpendicular foot / closest points for line landmarks).
      const measure = this.resolveMeasureEndpoints(this.pendingStart!.landmark, this.pendingEnd.landmark);
      if (!measure) {
        for (const line of this.previewLines) {
          line.visible = false;
        }
        return;
      }
      const A = measure.A;
      const B = measure.B;
      const O = this.placementOffset.dir.clone().multiplyScalar(this.placementOffset.magnitude);
      const along =
        this.pendingEnd.axis === "direct"
          ? B.clone().sub(A)
          : new THREE.Vector3().setComponent(
              axisIndexOf(this.pendingEnd.axis),
              B.getComponent(axisIndexOf(this.pendingEnd.axis)) - A.getComponent(axisIndexOf(this.pendingEnd.axis))
            );
      const m1 = A.clone().add(O);
      const m2 = m1.clone().add(along);
      setLinePoints(this.previewLines[0]!, A, m1);
      setLinePoints(this.previewLines[1]!, B, m2);
      setLinePoints(this.previewLines[2]!, m1, m2);
      for (const line of this.previewLines) {
        line.visible = true;
      }
      return;
    }
    for (const line of this.previewLines) {
      line.visible = false;
    }
    const hoverLine = this.hoverSnap?.landmark.kind === "line" ? this.resolveLandmarkLine(this.hoverSnap.landmark) : null;
    if (hoverLine) {
      // Hovering a line landmark: highlight the whole segment, hide the point sphere.
      this.hoverLine.visible = true;
      setLinePoints(this.hoverLine, hoverLine.a, hoverLine.b);
      this.hoverMarker.visible = false;
    } else if (this.hoverSnap) {
      this.hoverLine.visible = false;
      this.hoverMarker.visible = true;
      this.hoverMarker.position.copy(this.hoverSnap.world);
      this.hoverMarker.scale.setScalar(this.markerScale(this.hoverSnap.world, 6));
    } else {
      this.hoverLine.visible = false;
      this.hoverMarker.visible = false;
    }
    if (!annotation && this.pendingStart) {
      this.startMarker.visible = true;
      this.startMarker.position.copy(this.pendingStart.world);
      this.startMarker.scale.setScalar(this.markerScale(this.pendingStart.world, 6));
      if (this.hoverSnap) {
        this.rubberLine.visible = true;
        setLinePoints(this.rubberLine, this.pendingStart.world, this.hoverSnap.world);
      } else {
        this.rubberLine.visible = false;
      }
    } else {
      this.startMarker.visible = false;
      this.rubberLine.visible = false;
    }
  }

  // ----- Pointer handling ----------------------------------------------------

  private onPointerMove = (event: PointerEvent): void => {
    this.shiftHeld = event.shiftKey;
    const rectForCursor = this.domElement.getBoundingClientRect();
    if (rectForCursor.width > 0 && rectForCursor.height > 0) {
      this.lastPointerPx = { x: event.clientX - rectForCursor.left, y: event.clientY - rectForCursor.top };
    }
    if (this.draggingOffset) {
      this.applyOffsetDrag(event);
      return;
    }
    const tool = this.tool;
    if (tool === "select") {
      if (this.domElement.style.cursor === "crosshair") {
        this.domElement.style.cursor = "";
      }
      this.publishHover(null);
      return;
    }
    this.domElement.style.cursor = "crosshair";
    if (this.pendingEnd) {
      // Offset step: cursor sets the perpendicular offset, not a snap point.
      // Re-evaluate the axis from the live Shift state so it can be toggled here.
      this.refreshOffsetStep();
      this.hoverSnap = null;
      this.publishHover(null);
      return;
    }
    this.hoverSnap = this.computeSnap(event);
    this.publishHover(this.hoverSnap);
  };

  private onPointerDown = (event: PointerEvent): void => {
    this.shiftHeld = event.shiftKey;
    const tool = this.tool;
    if (tool === "select") {
      if (event.button === 0 && this.offsetHandleActive) {
        const actorId = this.pickHandle(event);
        if (actorId) {
          this.beginOffsetDrag(event, actorId);
        }
      }
      return;
    }
    if (event.button !== 0) {
      return;
    }

    if (tool === "annotation") {
      const snap = this.computeSnap(event);
      if (!snap) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.kernel.store.getState().actions.createAnnotation({ anchor: snap.landmark });
      this.kernel.store.getState().actions.setStatus("Annotation placed.");
      this.kernel.store.getState().actions.setInteractionTool("select");
      this.cancelPlacement();
      return;
    }

    // Dimension: three steps (start, end, offset).
    if (!this.pendingStart) {
      const snap = this.computeSnap(event);
      if (!snap) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.pendingStart = { landmark: snap.landmark, world: snap.world.clone() };
      this.kernel.store.getState().actions.setStatus("Dimension start set. Click the end point (hold Shift for direct).");
      return;
    }
    if (!this.pendingEnd) {
      const snap = this.computeSnap(event);
      if (!snap) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // A line landmark forces an orthogonal measure; otherwise use the dominant
      // world axis of the derived measure endpoints (Shift = direct). The axis can
      // still be toggled with Shift during the offset step that follows.
      const rect = this.domElement.getBoundingClientRect();
      this.lastPointerPx = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const measure = this.resolveMeasureEndpoints(this.pendingStart.landmark, snap.landmark);
      const axis = this.resolvePlacementAxis(this.pendingStart.landmark, snap.landmark);
      this.pendingEnd = { landmark: snap.landmark, world: snap.world.clone(), axis };
      const mA = measure ? measure.A : this.pendingStart.world;
      const mB = measure ? measure.B : snap.world;
      this.placementOffset = this.computeOffset(this.lastPointerPx, mA, mB, axis);
      this.kernel.store
        .getState()
        .actions.setStatus(
          "Move to position the dimension line (Shift = direct, Space = flip axis), then click to place."
        );
      return;
    }

    // Third click: confirm offset and create.
    event.preventDefault();
    event.stopPropagation();
    const measure3 = this.resolveMeasureEndpoints(this.pendingStart.landmark, this.pendingEnd.landmark);
    const offA = measure3 ? measure3.A : this.pendingStart.world;
    const offB = measure3 ? measure3.B : this.pendingEnd.world;
    const rect3 = this.domElement.getBoundingClientRect();
    const px3 = { x: event.clientX - rect3.left, y: event.clientY - rect3.top };
    const offset = this.placementOffset ?? this.computeOffset(px3, offA, offB, this.pendingEnd.axis);
    let dir = offset ? offset.dir.clone() : new THREE.Vector3(0, 1, 0);
    let magnitude = offset ? offset.magnitude : 0;
    if (magnitude < 0) {
      dir = dir.negate();
      magnitude = -magnitude;
    }
    this.kernel.store.getState().actions.createDimension({
      start: this.pendingStart.landmark,
      end: this.pendingEnd.landmark,
      axis: this.pendingEnd.axis,
      offsetDir: [dir.x, dir.y, dir.z],
      extensionGap: magnitude
    });
    this.kernel.store.getState().actions.setStatus(`Dimension created (${this.pendingEnd.axis}).`);
    this.kernel.store.getState().actions.setInteractionTool("select");
    this.cancelPlacement();
  };

  private onPointerUp = (): void => {
    if (this.draggingOffset) {
      this.draggingOffset = null;
      (this.orbitControls as any).enabled = true;
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Shift") {
      // Live-toggle the axis during the offset step (auto-repeat is harmless).
      this.shiftHeld = true;
      if (this.pendingEnd) {
        this.refreshOffsetStep();
      }
      return;
    }
    if ((event.key === " " || event.code === "Space") && this.pendingEnd && !this.draggingOffset) {
      // Flip to the other in-view orthogonal axis while positioning the offset.
      event.preventDefault();
      event.stopPropagation();
      this.axisOverride = this.flipOrthoAxis(this.pendingEnd.axis);
      this.refreshOffsetStep();
      this.kernel.store.getState().actions.setStatus(`Dimension axis: ${this.pendingEnd.axis}.`);
      return;
    }
    if (event.key !== "Escape" || this.tool === "select") {
      return;
    }
    if (this.pendingEnd) {
      // Step back from the offset step to re-pick the end point.
      this.pendingEnd = null;
      this.placementOffset = null;
      this.axisOverride = null;
      this.kernel.store.getState().actions.setStatus("Re-pick the dimension end point.");
    } else if (this.pendingStart) {
      this.cancelPlacement();
      this.kernel.store.getState().actions.setStatus("Dimension cancelled.");
    } else {
      this.kernel.store.getState().actions.setInteractionTool("select");
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== "Shift") {
      return;
    }
    this.shiftHeld = false;
    if (this.pendingEnd) {
      this.refreshOffsetStep();
    }
  };

  // Axis selection shared by the end-point click and the offset step: a line
  // landmark always forces a direct measure; otherwise Shift forces direct, a
  // Space override (set while placing) pins a chosen orthogonal axis, and the
  // default snaps to the dominant world axis of the measured endpoints.
  private resolvePlacementAxis(start: Landmark, end: Landmark): DimensionAxis {
    const lineInvolved = start.kind === "line" || end.kind === "line";
    const measure = this.resolveMeasureEndpoints(start, end);
    if (lineInvolved || !measure) {
      return "direct";
    }
    if (this.shiftHeld) {
      return "direct";
    }
    if (this.axisOverride) {
      return this.axisOverride;
    }
    return dominantAxis(measure.A, measure.B);
  }

  // The two world axes that lie most in the current view plane (i.e. not the
  // camera's depth axis), ordered most-in-view first.
  private inViewAxes(): [DimensionAxis, DimensionAxis] {
    if (!this.currentCamera) {
      return ["x", "y"];
    }
    const fwd = new THREE.Vector3();
    this.currentCamera.getWorldDirection(fwd);
    const comp: Record<"x" | "y" | "z", number> = { x: Math.abs(fwd.x), y: Math.abs(fwd.y), z: Math.abs(fwd.z) };
    const sorted = (["x", "y", "z"] as const).slice().sort((a, b) => comp[a] - comp[b]);
    return [sorted[0]!, sorted[1]!];
  }

  // Flip the current orthogonal axis to the other in-view axis (Space). From a
  // direct/depth axis, jump to the most in-view axis.
  private flipOrthoAxis(current: DimensionAxis): DimensionAxis {
    const [a, b] = this.inViewAxes();
    if (current === a) {
      return b;
    }
    if (current === b) {
      return a;
    }
    return a;
  }

  // Re-derive the axis (from the live Shift state) and offset for the offset
  // step, using the last known cursor position so a stationary-mouse Shift
  // toggle still updates the preview.
  private refreshOffsetStep(): void {
    if (!this.pendingStart || !this.pendingEnd || this.draggingOffset || !this.lastPointerPx) {
      return;
    }
    const axis = this.resolvePlacementAxis(this.pendingStart.landmark, this.pendingEnd.landmark);
    this.pendingEnd.axis = axis;
    const measure = this.resolveMeasureEndpoints(this.pendingStart.landmark, this.pendingEnd.landmark);
    const mA = measure ? measure.A : this.pendingStart.world;
    const mB = measure ? measure.B : this.pendingEnd.world;
    this.placementOffset = this.computeOffset(this.lastPointerPx, mA, mB, axis);
  }

  private cancelPlacement(): void {
    this.shiftHeld = false;
    this.axisOverride = null;
    this.pendingStart = null;
    this.pendingEnd = null;
    this.placementOffset = null;
    this.hoverSnap = null;
    this.startMarker.visible = false;
    this.rubberLine.visible = false;
    for (const line of this.previewLines) {
      line.visible = false;
    }
    this.publishHover(null);
    this.domElement.style.cursor = "";
  }

  // ----- Offset drag ---------------------------------------------------------

  private beginOffsetDrag(event: PointerEvent, actorId: string): void {
    const actor = this.kernel.store.getState().state.actors[actorId];
    if (!actor) {
      return;
    }
    const geom = this.computeDimensionGeometry(actor);
    if (!geom) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.kernel.store.getState().actions.pushHistory("Move dimension");
    this.draggingOffset = { actorId, A: geom.A.clone(), B: geom.B.clone(), axis: geom.axis };
    (this.orbitControls as any).enabled = false;
  }

  private applyOffsetDrag(event: PointerEvent): void {
    if (!this.draggingOffset) {
      return;
    }
    const rect = this.domElement.getBoundingClientRect();
    const px = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const offset = this.computeOffset(px, this.draggingOffset.A, this.draggingOffset.B, this.draggingOffset.axis);
    if (!offset) {
      return;
    }
    let dir = offset.dir.clone();
    let magnitude = offset.magnitude;
    if (magnitude < 0) {
      dir = dir.negate();
      magnitude = -magnitude;
    }
    this.kernel.store.getState().actions.updateActorParamsNoHistory(this.draggingOffset.actorId, {
      offsetDir: [dir.x, dir.y, dir.z],
      extensionGap: magnitude
    });
  }

  private pickHandle(event: PointerEvent): string | null {
    if (!this.currentCamera || !this.offsetHandleActive) {
      return null;
    }
    const rect = this.domElement.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const screen = this.worldToScreenPx(this.offsetHandle.position, rect);
    if (!screen) {
      return null;
    }
    if (Math.hypot(screen.x - pointerX, screen.y - pointerY) > HANDLE_PIXEL_THRESHOLD) {
      return null;
    }
    return typeof this.offsetHandle.userData.actorId === "string" ? this.offsetHandle.userData.actorId : null;
  }

  // ----- Offset math ---------------------------------------------------------

  /** Compute a perpendicular offset (direction + signed magnitude) from the cursor. */
  private computeOffset(
    px: { x: number; y: number } | null,
    A: THREE.Vector3,
    B: THREE.Vector3,
    axis: DimensionAxis
  ): { dir: THREE.Vector3; magnitude: number } | null {
    if (!px) {
      return null;
    }
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || !this.currentCamera) {
      return null;
    }
    this.ensureCameraMatrices();
    this.pointerNdc.set((px.x / rect.width) * 2 - 1, -(px.y / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointerNdc, this.currentCamera);

    const lineDir = axis === "direct"
      ? B.clone().sub(A)
      : axisUnit(axis);
    if (lineDir.lengthSq() < 1e-12) {
      lineDir.set(1, 0, 0);
    }
    lineDir.normalize();

    const camForward = new THREE.Vector3();
    this.currentCamera.getWorldDirection(camForward);
    let offsetDir = new THREE.Vector3().crossVectors(camForward, lineDir);
    if (offsetDir.lengthSq() < 1e-8) {
      // Looking straight down the line: fall back to camera-up made perpendicular.
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.currentCamera.quaternion);
      offsetDir = up.sub(lineDir.clone().multiplyScalar(up.dot(lineDir)));
      if (offsetDir.lengthSq() < 1e-8) {
        return null;
      }
    }
    offsetDir.normalize();

    const M = A.clone().add(B).multiplyScalar(0.5);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camForward, M);
    const cursorWorld = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, cursorWorld)) {
      return null;
    }
    const magnitude = cursorWorld.sub(M).dot(offsetDir);
    return { dir: offsetDir, magnitude };
  }

  // ----- Snapping ------------------------------------------------------------

  private publishHover(snap: SnapResult | null): void {
    const label = snap ? `${snap.description.actorName} · ${snap.description.pointName}` : null;
    if (label === this.lastHoverLabel) {
      return;
    }
    this.lastHoverLabel = label;
    const hover: DimensionSnapHover = snap ? { actorName: snap.description.actorName, pointName: snap.description.pointName } : null;
    this.kernel.store.getState().actions.setDimensionSnapHover(hover);
  }

  private computeSnap(event: PointerEvent): SnapResult | null {
    if (!this.currentCamera) {
      return null;
    }
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const settings = this.kernel.store.getState().state.dimensionSnap;
    const state = this.kernel.store.getState().state;
    this.ensureCameraMatrices();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    this.pointerNdc.set((pointerX / rect.width) * 2 - 1, -(pointerY / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointerNdc, this.currentCamera);

    // 1) Origin.
    if (settings.origin) {
      const originScreen = this.worldToScreenPx(new THREE.Vector3(0, 0, 0), rect);
      if (originScreen && Math.hypot(originScreen.x - pointerX, originScreen.y - pointerY) <= SNAP_PIXEL_THRESHOLD) {
        return { world: new THREE.Vector3(0, 0, 0), landmark: { kind: "origin" }, description: { actorName: "World", pointName: "Origin" } };
      }
    }

    // 2) Nearest actor landmark: pick the closest candidate in screen space from
    // the pre-resolved pool. This is geometry-type agnostic (mesh vertices, line
    // endpoints, point clouds, and per-instance beam-emitter positions all land
    // in the pool), so it works where the old face-raycast snap could not. Each
    // candidate is gated by its category's toggle (vertex / endpoint / midpoint / center).
    if ((settings.vertex || settings.endpoint || settings.midpoint || settings.center) && this.snapDotPool.length > 0) {
      let best: SnapCandidate | null = null;
      let bestDist = SNAP_PIXEL_THRESHOLD;
      for (const candidate of this.snapDotPool) {
        if (!this.isSnapCategoryEnabled(candidate.category, settings)) {
          continue;
        }
        const screen = this.worldToScreenPx(candidate.world, rect);
        if (!screen) {
          continue;
        }
        const dist = Math.hypot(screen.x - pointerX, screen.y - pointerY);
        if (dist <= bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
      if (best) {
        // Re-resolve to the live world position so the placed point matches the
        // landmark exactly even if the actor moved since the last pool rebuild.
        const world = this.resolveLandmarkWorld(best.landmark) ?? best.world.clone();
        const actorName =
          best.landmark.kind === "actor" ? state.actors[best.landmark.actorId]?.name ?? "Actor" : "World";
        return { world, landmark: best.landmark, description: { actorName, pointName: best.name ?? "Landmark" } };
      }
    }

    // 2b) DXF lines: line–line intersections (point), then the line itself (segment).
    if (settings.vertex && this.edgePool.length > 0) {
      const near: Array<{ edge: EdgeCandidate; sa: { x: number; y: number }; sb: { x: number; y: number } }> = [];
      for (const edge of this.edgePool) {
        const sa = this.worldToScreenPx(edge.a, rect);
        const sb = this.worldToScreenPx(edge.b, rect);
        if (!sa || !sb) {
          continue;
        }
        if (segmentPointDistancePx(sa, sb, pointerX, pointerY) <= SNAP_PIXEL_THRESHOLD * 2) {
          near.push({ edge, sa, sb });
          if (near.length >= 32) {
            break;
          }
        }
      }

      // Intersection (preferred): two near segments that actually cross on screen.
      let bestX: { world: THREE.Vector3; actorId: string; dist: number } | null = null;
      for (let i = 0; i < near.length; i += 1) {
        for (let j = i + 1; j < near.length; j += 1) {
          const { c1, c2 } = closestPointsBetweenSegments(near[i]!.edge.a, near[i]!.edge.b, near[j]!.edge.a, near[j]!.edge.b);
          const s1 = this.worldToScreenPx(c1, rect);
          const s2 = this.worldToScreenPx(c2, rect);
          if (!s1 || !s2 || Math.hypot(s1.x - s2.x, s1.y - s2.y) > 3) {
            continue;
          }
          const dist = Math.hypot(s1.x - pointerX, s1.y - pointerY);
          if (dist <= SNAP_PIXEL_THRESHOLD && (!bestX || dist < bestX.dist)) {
            bestX = { world: c1.clone().add(c2).multiplyScalar(0.5), actorId: near[i]!.edge.actorId, dist };
          }
        }
      }
      if (bestX) {
        return this.actorPointResult(bestX.world, bestX.actorId, "Intersection", state);
      }

      // The line itself: nearest near-edge to the cursor → a line landmark.
      let bestEdge: { edge: EdgeCandidate; dist: number } | null = null;
      for (const entry of near) {
        const dist = segmentPointDistancePx(entry.sa, entry.sb, pointerX, pointerY);
        if (dist <= SNAP_PIXEL_THRESHOLD && (!bestEdge || dist < bestEdge.dist)) {
          bestEdge = { edge: entry.edge, dist };
        }
      }
      if (bestEdge) {
        const result = this.lineLandmarkResult(bestEdge.edge, pointerX, pointerY, rect, state);
        if (result) {
          return result;
        }
      }
    }

    // 3) Grid: snap to the nearest ground-plane (y=0) lattice point at the grid's minor pitch.
    if (settings.grid) {
      const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const gridHit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(groundPlane, gridHit)) {
        const pitch = Math.max(1e-3, state.scene.helpers.grid.minorPitch);
        const rx = Math.round(gridHit.x / pitch) * pitch;
        const rz = Math.round(gridHit.z / pitch) * pitch;
        const world = new THREE.Vector3(rx, 0, rz);
        return {
          world,
          landmark: { kind: "world", point: [rx, 0, rz] },
          description: { actorName: "Grid", pointName: `(${rx.toFixed(2)}, ${rz.toFixed(2)})` }
        };
      }
    }

    // 4) Surface: the raycast hit point on visible geometry (opt-in).
    if (settings.surface) {
      const hits = this.raycaster.intersectObjects(this.sceneController.scene.children, true);
      for (const hit of hits) {
        const object = hit.object;
        if (!object.visible || this.isOverlayObject(object)) {
          continue;
        }
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line) && !(object instanceof THREE.Points)) {
          continue;
        }
        const snappedWorld = hit.point.clone();
        const actorId = this.sceneController.getActorIdForObject(object);
        if (actorId) {
          const actorObject = this.sceneController.getActorObject(actorId);
          if (actorObject instanceof THREE.Object3D) {
            actorObject.updateWorldMatrix(true, false);
            const localOffset = actorObject.worldToLocal(snappedWorld.clone());
            return {
              world: snappedWorld,
              landmark: { kind: "actor", actorId, localOffset: [localOffset.x, localOffset.y, localOffset.z] },
              description: { actorName: state.actors[actorId]?.name ?? "Actor", pointName: "Surface" }
            };
          }
        }
        return {
          world: snappedWorld,
          landmark: { kind: "world", point: [snappedWorld.x, snappedWorld.y, snappedWorld.z] },
          description: { actorName: "World", pointName: "Surface" }
        };
      }
    }

    // 5) Free point on a camera-facing plane through origin.
    if (settings.free) {
      const cameraDir = new THREE.Vector3();
      this.currentCamera.getWorldDirection(cameraDir);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDir, new THREE.Vector3(0, 0, 0));
      const worldHit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, worldHit)) {
        return {
          world: worldHit,
          landmark: { kind: "world", point: [worldHit.x, worldHit.y, worldHit.z] },
          description: { actorName: "World", pointName: "Free" }
        };
      }
    }
    return null;
  }

  /** Build a point SnapResult anchored to an actor (live-follow via local offset). */
  private actorPointResult(world: THREE.Vector3, actorId: string, pointName: string, state: AppState): SnapResult {
    const actorObject = this.sceneController.getActorObject(actorId);
    if (actorObject instanceof THREE.Object3D) {
      actorObject.updateWorldMatrix(true, false);
      const local = actorObject.worldToLocal(world.clone());
      return {
        world,
        landmark: { kind: "actor", actorId, localOffset: [local.x, local.y, local.z] },
        description: { actorName: state.actors[actorId]?.name ?? "Actor", pointName }
      };
    }
    return {
      world,
      landmark: { kind: "world", point: [world.x, world.y, world.z] },
      description: { actorName: "World", pointName }
    };
  }

  /** Build a line SnapResult from a world-space edge; marker sits on the segment nearest the cursor. */
  private lineLandmarkResult(
    edge: EdgeCandidate,
    pointerX: number,
    pointerY: number,
    rect: DOMRect,
    state: AppState
  ): SnapResult | null {
    const actorObject = this.sceneController.getActorObject(edge.actorId);
    if (!(actorObject instanceof THREE.Object3D)) {
      return null;
    }
    actorObject.updateWorldMatrix(true, false);
    const la = actorObject.worldToLocal(edge.a.clone());
    const lb = actorObject.worldToLocal(edge.b.clone());
    let world = edge.a.clone().add(edge.b).multiplyScalar(0.5);
    const sa = this.worldToScreenPx(edge.a, rect);
    const sb = this.worldToScreenPx(edge.b, rect);
    if (sa && sb) {
      const dx = sb.x - sa.x;
      const dy = sb.y - sa.y;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 1e-9 ? clamp01(((pointerX - sa.x) * dx + (pointerY - sa.y) * dy) / lenSq) : 0;
      world = edge.a.clone().lerp(edge.b, t);
    }
    return {
      world,
      landmark: { kind: "line", actorId: edge.actorId, a: [la.x, la.y, la.z], b: [lb.x, lb.y, lb.z] },
      description: { actorName: state.actors[edge.actorId]?.name ?? "Actor", pointName: "Line" }
    };
  }

  private worldToScreenPx(world: THREE.Vector3, rect: DOMRect): { x: number; y: number } | null {
    const ndc = world.clone().project(this.currentCamera);
    if (ndc.z < -1 || ndc.z > 1) {
      return null;
    }
    return {
      x: ((ndc.x + 1) / 2) * rect.width,
      y: ((1 - ndc.y) / 2) * rect.height
    };
  }

  private isOverlayObject(object: THREE.Object3D): boolean {
    let cursor: THREE.Object3D | null = object;
    while (cursor) {
      if (cursor === this.overlayRoot) {
        return true;
      }
      cursor = cursor.parent;
    }
    return false;
  }
}

function dominantAxis(a: THREE.Vector3, b: THREE.Vector3): DimensionAxis {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const dz = Math.abs(b.z - a.z);
  if (dx >= dy && dx >= dz) {
    return "x";
  }
  return dy >= dz ? "y" : "z";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
