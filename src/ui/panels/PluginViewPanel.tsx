import { useMemo } from "react";
import { useKernel } from "@/app/useKernel";
import { useAppStore } from "@/app/useAppStore";
import { isPluginEnabled } from "@/features/plugins/pluginEnabled";
import type { ParameterValues } from "@/core/types";

interface PluginViewPanelProps {
  pluginViewId: string;
}

export function PluginViewPanel(props: PluginViewPanelProps) {
  const kernel = useKernel();
  const pluginView = useAppStore((store) => store.state.pluginViews[props.pluginViewId] ?? null);
  const actor = useAppStore((store) => {
    const view = store.state.pluginViews[props.pluginViewId];
    return view ? store.state.actors[view.actorId] ?? null : null;
  });
  const runtimeStatus = useAppStore((store) => {
    const view = store.state.pluginViews[props.pluginViewId];
    return view ? store.state.actorStatusByActorId[view.actorId] ?? null : null;
  });
  const pluginEnabled = useAppStore((store) => {
    const view = store.state.pluginViews[props.pluginViewId];
    return view ? isPluginEnabled(store.state.pluginsEnabled, view.pluginId) : true;
  });

  const descriptor = useMemo(() => {
    if (!pluginView) {
      return null;
    }
    return kernel.pluginApi.getViewDescriptor(pluginView.pluginId, pluginView.viewType);
  }, [kernel, pluginView]);
  const actions = useMemo(() => {
    if (!pluginView) {
      return null;
    }
    return {
      updateActorParams: (partial: ParameterValues) => {
        kernel.store.getState().actions.updateActorParams(pluginView.actorId, partial);
      },
      openSiblingView: (viewType: string) => {
        const target = kernel.pluginApi.getViewDescriptor(pluginView.pluginId, viewType);
        if (!target) {
          return;
        }
        const view = kernel.store.getState().actions.openPluginView({
          pluginId: pluginView.pluginId,
          actorId: pluginView.actorId,
          viewType: target.viewType,
          title: target.title
        });
        kernel.store.getState().actions.focusPluginView(view.id);
      },
      focusView: (viewId: string) => {
        kernel.store.getState().actions.focusPluginView(viewId);
      },
      closeView: (viewId: string) => {
        kernel.store.getState().actions.closePluginView(viewId);
      }
    };
  }, [kernel, pluginView]);

  if (!pluginView) {
    return <div className="panel-empty">Plugin view not found.</div>;
  }

  if (!pluginEnabled) {
    return <div className="panel-empty">Plugin is disabled.</div>;
  }

  if (descriptor?.component && actions) {
    const Component = descriptor.component;
    return (
      <Component
        pluginView={pluginView}
        actor={actor}
        runtimeStatus={runtimeStatus}
        actions={actions}
      />
    );
  }

  if (descriptor?.render && actions) {
    return descriptor.render({
      pluginView,
      actor,
      runtimeStatus,
      actions
    });
  }

  return (
    <div className="panel-stack">
      <div className="panel-section">
        <strong>{descriptor?.title ?? pluginView.title}</strong>
        <div className="panel-empty">
          Plugin view host is registered.
          {actor ? ` Actor: ${actor.name}.` : " Linked actor is missing."}
        </div>
      </div>
    </div>
  );
}
