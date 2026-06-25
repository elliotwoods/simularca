import * as THREE from "three";
import type { AppKernel } from "@/app/kernel";
import type { SceneGridSettings } from "@/core/types";
import { applyLineOpacity, normalizeBackgroundColor, type SceneController } from "@/render/sceneController";

// A camera forward whose dominant axis component is at least this is treated as
// "looking straight down a world axis" (top/front/side). Matches the default
// tolerance used by isCameraFacingDirection in viewUtils.
const AXIS_ALIGNED_DOT = 0.9995;
// At or below this on-screen spacing (in CSS pixels) the minor lines are fully
// faded out and dropped, so a zoomed-out ortho view stays legible/cheap. Kept
// low so the minor lines linger a little longer before disappearing as the view
// zooms out, fading out gently rather than dropping abruptly.
const MINOR_FADE_MIN_PIXEL_SPACING = 2;
// At or above this on-screen spacing the minor lines are drawn at full opacity.
// Between the two bounds they fade linearly with zoom so the subgrid eases in
// and out instead of popping as the boundary is crossed.
const MINOR_FADE_FULL_PIXEL_SPACING = 12;
// Opacity scales for the three-tier grid: major (full), half (midpoints), minor (rest).
const HALF_OPACITY_SCALE = 0.6;
const MINOR_OPACITY_SCALE = 0.25;
// When the major lines crowd together on screen (zoomed out) they dim toward
// MAJOR_FADE_MIN_OPACITY so a dense major grid stays calm instead of reading as a
// solid fill. At or below MAJOR_FADE_MIN_PIXEL_SPACING they sit at the floor; at
// or above MAJOR_FADE_FULL_PIXEL_SPACING they are fully opaque; linear in between.
const MAJOR_FADE_MIN_PIXEL_SPACING = 50;
const MAJOR_FADE_FULL_PIXEL_SPACING = 100;
const MAJOR_FADE_MIN_OPACITY = 0.5;
// Hard safety cap on the number of grid lines generated per axis.
const MAX_LINES_PER_AXIS = 4000;
const TICK_EPSILON = 1e-6;
const GRID_RENDER_ORDER = -1;

interface GridGeometryRequest {
  normalAxis: 0 | 1 | 2;
  axisU: 0 | 1 | 2;
  axisV: 0 | 1 | 2;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  minorPitch: number;
  majorPitch: number;
  drawMinor: boolean;
  majorColor: string;
  minorColor: string;
  opacity: number;
}

interface GridUpdate {
  // Geometry-relevant fields only; serialized into the rebuild signature.
  request: GridGeometryRequest;
  // Per-frame minor-line opacity multiplier (0..1). Kept out of `request` so a
  // continuous zoom fade does not force a geometry rebuild every frame.
  minorFade: number;
  // Per-frame major-line opacity multiplier (MAJOR_FADE_MIN_OPACITY..1), dimming
  // the majors as they crowd together. Kept out of `request` for the same reason.
  majorFade: number;
}

// In-plane axes (lowest index first) for a grid whose normal is the given axis.
function inPlaneAxes(normalAxis: 0 | 1 | 2): [0 | 1 | 2, 0 | 1 | 2] {
  switch (normalAxis) {
    case 0:
      return [1, 2]; // YZ plane (left/right view)
    case 1:
      return [0, 2]; // XZ plane (top/bottom view)
    case 2:
      return [0, 1]; // XY plane (front/back view)
  }
}

function setComponent(target: [number, number, number], axisU: number, axisV: number, u: number, v: number): void {
  target[0] = 0;
  target[1] = 0;
  target[2] = 0;
  target[axisU] = u;
  target[axisV] = v;
}

function isMajorTick(value: number, majorPitch: number): boolean {
  const ratio = value / majorPitch;
  return Math.abs(ratio - Math.round(ratio)) < 1e-4;
}

function isHalfTick(value: number, majorPitch: number): boolean {
  const ratio = value / majorPitch;
  return Math.abs(Math.abs(ratio - Math.round(ratio)) - 0.5) < 1e-4;
}

// Opacity multiplier (0..1) for the minor grid lines given their on-screen
// spacing in CSS pixels. Fully transparent at/below MINOR_FADE_MIN_PIXEL_SPACING,
// fully opaque at/above MINOR_FADE_FULL_PIXEL_SPACING, linear in between.
export function minorFadeForSpacing(minorPixelSpacing: number): number {
  if (Number.isNaN(minorPixelSpacing)) {
    return 0;
  }
  const span = MINOR_FADE_FULL_PIXEL_SPACING - MINOR_FADE_MIN_PIXEL_SPACING;
  const t = (minorPixelSpacing - MINOR_FADE_MIN_PIXEL_SPACING) / span;
  // Clamp also collapses +Infinity (extreme zoom-in) to fully opaque.
  return Math.max(0, Math.min(1, t));
}

// Opacity multiplier for the major grid lines given their on-screen spacing in
// CSS pixels. Drops to MAJOR_FADE_MIN_OPACITY at/below MAJOR_FADE_MIN_PIXEL_SPACING
// (majors crowded together when zoomed out), rises to 1 at/above
// MAJOR_FADE_FULL_PIXEL_SPACING, linear in between.
export function majorFadeForSpacing(majorPixelSpacing: number): number {
  if (Number.isNaN(majorPixelSpacing)) {
    return 1;
  }
  const span = MAJOR_FADE_FULL_PIXEL_SPACING - MAJOR_FADE_MIN_PIXEL_SPACING;
  const t = (majorPixelSpacing - MAJOR_FADE_MIN_PIXEL_SPACING) / span;
  const clamped = Math.max(0, Math.min(1, t));
  return MAJOR_FADE_MIN_OPACITY + clamped * (1 - MAJOR_FADE_MIN_OPACITY);
}

function lineMaterial(color: string): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false });
}

export class SceneGridController {
  private readonly root = new THREE.Group();
  private readonly minorMaterial = lineMaterial("#1f2430");
  private readonly halfMaterial = lineMaterial("#1f2430");
  private readonly majorMaterial = lineMaterial("#2f8f9d");
  private minorSegments: THREE.LineSegments | null = null;
  private halfSegments: THREE.LineSegments | null = null;
  private majorSegments: THREE.LineSegments | null = null;
  private currentCamera: THREE.Camera;
  private viewportHeight = 1;
  private signature = "";
  private readonly scratch: [number, number, number] = [0, 0, 0];

  public constructor(
    private readonly kernel: AppKernel,
    private readonly sceneController: SceneController,
    initialCamera: THREE.Camera
  ) {
    this.currentCamera = initialCamera;
    this.root.name = "scene-grid";
    this.root.renderOrder = GRID_RENDER_ORDER;
    this.sceneController.scene.add(this.root);
  }

  public setCamera(camera: THREE.Camera): void {
    this.currentCamera = camera;
  }

  public setViewportSize(_width: number, height: number): void {
    this.viewportHeight = Math.max(1, height);
  }

  public dispose(): void {
    this.clearSegments();
    this.minorMaterial.dispose();
    this.halfMaterial.dispose();
    this.majorMaterial.dispose();
    this.root.parent?.remove(this.root);
  }

  public update(): void {
    const grid = this.kernel.store.getState().state.scene.helpers.grid;
    const override = this.sceneController.getGridVisibleOverride();
    const visible = override ?? (this.sceneController.getDebugHelpersVisible() && grid.visible);
    this.root.visible = visible;
    if (!visible) {
      return;
    }

    // Our update runs before the renderer refreshes world matrices, so make sure
    // the camera's matrices are current for getWorldDirection / unproject.
    this.currentCamera.updateMatrixWorld();
    if (this.currentCamera instanceof THREE.OrthographicCamera || this.currentCamera instanceof THREE.PerspectiveCamera) {
      this.currentCamera.updateProjectionMatrix();
    }

    const { request, minorFade, majorFade } = this.computeRequest(grid);
    const signature = JSON.stringify(request);
    if (signature !== this.signature) {
      this.rebuild(request);
      this.signature = signature;
    }
    // Opacity is applied every frame (not folded into the signature) so the
    // lines can fade smoothly with zoom without rebuilding geometry.
    applyLineOpacity(this.minorSegments ?? {}, request.opacity * minorFade * MINOR_OPACITY_SCALE);
    applyLineOpacity(this.halfSegments ?? {}, request.opacity * minorFade * HALF_OPACITY_SCALE);
    applyLineOpacity(this.majorSegments ?? {}, request.opacity * majorFade);
  }

  private computeRequest(grid: SceneGridSettings): GridUpdate {
    const minorPitch = Math.max(1e-3, grid.minorPitch);
    const majorPitch = Math.max(minorPitch, grid.majorPitch);
    const majorColor = normalizeBackgroundColor(grid.majorColor);
    const minorColor = normalizeBackgroundColor(grid.minorColor);

    const fill = this.resolveFillNormalAxis();
    if (fill !== null) {
      return this.computeFillRequest(fill, minorPitch, majorPitch, majorColor, minorColor, grid.opacity);
    }
    return this.computeFixedRequest(grid.size, minorPitch, majorPitch, majorColor, minorColor, grid.opacity);
  }

  // Returns the world axis the orthographic camera is looking straight down, or
  // null when the grid should fall back to the fixed ground-plane mode.
  private resolveFillNormalAxis(): 0 | 1 | 2 | null {
    if (!(this.currentCamera instanceof THREE.OrthographicCamera)) {
      return null;
    }
    const forward = new THREE.Vector3();
    this.currentCamera.getWorldDirection(forward);
    const ax = Math.abs(forward.x);
    const ay = Math.abs(forward.y);
    const az = Math.abs(forward.z);
    let axis: 0 | 1 | 2 = 0;
    let max = ax;
    if (ay > max) {
      axis = 1;
      max = ay;
    }
    if (az > max) {
      axis = 2;
      max = az;
    }
    return max >= AXIS_ALIGNED_DOT ? axis : null;
  }

  private computeFillRequest(
    normalAxis: 0 | 1 | 2,
    minorPitch: number,
    majorPitch: number,
    majorColor: string,
    minorColor: string,
    opacity: number
  ): GridUpdate {
    const [axisU, axisV] = inPlaneAxes(normalAxis);
    const camera = this.currentCamera as THREE.OrthographicCamera;

    // Exact visible rectangle: unproject the four NDC corners and read their
    // in-plane coordinates. Works for any axis-aligned ortho orientation.
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    const corner = new THREE.Vector3();
    for (const nx of [-1, 1]) {
      for (const ny of [-1, 1]) {
        corner.set(nx, ny, 0).unproject(camera);
        const u = corner.getComponent(axisU);
        const v = corner.getComponent(axisV);
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
    }

    // Snap outward to whole major cells and pad by one cell so small pans/zooms
    // stay covered without forcing a geometry rebuild every frame.
    uMin = Math.floor(uMin / majorPitch) * majorPitch - majorPitch;
    uMax = Math.ceil(uMax / majorPitch) * majorPitch + majorPitch;
    vMin = Math.floor(vMin / majorPitch) * majorPitch - majorPitch;
    vMax = Math.ceil(vMax / majorPitch) * majorPitch + majorPitch;

    const worldHeight = (camera.top - camera.bottom) / Math.max(1e-6, camera.zoom);
    const minorPixelSpacing = (this.viewportHeight * minorPitch) / Math.max(1e-6, worldHeight);
    const minorFade = minorFadeForSpacing(minorPixelSpacing);
    const majorPixelSpacing = (this.viewportHeight * majorPitch) / Math.max(1e-6, worldHeight);
    const majorFade = majorFadeForSpacing(majorPixelSpacing);
    // Generate minor geometry whenever it is at all visible; the continuous
    // fade itself is applied per-frame via opacity, not baked into geometry.
    const drawMinor = minorFade > 0;

    const request: GridGeometryRequest = {
      normalAxis,
      axisU,
      axisV,
      uMin,
      uMax,
      vMin,
      vMax,
      minorPitch,
      majorPitch,
      drawMinor,
      majorColor,
      minorColor,
      opacity
    };
    return { request, minorFade, majorFade };
  }

  private computeFixedRequest(
    size: number,
    minorPitch: number,
    majorPitch: number,
    majorColor: string,
    minorColor: string,
    opacity: number
  ): GridUpdate {
    const half = Math.max(0.001, size) / 2;
    const request: GridGeometryRequest = {
      normalAxis: 1,
      axisU: 0,
      axisV: 2,
      uMin: -half,
      uMax: half,
      vMin: -half,
      vMax: half,
      minorPitch,
      majorPitch,
      drawMinor: true,
      majorColor,
      minorColor,
      opacity
    };
    // The fixed ground-plane grid (non-ortho fallback) keeps all lines at full
    // strength; zoom-based fading only applies to the axis-aligned ortho fill.
    return { request, minorFade: 1, majorFade: 1 };
  }

  private rebuild(request: GridGeometryRequest): void {
    this.clearSegments();

    const minorPositions: number[] = [];
    const halfPositions: number[] = [];
    const majorPositions: number[] = [];

    // Lines parallel to V, placed at each U tick.
    this.addLines(request, true, request.uMin, request.uMax, request.vMin, request.vMax, minorPositions, halfPositions, majorPositions);
    // Lines parallel to U, placed at each V tick.
    this.addLines(request, false, request.vMin, request.vMax, request.uMin, request.uMax, minorPositions, halfPositions, majorPositions);

    this.majorMaterial.color.set(request.majorColor);
    this.minorMaterial.color.set(request.minorColor);
    this.halfMaterial.color.set(request.minorColor);

    if (request.drawMinor && minorPositions.length > 0) {
      this.minorSegments = this.makeSegments(minorPositions, this.minorMaterial);
      this.root.add(this.minorSegments);
    }
    if (request.drawMinor && halfPositions.length > 0) {
      this.halfSegments = this.makeSegments(halfPositions, this.halfMaterial);
      this.root.add(this.halfSegments);
    }
    if (majorPositions.length > 0) {
      this.majorSegments = this.makeSegments(majorPositions, this.majorMaterial);
      this.root.add(this.majorSegments);
    }
    // Opacity (including the zoom fade for minor lines) is applied per-frame in
    // update(), so we intentionally do not set it here.
  }

  // Emits a line at every tick of `tickAxis` spanning [spanMin, spanMax]. When
  // tickAlongU is true the tick coordinate is the U value (line runs along V).
  private addLines(
    request: GridGeometryRequest,
    tickAlongU: boolean,
    tickMin: number,
    tickMax: number,
    spanMin: number,
    spanMax: number,
    minorPositions: number[],
    halfPositions: number[],
    majorPositions: number[]
  ): void {
    const { axisU, axisV, minorPitch, majorPitch, drawMinor } = request;
    const start = Math.ceil(tickMin / minorPitch - TICK_EPSILON);
    const end = Math.floor(tickMax / minorPitch + TICK_EPSILON);
    let emitted = 0;
    for (let i = start; i <= end; i += 1) {
      if (emitted >= MAX_LINES_PER_AXIS) {
        break;
      }
      emitted += 1;
      const coord = i * minorPitch;
      const major = isMajorTick(coord, majorPitch);
      if (!major && !drawMinor) {
        continue;
      }
      let target: number[];
      if (major) {
        target = majorPositions;
      } else if (drawMinor && isHalfTick(coord, majorPitch)) {
        target = halfPositions;
      } else {
        target = minorPositions;
      }
      const a = this.scratch;
      if (tickAlongU) {
        setComponent(a, axisU, axisV, coord, spanMin);
        target.push(a[0], a[1], a[2]);
        setComponent(a, axisU, axisV, coord, spanMax);
        target.push(a[0], a[1], a[2]);
      } else {
        setComponent(a, axisU, axisV, spanMin, coord);
        target.push(a[0], a[1], a[2]);
        setComponent(a, axisU, axisV, spanMax, coord);
        target.push(a[0], a[1], a[2]);
      }
    }
  }

  private makeSegments(positions: number[], material: THREE.LineBasicMaterial): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const segments = new THREE.LineSegments(geometry, material);
    segments.frustumCulled = false;
    segments.renderOrder = GRID_RENDER_ORDER;
    return segments;
  }

  private clearSegments(): void {
    for (const segments of [this.minorSegments, this.halfSegments, this.majorSegments]) {
      if (segments) {
        this.root.remove(segments);
        segments.geometry.dispose();
      }
    }
    this.minorSegments = null;
    this.halfSegments = null;
    this.majorSegments = null;
  }
}
