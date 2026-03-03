import type { ReactNode } from "react";

interface SegmentedOption {
  value: string;
  label: string;
  icon?: ReactNode;
  title?: string;
}

interface SegmentedControlProps {
  value: string;
  options: SegmentedOption[];
  disabled?: boolean;
  compact?: boolean;
  onChange: (value: string) => void;
}

export function SegmentedControl(props: SegmentedControlProps) {
  return (
    <div className={`widget-segmented${props.compact ? " compact" : ""}`} role="group">
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`widget-segmented-option${selected ? " selected" : ""}`}
            disabled={props.disabled}
            title={option.title ?? option.label}
            aria-label={option.label}
            aria-pressed={selected}
            onClick={() => {
              if (!selected) {
                props.onChange(option.value);
              }
            }}
          >
            {option.icon ? <span className="widget-segmented-icon">{option.icon}</span> : option.label}
          </button>
        );
      })}
    </div>
  );
}
