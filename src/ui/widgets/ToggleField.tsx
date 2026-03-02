import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";

interface ToggleFieldProps {
  label: string;
  description?: string;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  embedded?: boolean;
  onChange: (value: boolean) => void;
}

export function ToggleField(props: ToggleFieldProps) {
  const title = props.mixed ? "Mixed values" : props.checked ? "On" : "Off";
  const content = (
    <button
      type="button"
      className={`widget-toggle${props.checked ? " on" : ""}`}
      role="switch"
      aria-checked={props.checked}
      title={title}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="widget-toggle-track">
        <span className="widget-toggle-thumb" />
      </span>
      <span className="widget-toggle-label">{props.mixed ? "Mixed" : props.checked ? "On" : "Off"}</span>
    </button>
  );
  if (props.embedded) {
    return content;
  }
  return <InspectorFieldRow label={props.label} description={props.description}>{content}</InspectorFieldRow>;
}
