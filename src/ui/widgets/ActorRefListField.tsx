import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";

interface ActorRefOption {
  id: string;
  label: string;
}

interface ActorRefListFieldProps {
  label: string;
  description?: string;
  values: string[];
  options: ActorRefOption[];
  mixed?: boolean;
  disabled?: boolean;
  onChange: (values: string[]) => void;
}

export function ActorRefListField(props: ActorRefListFieldProps) {
  const selected = props.mixed ? [] : props.values;
  const optionIds = new Set(props.options.map((option) => option.id));
  const canDrop = !props.disabled;
  const hasValues = selected.length > 0;

  const appendFromDrop = (actorId: string): void => {
    if (!optionIds.has(actorId)) {
      return;
    }
    if (selected.includes(actorId)) {
      return;
    }
    props.onChange([...selected, actorId]);
  };

  return (
    <InspectorFieldRow label={props.label} description={props.description}>
      <div
        className={`widget-actor-ref-list${canDrop ? " droppable" : ""}${!hasValues ? " empty" : ""}`}
        onDragOver={(event) => {
          if (!canDrop) {
            return;
          }
          event.preventDefault();
        }}
        onDrop={(event) => {
          if (!canDrop) {
            return;
          }
          event.preventDefault();
          const actorId = event.dataTransfer.getData("text/plain");
          if (!actorId) {
            return;
          }
          appendFromDrop(actorId);
        }}
      >
        <select
          className="widget-select widget-actor-ref-list-select"
          multiple
          size={Math.min(10, Math.max(6, props.options.length || 6))}
          value={selected}
          disabled={props.disabled}
          onChange={(event) => {
            const next = Array.from(event.target.selectedOptions).map((option) => option.value);
            props.onChange(next);
          }}
        >
          {props.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {!hasValues ? <div className="widget-actor-ref-list-empty">Drop primitive actor(s) here</div> : null}
      </div>
    </InspectorFieldRow>
  );
}
