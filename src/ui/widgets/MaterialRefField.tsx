import React from "react";
import { useAppStore } from "@/app/useAppStore";
import { Material } from "@/core/types";

interface MaterialRefFieldProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  label?: string;
  placeholder?: string;
  extraMaterials?: Record<string, Material>;
}

export const MaterialRefField: React.FC<MaterialRefFieldProps> = ({
  value,
  onChange,
  label,
  placeholder = "None (Default)",
  extraMaterials
}) => {
  const materials = useAppStore((s) => s.state.materials);
  // Merge extra (actor-local) materials with global ones; local materials come first
  const merged = extraMaterials ? { ...extraMaterials, ...materials } : materials;
  const materialList = Object.values(merged).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="widget-material-ref">
      {label && <label className="widget-label">{label}</label>}
      <select
        className="widget-select"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">{placeholder}</option>
        {materialList.map((mat) => (
          <option key={mat.id} value={mat.id}>
            {mat.name}
          </option>
        ))}
      </select>
    </div>
  );
};
