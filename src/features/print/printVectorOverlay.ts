import * as THREE from "three";
import type { ActorNode, AppState } from "@/core/types";
import type { PaperPoint, WorldToPaperProjector } from "@/features/camera/viewUtils";
import { computeDimensionWorldGeometry, resolveLandmarkWorld } from "@/features/dimensions/geometry";
import { formatDistanceMeters, readLandmark } from "@/features/dimensions/model";
import { CURVE_RENDER_LINE_NAME } from "@/render/sceneController";

/** A projected, paper-pixel point. */
export interface OverlayPoint {
  x: number;
  y: number;
}

/** A projected curve polyline (already split where it crosses behind the camera). */
export interface PrintOverlayCurve {
  points: OverlayPoint[];
  color: string;
}

/** A projected dimension or annotation, in paper pixels. */
export interface PrintOverlayDimension {
  kind: "measure" | "annotation";
  /** Measure: extension feet A→m1, B→m2 + span m1→m2 (broken around the label). */
  A: OverlayPoint;
  B: OverlayPoint;
  m1: OverlayPoint;
  m2: OverlayPoint;
  /** Label anchor in paper pixels (measure: span midpoint; annotation: note position). */
  labelPos: OverlayPoint;
  text: string;
  lineColor: string;
  textColor: string;
  fontPx: number;
  /** Annotation only: draw a leader line from A (anchor) to labelPos. */
  leader: boolean;
}

export interface PrintVectorOverlay {
  curves: PrintOverlayCurve[];
  dimensions: PrintOverlayDimension[];
}

/** On-screen default colours for curve lines (matches the editor materials). */
const CURVE_LINE_COLOR = "#78ffcb";
const DIMENSION_LINE_COLOR = "#ffcc33";
const ANNOTATION_TEXT_COLOR = "#ffffff";

interface SceneObjectSource {
  getActorObject(actorId: string): THREE.Object3D | null;
}

/** Visible for export purposes: enabled and unconditionally shown (not "selected only"). */
function isPrintableActor(actor: ActorNode): boolean {
  return actor.enabled !== false && (actor.visibilityMode ?? "visible") === "visible";
}

function hexParam(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Map a dimension's editor-pixel text size to a paper-pixel font size. The
 * editor size is relative to a live viewport, so scale it to the paper's short
 * edge (keeping the default 14px ≈ a legible label) rather than printing a few
 * pixels tall on a multi-thousand-pixel page.
 */
function paperFontPx(textSizePx: number, width: number, height: number): number {
  const size = Number.isFinite(textSizePx) ? textSizePx : 14;
  const base = Math.min(width, height) * 0.012;
  return Math.max(12, Math.round(base * (size / 14)));
}

/**
 * Read a THREE line's vertices, transform to world space, project to paper, and
 * split into sub-polylines wherever a vertex falls behind the camera. For
 * `LineSegments` each vertex pair is an independent segment.
 */
function projectLineObject(line: THREE.Line, project: WorldToPaperProjector): OverlayPoint[][] {
  const position = line.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position || position.count < 2) {
    return [];
  }
  line.updateWorldMatrix(true, false);
  const matrix = line.matrixWorld;
  const isSegments = line instanceof THREE.LineSegments;
  const vertex = new THREE.Vector3();
  const polylines: OverlayPoint[][] = [];
  let current: OverlayPoint[] = [];

  const flush = (): void => {
    if (current.length >= 2) {
      polylines.push(current);
    }
    current = [];
  };

  for (let i = 0; i < position.count; i += 1) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
    const projected = project(vertex);
    if (projected.behind) {
      flush();
      if (isSegments) {
        // Skip the partner vertex of this segment too.
        i += i % 2 === 0 ? 1 : 0;
      }
      continue;
    }
    current.push({ x: projected.x, y: projected.y });
    // LineSegments: vertices come in pairs; close each pair as its own polyline.
    if (isSegments && i % 2 === 1) {
      flush();
    }
  }
  flush();
  return polylines;
}

/** Find the curve render line child (plain line or projected segments) of a curve actor group. */
function findCurveLine(object: THREE.Object3D): THREE.Line | null {
  const child = object.getObjectByName(CURVE_RENDER_LINE_NAME);
  return child instanceof THREE.Line ? child : null;
}

/**
 * Project all visible curve and dimension actors to paper-pixel vector
 * primitives for the print compositor. `project` must use the same camera the
 * offscreen frame was rendered with so the vectors align with the raster scene.
 */
export function buildPrintVectorOverlay(args: {
  state: AppState;
  scene: SceneObjectSource;
  project: WorldToPaperProjector;
  width: number;
  height: number;
}): PrintVectorOverlay {
  const { state, scene, project, width, height } = args;
  const resolveObject = (actorId: string): THREE.Object3D | null => scene.getActorObject(actorId);

  const curves: PrintOverlayCurve[] = [];
  const dimensions: PrintOverlayDimension[] = [];

  for (const actor of Object.values(state.actors)) {
    if (!isPrintableActor(actor)) {
      continue;
    }

    if (actor.actorType === "curve") {
      const object = scene.getActorObject(actor.id);
      const line = object instanceof THREE.Object3D ? findCurveLine(object) : null;
      if (!line) {
        continue;
      }
      for (const points of projectLineObject(line, project)) {
        curves.push({ points, color: CURVE_LINE_COLOR });
      }
      continue;
    }

    if (actor.actorType === "dimension") {
      const geom = computeDimensionWorldGeometry(actor, resolveObject);
      if (!geom) {
        continue;
      }
      const A = project(geom.A);
      const B = project(geom.B);
      const m1 = project(geom.m1);
      const m2 = project(geom.m2);
      const labelPos = project(geom.labelPos);
      if (anyBehind(A, B, m1, m2)) {
        continue;
      }
      const units = typeof actor.params.units === "string" ? actor.params.units : "m";
      const decimals = Number.isFinite(Number(actor.params.decimals)) ? Number(actor.params.decimals) : 2;
      const showValue = actor.params.showValue !== false;
      dimensions.push({
        kind: "measure",
        A: toPoint(A),
        B: toPoint(B),
        m1: toPoint(m1),
        m2: toPoint(m2),
        labelPos: toPoint(labelPos),
        text: showValue ? formatDistanceMeters(geom.distance, units, decimals) : "",
        lineColor: hexParam(actor.params.lineColor, DIMENSION_LINE_COLOR),
        textColor: hexParam(actor.params.textColor, ANNOTATION_TEXT_COLOR),
        fontPx: paperFontPx(Number(actor.params.textSizePx), width, height),
        leader: false
      });
      continue;
    }

    if (actor.actorType === "annotation") {
      const anchorWorld = resolveLandmarkWorld(readLandmark(actor.params.anchor), resolveObject);
      if (!anchorWorld) {
        continue;
      }
      const anchor = project(anchorWorld);
      if (anchor.behind) {
        continue;
      }
      const fontPx = paperFontPx(Number(actor.params.textSizePx), width, height);
      // Offset the note above the anchor in paper space (the live overlay offsets
      // by ~2× the text height along screen-up).
      const labelPos: OverlayPoint = { x: anchor.x, y: anchor.y - fontPx * 2 };
      dimensions.push({
        kind: "annotation",
        A: toPoint(anchor),
        B: toPoint(anchor),
        m1: toPoint(anchor),
        m2: toPoint(anchor),
        labelPos,
        text: typeof actor.params.text === "string" ? actor.params.text : "Note",
        lineColor: hexParam(actor.params.textColor, ANNOTATION_TEXT_COLOR),
        textColor: hexParam(actor.params.textColor, ANNOTATION_TEXT_COLOR),
        fontPx,
        leader: actor.params.leader !== false
      });
    }
  }

  return { curves, dimensions };
}

function toPoint(p: PaperPoint): OverlayPoint {
  return { x: p.x, y: p.y };
}

function anyBehind(...points: PaperPoint[]): boolean {
  return points.some((p) => p.behind);
}
