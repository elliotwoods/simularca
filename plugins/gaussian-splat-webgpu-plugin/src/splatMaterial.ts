/**
 * NodeMaterial for gaussian splat rendering using Three.js TSL.
 *
 * Vertex shader: projects 3D covariance to 2D screen-space ellipse,
 * positions quad vertices to cover the ellipse.
 *
 * Fragment shader: evaluates 2D gaussian falloff with alpha blending.
 *
 * NOTE: TSL node types use `any` throughout for shader node operations,
 * matching the pattern from tonemapping.ts — the TSL type definitions
 * are too strict for complex shader math involving matrix element access.
 */

import * as THREE from "three";
import { NodeMaterial, StorageBufferAttribute } from "three/webgpu";
import {
  Fn,
  vec2,
  vec3,
  vec4,
  float,
  uint,
  uniform,
  storage,
  instanceIndex,
  positionGeometry,
  cameraProjectionMatrix,
  modelViewMatrix,
  varyingProperty,
  sqrt,
  max,
  min,
  atan,
  cos,
  sin,
  exp,
  select
} from "three/tsl";

/**
 * Storage buffer data needed by the material.
 */
export interface SplatBuffers {
  positions: StorageBufferAttribute;
  covA: StorageBufferAttribute; // [c00, c01, c02] per splat
  covB: StorageBufferAttribute; // [c11, c12, c22] per splat
  colors: StorageBufferAttribute; // [r, g, b, opacity] per splat
  sortedIndices: StorageBufferAttribute;
  // Optional: chunk-based frustum culling buffers
  chunkIds?: StorageBufferAttribute;        // uint per splat → chunk index
  chunkVisibility?: StorageBufferAttribute; // uint per chunk → 1 visible, 0 culled
}

/**
 * Uniforms exposed for runtime parameter updates.
 */
export interface SplatUniforms {
  opacity: { value: number };
  brightness: { value: number };
  viewportSize: { value: THREE.Vector2 };
  focalX: { value: number };
  focalY: { value: number };
  sizeScale: { value: number };
}

export interface SplatMaterialResult {
  material: NodeMaterial;
  uniforms: SplatUniforms;
}

export function createSplatMaterial(
  buffers: SplatBuffers,
  count: number,
  paddedCount?: number,
  numChunks?: number
): SplatMaterialResult {
  const uOpacity = uniform(1.0);
  const uBrightness = uniform(1.0);
  const uViewportSize = uniform(new THREE.Vector2(1920, 1080));
  const uFocalX = uniform(1.0);
  const uFocalY = uniform(1.0);
  const uSizeScale = uniform(1.0);

  // Storage buffer nodes (vec4 to match WGSL array alignment — xyz used, w=0 padding)
  const positionsStorage: any = storage(buffers.positions, "vec4", count);
  const covAStorage: any = storage(buffers.covA, "vec4", count);
  const covBStorage: any = storage(buffers.covB, "vec4", count);
  const colorsStorage: any = storage(buffers.colors, "vec4", count);
  // sortedIndices may be padded to power-of-2 for GPU bitonic sort
  const indicesCount = paddedCount ?? count;
  const sortedIndicesStorage: any = storage(buffers.sortedIndices, "uint", indicesCount);

  // Optional: chunk visibility storage nodes for frustum culling
  const hasChunkCulling = !!(buffers.chunkIds && buffers.chunkVisibility && numChunks);
  let chunkIdsStorage: any = null;
  let chunkVisibilityStorage: any = null;
  if (hasChunkCulling && buffers.chunkIds && buffers.chunkVisibility && numChunks) {
    chunkIdsStorage = storage(buffers.chunkIds, "uint", count);
    chunkVisibilityStorage = storage(buffers.chunkVisibility, "uint", numChunks);
  }

  // Varyings to pass from vertex to fragment shader
  const vColor: any = varyingProperty("vec3", "vSplatColor");
  const vOpacity: any = varyingProperty("float", "vSplatOpacity");
  const vQuadUV: any = varyingProperty("vec2", "vQuadUV");
  const vValid: any = varyingProperty("float", "vValid");

  // Vertex shader
  const vertexNode = Fn(() => {
    // Look up the actual splat index via sort indirection
    const splatIdx: any = sortedIndicesStorage.element(instanceIndex);

    // Read per-splat data (extract xyz from vec4 storage)
    const center: any = positionsStorage.element(splatIdx).xyz.toVar("center");
    const covA: any = covAStorage.element(splatIdx).xyz.toVar("covA");
    const covB: any = covBStorage.element(splatIdx).xyz.toVar("covB");
    const colorData: any = colorsStorage.element(splatIdx).toVar("colorData");

    // Transform center to view space
    const mv: any = modelViewMatrix;
    const viewPos: any = mv.mul(vec4(center, 1.0)).toVar("viewPos");

    // Cull splats behind camera (initial check — merged with frustum cull below)
    const behindCamera: any = viewPos.z.greaterThan(float(0.0));

    // Chunk-based frustum culling: if the splat's chunk is not visible, cull it
    let shouldCull: any = behindCamera;
    if (hasChunkCulling && chunkIdsStorage && chunkVisibilityStorage) {
      const chunkId: any = chunkIdsStorage.element(splatIdx);
      const chunkVisible: any = chunkVisibilityStorage.element(chunkId);
      const chunkCulled: any = chunkVisible.equal(uint(0));
      shouldCull = behindCamera.or(chunkCulled);
    }
    vValid.assign(select(shouldCull, float(0.0), float(1.0)));

    // 3D covariance components
    const c00: any = covA.x;
    const c01: any = covA.y;
    const c02: any = covA.z;
    const c11: any = covB.x;
    const c12: any = covB.y;
    const c22: any = covB.z;

    // Extract 3x3 rotation from modelViewMatrix
    // modelViewMatrix is view * model (column-major in Three.js)
    const r00: any = mv.element(0).element(0);
    const r01: any = mv.element(1).element(0);
    const r02: any = mv.element(2).element(0);
    const r10: any = mv.element(0).element(1);
    const r11: any = mv.element(1).element(1);
    const r12: any = mv.element(2).element(1);
    const r20: any = mv.element(0).element(2);
    const r21: any = mv.element(1).element(2);
    const r22: any = mv.element(2).element(2);

    // Compute W * Cov3D (t = W * C, 3x3 * symmetric)
    const t00: any = r00.mul(c00).add(r01.mul(c01)).add(r02.mul(c02));
    const t01: any = r00.mul(c01).add(r01.mul(c11)).add(r02.mul(c12));
    const t02: any = r00.mul(c02).add(r01.mul(c12)).add(r02.mul(c22));
    const t10: any = r10.mul(c00).add(r11.mul(c01)).add(r12.mul(c02));
    const t11_v: any = r10.mul(c01).add(r11.mul(c11)).add(r12.mul(c12));
    const t12: any = r10.mul(c02).add(r11.mul(c12)).add(r12.mul(c22));
    const t20: any = r20.mul(c00).add(r21.mul(c01)).add(r22.mul(c02));
    const t21: any = r20.mul(c01).add(r21.mul(c11)).add(r22.mul(c12));
    const t22_v: any = r20.mul(c02).add(r21.mul(c12)).add(r22.mul(c22));

    // Cov_view = t * W^T (only upper triangle)
    const cv00: any = t00.mul(r00).add(t01.mul(r01)).add(t02.mul(r02));
    const cv01: any = t00.mul(r10).add(t01.mul(r11)).add(t02.mul(r12));
    const cv02: any = t00.mul(r20).add(t01.mul(r21)).add(t02.mul(r22));
    const cv11: any = t10.mul(r10).add(t11_v.mul(r11)).add(t12.mul(r12));
    const cv12: any = t10.mul(r20).add(t11_v.mul(r21)).add(t12.mul(r22));
    const cv22: any = t20.mul(r20).add(t21.mul(r21)).add(t22_v.mul(r22));

    // Perspective projection Jacobian
    // Clamp tz to prevent blow-up when camera is very close to a splat
    const tz: any = max(viewPos.z.negate(), float(0.2)); // positive depth, min 0.2
    const tz2: any = tz.mul(tz);
    const vx: any = viewPos.x;
    const vy: any = viewPos.y;

    const j00: any = uFocalX.div(tz);
    const j02: any = uFocalX.mul(vx).div(tz2);
    const j11_jac: any = uFocalY.div(tz);
    const j12: any = uFocalY.mul(vy).div(tz2);

    // Cov2D = J * Cov_view * J^T (2x2 symmetric)
    const jc00: any = j00.mul(cv00).add(j02.mul(cv02));
    const jc01: any = j00.mul(cv01).add(j02.mul(cv12));
    const jc02_v: any = j00.mul(cv02).add(j02.mul(cv22));
    const jc11_v: any = j11_jac.mul(cv11).add(j12.mul(cv12));
    const jc12_v: any = j11_jac.mul(cv12).add(j12.mul(cv22));

    // Final 2D cov (with low-pass filter for stability, 0.3 px²)
    const s00: any = jc00.mul(j00).add(jc02_v.mul(j02)).add(float(0.3));
    const s01: any = jc01.mul(j11_jac).add(jc02_v.mul(j12));
    const s11: any = jc11_v.mul(j11_jac).add(jc12_v.mul(j12)).add(float(0.3));

    // Eigendecomposition of 2x2 symmetric matrix (closed form)
    const halfSum: any = s00.add(s11).mul(0.5);
    const diff: any = s00.sub(s11);
    const discriminant: any = diff.mul(diff).add(s01.mul(s01).mul(4.0));
    const halfSqrtDisc: any = sqrt(max(discriminant, float(1e-8))).mul(0.5);

    const lambda1: any = max(halfSum.add(halfSqrtDisc), float(0.1));
    const lambda2: any = max(halfSum.sub(halfSqrtDisc), float(0.1));

    // Ellipse radii: sqrt(8)-sigma ≈ 2.828σ matching Spark's maxStdDev.
    // Clamped to 1024px to prevent screen-filling quads.
    // uSizeScale allows interactive testing of splat sizes.
    const maxStdDev: any = float(Math.sqrt(8));
    const radius1: any = min(sqrt(lambda1).mul(maxStdDev).mul(uSizeScale), float(1024.0));
    const radius2: any = min(sqrt(lambda2).mul(maxStdDev).mul(uSizeScale), float(1024.0));

    // Eigenvector rotation angle (atan with 2 args = atan2)
    const theta: any = atan(s01.mul(2.0), diff).mul(0.5);
    const cosT: any = cos(theta);
    const sinT: any = sin(theta);

    // Scale and rotate the quad vertex
    const quadPos: any = positionGeometry.xy; // [-1..1]
    const scaled: any = vec2(quadPos.x.mul(radius1), quadPos.y.mul(radius2));
    const rotated: any = vec2(
      scaled.x.mul(cosT).sub(scaled.y.mul(sinT)),
      scaled.x.mul(sinT).add(scaled.y.mul(cosT))
    );

    // Project center to clip space
    const clipPos: any = cameraProjectionMatrix.mul(viewPos).toVar("clipPos");

    // Convert pixel offset to NDC offset
    const ndcOffset: any = vec2(
      rotated.x.div(uViewportSize.x.mul(0.5)),
      rotated.y.div(uViewportSize.y.mul(0.5))
    );

    // NOTE: NDC clip test removed — it had a per-vertex vs per-splat
    // inconsistency (ndcOffset varies per quad vertex, causing vValid varying
    // interpolation artifacts at screen edges). Chunk-based frustum culling
    // handles off-screen culling at a coarser (and correct) level.

    // Pass varyings to fragment
    vColor.assign(vec3(colorData.x, colorData.y, colorData.z).mul(uBrightness));
    vOpacity.assign(colorData.w.mul(uOpacity));
    vQuadUV.assign(quadPos);

    // Final clip position with ellipse offset
    return vec4(
      clipPos.x.add(ndcOffset.x.mul(clipPos.w)),
      clipPos.y.add(ndcOffset.y.mul(clipPos.w)),
      clipPos.z,
      clipPos.w
    );
  })();

  // Fragment shader
  const fragmentNode = Fn(() => {
    // Discard invalid (behind camera) splats
    vValid.lessThan(float(0.5)).discard();

    const uv: any = vQuadUV;
    const distSq: any = uv.x.mul(uv.x).add(uv.y.mul(uv.y));

    // Discard fragments outside 3-sigma ellipse
    distSq.greaterThan(float(1.0)).discard();

    // Gaussian falloff: the quad spans sqrt(8) sigma, so distSq=1 corresponds to sqrt(8) sigma
    // alpha = exp(-0.5 * (sqrt(8)*r)^2) = exp(-4.0 * distSq)  (matches Spark)
    const gaussAlpha: any = (exp as any)(float(-4.0).mul(distSq));
    const finalAlpha: any = gaussAlpha.mul(vOpacity);

    // Discard nearly transparent fragments (0.5/255 ≈ 0.002, matches Spark)
    finalAlpha.lessThan(float(1.0 / 255.0 / 2.0)).discard();

    return vec4(vColor.x, vColor.y, vColor.z, finalAlpha);
  })();

  // Build the NodeMaterial
  const material = new NodeMaterial();
  material.vertexNode = vertexNode;
  material.colorNode = fragmentNode;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.blending = THREE.NormalBlending;
  material.side = THREE.DoubleSide;

  return {
    material,
    uniforms: {
      opacity: uOpacity as unknown as { value: number },
      brightness: uBrightness as unknown as { value: number },
      viewportSize: uViewportSize as unknown as { value: THREE.Vector2 },
      focalX: uFocalX as unknown as { value: number },
      focalY: uFocalY as unknown as { value: number },
      sizeScale: uSizeScale as unknown as { value: number }
    }
  };
}
