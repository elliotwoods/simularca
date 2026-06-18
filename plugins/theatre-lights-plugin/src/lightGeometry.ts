// THREE-side construction for the Source Four fixture: a root Group the host transforms,
// an "aim" child carrying the body + beam wireframes (so look-at can re-orient the
// fixture independently of the user's manual transform), and helpers to rebuild/dispose.

import * as THREE from "three";
import { buildBeamSegments, type BeamParams } from "./source4Optics";

export const AIM_NAME = "source4-aim";
export const BODY_NAME = "source4-body";
export const BEAM_NAME = "source4-beam";

const UP = new THREE.Vector3(0, 1, 0);

export interface LightUserData {
  beamSig: string;
  frame: number;
  lastStatusKey: string;
}

function lineMaterial(hex: string, opacity: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: new THREE.Color(hex),
    transparent: true,
    opacity,
    depthWrite: false
  });
}

function setSegments(line: THREE.LineSegments, data: Float32Array): void {
  line.geometry.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data, 3));
  line.geometry = geometry;
}

function push(out: number[], ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  out.push(ax, ay, az, bx, by, bz);
}

function ring(out: number[], z: number, radius: number, segments: number): void {
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    push(
      out,
      radius * Math.cos(a),
      radius * Math.sin(a),
      z,
      radius * Math.cos(b),
      radius * Math.sin(b),
      z
    );
  }
}

function boxEdges(
  out: number[],
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number
): void {
  const xs = [cx - hx, cx + hx];
  const ys = [cy - hy, cy + hy];
  const zs = [cz - hz, cz + hz];
  const c = (i: number, j: number, k: number): [number, number, number] => [xs[i]!, ys[j]!, zs[k]!];
  const edges: Array<[[number, number, number], [number, number, number]]> = [];
  for (let j = 0; j < 2; j += 1) {
    for (let k = 0; k < 2; k += 1) {
      edges.push([c(0, j, k), c(1, j, k)]);
    }
  }
  for (let i = 0; i < 2; i += 1) {
    for (let k = 0; k < 2; k += 1) {
      edges.push([c(i, 0, k), c(i, 1, k)]);
    }
  }
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      edges.push([c(i, j, 0), c(i, j, 1)]);
    }
  }
  for (const [a, b] of edges) {
    push(out, a[0], a[1], a[2], b[0], b[1], b[2]);
  }
}

/**
 * Simplified Source Four silhouette, lens at the origin, body extending toward +Z (the
 * lamp end) so the beam reads out the -Z (lens) side. Includes a yoke and a mounting
 * point at the top. ~50 segments.
 */
export function buildBodySegments(): Float32Array {
  const out: number[] = [];
  const barrelR = 0.1;
  const lensZ = 0;
  const barrelBackZ = 0.3;

  // Barrel: lens ring, back ring, longitudinal connectors (octagonal).
  ring(out, lensZ, barrelR, 8);
  ring(out, barrelBackZ, barrelR, 8);
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    push(out, barrelR * Math.cos(a), barrelR * Math.sin(a), lensZ, barrelR * Math.cos(a), barrelR * Math.sin(a), barrelBackZ);
  }

  // Lamp housing ("bean can") at the back.
  boxEdges(out, 0, 0, 0.42, 0.13, 0.13, 0.12);

  // Yoke (U bracket) in a plane just below the barrel centre.
  const yokeZ = 0.16;
  const armBottomY = -0.02;
  const armTopY = 0.3;
  const armX = 0.16;
  push(out, -barrelR, armBottomY, yokeZ, -armX, armTopY, yokeZ); // left arm
  push(out, barrelR, armBottomY, yokeZ, armX, armTopY, yokeZ); // right arm
  push(out, -armX, armTopY, yokeZ, armX, armTopY, yokeZ); // top bar

  // Mounting point: a stub up to a small clamp block at the top centre.
  push(out, 0, armTopY, yokeZ, 0, armTopY + 0.1, yokeZ);
  boxEdges(out, 0, armTopY + 0.15, yokeZ, 0.045, 0.05, 0.05);

  return new Float32Array(out);
}

export interface LightObjectRefs {
  root: THREE.Group;
  aim: THREE.Group;
  body: THREE.LineSegments;
  beam: THREE.LineSegments;
}

export function createLightObject(bodyHex: string, beamHex: string, beamOpacity: number): THREE.Group {
  const root = new THREE.Group();
  root.name = "source4-fixture";

  const aim = new THREE.Group();
  aim.name = AIM_NAME;
  root.add(aim);

  const body = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial(bodyHex, 0.95));
  body.name = BODY_NAME;
  body.frustumCulled = false;
  setSegments(body, buildBodySegments());
  aim.add(body);

  const beam = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial(beamHex, beamOpacity));
  beam.name = BEAM_NAME;
  beam.frustumCulled = false;
  aim.add(beam);

  const userData: LightUserData = { beamSig: "", frame: 0, lastStatusKey: "" };
  root.userData.source4 = userData;
  return root;
}

export function resolveRefs(object: unknown): LightObjectRefs | null {
  if (!(object instanceof THREE.Group)) {
    return null;
  }
  const aim = object.getObjectByName(AIM_NAME);
  const body = object.getObjectByName(BODY_NAME);
  const beam = object.getObjectByName(BEAM_NAME);
  if (aim instanceof THREE.Group && body instanceof THREE.LineSegments && beam instanceof THREE.LineSegments) {
    return { root: object, aim, body, beam };
  }
  return null;
}

export function getUserData(root: THREE.Group): LightUserData {
  const existing = root.userData.source4 as LightUserData | undefined;
  if (existing) {
    return existing;
  }
  const created: LightUserData = { beamSig: "", frame: 0, lastStatusKey: "" };
  root.userData.source4 = created;
  return created;
}

export function rebuildBeamGeometry(beam: THREE.LineSegments, params: BeamParams): void {
  setSegments(beam, buildBeamSegments(params));
}

export function applyBeamAppearance(beam: THREE.LineSegments, hex: string, opacity: number): void {
  const material = beam.material as THREE.LineBasicMaterial;
  material.color.set(hex);
  material.opacity = opacity;
}

export function applyBodyAppearance(body: THREE.LineSegments, hex: string): void {
  (body.material as THREE.LineBasicMaterial).color.set(hex);
}

/**
 * Local quaternion for the aim child so the fixture's local -Z points at the target in
 * world space, cancelling the root's world rotation. Returns null when target ≈ origin.
 */
export function aimChildQuaternion(
  rootWorldPos: THREE.Vector3,
  rootWorldQuat: THREE.Quaternion,
  targetWorldPos: THREE.Vector3
): THREE.Quaternion | null {
  if (targetWorldPos.distanceToSquared(rootWorldPos) < 1e-8) {
    return null;
  }
  const lookMatrix = new THREE.Matrix4().lookAt(rootWorldPos, targetWorldPos, UP);
  const worldAim = new THREE.Quaternion().setFromRotationMatrix(lookMatrix);
  return rootWorldQuat.clone().invert().multiply(worldAim);
}

export function disposeLightObject(object: unknown): void {
  if (!(object instanceof THREE.Object3D)) {
    return;
  }
  object.traverse((node) => {
    const line = node as Partial<THREE.LineSegments>;
    line.geometry?.dispose?.();
    const material = line.material;
    if (Array.isArray(material)) {
      for (const entry of material) {
        entry.dispose();
      }
    } else {
      material?.dispose?.();
    }
  });
}
