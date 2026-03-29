/**
 * SplatProjection — GPU compute pre-pass that projects 3D covariance to
 * 2D screen-space ellipse parameters, once per splat (not 4× per vertex).
 *
 * Output buffers (vec4 per splat):
 *   ellipseA: (radius1, radius2, cosTheta, sinTheta)
 *   ellipseB: (clipX, clipY, clipZ, clipW)
 *
 * The vertex shader then reads these instead of doing the full matrix math.
 */

import * as THREE from "three";
import { StorageBufferAttribute } from "three/webgpu";
import {
  Fn,
  vec4,
  float,
  uint,
  uniform,
  storage,
  globalId,
  sqrt,
  max,
  min,
  atan,
  cos,
  sin,
  select
} from "three/tsl";
import { MIN_PERSPECTIVE_PROJECTION_DEPTH } from "./projectionDepth";

export class SplatProjection {
  // Output buffers
  readonly ellipseABuffer: StorageBufferAttribute;
  readonly ellipseBBuffer: StorageBufferAttribute;

  // Uniforms (compute shaders don't get built-in camera matrices)
  private readonly uModelView = uniform(new THREE.Matrix4());
  private readonly uProjection = uniform(new THREE.Matrix4());
  private readonly uFocalX = uniform(1.0);
  private readonly uFocalY = uniform(1.0);
  private readonly uCameraNear = uniform(MIN_PERSPECTIVE_PROJECTION_DEPTH);
  private readonly uSizeScale = uniform(1.0);
  private readonly uViewportSize = uniform(new THREE.Vector2(1920, 1080));
  private readonly uIsOrthographic = uniform(0.0);

  // Compute node
  private readonly projectionNode: any;

  // Temp matrix for modelView computation
  private readonly _modelViewMatrix = new THREE.Matrix4();

  constructor(
    positionsBuffer: StorageBufferAttribute,
    covABuffer: StorageBufferAttribute,
    covBBuffer: StorageBufferAttribute,
    count: number,
    chunkIdsBuffer?: StorageBufferAttribute,
    numChunks?: number,
    chunkVisibilityBuffer?: StorageBufferAttribute
  ) {
    // Create output storage buffers
    const ellipseAData = new Float32Array(count * 4);
    const ellipseBData = new Float32Array(count * 4);
    this.ellipseABuffer = new StorageBufferAttribute(ellipseAData, 4);
    this.ellipseBBuffer = new StorageBufferAttribute(ellipseBData, 4);

    // Storage nodes
    const positionsStorage: any = storage(positionsBuffer, "vec4", count).toReadOnly();
    const covAStorage: any = storage(covABuffer, "vec4", count).toReadOnly();
    const covBStorage: any = storage(covBBuffer, "vec4", count).toReadOnly();
    const ellipseAStorage: any = storage(this.ellipseABuffer, "vec4", count);
    const ellipseBStorage: any = storage(this.ellipseBBuffer, "vec4", count);

    // Optional chunk culling
    const hasChunkCulling = !!(chunkIdsBuffer && chunkVisibilityBuffer && numChunks);
    let chunkIdsStorage: any = null;
    let chunkVisibilityStorage: any = null;
    if (hasChunkCulling && chunkIdsBuffer && chunkVisibilityBuffer && numChunks) {
      chunkIdsStorage = storage(chunkIdsBuffer, "uint", count).toReadOnly();
      chunkVisibilityStorage = storage(chunkVisibilityBuffer, "uint", numChunks).toReadOnly();
    }

    // Capture uniforms for closure
    const uMV = this.uModelView;
    const uProj = this.uProjection;
    const uFX = this.uFocalX;
    const uFY = this.uFocalY;
    const uNear = this.uCameraNear;
    const uSS = this.uSizeScale;
    const uVP = this.uViewportSize;
    const uOrtho = this.uIsOrthographic;

    // Compute kernel
    const projectionKernel = Fn(() => {
      const idx: any = globalId.x;

      // Read per-splat data
      const center: any = positionsStorage.element(idx).xyz;
      const covA: any = covAStorage.element(idx).xyz;
      const covB: any = covBStorage.element(idx).xyz;

      // Transform center to view space
      const mv: any = uMV;
      const viewPos: any = mv.mul(vec4(center, 1.0));

      // Cull behind camera
      let shouldCull: any = viewPos.z.greaterThan(float(0.0));

      // Chunk-based frustum culling
      if (hasChunkCulling && chunkIdsStorage && chunkVisibilityStorage) {
        const chunkId: any = chunkIdsStorage.element(idx);
        const chunkVisible: any = chunkVisibilityStorage.element(chunkId);
        const chunkCulled: any = chunkVisible.equal(uint(0));
        shouldCull = shouldCull.or(chunkCulled);
      }

      // 3D covariance components
      const c00: any = covA.x;
      const c01: any = covA.y;
      const c02: any = covA.z;
      const c11: any = covB.x;
      const c12: any = covB.y;
      const c22: any = covB.z;

      // Extract 3x3 rotation from modelViewMatrix (column-major)
      const r00: any = mv.element(0).element(0);
      const r01: any = mv.element(1).element(0);
      const r02: any = mv.element(2).element(0);
      const r10: any = mv.element(0).element(1);
      const r11: any = mv.element(1).element(1);
      const r12: any = mv.element(2).element(1);
      const r20: any = mv.element(0).element(2);
      const r21: any = mv.element(1).element(2);
      const r22: any = mv.element(2).element(2);

      // W * Cov3D (t = W * C, 3x3 * symmetric)
      const t00: any = r00.mul(c00).add(r01.mul(c01)).add(r02.mul(c02));
      const t01: any = r00.mul(c01).add(r01.mul(c11)).add(r02.mul(c12));
      const t02: any = r00.mul(c02).add(r01.mul(c12)).add(r02.mul(c22));
      const t10: any = r10.mul(c00).add(r11.mul(c01)).add(r12.mul(c02));
      const t11_v: any = r10.mul(c01).add(r11.mul(c11)).add(r12.mul(c12));
      const t12: any = r10.mul(c02).add(r11.mul(c12)).add(r12.mul(c22));
      const t20: any = r20.mul(c00).add(r21.mul(c01)).add(r22.mul(c02));
      const t21: any = r20.mul(c01).add(r21.mul(c11)).add(r22.mul(c12));
      const t22_v: any = r20.mul(c02).add(r21.mul(c12)).add(r22.mul(c22));

      // Cov_view = t * W^T (upper triangle)
      const cv00: any = t00.mul(r00).add(t01.mul(r01)).add(t02.mul(r02));
      const cv01: any = t00.mul(r10).add(t01.mul(r11)).add(t02.mul(r12));
      const cv02: any = t00.mul(r20).add(t01.mul(r21)).add(t02.mul(r22));
      const cv11: any = t10.mul(r10).add(t11_v.mul(r11)).add(t12.mul(r12));
      const cv12: any = t10.mul(r20).add(t11_v.mul(r21)).add(t12.mul(r22));
      const cv22: any = t20.mul(r20).add(t21.mul(r21)).add(t22_v.mul(r22));

      // Match the material fallback path: use the real camera near instead of a
      // hidden fixed threshold that behaves like an exaggerated near plane.
      const perspectiveNear: any = max(uNear, float(MIN_PERSPECTIVE_PROJECTION_DEPTH));
      const perspectiveViewZ: any = min(viewPos.z, perspectiveNear.negate());
      const tz: any = perspectiveViewZ.negate();
      const tz2: any = tz.mul(tz);
      const vx: any = viewPos.x;
      const vy: any = viewPos.y;

      const j00: any = uFX.div(tz);
      const j02: any = uFX.mul(vx).div(tz2);
      const j11_jac: any = uFY.div(tz);
      const j12: any = uFY.mul(vy).div(tz2);

      // Cov2D = J * Cov_view * J^T (2x2 symmetric)
      const jc00: any = j00.mul(cv00).add(j02.mul(cv02));
      const jc01: any = j00.mul(cv01).add(j02.mul(cv12));
      const jc02_v: any = j00.mul(cv02).add(j02.mul(cv22));
      const jc11_v: any = j11_jac.mul(cv11).add(j12.mul(cv12));
      const jc12_v: any = j11_jac.mul(cv12).add(j12.mul(cv22));

      // Final 2D cov (with low-pass filter, 0.3 px²)
      const perspectiveS00: any = jc00.mul(j00).add(jc02_v.mul(j02)).add(float(0.3));
      const perspectiveS01: any = jc01.mul(j11_jac).add(jc02_v.mul(j12));
      const perspectiveS11: any = jc11_v.mul(j11_jac).add(jc12_v.mul(j12)).add(float(0.3));

      const orthographicS00: any = cv00.mul(uFX.mul(uFX)).add(float(0.3));
      const orthographicS01: any = cv01.mul(uFX.mul(uFY));
      const orthographicS11: any = cv11.mul(uFY.mul(uFY)).add(float(0.3));

      const isOrthographic: any = uOrtho.greaterThan(float(0.5));
      const s00: any = select(isOrthographic, orthographicS00, perspectiveS00);
      const s01: any = select(isOrthographic, orthographicS01, perspectiveS01);
      const s11: any = select(isOrthographic, orthographicS11, perspectiveS11);

      // Eigendecomposition (closed form)
      const halfSum: any = s00.add(s11).mul(0.5);
      const diff: any = s00.sub(s11);
      const discriminant: any = diff.mul(diff).add(s01.mul(s01).mul(4.0));
      const halfSqrtDisc: any = sqrt(max(discriminant, float(1e-8))).mul(0.5);

      const lambda1: any = max(halfSum.add(halfSqrtDisc), float(0.1));
      const lambda2: any = max(halfSum.sub(halfSqrtDisc), float(0.1));

      // Ellipse radii (sqrt(8)-sigma ≈ 2.828σ, clamped to 1024px)
      const maxStdDev: any = float(Math.sqrt(8));
      const radius1: any = min(sqrt(lambda1).mul(maxStdDev).mul(uSS), float(1024.0));
      const radius2: any = min(sqrt(lambda2).mul(maxStdDev).mul(uSS), float(1024.0));

      // Eigenvector rotation angle
      const theta: any = atan(s01.mul(2.0), diff).mul(0.5);
      const cosT: any = cos(theta);
      const sinT: any = sin(theta);

      // Project center to clip space
      const clipViewZ: any = select(isOrthographic, viewPos.z, perspectiveViewZ);
      const clipPos: any = uProj.mul(vec4(vx, vy, clipViewZ, 1.0));

      // Write outputs — culled splats get radius1=0 as sentinel
      ellipseAStorage.element(idx).assign(
        select(shouldCull, vec4(0, 0, 0, 0), vec4(radius1, radius2, cosT, sinT))
      );
      ellipseBStorage.element(idx).assign(
        select(shouldCull, vec4(0, 0, 0, 0), clipPos)
      );
    });

    this.projectionNode = projectionKernel().compute(count);
  }

  updateUniforms(
    camera: THREE.Camera,
    meshWorldMatrix: THREE.Matrix4,
    focalX: number,
    focalY: number,
    isOrthographic: boolean,
    cameraNear: number,
    sizeScale: number,
    viewportSize: THREE.Vector2
  ): void {
    // modelView = camera.matrixWorldInverse * meshWorldMatrix
    this._modelViewMatrix.multiplyMatrices(
      camera.matrixWorldInverse,
      meshWorldMatrix
    );
    (this.uModelView as any).value.copy(this._modelViewMatrix);
    (this.uProjection as any).value.copy(camera.projectionMatrix);
    (this.uFocalX as any).value = focalX;
    (this.uFocalY as any).value = focalY;
    (this.uCameraNear as any).value = cameraNear;
    (this.uIsOrthographic as any).value = isOrthographic ? 1 : 0;
    (this.uSizeScale as any).value = sizeScale;
    (this.uViewportSize as any).value.copy(viewportSize);
  }

  dispatch(renderer: any): void {
    renderer.compute(this.projectionNode);
  }

  dispose(): void {
    // Storage buffer attributes will be GC'd when references are dropped
  }
}
