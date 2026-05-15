import React, { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import type { AppKernel } from "@/app/kernel";
import { KernelProvider } from "@/app/KernelContext";
import { createAppStore } from "@/core/store/appStore";
import type { ReloadableDescriptor } from "@/core/hotReload/types";
import type { RegisteredPlugin } from "@/features/plugins/pluginApi";
import { emptyActorDescriptor } from "@/features/actors/descriptors/emptyActor";
import { AddActorMenu } from "@/ui/components/AddActorMenu";
import { ActorProfilingService } from "@/render/profiling";

function createPluginActorDescriptor(): ReloadableDescriptor {
  return {
    id: "plugin.sparkEmitter",
    kind: "actor",
    version: 1,
    schema: {
      id: "plugin.sparkEmitter",
      title: "Spark Emitter",
      params: []
    },
    spawn: {
      actorType: "plugin",
      pluginType: "spark-emitter",
      label: "Spark Emitter",
      description: "Emit sparks from a plugin actor.",
      iconGlyph: "SP",
      fileExtensions: []
    },
    createRuntime: () => ({ created: true }),
    updateRuntime() {}
  };
}

function createKernelStub(
  descriptors: ReloadableDescriptor[],
  plugins: RegisteredPlugin[]
): AppKernel {
  const store = createAppStore("electron-rw");
  return {
    store,
    storage: {} as AppKernel["storage"],
    projectService: {} as AppKernel["projectService"],
    hotReloadManager: {} as AppKernel["hotReloadManager"],
    descriptorRegistry: {
      listByKind: (kind: string) => (kind === "actor" ? descriptors : [])
    } as unknown as AppKernel["descriptorRegistry"],
    pluginApi: {
      listPlugins: () => plugins,
      subscribe: () => () => {},
      getRevision: () => 0
    } as unknown as AppKernel["pluginApi"],
    clock: {} as AppKernel["clock"],
    profiler: new ActorProfilingService()
  };
}

describe("AddActorMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows plugin actor types and creates the highlighted search match on Enter", async () => {
    const descriptors: ReloadableDescriptor[] = [emptyActorDescriptor];
    const plugins: RegisteredPlugin[] = [];
    const kernel = createKernelStub(descriptors, plugins);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const render = async () => {
      await act(async () => {
        root.render(
          React.createElement(
            KernelProvider as React.ComponentType<{ kernel: AppKernel; children?: React.ReactNode }>,
            { kernel },
            React.createElement(AddActorMenu)
          )
        );
      });
    };

    await render();

    const openButton = container.querySelector("button.add-actor-button") as HTMLButtonElement | null;
    expect(openButton?.title).toBe("Create Actor Browser");

    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const initialDialog = document.querySelector("[aria-label='Create Actor Browser']");
    expect(initialDialog?.textContent).toContain("Create Actor Browser");
    expect(initialDialog?.textContent).not.toContain("Spark Emitter");

    const pluginDescriptor = createPluginActorDescriptor();
    descriptors.push(pluginDescriptor);
    plugins.push({
      definition: {
        id: "spark-plugin",
        name: "Spark Plugin",
        actorDescriptors: [pluginDescriptor],
        componentDescriptors: [],
        viewDescriptors: []
        },
      lastLoadedAtIso: "2026-03-09T00:00:00.000Z",
      reloadCount: 0,
      manifest: {
        handshakeVersion: 1,
        id: "spark-plugin",
        name: "Spark Plugin",
        version: "1.0.0",
        engine: {
          minApiVersion: 1,
          maxApiVersion: 1
        }
      }
    });

    await render();

    const searchInput = document.querySelector("input[aria-label='Search actor types']") as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    expect(searchInput?.placeholder).toBe("Search actor types... Press Enter to create");
    expect(document.activeElement).toBe(searchInput);
    expect(document.body.textContent).toContain("Spark Emitter");

    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(searchInput, "spark");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      searchInput?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    const createdActor = Object.values(kernel.store.getState().state.actors).find((actor) => actor.name === "Spark Emitter");
    expect(createdActor?.actorType).toBe("plugin");
    expect(createdActor?.pluginType).toBe("spark-emitter");

    await act(async () => {
      root.unmount();
    });
  });
});
