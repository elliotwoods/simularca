import type { ReactNode } from "react";

interface InspectorFieldRowProps {
  label: string;
  description?: string;
  children: ReactNode;
}

export function InspectorFieldRow(props: InspectorFieldRowProps) {
  return (
    <div className="widget-row">
      <div className="widget-row-header">
        <label className="widget-label">{props.label}</label>
        {props.description ? <span className="widget-description">{props.description}</span> : null}
      </div>
      <div className="widget-row-control">{props.children}</div>
    </div>
  );
}
