import * as THREE from "three";
import type {
  ActorRuntimeStatus,
  ParameterSchema,
  ParameterValues,
  ReloadableDescriptor,
  SceneHookContext
} from "./pluginContracts";
import {
  getGelSpec,
  getLampSpec,
  getLensSpec,
  getZoomBarrel,
  listGelOptions,
  listLampOptions,
  listLensTubeOptions,
  listZoomBarrelOptions
} from "./source4Data";
import {
  clamp,
  effectiveOutputLumens,
  fieldDiameterAtThrow,
  resolveFieldAngleDeg,
  type BeamParams
} from "./source4Optics";
import {
  aimChildQuaternion,
  applyBeamAppearance,
  applyBodyAppearance,
  applySpotLight,
  createLightObject,
  disposeLightObject,
  getUserData,
  rebuildBeamGeometry,
  resolveRefs,
  type LightObjectRefs
} from "./lightGeometry";

export const SOURCE4_DESCRIPTOR_ID = "plugin.theatre.source4";

const DEFAULT_LENS_LABEL = getLensSpec("36deg")?.label ?? "36°";
const DEFAULT_ZOOM_LABEL = getZoomBarrel("25-50")?.label ?? "25–50° Zoom";
const DEFAULT_LAMP_LABEL = getLampSpec("HPL575")?.label ?? "HPL 575W";
const DEFAULT_GEL_LABEL = getGelSpec("L201")?.label ?? "L201 Full C.T.Blue";

const DEFAULT_BEAM_COLOR = "#ffd9a0";
const DEFAULT_BODY_COLOR = "#9fb4c8";

const STATUS_REFRESH_FRAMES = 30;

function num(params: ParameterValues, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(params: ParameterValues, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === "string" ? value : fallback;
}

function bool(params: ParameterValues, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

function buildBeamParams(params: ParameterValues): BeamParams {
  return {
    lensMode: str(params, "lensMode", "fixed") === "zoom" ? "zoom" : "fixed",
    lensTube: str(params, "lensTube", DEFAULT_LENS_LABEL),
    zoomBarrel: str(params, "zoomBarrel", DEFAULT_ZOOM_LABEL),
    zoomAngleDeg: num(params, "zoomAngleDeg", 36),
    throwDistance: num(params, "throwDistance", 5),
    previewLength: num(params, "previewLength", 8),
    edgeQuality: num(params, "edgeQuality", 0.5),
    shutterTop: num(params, "shutterTop", 0),
    shutterBottom: num(params, "shutterBottom", 0),
    shutterLeft: num(params, "shutterLeft", 0),
    shutterRight: num(params, "shutterRight", 0)
  };
}

const LIGHT_ACTOR_SCHEMA: ParameterSchema = {
  id: SOURCE4_DESCRIPTOR_ID,
  title: "Source Four",
  params: [
    {
      key: "lensMode",
      label: "Lens Mode",
      type: "select",
      options: ["fixed", "zoom"],
      groupKey: "lens",
      groupLabel: "Lens",
      defaultValue: "fixed",
      description: "Fixed degree lens tube, or a variable zoom barrel."
    },
    {
      key: "lensTube",
      label: "Lens Tube",
      type: "select",
      options: listLensTubeOptions(),
      groupKey: "lens",
      groupLabel: "Lens",
      defaultValue: DEFAULT_LENS_LABEL,
      visibleWhen: [{ key: "lensMode", equals: "fixed" }]
    },
    {
      key: "zoomBarrel",
      label: "Zoom Barrel",
      type: "select",
      options: listZoomBarrelOptions(),
      groupKey: "lens",
      groupLabel: "Lens",
      defaultValue: DEFAULT_ZOOM_LABEL,
      visibleWhen: [{ key: "lensMode", equals: "zoom" }]
    },
    {
      key: "zoomAngleDeg",
      label: "Zoom Angle",
      type: "number",
      min: 15,
      max: 50,
      step: 0.5,
      unit: "°",
      groupKey: "lens",
      groupLabel: "Lens",
      defaultValue: 36,
      description: "Clamped to the selected barrel range (15–30° or 25–50°).",
      visibleWhen: [{ key: "lensMode", equals: "zoom" }]
    },
    {
      key: "throwDistance",
      label: "Throw / Focus",
      type: "number",
      min: 0.1,
      step: 0.1,
      unit: "m",
      groupKey: "beam",
      groupLabel: "Beam",
      defaultValue: 5,
      description: "Focus distance — where the field diameter is quoted."
    },
    {
      key: "previewLength",
      label: "Preview Length",
      type: "number",
      min: 0.1,
      step: 0.1,
      unit: "m",
      groupKey: "beam",
      groupLabel: "Beam",
      defaultValue: 8,
      description: "How far the beam cone (and the real light) reaches — independent of focus. Increase to show coverage on far objects."
    },
    {
      key: "edgeQuality",
      label: "Edge (hard→soft)",
      type: "number",
      min: 0,
      max: 1,
      step: 0.01,
      groupKey: "beam",
      groupLabel: "Beam",
      defaultValue: 0.5,
      description: "0 = hard focus (single outline); higher adds a soft penumbra ring."
    },
    {
      key: "lampType",
      label: "Lamp",
      type: "select",
      options: listLampOptions(),
      groupKey: "lamp",
      groupLabel: "Lamp",
      defaultValue: DEFAULT_LAMP_LABEL
    },
    {
      key: "dimming",
      label: "Dimmer",
      type: "number",
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      groupKey: "lamp",
      groupLabel: "Lamp",
      defaultValue: 100,
      description: "Scales reported output, beam wireframe brightness, and the real-light intensity."
    },
    {
      key: "castLight",
      label: "Cast Light",
      type: "boolean",
      groupKey: "lamp",
      groupLabel: "Lamp",
      defaultValue: true,
      description: "Emit a real light that illuminates meshes/primitives and gaussian splats inside the beam (additive, no shadows)."
    },
    {
      key: "lightIntensity",
      label: "Light Intensity",
      type: "number",
      min: 0,
      max: 20,
      step: 0.5,
      groupKey: "lamp",
      groupLabel: "Lamp",
      defaultValue: 4,
      description: "Brightness of the real beam light. The scene is IBL-dominant, so tune to taste.",
      visibleWhen: [{ key: "castLight", equals: true }]
    },
    {
      key: "gelMode",
      label: "Gel",
      type: "select",
      options: ["none", "preset", "custom"],
      groupKey: "gel",
      groupLabel: "Gel",
      defaultValue: "none"
    },
    {
      key: "gelPreset",
      label: "Gel Preset",
      type: "select",
      options: listGelOptions(),
      groupKey: "gel",
      groupLabel: "Gel",
      defaultValue: DEFAULT_GEL_LABEL,
      description: "Lee (L###) and Rosco (R###) gels. Colours are approximate sRGB.",
      visibleWhen: [{ key: "gelMode", equals: "preset" }]
    },
    {
      key: "gelCustomColor",
      label: "Custom Gel Colour",
      type: "color",
      groupKey: "gel",
      groupLabel: "Gel",
      defaultValue: "#ffffff",
      visibleWhen: [{ key: "gelMode", equals: "custom" }]
    },
    {
      key: "shutterTop",
      label: "Shutter Top",
      type: "number",
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      groupKey: "shutters",
      groupLabel: "Framing Shutters",
      defaultValue: 0
    },
    {
      key: "shutterBottom",
      label: "Shutter Bottom",
      type: "number",
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      groupKey: "shutters",
      groupLabel: "Framing Shutters",
      defaultValue: 0
    },
    {
      key: "shutterLeft",
      label: "Shutter Left",
      type: "number",
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      groupKey: "shutters",
      groupLabel: "Framing Shutters",
      defaultValue: 0
    },
    {
      key: "shutterRight",
      label: "Shutter Right",
      type: "number",
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      groupKey: "shutters",
      groupLabel: "Framing Shutters",
      defaultValue: 0
    },
    {
      key: "lookAtActorId",
      label: "Look At",
      type: "actor-ref",
      allowSelf: false,
      groupKey: "aim",
      groupLabel: "Aim",
      defaultValue: "",
      description: "When set, the fixture continuously aims at this actor."
    },
    {
      key: "beamColor",
      label: "Beam Colour",
      type: "color",
      groupKey: "display",
      groupLabel: "Display",
      defaultValue: DEFAULT_BEAM_COLOR,
      description: "Beam outline colour when no gel is applied."
    },
    {
      key: "bodyColor",
      label: "Body Colour",
      type: "color",
      groupKey: "display",
      groupLabel: "Display",
      defaultValue: DEFAULT_BODY_COLOR
    },
    {
      key: "showBeam",
      label: "Show Beam",
      type: "boolean",
      groupKey: "display",
      groupLabel: "Display",
      defaultValue: true
    },
    {
      key: "showBody",
      label: "Show Body",
      type: "boolean",
      groupKey: "display",
      groupLabel: "Display",
      defaultValue: true
    }
  ]
};

interface Source4Runtime {
  ready: boolean;
}

interface GelTint {
  hex: string;
  label: string;
  approximate: boolean;
}

function resolveTint(params: ParameterValues): GelTint {
  const gelMode = str(params, "gelMode", "none");
  if (gelMode === "custom") {
    const hex = str(params, "gelCustomColor", "#ffffff");
    return { hex, label: hex, approximate: false };
  }
  if (gelMode === "preset") {
    const gel = getGelSpec(str(params, "gelPreset", DEFAULT_GEL_LABEL));
    if (gel) {
      return { hex: gel.hex, label: gel.label, approximate: gel.approximate };
    }
  }
  return { hex: str(params, "beamColor", DEFAULT_BEAM_COLOR), label: "None", approximate: false };
}

function buildStatusValues(params: ParameterValues, beamParams: BeamParams, aimLabel: string): Record<string, string> {
  const fieldAngle = resolveFieldAngleDeg(beamParams);
  const throwM = Math.max(0, beamParams.throwDistance);
  const dimming = clamp(num(params, "dimming", 100), 0, 100);
  const lamp = getLampSpec(str(params, "lampType", DEFAULT_LAMP_LABEL));
  const output = effectiveOutputLumens(str(params, "lampType", DEFAULT_LAMP_LABEL), dimming);
  const tint = resolveTint(params);
  const gelMode = str(params, "gelMode", "none");
  const lensLabel =
    beamParams.lensMode === "zoom"
      ? `${getZoomBarrel(beamParams.zoomBarrel)?.label ?? beamParams.zoomBarrel}`
      : `${getLensSpec(beamParams.lensTube)?.label ?? beamParams.lensTube} tube`;
  const edge = clamp(num(params, "edgeQuality", 0.5), 0, 1);
  const previewLength = Math.max(0.1, beamParams.previewLength);
  const shutters = `T${num(params, "shutterTop", 0)} B${num(params, "shutterBottom", 0)} L${num(params, "shutterLeft", 0)} R${num(params, "shutterRight", 0)} %`;

  let gelText = "None";
  if (gelMode === "custom") {
    gelText = tint.label;
  } else if (gelMode === "preset") {
    gelText = tint.approximate ? `${tint.label} (approx)` : tint.label;
  }

  const castLight = bool(params, "castLight", true);
  const lightIntensity = clamp(num(params, "lightIntensity", 4), 0, 20);
  const lightText = castLight ? `On · ${(lightIntensity * (dimming / 100)).toFixed(1)}` : "Off";

  return {
    type: "Source Four",
    lens: lensLabel,
    fieldAngle: `${fieldAngle.toFixed(1)}°`,
    throw: `${throwM.toFixed(2)} m`,
    fieldDiameter: `${fieldDiameterAtThrow(fieldAngle, throwM).toFixed(2)} m`,
    previewLength: `${previewLength.toFixed(2)} m`,
    coverageDiameter: `${fieldDiameterAtThrow(fieldAngle, previewLength).toFixed(2)} m`,
    lamp: lamp ? lamp.label : "—",
    output: `${output} lm @ ${Math.round(dimming)}%${lamp ? ` · ${lamp.cct}K` : ""}`,
    light: lightText,
    gel: gelText,
    shutters,
    aim: aimLabel,
    edge: edge <= 0.01 ? "Hard" : `Soft ${Math.round(edge * 100)}%`
  };
}

/**
 * Drive the real beam light: a THREE.SpotLight illuminates standard meshes/primitives,
 * and (for gaussian splats, which ignore THREE lights) the world-space cone is published
 * to the host beam-light registry for the splat shader to sample.
 */
function applyIllumination(
  context: SceneHookContext,
  refs: LightObjectRefs,
  params: ParameterValues,
  beamParams: BeamParams,
  colorHex: string
): void {
  const castLight = bool(params, "castLight", true);
  const dimming = clamp(num(params, "dimming", 100), 0, 100);
  const lightIntensity = clamp(num(params, "lightIntensity", 4), 0, 20);
  const intensity = castLight ? lightIntensity * (dimming / 100) : 0;
  const on = castLight && intensity > 1e-4;

  const fieldAngle = resolveFieldAngleDeg(beamParams);
  const halfAngleRad = Math.min(Math.max((fieldAngle * Math.PI) / 180 / 2, 0.01), Math.PI / 2 - 0.01);
  const edge = clamp(num(params, "edgeQuality", 0.5), 0, 1);
  const range = Math.max(0.1, beamParams.previewLength);

  // Meshes / primitives: a real spotlight under the aim group (follows look-at).
  if (refs.spot) {
    applySpotLight(refs.spot, {
      visible: on,
      colorHex,
      intensity,
      angleRad: halfAngleRad,
      penumbra: edge,
      distance: range,
      decay: 1
    });
  }

  // Gaussian splats: publish the world-space cone for the splat shader to sample.
  if (typeof context.setBeamLights === "function") {
    if (on) {
      refs.aim.updateWorldMatrix(true, false);
      const apex = refs.aim.getWorldPosition(new THREE.Vector3());
      const dir = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(refs.aim.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
      const color = new THREE.Color(colorHex);
      context.setBeamLights(context.actor.id, [
        {
          position: [apex.x, apex.y, apex.z],
          direction: [dir.x, dir.y, dir.z],
          cosHalfAngle: Math.cos(halfAngleRad),
          color: [color.r, color.g, color.b],
          intensity,
          range,
          penumbra: edge
        }
      ]);
    } else {
      context.setBeamLights(context.actor.id, []);
    }
  }
}

function applyLookAt(context: SceneHookContext, root: THREE.Object3D, aim: THREE.Object3D, params: ParameterValues): string {
  const targetId = str(params, "lookAtActorId", "");
  if (!targetId) {
    aim.quaternion.identity();
    return "Manual";
  }
  const targetObject = context.getActorObject(targetId);
  if (!(targetObject instanceof THREE.Object3D)) {
    return "target missing";
  }
  targetObject.updateWorldMatrix(true, false);
  root.updateWorldMatrix(true, false);
  const targetPos = targetObject.getWorldPosition(new THREE.Vector3());
  const rootPos = root.getWorldPosition(new THREE.Vector3());
  const rootQuat = root.getWorldQuaternion(new THREE.Quaternion());
  const childQuat = aimChildQuaternion(rootPos, rootQuat, targetPos);
  if (childQuat) {
    aim.quaternion.copy(childQuat);
  }
  const targetNode = context.getActorById(targetId);
  return `→ ${targetNode?.name ?? targetId}`;
}

export const source4Descriptor: ReloadableDescriptor<Source4Runtime> = {
  id: SOURCE4_DESCRIPTOR_ID,
  kind: "actor",
  version: 1,
  schema: LIGHT_ACTOR_SCHEMA,
  spawn: {
    actorType: "plugin",
    pluginType: SOURCE4_DESCRIPTOR_ID,
    label: "Source Four",
    description: "ETC Source Four ellipsoidal — wireframe body + beam outline visualisation.",
    iconGlyph: "S4"
  },
  createRuntime: () => ({ ready: true }),
  updateRuntime: () => {
    // Per-frame state lives on the scene object's userData (see sceneHooks.syncObject);
    // nothing to do here.
  },
  sceneHooks: {
    createObject: ({ actor }) => {
      const params = actor.params;
      const dimming = clamp(num(params, "dimming", 100), 0, 100);
      const beamOpacity = 0.25 + 0.65 * (dimming / 100);
      const bodyColor = str(params, "bodyColor", DEFAULT_BODY_COLOR);
      const beamColor = str(params, "beamColor", DEFAULT_BEAM_COLOR);
      return createLightObject(bodyColor, beamColor, beamOpacity);
    },
    syncObject: (context) => {
      const refs = resolveRefs(context.object);
      if (!refs) {
        return;
      }
      const params = context.actor.params;
      const beamParams = buildBeamParams(params);
      const data = getUserData(refs.root);

      // Rebuild the beam geometry only when an optics param changes.
      const signature = JSON.stringify(beamParams);
      if (signature !== data.beamSig) {
        data.beamSig = signature;
        rebuildBeamGeometry(refs.beam, beamParams);
      }

      // Visibility + appearance are cheap; apply every frame.
      refs.beam.visible = bool(params, "showBeam", true);
      refs.body.visible = bool(params, "showBody", true);

      const dimming = clamp(num(params, "dimming", 100), 0, 100);
      const beamOpacity = 0.25 + 0.65 * (dimming / 100);
      const tint = resolveTint(params);
      applyBeamAppearance(refs.beam, tint.hex, beamOpacity);
      applyBodyAppearance(refs.body, str(params, "bodyColor", DEFAULT_BODY_COLOR));

      // Continuous aim (visual): orient the aim child toward the target.
      const aimLabel = applyLookAt(context, refs.root, refs.aim, params);

      // Real illumination: spotlight (meshes) + beam-light registry (splats).
      applyIllumination(context, refs, params, beamParams, tint.hex);

      // Throttled status: on change, or every STATUS_REFRESH_FRAMES frames.
      data.frame += 1;
      const statusValues = buildStatusValues(params, beamParams, aimLabel);
      const statusKey = JSON.stringify(statusValues);
      if (statusKey !== data.lastStatusKey || data.frame % STATUS_REFRESH_FRAMES === 0) {
        data.lastStatusKey = statusKey;
        const status: ActorRuntimeStatus = { values: statusValues, updatedAtIso: new Date().toISOString() };
        context.setActorStatus(status);
      }
    },
    disposeObject: ({ object }) => {
      disposeLightObject(object);
    }
  }
};
