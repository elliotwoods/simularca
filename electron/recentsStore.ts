import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

import type { RecentsEntry } from "../src/types/ipc";

const MAX_RECENTS = 20;

const RecentsEntrySchema = z.object({
  uuid: z.string().min(1),
  path: z.string().min(1),
  cachedName: z.string(),
  lastOpenedAtIso: z.string(),
  lastSnapshotName: z.string().nullable()
});

const RecentsFileSchema = z.array(RecentsEntrySchema);

export async function loadRecents(filePath: string): Promise<RecentsEntry[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const result = RecentsFileSchema.safeParse(parsed);
    if (!result.success) {
      return [];
    }
    return result.data.slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export async function saveRecents(filePath: string, entries: RecentsEntry[]): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const capped = entries.slice(0, MAX_RECENTS);
  await fsp.writeFile(filePath, JSON.stringify(capped, null, 2), "utf8");
}

/** Add or move-to-front by uuid. */
export function promoteRecentInPlace(entries: RecentsEntry[], next: RecentsEntry): RecentsEntry[] {
  const filtered = entries.filter((e) => e.uuid !== next.uuid);
  return [next, ...filtered].slice(0, MAX_RECENTS);
}

export function findRecentByUuid(entries: RecentsEntry[], uuid: string): RecentsEntry | null {
  return entries.find((e) => e.uuid === uuid) ?? null;
}

export function removeRecentByUuid(entries: RecentsEntry[], uuid: string): RecentsEntry[] {
  return entries.filter((e) => e.uuid !== uuid);
}

export function updateRecentPath(
  entries: RecentsEntry[],
  uuid: string,
  newPath: string,
  newCachedName: string
): RecentsEntry[] {
  return entries.map((e) =>
    e.uuid === uuid ? { ...e, path: newPath, cachedName: newCachedName } : e
  );
}
