import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode, AppState, DimensionAxis, DimensionSnapHover, Landmark, ParameterValues } from "@/core/types";
import {
  formatDistanceMeters,
  readLandmark,
  resolveDimensionAxis,
  resolveDimensionUnits
} from "@/features/dimensions/model";
import { computeActorObjectVisibility, type SceneController } from "@/render/sceneController";

const OVERLAY_RENDER_ORDER = 999;
const LABEL_RENDER_ORDER = 1000;
const SNAP_PIXEL_THRESHOLD = 14;
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

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  );
}

function axisIndexOf(axis: DimensionAxis): number {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

function axisUnit(axis: DimensionAxis): THREE.Vector3 {
  return new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
}

export class DimensionOverlayController {
  private readonly overlayRoot = new THREE.Group();
  private readonly placementGroup = new THREE.Group();
  private readonly hoverMarker: THREE.Mesh;
  private readonly startMarker: THREE.Mesh;
  private readonly rubberLine: THREE.Line;
  private readonly previewLines: THREE.Line[];
  private readonly offsetHandle: THREE.Mesh;
  private readonly snapDots: THREE.Points;
  private snapDotPool: THREE.Vector3[] = [];
  private snapPoolSignature = "";
  private lastPointerPx: { x: number; y: number } | null = null;
  private readonly visuals = new Map<string, DimensionVisual>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private currentCamera: any;
  private pendingStart: { landmark: Landmark; world: THREE.Vector3 } | null = null;
  private pendingEnd: { landmark: Landmark; world: THREE.Vector3; axis: DimensionAxis } | null = null;
  private placementOffset: { dir: THREE.Vector3; magnitude: number } | null = null;
  private draggingOffset: { actorId: string; A: THREE.Vector3; B: THREE.Vector3; axis: DimensionAxis } | null = null;
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
    this.startMarker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false, depthWrite: false }));
    this.startMarker.renderOrder = LABEL_RENDER_ORDER;
    this.startMarker.visible = false;
    this.rubberLine = makeLine(0xffcc33);
    this.previewLines = [makeLine(0xffcc33), makeLine(0xffcc33), makeLine(0xffcc33)];
    for (const line of this.previewLines) {
      line.visible = false;
      this.placementGroup.add(line);
    }
    this.placementGroup.add(this.hoverMarker, this.startMarker, this.rubberLine);
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
  }

  public dispose(): void {
    this.domElement.removeEventListener("pointerdown", this.onPointerDown, true);
    this.domElement.removeEventListener("pointermove", this.onPointerMove, true);
    this.domElement.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
    for (const visual of this.visuals.values()) {
      this.disposeVisual(visual);
    }
    this.visuals.clear();
    this.hoverMarker.geometry.dispose();
    (this.hoverMarker.material as THREE.Material).dispose();
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
    return this.offsetHandle.visible && this.pickHandle(event) !== null;
  }

  public update(): void {
    const visible = this.sceneController.getDebugHelpersVisible();
    this.overlayRoot.visible = visible;
    const placementActive = this.tool !== "select";
    this.placementGroup.visible = visible && placementActive;
    if (!visible) {
      this.offsetHandle.visible = false;
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
        this.updateDimensionVisual(actor, visual);
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
    const showDots = placementActive && snap.showSnapPoints && snap.vertex;
    this.snapDots.visible = showDots;
    if (showDots) {
      this.maybeRebuildSnapPool(state, selectedIds);
      this.updateSnapDots();
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
        computeActorObjectVisibility(actor, selectedIds.has(actor.id), true)
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
    const pool: THREE.Vector3[] = [];
    const seen = new Set<string>();
    for (const actorId of actorIds) {
      const root = this.sceneController.getActorObject(actorId);
      if (!(root instanceof THREE.Object3D)) {
        continue;
      }
      root.updateWorldMatrix(true, false);
      let perActor = 0;
      root.traverse((node) => {
        if (pool.length >= SNAP_DOT_POOL_CAP || perActor >= SNAP_DOT_PER_ACTOR_CAP) {
          return;
        }
        if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.Line) && !(node instanceof THREE.Points)) {
          return;
        }
        if (this.isOverlayObject(node)) {
          return;
        }
        const geometry = (node as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        const position = geometry?.getAttribute?.("position") as THREE.BufferAttribute | undefined;
        if (!position) {
          return;
        }
        node.updateWorldMatrix(true, false);
        // Evenly sample when the geometry is dense so one actor can't flood the pool.
        const stride = Math.max(1, Math.floor(position.count / SNAP_DOT_PER_ACTOR_CAP));
        for (let i = 0; i < position.count; i += stride) {
          if (pool.length >= SNAP_DOT_POOL_CAP || perActor >= SNAP_DOT_PER_ACTOR_CAP) {
            break;
          }
          const world = node.localToWorld(new THREE.Vector3().fromBufferAttribute(position, i));
          const key = `${world.x.toFixed(2)},${world.y.toFixed(2)},${world.z.toFixed(2)}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          pool.push(world);
          perActor += 1;
        }
      });
    }
    this.snapDotPool = pool;
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
    const scored: Array<{ p: THREE.Vector3; d: number }> = [];
    for (const p of this.snapDotPool) {
      const screen = this.worldToScreenPx(p, rect);
      if (!screen) {
        continue;
      }
      scored.push({ p, d: Math.hypot(screen.x - cursor.x, screen.y - cursor.y) });
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

  private resolveLandmarkWorld(landmark: Landmark | null): THREE.Vector3 | null {
    if (!landmark) {
      return null;
    }
    if (landmark.kind === "origin") {
      return new THREE.Vector3(0, 0, 0);
    }
    if (landmark.kind === "world") {
      return new THREE.Vector3(landmark.point[0], landmark.point[1], landmark.point[2]);
    }
    const object = this.sceneController.getActorObject(landmark.actorId);
    if (!(object instanceof THREE.Object3D)) {
      return null;
    }
    object.updateWorldMatrix(true, false);
    return object.localToWorld(new THREE.Vector3(landmark.localOffset[0], landmark.localOffset[1], landmark.localOffset[2]));
  }

  /** Offset vector O for a dimension's measure line, from offsetDir × extensionGap (with fallback). */
  private resolveOffsetVector(params: ParameterValues, axis: DimensionAxis): THREE.Vector3 {
    const mag = Number.isFinite(Number(params.extensionGap)) ? Math.max(0, Number(params.extensionGap)) : 0.25;
    const dirRaw = params.offsetDir;
    if (isVec3(dirRaw)) {
      const dir = new THREE.Vector3(dirRaw[0], dirRaw[1], dirRaw[2]);
      if (dir.lengthSq() > 1e-12) {
        return dir.normalize().multiplyScalar(mag);
      }
    }
    if (axis === "direct") {
      return new THREE.Vector3(0, 0, 0);
    }
    const perp = axis === "y" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    return perp.multiplyScalar(mag);
  }

  private computeDimensionGeometry(actor: ActorNode): DimensionGeometry | null {
    const A = this.resolveLandmarkWorld(readLandmark(actor.params.start));
    const B = this.resolveLandmarkWorld(readLandmark(actor.params.end));
    if (!A || !B) {
      return null;
    }
    const axis = resolveDimensionAxis(actor.params.axis);
    const O = this.resolveOffsetVector(actor.params, axis);
    let along: THREE.Vector3;
    let lineDir: THREE.Vector3;
    if (axis === "direct") {
      along = B.clone().sub(A);
      lineDir = along.lengthSq() > 1e-12 ? along.clone().normalize() : new THREE.Vector3(1, 0, 0);
    } else {
      const i = axisIndexOf(axis);
      along = new THREE.Vector3();
      along.setComponent(i, B.getComponent(i) - A.getComponent(i));
      lineDir = axisUnit(axis);
    }
    const m1 = A.clone().add(O);
    const m2 = m1.clone().add(along);
    return {
      A,
      B,
      axis,
      m1,
      m2,
      distance: along.length(),
      labelPos: m1.clone().add(m2).multiplyScalar(0.5),
      lineDir
    };
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
    const lines = [makeLine(0xffcc33), makeLine(0xffcc33), makeLine(0xffcc33)];
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

  private updateDimensionVisual(actor: ActorNode, visual: DimensionVisual): void {
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
    setLinePoints(visual.lines[2]!, geom.m1, geom.m2); // measure line
    visual.lines[0]!.visible = true;
    visual.lines[1]!.visible = true;
    visual.lines[2]!.visible = true;

    const showValue = actor.params.showValue !== false;
    const text = showValue ? formatDistanceMeters(geom.distance, units, decimals) : "";
    const textColor = hexToCss(actor.params.textColor, "#ffffff");
    const textSizePx = Number.isFinite(Number(actor.params.textSizePx)) ? Number(actor.params.textSizePx) : 14;
    const signature = `dim|${text}|${textColor}|${textSizePx}`;
    if (signature !== visual.signature) {
      this.renderLabel(visual, text, { textColor, textSizePx, background: null });
      visual.signature = signature;
    }
    visual.label.visible = text.length > 0;
    visual.label.position.copy(geom.labelPos);
    this.scaleLabel(visual, textSizePx);

    this.maybeWriteStatus(actor.id, geom.distance);
  }

  private updateAnnotationVisual(actor: ActorNode, visual: DimensionVisual): void {
    const anchor = this.resolveLandmarkWorld(readLandmark(actor.params.anchor));
    if (!anchor) {
      visual.root.visible = false;
      return;
    }
    visual.lines[1]!.visible = false;
    visual.lines[2]!.visible = false;

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
    canvas.width = Math.ceil(cssWidth * dpr);
    canvas.height = Math.ceil(cssHeight * dpr);
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
    visual.labelTexture.needsUpdate = true;
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
      this.offsetHandle.visible = false;
      return;
    }
    const actorId = [...selectedIds][0]!;
    const actor = state.actors[actorId];
    if (!actor || actor.actorType !== "dimension") {
      this.offsetHandle.visible = false;
      return;
    }
    const geom = this.computeDimensionGeometry(actor);
    if (!geom) {
      this.offsetHandle.visible = false;
      return;
    }
    this.offsetHandle.visible = true;
    this.offsetHandle.position.copy(geom.labelPos);
    this.offsetHandle.scale.setScalar(this.markerScale(geom.labelPos, 9));
    this.offsetHandle.userData.actorId = actorId;
  }

  // ----- Placement preview ---------------------------------------------------

  private updatePlacementPreview(): void {
    const annotation = this.tool === "annotation";
    if (this.pendingEnd && this.placementOffset) {
      // Offset step: preview the measure line at the candidate offset.
      this.hoverMarker.visible = false;
      this.startMarker.visible = false;
      this.rubberLine.visible = false;
      const A = (this.pendingStart as { world: THREE.Vector3 }).world;
      const B = this.pendingEnd.world;
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
    if (this.hoverSnap) {
      this.hoverMarker.visible = true;
      this.hoverMarker.position.copy(this.hoverSnap.world);
      this.hoverMarker.scale.setScalar(this.markerScale(this.hoverSnap.world, 6));
    } else {
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
      this.placementOffset = this.computeOffset(event, (this.pendingStart as { world: THREE.Vector3 }).world, this.pendingEnd.world, this.pendingEnd.axis);
      this.hoverSnap = null;
      this.publishHover(null);
      return;
    }
    this.hoverSnap = this.computeSnap(event);
    this.publishHover(this.hoverSnap);
  };

  private onPointerDown = (event: PointerEvent): void => {
    const tool = this.tool;
    if (tool === "select") {
      if (event.button === 0 && this.offsetHandle.visible) {
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
      const axis: DimensionAxis = event.shiftKey ? "direct" : dominantAxis(this.pendingStart.world, snap.world);
      this.pendingEnd = { landmark: snap.landmark, world: snap.world.clone(), axis };
      this.placementOffset = this.computeOffset(event, this.pendingStart.world, this.pendingEnd.world, axis);
      this.kernel.store.getState().actions.setStatus("Move to position the dimension line, then click to place.");
      return;
    }

    // Third click: confirm offset and create.
    event.preventDefault();
    event.stopPropagation();
    const offset = this.placementOffset ?? this.computeOffset(event, this.pendingStart.world, this.pendingEnd.world, this.pendingEnd.axis);
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
    if (event.key !== "Escape" || this.tool === "select") {
      return;
    }
    if (this.pendingEnd) {
      // Step back from the offset step to re-pick the end point.
      this.pendingEnd = null;
      this.placementOffset = null;
      this.kernel.store.getState().actions.setStatus("Re-pick the dimension end point.");
    } else if (this.pendingStart) {
      this.cancelPlacement();
      this.kernel.store.getState().actions.setStatus("Dimension cancelled.");
    } else {
      this.kernel.store.getState().actions.setInteractionTool("select");
    }
  };

  private cancelPlacement(): void {
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
    const offset = this.computeOffset(event, this.draggingOffset.A, this.draggingOffset.B, this.draggingOffset.axis);
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
    if (!this.currentCamera || !this.offsetHandle.visible) {
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
    event: PointerEvent,
    A: THREE.Vector3,
    B: THREE.Vector3,
    axis: DimensionAxis
  ): { dir: THREE.Vector3; magnitude: number } | null {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || !this.currentCamera) {
      return null;
    }
    this.ensureCameraMatrices();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
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

    // 2) Geometry hits (vertex / surface).
    if (settings.vertex || settings.surface) {
      const hits = this.raycaster.intersectObjects(this.sceneController.scene.children, true);
      for (const hit of hits) {
        const object = hit.object;
        if (!object.visible || this.isOverlayObject(object)) {
          continue;
        }
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line) && !(object instanceof THREE.Points)) {
          continue;
        }
        let snappedWorld: THREE.Vector3 | null = null;
        let pointName: string | null = null;
        if (settings.vertex) {
          const vertex = this.snapHitToVertex(hit, rect, pointerX, pointerY);
          if (vertex) {
            snappedWorld = vertex;
            pointName = "Landmark";
          }
        }
        if (!snappedWorld && settings.surface) {
          snappedWorld = hit.point.clone();
          pointName = "Surface";
        }
        if (!snappedWorld || !pointName) {
          continue;
        }
        const actorId = this.sceneController.getActorIdForObject(object);
        if (actorId) {
          const actorObject = this.sceneController.getActorObject(actorId);
          if (actorObject instanceof THREE.Object3D) {
            actorObject.updateWorldMatrix(true, false);
            const localOffset = actorObject.worldToLocal(snappedWorld.clone());
            return {
              world: snappedWorld,
              landmark: { kind: "actor", actorId, localOffset: [localOffset.x, localOffset.y, localOffset.z] },
              description: { actorName: state.actors[actorId]?.name ?? "Actor", pointName }
            };
          }
        }
        return {
          world: snappedWorld,
          landmark: { kind: "world", point: [snappedWorld.x, snappedWorld.y, snappedWorld.z] },
          description: { actorName: "World", pointName }
        };
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

    // 4) Free point on a camera-facing plane through origin.
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

  private snapHitToVertex(
    hit: THREE.Intersection,
    rect: DOMRect,
    pointerX: number,
    pointerY: number
  ): THREE.Vector3 | null {
    const face = hit.face;
    const object = hit.object as THREE.Mesh;
    const geometry = object.geometry as THREE.BufferGeometry | undefined;
    if (!face || !geometry) {
      return null;
    }
    const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!position) {
      return null;
    }
    object.updateWorldMatrix(true, false);
    let best: THREE.Vector3 | null = null;
    let bestDist = SNAP_PIXEL_THRESHOLD;
    for (const index of [face.a, face.b, face.c]) {
      const local = new THREE.Vector3().fromBufferAttribute(position, index);
      const world = object.localToWorld(local.clone());
      const screen = this.worldToScreenPx(world, rect);
      if (!screen) {
        continue;
      }
      const dist = Math.hypot(screen.x - pointerX, screen.y - pointerY);
      if (dist <= bestDist) {
        bestDist = dist;
        best = world;
      }
    }
    return best;
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
