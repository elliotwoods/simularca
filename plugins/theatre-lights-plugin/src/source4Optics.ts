// Pure optics + beam-outline geometry for the Source Four fixture.
// No THREE imports here so this is trivially unit-testable. The beam is authored down
// local -Z (apex at the origin, field plane at z = -throwDistance) so the host's
// look-at semantics (local -Z points at the target) line up with the geometry.

import { getLampSpec, getLensSpec, getZoomBarrel } from "./source4Data";

export type LensMode = "fixed" | "zoom";

export interface BeamParams {
  lensMode: LensMode;
  lensTube: string;
  zoomBarrel: string;
  zoomAngleDeg: number;
  throwDistance: number;
  /** Visual length the beam cone is drawn to — independent of throw/focus. */
  previewLength: number;
  edgeQuality: number;
  shutterTop: number;
  shutterBottom: number;
  shutterLeft: number;
  shutterRight: number;
}

const DEG_TO_RAD = Math.PI / 180;
const FALLBACK_FIELD_ANGLE_DEG = 26;
const BOUNDARY_SAMPLES = 48;
const RAY_COUNT = 8;

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/** Effective field angle (degrees). Zoom angle is clamped to the selected barrel range. */
export function resolveFieldAngleDeg(p: Pick<BeamParams, "lensMode" | "lensTube" | "zoomBarrel" | "zoomAngleDeg">): number {
  if (p.lensMode === "zoom") {
    const barrel = getZoomBarrel(p.zoomBarrel);
    if (barrel) {
      return clamp(p.zoomAngleDeg, barrel.minDeg, barrel.maxDeg);
    }
    return clamp(p.zoomAngleDeg, 15, 50);
  }
  const lens = getLensSpec(p.lensTube);
  return lens ? lens.angleDeg : FALLBACK_FIELD_ANGLE_DEG;
}

/** Circular field radius (metres) a fixture of the given field angle casts at `dist`. */
export function beamRadiusAtDistance(fieldAngleDeg: number, dist: number): number {
  const half = clamp(fieldAngleDeg, 0, 179) * 0.5 * DEG_TO_RAD;
  return Math.max(0, dist) * Math.tan(half);
}

/** Field diameter (metres) at the throw plane: 2 * throw * tan(angle/2). */
export function fieldDiameterAtThrow(fieldAngleDeg: number, throwM: number): number {
  return 2 * beamRadiusAtDistance(fieldAngleDeg, throwM);
}

/** Reported output in lumens, scaled by the dimmer (0-100). */
export function effectiveOutputLumens(lampId: string, dimming: number): number {
  const lamp = getLampSpec(lampId);
  if (!lamp) {
    return 0;
  }
  return Math.round(lamp.lumens * (clamp(dimming, 0, 100) / 100));
}

export interface GelResolution {
  hex: string | null;
  approximate: boolean;
  label: string;
}

export function resolveGelHex(gelMode: string, gelPreset: string, gelCustomColor: string): GelResolution {
  if (gelMode === "custom") {
    return { hex: gelCustomColor || "#ffffff", approximate: false, label: gelCustomColor || "#ffffff" };
  }
  if (gelMode === "preset") {
    // Resolved against source4Data in the caller for label richness; here keep it light.
    return { hex: null, approximate: true, label: gelPreset };
  }
  return { hex: null, approximate: false, label: "None" };
}

interface ClipBounds {
  xLeft: number;
  xRight: number;
  yBot: number;
  yTop: number;
  collapsed: boolean;
}

/** Convert the four shutter insertions (0-100 %) into rectangular clip bounds in metres. */
function shutterBounds(p: BeamParams, R: number): ClipBounds {
  const yTop = R * (1 - 2 * clamp(p.shutterTop, 0, 100) / 100);
  const yBot = R * (2 * clamp(p.shutterBottom, 0, 100) / 100 - 1);
  const xRight = R * (1 - 2 * clamp(p.shutterRight, 0, 100) / 100);
  const xLeft = R * (2 * clamp(p.shutterLeft, 0, 100) / 100 - 1);
  const collapsed = xLeft > xRight || yBot > yTop;
  return { xLeft, xRight, yBot, yTop, collapsed };
}

/** One shutter-clipped boundary point on a circle of radius `radius` at angle `theta`. */
function clippedBoundaryPoint(theta: number, radius: number, bounds: ClipBounds): [number, number] {
  const px = clamp(radius * Math.cos(theta), bounds.xLeft, bounds.xRight);
  const py = clamp(radius * Math.sin(theta), bounds.yBot, bounds.yTop);
  return [px, py];
}

function pushSegment(out: number[], ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  out.push(ax, ay, az, bx, by, bz);
}

function pushLoop(out: number[], radius: number, z: number, bounds: ClipBounds): void {
  let prev = clippedBoundaryPoint(0, radius, bounds);
  const first = prev;
  for (let i = 1; i <= BOUNDARY_SAMPLES; i += 1) {
    const theta = (i / BOUNDARY_SAMPLES) * Math.PI * 2;
    const next = i === BOUNDARY_SAMPLES ? first : clippedBoundaryPoint(theta, radius, bounds);
    pushSegment(out, prev[0], prev[1], z, next[0], next[1], z);
    prev = next;
  }
}

/**
 * Build the beam-outline as LineSegments vertex pairs (flat Float32Array, 6 floats per
 * segment). Apex at the origin; field plane at z = -previewLength (the visual cone reach,
 * decoupled from throw/focus). Returns an empty array when the shutters fully close the
 * field or the beam is degenerate.
 */
export function buildBeamSegments(p: BeamParams): Float32Array {
  const fieldAngleDeg = resolveFieldAngleDeg(p);
  const lengthM = Math.max(0, p.previewLength);
  const R = beamRadiusAtDistance(fieldAngleDeg, lengthM);
  if (R <= 1e-4 || lengthM <= 1e-4) {
    return new Float32Array(0);
  }
  const z = -lengthM;
  const bounds = shutterBounds(p, R);
  if (bounds.collapsed) {
    return new Float32Array(0);
  }

  const out: number[] = [];

  // Outer boundary loop at the throw plane.
  pushLoop(out, R, z, bounds);

  // Rays from the lens (apex) to evenly spaced boundary points.
  for (let i = 0; i < RAY_COUNT; i += 1) {
    const theta = (i / RAY_COUNT) * Math.PI * 2;
    const [px, py] = clippedBoundaryPoint(theta, R, bounds);
    pushSegment(out, 0, 0, 0, px, py, z);
  }

  // Soft edge: a second (penumbra) loop just inside the outer one.
  const edge = clamp(p.edgeQuality, 0, 1);
  if (edge > 0.01) {
    const innerRadius = R * (1 - 0.12 * edge);
    pushLoop(out, innerRadius, z, bounds);
  }

  return new Float32Array(out);
}

export type Vec3 = [number, number, number];

/** A world-space beam cone (what the fixture publishes for illuminating actors). */
export interface BeamCone {
  position: Vec3;
  direction: Vec3; // unit vector along the beam axis
  cosHalfAngle: number;
  range: number;
}

/**
 * True if a world point lies inside the beam cone (within the half-angle and range).
 * Mirrors the per-splat cone test used by the gaussian-splat shader so behaviour matches.
 */
export function pointInBeamCone(point: Vec3, cone: BeamCone): boolean {
  const dx = point[0] - cone.position[0];
  const dy = point[1] - cone.position[1];
  const dz = point[2] - cone.position[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist <= 1e-6 || dist > cone.range) {
    return false;
  }
  const cosA = (dx * cone.direction[0] + dy * cone.direction[1] + dz * cone.direction[2]) / dist;
  return cosA >= cone.cosHalfAngle;
}
