import React, { useState } from "react";
import { useAppStore } from "@/app/useAppStore";
import { Material } from "@/core/types";
import { ColorField, NumberField, SelectField, TextField, ToggleField } from "@/ui/widgets";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faTrash, faXmark } from "@fortawesome/free-solid-svg-icons";

interface MaterialsModalProps {
  open: boolean;
  onClose: () => void;
}

export const MaterialsModal: React.FC<MaterialsModalProps> = ({ open, onClose }) => {
  const materials = useAppStore((s) => s.state.materials);
  const actions = useAppStore((s) => s.actions);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);

  if (!open) return null;

  const materialList = Object.values(materials).sort((a, b) => a.name.localeCompare(b.name));
  const selectedMaterial = selectedMaterialId ? materials[selectedMaterialId] : null;

  const handleCreate = () => {
    const id = actions.createMaterial();
    setSelectedMaterialId(id);
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Are you sure you want to delete this material?")) {
      actions.deleteMaterial(id);
      if (selectedMaterialId === id) {
        setSelectedMaterialId(null);
      }
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content materials-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Material Library</h3>
          <button className="modal-close" onClick={onClose}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </header>

        <div className="materials-modal-body">
          <aside className="materials-sidebar">
            <div className="materials-sidebar-actions">
              <button className="widget-button primary" onClick={handleCreate}>
                <FontAwesomeIcon icon={faPlus} /> New Material
              </button>
            </div>
            <ul className="materials-list">
              {materialList.map((mat) => (
                <li
                  key={mat.id}
                  className={`material-item ${selectedMaterialId === mat.id ? "selected" : ""}`}
                  onClick={() => setSelectedMaterialId(mat.id)}
                >
                  <div
                    className="material-preview-swatch"
                    style={{ backgroundColor: mat.albedo, opacity: mat.opacity }}
                  />
                  <span className="material-name">{mat.name}</span>
                  <button className="material-delete-btn" onClick={(e) => handleDelete(mat.id, e)}>
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <main className="material-editor">
            {selectedMaterial ? (
              <div className="material-editor-fields">
                <TextField
                  label="Name"
                  value={selectedMaterial.name}
                  onChange={(val) => actions.updateMaterial(selectedMaterial.id, { name: val })}
                />
                <ColorField
                  label="Albedo"
                  value={selectedMaterial.albedo}
                  onChange={(val) => actions.updateMaterial(selectedMaterial.id, { albedo: val })}
                />
                <div className="material-editor-row">
                  <NumberField
                    label="Metalness"
                    value={selectedMaterial.metalness}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(val) => actions.updateMaterial(selectedMaterial.id, { metalness: val })}
                  />
                  <NumberField
                    label="Roughness"
                    value={selectedMaterial.roughness}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(val) => actions.updateMaterial(selectedMaterial.id, { roughness: val })}
                  />
                </div>
                <div className="material-editor-row">
                  <ColorField
                    label="Emissive"
                    value={selectedMaterial.emissive}
                    onChange={(val) => actions.updateMaterial(selectedMaterial.id, { emissive: val })}
                  />
                  <NumberField
                    label="Intensity"
                    value={selectedMaterial.emissiveIntensity}
                    min={0}
                    step={0.1}
                    onChange={(val) => actions.updateMaterial(selectedMaterial.id, { emissiveIntensity: val })}
                  />
                </div>
                <div className="material-editor-row">
                  <NumberField
                    label="Opacity"
                    value={selectedMaterial.opacity}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(val) => actions.updateMaterial(selectedMaterial.id, { opacity: val })}
                  />
                  <ToggleField
                    label="Transparent"
                    checked={selectedMaterial.transparent}
                    onChange={(val) => actions.updateMaterial(selectedMaterial.id, { transparent: val })}
                  />
                </div>
                <SelectField
                  label="Side"
                  value={selectedMaterial.side}
                  options={["front", "back", "double"]}
                  onChange={(val) => actions.updateMaterial(selectedMaterial.id, { side: val as any })}
                />
                <ToggleField
                  label="Wireframe"
                  checked={selectedMaterial.wireframe}
                  onChange={(val) => actions.updateMaterial(selectedMaterial.id, { wireframe: val })}
                />
              </div>
            ) : (
              <div className="panel-empty">Select or create a material to edit its properties.</div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};
