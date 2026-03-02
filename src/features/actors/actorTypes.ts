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
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "pointSize", label: "Point Size", type: "number", min: 0.001, max: 0.2, step: 0.001 }
  ]
};

export const PLUGIN_ACTOR_SCHEMA: ParameterSchema = {
  id: "actor.plugin",
  title: "Plugin Actor",
  params: [
    { key: "pluginId", label: "Plugin Id", type: "string" },
    { key: "entry", label: "Entry", type: "string" }
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
      options: ["cube", "sphere", "torus", "cylinder", "cone", "icosahedron"]
    },
    {
      key: "size",
      label: "Size",
      type: "number",
      min: 0.05,
      max: 50,
      step: 0.05
    },
    {
      key: "segments",
      label: "Segments",
      type: "number",
      min: 3,
      max: 64,
      step: 1
    },
    {
      key: "color",
      label: "Color",
      type: "string"
    },
    {
      key: "wireframe",
      label: "Wireframe",
      type: "boolean"
    }
  ]
};

