import {
  ACESFilmicToneMapping,
  ColorManagement,
  NoToneMapping,
  RawShaderMaterial,
  SRGBTransfer,
  UniformsUtils
} from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { OutputShader } from "three/examples/jsm/shaders/OutputShader.js";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import { film } from "three/examples/jsm/tsl/display/FilmNode.js";
import { rgbShift } from "three/examples/jsm/tsl/display/RGBShiftNode.js";
import { ao } from "three/examples/jsm/tsl/display/GTAONode.js";
import * as TSL from "three/tsl";
import {
  clamp,
  float,
  fract,
  mix,
  renderOutput,
  screenCoordinate,
  vec2,
  vec3,
  vec4,
  dot
} from "three/tsl";
const abs = (TSL as any).abs as (x: any) => any;
const step = (TSL as any).step as (edge: any, x: any) => any;
import type { Camera } from "three";
import type { ScenePostProcessingSettings, SceneToneMappingMode, SceneTonemappingSettings } from "@/core/types";

const DISPLAY_DISTANCE_MAX = Math.SQRT2;

const SCENE_OUTPUT_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform sampler2D tDiffuse;
  uniform bool ditherEnabled;
  uniform bool vignetteEnabled;
  uniform float vignetteOffset;
  uniform float vignetteDarkness;
  uniform bool chromaticAberrationEnabled;
  uniform float chromaticAberrationOffset;
  uniform bool grainEnabled;
  uniform float grainIntensity;

  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>

  varying vec2 vUv;

  float screenSpaceNoise( vec2 screenPosition ) {
    return fract( 52.9829189 * fract( dot( screenPosition, vec2( 0.06711056, 0.00583715 ) ) ) );
  }

  vec4 applyOutputTransform( vec4 color ) {
    #ifdef ACES_FILMIC_TONE_MAPPING
      color.rgb = ACESFilmicToneMapping( color.rgb );
    #endif

    #ifdef SRGB_TRANSFER
      color = sRGBTransferOETF( color );
    #endif

    return color;
  }

  void main() {
    vec2 uv = vUv;
    vec4 base = texture2D( tDiffuse, uv );
    vec4 display = applyOutputTransform( base );

    if ( chromaticAberrationEnabled && chromaticAberrationOffset > 0.0 ) {
      vec2 direction = uv - vec2( 0.5 );
      float directionLength = length( direction );
      if ( directionLength > 1e-6 ) {
        direction /= directionLength;
      } else {
        direction = vec2( 1.0, 0.0 );
      }
      vec2 offset = direction * chromaticAberrationOffset;
      vec4 redSample = applyOutputTransform( texture2D( tDiffuse, uv + offset ) );
      vec4 blueSample = applyOutputTransform( texture2D( tDiffuse, uv - offset ) );
      display = vec4( redSample.r, display.g, blueSample.b, display.a );
    }

    if ( vignetteEnabled && vignetteDarkness > 0.0 ) {
      float dist = length( ( uv - vec2( 0.5 ) ) * 2.0 );
      float vignetteMask = smoothstep( vignetteOffset, ${DISPLAY_DISTANCE_MAX.toFixed(8)}, dist );
      float vignetteFactor = mix( 1.0, max( 0.0, 1.0 - vignetteDarkness ), vignetteMask );
      display.rgb *= vignetteFactor;
    }

    if ( grainEnabled && grainIntensity > 0.0 ) {
      float grain = ( screenSpaceNoise( gl_FragCoord.xy + uv * 4096.0 ) - 0.5 ) * grainIntensity;
      display.rgb = clamp( display.rgb + vec3( grain ), 0.0, 1.0 );
    }

    if ( ditherEnabled ) {
      float dither = ( screenSpaceNoise( gl_FragCoord.xy ) - 0.5 ) / 255.0;
      display.rgb = clamp( display.rgb + vec3( dither ), 0.0, 1.0 );
    }

    gl_FragColor = display;
  }
`;

export function threeToneMappingForMode(mode: SceneToneMappingMode): number {
  return mode === "aces" ? ACESFilmicToneMapping : NoToneMapping;
}

export class SceneOutputPass extends Pass {
  private readonly uniforms = UniformsUtils.clone({
    ...OutputShader.uniforms,
    ditherEnabled: { value: true },
    vignetteEnabled: { value: false },
    vignetteOffset: { value: 1 },
    vignetteDarkness: { value: 0.35 },
    chromaticAberrationEnabled: { value: false },
    chromaticAberrationOffset: { value: 0.0015 },
    grainEnabled: { value: false },
    grainIntensity: { value: 0.02 }
  });

  private readonly material = new RawShaderMaterial({
    name: "SceneOutputShader",
    uniforms: this.uniforms,
    vertexShader: OutputShader.vertexShader,
    fragmentShader: SCENE_OUTPUT_FRAGMENT_SHADER
  });

  private readonly fsQuad = new FullScreenQuad(this.material);
  private lastOutputColorSpace: string | null = null;
  private lastToneMapping: number | null = null;

  public render(renderer: any, writeBuffer: any, readBuffer: any): void {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    this.syncDefines(renderer);

    if (this.renderToScreen === true) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
      return;
    }

    renderer.setRenderTarget(writeBuffer);
    if (this.clear) {
      renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
    }
    this.fsQuad.render(renderer);
  }

  public setDitherEnabled(enabled: boolean): void {
    this.uniforms.ditherEnabled.value = enabled;
  }

  public setPostProcessingSettings(postProcessing: ScenePostProcessingSettings): void {
    this.uniforms.vignetteEnabled.value = postProcessing.vignette.enabled;
    this.uniforms.vignetteOffset.value = postProcessing.vignette.offset;
    this.uniforms.vignetteDarkness.value = postProcessing.vignette.darkness;
    this.uniforms.chromaticAberrationEnabled.value = postProcessing.chromaticAberration.enabled;
    this.uniforms.chromaticAberrationOffset.value = postProcessing.chromaticAberration.offset;
    this.uniforms.grainEnabled.value = postProcessing.grain.enabled;
    this.uniforms.grainIntensity.value = postProcessing.grain.intensity;
  }

  public dispose(): void {
    this.material.dispose();
    this.fsQuad.dispose();
  }

  private syncDefines(renderer: any): void {
    if (this.lastOutputColorSpace === renderer.outputColorSpace && this.lastToneMapping === renderer.toneMapping) {
      return;
    }

    this.lastOutputColorSpace = renderer.outputColorSpace;
    this.lastToneMapping = renderer.toneMapping;
    this.material.defines = {};

    if (ColorManagement.getTransfer(renderer.outputColorSpace) === SRGBTransfer) {
      this.material.defines.SRGB_TRANSFER = "";
    }

    if (renderer.toneMapping === ACESFilmicToneMapping) {
      this.material.defines.ACES_FILMIC_TONE_MAPPING = "";
    }

    this.material.needsUpdate = true;
  }
}

function applyWebGpuVignette(node: any, vignette: ScenePostProcessingSettings["vignette"]): any {
  void vignette;
  return node;
}

function applyWebGpuGrain(node: any, grain: ScenePostProcessingSettings["grain"]): any {
  if (!grain.enabled || grain.intensity <= 0) {
    return node;
  }

  return film(node, float(grain.intensity));
}

export interface WebGpuAoSourceNodes {
  meshDepth: any;
  meshNormal: any;
  sceneDepth: any;
  camera: Camera;
}

export function buildWebGpuToneMappedOutputNode(
  inputNode: any,
  outputColorSpace: string,
  tonemapping: SceneTonemappingSettings,
  postProcessing: ScenePostProcessingSettings,
  aoSources: WebGpuAoSourceNodes | null
): any {
  let linearNode = inputNode;

  if (postProcessing.ambientOcclusion.enabled && aoSources) {
    const settings = postProcessing.ambientOcclusion;
    const aoPass = ao(aoSources.meshDepth, aoSources.meshNormal, aoSources.camera);
    aoPass.radius.value = settings.radius;
    aoPass.thickness.value = settings.thickness;
    aoPass.distanceExponent.value = settings.distanceExponent;
    aoPass.scale.value = settings.scale;
    aoPass.samples.value = settings.samples;
    aoPass.resolutionScale = settings.resolutionScale;
    const aoTex = aoPass.getTextureNode();
    const meshIsVisible = step(abs(aoSources.meshDepth.sub(aoSources.sceneDepth)), float(1e-4));
    linearNode = linearNode.mul(mix(vec4(1.0), aoTex, meshIsVisible));
  }

  if (postProcessing.bloom.enabled) {
    linearNode = linearNode.add(
      bloom(linearNode, postProcessing.bloom.strength, postProcessing.bloom.radius, postProcessing.bloom.threshold)
    );
  }

  let outputNode = renderOutput(linearNode, threeToneMappingForMode(tonemapping.mode), outputColorSpace);

  if (postProcessing.chromaticAberration.enabled && postProcessing.chromaticAberration.offset > 0) {
    outputNode = rgbShift(outputNode, postProcessing.chromaticAberration.offset, 0);
  }

  outputNode = applyWebGpuVignette(outputNode, postProcessing.vignette);
  outputNode = applyWebGpuGrain(outputNode, postProcessing.grain);

  if (!tonemapping.dither) {
    return outputNode;
  }

  const noise = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))));
  const dither = noise.sub(0.5).div(255.0);
  return vec4(clamp(outputNode.rgb.add(vec3(dither)), 0.0, 1.0), outputNode.a);
}
