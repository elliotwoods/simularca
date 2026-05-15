import { useEffect, useState } from "react";
import { subscribeAssetProgress, type AssetProgressSnapshot } from "@/viewer/assetIntercept";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "—";
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} kB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

/**
 * Floating overlay that shows currently-in-flight asset downloads — aggregate
 * speed at the top, per-file progress bars beneath. Disappears 1.5s after
 * the last download finishes.
 */
export function AssetLoadingOverlay() {
  const [snapshot, setSnapshot] = useState<AssetProgressSnapshot>({
    inFlight: [],
    totalLoadedBytes: 0,
    totalKnownBytes: 0,
    aggregateBytesPerSecond: 0
  });

  useEffect(() => subscribeAssetProgress(setSnapshot), []);

  if (snapshot.inFlight.length === 0) return null;

  const aggregatePercent =
    snapshot.totalKnownBytes > 0
      ? Math.min(100, Math.round((snapshot.totalLoadedBytes / snapshot.totalKnownBytes) * 100))
      : null;

  return (
    <div className="viewer-asset-loading">
      <div className="viewer-asset-loading-summary">
        <span className="viewer-asset-loading-title">
          Loading {snapshot.inFlight.length} asset{snapshot.inFlight.length === 1 ? "" : "s"}
        </span>
        <span className="viewer-asset-loading-speed">{formatRate(snapshot.aggregateBytesPerSecond)}</span>
      </div>
      {aggregatePercent !== null ? (
        <div className="viewer-asset-loading-bar">
          <div
            className="viewer-asset-loading-bar-fill"
            style={{ width: `${String(aggregatePercent)}%` }}
          />
        </div>
      ) : null}
      <ul className="viewer-asset-loading-items">
        {snapshot.inFlight.map((entry) => {
          const pct =
            entry.totalBytes && entry.totalBytes > 0
              ? Math.min(100, Math.round((entry.loadedBytes / entry.totalBytes) * 100))
              : null;
          return (
            <li key={entry.id} className="viewer-asset-loading-item">
              <div className="viewer-asset-loading-item-row">
                <span className="viewer-asset-loading-item-name" title={entry.url}>
                  {entry.fileName}
                </span>
                <span className="viewer-asset-loading-item-stats">
                  {formatBytes(entry.loadedBytes)}
                  {entry.totalBytes != null ? ` / ${formatBytes(entry.totalBytes)}` : ""} ·{" "}
                  {formatRate(entry.bytesPerSecond)}
                  {pct !== null ? ` · ${String(pct)}%` : ""}
                </span>
              </div>
              <div className="viewer-asset-loading-item-bar">
                <div
                  className="viewer-asset-loading-item-bar-fill"
                  style={{ width: pct === null ? "30%" : `${String(pct)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
