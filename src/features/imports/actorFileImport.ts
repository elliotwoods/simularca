import type { AppKernel } from "@/app/kernel";
import { createActorFromDescriptor } from "@/features/actors/actorCatalog";
import { importFileForActorParam } from "@/features/imports/fileParameterImport";
import type { FileParameterDefinition } from "@/core/types";

export interface ActorFileImportOption {
  descriptorId: string;
  actorType: string;
  label: string;
  description: string;
  iconGlyph: string;
  fileExtensions: string[];
  fileDefinition: FileParameterDefinition;
}

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

function fileDefinitionsFromDescriptor(kernel: AppKernel, descriptorId: string): FileParameterDefinition[] {
  const descriptor = kernel.descriptorRegistry.get(descriptorId);
  if (!descriptor) {
    return [];
  }
  return descriptor.schema.params.filter(
    (definition): definition is FileParameterDefinition => definition.type === "file"
  );
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

export async function importFileAsActor(
  kernel: AppKernel,
  args: {
    descriptorId: string;
    sourcePath: string;
    fileName: string;
    sessionName: string;
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

  const importedAsset = await importFileForActorParam(kernel, {
    sessionName: args.sessionName,
    sourcePath: args.sourcePath,
    definition: option.fileDefinition
  });

  kernel.store.getState().actions.updateActorParams(actorId, {
    [option.fileDefinition.key]: importedAsset.id
  });
  kernel.store.getState().actions.setStatus(
    `${option.label} imported ${args.fileName} (${option.fileExtensions.join(", ")})`
  );
  kernel.sessionService.queueAutosave();
  return actorId;
}
