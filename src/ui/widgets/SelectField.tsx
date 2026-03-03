import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";

interface SelectFieldProps {
  label: string;
  description?: string;
  value: string;
  options: string[];
  mixed?: boolean;
  disabled?: boolean;
  showReset?: boolean;
  onReset?: () => void;
  onChange: (value: string) => void;
}

export function SelectField(props: SelectFieldProps) {
  return (
    <InspectorFieldRow
      label={props.label}
      description={props.description}
      showReset={props.showReset}
      onReset={props.onReset}
      resetDisabled={props.disabled}
    >
      <select
        className="widget-select"
        value={props.mixed ? "" : props.value}
        disabled={props.disabled}
        onChange={(event) => {
          if (!event.target.value) {
            return;
          }
          props.onChange(event.target.value);
        }}
      >
        {props.mixed ? <option value="">Mixed...</option> : null}
        {props.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </InspectorFieldRow>
  );
}
