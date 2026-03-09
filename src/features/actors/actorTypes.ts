import type { ParameterSchema } from "@/core/types";
import { MIST_LOOKUP_NOISE_PRESETS } from "@/features/actors/mistVolumeLookupNoise";

export const EMPTY_ACTOR_SCHEMA: ParameterSchema = {
  id: "actor.empty",
  title: "Empty Actor",
  params: []
};

export const ENVIRONMENT_ACTOR_SCHEMA: ParameterSchema = {
  id: "actor.environment",
  title: "Environment",
  params: [
    {
      key: "assetId",
      label: "Asset",
      type: "file",
      accept: [".hdr", ".exr", ".ktx2", ".png", ".jpg", ".jpeg"],
      dialogTitle: "Select environment source",
      import: {
        mode: "transcode-hdri",
        options: {
          uastc: true,
          zstdLevel: 18,
          generateMipmaps: true
        }
      }
    },
    { key: "intensity", label: "Intensity", type: "number", min: 0, max: 5, step: 0.05 }
  ]
};

export const GAUSSIAN_SPLAT_SPARK_SCHEMA: ParameterSchema = {
  id: "actor.gaussianSplatSpark",
  title: "Gaussian Splat",
  params: [
    {
      key: "assetId",
      label: "PLY Asset",
      type: "file",
      accept: [".ply"],
      dialogTitle: "Select Gaussian splat PLY",
      import: {
        mode: "import-asset",
        kind: "generic"
      }
    },
    {
      key: "scaleFactor",
      label: "Scale",
      type: "number",
      step: 0.001,
      precision: 3,
      defaultValue: 1
    },
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.01, defaultValue: 1 },
    {
      key: "brightness",
      label: "Brightness",
      type: "number",
      min: 0,
      max: 8,
      step: 0.05,
      defaultValue: 1
    },
    {
      key: "colorInputSpace",
      label: "Captured Color Space",
      type: "select",
      options: ["srgb", "iphone-sdr", "linear"],
      defaultValue: "srgb"
    },
    {
      key: "stochasticDepth",
      label: "Depth-Correct Transparency",
      description: "Uses Spark's stochastic depth-writing mode. Transparent objects interact with splats more correctly, but the splats become dithered.",
      type: "boolean",
      defaultValue: false
    }
  ]
};

export const MIST_VOLUME_ACTOR_SCHEMA: ParameterSchema = {
  id: "actor.mistVolume",
  title: "Mist Volume",
  params: [
    {
      key: "volumeActorId",
      label: "Volume Cube",
      type: "actor-ref",
      groupKey: "volume",
      groupLabel: "Volume",
      allowedActorTypes: ["primitive"],
      allowSelf: false,
      description: "Reference a cube primitive actor to define the mist simulation bounds."
    },
    {
      key: "sourceActorIds",
      label: "Emitter Sources",
      type: "actor-ref-list",
      groupKey: "emission",
      groupLabel: "Emission",
      allowedActorTypes: ["empty", "curve"],
      allowSelf: false,
      description: "Actors that inject mist into the volume. Empty actors emit from a point, and curves emit along their sampled length."
    },
    {
      key: "resolutionX",
      label: "Resolution X",
      type: "number",
      groupKey: "volume",
      groupLabel: "Volume",
      min: 4,
      max: 256,
      step: 1,
      description: "Number of simulation cells across the local X axis of the referenced volume cube.",
      defaultValue: 32
    },
    {
      key: "resolutionY",
      label: "Resolution Y",
      type: "number",
      groupKey: "volume",
      groupLabel: "Volume",
      min: 4,
      max: 256,
      step: 1,
      description: "Number of simulation cells across the local Y axis of the referenced volume cube.",
      defaultValue: 24
    },
    {
      key: "resolutionZ",
      label: "Resolution Z",
      type: "number",
      groupKey: "volume",
      groupLabel: "Volume",
      min: 4,
      max: 256,
      step: 1,
      description: "Number of simulation cells across the local Z axis of the referenced volume cube.",
      defaultValue: 32
    },
    {
      key: "sourceRadius",
      label: "Emitter Radius",
      type: "number",
      groupKey: "emission",
      groupLabel: "Emission",
      min: 0.01,
      step: 0.01,
      unit: "m",
      description: "Physical radius around each emitter sample that receives injected density and launch velocity.",
      defaultValue: 0.2
    },
    {
      key: "injectionRate",
      label: "Injection Rate",
      type: "number",
      groupKey: "emission",
      groupLabel: "Emission",
      min: 0,
      step: 0.05,
      description: "Base amount of mist density injected per second before emission noise is applied.",
      defaultValue: 1
    },
    {
      key: "initialSpeed",
      label: "Initial Speed",
      type: "number",
      groupKey: "emission",
      groupLabel: "Emission",
      min: 0,
      step: 0.05,
      unit: "m/s",
      description: "Launch speed assigned to newly emitted mist before wind, turbulence, and drag modify it.",
      defaultValue: 0.6
    },
    {
      key: "emissionDirection",
      label: "Emission Direction",
      type: "vector3",
      groupKey: "emission",
      groupLabel: "Emission",
      description: "Emitter-local launch direction. The emitter actor's rotation is applied to this vector before injection.",
      defaultValue: [0, -1, 0],
      precision: 3
    },
    {
      key: "buoyancy",
      label: "Buoyancy",
      type: "number",
      groupKey: "physics",
      groupLabel: "Physics",
      step: 0.05,
      description: "Upward acceleration added in proportion to local density, simulating lighter-than-air mist lift.",
      defaultValue: 0.35
    },
    {
      key: "velocityDrag",
      label: "Velocity Drag",
      type: "number",
      groupKey: "physics",
      groupLabel: "Physics",
      min: 0,
      max: 1,
      step: 0.01,
      description: "Per-step damping applied to velocity. Higher values make motion settle faster and reduce lingering flow.",
      defaultValue: 0.12
    },
    {
      key: "diffusion",
      label: "Diffusion",
      type: "number",
      groupKey: "physics",
      groupLabel: "Physics",
      min: 0,
      step: 0.01,
      description: "Amount of smoothing between neighboring cells. Higher values make the plume spread and blur more quickly.",
      defaultValue: 0.04
    },
    {
      key: "densityDecay",
      label: "Density Decay",
      type: "number",
      groupKey: "physics",
      groupLabel: "Physics",
      min: 0,
      max: 1,
      step: 0.01,
      description: "Rate at which mist density fades over time, simulating dissipation and mixing into the environment.",
      defaultValue: 0.08
    },
    {
      key: "simulationSubsteps",
      label: "Simulation Steps",
      type: "number",
      groupKey: "physics",
      groupLabel: "Physics",
      min: 1,
      max: 16,
      step: 1,
      description: "Number of smaller integration steps taken each frame. Increase to improve stability at the cost of more CPU time.",
      defaultValue: 1
    },
    {
      key: "noiseSeed",
      label: "Noise Seed",
      type: "number",
      groupKey: "noise",
      groupLabel: "Noise",
      step: 1,
      description: "Seed used for deterministic noise fields so the same setup reproduces the same evolving mist pattern.",
      defaultValue: 1
    },
    {
      key: "emissionNoiseStrength",
      label: "Emission Noise",
      type: "number",
      groupKey: "noise",
      groupLabel: "Noise",
      min: 0,
      max: 2,
      step: 0.01,
      description: "Strength of noisy variation in source density and launch direction. Use it to break up perfectly smooth emission.",
      defaultValue: 0
    },
    {
      key: "emissionNoiseScale",
      label: "Emission Noise Scale",
      type: "number",
      groupKey: "noise",
      groupLabel: "Noise",
      min: 0.01,
      step: 0.01,
      description: "Spatial scale of emission noise. Lower values create broader pulsation; higher values create finer variation.",
      defaultValue: 1
    },
    {
      key: "emissionNoiseSpeed",
      label: "Emission Noise Speed",
      type: "number",
      groupKey: "noise",
      groupLabel: "Noise",
      min: 0,
      step: 0.01,
      description: "How quickly emission noise evolves over time.",
      defaultValue: 0.75
    },
    {
      key: "windVector",
      label: "Wind Vector",
      type: "vector3",
      groupKey: "noise",
      groupLabel: "Noise",
      description: "Constant ambient wind force applied everywhere in the occupied mist field.",
      defaultValue: [0, 0, 0],
      precision: 3
    },
    {
      key: "windNoiseStrength",
      label: "Wind Noise",
      type: "number",
      groupKey: "noise",
      groupLabel: "Noise",
      min: 0,
      max: 2,
      step: 0.01,
      description: "Strength of large-scale fluctuating wind added on top of the base wind vector.",
      defaultValue: 0
    },
    {
      key: "windNoiseScale",
      label: "Wind Noise Scale",
      type: "number",
      groupKey: "noise",
      groupLabel: "Noise",
      min: 0.01,
      step: 0.01,
      description: "Spatial size of wind-noise structures. Lower values make broad gusts; higher values make more localized variation.",
      defaultValue: 0.75
    },
    {
      key: "windNoiseSpeed",
      label: "Wind Noise Speed",
      type: "number",
      groupKey: "noise",
      groupLabel: "Noise",
      min: 0,
      step: 0.01,
      description: "How quickly the wind-noise field changes over time.",
      defaultValue: 0.25
    },
    {
      key: "wispiness",
      label: "Wispiness",
      type: "number",
      groupKey: "noise",
      groupLabel: "Noise",
      min: 0,
      max: 2,
      step: 0.01,
      description: "Amount of fine turbulent breakup applied inside the plume to create filamented, wispy structure.",
      defaultValue: 0
    },
    {
      key: "edgeBreakup",
      label: "Edge Breakup",
      type: "number",
      groupKey: "noise",
      groupLabel: "Noise",
      min: 0,
      max: 2,
      step: 0.01,
      description: "Irregular extra decay applied around plume boundaries so the silhouette feels less smooth and uniform.",
      defaultValue: 0
    },
    {
      key: "lookupNoisePreset",
      label: "Lookup Noise Preset",
      type: "select",
      groupKey: "lookup-noise",
      groupLabel: "Lookup Noise",
      options: ["off", "cloudy", "wispy", "rolling", "custom"],
      description: "Applies a preset for analytic lookup-time noise layered on top of the voxel density. Manual edits switch this to custom.",
      defaultValue: "cloudy"
    },
    {
      key: "lookupNoiseStrength",
      label: "Lookup Noise Strength",
      type: "number",
      groupKey: "lookup-noise",
      groupLabel: "Lookup Noise",
      min: 0,
      max: 1,
      step: 0.01,
      description: "How strongly analytic noise modulates the mist density at sampling time without changing the stored voxels.",
      defaultValue: MIST_LOOKUP_NOISE_PRESETS.cloudy.strength
    },
    {
      key: "lookupNoiseScale",
      label: "Lookup Noise Scale",
      type: "number",
      groupKey: "lookup-noise",
      groupLabel: "Lookup Noise",
      min: 0.01,
      step: 0.01,
      description: "Spatial size of the analytic lookup-noise field. Lower values make broad cloudy structure; higher values make finer breakup.",
      defaultValue: MIST_LOOKUP_NOISE_PRESETS.cloudy.scale
    },
    {
      key: "lookupNoiseSpeed",
      label: "Lookup Noise Speed",
      type: "number",
      groupKey: "lookup-noise",
      groupLabel: "Lookup Noise",
      min: 0,
      step: 0.01,
      description: "How quickly the analytic lookup-noise pattern evolves over time.",
      defaultValue: MIST_LOOKUP_NOISE_PRESETS.cloudy.speed
    },
    {
      key: "lookupNoiseScroll",
      label: "Lookup Noise Scroll",
      type: "vector3",
      groupKey: "lookup-noise",
      groupLabel: "Lookup Noise",
      description: "Directional drift applied to the analytic lookup-noise field over time.",
      defaultValue: MIST_LOOKUP_NOISE_PRESETS.cloudy.scroll,
      precision: 3
    },
    {
      key: "lookupNoiseContrast",
      label: "Lookup Noise Contrast",
      type: "number",
      groupKey: "lookup-noise",
      groupLabel: "Lookup Noise",
      min: 0.1,
      step: 0.05,
      description: "Shape control for the analytic lookup-noise response. Higher values sharpen the noisy density modulation.",
      defaultValue: MIST_LOOKUP_NOISE_PRESETS.cloudy.contrast
    },
    {
      key: "lookupNoiseBias",
      label: "Lookup Noise Bias",
      type: "number",
      groupKey: "lookup-noise",
      groupLabel: "Lookup Noise",
      min: -1,
      max: 1,
      step: 0.01,
      description: "Bias applied after analytic lookup-noise evaluation to favor denser or thinner mist regions.",
      defaultValue: MIST_LOOKUP_NOISE_PRESETS.cloudy.bias
    },
    {
      key: "surfaceNegXMode",
      label: "Left Face",
      type: "select",
      groupKey: "surfaces",
      groupLabel: "Surfaces",
      options: ["open", "closed"],
      description: "Whether mist can leave the volume through the negative X face.",
      defaultValue: "open"
    },
    {
      key: "surfacePosXMode",
      label: "Right Face",
      type: "select",
      groupKey: "surfaces",
      groupLabel: "Surfaces",
      options: ["open", "closed"],
      description: "Whether mist can leave the volume through the positive X face.",
      defaultValue: "open"
    },
    {
      key: "surfaceNegYMode",
      label: "Bottom Face",
      type: "select",
      groupKey: "surfaces",
      groupLabel: "Surfaces",
      options: ["open", "closed"],
      description: "Whether mist can leave the volume through the negative Y face.",
      defaultValue: "open"
    },
    {
      key: "surfacePosYMode",
      label: "Top Face",
      type: "select",
      groupKey: "surfaces",
      groupLabel: "Surfaces",
      options: ["open", "closed"],
      description: "Whether mist can leave the volume through the positive Y face.",
      defaultValue: "open"
    },
    {
      key: "surfaceNegZMode",
      label: "Back Face",
      type: "select",
      groupKey: "surfaces",
      groupLabel: "Surfaces",
      options: ["open", "closed"],
      description: "Whether mist can leave the volume through the negative Z face.",
      defaultValue: "open"
    },
    {
      key: "surfacePosZMode",
      label: "Front Face",
      type: "select",
      groupKey: "surfaces",
      groupLabel: "Surfaces",
      options: ["open", "closed"],
      description: "Whether mist can leave the volume through the positive Z face.",
      defaultValue: "open"
    },
    {
      key: "previewMode",
      label: "Preview Mode",
      type: "select",
      groupKey: "preview",
      groupLabel: "Preview",
      options: ["volume", "bounds", "slice-x", "slice-y", "slice-z", "off"],
      defaultValue: "volume"
    },
    {
      key: "previewTint",
      label: "Preview Tint",
      type: "color",
      groupKey: "preview",
      groupLabel: "Preview",
      defaultValue: "#d9eef7"
    },
    {
      key: "previewOpacity",
      label: "Preview Opacity",
      type: "number",
      groupKey: "preview",
      groupLabel: "Preview",
      min: 0,
      max: 4,
      step: 0.05,
      defaultValue: 1.1
    },
    {
      key: "previewThreshold",
      label: "Preview Threshold",
      type: "number",
      groupKey: "preview",
      groupLabel: "Preview",
      min: 0,
      max: 1,
      step: 0.005,
      defaultValue: 0.02
    },
    {
      key: "slicePosition",
      label: "Slice Position",
      type: "number",
      groupKey: "preview",
      groupLabel: "Preview",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.5,
      visibleWhen: [{ key: "previewMode", equals: "slice-x" }]
    },
    {
      key: "slicePosition",
      label: "Slice Position",
      type: "number",
      groupKey: "preview",
      groupLabel: "Preview",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.5,
      visibleWhen: [{ key: "previewMode", equals: "slice-y" }]
    },
    {
      key: "slicePosition",
      label: "Slice Position",
      type: "number",
      groupKey: "preview",
      groupLabel: "Preview",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.5,
      visibleWhen: [{ key: "previewMode", equals: "slice-z" }]
    },
    {
      key: "previewRaymarchSteps",
      label: "Preview Steps",
      type: "number",
      groupKey: "preview",
      groupLabel: "Preview",
      min: 8,
      max: 256,
      step: 1,
      defaultValue: 48
    },
    {
      key: "renderOverrideEnabled",
      label: "Use Render Override",
      type: "boolean",
      groupKey: "render",
      groupLabel: "Render Override",
      defaultValue: false
    },
    {
      key: "renderResolutionX",
      label: "Render Resolution X",
      type: "number",
      groupKey: "render",
      groupLabel: "Render Override",
      min: 4,
      max: 512,
      step: 1,
      defaultValue: 64,
      visibleWhen: [{ key: "renderOverrideEnabled", equals: true }]
    },
    {
      key: "renderResolutionY",
      label: "Render Resolution Y",
      type: "number",
      groupKey: "render",
      groupLabel: "Render Override",
      min: 4,
      max: 512,
      step: 1,
      defaultValue: 48,
      visibleWhen: [{ key: "renderOverrideEnabled", equals: true }]
    },
    {
      key: "renderResolutionZ",
      label: "Render Resolution Z",
      type: "number",
      groupKey: "render",
      groupLabel: "Render Override",
      min: 4,
      max: 512,
      step: 1,
      defaultValue: 64,
      visibleWhen: [{ key: "renderOverrideEnabled", equals: true }]
    },
    {
      key: "renderSimulationSubsteps",
      label: "Render Sim Steps",
      type: "number",
      groupKey: "render",
      groupLabel: "Render Override",
      min: 1,
      max: 32,
      step: 1,
      defaultValue: 2,
      visibleWhen: [{ key: "renderOverrideEnabled", equals: true }]
    },
    {
      key: "renderPreviewRaymarchSteps",
      label: "Render Preview Steps",
      type: "number",
      groupKey: "render",
      groupLabel: "Render Override",
      min: 8,
      max: 512,
      step: 1,
      defaultValue: 96,
      visibleWhen: [{ key: "renderOverrideEnabled", equals: true }]
    }
  ]
};

export const MESH_ACTOR_SCHEMA: ParameterSchema = {
  id: "actor.mesh",
  title: "Mesh",
  params: [
    {
      key: "assetId",
      label: "Mesh Asset",
      type: "file",
      accept: [".glb", ".gltf", ".fbx", ".dae", ".obj"],
      dialogTitle: "Select mesh file",
      import: {
        mode: "import-asset",
        kind: "generic"
      },
      clearsParams: ["materialSlots", "localMaterials"]
    },
    {
      key: "scaleFactor",
      label: "Import Scale (src->m)",
      type: "number",
      step: 0.001,
      precision: 3,
      defaultValue: 1
    },
    {
      key: "materialId",
      label: "Material Override",
      type: "material-ref"
    },
    {
      key: "materialSlots",
      label: "Material Slots",
      type: "material-slots"
    }
  ]
};

export const PRIMITIVE_ACTOR_SCHEMA: ParameterSchema = {
  id: "actor.primitive",
  title: "Primitive",
  params: [
    {
      key: "shape",
      label: "Shape",
      type: "select",
      options: ["cube", "sphere", "cylinder"]
    },
    {
      key: "cubeSize",
      label: "Cube Size",
      type: "number",
      unit: "m",
      min: 0,
      step: 0.05,
      defaultValue: 1,
      visibleWhen: [{ key: "shape", equals: "cube" }]
    },
    {
      key: "sphereRadius",
      label: "Sphere Radius",
      type: "number",
      unit: "m",
      min: 0,
      step: 0.05,
      defaultValue: 0.5,
      visibleWhen: [{ key: "shape", equals: "sphere" }]
    },
    {
      key: "cylinderRadius",
      label: "Cylinder Radius",
      type: "number",
      unit: "m",
      min: 0,
      step: 0.05,
      defaultValue: 0.5,
      visibleWhen: [{ key: "shape", equals: "cylinder" }]
    },
    {
      key: "cylinderHeight",
      label: "Cylinder Height",
      type: "number",
      unit: "m",
      min: 0,
      step: 0.05,
      defaultValue: 1,
      visibleWhen: [{ key: "shape", equals: "cylinder" }]
    },
    {
      key: "segments",
      label: "Segments",
      type: "number",
      min: 1,
      max: 64,
      step: 1,
      defaultValue: 24
    },
    {
      key: "materialId",
      label: "Material",
      type: "material-ref",
      defaultValue: "mat.plastic.white.glossy"
    },
    {
      key: "wireframe",
      label: "Wireframe",
      type: "boolean"
    }
  ]
};

export const CURVE_ACTOR_SCHEMA: ParameterSchema = {
  id: "actor.curve",
  title: "Curve",
  params: [
    {
      key: "curveType",
      label: "Curve Type",
      type: "select",
      options: ["spline", "circle"],
      defaultValue: "spline"
    },
    {
      key: "closed",
      label: "Closed",
      type: "boolean",
      defaultValue: false,
      visibleWhen: [{ key: "curveType", equals: "spline" }]
    },
    {
      key: "samplesPerSegment",
      label: "Samples",
      type: "number",
      min: 2,
      max: 256,
      step: 1,
      defaultValue: 24
    },
    {
      key: "radius",
      label: "Radius",
      type: "number",
      unit: "m",
      min: 0,
      step: 0.05,
      defaultValue: 1,
      visibleWhen: [{ key: "curveType", equals: "circle" }]
    },
    {
      key: "handleSize",
      label: "Handle Size",
      type: "number",
      unit: "m",
      min: 0.1,
      max: 4,
      step: 0.05,
      defaultValue: 0.5,
      visibleWhen: [{ key: "curveType", equals: "spline" }]
    }
  ]
};

export const CAMERA_PATH_ACTOR_SCHEMA: ParameterSchema = {
  id: "actor.cameraPath",
  title: "Camera Path",
  params: [
    {
      key: "targetMode",
      label: "Target Mode",
      type: "select",
      options: ["curve", "actor"],
      defaultValue: "curve"
    },
    {
      key: "targetActorId",
      label: "Target Actor",
      type: "actor-ref",
      allowSelf: false,
      visibleWhen: [{ key: "targetMode", equals: "actor" }]
    }
  ]
};

