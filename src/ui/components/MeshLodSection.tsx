import { useState } from "react";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode } from "@/core/types";
import type { ProjectAssetRef } from "@/types/ipc";
import { detectMeshFormat, type DecimationResult } from "@/features/mesh/meshDecimation";
import { MeshLodGenerateModal } from "@/ui/components/MeshLodGenerateModal";

interface Props {
  kernel: AppKernel;
  actor: ActorNode;
  assets: ProjectAssetRef[];
  activeProjectPath: string | null;
  readOnly: boolean;
  onParamsChange: (key: string, value: string) => void;
}

export function MeshLodSection({ kernel, actor, assets, activeProjectPath, readOnly, onParamsChange }: Props) {
  const parentAssetId = typeof actor.params.assetId === "string" ? actor.params.assetId : "";
  const parentAsset = assets.find((entry) => entry.id === parentAssetId);
  const lodAssets = assets.filter((entry) => entry.lodOf === parentAssetId);
  const [modalOpen, setModalOpen] = useState(false);

  const runtimeStatus = kernel.store.getState().state.actorStatusByActorId[actor.id];
  const skinnedMeshCount = Number(runtimeStatus?.values?.skinnedMeshCount ?? 0);
  const morphTargetMeshCount = Number(runtimeStatus?.values?.morphTargetMeshCount ?? 0);
  const isSkinned = skinnedMeshCount > 0 || morphTargetMeshCount > 0;
  const originalTriangleCount = Number(runtimeStatus?.values?.triangleCount ?? 0);

  const detectedFormat = parentAsset
    ? detectMeshFormat(parentAsset.sourceFileName) ?? detectMeshFormat(parentAsset.relativePath)
    : null;
  const canGenerate = !readOnly && !!activeProjectPath && !!parentAsset && !isSkinned && detectedFormat !== null;

  const onComplete = async (results: DecimationResult[]) => {
    if (!parentAsset || !activeProjectPath) return;
    const baseName = parentAsset.sourceFileName.replace(/\.[^.]+$/, "");
    for (const result of results) {
      const pct = Math.round(result.ratio * 100);
      const fileName = `${baseName}_lod_${pct}.glb`;
      const newAsset = await kernel.storage.writeGeneratedAsset({
        projectPath: activeProjectPath,
        bytes: result.glbBytes,
        fileName,
        kind: "generic"
      });
      const enriched: ProjectAssetRef = {
        ...newAsset,
        lodOf: parentAsset.id,
        lodRatio: result.ratio,
        lodTriangleCount: result.triangleCount,
        lodOriginalTriangleCount: result.originalTriangleCount
      };
      kernel.store.getState().actions.addAssets([enriched]);
    }
    kernel.store.getState().actions.setStatus(
      `Generated ${results.length} LOD${results.length === 1 ? "" : "s"} for ${parentAsset.sourceFileName}`
    );
  };

  const loadSourceBytes = async () => {
    if (!parentAsset || !activeProjectPath) {
      throw new Error("No active project / source asset.");
    }
    return kernel.storage.readAssetBytes({
      projectPath: activeProjectPath,
      relativePath: parentAsset.relativePath
    });
  };

  const onDeleteLod = async (asset: ProjectAssetRef) => {
    if (!activeProjectPath) return;
    try {
      await kernel.storage.deleteAsset({ projectPath: activeProjectPath, relativePath: asset.relativePath });
      kernel.store.getState().actions.removeAsset(asset.id);
      // Clear any actor refs that pointed at the deleted LOD.
      const stateAfter = kernel.store.getState().state;
      for (const node of Object.values(stateAfter.actors)) {
        if (node.params.viewportLodAssetId === asset.id) {
          kernel.store.getState().actions.updateActorParams(node.id, { viewportLodAssetId: null });
        }
        if (node.params.renderLodAssetId === asset.id) {
          kernel.store.getState().actions.updateActorParams(node.id, { renderLodAssetId: null });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      kernel.store.getState().actions.setStatus(`Failed to delete LOD: ${message}`);
    }
  };

  if (!parentAsset) {
    return <p className="panel-empty">Set a mesh asset before generating LODs.</p>;
  }

  return (
    <div className="mesh-lod-section">
      <div className="mesh-lod-section__summary">
        <strong>Original:</strong> {parentAsset.sourceFileName}
        {originalTriangleCount > 0 ? ` — ${originalTriangleCount.toLocaleString()} tris` : null}
      </div>
      {isSkinned ? (
        <p className="panel-empty">Skinned or morph-target meshes cannot be decimated. Bake animations to keyframes first.</p>
      ) : null}
      <div className="mesh-lod-section__list">
        {lodAssets.length === 0 ? (
          <p className="panel-empty">No LODs generated yet.</p>
        ) : (
          <table className="mesh-lod-table">
            <thead>
              <tr>
                <th>Ratio</th>
                <th>Triangles</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lodAssets.map((lod) => {
                const ratioPct = typeof lod.lodRatio === "number" ? `${Math.round(lod.lodRatio * 100)}%` : "?";
                const tris = typeof lod.lodTriangleCount === "number" ? lod.lodTriangleCount.toLocaleString() : "?";
                const kb = (lod.byteSize / 1024).toFixed(0);
                return (
                  <tr key={lod.id}>
                    <td>{ratioPct}</td>
                    <td>{tris}</td>
                    <td>{kb} KB</td>
                    <td>
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        disabled={readOnly}
                        onClick={() => { void onDeleteLod(lod); }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {!isSkinned ? (
        <div className="mesh-lod-section__generate">
          <button
            type="button"
            className="button button--primary"
            disabled={!canGenerate}
            onClick={() => setModalOpen(true)}
          >
            Generate LODs…
          </button>
          {!detectedFormat && parentAsset ? (
            <p className="panel-error">
              Unsupported mesh format. Supported: glb, gltf, fbx, obj, dae.
            </p>
          ) : null}
        </div>
      ) : null}
      {parentAsset && detectedFormat ? (
        <MeshLodGenerateModal
          open={modalOpen}
          sourceFileName={parentAsset.sourceFileName}
          sourceTriangleCount={originalTriangleCount}
          format={detectedFormat}
          loadSourceBytes={loadSourceBytes}
          onComplete={onComplete}
          onClose={() => setModalOpen(false)}
          onError={(message) => {
            kernel.store.getState().actions.setStatus(`LOD generation failed: ${message}`);
          }}
        />
      ) : null}
      <div className="mesh-lod-section__selectors">
        <LodSelect
          label="Viewport LOD"
          value={typeof actor.params.viewportLodAssetId === "string" ? actor.params.viewportLodAssetId : ""}
          parentAsset={parentAsset}
          originalTriangleCount={originalTriangleCount}
          lodAssets={lodAssets}
          disabled={readOnly}
          onChange={(next) => onParamsChange("viewportLodAssetId", next)}
        />
        <LodSelect
          label="Render LOD"
          value={typeof actor.params.renderLodAssetId === "string" ? actor.params.renderLodAssetId : ""}
          parentAsset={parentAsset}
          originalTriangleCount={originalTriangleCount}
          lodAssets={lodAssets}
          disabled={readOnly}
          onChange={(next) => onParamsChange("renderLodAssetId", next)}
        />
      </div>
    </div>
  );
}

interface LodSelectProps {
  label: string;
  value: string;
  parentAsset: ProjectAssetRef;
  originalTriangleCount: number;
  lodAssets: ProjectAssetRef[];
  disabled: boolean;
  onChange: (next: string) => void;
}

function LodSelect({ label, value, originalTriangleCount, lodAssets, disabled, onChange }: LodSelectProps) {
  const originalLabel = originalTriangleCount > 0
    ? `Original (${originalTriangleCount.toLocaleString()} tris)`
    : "Original";
  return (
    <div className="widget-field">
      <label className="widget-label">{label}</label>
      <select
        className="widget-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{originalLabel}</option>
        {lodAssets.map((lod) => {
          const ratioPct = typeof lod.lodRatio === "number" ? `${Math.round(lod.lodRatio * 100)}%` : "?";
          const tris = typeof lod.lodTriangleCount === "number" ? `${lod.lodTriangleCount.toLocaleString()} tris` : "";
          return (
            <option key={lod.id} value={lod.id}>
              {tris ? `${ratioPct} (${tris})` : ratioPct}
            </option>
          );
        })}
      </select>
    </div>
  );
}
