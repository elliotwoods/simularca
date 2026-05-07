import type { ProjectionCacheFileV1 } from "@/types/ipc";

export interface ProjectedPolyline {
  points: ([number, number, number] | null)[];
  hitCount: number;
  resolution: number;
  targetCount: number;
}

interface CacheEntry {
  polyline: ProjectedPolyline;
  signature: string | null;
  updatedAtIso?: string;
}

const cache = new Map<string, CacheEntry>();

export function setProjectedPolyline(actorId: string, value: ProjectedPolyline): void {
  const existing = cache.get(actorId);
  cache.set(actorId, {
    polyline: value,
    signature: existing?.signature ?? null,
    updatedAtIso: existing?.updatedAtIso
  });
  scheduleFlush();
}

export function getProjectedPolyline(actorId: string): ProjectedPolyline | null {
  return cache.get(actorId)?.polyline ?? null;
}

export function setProjectedPolylineSignature(actorId: string, signature: string): void {
  const existing = cache.get(actorId);
  if (!existing) {
    return;
  }
  cache.set(actorId, {
    polyline: existing.polyline,
    signature,
    updatedAtIso: new Date().toISOString()
  });
  scheduleFlush();
}

export function getProjectedPolylineSignature(actorId: string): string | null {
  return cache.get(actorId)?.signature ?? null;
}

export function clearProjectedPolyline(actorId: string): void {
  cache.delete(actorId);
  scheduleFlush();
}

export function clearAllProjectedPolylines(): void {
  if (cache.size === 0) {
    return;
  }
  cache.clear();
  // Don't schedule a flush here — clearing is usually a project-switch which has its own
  // lifecycle (the new project hydrates over us, and a flush on the old project's storage
  // would be wrong anyway).
}

export function hydrateProjectionCacheFromFile(file: ProjectionCacheFileV1 | null): void {
  cache.clear();
  if (!file || file.version !== 1 || !file.entries) {
    return;
  }
  for (const [actorId, entry] of Object.entries(file.entries)) {
    if (!entry || !entry.polyline || !Array.isArray(entry.polyline.points)) {
      continue;
    }
    cache.set(actorId, {
      polyline: {
        points: entry.polyline.points,
        hitCount: typeof entry.polyline.hitCount === "number" ? entry.polyline.hitCount : 0,
        resolution: typeof entry.polyline.resolution === "number" ? entry.polyline.resolution : entry.polyline.points.length,
        targetCount: typeof entry.polyline.targetCount === "number" ? entry.polyline.targetCount : 0
      },
      signature: typeof entry.signature === "string" ? entry.signature : null,
      updatedAtIso: typeof entry.updatedAtIso === "string" ? entry.updatedAtIso : undefined
    });
  }
}

export function snapshotProjectionCache(): ProjectionCacheFileV1 {
  const entries: ProjectionCacheFileV1["entries"] = {};
  for (const [actorId, entry] of cache.entries()) {
    if (!entry.signature) {
      // Skip entries that have no signature — they can't survive a session round-trip
      // because we can't tell whether they're still valid on reload.
      continue;
    }
    entries[actorId] = {
      signature: entry.signature,
      polyline: entry.polyline,
      updatedAtIso: entry.updatedAtIso
    };
  }
  return { version: 1, entries };
}

// === Persistence wiring ===

interface ProjectionCacheStorage {
  writeProjectionCache(projectPath: string, payload: ProjectionCacheFileV1): Promise<void>;
}

let storage: ProjectionCacheStorage | null = null;
let getActiveProjectPath: (() => string | null) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 1000;

export function attachProjectionCacheStorage(
  s: ProjectionCacheStorage,
  resolveActivePath: () => string | null
): void {
  storage = s;
  getActiveProjectPath = resolveActivePath;
}

function scheduleFlush(): void {
  if (!storage || !getActiveProjectPath) {
    return;
  }
  if (flushTimer !== null) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushProjectionCacheNow();
  }, FLUSH_DEBOUNCE_MS);
}

export async function flushProjectionCacheNow(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!storage || !getActiveProjectPath) {
    return;
  }
  const projectPath = getActiveProjectPath();
  if (!projectPath) {
    return;
  }
  try {
    await storage.writeProjectionCache(projectPath, snapshotProjectionCache());
  } catch (err) {
    // Best-effort: log and continue. The cache will be retried next time something updates.
    // eslint-disable-next-line no-console
    console.warn("[projectionCache] flush failed:", err);
  }
}
