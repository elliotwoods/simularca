import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faXmark } from "@fortawesome/free-solid-svg-icons";
import { createActorFromDescriptor, listActorCreationOptions } from "@/features/actors/actorCatalog";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { keyboardCommandRouter } from "@/app/keyboardCommandRouter";

interface AddActorMenuProps {
  disabled?: boolean;
  buttonTitle?: string;
  registerGlobalShortcut?: boolean;
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getSearchRank(
  option: ReturnType<typeof listActorCreationOptions>[number],
  query: string
): number | null {
  if (!query) {
    return 0;
  }
  const label = option.label.toLocaleLowerCase();
  const actorType = option.actorType.toLocaleLowerCase();
  const description = option.description.toLocaleLowerCase();
  const groupLabel = option.groupLabel.toLocaleLowerCase();
  const pluginName = (option.pluginName ?? "").toLocaleLowerCase();

  if (label === query) {
    return 0;
  }
  if (label.startsWith(query)) {
    return 1;
  }
  if (label.includes(query)) {
    return 2;
  }
  if (actorType.startsWith(query)) {
    return 3;
  }
  if (actorType.includes(query)) {
    return 4;
  }
  if (pluginName.startsWith(query)) {
    return 5;
  }
  if (pluginName.includes(query)) {
    return 6;
  }
  if (groupLabel.startsWith(query)) {
    return 7;
  }
  if (groupLabel.includes(query)) {
    return 8;
  }
  if (description.includes(query)) {
    return 9;
  }
  return null;
}

export function AddActorMenu(props: AddActorMenuProps) {
  const kernel = useKernel();
  const mode = useAppStore((store) => store.state.mode);
  const pluginCount = kernel.pluginApi.listPlugins().length;
  const actorDescriptorCount = kernel.descriptorRegistry.listByKind("actor").length;
  const options = useMemo(
    () => listActorCreationOptions(kernel),
    [kernel, pluginCount, actorDescriptorCount]
  );
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeDescriptorId, setActiveDescriptorId] = useState<string | null>(options[0]?.descriptorId ?? null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const readOnly = mode === "web-ro";

  const filteredOptions = useMemo(() => {
    const query = normalizeSearchValue(searchQuery);
    if (!query) {
      return options;
    }
    return options
      .map((option, index) => ({
        option,
        index,
        rank: getSearchRank(option, query)
      }))
      .filter((entry) => entry.rank !== null)
      .sort((a, b) => {
        if (a.rank !== b.rank) {
          return (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY);
        }
        if (a.option.groupLabel !== b.option.groupLabel) {
          return a.option.groupLabel.localeCompare(b.option.groupLabel);
        }
        if (a.option.label !== b.option.label) {
          return a.option.label.localeCompare(b.option.label);
        }
        return a.index - b.index;
      })
      .map((entry) => entry.option);
  }, [options, searchQuery]);

  const activeOption = filteredOptions.find((option) => option.descriptorId === activeDescriptorId) ?? filteredOptions[0] ?? null;

  const groupedOptions = useMemo(() => {
    const order: string[] = [];
    const groups = new Map<string, { label: string; entries: typeof filteredOptions }>();
    for (const option of filteredOptions) {
      const existing = groups.get(option.groupKey);
      if (existing) {
        existing.entries.push(option);
        continue;
      }
      order.push(option.groupKey);
      groups.set(option.groupKey, {
        label: option.groupLabel,
        entries: [option]
      });
    }
    return order
      .map((key) => {
        const group = groups.get(key);
        return group ? { key, ...group } : null;
      })
      .filter((group): group is NonNullable<typeof group> => Boolean(group));
  }, [filteredOptions]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSearchQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (!filteredOptions.some((option) => option.descriptorId === activeDescriptorId)) {
      setActiveDescriptorId(filteredOptions[0]?.descriptorId ?? null);
    }
  }, [activeDescriptorId, filteredOptions, open]);

  useEffect(() => {
    if (!open || !activeOption) {
      return;
    }
    const optionElement = optionRefs.current.get(activeOption.descriptorId);
    if (optionElement && typeof optionElement.scrollIntoView === "function") {
      optionElement.scrollIntoView({ block: "nearest" });
    }
  }, [activeOption, open]);

  useEffect(() => {
    if (!props.registerGlobalShortcut || props.disabled) {
      return;
    }
    return keyboardCommandRouter.register("open-add-actor-browser", () => {
      setOpen(true);
      return true;
    }, 10);
  }, [props.disabled, props.registerGlobalShortcut]);

  const handleCreateFromOption = async (descriptorId: string): Promise<void> => {
    const created = createActorFromDescriptor(kernel, descriptorId);
    if (!created) {
      kernel.store.getState().actions.setStatus(`Unable to create actor from descriptor: ${descriptorId}`);
      return;
    }
    const optionLabel = options.find((option) => option.descriptorId === descriptorId)?.label ?? "Actor";
    kernel.store.getState().actions.setStatus(`${optionLabel} added. Configure it in Inspector.`);
  };

  const close = (): void => {
    setOpen(false);
    setSearchQuery("");
  };

  const moveActiveSelection = (direction: -1 | 1): void => {
    if (filteredOptions.length <= 0) {
      return;
    }
    const currentIndex = filteredOptions.findIndex((option) => option.descriptorId === activeOption?.descriptorId);
    const safeIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (safeIndex + direction + filteredOptions.length) % filteredOptions.length;
    setActiveDescriptorId(filteredOptions[nextIndex]?.descriptorId ?? null);
  };

  const createActiveOption = (): void => {
    if (!activeOption || readOnly) {
      return;
    }
    close();
    void handleCreateFromOption(activeOption.descriptorId).catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown add actor error";
      kernel.store.getState().actions.setStatus(`Unable to add actor: ${message}`);
    });
  };

  return (
    <div className="add-actor-menu">
      <button
        type="button"
        className="add-actor-button"
        disabled={props.disabled}
        title={props.buttonTitle ?? "Create Actor Browser"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <FontAwesomeIcon icon={faPlus} />
      </button>
      {open &&
        createPortal(
          <div className="add-actor-browser-backdrop" onClick={close}>
            <div
              className="add-actor-browser"
              role="dialog"
              aria-modal="true"
              aria-label="Create Actor Browser"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="add-actor-browser-header">
                <div>
                  <h3>Create Actor Browser</h3>
                  <p>Browse core and plugin actor types. Use arrow keys to navigate and Enter to create.</p>
                </div>
                <button type="button" className="add-actor-browser-close" title="Close" onClick={close}>
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              </div>
              <div className="add-actor-browser-search-row">
                <input
                  ref={searchInputRef}
                  type="text"
                  className="add-actor-browser-search"
                  value={searchQuery}
                  placeholder="Search actor types... Press Enter to create"
                  aria-label="Search actor types"
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      moveActiveSelection(1);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      moveActiveSelection(-1);
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      createActiveOption();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      close();
                    }
                  }}
                />
                <div className="add-actor-browser-search-meta">
                  {filteredOptions.length} result{filteredOptions.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="add-actor-browser-body">
                <div className="add-actor-browser-list" role="listbox" aria-label="Actor types">
                  {groupedOptions.length === 0 ? (
                    <div className="add-actor-browser-empty">No actor types match the current search.</div>
                  ) : (
                    groupedOptions.map((group) => (
                      <div key={group.key} className="add-actor-group">
                        <div className="add-actor-group-title">{group.label}</div>
                        {group.entries.map((option) => (
                          <button
                            key={option.descriptorId}
                            ref={(element) => {
                              if (element) {
                                optionRefs.current.set(option.descriptorId, element);
                              } else {
                                optionRefs.current.delete(option.descriptorId);
                              }
                            }}
                            type="button"
                            role="option"
                            aria-selected={activeOption?.descriptorId === option.descriptorId}
                            className={`add-actor-option${activeOption?.descriptorId === option.descriptorId ? " active" : ""}`}
                            onMouseEnter={() => {
                              setActiveDescriptorId(option.descriptorId);
                            }}
                            onFocus={() => {
                              setActiveDescriptorId(option.descriptorId);
                            }}
                            onClick={() => {
                              setActiveDescriptorId(option.descriptorId);
                              if (readOnly) {
                                return;
                              }
                              close();
                              void handleCreateFromOption(option.descriptorId).catch((error) => {
                                const message = error instanceof Error ? error.message : "Unknown add actor error";
                                kernel.store.getState().actions.setStatus(`Unable to add actor: ${message}`);
                              });
                            }}
                          >
                            <span className="add-actor-option-icon">{option.iconGlyph}</span>
                            <span className="add-actor-option-copy">
                              <span className="add-actor-option-label">{option.label}</span>
                              <span className="add-actor-option-description">{option.description}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
                <div className="add-actor-browser-info">
                  {activeOption ? (
                    <>
                      <div className="add-actor-popup-info-title">
                        <span className="add-actor-option-icon large">{activeOption.iconGlyph}</span>
                        <span>{activeOption.label}</span>
                      </div>
                      <p>{activeOption.description}</p>
                      <dl className="add-actor-browser-meta">
                        <dt>Type</dt>
                        <dd>{activeOption.actorType}</dd>
                        <dt>Source</dt>
                        <dd>{activeOption.pluginBacked ? `Plugin: ${activeOption.pluginName ?? activeOption.groupLabel}` : "Core actor type"}</dd>
                      </dl>
                    </>
                  ) : (
                    <p className="add-actor-browser-empty">Search to find an actor type to create.</p>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
