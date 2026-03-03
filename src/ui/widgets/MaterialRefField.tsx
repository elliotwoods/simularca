import React from "react";
import { useAppStore } from "@/app/useAppStore";
import { Material } from "@/core/types";

interface MaterialRefFieldProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  label?: string;
  placeholder?: string;
}

export const MaterialRefField: React.FC<MaterialRefFieldProps> = ({
  value,
  onChange,
  label,
  placeholder = "None (Default)"
}) => {
  const materials = useAppStore((s) => s.state.materials);
  const materialList = Object.values(materials).sort((a, b) => a.name.localeCompare(b.name));

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
