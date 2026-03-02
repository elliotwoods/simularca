import { useEffect, useState } from "react";
import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";

interface TextFieldProps {
  label: string;
  description?: string;
  value: string;
  mixed?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function TextField(props: TextFieldProps) {
  const [draft, setDraft] = useState(props.value);

  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);

  return (
    <InspectorFieldRow label={props.label} description={props.description}>
      <input
        className="widget-text"
        value={props.mixed ? "" : draft}
        placeholder={props.mixed ? "Mixed" : undefined}
        disabled={props.disabled}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          props.onChange(next);
        }}
      />
    </InspectorFieldRow>
  );
}
