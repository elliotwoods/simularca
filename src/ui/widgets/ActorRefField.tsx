import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";

interface ActorRefOption {
  id: string;
  label: string;
}

interface ActorRefFieldProps {
  label: string;
  description?: string;
  value: string;
  options: ActorRefOption[];
  mixed?: boolean;
  disabled?: boolean;
  showReset?: boolean;
  onReset?: () => void;
  onChange: (value: string) => void;
}

export function ActorRefField(props: ActorRefFieldProps) {
  const selectedValue = props.mixed ? "" : props.value;

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
        value={selectedValue}
        disabled={props.disabled}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      >
        {props.mixed ? <option value="">Mixed...</option> : null}
        <option value="">(none)</option>
        {props.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </InspectorFieldRow>
  );
}
