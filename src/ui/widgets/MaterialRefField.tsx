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

const MaterialRefFieldImpl: React.FC<MaterialRefFieldProps> = ({
  value,
  onChange,
  label,
  placeholder = "None (Default)",
  extraMaterials
}) => {
  const materials = useAppStore((s) => s.state.materials);
  // Memoize sort — localeCompare on 100 items is expensive and materials rarely change.
  const materialList = React.useMemo(
    () => {
      const merged = extraMaterials ? { ...extraMaterials, ...materials } : materials;
      return Object.values(merged).sort((a, b) => a.name.localeCompare(b.name));
    },
    [materials, extraMaterials]
  );

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

// Memo with custom comparator: skip re-render when only onChange changes.
// onChange is always a new closure from the parent's map(), but value/label are stable
// when material assignments haven't changed. If value changes (user picks a material),
// the comparator returns false and the component re-renders with a fresh onChange.
export const MaterialRefField = React.memo(MaterialRefFieldImpl, (prev, next) =>
  prev.value === next.value &&
  prev.label === next.label &&
  prev.placeholder === next.placeholder &&
  prev.extraMaterials === next.extraMaterials
);
