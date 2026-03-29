import type { ReloadableDescriptor } from "@/core/hotReload/types";
import type { DxfDrawingPlane, DxfInputUnits, DxfLayerStateMap, DxfSourcePlane } from "@/core/types";
import { DXF_REFERENCE_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface DxfReferenceRuntime {
  assetId?: string;
  inputUnits: DxfInputUnits;
  sourcePlane: DxfSourcePlane;
  drawingPlane: DxfDrawingPlane;
  invertColors: boolean;
  showText: boolean;
  curveResolution: number;
  layerCount: number;
}

function getLayerStates(params: Record<string, unknown>): DxfLayerStateMap {
  const value = params.layerStates;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as DxfLayerStateMap;
}

function getSourcePlane(value: unknown): DxfSourcePlane {
  switch (value) {
    case "xy":
    case "yz":
    case "xz":
      return value;
    case "auto":
    default:
      return "auto";
  }
}

export const dxfReferenceActorDescriptor: ReloadableDescriptor<DxfReferenceRuntime> = {
  id: "actor.dxfReference",
  kind: "actor",
  version: 1,
  schema: DXF_REFERENCE_ACTOR_SCHEMA,
  spawn: {
    actorType: "dxf-reference",
    label: "DXF Drawing",
    description: "Renders imported DXF drawings as layered vector linework.",
    iconGlyph: "DXF",
    fileExtensions: [".dxf"]
  },
  createRuntime: ({ params }) => ({
    assetId: typeof params.assetId === "string" ? params.assetId : undefined,
    inputUnits: params.inputUnits === "centimeters"
      || params.inputUnits === "meters"
      || params.inputUnits === "inches"
      || params.inputUnits === "feet"
      ? params.inputUnits
      : "millimeters",
    sourcePlane: getSourcePlane(params.sourcePlane),
    drawingPlane: params.drawingPlane === "front-xy" || params.drawingPlane === "side-zy" ? params.drawingPlane : "plan-xz",
    invertColors: params.invertColors === true,
    showText: params.showText !== false,
    curveResolution: Math.max(4, Math.floor(Number(params.curveResolution ?? 32))),
    layerCount: Object.keys(getLayerStates(params)).length
  }),
  updateRuntime(runtime, { params }) {
    runtime.assetId = typeof params.assetId === "string" ? params.assetId : runtime.assetId;
    runtime.inputUnits = params.inputUnits === "centimeters"
      || params.inputUnits === "meters"
      || params.inputUnits === "inches"
      || params.inputUnits === "feet"
      ? params.inputUnits
      : "millimeters";
    runtime.sourcePlane = getSourcePlane(params.sourcePlane);
    runtime.drawingPlane = params.drawingPlane === "front-xy" || params.drawingPlane === "side-zy" ? params.drawingPlane : "plan-xz";
    runtime.invertColors = params.invertColors === true;
    runtime.showText = params.showText !== false;
    runtime.curveResolution = Math.max(4, Math.floor(Number(params.curveResolution ?? runtime.curveResolution ?? 32)));
    runtime.layerCount = Object.keys(getLayerStates(params)).length;
  },
  status: {
    build({ actor, state, runtimeStatus }) {
      const assetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
      const asset = state.assets.find((entry) => entry.id === assetId);
      const layerStates = getLayerStates(actor.params);
      const visibleLayerCount = Object.values(layerStates).filter((entry) => entry.visible !== false).length;
      return [
        { label: "Type", value: "DXF Drawing" },
        { label: "Asset", value: asset?.sourceFileName ?? (assetId ? "Missing asset reference" : "Not set") },
        { label: "Load State", value: runtimeStatus?.values.loadState ?? "n/a" },
        { label: "Units", value: typeof actor.params.inputUnits === "string" ? actor.params.inputUnits : "millimeters" },
        { label: "Source Plane", value: typeof actor.params.sourcePlane === "string" ? actor.params.sourcePlane : "auto" },
        { label: "Resolved Plane", value: runtimeStatus?.values.resolvedSourcePlane ?? "n/a" },
        { label: "Plane", value: typeof actor.params.drawingPlane === "string" ? actor.params.drawingPlane : "plan-xz" },
        { label: "Curve Resolution", value: typeof actor.params.curveResolution === "number" ? actor.params.curveResolution : 32 },
        { label: "Invert Colors", value: actor.params.invertColors === true },
        { label: "Show Text", value: actor.params.showText !== false },
        { label: "Layer Count", value: runtimeStatus?.values.layerCount ?? Object.keys(layerStates).length },
        { label: "Visible Layers", value: runtimeStatus?.values.visibleLayerCount ?? visibleLayerCount },
        { label: "Entity Count", value: runtimeStatus?.values.entityCount ?? "n/a" },
        { label: "Polyline Segments", value: runtimeStatus?.values.segmentCount ?? "n/a" },
        { label: "Text Count", value: runtimeStatus?.values.textCount ?? "n/a" },
        { label: "Unsupported", value: runtimeStatus?.values.unsupportedEntityCounts ?? "n/a" },
        { label: "Bounds Min (m)", value: runtimeStatus?.values.boundsMin ?? "n/a" },
        { label: "Bounds Max (m)", value: runtimeStatus?.values.boundsMax ?? "n/a" },
        {
          label: "Last Update",
          value: runtimeStatus?.updatedAtIso ? new Date(runtimeStatus.updatedAtIso).toLocaleString() : "n/a"
        },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
    }
  }
};

