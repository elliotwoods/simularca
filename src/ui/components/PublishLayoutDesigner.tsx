import { useCallback, useMemo, useRef } from "react";
import { Layout, Model, type IJsonModel, type TabNode } from "flexlayout-react";
import {
  defaultViewerLayoutConfig,
  reconcileLayoutWithPanels,
  sanitizeLayoutConfig
} from "@/ui/FlexLayoutHost";
import type { PublishConfig } from "@/features/publish/publishConfigSchema";

interface PublishLayoutDesignerProps {
  /** Current draft of the publish config; supplies the starting layout. */
  publishConfig: PublishConfig;
  /** Called with a freshly sanitized layout JSON after every drag/drop edit. */
  onChange: (layout: IJsonModel) => void;
}

const PLACEHOLDER_LABELS: Record<string, string> = {
  left: "Scene Tree",
  center: "Viewport",
  right: "Inspector",
  console: "Console"
};

interface WeightedNode {
  getWeight?: () => number;
}

interface OrientableNode {
  getOrientation?: () => { getName?: () => string } | string;
}

function readWeight(node: unknown): number | null {
  const weighted = node as WeightedNode;
  if (typeof weighted?.getWeight !== "function") return null;
  const value = weighted.getWeight();
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readAxisLabel(parent: unknown): "width" | "height" {
  const orientable = parent as OrientableNode;
  if (typeof orientable?.getOrientation !== "function") return "width";
  const orientation = orientable.getOrientation();
  // flexlayout's Orientation has a `getName()` returning "horz"/"vert"; some
  // builds expose the raw string instead. Handle both shapes.
  const raw =
    typeof orientation === "string"
      ? orientation
      : typeof orientation?.getName === "function"
        ? orientation.getName()
        : "";
  return raw.toLowerCase().startsWith("horz") ? "width" : "height";
}

function formatPanelSize(node: TabNode): string {
  const tabset = node.getParent();
  if (!tabset) return "";
  const parent = tabset.getParent();
  if (!parent || typeof parent.getChildren !== "function") return "";
  const siblings = parent.getChildren();
  if (!Array.isArray(siblings) || siblings.length === 0) return "";
  let total = 0;
  for (const sibling of siblings) {
    const w = readWeight(sibling);
    if (w === null) return "";
    total += w;
  }
  if (total <= 0) return "";
  const own = readWeight(tabset);
  if (own === null) return "";
  const pct = Math.round((own / total) * 100);
  return `${readAxisLabel(parent)} ${pct}%`;
}

function placeholderFactory(node: TabNode): React.ReactNode {
  const component = node.getComponent() ?? "";
  const label = PLACEHOLDER_LABELS[component] ?? node.getName() ?? component;
  const sizeText = formatPanelSize(node);
  return (
    <div className="publish-layout-placeholder">
      <span className="publish-layout-placeholder-label">{label}</span>
      {sizeText ? <span className="publish-layout-placeholder-size">{sizeText}</span> : null}
    </div>
  );
}

export function PublishLayoutDesigner(props: PublishLayoutDesignerProps) {
  const initialJson = useMemo<IJsonModel>(() => {
    const supplied = props.publishConfig.layout;
    if (supplied && typeof supplied === "object") {
      // Reconcile against current panel flags so a saved layout that was
      // written before a panel toggle still opens consistent with the
      // checkboxes in the modal.
      return reconcileLayoutWithPanels(
        sanitizeLayoutConfig(supplied as IJsonModel),
        props.publishConfig.panels
      );
    }
    return defaultViewerLayoutConfig(props.publishConfig);
    // Re-seed when the layout structure changes (e.g. panel toggle calls
    // `applyPanelToggleToLayout`) or when panel flags change without a
    // custom layout. The downstream Model rebuild compares serialized
    // JSON, so flexlayout's in-flight drag state survives normal renders
    // and only flips when the underlying source actually differs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.publishConfig.layout
      ? `custom:${JSON.stringify(props.publishConfig.layout)}`
      : `derived:${JSON.stringify(props.publishConfig.panels)}`
  ]);

  const modelRef = useRef<Model>(Model.fromJson(initialJson));
  // If the seed json changed identity, rebuild the model.
  const seedJsonStringRef = useRef<string>(JSON.stringify(initialJson));
  const nextSeedString = JSON.stringify(initialJson);
  if (nextSeedString !== seedJsonStringRef.current) {
    seedJsonStringRef.current = nextSeedString;
    modelRef.current = Model.fromJson(initialJson);
  }

  const handleModelChange = useCallback(
    (model: Model) => {
      const sanitized = sanitizeLayoutConfig(model.toJson() as IJsonModel);
      props.onChange(sanitized);
    },
    [props]
  );

  return (
    <div className="publish-layout-designer">
      <div className="publish-layout-designer-surface">
        <Layout model={modelRef.current} factory={placeholderFactory} onModelChange={handleModelChange} />
      </div>
      <p className="publish-layout-designer-hint">
        Drag panel tabs to dock them in new positions. The viewer will use this layout when this
        publish loads. Tabs you remove will be hidden in the viewer.
      </p>
    </div>
  );
}
