import type { PluginHandshakeModule, PluginDefinition, ReloadableDescriptor, ParameterSchema } from "./contracts";
import { createDxfController } from "./dxfController";
import { PLUGIN_VERSION } from "./pluginBuildInfo.generated";

const DESCRIPTOR_ID = "plugin.dxfDrawing.actor";

const schema: ParameterSchema = {
  id: DESCRIPTOR_ID,
  title: "DXF Drawing",
  params: [
    {
      key: "assetId",
      label: "DXF Asset",
      type: "file",
      accept: [".dxf"],
      dialogTitle: "Select DXF drawing",
      import: {
        mode: "import-asset",
        kind: "generic"
      }
    },
    {
      key: "inputUnits",
      label: "Input Units",
      type: "select",
      groupKey: "source",
      groupLabel: "Source",
      options: ["millimeters", "centimeters", "meters", "inches", "feet"],
      defaultValue: "millimeters"
    },
    {
      key: "drawingPlane",
      label: "Drawing Plane",
      type: "select",
      groupKey: "source",
      groupLabel: "Source",
      options: ["plan-xz", "front-xy", "side-zy"],
      defaultValue: "plan-xz"
    },
    {
      key: "curveResolution",
      label: "Curve Resolution",
      type: "number",
      groupKey: "source",
      groupLabel: "Source",
      min: 4,
      max: 256,
      step: 1,
      defaultValue: 32
    },
    {
      key: "invertColors",
      label: "Invert Colors",
      type: "boolean",
      groupKey: "display",
      groupLabel: "Display",
      defaultValue: false
    },
    {
      key: "showText",
      label: "Show Text",
      type: "boolean",
      groupKey: "display",
      groupLabel: "Display",
      defaultValue: true
    },
    {
      key: "layerStates",
      label: "Layers",
      type: "dxf-layer-states",
      groupKey: "layers",
      groupLabel: "Layers",
      defaultValue: {}
    }
  ]
};

interface DxfRuntime {
  assetId?: string;
}

export function createDxfDrawingDescriptor(): ReloadableDescriptor<DxfRuntime> {
  return {
    id: DESCRIPTOR_ID,
    kind: "actor",
    version: 1,
    schema,
    spawn: {
      actorType: "plugin",
      pluginType: DESCRIPTOR_ID,
      label: "DXF Drawing",
      description: "Renders imported DXF drawings as layered vector linework, including block inserts.",
      iconGlyph: "DXF",
      fileExtensions: [".dxf"]
    },
    createRuntime: ({ params }) => ({
      assetId: typeof params.assetId === "string" ? params.assetId : undefined
    }),
    updateRuntime(runtime, { params }) {
      runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    },
    sceneHooks: {
      createObject() {
        return createDxfController();
      },
      syncObject(context) {
        const controller = context.object as ReturnType<typeof createDxfController>;
        controller.sync(context);
      },
      disposeObject({ object }) {
        const controller = object as ReturnType<typeof createDxfController>;
        controller.dispose();
      }
    },
    status: {
      build({ actor, state, runtimeStatus }) {
        const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
        const asset = state.assets?.find((entry) => entry.id === assetId);
        const rs = runtimeStatus;
        return [
          { label: "Type", value: "DXF Drawing" },
          { label: "Asset", value: asset?.sourceFileName ?? (assetId ? "Missing asset reference" : "Not set") },
          { label: "Load State", value: rs?.values.loadState ?? "n/a" },
          { label: "Units", value: typeof actor.params.inputUnits === "string" ? actor.params.inputUnits : "millimeters" },
          { label: "Plane", value: typeof actor.params.drawingPlane === "string" ? actor.params.drawingPlane : "plan-xz" },
          { label: "Curve Resolution", value: typeof actor.params.curveResolution === "number" ? actor.params.curveResolution : 32 },
          { label: "Invert Colors", value: actor.params.invertColors === true },
          { label: "Show Text", value: actor.params.showText !== false },
          { label: "Layer Count", value: rs?.values.layerCount ?? "n/a" },
          { label: "Visible Layers", value: rs?.values.visibleLayerCount ?? "n/a" },
          { label: "Entity Count", value: rs?.values.entityCount ?? "n/a" },
          { label: "Polyline Segments", value: rs?.values.segmentCount ?? "n/a" },
          { label: "Text Count", value: rs?.values.textCount ?? "n/a" },
          { label: "Block Definitions", value: rs?.values.blockCount ?? "n/a" },
          { label: "Insert Count", value: rs?.values.insertCount ?? "n/a" },
          { label: "Bounds Min (m)", value: rs?.values.boundsMin ?? "n/a" },
          { label: "Bounds Max (m)", value: rs?.values.boundsMax ?? "n/a" },
          { label: "Warnings", value: rs?.values.warningCount ?? "n/a" },
          {
            label: "Last Update",
            value: rs?.updatedAtIso ? new Date(rs.updatedAtIso).toLocaleString() : "n/a"
          },
          { label: "Error", value: rs?.error ?? null, tone: "error" }
        ];
      }
    }
  };
}

export function createDxfDrawingPlugin(): PluginDefinition {
  return {
    id: "plugin.dxfDrawing",
    name: "DXF Drawing",
    actorDescriptors: [createDxfDrawingDescriptor()],
    componentDescriptors: []
  };
}

const handshake: PluginHandshakeModule = {
  manifest: {
    handshakeVersion: 1,
    id: "dxf.drawing",
    name: "DXF Drawing",
    version: PLUGIN_VERSION,
    description: "DXF drawing import with recursive block insert support.",
    engine: {
      minApiVersion: 1,
      maxApiVersion: 1
    }
  },
  createPlugin() {
    return createDxfDrawingPlugin();
  }
};

export { DESCRIPTOR_ID as DXF_DRAWING_DESCRIPTOR_ID, handshake };
export default handshake;
