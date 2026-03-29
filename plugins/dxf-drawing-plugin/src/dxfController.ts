import * as THREE from "three";
import type { ActorRuntimeStatus, DxfDrawingPlane, DxfInputUnits, DxfLayerStateMap, SceneHookContext } from "./contracts";
import { buildDxfScene, createDxfObject, disposeDxfObject, syncDxfAppearance } from "./dxfScene";
import { parseDxf } from "./parseDxf";
import type { BuiltDxfScene, ParsedDxfDocument } from "./dxfTypes";

const RENDER_ROOT_NAME = "dxf-drawing-render-root";

function nowIso(): string {
  return new Date().toISOString();
}

function parseInputUnits(params: Record<string, unknown>): DxfInputUnits {
  return params.inputUnits === "centimeters"
    || params.inputUnits === "meters"
    || params.inputUnits === "inches"
    || params.inputUnits === "feet"
    ? params.inputUnits
    : "millimeters";
}

function parseDrawingPlane(params: Record<string, unknown>): DxfDrawingPlane {
  return params.drawingPlane === "front-xy" || params.drawingPlane === "side-zy" ? params.drawingPlane : "plan-xz";
}

function parseCurveResolution(params: Record<string, unknown>): number {
  return Math.max(4, Math.floor(Number(params.curveResolution ?? 32)));
}

function parseLayerStates(params: Record<string, unknown>): DxfLayerStateMap {
  const value = params.layerStates;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as DxfLayerStateMap;
}

function statusValues(
  built: BuiltDxfScene,
  visibleLayerCount: number,
  params: Record<string, unknown>
): ActorRuntimeStatus["values"] {
  const unsupportedEntries = Object.entries(built.unsupportedEntityCounts);
  return {
    loadState: "loaded",
    units: parseInputUnits(params),
    plane: parseDrawingPlane(params),
    layerCount: built.layers.length,
    visibleLayerCount,
    entityCount: built.entityCount,
    segmentCount: built.segmentCount,
    textCount: built.textCount,
    blockCount: built.blockCount,
    insertCount: built.insertCount,
    boundsMin: built.bounds?.min ?? null,
    boundsMax: built.bounds?.max ?? null,
    unsupportedEntityCount: unsupportedEntries.reduce((sum, [, count]) => sum + count, 0),
    unsupportedEntityTypes: unsupportedEntries.map(([name, count]) => `${name}:${count}`),
    warningCount: built.warnings.length,
    warnings: built.warnings,
    layerOrder: built.layerOrder
  };
}

class DxfDrawingController extends THREE.Group {
  private parsedDocument: ParsedDxfDocument | null = null;
  private builtScene: BuiltDxfScene | null = null;
  private loadedAssetId = "";
  private pendingAssetId = "";
  private assetReloadToken = 0;
  private loadToken = 0;
  private buildSignature = "";
  private appearanceSignature = "";
  private statusSignature = "";

  constructor() {
    super();
    this.name = "dxf-drawing-container";
  }

  sync(context: SceneHookContext): void {
    const params = context.actor.params;
    const assetId = typeof params.assetId === "string" ? params.assetId : "";
    const reloadToken = typeof params.assetIdReloadToken === "number" ? params.assetIdReloadToken : 0;

    if (!assetId) {
      if (this.loadedAssetId || this.pendingAssetId) {
        this.resetState();
        context.setActorStatus(null);
      }
      return;
    }

    if (assetId !== this.loadedAssetId || reloadToken !== this.assetReloadToken) {
      this.pendingAssetId = assetId;
      this.assetReloadToken = reloadToken;
      void this.loadAsset(assetId, context);
    }

    if (!this.parsedDocument) {
      return;
    }

    const nextBuildSignature = JSON.stringify({
      assetId: this.loadedAssetId,
      assetReloadToken: this.assetReloadToken,
      inputUnits: parseInputUnits(params),
      drawingPlane: parseDrawingPlane(params),
      curveResolution: parseCurveResolution(params)
    });

    if (!this.builtScene || nextBuildSignature !== this.buildSignature) {
      this.builtScene = buildDxfScene(this.parsedDocument, {
        inputUnits: parseInputUnits(params),
        drawingPlane: parseDrawingPlane(params),
        curveResolution: parseCurveResolution(params)
      });
      this.buildSignature = nextBuildSignature;
      this.appearanceSignature = "";

      const previous = this.getObjectByName(RENDER_ROOT_NAME);
      if (previous) {
        disposeDxfObject(previous);
        this.remove(previous);
      }

      const layerStates = this.mergeLayerStates(parseLayerStates(params), this.builtScene);
      const renderRoot = createDxfObject(this.builtScene, layerStates, {
        invertColors: params.invertColors === true,
        showText: params.showText !== false,
        drawingPlane: parseDrawingPlane(params)
      });
      renderRoot.name = RENDER_ROOT_NAME;
      this.add(renderRoot);
    }

    const renderRoot = this.getObjectByName(RENDER_ROOT_NAME);
    if (!(renderRoot instanceof THREE.Group) || !this.builtScene) {
      return;
    }

    const layerStates = this.mergeLayerStates(parseLayerStates(params), this.builtScene);
    const nextAppearanceSignature = JSON.stringify({
      layerStates,
      invertColors: params.invertColors === true,
      showText: params.showText !== false
    });

    const visibleLayerCount =
      nextAppearanceSignature !== this.appearanceSignature
        ? syncDxfAppearance(renderRoot, layerStates, {
            invertColors: params.invertColors === true,
            showText: params.showText !== false
          })
        : Object.values(layerStates).filter((entry) => entry.visible !== false).length;

    this.appearanceSignature = nextAppearanceSignature;
    this.publishStatus(context, statusValues(this.builtScene, visibleLayerCount, params));
  }

  dispose(): void {
    this.resetState();
  }

  private resetState(): void {
    this.parsedDocument = null;
    this.builtScene = null;
    this.loadedAssetId = "";
    this.pendingAssetId = "";
    this.buildSignature = "";
    this.appearanceSignature = "";
    this.statusSignature = "";
    const renderRoot = this.getObjectByName(RENDER_ROOT_NAME);
    if (renderRoot) {
      disposeDxfObject(renderRoot);
      this.remove(renderRoot);
    }
  }

  private mergeLayerStates(existingStates: DxfLayerStateMap, built: BuiltDxfScene): DxfLayerStateMap {
    const merged: DxfLayerStateMap = {};
    for (const layer of built.layers) {
      const prior = existingStates[layer.layerName];
      merged[layer.layerName] = {
        name: layer.layerName,
        sourceColor: layer.sourceColor,
        color: typeof prior?.color === "string" ? prior.color : layer.sourceColor,
        visible: prior?.visible !== false
      };
    }
    return merged;
  }

  private publishStatus(context: SceneHookContext, values: ActorRuntimeStatus["values"], error?: string): void {
    const signature = JSON.stringify({ values, error });
    if (signature === this.statusSignature) {
      return;
    }
    this.statusSignature = signature;
    context.setActorStatus({
      values,
      error,
      updatedAtIso: nowIso()
    });
  }

  private async loadAsset(assetId: string, context: SceneHookContext): Promise<void> {
    const localToken = ++this.loadToken;
    context.setActorStatus({
      values: {
        loadState: "loading"
      },
      updatedAtIso: nowIso()
    });

    try {
      const bytes = await context.readAssetBytes(assetId);
      if (localToken !== this.loadToken) {
        return;
      }
      const text = new TextDecoder("utf-8").decode(bytes);
      this.parsedDocument = parseDxf(text);
      this.builtScene = null;
      this.loadedAssetId = assetId;
      this.pendingAssetId = "";
      this.buildSignature = "";
      this.appearanceSignature = "";
      this.statusSignature = "";
    } catch (error) {
      if (localToken !== this.loadToken) {
        return;
      }
      this.resetState();
      context.setActorStatus({
        values: {
          loadState: "failed"
        },
        error: error instanceof Error ? error.message : String(error),
        updatedAtIso: nowIso()
      });
    }
  }
}

export function createDxfController(): DxfDrawingController {
  return new DxfDrawingController();
}

