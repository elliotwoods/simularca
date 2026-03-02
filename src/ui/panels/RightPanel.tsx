import { useAppStore } from "@/app/useAppStore";
import { InspectorPane } from "@/ui/components/InspectorPane";

export function RightPanel() {
  const selection = useAppStore((store) => store.state.selection);

  return (
    <div className="right-panel">
      <section className="panel-section">
        <header>
          <h3>Inspector</h3>
        </header>
        <InspectorPane />
      </section>
      <section className="panel-section">
        <header>
          <h3>Selection</h3>
        </header>
        <p className="panel-empty">{selection.length === 0 ? "Nothing selected." : `${selection.length} item(s) selected`}</p>
      </section>
    </div>
  );
}
