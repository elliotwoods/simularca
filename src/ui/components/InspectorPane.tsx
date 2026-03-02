import { useEffect, useMemo, useRef } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCopy } from "@fortawesome/free-solid-svg-icons";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import type { ActorNode, FileParameterDefinition, ParameterDefinition } from "@/core/types";
import type { ActorStatusEntry, ReloadableDescriptor } from "@/core/hotReload/types";
import { importFileForActorParam } from "@/features/imports/fileParameterImport";
import { DigitScrubInput, FileField, NumberField, SelectField, TextField, ToggleField } from "@/ui/widgets";

type BindingValue = number | string | boolean;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

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

function getDefaultStatusEntries(actor: ActorNode): ActorStatusEntry[] {
  return [
    { label: "Type", value: actor.actorType },
    { label: "Enabled", value: actor.enabled },
    { label: "Children", value: actor.childActorIds.length },
    { label: "Components", value: actor.componentIds.length }
  ];
}

function formatStatusValue(value: ActorStatusEntry["value"]): string {
  if (Array.isArray(value)) {
    return `${value[0].toFixed(3)}, ${value[1].toFixed(3)}, ${value[2].toFixed(3)}`;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3).replace(/\.?0+$/, "");
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }
  return value;
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

function isMixedNumber(values: number[]): boolean {
  const first = values[0];
  if (first === undefined) {
    return false;
  }
  return values.some((value) => Math.abs(value - first) > 1e-9);
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
  const appState = useAppStore((store) => store.state);
  const selection = appState.selection;
  const actors = appState.actors;
  const assets = appState.assets;
  const actorStatusByActorId = appState.actorStatusByActorId;
  const mode = appState.mode;
  const sessionName = appState.activeSessionName;
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

  const reloadSelectedActorFileParam = (key: string): void => {
    const reloadKey = `${key}ReloadToken`;
    let updatedCount = 0;
    for (const actor of actorSelection) {
      const value = actor.params[key];
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      updatedCount += 1;
      kernel.store.getState().actions.updateActorParams(actor.id, {
        [reloadKey]: Date.now() + updatedCount
      });
    }
    if (updatedCount > 0) {
      scheduleAutosave();
      kernel.store.getState().actions.setStatus(`Reload requested for ${updatedCount} file asset${updatedCount === 1 ? "" : "s"}.`);
    }
  };

  const updateSelectedActorEnabled = (nextEnabled: boolean): void => {
    for (const actor of actorSelection) {
      kernel.store.getState().actions.setNodeEnabled({ kind: "actor", id: actor.id }, nextEnabled);
    }
    scheduleAutosave();
  };

  const updateSelectedActorTransformAxis = (
    key: "position" | "rotation",
    axisIndex: 0 | 1 | 2,
    nextValue: number
  ): void => {
    for (const actor of actorSelection) {
      const current = actor.transform[key];
      const next: [number, number, number] = [current[0], current[1], current[2]];
      next[axisIndex] = nextValue;
      kernel.store.getState().actions.setActorTransform(actor.id, key, next);
    }
    scheduleAutosave();
  };

  if (actorSelection.length === 0) {
    return <div className="inspector-empty">Select one or more actors/components</div>;
  }

  const singleSelection = actorSelection.length === 1 ? actorSelection[0] : null;
  const descriptorForSingleSelection = singleSelection ? resolveActorDescriptor(singleSelection, actorDescriptors) : undefined;
  const runtimeStatus = singleSelection ? actorStatusByActorId[singleSelection.id] : undefined;
  const statusEntries = singleSelection
    ? (descriptorForSingleSelection?.status?.build({
        actor: singleSelection,
        state: appState,
        runtimeStatus
      }) ?? getDefaultStatusEntries(singleSelection))
    : [];
  const visibleStatusEntries = statusEntries.filter(
    (entry) => entry.value !== null && entry.value !== undefined && entry.value !== ""
  );
  const copyText = (value: string, label: string): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        kernel.store.getState().actions.setStatus(`${label} copied to clipboard.`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Clipboard write failed";
        kernel.store.getState().actions.setStatus(`Unable to copy ${label}: ${message}`);
      });
  };

  const enabledValues = actorSelection.map((actor) => actor.enabled);
  const enabledMixed = enabledValues.some((value) => value !== enabledValues[0]);
  const enabledValue = enabledValues[0] ?? true;

  const positionValuesByAxis: [number[], number[], number[]] = [
    actorSelection.map((actor) => actor.transform.position[0]),
    actorSelection.map((actor) => actor.transform.position[1]),
    actorSelection.map((actor) => actor.transform.position[2])
  ];
  const rotationValuesByAxis: [number[], number[], number[]] = [
    actorSelection.map((actor) => actor.transform.rotation[0] * RAD_TO_DEG),
    actorSelection.map((actor) => actor.transform.rotation[1] * RAD_TO_DEG),
    actorSelection.map((actor) => actor.transform.rotation[2] * RAD_TO_DEG)
  ];

  return (
    <div className="inspector-pane-root custom-inspector">
      <section className="inspector-common-card">
        <header>
          <h4>Actor</h4>
        </header>
        <div className="inspector-common-grid">
          <div className="inspector-common-row">
            <span className="inspector-common-label">Enabled</span>
            <ToggleField
              label=""
              checked={enabledValue}
              mixed={enabledMixed}
              disabled={readOnly}
              embedded
              onChange={(next) => updateSelectedActorEnabled(next)}
            />
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Translate</span>
            <div className="inspector-vector-inputs">
              {([0, 1, 2] as const).map((axisIndex) => {
                const values = positionValuesByAxis[axisIndex];
                return (
                  <div key={`pos-${axisIndex}`} className="inspector-vector-cell">
                    <span className="inspector-axis-label">{axisIndex === 0 ? "X" : axisIndex === 1 ? "Y" : "Z"}</span>
                    <DigitScrubInput
                      value={values[0] ?? 0}
                      mixed={isMixedNumber(values)}
                      precision={3}
                      disabled={readOnly}
                      onChange={(next) => updateSelectedActorTransformAxis("position", axisIndex, next)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          <div className="inspector-common-row">
            <span className="inspector-common-label">Rotate (deg)</span>
            <div className="inspector-vector-inputs">
              {([0, 1, 2] as const).map((axisIndex) => {
                const values = rotationValuesByAxis[axisIndex];
                return (
                  <div key={`rot-${axisIndex}`} className="inspector-vector-cell">
                    <span className="inspector-axis-label">{axisIndex === 0 ? "X" : axisIndex === 1 ? "Y" : "Z"}</span>
                    <DigitScrubInput
                      value={values[0] ?? 0}
                      mixed={isMixedNumber(values)}
                      precision={2}
                      disabled={readOnly}
                      onChange={(next) => updateSelectedActorTransformAxis("rotation", axisIndex, next * DEG_TO_RAD)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>
      {definitions.length === 0 ? <div className="inspector-empty">No common editable params in current selection</div> : null}
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
              onReload={() => {
                reloadSelectedActorFileParam(definition.key);
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
      {singleSelection ? (
        <section className="inspector-debug-card">
          <header className="inspector-card-header">
            <h4>Status</h4>
            <button
              type="button"
              className="inspector-copy-button"
              title="Copy panel contents"
              onClick={() => {
                const lines = ["Status", ...visibleStatusEntries.map((entry) => `${entry.label}: ${formatStatusValue(entry.value)}`)];
                copyText(lines.join("\n"), "Status");
              }}
            >
              <FontAwesomeIcon icon={faCopy} />
            </button>
          </header>
          {visibleStatusEntries.length === 0 ? (
            <p className="panel-empty">No status available.</p>
          ) : (
            <dl className="inspector-debug-list">
              {visibleStatusEntries.map((entry) => (
                <div key={entry.label}>
                  <dt>{entry.label}</dt>
                  <dd
                    className={
                      entry.tone === "error"
                        ? "inspector-debug-error"
                        : entry.tone === "warning"
                          ? "inspector-debug-warning"
                          : undefined
                    }
                  >
                    {formatStatusValue(entry.value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ) : null}
    </div>
  );
}
