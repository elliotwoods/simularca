import { useEffect, useMemo, useRef } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { ActorNode, FileParameterDefinition, ParameterDefinition } from "@/core/types";
import type { ReloadableDescriptor } from "@/core/hotReload/types";
import { importFileForActorParam } from "@/features/imports/fileParameterImport";
import { FileField, NumberField, SelectField, TextField, ToggleField } from "@/ui/widgets";

type BindingValue = number | string | boolean;

function resolveActorDescriptor(
  actor: ActorNode,
  descriptors: ReloadableDescriptor[]
): ReloadableDescriptor | undefined {
  return descriptors.find((descriptor) => {
    if (!descriptor.spawn) {
      return false;
    }
    if (descriptor.spawn.actorType !== actor.actorType) {
      return false;
    }
    return descriptor.spawn.pluginType === actor.pluginType;
  });
}

function inferParamType(value: BindingValue): "number" | "boolean" | "string" {
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return "string";
}

function getFallbackDefinitionsFromParams(actor: ActorNode): ParameterDefinition[] {
  return Object.entries(actor.params).map(([key, value]) => ({
    key,
    label: key,
    type: inferParamType(value)
  }));
}

function getParameterDefinitions(actor: ActorNode, descriptors: ReloadableDescriptor[]): ParameterDefinition[] {
  const descriptor = resolveActorDescriptor(actor, descriptors);
  const schemaParams = descriptor?.schema.params ?? [];
  if (schemaParams.length > 0) {
    return schemaParams;
  }
  return getFallbackDefinitionsFromParams(actor);
}

function defaultValueForDefinition(definition: ParameterDefinition): BindingValue {
  if (definition.type === "number") {
    return 0;
  }
  if (definition.type === "boolean") {
    return false;
  }
  if (definition.type === "select") {
    return definition.options[0] ?? "";
  }
  return "";
}

function bindingValueFor(definition: ParameterDefinition, actor: ActorNode): BindingValue {
  const value = actor.params[definition.key];
  if (value !== undefined) {
    return value;
  }
  return defaultValueForDefinition(definition);
}

function commonDefinitionsForGroup(
  actorSelection: ActorNode[],
  descriptors: ReloadableDescriptor[]
): ParameterDefinition[] {
  const firstActor = actorSelection[0];
  if (!firstActor) {
    return [];
  }
  const firstDefinitions = getParameterDefinitions(firstActor, descriptors);
  const otherDefinitionsByActor = actorSelection.slice(1).map((actor) => {
    return new Map(getParameterDefinitions(actor, descriptors).map((definition) => [definition.key, definition]));
  });

  return firstDefinitions.filter((definition) =>
    otherDefinitionsByActor.every((definitions) => definitions.get(definition.key)?.type === definition.type)
  );
}

function isMixedValue(values: BindingValue[]): boolean {
  const first = values[0];
  if (first === undefined) {
    return false;
  }
  return values.some((value) => value !== first);
}

function buildFileFilters(definition: FileParameterDefinition): { name: string; extensions: string[] }[] {
  const extensions = definition.accept
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."))
    .map((extension) => extension.slice(1))
    .filter((extension) => extension.length > 0);

  if (extensions.length === 0) {
    return [];
  }

  return [
    {
      name: definition.label,
      extensions
    }
  ];
}

async function pickFileFromDialog(definition: FileParameterDefinition): Promise<string | null> {
  if (!window.electronAPI) {
    return null;
  }
  return window.electronAPI.openFileDialog({
    title: definition.dialogTitle ?? `Select ${definition.label}`,
    filters: buildFileFilters(definition)
  });
}

export function InspectorPane() {
  const kernel = useKernel();
  const selection = useAppStore((store) => store.state.selection);
  const actors = useAppStore((store) => store.state.actors);
  const assets = useAppStore((store) => store.state.assets);
  const splatDiagnosticsByActorId = useAppStore((store) => store.state.splatDiagnosticsByActorId);
  const mode = useAppStore((store) => store.state.mode);
  const sessionName = useAppStore((store) => store.state.activeSessionName);
  const autosaveTimeoutRef = useRef<number | null>(null);

  const actorDescriptors = kernel.descriptorRegistry.listByKind("actor");

  const actorSelection = useMemo(
    () =>
      selection
        .filter((entry) => entry.kind === "actor")
        .map((entry) => actors[entry.id])
        .filter((actor): actor is NonNullable<typeof actor> => Boolean(actor)),
    [selection, actors]
  );

  const definitions = useMemo(() => {
    const first = actorSelection[0];
    if (!first) {
      return [];
    }
    if (actorSelection.length === 1) {
      return getParameterDefinitions(first, actorDescriptors);
    }
    return commonDefinitionsForGroup(actorSelection, actorDescriptors);
  }, [actorSelection, actorDescriptors]);

  const readOnly = mode === "web-ro";

  useEffect(
    () => () => {
      if (autosaveTimeoutRef.current !== null) {
        window.clearTimeout(autosaveTimeoutRef.current);
      }
    },
    []
  );

  const scheduleAutosave = () => {
    if (autosaveTimeoutRef.current !== null) {
      window.clearTimeout(autosaveTimeoutRef.current);
    }
    autosaveTimeoutRef.current = window.setTimeout(() => {
      kernel.sessionService.queueAutosave();
      autosaveTimeoutRef.current = null;
    }, 120);
  };

  const updateSelectedActorParams = (key: string, nextValue: BindingValue): void => {
    for (const actor of actorSelection) {
      kernel.store.getState().actions.updateActorParams(actor.id, {
        [key]: nextValue
      });
    }
    scheduleAutosave();
  };

  if (actorSelection.length === 0) {
    return <div className="inspector-empty">Select one or more actors/components</div>;
  }

  if (definitions.length === 0) {
    return <div className="inspector-empty">No common editable params in current selection</div>;
  }

  const singleSelection = actorSelection.length === 1 ? actorSelection[0] : null;
  const showSplatDiagnostics = singleSelection?.actorType === "gaussian-splat";
  const splatDiagnostics = showSplatDiagnostics ? splatDiagnosticsByActorId[singleSelection.id] : undefined;
  const formatVector = (vector?: [number, number, number]): string =>
    vector ? `${vector[0].toFixed(3)}, ${vector[1].toFixed(3)}, ${vector[2].toFixed(3)}` : "n/a";

  return (
    <div className="inspector-pane-root custom-inspector">
      {definitions.map((definition) => {
        const values = actorSelection.map((actor) => bindingValueFor(definition, actor));
        const mixed = isMixedValue(values);
        const current = values[0] ?? defaultValueForDefinition(definition);

        if (definition.type === "number") {
          return (
            <NumberField
              key={definition.key}
              label={definition.label}
              value={typeof current === "number" ? current : 0}
              mixed={mixed}
              min={definition.min}
              max={definition.max}
              step={definition.step}
              precision={definition.precision}
              unit={definition.unit}
              dragSpeed={definition.dragSpeed}
              disabled={readOnly}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "boolean") {
          return (
            <ToggleField
              key={definition.key}
              label={definition.label}
              checked={Boolean(current)}
              mixed={mixed}
              disabled={readOnly}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "select") {
          return (
            <SelectField
              key={definition.key}
              label={definition.label}
              value={typeof current === "string" ? current : ""}
              mixed={mixed}
              options={definition.options}
              disabled={readOnly}
              onChange={(next) => {
                updateSelectedActorParams(definition.key, next);
              }}
            />
          );
        }

        if (definition.type === "file") {
          const assetId = typeof current === "string" ? current : "";
          const asset = mixed ? undefined : assets.find((entry) => entry.id === assetId);
          return (
            <FileField
              key={definition.key}
              label={definition.label}
              value={assetId}
              mixed={mixed}
              asset={asset}
              disabled={readOnly}
              onBrowse={() => {
                void (async () => {
                  try {
                    const sourcePath = await pickFileFromDialog(definition);
                    if (!sourcePath) {
                      if (!window.electronAPI) {
                        kernel.store
                          .getState()
                          .actions.setStatus("Desktop file dialogs are only available in Electron mode.");
                      }
                      return;
                    }

                    const importedAsset = await importFileForActorParam(kernel, {
                      sessionName,
                      sourcePath,
                      definition
                    });

                    updateSelectedActorParams(definition.key, importedAsset.id);
                    kernel.store
                      .getState()
                      .actions.setStatus(`${definition.label} imported: ${importedAsset.sourceFileName}`);
                  } catch (error) {
                    const message = error instanceof Error ? error.message : "Unknown file import error";
                    kernel.store.getState().actions.setStatus(`Unable to import ${definition.label}: ${message}`);
                  }
                })();
              }}
              onClear={() => {
                updateSelectedActorParams(definition.key, "");
                kernel.store.getState().actions.setStatus(`${definition.label} cleared.`);
              }}
            />
          );
        }

        return (
          <TextField
            key={definition.key}
            label={definition.label}
            value={typeof current === "string" ? current : ""}
            mixed={mixed}
            disabled={readOnly}
            onChange={(next) => {
              updateSelectedActorParams(definition.key, next);
            }}
          />
        );
      })}
      {showSplatDiagnostics ? (
        <section className="inspector-debug-card">
          <header>
            <h4>Gaussian Splat Diagnostics</h4>
          </header>
          {!splatDiagnostics ? (
            <p className="panel-empty">Diagnostics unavailable. Load a splat asset to populate stats.</p>
          ) : (
            <dl className="inspector-debug-list">
              <div>
                <dt>Backend</dt>
                <dd>{splatDiagnostics.backend}</dd>
              </div>
              <div>
                <dt>Loader</dt>
                <dd>{splatDiagnostics.loader}</dd>
              </div>
              <div>
                <dt>Loader Version</dt>
                <dd>{splatDiagnostics.loaderVersion ?? "n/a"}</dd>
              </div>
              <div>
                <dt>Asset</dt>
                <dd>{splatDiagnostics.assetFileName ?? "n/a"}</dd>
              </div>
              <div>
                <dt>Point Count</dt>
                <dd>{splatDiagnostics.pointCount?.toLocaleString() ?? "n/a"}</dd>
              </div>
              <div>
                <dt>Bounds Min</dt>
                <dd>{formatVector(splatDiagnostics.boundsMin)}</dd>
              </div>
              <div>
                <dt>Bounds Max</dt>
                <dd>{formatVector(splatDiagnostics.boundsMax)}</dd>
              </div>
              <div>
                <dt>Last Update</dt>
                <dd>{new Date(splatDiagnostics.updatedAtIso).toLocaleString()}</dd>
              </div>
              {splatDiagnostics.error ? (
                <div>
                  <dt>Error</dt>
                  <dd className="inspector-debug-error">{splatDiagnostics.error}</dd>
                </div>
              ) : null}
            </dl>
          )}
        </section>
      ) : null}
    </div>
  );
}
