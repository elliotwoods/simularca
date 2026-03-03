import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { createActorFromDescriptor, listActorCreationOptions } from "@/features/actors/actorCatalog";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";

interface AddActorMenuProps {
  disabled?: boolean;
}

export function AddActorMenu(props: AddActorMenuProps) {
  const kernel = useKernel();
  const mode = useAppStore((store) => store.state.mode);
  const statusMessage = useAppStore((store) => store.state.statusMessage);
  const options = useMemo(() => listActorCreationOptions(kernel), [kernel, statusMessage]);
  const [open, setOpen] = useState(false);
  const [activeDescriptorId, setActiveDescriptorId] = useState<string | null>(options[0]?.descriptorId ?? null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0 });

  const recalculatePopupPosition = () => {
    const trigger = rootRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const popupWidth = Math.min(560, Math.max(360, window.innerWidth - 24));
    const x = Math.max(12, Math.min(rect.left, window.innerWidth - popupWidth - 12));
    const y = Math.min(rect.bottom + 8, window.innerHeight - 12);
    setPopupPosition({ x: Math.round(x), y: Math.round(y) });
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    recalculatePopupPosition();

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popupRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    const onReposition = () => {
      recalculatePopupPosition();
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!options.some((option) => option.descriptorId === activeDescriptorId)) {
      setActiveDescriptorId(options[0]?.descriptorId ?? null);
    }
  }, [activeDescriptorId, options]);

  const activeOption = options.find((option) => option.descriptorId === activeDescriptorId) ?? options[0];
  const groupedOptions = useMemo(() => {
    const order: string[] = [];
    const groups = new Map<string, { label: string; entries: typeof options }>();
    for (const option of options) {
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
  }, [options]);
  const readOnly = mode === "web-ro";

  const handleCreateFromOption = async (descriptorId: string): Promise<void> => {
    const created = createActorFromDescriptor(kernel, descriptorId);
    if (!created) {
      kernel.store.getState().actions.setStatus(`Unable to create actor from descriptor: ${descriptorId}`);
      return;
    }
    const optionLabel = options.find((option) => option.descriptorId === descriptorId)?.label ?? "Actor";
    kernel.store.getState().actions.setStatus(`${optionLabel} added. Configure it in Inspector.`);
  };

  return (
    <div className="add-actor-menu" ref={rootRef}>
      <button
        type="button"
        className="add-actor-button"
        disabled={props.disabled}
        title="Add actor"
        onClick={() => {
          recalculatePopupPosition();
          setOpen((value) => !value);
        }}
      >
        <FontAwesomeIcon icon={faPlus} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            className="add-actor-popup"
            role="menu"
            aria-label="Add actor type"
            style={{ left: `${popupPosition.x}px`, top: `${popupPosition.y}px` }}
          >
          <div className="add-actor-popup-list">
            {groupedOptions.map((group) => (
              <div key={group.key} className="add-actor-group">
                <div className="add-actor-group-title">{group.label}</div>
                {group.entries.map((option) => (
                  <button
                    key={option.descriptorId}
                    type="button"
                    className={`add-actor-option${activeOption?.descriptorId === option.descriptorId ? " active" : ""}`}
                    onMouseEnter={() => {
                      setActiveDescriptorId(option.descriptorId);
                    }}
                    onFocus={() => {
                      setActiveDescriptorId(option.descriptorId);
                    }}
                    onClick={() => {
                      setOpen(false);
                      if (readOnly) {
                        return;
                      }
                      void handleCreateFromOption(option.descriptorId).catch((error) => {
                        const message = error instanceof Error ? error.message : "Unknown add actor error";
                        kernel.store.getState().actions.setStatus(`Unable to add actor: ${message}`);
                      });
                    }}
                  >
                    <span className="add-actor-option-icon">{option.iconGlyph}</span>
                    <span className="add-actor-option-label">{option.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          {activeOption ? (
            <div className="add-actor-popup-info">
              <div className="add-actor-popup-info-title">
                <span className="add-actor-option-icon large">{activeOption.iconGlyph}</span>
                <span>{activeOption.label}</span>
              </div>
              <p>{activeOption.description}</p>
              <small>{activeOption.pluginBacked ? `Plugin: ${activeOption.pluginName ?? activeOption.groupLabel}` : "Core actor type"}</small>
            </div>
          ) : null}
          </div>,
          document.body
        )}
    </div>
  );
}
