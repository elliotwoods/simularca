import type { ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faRotateLeft } from "@fortawesome/free-solid-svg-icons";

interface InspectorFieldRowProps {
  label: string;
  description?: string;
  children: ReactNode;
  showReset?: boolean;
  resetTitle?: string;
  resetDisabled?: boolean;
  resetAlign?: "center" | "start";
  onReset?: () => void;
}

export function InspectorFieldRow(props: InspectorFieldRowProps) {
  return (
    <div className="widget-row">
      <div className="widget-row-header">
        <label className="widget-label">{props.label}</label>
        {props.description ? <span className="widget-description">{props.description}</span> : null}
      </div>
      <div className={`widget-row-control-wrap${props.resetAlign === "start" ? " align-start" : ""}`}>
        <div className="widget-row-control">{props.children}</div>
        <button
          type="button"
          className={`widget-reset-button${props.showReset ? "" : " is-hidden"}`}
          title={props.resetTitle ?? `Reset ${props.label}`}
          disabled={!props.showReset || props.resetDisabled}
          onClick={props.onReset}
        >
          <FontAwesomeIcon icon={faRotateLeft} />
        </button>
      </div>
    </div>
  );
}
