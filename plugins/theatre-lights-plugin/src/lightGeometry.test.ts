import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { aimChildQuaternion, buildBodySegments } from "./lightGeometry";

describe("buildBodySegments", () => {
  it("returns non-empty line-segment pairs", () => {
    const data = buildBodySegments();
    expect(data.length).toBeGreaterThan(0);
    expect(data.length % 6).toBe(0);
  });
});

describe("aimChildQuaternion", () => {
  const origin = new THREE.Vector3(0, 0, 0);
  const identity = new THREE.Quaternion();

  function forwardOf(quat: THREE.Quaternion): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  }

  it("is ~identity when the target is already straight down -Z", () => {
    const quat = aimChildQuaternion(origin, identity, new THREE.Vector3(0, 0, -5));
    expect(quat).not.toBeNull();
    expect(forwardOf(quat!).distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-5);
  });

  it("yaws to face a target on +X (root unrotated)", () => {
    const quat = aimChildQuaternion(origin, identity, new THREE.Vector3(5, 0, 0));
    expect(forwardOf(quat!).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-5);
  });

  it("cancels the root's world rotation so the fixture still points at the target", () => {
    const rootQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.7, -0.2, "XYZ"));
    const target = new THREE.Vector3(3, 1, -2);
    const childQuat = aimChildQuaternion(origin, rootQuat, target);
    expect(childQuat).not.toBeNull();
    const worldChild = rootQuat.clone().multiply(childQuat!);
    const worldForward = new THREE.Vector3(0, 0, -1).applyQuaternion(worldChild);
    const expected = target.clone().normalize();
    expect(worldForward.distanceTo(expected)).toBeLessThan(1e-5);
  });

  it("returns null when the target coincides with the fixture", () => {
    expect(aimChildQuaternion(origin, identity, new THREE.Vector3(0, 0, 0))).toBeNull();
  });
});
