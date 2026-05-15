import React from "react";
import { useAppStore } from "@/app/useAppStore";
import { useKernel } from "@/app/useKernel";

interface ImageRefFieldProps {
  value: string | null;
  onChange: (assetId: string | null) => void;
  label?: string;
}

export const ImageRefField: React.FC<ImageRefFieldProps> = ({ value, onChange, label }) => {
  const assets = useAppStore((s) => s.state.assets);
  const activeProject = useAppStore((s) => s.state.activeProject);
  const kernel = useKernel();

  const imageAssets = assets.filter((a) => a.kind === "image").sort((a, b) => a.sourceFileName.localeCompare(b.sourceFileName));

  const handleImport = async () => {
    if (!window.electronAPI || !activeProject) return;
    const sourcePath = await window.electronAPI.openFileDialog({
      title: "Select image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif"] }]
    });
    if (!sourcePath) return;
    const asset = await window.electronAPI.importAsset({ projectPath: activeProject.path, sourcePath, kind: "image" });
    kernel.store.getState().actions.addAssets([asset]);
    onChange(asset.id);
  };

  return (
    <div className="widget-image-ref">
      {label && <label className="widget-label">{label}</label>}
      <div className="widget-image-ref-row">
        <select
          className="widget-select"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">None</option>
          {imageAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.sourceFileName}
            </option>
          ))}
        </select>
        {window.electronAPI ? (
          <button className="widget-button" onClick={() => { void handleImport(); }}>
            Import…
          </button>
        ) : null}
      </div>
    </div>
  );
};
