import { useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChartColumn,
  faCircleDot,
  faClone,
  faForwardStep
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import type {
  ProfileActorFrameSnapshot,
  ProfileChunkSnapshot,
  ProfileFrameSnapshot,
  ProfileGpuStatus,
  ProfileSessionResult
} from "@/render/profiling";

interface ProfilingResultsPanelProps {
  result: ProfileSessionResult;
}

interface ProfileGraphNode {
  id: string;
  label: string;
  durationMs: number;
  children: ProfileGraphNode[];
}

interface GraphSectionRow {
  key: string;
  label: string;
  root: ProfileGraphNode;
}

interface DrilldownConnectorBounds {
  startPercent: number;
  endPercent: number;
}

interface ExpandedDrilldown {
  path: string[];
  connectors: DrilldownConnectorBounds[];
}

interface FrameRowEntry {
  key: string;
  label: string;
  cpuRoot: ProfileGraphNode;
  gpuRoot: ProfileGraphNode | null;
  gpuStatus: ProfileGpuStatus;
  gpuDurationMs: number | null;
}

function cloneGraphNode(node: ProfileGraphNode): ProfileGraphNode {
  return {
    id: node.id,
    label: node.label,
    durationMs: node.durationMs,
    children: node.children.map(cloneGraphNode)
  };
}

function chunkToGraphNode(chunk: ProfileChunkSnapshot): ProfileGraphNode {
  return {
    id: chunk.id,
    label: chunk.label,
    durationMs: chunk.durationMs,
    children: chunk.children.map(chunkToGraphNode)
  };
}

const UNATTRIBUTED_SEGMENT_MIN_MS = 0.01;

export function addUnattributedGraphNodes(node: ProfileGraphNode, label = "Unattributed"): ProfileGraphNode {
  const children = node.children.map((child) => addUnattributedGraphNodes(child, label));
  const residualMs = Math.max(0, node.durationMs - children.reduce((sum, child) => sum + child.durationMs, 0));
  if (residualMs > UNATTRIBUTED_SEGMENT_MIN_MS) {
    children.push({
      id: `${node.id}:unattributed`,
      label,
      durationMs: residualMs,
      children: []
    });
  }
  children.sort((a, b) => b.durationMs - a.durationMs || a.label.localeCompare(b.label));
  return {
    ...node,
    children
  };
}

function buildRootNode(
  id: string,
  label: string,
  chunks: ProfileChunkSnapshot[],
  fallbackTotal?: number,
  unattributedLabel = "Unattributed"
): ProfileGraphNode {
  const children = chunks.map(chunkToGraphNode).filter((chunk) => chunk.durationMs > 0);
  const durationMs = Math.max(
    children.reduce((sum, chunk) => sum + chunk.durationMs, 0),
    fallbackTotal ?? 0
  );
  return addUnattributedGraphNodes({
    id,
    label,
    durationMs,
    children
  }, unattributedLabel);
}

function buildCpuFrameGraph(frame: ProfileFrameSnapshot): ProfileGraphNode {
  return buildRootNode(
    `cpu-frame:${frame.frameIndex}`,
    `Frame ${frame.frameIndex + 1}`,
    frame.cpu.roots,
    frame.cpu.totalDurationMs,
    "Unattributed CPU"
  );
}

function buildGpuFrameGraph(frame: ProfileFrameSnapshot): ProfileGraphNode {
  return buildRootNode(
    `gpu-frame:${frame.frameIndex}`,
    `Frame ${frame.frameIndex + 1}`,
    frame.gpu.roots,
    frame.gpu.totalDurationMs ?? 0
  );
}

function buildActorCpuRoot(actor: ProfileActorFrameSnapshot): ProfileGraphNode | null {
  const chunks = [actor.update, actor.drawCpu].filter((chunk): chunk is ProfileChunkSnapshot => Boolean(chunk));
  if (chunks.length === 0) {
    return null;
  }
  return buildRootNode(`actor-cpu:${actor.actorId}`, actor.actorName, chunks);
}

function mergeGraphNode(target: ProfileGraphNode, source: ProfileGraphNode): void {
  target.durationMs += source.durationMs;
  for (const sourceChild of source.children) {
    const existing = target.children.find((child) => child.id === sourceChild.id);
    if (existing) {
      mergeGraphNode(existing, sourceChild);
      continue;
    }
    target.children.push(cloneGraphNode(sourceChild));
  }
}

function divideGraphNode(node: ProfileGraphNode, divisor: number): void {
  node.durationMs /= Math.max(1, divisor);
  node.children.forEach((child) => divideGraphNode(child, divisor));
  node.children.sort((a, b) => b.durationMs - a.durationMs || a.label.localeCompare(b.label));
}

function averageGraphRoots(roots: ProfileGraphNode[], label: string, divisor: number): ProfileGraphNode {
  const aggregate: ProfileGraphNode = {
    id: `average:${label}`,
    label,
    durationMs: 0,
    children: []
  };
  for (const root of roots) {
    mergeGraphNode(aggregate, root);
  }
  divideGraphNode(aggregate, divisor);
  return aggregate;
}

function buildMaxProcessRoot(roots: ProfileGraphNode[], label: string): ProfileGraphNode {
  const stats = new Map<string, { durationMs: number; label: string; parentPath: string | null }>();
  const visit = (node: ProfileGraphNode, parentPath: string | null) => {
    const key = parentPath ? `${parentPath} > ${node.id}` : node.id;
    const existing = stats.get(key);
    if (!existing || node.durationMs > existing.durationMs) {
      stats.set(key, {
        durationMs: node.durationMs,
        label: node.label,
        parentPath
      });
    }
    for (const child of node.children) {
      visit(child, key);
    }
  };
  for (const root of roots) {
    for (const child of root.children) {
      visit(child, null);
    }
  }
  const buildChildren = (parentPath: string | null): ProfileGraphNode[] =>
    Array.from(stats.entries())
      .filter(([, entry]) => entry.parentPath === parentPath)
      .map(([path, entry]) => ({
        id: path,
        label: entry.label,
        durationMs: entry.durationMs,
        children: buildChildren(path)
      }))
      .sort((a, b) => b.durationMs - a.durationMs || a.label.localeCompare(b.label));
  const children = buildChildren(null);
  return {
    id: `max-process:${label}`,
    label,
    durationMs: children.reduce((sum, child) => sum + child.durationMs, 0),
    children
  };
}

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ms`;
}

function colorForId(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 72% 54%)`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function pathsEqual(left: string[] | null | undefined, right: string[]): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }
  return left.every((segment, index) => segment === right[index]);
}

function DrilldownConnector(props: {
  bounds: DrilldownConnectorBounds;
  onClose?: () => void;
}) {
  const sourceStart = clampPercent(props.bounds.startPercent);
  const sourceEnd = clampPercent(props.bounds.endPercent);
  const targetStart = 0;
  const targetEnd = 100;

  return (
    <div className="profile-inline-drilldown-rail">
      <svg
        className="profile-inline-drilldown-graphic"
        viewBox="0 0 100 28"
        preserveAspectRatio="none"
        aria-label="Zoom connector"
      >
        <line x1={sourceStart} y1="0" x2={sourceStart} y2="8" />
        <line x1={sourceEnd} y1="0" x2={sourceEnd} y2="8" />
        <line x1={sourceStart} y1="8" x2={targetStart} y2="20" />
        <line x1={sourceEnd} y1="8" x2={targetEnd} y2="20" />
        <line x1={targetStart} y1="20" x2={targetStart} y2="28" />
        <line x1={targetEnd} y1="20" x2={targetEnd} y2="28" />
      </svg>
      {props.onClose ? (
        <button
          type="button"
          className="profile-inline-drilldown-close"
          aria-label="Collapse drilldown"
          onClick={props.onClose}
        >
          x
        </button>
      ) : null}
    </div>
  );
}

function GraphNodeView(props: {
  node: ProfileGraphNode;
  depth: number;
  expanded: ExpandedDrilldown | null;
  onExpand: (path: string[], bounds: DrilldownConnectorBounds) => void;
  onCollapse: (path: string[]) => void;
  path: string[];
}) {
  const total = Math.max(0.0001, props.node.durationMs);
  const nextExpandedId = props.expanded?.path[props.path.length] ?? null;
  const expandedChild = nextExpandedId ? props.node.children.find((child) => child.id === nextExpandedId) ?? null : null;
  const connectorBounds = props.expanded?.connectors[props.path.length] ?? null;

  return (
    <div className={`profile-node-view depth-${props.depth}`}>
      <div className="profile-bar">
        {props.node.children.length === 0 ? (
          <div className="profile-bar-empty">No child timings</div>
        ) : (
          props.node.children.map((child) => {
            const widthPercent = Math.max(0.5, (child.durationMs / total) * 100);
            const showText = widthPercent >= 12;
            const drillable = child.children.length > 0;
            const isExpanded = expandedChild?.id === child.id;
            const buttonLabel = `${child.label}: ${formatDuration(child.durationMs)}${drillable ? " (drill down)" : ""}`;
            return (
              <button
                key={child.id}
                type="button"
                className={`profile-bar-segment${drillable ? " is-drillable" : ""}${isExpanded ? " is-expanded" : ""}`}
                style={{
                  width: `${widthPercent}%`,
                  background: colorForId(child.id)
                }}
                title={buttonLabel}
                aria-label={buttonLabel}
                onClick={(event) => {
                  if (!drillable) {
                    return;
                  }
                  const segmentRect = event.currentTarget.getBoundingClientRect();
                  const parentRect = event.currentTarget.parentElement?.getBoundingClientRect();
                  const startPercent =
                    parentRect && parentRect.width > 0
                      ? ((segmentRect.left - parentRect.left) / parentRect.width) * 100
                      : 0;
                  const endPercent =
                    parentRect && parentRect.width > 0
                      ? ((segmentRect.right - parentRect.left) / parentRect.width) * 100
                      : 100;
                  props.onExpand([...props.path, child.id], {
                    startPercent,
                    endPercent
                  });
                }}
              >
                {showText ? (
                  <span className="profile-bar-segment-text">
                    {child.label}
                    {drillable ? " v" : ""}
                  </span>
                ) : drillable ? (
                  <span className="profile-bar-segment-mark" aria-hidden>
                    v
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
      {expandedChild && connectorBounds ? (
        <div className="profile-inline-drilldown">
          <DrilldownConnector
            bounds={connectorBounds}
            onClose={() => props.onCollapse(props.path)}
          />
          <div className="profile-inline-drilldown-meta">
            <span>{expandedChild.label}</span>
            <strong>{formatDuration(expandedChild.durationMs)}</strong>
          </div>
          <GraphNodeView
            node={expandedChild}
            depth={props.depth + 1}
            expanded={props.expanded}
            onExpand={props.onExpand}
            onCollapse={props.onCollapse}
            path={[...props.path, expandedChild.id]}
          />
        </div>
      ) : null}
    </div>
  );
}

function ProfileRowGraph(props: {
  label: string;
  root: ProfileGraphNode;
}) {
  const [expanded, setExpanded] = useState<ExpandedDrilldown | null>(null);

  return (
    <div className="profile-row">
      <div className="profile-row-meta">
        <span>{props.label}</span>
        <strong>{formatDuration(props.root.durationMs)}</strong>
      </div>
      <GraphNodeView
        node={props.root}
        depth={0}
        expanded={expanded}
        onExpand={(path, bounds) => {
          setExpanded((previous) => {
            if (pathsEqual(previous?.path, path)) {
              const parentPath = path.slice(0, -1);
              if (parentPath.length === 0) {
                return null;
              }
              return {
                path: parentPath,
                connectors: (previous?.connectors ?? []).slice(0, parentPath.length)
              };
            }
            return {
              path,
              connectors: [...(previous?.connectors ?? []).slice(0, Math.max(0, path.length - 1)), bounds]
            };
          });
        }}
        onCollapse={(path) => {
          if (path.length === 0) {
            setExpanded(null);
            return;
          }
          setExpanded((previous) => {
            if (!previous) {
              return null;
            }
            return {
              path,
              connectors: previous.connectors.slice(0, path.length)
            };
          });
        }}
        path={[]}
      />
    </div>
  );
}

function ProfileSectionHeader(props: {
  icon: IconDefinition;
  title: string;
  description?: string;
}) {
  return (
    <div className="profile-section-header">
      <div className="profile-section-heading">
        <FontAwesomeIcon icon={props.icon} className="profile-section-icon" />
        <strong>{props.title}</strong>
      </div>
      {props.description ? <span>{props.description}</span> : null}
    </div>
  );
}

function ProfileSummaryChip(props: {
  label: string;
  value: string;
}) {
  return (
    <div className="profile-summary-chip">
      <span className="profile-summary-chip-label">{props.label}</span>
      <strong className="profile-summary-chip-value">{props.value}</strong>
    </div>
  );
}

function GraphSection(props: {
  icon: IconDefinition;
  title: string;
  description?: string;
  rows: GraphSectionRow[];
  emptyMessage?: string;
  className?: string;
}) {
  return (
    <section className={`profile-section${props.className ? ` ${props.className}` : ""}`}>
      <ProfileSectionHeader icon={props.icon} title={props.title} description={props.description} />
      {props.rows.length === 0 ? (
        <div className="panel-empty">{props.emptyMessage ?? "No timings captured."}</div>
      ) : (
        <div className="profile-rows">
          {props.rows.map((row) => (
            <ProfileRowGraph key={row.key} label={row.label} root={row.root} />
          ))}
        </div>
      )}
    </section>
  );
}

function FrameGroupSection(props: {
  frames: FrameRowEntry[];
}) {
  const [expandedFrame, setExpandedFrame] = useState<{
    key: string;
    bounds: DrilldownConnectorBounds;
  } | null>(null);
  const expandedFrameEntry = props.frames.find((frame) => frame.key === expandedFrame?.key) ?? null;

  return (
    <section className="profile-section profile-section-emphasis">
      <ProfileSectionHeader
        icon={faForwardStep}
        title="Captured Frames"
        description="Click a frame segment to inspect CPU and GPU timings."
      />
      {props.frames.length === 0 ? (
        <div className="panel-empty">No frames captured.</div>
      ) : (
        <div className="profile-row profile-frame-group">
          <div className="profile-row-meta">
            <span>Captured Frames</span>
            {expandedFrameEntry ? (
              <strong>#{expandedFrameEntry.label}</strong>
            ) : (
              <strong>Select a frame</strong>
            )}
          </div>
          <div className="profile-bar">
            {props.frames.map((frame) => {
              const expanded = expandedFrame?.key === frame.key;
              const widthPercent = 100 / Math.max(1, props.frames.length);
              const gpuSummary =
                frame.gpuStatus === "captured"
                  ? formatDuration(frame.gpuDurationMs)
                  : frame.gpuStatus === "unavailable"
                    ? "n/a"
                    : "off";
              const buttonLabel = `Frame ${frame.label}: CPU ${formatDuration(frame.cpuRoot.durationMs)} | GPU ${gpuSummary} (drill down)`;
              return (
                <button
                  type="button"
                  key={frame.key}
                  className={`profile-bar-segment profile-frame-segment is-drillable${expanded ? " is-expanded" : ""}`}
                  style={{
                    width: `${widthPercent}%`,
                    background: colorForId(frame.key)
                  }}
                  aria-expanded={expanded}
                  aria-label={buttonLabel}
                  title={buttonLabel}
                  onClick={(event) => {
                    const segmentRect = event.currentTarget.getBoundingClientRect();
                    const parentRect = event.currentTarget.parentElement?.getBoundingClientRect();
                    const startPercent =
                      parentRect && parentRect.width > 0
                        ? ((segmentRect.left - parentRect.left) / parentRect.width) * 100
                        : 0;
                    const endPercent =
                      parentRect && parentRect.width > 0
                        ? ((segmentRect.right - parentRect.left) / parentRect.width) * 100
                        : 100;
                    setExpandedFrame((current) =>
                      current?.key === frame.key
                        ? null
                        : {
                            key: frame.key,
                            bounds: {
                              startPercent,
                              endPercent
                            }
                          }
                    );
                  }}
                >
                  <span className="profile-bar-segment-text">
                    {frame.label}
                  </span>
                </button>
              );
            })}
          </div>
          {expandedFrameEntry && expandedFrame ? (
            <div className="profile-frame-expanded-stack">
              <DrilldownConnector bounds={expandedFrame.bounds} />
              <div className="profile-frame-expanded">
                <ProfileRowGraph label="CPU Total" root={expandedFrameEntry.cpuRoot} />
                {expandedFrameEntry.gpuRoot ? (
                  <ProfileRowGraph label="GPU Total" root={expandedFrameEntry.gpuRoot} />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="panel-empty">Select a frame in the strip above to inspect it.</div>
          )}
        </div>
      )}
    </section>
  );
}

function buildActorAverageRoots(
  frames: ProfileFrameSnapshot[]
): Array<{ actorId: string; actorName: string; root: ProfileGraphNode; averageMs: number }> {
  const aggregates = new Map<string, { actorName: string; root: ProfileGraphNode; count: number }>();
  for (const frame of frames) {
    for (const actor of frame.actors) {
      const actorRoot = buildActorCpuRoot(actor);
      if (!actorRoot) {
        continue;
      }
      const existing = aggregates.get(actor.actorId);
      if (existing) {
        mergeGraphNode(existing.root, actorRoot);
        existing.count += 1;
        continue;
      }
      aggregates.set(actor.actorId, {
        actorName: actor.actorName,
        root: cloneGraphNode(actorRoot),
        count: 1
      });
    }
  }
  return Array.from(aggregates.entries())
    .map(([actorId, entry]) => {
      divideGraphNode(entry.root, entry.count);
      return {
        actorId,
        actorName: entry.actorName,
        root: entry.root,
        averageMs: entry.root.durationMs
      };
    })
    .sort((a, b) => b.averageMs - a.averageMs || a.actorName.localeCompare(b.actorName));
}

function gpuStatusDescription(status: ProfileGpuStatus): string {
  switch (status) {
    case "captured":
      return "Real GPU timestamp queries.";
    case "unavailable":
      return "GPU timestamps unavailable on this backend/device.";
    case "disabled":
    default:
      return "GPU timings disabled for this capture.";
  }
}

export function ProfilingResultsPanel(props: ProfilingResultsPanelProps) {
  const cpuFrameRoots = useMemo(() => props.result.frames.map(buildCpuFrameGraph), [props.result.frames]);
  const averageCpuRoot = useMemo(
    () => averageGraphRoots(cpuFrameRoots, "Average CPU Frame", Math.max(1, cpuFrameRoots.length)),
    [cpuFrameRoots]
  );
  const maxCpuFrameRoot = useMemo(
    () =>
      cpuFrameRoots.reduce<ProfileGraphNode | null>(
        (winner, candidate) => (!winner || candidate.durationMs > winner.durationMs ? candidate : winner),
        null
      ),
    [cpuFrameRoots]
  );
  const maxCpuProcessRoot = useMemo(
    () => buildMaxProcessRoot(cpuFrameRoots, "Maximum CPU Process"),
    [cpuFrameRoots]
  );
  const frameRows = useMemo<FrameRowEntry[]>(
    () =>
      props.result.frames.map((frame, index) => ({
        key: `frame:${frame.frameIndex}`,
        label: `${index + 1}`,
        cpuRoot: buildCpuFrameGraph(frame),
        gpuRoot: frame.gpu.status === "captured" ? buildGpuFrameGraph(frame) : null,
        gpuStatus: frame.gpu.status,
        gpuDurationMs: frame.gpu.totalDurationMs
      })),
    [props.result.frames]
  );
  const gpuCapturedFrames = useMemo(
    () => props.result.frames.filter((frame) => frame.gpu.status === "captured"),
    [props.result.frames]
  );
  const gpuFrameRoots = useMemo(() => gpuCapturedFrames.map(buildGpuFrameGraph), [gpuCapturedFrames]);
  const averageGpuRoot = useMemo(
    () =>
      gpuFrameRoots.length > 0
        ? averageGraphRoots(gpuFrameRoots, "Average GPU Frame", Math.max(1, gpuFrameRoots.length))
        : null,
    [gpuFrameRoots]
  );
  const maxGpuFrameRoot = useMemo(
    () =>
      gpuFrameRoots.reduce<ProfileGraphNode | null>(
        (winner, candidate) => (!winner || candidate.durationMs > winner.durationMs ? candidate : winner),
        null
      ),
    [gpuFrameRoots]
  );
  const maxGpuProcessRoot = useMemo(
    () => (gpuFrameRoots.length > 0 ? buildMaxProcessRoot(gpuFrameRoots, "Maximum GPU Process") : null),
    [gpuFrameRoots]
  );
  const actorAverageRoots = useMemo(() => buildActorAverageRoots(props.result.frames), [props.result.frames]);
  const pluginAverageRoots = useMemo(
    () =>
      actorAverageRoots.filter((entry) =>
        props.result.frames.some((frame) => frame.actors.some((actor) => actor.actorId === entry.actorId && Boolean(actor.pluginType)))
      ),
    [actorAverageRoots, props.result.frames]
  );

  const summaryRows = [
    {
      key: "cpu-average",
      label: "CPU Average Frame",
      root: averageCpuRoot
    },
    ...(maxCpuFrameRoot
      ? [
          {
            key: "cpu-max-frame",
            label: "CPU Maximum Frame",
            root: maxCpuFrameRoot
          }
        ]
      : []),
    {
      key: "cpu-max-process",
      label: "CPU Maximum Individual Process",
      root: maxCpuProcessRoot
    },
    ...(averageGpuRoot
      ? [
          {
            key: "gpu-average",
            label: "GPU Average Frame",
            root: averageGpuRoot
          }
        ]
      : []),
    ...(maxGpuFrameRoot
      ? [
          {
            key: "gpu-max-frame",
            label: "GPU Maximum Frame",
            root: maxGpuFrameRoot
          }
        ]
      : []),
    ...(maxGpuProcessRoot
      ? [
          {
            key: "gpu-max-process",
            label: "GPU Maximum Individual Process",
            root: maxGpuProcessRoot
          }
        ]
      : [])
  ];
  const profileTitle = "Performance Profile";
  const gpuSummaryLine =
    props.result.summary.gpu.metrics.averageFrameMs !== null
      ? `${gpuStatusDescription(props.result.summary.gpu.status)} Average ${formatDuration(
          props.result.summary.gpu.metrics.averageFrameMs
        )} | Max ${formatDuration(props.result.summary.gpu.metrics.maxFrameMs)}`
      : gpuStatusDescription(props.result.summary.gpu.status);

  return (
    <div className="panel-stack profile-panel">
      <div className="panel-section profile-panel-header">
        <div className="profile-panel-title-row">
          <div className="profile-panel-title">
            <FontAwesomeIcon icon={faChartColumn} className="profile-panel-title-icon" />
            <strong>{profileTitle}</strong>
          </div>
        </div>
        <div className="profile-summary-chips">
          <ProfileSummaryChip label="Frames" value={String(props.result.frames.length)} />
          <ProfileSummaryChip label="CPU Avg" value={formatDuration(props.result.summary.cpu.averageFrameMs)} />
          <ProfileSummaryChip label="CPU Max" value={formatDuration(props.result.summary.cpu.maxFrameMs)} />
          <ProfileSummaryChip label="Process Max" value={formatDuration(props.result.summary.cpu.maxProcessMs)} />
        </div>
        <div className="profile-panel-subtext">{gpuSummaryLine}</div>
        <div className="profile-panel-subtext">Click highlighted segments to drill down. Hover compact segments to see full labels.</div>
      </div>

      <GraphSection
        icon={faChartColumn}
        title="Summaries"
        description="Aggregate frame timing views."
        rows={summaryRows}
        className="profile-section-emphasis"
      />

      <FrameGroupSection frames={frameRows} />

      <GraphSection
        icon={faCircleDot}
        title="Actor CPU Hotspots"
        description="Average actor update + draw CPU timings."
        className="profile-section-break"
        rows={actorAverageRoots.slice(0, 12).map((entry) => ({
          key: `actor-average:${entry.actorId}`,
          label: entry.actorName,
          root: entry.root
        }))}
        emptyMessage="No actor CPU timings captured."
      />

      <GraphSection
        icon={faClone}
        title="Plugin CPU Hotspots"
        description="Average plugin actor update + draw CPU timings."
        rows={pluginAverageRoots.slice(0, 12).map((entry) => ({
          key: `plugin-average:${entry.actorId}`,
          label: entry.actorName,
          root: entry.root
        }))}
        emptyMessage="No plugin CPU timings captured."
      />
    </div>
  );
}
