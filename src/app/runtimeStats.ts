// Renderer-side diagnostic heartbeat.
// Posts memory + GPU resource counts to the Electron main process every
// HEARTBEAT_INTERVAL_MS, so a frozen renderer leaves a clear trail in the
// runtime log even if the live debug bridge is starved.

import type { AppKernel } from "./kernel";

const HEARTBEAT_INTERVAL_MS = 30_000;
const STALL_THRESHOLD_MS = 100;
const STALL_RING_SIZE = 32;
const HMR_FLAG = "__simularca_runtime_stats_started__";

export interface ViewportStatsSnapshot {
  geometries?: number;
  textures?: number;
  programs?: number;
  triangles?: number;
  calls?: number;
  frame?: number;
}

type ViewportStatsProvider = () => ViewportStatsSnapshot | null;

interface StallSample {
  atMs: number;          // performance.now() when the stall ended
  deltaMs: number;       // gap since previous frame start
  hidden: boolean;       // true if page was document.hidden during the gap
  focused: boolean;      // true if window had focus during the gap
}

interface StatsRegistry {
  provider: ViewportStatsProvider | null;
  frameCounter: number;
  intervalHandle: ReturnType<typeof setInterval> | null;
  lastFrameAtMs: number;
  lastFrameCounter: number;
  // Frame-interval tracking for stall detection (>STALL_THRESHOLD_MS).
  maxIntervalSinceTickMs: number;
  stallCountSinceTick: number;
  recentStalls: StallSample[];
}

declare global {
  // eslint-disable-next-line no-var
  var __simularca_stats__: StatsRegistry | undefined;
}

function getRegistry(): StatsRegistry {
  if (!globalThis.__simularca_stats__) {
    globalThis.__simularca_stats__ = {
      provider: null,
      frameCounter: 0,
      intervalHandle: null,
      lastFrameAtMs: performance.now(),
      lastFrameCounter: 0,
      maxIntervalSinceTickMs: 0,
      stallCountSinceTick: 0,
      recentStalls: []
    };
  }
  return globalThis.__simularca_stats__;
}

export function setViewportStatsProvider(provider: ViewportStatsProvider | null): void {
  getRegistry().provider = provider;
}

export function bumpFrameCounter(): void {
  const reg = getRegistry();
  const now = performance.now();
  const delta = now - reg.lastFrameAtMs;
  reg.frameCounter++;
  reg.lastFrameAtMs = now;
  if (delta > reg.maxIntervalSinceTickMs) {
    reg.maxIntervalSinceTickMs = delta;
  }
  if (delta > STALL_THRESHOLD_MS) {
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const focused = typeof document !== "undefined" && document.hasFocus();
    reg.stallCountSinceTick++;
    reg.recentStalls.push({ atMs: now, deltaMs: delta, hidden, focused });
    if (reg.recentStalls.length > STALL_RING_SIZE) {
      reg.recentStalls.shift();
    }
  }
}

interface PerfMemory {
  jsHeapSizeLimit?: number;
  totalJSHeapSize?: number;
  usedJSHeapSize?: number;
}

function readPerfMemory(): PerfMemory | null {
  // performance.memory exposes properties as non-enumerable getters on its
  // prototype, so spreading/JSON.stringify yields an empty object. Read each
  // property explicitly.
  const mem = (performance as unknown as { memory?: PerfMemory }).memory;
  if (!mem) {
    return null;
  }
  return {
    jsHeapSizeLimit: mem.jsHeapSizeLimit,
    totalJSHeapSize: mem.totalJSHeapSize,
    usedJSHeapSize: mem.usedJSHeapSize
  };
}

export function startRuntimeStatsHeartbeat(kernel: AppKernel): void {
  if ((globalThis as Record<string, unknown>)[HMR_FLAG]) {
    // Survives Vite HMR — interval already running from a prior module load.
    return;
  }
  (globalThis as Record<string, unknown>)[HMR_FLAG] = true;

  const log = (payload: Record<string, unknown>): void => {
    try {
      const api = (window as unknown as {
        electronAPI?: { logRuntimeStats?: (p: Record<string, unknown>) => void };
      }).electronAPI;
      api?.logRuntimeStats?.(payload);
    } catch {
      /* ignore — IPC may be torn down */
    }
  };

  const tick = (): void => {
    const reg = getRegistry();
    const now = performance.now();
    const framesSinceLast = reg.frameCounter - reg.lastFrameCounter;
    reg.lastFrameCounter = reg.frameCounter;
    const state = kernel.store.getState().state;
    const viewportStats = (() => {
      try {
        return reg.provider?.() ?? null;
      } catch {
        return null;
      }
    })();
    // Only include stalls that occurred within this heartbeat window —
    // older entries from the ring re-appear in every heartbeat and dominate
    // the log otherwise. Drop the `recent` block entirely when empty.
    const recentWindowMs = HEARTBEAT_INTERVAL_MS;
    const recent = reg.recentStalls
      .filter((s) => now - s.atMs <= recentWindowMs)
      .map((s) => ({
        deltaMs: Math.round(s.deltaMs),
        ageMs: Math.round(now - s.atMs),
        h: s.hidden ? 1 : 0,
        f: s.focused ? 1 : 0
      }));
    const stallSnapshot: Record<string, unknown> = {
      maxIntervalMs: Math.round(reg.maxIntervalSinceTickMs),
      stallCount: reg.stallCountSinceTick,
      thresholdMs: STALL_THRESHOLD_MS
    };
    if (recent.length > 0) {
      stallSnapshot.recent = recent;
    }
    reg.maxIntervalSinceTickMs = 0;
    reg.stallCountSinceTick = 0;
    if (!state.runtimeDebug?.heartbeatLoggingEnabled) {
      return;
    }
    log({
      ts: new Date().toISOString(),
      mem: readPerfMemory(),
      frames: { total: reg.frameCounter, deltaSinceLast: framesSinceLast, lastFrameAgoMs: Math.round(now - reg.lastFrameAtMs) },
      stalls: stallSnapshot,
      actors: Object.keys(state.actors ?? {}).length,
      project: state.activeProject ? { name: state.activeProject.name, snapshot: state.activeSnapshotName ?? null } : null,
      viewport: viewportStats
    });
  };

  // Fire one immediate tick so the log shows the heartbeat was wired up,
  // then start the periodic interval.
  tick();
  const reg = getRegistry();
  reg.intervalHandle = setInterval(tick, HEARTBEAT_INTERVAL_MS);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      const r = getRegistry();
      if (r.intervalHandle) {
        clearInterval(r.intervalHandle);
        r.intervalHandle = null;
      }
      (globalThis as Record<string, unknown>)[HMR_FLAG] = false;
    });
  }
}
