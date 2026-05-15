import type { AppKernel } from "@/app/kernel";
import type { ActorNode, FileParameterDefinition, ParameterValue, ParameterValues, SelectionEntry } from "@/core/types";
import { createActorFromDescriptor } from "@/features/actors/actorCatalog";
import { importFileForActorParam, type FileImportResult } from "@/features/imports/fileParameterImport";

export interface ActorFileImportOption {
  descriptorId: string;
  actorType: string;
  label: string;
  description: string;
  iconGlyph: string;
  fileExtensions: string[];
  fileDefinition: FileParameterDefinition;
}

export interface SelectedActorFileImportTarget {
  actorId: string;
  actorName: string;
  fileDefinition: FileParameterDefinition;
}

export type NewActorFileDropAction =
  | { kind: "none" }
  | { kind: "direct"; descriptorId: string }
  | { kind: "choose"; options: ActorFileImportOption[] };

function normalizeExtension(value: string): string {
  const next = value.trim().toLowerCase();
  if (!next) {
    return "";
  }
  return next.startsWith(".") ? next : `.${next}`;
}

function fileExtensionFromName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) {
    return "";
  }
  return normalizeExtension(fileName.slice(dotIndex));
}

function actorNameFromFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "Actor";
  }
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex <= 0) {
    return trimmed;
  }
  const stem = trimmed.slice(0, dotIndex).trim();
  return stem || trimmed;
}

function fileDefinitionsFromDescriptor(kernel: AppKernel, descriptorId: string): FileParameterDefinition[] {
  const descriptor = kernel.descriptorRegistry.get(descriptorId);
  if (!descriptor) {
    return [];
  }
  return descriptor.schema.params.filter(
    (definition): definition is FileParameterDefinition => definition.type === "file"
  );
}

function resolveActorDescriptorId(kernel: AppKernel, actor: ActorNode): string | null {
  const descriptor = kernel.descriptorRegistry.listByKind("actor").find((entry) => {
    if (!entry.spawn) {
      return false;
    }
    if (entry.spawn.actorType !== actor.actorType) {
      return false;
    }
    return entry.spawn.pluginType === actor.pluginType;
  });
  return descriptor?.id ?? null;
}

function optionFromDescriptor(kernel: AppKernel, descriptorId: string): ActorFileImportOption | null {
  const descriptor = kernel.descriptorRegistry.get(descriptorId);
  if (!descriptor?.spawn) {
    return null;
  }
  const fileDefinitions = fileDefinitionsFromDescriptor(kernel, descriptorId);
  const fileDefinition = fileDefinitions[0];
  if (!fileDefinition) {
    return null;
  }

  const bySpawn = (descriptor.spawn.fileExtensions ?? []).map(normalizeExtension).filter(Boolean);
  const bySchema = fileDefinitions.flatMap((entry) => entry.accept.map(normalizeExtension)).filter(Boolean);
  const fileExtensions = [...new Set([...bySpawn, ...bySchema])];

  return {
    descriptorId,
    actorType: descriptor.spawn.actorType,
    label: descriptor.spawn.label ?? descriptor.schema.title,
    description: descriptor.spawn.description ?? "",
    iconGlyph: descriptor.spawn.iconGlyph ?? descriptor.spawn.actorType.toUpperCase(),
    fileExtensions,
    fileDefinition
  };
}

export function listActorFileImportOptions(kernel: AppKernel): ActorFileImportOption[] {
  return kernel.descriptorRegistry
    .listByKind("actor")
    .map((descriptor) => optionFromDescriptor(kernel, descriptor.id))
    .filter((entry): entry is ActorFileImportOption => Boolean(entry))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function listCompatibleActorFileImportOptions(kernel: AppKernel, fileName: string): ActorFileImportOption[] {
  const extension = fileExtensionFromName(fileName);
  if (!extension) {
    return [];
  }
  return listActorFileImportOptions(kernel).filter((option) => option.fileExtensions.includes(extension));
}

export function resolveNewActorFileDropAction(options: ActorFileImportOption[]): NewActorFileDropAction {
  if (options.length === 0) {
    return { kind: "none" };
  }
  if (options.length === 1) {
    const onlyOption = options[0];
    if (!onlyOption) {
      return { kind: "none" };
    }
    return { kind: "direct", descriptorId: onlyOption.descriptorId };
  }
  return { kind: "choose", options };
}

export function resolveSelectedActorFileImportTarget(
  kernel: AppKernel,
  args: {
    actors: Record<string, ActorNode>;
    selection: SelectionEntry[];
  }
): SelectedActorFileImportTarget | null {
  if (args.selection.length !== 1 || args.selection[0]?.kind !== "actor") {
    return null;
  }
  const actor = args.actors[args.selection[0].id];
  if (!actor) {
    return null;
  }
  const descriptorId = resolveActorDescriptorId(kernel, actor);
  if (!descriptorId) {
    return null;
  }
  const fileDefinitions = fileDefinitionsFromDescriptor(kernel, descriptorId);
  if (fileDefinitions.length !== 1) {
    return null;
  }
  const compatibleDefinition = fileDefinitions[0];
  if (!compatibleDefinition) {
    return null;
  }
  return {
    actorId: actor.id,
    actorName: actor.name,
    fileDefinition: compatibleDefinition
  };
}

export async function importFileIntoActor(
  kernel: AppKernel,
  args: {
    actorId: string;
    definition: FileParameterDefinition;
    sourcePath: string;
    projectPath: string;
  }
): Promise<FileImportResult> {
  const imported = await importFileForActorParam(kernel, {
    projectPath: args.projectPath,
    sourcePath: args.sourcePath,
    definition: args.definition
  });
  const patch: ParameterValues = {};
  for (const key of args.definition.clearsParams ?? []) {
    patch[key] = null;
  }
  patch[args.definition.key] = imported.asset.id;
  if (imported.extraParams) {
    for (const [key, value] of Object.entries(imported.extraParams)) {
      patch[key] = value as ParameterValue;
    }
  }
  kernel.store.getState().actions.updateActorParams(args.actorId, patch);
  return imported;
}

export async function importFileAsActor(
  kernel: AppKernel,
  args: {
    descriptorId: string;
    sourcePath: string;
    fileName: string;
    projectPath: string;
  }
): Promise<string> {
  const option = optionFromDescriptor(kernel, args.descriptorId);
  if (!option) {
    throw new Error(`Actor type is not file-import capable: ${args.descriptorId}`);
  }

  const actorId = createActorFromDescriptor(kernel, args.descriptorId);
  if (!actorId) {
    throw new Error(`Unable to create actor: ${args.descriptorId}`);
  }

  kernel.store.getState().actions.renameNode({ kind: "actor", id: actorId }, actorNameFromFileName(args.fileName));

  const importedAsset = await importFileForActorParam(kernel, {
    projectPath: args.projectPath,
    sourcePath: args.sourcePath,
    definition: option.fileDefinition
  });

  kernel.store.getState().actions.updateActorParams(actorId, {
    [option.fileDefinition.key]: importedAsset.asset.id
  });
  kernel.store.getState().actions.setStatus(
    `${option.label} imported ${args.fileName} (${option.fileExtensions.join(", ")})`
  );
  kernel.projectService.queueAutosave();
  return actorId;
}
