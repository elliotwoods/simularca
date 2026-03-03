import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleInfo, faFolderOpen, faTrashCan, faFile, faRotateRight } from "@fortawesome/free-solid-svg-icons";
import type { SessionAssetRef } from "@/types/ipc";
import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";

interface FileFieldProps {
  label: string;
  description?: string;
  value: string;
  mixed?: boolean;
  asset?: SessionAssetRef;
  disabled?: boolean;
  showReset?: boolean;
  onReset?: () => void;
  onBrowse: () => void;
  onReload: () => void;
  onClear: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function buildAssetTooltip(asset?: SessionAssetRef, mixed?: boolean, value?: string): string {
  if (mixed) {
    return "Mixed assets in selection";
  }
  if (!asset && value) {
    return `Asset id: ${value}\nAsset record not found in current session.`;
  }
  if (!asset) {
    return "No file selected";
  }
  return [
    `File: ${asset.sourceFileName}`,
    `Kind: ${asset.kind}`,
    `Size: ${formatBytes(asset.byteSize)}`,
    `Path: ${asset.relativePath}`
  ].join("\n");
}

export function FileField(props: FileFieldProps) {
  const hasValue = props.mixed || Boolean(props.value);
  const displayName = props.mixed
    ? "Mixed"
    : props.asset
      ? props.asset.sourceFileName
      : props.value
        ? "Missing asset"
        : "No file selected";
  const tooltip = buildAssetTooltip(props.asset, props.mixed, props.value);

  return (
    <InspectorFieldRow
      label={props.label}
      description={props.description}
      showReset={props.showReset}
      onReset={props.onReset}
      resetDisabled={props.disabled}
      resetAlign="start"
    >
      <div className="widget-file">
        <div className="widget-file-main" title={tooltip}>
          <span className="widget-file-icon" aria-hidden>
            <FontAwesomeIcon icon={faFile} />
          </span>
          <span className={`widget-file-name${props.value && !props.asset && !props.mixed ? " missing" : ""}`}>
            {displayName}
          </span>
          <span className="widget-file-info" title={tooltip}>
            <FontAwesomeIcon icon={faCircleInfo} />
          </span>
        </div>
        <div className="widget-file-actions">
          <button type="button" className="widget-file-btn" disabled={props.disabled} onClick={props.onBrowse}>
            <FontAwesomeIcon icon={faFolderOpen} />
            <span>Browse</span>
          </button>
          <button
            type="button"
            className="widget-file-btn"
            disabled={props.disabled || !hasValue}
            onClick={props.onReload}
          >
            <FontAwesomeIcon icon={faRotateRight} />
            <span>Reload</span>
          </button>
          <button
            type="button"
            className="widget-file-btn"
            disabled={props.disabled || !hasValue}
            onClick={props.onClear}
          >
            <FontAwesomeIcon icon={faTrashCan} />
            <span>Clear</span>
          </button>
        </div>
      </div>
    </InspectorFieldRow>
  );
}
