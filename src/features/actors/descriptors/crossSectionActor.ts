import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { CROSS_SECTION_ACTOR_SCHEMA } from "@/features/actors/actorTypes";

interface CrossSectionRuntime {
  flipNormal: boolean;
  showPlaneGizmo: boolean;
  affectedActorIds: string[];
  edgeHighlightEnabled: boolean;
  edgeHighlightColor: string;
  edgeWidthPx: number;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readColor(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function formatVector(value: unknown): string {
  if (!Array.isArray(value) || value.length < 3) {
    return "n/a";
  }
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
    return "n/a";
  }
  return `${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}`;
}

export const crossSectionActorDescriptor: ReloadableDescriptor<CrossSectionRuntime> = {
  id: "actor.crossSection",
  kind: "actor",
  version: 1,
  schema: CROSS_SECTION_ACTOR_SCHEMA,
  spawn: {
    actorType: "cross-section",
    label: "Cross-Section",
    description: "Slices the scene at a plane and highlights mesh surfaces near the cut.",
    iconGlyph: "XS"
  },
  createRuntime: ({ params }) => ({
    flipNormal: readBoolean(params.flipNormal, false),
    showPlaneGizmo: readBoolean(params.showPlaneGizmo, true),
    affectedActorIds: readStringArray(params.affectedActorIds, []),
    edgeHighlightEnabled: readBoolean(params.edgeHighlightEnabled, true),
    edgeHighlightColor: readColor(params.edgeHighlightColor, "#ff8800"),
    edgeWidthPx: readNumber(params.edgeWidthPx, 2)
  }),
  updateRuntime(runtime, { params }) {
    runtime.flipNormal = readBoolean(params.flipNormal, runtime.flipNormal);
    runtime.showPlaneGizmo = readBoolean(params.showPlaneGizmo, runtime.showPlaneGizmo);
    runtime.affectedActorIds = readStringArray(params.affectedActorIds, runtime.affectedActorIds);
    runtime.edgeHighlightEnabled = readBoolean(params.edgeHighlightEnabled, runtime.edgeHighlightEnabled);
    runtime.edgeHighlightColor = readColor(params.edgeHighlightColor, runtime.edgeHighlightColor);
    runtime.edgeWidthPx = readNumber(params.edgeWidthPx, runtime.edgeWidthPx);
  },
  status: {
    build({ actor, runtimeStatus }) {
      const values = runtimeStatus?.values ?? {};
      const affectedList = readStringArray(actor.params.affectedActorIds, []);
      const renderEngine = typeof values.renderEngine === "string" ? values.renderEngine : "?";
      const isClippingGroup = values.clipGroupIsClippingGroup === true;
      const childNames = Array.isArray(values.clipGroupChildNames) ? values.clipGroupChildNames as string[] : [];
      const matTypes = (values.clipDescendantMaterialTypes && typeof values.clipDescendantMaterialTypes === "object")
        ? values.clipDescendantMaterialTypes as Record<string, number>
        : {};
      const matTypeSummary = Object.entries(matTypes)
        .map(([type, count]) => `${type}×${count}`)
        .join(", ") || "none";
      const reparentToClip = typeof values.reparentToClipTotal === "number" ? values.reparentToClipTotal : 0;
      const reparentToScene = typeof values.reparentToSceneTotal === "number" ? values.reparentToSceneTotal : 0;
      const lineCount = typeof values.clipDescendantLineCount === "number" ? values.clipDescendantLineCount : 0;
      const pointsCount = typeof values.clipDescendantPointsCount === "number" ? values.clipDescendantPointsCount : 0;
      const spriteCount = typeof values.clipDescendantSpriteCount === "number" ? values.clipDescendantSpriteCount : 0;
      const unsupportedTypes = (values.unsupportedMaterialTypes && typeof values.unsupportedMaterialTypes === "object")
        ? values.unsupportedMaterialTypes as Record<string, number>
        : {};
      const unsupportedSummary = Object.entries(unsupportedTypes)
        .map(([t, c]) => `${t}×${c}`)
        .join(", ");
      const gizmoMisparented = values.gizmoMisparented === true;
      const gizmoPositionMismatch = values.gizmoPositionMismatch === true;
      const activeUnionPlane = Array.isArray(values.activeUnionPlaneViewSpace) ? values.activeUnionPlaneViewSpace as number[] : null;
      const gizmoLocalPos = formatVector(values.gizmoLocalPos);
      const gizmoActorPos = formatVector(values.gizmoActorPos);
      const gizmoParentName = typeof values.gizmoParentName === "string" ? values.gizmoParentName : null;
      return [
        { label: "Type", value: "Cross-Section" },
        { label: "Active", value: values.active === true },
        { label: "Render Engine", value: renderEngine },
        { label: "Plane Origin (world)", value: formatVector(values.worldOrigin) },
        { label: "Plane Normal (world)", value: formatVector(values.worldNormal) },
        {
          label: "Affecting",
          value: affectedList.length === 0
            ? "all supported actors"
            : `${affectedList.length} actor${affectedList.length === 1 ? "" : "s"}`
        },
        { label: "Affect Mode", value: typeof values.affectMode === "string" ? values.affectMode : "n/a" },
        { label: "Applied Actors / Frame", value: typeof values.appliedActorCount === "number" ? values.appliedActorCount : 0 },
        { label: "Material Patches / Frame", value: typeof values.materialPatchCount === "number" ? values.materialPatchCount : 0 },
        {
          label: "ClippingGroup",
          value: `${isClippingGroup ? "yes" : "fallback Group"} · enabled=${values.clipGroupEnabled === true} · planes=${values.clipGroupPlaneCount ?? 0} · children=${values.clipGroupChildCount ?? 0}`,
          tone: isClippingGroup || renderEngine !== "webgpu" ? "default" : "warning"
        },
        { label: "Clip Group Attached", value: values.clipGroupAttachedToScene === true },
        { label: "Clip Children", value: childNames.length > 0 ? childNames.join(", ") : "(none)" },
        { label: "Clip Descendant Meshes", value: typeof values.clipDescendantMeshCount === "number" ? values.clipDescendantMeshCount : 0 },
        { label: "Clip Descendant Lines / Points / Sprites", value: `${lineCount} / ${pointsCount} / ${spriteCount}` },
        { label: "Clip Descendant Material Types", value: matTypeSummary },
        {
          label: "Material Flags (transparent / alphaTest / a2c / 2-side / back / no-depthWrite)",
          value: `${typeof values.clipDescendantMaterialsTransparent === "number" ? values.clipDescendantMaterialsTransparent : 0} / ${typeof values.clipDescendantMaterialsAlphaTest === "number" ? values.clipDescendantMaterialsAlphaTest : 0} / ${typeof values.clipDescendantMaterialsAlphaToCoverage === "number" ? values.clipDescendantMaterialsAlphaToCoverage : 0} / ${typeof values.clipDescendantMaterialsDoubleSide === "number" ? values.clipDescendantMaterialsDoubleSide : 0} / ${typeof values.clipDescendantMaterialsBackSide === "number" ? values.clipDescendantMaterialsBackSide : 0} / ${typeof values.clipDescendantMaterialsDepthWriteFalse === "number" ? values.clipDescendantMaterialsDepthWriteFalse : 0}`
        },
        {
          label: "Unsupported Materials",
          value: unsupportedSummary || "(none)",
          tone: unsupportedSummary ? "warning" : "default"
        },
        { label: "Clip Reparents (→clip / →scene)", value: `${reparentToClip} / ${reparentToScene}` },
        {
          label: "Gizmo Parent",
          value: gizmoParentName ?? "(unknown)",
          tone: gizmoMisparented ? "warning" : "default"
        },
        {
          label: "Gizmo Local Pos / Actor Pos",
          value: `${gizmoLocalPos} / ${gizmoActorPos}`,
          tone: gizmoPositionMismatch ? "warning" : "default"
        },
        {
          label: "Active Union Plane (view-space)",
          value: activeUnionPlane && activeUnionPlane.length === 4
            && typeof activeUnionPlane[0] === "number"
            && typeof activeUnionPlane[1] === "number"
            && typeof activeUnionPlane[2] === "number"
            && typeof activeUnionPlane[3] === "number"
            ? `n=(${activeUnionPlane[0].toFixed(3)}, ${activeUnionPlane[1].toFixed(3)}, ${activeUnionPlane[2].toFixed(3)}) c=${activeUnionPlane[3].toFixed(3)}`
            : "(unavailable)"
        },
        {
          label: "Edge",
          value: actor.params.edgeHighlightEnabled !== false
            ? `${actor.params.edgeHighlightColor ?? "#ff8800"} · ${actor.params.edgeWidthPx ?? 2}px`
            : "off"
        },
        { label: "Error", value: runtimeStatus?.error ?? null, tone: "error" }
      ];
    }
  }
};
