import type { DxfLayerStateMap } from "@/core/types";

interface DxfLayerStatesFieldProps {
  label: string;
  description?: string;
  value: DxfLayerStateMap;
  layerOrder?: string[];
  disabled?: boolean;
  onChange(next: DxfLayerStateMap): void;
  onReset?(): void;
}

function orderedLayerNames(value: DxfLayerStateMap, layerOrder?: string[]): string[] {
  if (Array.isArray(layerOrder) && layerOrder.length > 0) {
    const seen = new Set<string>();
    const ordered = layerOrder.filter((name) => {
      if (!value[name] || seen.has(name)) {
        return false;
      }
      seen.add(name);
      return true;
    });
    const extras = Object.keys(value).filter((name) => !seen.has(name)).sort((a, b) => a.localeCompare(b));
    return [...ordered, ...extras];
  }
  return Object.keys(value).sort((a, b) => a.localeCompare(b));
}

export function DxfLayerStatesField(props: DxfLayerStatesFieldProps) {
  const names = orderedLayerNames(props.value, props.layerOrder);

  return (
    <div className="widget-row">
      <div className="widget-row-header">
        <label className="widget-label">{props.label}</label>
        {props.onReset ? (
          <button type="button" className="widget-reset-button" disabled={props.disabled} onClick={props.onReset} title="Reset layer colors">
            R
          </button>
        ) : null}
      </div>
      {props.description ? <div className="widget-description">{props.description}</div> : null}
      {names.length === 0 ? (
        <p className="panel-empty">No layers loaded yet.</p>
      ) : (
        <div className="dxf-layer-states-list">
          {names.map((name) => {
            const entry = props.value[name];
            if (!entry) {
              return null;
            }
            return (
              <div key={name} className="dxf-layer-states-row">
                <label className="dxf-layer-states-toggle">
                  <input
                    type="checkbox"
                    checked={entry.visible !== false}
                    disabled={props.disabled}
                    onChange={(event) => {
                      props.onChange({
                        ...props.value,
                        [name]: {
                          ...entry,
                          visible: event.target.checked
                        }
                      });
                    }}
                  />
                  <span>{entry.name}</span>
                </label>
                <input
                  className="dxf-layer-states-color"
                  type="color"
                  value={entry.color}
                  disabled={props.disabled}
                  onChange={(event) => {
                    props.onChange({
                      ...props.value,
                      [name]: {
                        ...entry,
                        color: event.target.value
                      }
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
