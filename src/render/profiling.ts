import * as THREE from "three";
import type { ActorNode } from "@/core/types";

export type ProfileCaptureDetailPreset = "minimal" | "standard";
export type ProfilePhaseKind = "update" | "drawCpu" | "drawGpu";
export type ProfileGpuStatus = "disabled" | "captured" | "unavailable";

export interface ProfileCaptureOptions {
  frameCount: number;
  includeUpdateTimings: boolean;
  includeDrawTimings: boolean;
  includeGpuTimings: boolean;
  detailPreset: ProfileCaptureDetailPreset;
}

export interface ProfileChunkSnapshot {
  id: string;
  label: string;
  durationMs: number;
  children: ProfileChunkSnapshot[];
}

export interface ProfileActorFrameSnapshot {
  actorId: string;
  actorName: string;
  actorType: ActorNode["actorType"];
  pluginType?: string;
  update: ProfileChunkSnapshot | null;
  drawCpu: ProfileChunkSnapshot | null;
  drawGpu: ProfileChunkSnapshot | null;
}

export interface ProfileCpuFrameSnapshot {
  totalDurationMs: number;
  roots: ProfileChunkSnapshot[];
}

export interface ProfileGpuFrameSnapshot {
  status: ProfileGpuStatus;
  totalDurationMs: number | null;
  roots: ProfileChunkSnapshot[];
}

export interface ProfileFrameSnapshot {
  frameIndex: number;
  cpu: ProfileCpuFrameSnapshot;
  gpu: ProfileGpuFrameSnapshot;
  actors: ProfileActorFrameSnapshot[];
}

export interface ProfileMetricSummary {
  averageFrameMs: number | null;
  maxFrameMs: number | null;
  maxProcessMs: number | null;
}

export interface ProfileProcessSummaryEntry {
  path: string;
  averageMs: number;
  maxMs: number;
}

export interface ProfileActorSummaryEntry {
  actorId: string;
  actorName: string;
  actorType: ActorNode["actorType"];
  pluginType?: string;
  averageCpuMs: number;
  maxCpuMs: number;
  averageGpuMs: number;
  maxGpuMs: number;
}

export interface ProfileSessionSummary {
  frameCount: number;
  cpu: ProfileMetricSummary & {
    topProcesses: ProfileProcessSummaryEntry[];
  };
  gpu: {
    status: ProfileGpuStatus;
    availableFrames: number;
    metrics: ProfileMetricSummary;
    topProcesses: ProfileProcessSummaryEntry[];
  };
  hotActors: ProfileActorSummaryEntry[];
}

interface ProfileFrameConsoleSummary {
  frameIndex: number;
  cpuMs: number;
  gpuMs: number | null;
  gpuStatus: ProfileGpuStatus;
  topCpuRoots: Array<{
    label: string;
    durationMs: number;
  }>;
  topGpuRoots: Array<{
    label: string;
    durationMs: number;
  }>;
}

export interface ProfileSessionResult {
  id: string;
  options: ProfileCaptureOptions;
  startedAtIso: string;
  completedAtIso: string;
  frames: ProfileFrameSnapshot[];
  summary: ProfileSessionSummary;
}

export interface ActorProfileMeta {
  actorId: string;
  actorName: string;
  actorType: ActorNode["actorType"];
  pluginType?: string;
}

export interface ProfilingPublicState {
  phase: "idle" | "capturing" | "completed";
  requestedFrameCount: number;
  capturedFrameCount: number;
  pendingGpuFrames: number;
  options: ProfileCaptureOptions | null;
  result: ProfileSessionResult | null;
}

export interface ProfileFrameGpuInput {
  status: ProfileGpuStatus;
  roots?: ProfileChunkSnapshot[];
}

interface MutableProfileChunk {
  id: string;
  label: string;
  durationMs: number;
  children: MutableProfileChunk[];
  childIndex: Map<string, MutableProfileChunk>;
}

interface MutableActorFrameRecord extends ActorProfileMeta {
  update: MutableProfileChunk | null;
  drawCpu: MutableProfileChunk | null;
  drawGpu: MutableProfileChunk | null;
}

interface FrameCaptureState {
  frameIndex: number;
  cpuRoots: MutableProfileChunk[];
  cpuRootIndex: Map<string, MutableProfileChunk>;
  actors: Map<string, MutableActorFrameRecord>;
}

interface ActiveDrawSample {
  startedAtMs: number;
  actorRoot: MutableProfileChunk;
  mirrorChunk: MutableProfileChunk | null;
  previousChunkStack: MutableProfileChunk[];
  previousMirrorChunkStack: MutableProfileChunk[];
}

type Listener = () => void;

interface WrappedDrawHook {
  object: THREE.Object3D;
  actor: ActorProfileMeta;
  originalBeforeRender: THREE.Object3D["onBeforeRender"];
  originalAfterRender: THREE.Object3D["onAfterRender"];
}

function createChunk(id: string, label: string): MutableProfileChunk {
  return {
    id,
    label,
    durationMs: 0,
    children: [],
    childIndex: new Map()
  };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function snapshotChunk(chunk: MutableProfileChunk | null): ProfileChunkSnapshot | null {
  if (!chunk) {
    return null;
  }
  return {
    id: chunk.id,
    label: chunk.label,
    durationMs: chunk.durationMs,
    children: chunk.children
      .map((child) => snapshotChunk(child))
      .filter((child): child is ProfileChunkSnapshot => Boolean(child))
      .sort((a, b) => b.durationMs - a.durationMs || a.label.localeCompare(b.label))
  };
}

function snapshotActorRecord(record: MutableActorFrameRecord): ProfileActorFrameSnapshot {
  return {
    actorId: record.actorId,
    actorName: record.actorName,
    actorType: record.actorType,
    pluginType: record.pluginType,
    update: snapshotChunk(record.update),
    drawCpu: snapshotChunk(record.drawCpu),
    drawGpu: snapshotChunk(record.drawGpu)
  };
}

function flattenChunks(
  chunks: ProfileChunkSnapshot[],
  scope: "cpu" | "gpu",
  prefix: string[] = [],
  out: Array<{ path: string; durationMs: number }> = []
): Array<{ path: string; durationMs: number }> {
  for (const chunk of chunks) {
    const path = [...prefix, `${scope}:${chunk.label}`];
    out.push({
      path: path.join(" > "),
      durationMs: chunk.durationMs
    });
    flattenChunks(chunk.children, scope, path, out);
  }
  return out;
}

function roundProfileMs(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(value >= 10 ? 1 : 2));
}

function summarizeMetric(values: number[]): ProfileMetricSummary {
  if (values.length === 0) {
    return {
      averageFrameMs: null,
      maxFrameMs: null,
      maxProcessMs: null
    };
  }
  return {
    averageFrameMs: roundProfileMs(values.reduce((sum, value) => sum + value, 0) / values.length),
    maxFrameMs: roundProfileMs(Math.max(...values)),
    maxProcessMs: null
  };
}

interface ProcessAggregateEntry {
  sum: number;
  max: number;
  count: number;
}

interface ActorAggregateEntry {
  actorId: string;
  actorName: string;
  actorType: ActorNode["actorType"];
  pluginType?: string;
  cpuSum: number;
  cpuMax: number;
  gpuSum: number;
  gpuMax: number;
  count: number;
}

function accumulateProcess(
  map: Map<string, ProcessAggregateEntry>,
  path: string,
  durationMs: number
): void {
  const existing = map.get(path);
  if (existing) {
    existing.sum += durationMs;
    existing.max = Math.max(existing.max, durationMs);
    existing.count += 1;
    return;
  }
  map.set(path, {
    sum: durationMs,
    max: durationMs,
    count: 1
  });
}

function summarizeTopProcesses(
  map: Map<string, ProcessAggregateEntry>,
  divisor: number
): ProfileProcessSummaryEntry[] {
  return Array.from(map.entries())
    .map(([path, entry]) => ({
      path,
      averageMs: Number((entry.sum / Math.max(1, divisor)).toFixed(2)),
      maxMs: Number(entry.max.toFixed(2))
    }))
    .sort((a, b) => b.averageMs - a.averageMs || b.maxMs - a.maxMs || a.path.localeCompare(b.path))
    .slice(0, 12);
}

function summarizeHotActors(map: Map<string, ActorAggregateEntry>): ProfileActorSummaryEntry[] {
  return Array.from(map.values())
    .map((entry) => ({
      actorId: entry.actorId,
      actorName: entry.actorName,
      actorType: entry.actorType,
      pluginType: entry.pluginType,
      averageCpuMs: Number((entry.cpuSum / Math.max(1, entry.count)).toFixed(2)),
      maxCpuMs: Number(entry.cpuMax.toFixed(2)),
      averageGpuMs: Number((entry.gpuSum / Math.max(1, entry.count)).toFixed(2)),
      maxGpuMs: Number(entry.gpuMax.toFixed(2))
    }))
    .sort((a, b) => b.averageCpuMs - a.averageCpuMs || b.maxCpuMs - a.maxCpuMs || a.actorName.localeCompare(b.actorName))
    .slice(0, 20);
}

export function buildProfileSummary(result: Pick<ProfileSessionResult, "frames">): ProfileSessionSummary {
  const cpuFrameTotals = result.frames.map((frame) => frame.cpu.totalDurationMs);
  const gpuFrames = result.frames.filter((frame) => frame.gpu.status === "captured" && typeof frame.gpu.totalDurationMs === "number");
  const gpuFrameTotals = gpuFrames
    .map((frame) => frame.gpu.totalDurationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const processStats = new Map<string, ProcessAggregateEntry>();
  const gpuProcessStats = new Map<string, ProcessAggregateEntry>();
  const actorStats = new Map<string, ActorAggregateEntry>();

  for (const frame of result.frames) {
    for (const process of flattenChunks(frame.cpu.roots, "cpu")) {
      accumulateProcess(processStats, process.path, process.durationMs);
    }
    if (frame.gpu.status === "captured") {
      for (const process of flattenChunks(frame.gpu.roots, "gpu")) {
        accumulateProcess(gpuProcessStats, process.path, process.durationMs);
      }
    }
    for (const actor of frame.actors) {
      const cpuDuration = (actor.update?.durationMs ?? 0) + (actor.drawCpu?.durationMs ?? 0);
      const gpuDuration = actor.drawGpu?.durationMs ?? 0;
      const existing = actorStats.get(actor.actorId);
      if (existing) {
        existing.cpuSum += cpuDuration;
        existing.cpuMax = Math.max(existing.cpuMax, cpuDuration);
        existing.gpuSum += gpuDuration;
        existing.gpuMax = Math.max(existing.gpuMax, gpuDuration);
        existing.count += 1;
        continue;
      }
      actorStats.set(actor.actorId, {
        actorId: actor.actorId,
        actorName: actor.actorName,
        actorType: actor.actorType,
        pluginType: actor.pluginType,
        cpuSum: cpuDuration,
        cpuMax: cpuDuration,
        gpuSum: gpuDuration,
        gpuMax: gpuDuration,
        count: 1
      });
    }
  }

  const cpuMetrics = summarizeMetric(cpuFrameTotals);
  cpuMetrics.maxProcessMs = roundProfileMs(
    processStats.size > 0 ? Math.max(...Array.from(processStats.values(), (entry) => entry.max)) : null
  );
  const gpuMetrics = summarizeMetric(gpuFrameTotals);
  gpuMetrics.maxProcessMs = roundProfileMs(
    gpuProcessStats.size > 0 ? Math.max(...Array.from(gpuProcessStats.values(), (entry) => entry.max)) : null
  );

  return {
    frameCount: result.frames.length,
    cpu: {
      ...cpuMetrics,
      topProcesses: summarizeTopProcesses(processStats, result.frames.length)
    },
    gpu: {
      status: gpuFrames.length > 0 ? "captured" : result.frames.some((frame) => frame.gpu.status === "unavailable") ? "unavailable" : "disabled",
      availableFrames: gpuFrames.length,
      metrics: gpuMetrics,
      topProcesses: summarizeTopProcesses(gpuProcessStats, gpuFrames.length || result.frames.length)
    },
    hotActors: summarizeHotActors(actorStats)
  };
}

function summarizeConsoleFrame(frame: ProfileFrameSnapshot): ProfileFrameConsoleSummary {
  return {
    frameIndex: frame.frameIndex,
    cpuMs: Number(frame.cpu.totalDurationMs.toFixed(2)),
    gpuMs:
      typeof frame.gpu.totalDurationMs === "number" && Number.isFinite(frame.gpu.totalDurationMs)
        ? Number(frame.gpu.totalDurationMs.toFixed(2))
        : null,
    gpuStatus: frame.gpu.status,
    topCpuRoots: frame.cpu.roots.slice(0, 5).map((root) => ({
      label: root.label,
      durationMs: Number(root.durationMs.toFixed(2))
    })),
    topGpuRoots: frame.gpu.roots.slice(0, 5).map((root) => ({
      label: root.label,
      durationMs: Number(root.durationMs.toFixed(2))
    }))
  };
}

function buildPluginHotspots(summary: ProfileSessionSummary): Array<{
  pluginType: string;
  averageCpuMs: number;
  maxCpuMs: number;
  averageGpuMs: number;
  maxGpuMs: number;
  actors: string[];
}> {
  const plugins = new Map<
    string,
    {
      averageCpuMs: number;
      maxCpuMs: number;
      averageGpuMs: number;
      maxGpuMs: number;
      actors: string[];
    }
  >();

  for (const actor of summary.hotActors) {
    const pluginType = actor.pluginType ?? (actor.actorType === "plugin" ? "plugin.unknown" : null);
    if (!pluginType) {
      continue;
    }
    const existing = plugins.get(pluginType);
    if (existing) {
      existing.averageCpuMs += actor.averageCpuMs;
      existing.maxCpuMs = Math.max(existing.maxCpuMs, actor.maxCpuMs);
      existing.averageGpuMs += actor.averageGpuMs;
      existing.maxGpuMs = Math.max(existing.maxGpuMs, actor.maxGpuMs);
      existing.actors.push(actor.actorName);
      continue;
    }
    plugins.set(pluginType, {
      averageCpuMs: actor.averageCpuMs,
      maxCpuMs: actor.maxCpuMs,
      averageGpuMs: actor.averageGpuMs,
      maxGpuMs: actor.maxGpuMs,
      actors: [actor.actorName]
    });
  }

  return Array.from(plugins.entries())
    .map(([pluginType, entry]) => ({
      pluginType,
      averageCpuMs: Number(entry.averageCpuMs.toFixed(2)),
      maxCpuMs: Number(entry.maxCpuMs.toFixed(2)),
      averageGpuMs: Number(entry.averageGpuMs.toFixed(2)),
      maxGpuMs: Number(entry.maxGpuMs.toFixed(2)),
      actors: entry.actors.sort((a, b) => a.localeCompare(b))
    }))
    .sort((a, b) => b.averageCpuMs - a.averageCpuMs || b.maxCpuMs - a.maxCpuMs || a.pluginType.localeCompare(b.pluginType))
    .slice(0, 12);
}

export function buildProfileConsoleSummary(result: ProfileSessionResult | null): Record<string, unknown> | null {
  if (!result) {
    return null;
  }
  const worstCpuFrame = result.frames.reduce<ProfileFrameSnapshot | null>(
    (winner, frame) => (!winner || frame.cpu.totalDurationMs > winner.cpu.totalDurationMs ? frame : winner),
    null
  );
  const worstGpuFrame = result.frames
    .filter((frame) => frame.gpu.status === "captured" && typeof frame.gpu.totalDurationMs === "number")
    .reduce<ProfileFrameSnapshot | null>(
      (winner, frame) =>
        !winner || (frame.gpu.totalDurationMs ?? -Infinity) > (winner.gpu.totalDurationMs ?? -Infinity) ? frame : winner,
      null
    );
  const worstCpuFrames = [...result.frames]
    .sort((a, b) => b.cpu.totalDurationMs - a.cpu.totalDurationMs || a.frameIndex - b.frameIndex)
    .slice(0, 5)
    .map(summarizeConsoleFrame);
  const worstGpuFrames = result.frames
    .filter((frame) => frame.gpu.status === "captured" && typeof frame.gpu.totalDurationMs === "number")
    .sort((a, b) => (b.gpu.totalDurationMs ?? -Infinity) - (a.gpu.totalDurationMs ?? -Infinity) || a.frameIndex - b.frameIndex)
    .slice(0, 5)
    .map(summarizeConsoleFrame);

  return {
    id: result.id,
    startedAtIso: result.startedAtIso,
    completedAtIso: result.completedAtIso,
    frameCount: result.frames.length,
    options: result.options,
    summary: result.summary,
    survey: {
      cpu: {
        averageFrameMs: result.summary.cpu.averageFrameMs,
        maxFrameMs: result.summary.cpu.maxFrameMs,
        maxProcessMs: result.summary.cpu.maxProcessMs,
        topProcesses: result.summary.cpu.topProcesses.slice(0, 8),
        worstFrame: worstCpuFrame ? summarizeConsoleFrame(worstCpuFrame) : null,
        worstFrames: worstCpuFrames
      },
      gpu: {
        status: result.summary.gpu.status,
        availableFrames: result.summary.gpu.availableFrames,
        averageFrameMs: result.summary.gpu.metrics.averageFrameMs,
        maxFrameMs: result.summary.gpu.metrics.maxFrameMs,
        maxProcessMs: result.summary.gpu.metrics.maxProcessMs,
        topProcesses: result.summary.gpu.topProcesses.slice(0, 8),
        worstFrame: worstGpuFrame ? summarizeConsoleFrame(worstGpuFrame) : null,
        worstFrames: worstGpuFrames
      },
      hotActors: result.summary.hotActors.slice(0, 10),
      hotPlugins: buildPluginHotspots(result.summary)
    }
  };
}

export class ActorProfilingService {
  private readonly listeners = new Set<Listener>();
  private state: ProfilingPublicState = {
    phase: "idle",
    requestedFrameCount: 0,
    capturedFrameCount: 0,
    pendingGpuFrames: 0,
    options: null,
    result: null
  };
  private captureStartedAtIso: string | null = null;
  private currentFrame: FrameCaptureState | null = null;
  private currentChunkStack: MutableProfileChunk[] = [];
  private currentMirrorChunkStack: MutableProfileChunk[] = [];
  private readonly completedFrames: ProfileFrameSnapshot[] = [];
  private readonly activeDrawSamples = new Map<string, ActiveDrawSample>();
  private readonly wrappedDrawHooks = new Map<string, WrappedDrawHook>();
  private monitoringMode = false;
  private readonly monitoringDrawTimingsMs = new Map<string, number>();
  private readonly monitoringActiveSamples = new Map<string, { startedAtMs: number; actorId: string }>();

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getState(): ProfilingPublicState {
    return this.state;
  }

  public getLatestResult(): ProfileSessionResult | null {
    return this.state.result;
  }

  public getLatestSummary(): Record<string, unknown> | null {
    return buildProfileConsoleSummary(this.state.result);
  }

  public startCapture(options: ProfileCaptureOptions): boolean {
    if (this.state.phase === "capturing") {
      return false;
    }
    const normalizedOptions: ProfileCaptureOptions = {
      frameCount: Math.max(1, Math.round(options.frameCount)),
      includeUpdateTimings: options.includeUpdateTimings,
      includeDrawTimings: options.includeDrawTimings,
      includeGpuTimings: options.includeGpuTimings,
      detailPreset: options.detailPreset
    };
    this.captureStartedAtIso = new Date().toISOString();
    this.currentFrame = null;
    this.currentChunkStack = [];
    this.currentMirrorChunkStack = [];
    this.activeDrawSamples.clear();
    this.clearDrawHooks();
    this.completedFrames.length = 0;
    this.state = {
      phase: "capturing",
      requestedFrameCount: normalizedOptions.frameCount,
      capturedFrameCount: 0,
      pendingGpuFrames: 0,
      options: normalizedOptions,
      result: null
    };
    this.emit();
    return true;
  }

  public cancelCapture(): void {
    if (this.state.phase === "idle") {
      return;
    }
    this.captureStartedAtIso = null;
    this.currentFrame = null;
    this.currentChunkStack = [];
    this.currentMirrorChunkStack = [];
    this.completedFrames.length = 0;
    this.activeDrawSamples.clear();
    this.clearDrawHooks();
    this.state = {
      phase: "idle",
      requestedFrameCount: 0,
      capturedFrameCount: 0,
      pendingGpuFrames: 0,
      options: null,
      result: null
    };
    this.emit();
  }

  public clearResult(): void {
    if (this.state.phase === "capturing") {
      return;
    }
    this.state = {
      phase: "idle",
      requestedFrameCount: 0,
      capturedFrameCount: 0,
      pendingGpuFrames: 0,
      options: null,
      result: null
    };
    this.emit();
  }

  public isCaptureActive(): boolean {
    return this.state.phase === "capturing";
  }

  public shouldProfileUpdates(): boolean {
    return this.state.phase === "capturing" && Boolean(this.state.options?.includeUpdateTimings);
  }

  public shouldProfileDraws(): boolean {
    return this.monitoringMode || (this.state.phase === "capturing" && Boolean(this.state.options?.includeDrawTimings));
  }

  public shouldProfileGpuTimings(): boolean {
    return this.state.phase === "capturing" && Boolean(this.state.options?.includeGpuTimings);
  }

  public getDetailPreset(): ProfileCaptureDetailPreset {
    return this.state.options?.detailPreset ?? "minimal";
  }

  public setMonitoringMode(active: boolean): void {
    this.monitoringMode = active;
    if (!active) {
      this.monitoringDrawTimingsMs.clear();
      this.monitoringActiveSamples.clear();
    }
  }

  public isMonitoringActive(): boolean {
    return this.monitoringMode;
  }

  public getMonitoringDrawTimings(): ReadonlyMap<string, number> {
    return this.monitoringDrawTimingsMs;
  }

  public clearMonitoringDrawTimings(): void {
    this.monitoringDrawTimingsMs.clear();
  }

  public beginFrame(): void {
    if (this.state.phase !== "capturing") {
      return;
    }
    this.currentFrame = {
      frameIndex: this.completedFrames.length,
      cpuRoots: [],
      cpuRootIndex: new Map(),
      actors: new Map()
    };
    this.currentChunkStack = [];
    this.currentMirrorChunkStack = [];
    this.activeDrawSamples.clear();
    this.state = {
      ...this.state,
      pendingGpuFrames: this.shouldProfileGpuTimings() ? 1 : 0
    };
    this.emit();
  }

  public finishFrame(payload: { cpuTotalDurationMs: number; gpu?: ProfileFrameGpuInput }): void {
    if (this.state.phase !== "capturing" || !this.currentFrame) {
      return;
    }
    const frame = this.currentFrame;
    this.currentFrame = null;
    this.currentChunkStack = [];
    this.currentMirrorChunkStack = [];
    this.activeDrawSamples.clear();
    const gpuStatus = this.state.options?.includeGpuTimings
      ? payload.gpu?.status ?? "unavailable"
      : "disabled";
    const gpuRoots = (payload.gpu?.roots ?? [])
      .filter((chunk) => chunk.durationMs > 0)
      .sort((a, b) => b.durationMs - a.durationMs || a.label.localeCompare(b.label));
    const gpuTotalDurationMs =
      gpuStatus === "captured"
        ? gpuRoots.reduce((sum, chunk) => sum + chunk.durationMs, 0)
        : null;
    this.completedFrames.push({
      frameIndex: frame.frameIndex,
      cpu: {
        totalDurationMs: payload.cpuTotalDurationMs,
        roots: frame.cpuRoots
          .map((root) => snapshotChunk(root))
          .filter((root): root is ProfileChunkSnapshot => Boolean(root))
          .sort((a, b) => b.durationMs - a.durationMs || a.label.localeCompare(b.label))
      },
      gpu: {
        status: gpuStatus,
        totalDurationMs: gpuTotalDurationMs,
        roots: gpuRoots
      },
      actors: Array.from(frame.actors.values())
        .map((record) => snapshotActorRecord(record))
        .sort((a, b) => {
          const aTotal = (a.update?.durationMs ?? 0) + (a.drawCpu?.durationMs ?? 0) + (a.drawGpu?.durationMs ?? 0);
          const bTotal = (b.update?.durationMs ?? 0) + (b.drawCpu?.durationMs ?? 0) + (b.drawGpu?.durationMs ?? 0);
          return bTotal - aTotal || a.actorName.localeCompare(b.actorName);
        })
    });

    const capturedFrameCount = this.completedFrames.length;
    if (capturedFrameCount >= this.state.requestedFrameCount) {
      this.clearDrawHooks();
      const frames = [...this.completedFrames];
      const result: ProfileSessionResult = {
        id: `profile-session:${Date.now()}`,
        options: this.state.options!,
        startedAtIso: this.captureStartedAtIso ?? new Date().toISOString(),
        completedAtIso: new Date().toISOString(),
        frames,
        summary: buildProfileSummary({ frames })
      };
      this.state = {
        phase: "completed",
        requestedFrameCount: this.state.requestedFrameCount,
        capturedFrameCount,
        pendingGpuFrames: 0,
        options: this.state.options,
        result
      };
      this.captureStartedAtIso = null;
      this.completedFrames.length = 0;
      this.emit();
      return;
    }
    this.state = {
      ...this.state,
      capturedFrameCount,
      pendingGpuFrames: 0
    };
    this.emit();
  }

  public withFrameChunk<T>(label: string, run: () => T): T {
    const frame = this.currentFrame;
    if (!frame || this.state.phase !== "capturing") {
      return run();
    }
    const key = `frame:${slugifyProfileLabel(label)}`;
    const chunk =
      this.currentChunkStack.length > 0
        ? this.getOrCreateChildChunk(this.currentChunkStack[this.currentChunkStack.length - 1]!, key, label)
        : this.getOrCreateFrameRoot(frame, key, label);
    return this.runTimedChunk(chunk, run);
  }

  public withActorPhase<T>(actor: ActorProfileMeta, phase: "update" | "drawCpu", run: () => T): T {
    if (phase === "update" && !this.shouldProfileUpdates()) {
      return run();
    }
    if (phase === "drawCpu" && !this.shouldProfileDraws()) {
      return run();
    }
    const frame = this.currentFrame;
    if (!frame) {
      return run();
    }
    const actorRecord = this.getOrCreateActorRecord(frame, actor);
    const root = this.getOrCreatePhaseRoot(actorRecord, phase);
    const mirrorParent = this.currentChunkStack.length > 0 ? this.currentChunkStack[this.currentChunkStack.length - 1]! : null;
    const mirrorChunk =
      mirrorParent !== null ? this.getOrCreateChildChunk(mirrorParent, `actor:${actor.actorId}/phase:${phase}`, actor.actorName) : null;
    return this.runTimedChunk(root, run, mirrorChunk);
  }

  public withChunk<T>(label: string, run: () => T): T {
    if (this.currentChunkStack.length === 0) {
      return run();
    }
    const parent = this.currentChunkStack[this.currentChunkStack.length - 1]!;
    const chunk = this.getOrCreateChildChunk(parent, `${parent.id}/${slugifyProfileLabel(label)}`, label);
    const mirrorParent =
      this.currentMirrorChunkStack.length > 0
        ? this.currentMirrorChunkStack[this.currentMirrorChunkStack.length - 1]!
        : null;
    const mirrorChunk =
      mirrorParent !== null
        ? this.getOrCreateChildChunk(mirrorParent, `${mirrorParent.id}/${slugifyProfileLabel(label)}`, label)
        : null;
    return this.runTimedChunk(chunk, run, mirrorChunk);
  }

  public beginDrawSample(actor: ActorProfileMeta, sampleKey: string): void {
    if (!this.shouldProfileDraws()) {
      return;
    }
    if (this.monitoringMode && this.state.phase !== "capturing") {
      this.monitoringActiveSamples.set(sampleKey, { startedAtMs: performance.now(), actorId: actor.actorId });
      return;
    }
    const frame = this.currentFrame;
    if (!frame) {
      return;
    }
    const actorRecord = this.getOrCreateActorRecord(frame, actor);
    const root = this.getOrCreatePhaseRoot(actorRecord, "drawCpu");
    const mirrorParent = this.currentChunkStack.length > 0 ? this.currentChunkStack[this.currentChunkStack.length - 1]! : null;
    const mirrorChunk =
      mirrorParent !== null ? this.getOrCreateChildChunk(mirrorParent, `actor:${actor.actorId}/phase:drawCpu`, actor.actorName) : null;
    this.activeDrawSamples.set(sampleKey, {
      startedAtMs: performance.now(),
      actorRoot: root,
      mirrorChunk,
      previousChunkStack: this.currentChunkStack,
      previousMirrorChunkStack: this.currentMirrorChunkStack
    });
    this.currentChunkStack = [...this.currentChunkStack, root];
    this.currentMirrorChunkStack = mirrorChunk ? [...this.currentMirrorChunkStack, mirrorChunk] : this.currentMirrorChunkStack;
  }

  public endDrawSample(actor: ActorProfileMeta, sampleKey: string): void {
    if (!this.shouldProfileDraws()) {
      return;
    }
    if (this.monitoringMode && this.state.phase !== "capturing") {
      const monSample = this.monitoringActiveSamples.get(sampleKey);
      if (monSample) {
        this.monitoringActiveSamples.delete(sampleKey);
        const durationMs = performance.now() - monSample.startedAtMs;
        const prev = this.monitoringDrawTimingsMs.get(monSample.actorId) ?? durationMs;
        this.monitoringDrawTimingsMs.set(monSample.actorId, prev * 0.8 + durationMs * 0.2);
      }
      return;
    }
    const sample = this.activeDrawSamples.get(sampleKey);
    const frame = this.currentFrame;
    if (!sample || !frame) {
      return;
    }
    this.activeDrawSamples.delete(sampleKey);
    const durationMs = performance.now() - sample.startedAtMs;
    sample.actorRoot.durationMs += durationMs;
    if (sample.mirrorChunk) {
      sample.mirrorChunk.durationMs += durationMs;
    }
    this.currentChunkStack = sample.previousChunkStack;
    this.currentMirrorChunkStack = sample.previousMirrorChunkStack;
  }

  public syncDrawHooks(entries: Array<{ actor: ActorProfileMeta; object: THREE.Object3D }>): void {
    if (!this.shouldProfileDraws()) {
      this.clearDrawHooks();
      return;
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      entry.object.traverse((candidate) => {
        if (!isRenderableObject(candidate)) {
          return;
        }
        seen.add(candidate.uuid);
        const existing = this.wrappedDrawHooks.get(candidate.uuid);
        if (existing && existing.actor.actorId === entry.actor.actorId) {
          return;
        }
        if (existing) {
          this.restoreDrawHook(existing);
        }
        this.installDrawHook(candidate, entry.actor);
      });
    }
    for (const [uuid, wrapped] of [...this.wrappedDrawHooks.entries()]) {
      if (!seen.has(uuid)) {
        this.restoreDrawHook(wrapped);
      }
    }
  }

  public clearDrawHooks(): void {
    for (const wrapped of [...this.wrappedDrawHooks.values()]) {
      this.restoreDrawHook(wrapped);
    }
  }

  private runTimedChunk<T>(chunk: MutableProfileChunk, run: () => T, mirrorChunk?: MutableProfileChunk | null): T {
    const previousStack = this.currentChunkStack;
    const previousMirrorStack = this.currentMirrorChunkStack;
    this.currentChunkStack = [...previousStack, chunk];
    this.currentMirrorChunkStack = mirrorChunk ? [...previousMirrorStack, mirrorChunk] : previousMirrorStack;
    const startedAt = performance.now();
    try {
      const result = run();
      if (isPromiseLike(result)) {
        return result.finally(() => {
          const durationMs = performance.now() - startedAt;
          chunk.durationMs += durationMs;
          if (mirrorChunk) {
            mirrorChunk.durationMs += durationMs;
          }
          this.currentChunkStack = previousStack;
          this.currentMirrorChunkStack = previousMirrorStack;
        }) as T;
      }
      const durationMs = performance.now() - startedAt;
      chunk.durationMs += durationMs;
      if (mirrorChunk) {
        mirrorChunk.durationMs += durationMs;
      }
      this.currentChunkStack = previousStack;
      this.currentMirrorChunkStack = previousMirrorStack;
      return result;
    } finally {
      if (this.currentChunkStack[this.currentChunkStack.length - 1] === chunk) {
        this.currentChunkStack = previousStack;
      }
      if (mirrorChunk && this.currentMirrorChunkStack[this.currentMirrorChunkStack.length - 1] === mirrorChunk) {
        this.currentMirrorChunkStack = previousMirrorStack;
      }
    }
  }

  private getOrCreateFrameRoot(frame: FrameCaptureState, key: string, label: string): MutableProfileChunk {
    const existing = frame.cpuRootIndex.get(key);
    if (existing) {
      return existing;
    }
    const chunk = createChunk(key, label);
    frame.cpuRoots.push(chunk);
    frame.cpuRootIndex.set(key, chunk);
    return chunk;
  }

  private getOrCreateChildChunk(parent: MutableProfileChunk, key: string, label: string): MutableProfileChunk {
    const existing = parent.childIndex.get(key);
    if (existing) {
      return existing;
    }
    const chunk = createChunk(key, label);
    parent.children.push(chunk);
    parent.childIndex.set(key, chunk);
    return chunk;
  }

  private getOrCreateActorRecord(frame: FrameCaptureState, actor: ActorProfileMeta): MutableActorFrameRecord {
    const existing = frame.actors.get(actor.actorId);
    if (existing) {
      return existing;
    }
    const next: MutableActorFrameRecord = {
      ...actor,
      update: null,
      drawCpu: null,
      drawGpu: null
    };
    frame.actors.set(actor.actorId, next);
    return next;
  }

  private getOrCreatePhaseRoot(record: MutableActorFrameRecord, phase: ProfilePhaseKind): MutableProfileChunk {
    const key = phase === "update" ? "update" : phase === "drawCpu" ? "drawCpu" : "drawGpu";
    const existing = record[key];
    if (existing) {
      return existing;
    }
    const label = phase === "update" ? "Update" : phase === "drawCpu" ? "Draw (CPU)" : "Draw (GPU)";
    const root = createChunk(`actor:${record.actorId}/phase:${phase}`, label);
    record[key] = root;
    return root;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private installDrawHook(object: THREE.Object3D, actor: ActorProfileMeta): void {
    const originalBeforeRender = object.onBeforeRender;
    const originalAfterRender = object.onAfterRender;
    const sampleKey = `${actor.actorId}:${object.uuid}`;
    object.onBeforeRender = (...args) => {
      this.beginDrawSample(actor, sampleKey);
      if (typeof originalBeforeRender === "function") {
        originalBeforeRender.apply(object, args as Parameters<NonNullable<typeof originalBeforeRender>>);
      }
    };
    object.onAfterRender = (...args) => {
      try {
        if (typeof originalAfterRender === "function") {
          originalAfterRender.apply(object, args as Parameters<NonNullable<typeof originalAfterRender>>);
        }
      } finally {
        this.endDrawSample(actor, sampleKey);
      }
    };
    this.wrappedDrawHooks.set(object.uuid, {
      object,
      actor,
      originalBeforeRender,
      originalAfterRender
    });
  }

  private restoreDrawHook(wrapped: WrappedDrawHook): void {
    wrapped.object.onBeforeRender = wrapped.originalBeforeRender;
    wrapped.object.onAfterRender = wrapped.originalAfterRender;
    this.wrappedDrawHooks.delete(wrapped.object.uuid);
  }
}

export function slugifyProfileLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "chunk";
}

function isRenderableObject(object: THREE.Object3D): boolean {
  return Boolean(
    (object as THREE.Object3D & {
      isMesh?: boolean;
      isLine?: boolean;
      isLineSegments?: boolean;
      isLineLoop?: boolean;
      isPoints?: boolean;
      isSprite?: boolean;
    }).isMesh ||
      (object as any).isLine ||
      (object as any).isLineSegments ||
      (object as any).isLineLoop ||
      (object as any).isPoints ||
      (object as any).isSprite
  );
}
