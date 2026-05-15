import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  POINTER_SCHEMA_VERSION,
  SIMULARCA_EXTENSION,
  type ProjectIdentity,
  type ProjectPointer
} from "../src/types/ipc.js";

const ProjectPointerSchema = z.object({
  uuid: z.string().min(1),
  pointerSchemaVersion: z.literal(POINTER_SCHEMA_VERSION),
  format: z.literal("folder")
});

export function createPointer(): ProjectPointer {
  return {
    uuid: randomUUID(),
    pointerSchemaVersion: POINTER_SCHEMA_VERSION,
    format: "folder"
  };
}

export async function readPointer(simularcaFilePath: string): Promise<ProjectPointer> {
  const raw = await fsp.readFile(simularcaFilePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid .simularca pointer file (not JSON) at ${simularcaFilePath}: ${(error as Error).message}`
    );
  }
  const result = ProjectPointerSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid .simularca pointer file at ${simularcaFilePath}: ${result.error.message}`
    );
  }
  return result.data;
}

export async function writePointer(simularcaFilePath: string, pointer: ProjectPointer): Promise<void> {
  await fsp.mkdir(path.dirname(simularcaFilePath), { recursive: true });
  await fsp.writeFile(simularcaFilePath, JSON.stringify(pointer, null, 2), "utf8");
}

export function projectNameFromSimularcaPath(simularcaPath: string): string {
  return path.basename(simularcaPath, SIMULARCA_EXTENSION);
}

export function pointerFilePath(folderPath: string, projectName: string): string {
  return path.join(folderPath, `${projectName}${SIMULARCA_EXTENSION}`);
}

/**
 * Look in `folderPath` for the lone `<name>.simularca` file. If multiple are
 * found (user manipulation), return the first by sort order and let the caller
 * log a warning.
 */
export async function discoverSimularcaFile(folderPath: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(folderPath);
  } catch {
    return null;
  }
  const matches = entries
    .filter((name) => name.toLowerCase().endsWith(SIMULARCA_EXTENSION))
    .sort();
  const first = matches[0];
  if (first === undefined) {
    return null;
  }
  return path.join(folderPath, first);
}

export async function discoverAllSimularcaFiles(folderPath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(folderPath);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.toLowerCase().endsWith(SIMULARCA_EXTENSION))
    .sort()
    .map((name) => path.join(folderPath, name));
}

/**
 * Repair a project folder whose `.simularca` is missing or corrupt by writing a
 * fresh pointer with a new UUID. The project name is taken from the folder
 * basename. Returns the resulting identity.
 */
export async function repairPointer(folderPath: string): Promise<ProjectIdentity> {
  const projectName = path.basename(folderPath);
  const filePath = pointerFilePath(folderPath, projectName);
  const pointer = createPointer();
  await writePointer(filePath, pointer);
  return { uuid: pointer.uuid, path: filePath, name: projectName };
}

export async function ensurePointerExists(folderPath: string, projectName: string): Promise<ProjectIdentity> {
  const filePath = pointerFilePath(folderPath, projectName);
  if (fs.existsSync(filePath)) {
    const pointer = await readPointer(filePath);
    return { uuid: pointer.uuid, path: filePath, name: projectName };
  }
  const pointer = createPointer();
  await writePointer(filePath, pointer);
  return { uuid: pointer.uuid, path: filePath, name: projectName };
}

export async function loadIdentity(simularcaPath: string): Promise<ProjectIdentity> {
  const pointer = await readPointer(simularcaPath);
  return {
    uuid: pointer.uuid,
    path: simularcaPath,
    name: projectNameFromSimularcaPath(simularcaPath)
  };
}
