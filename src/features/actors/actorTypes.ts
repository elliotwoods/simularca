import type { ParameterSchema } from "@/core/types";

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

export const GAUSSIAN_SPLAT_SCHEMA: ParameterSchema = {
  id: "actor.gaussianSplat",
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
        kind: "gaussian-splat"
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
    { key: "splatSize", label: "Splat Size", type: "number", min: 0.05, max: 20, step: 0.05, defaultValue: 1 },
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.01, defaultValue: 1 },
    {
      key: "filterMode",
      label: "Filter Mode",
      type: "select",
      options: ["off", "inside", "outside"],
      defaultValue: "off"
    },
    {
      key: "filterRegionActorIds",
      label: "Filter Regions",
      type: "actor-ref-list",
      allowedActorTypes: ["primitive"],
      defaultValue: []
    }
  ]
};

export const GAUSSIAN_SPLAT_SPARK_SCHEMA: ParameterSchema = {
  id: "actor.gaussianSplatSpark",
  title: "Gaussian Splat (Spark)",
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
      label: "Import Scale (src->m)",
      type: "number",
      step: 0.001,
      precision: 3,
      defaultValue: 1
    },
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.01, defaultValue: 1 }
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
      }
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
      key: "closed",
      label: "Closed",
      type: "boolean",
      defaultValue: false
    },
    {
      key: "samplesPerSegment",
      label: "Samples / Segment",
      type: "number",
      min: 2,
      max: 256,
      step: 1,
      defaultValue: 24
    },
    {
      key: "handleSize",
      label: "Handle Size",
      type: "number",
      unit: "m",
      min: 0.1,
      max: 4,
      step: 0.05,
      defaultValue: 0.5
    }
  ]
};

