# Plugin Handshake Contract

This document defines the module contract between the host app and external plugin packages.

## Version
- Current handshake/API version: `1`

## Module Exports
A plugin module must export a handshake object in one of these forms:
1. `export default handshake`
2. `export const handshake = ...`

The handshake object shape:

```ts
interface PluginHandshakeModule {
  manifest: PluginManifest;
  createPlugin(): PluginDefinition;
}
```

## Manifest
```ts
interface PluginManifest {
  handshakeVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  engine: {
    minApiVersion: number;
    maxApiVersion: number;
  };
}
```

Validation rules:
1. `handshakeVersion` must match host version.
2. Host version must be in `engine.minApiVersion..engine.maxApiVersion`.
3. `id` and `name` must be non-empty.

## Plugin Definition
`createPlugin()` returns:

```ts
interface PluginDefinition {
  id: string;
  name: string;
  actorDescriptors: ReloadableDescriptor[];
  componentDescriptors: ReloadableDescriptor[];
}
```

Descriptors are registered into the host registry and participate in hot-reload behavior.

### Parameter Schema Notes
- Descriptor schemas support parameter types: `number`, `boolean`, `string`, `color`, `select`, `actor-ref`, `actor-ref-list`, and `file`.
- `file` parameters can provide `accept`, `dialogTitle`, and `import` metadata to use host file-import widgets.
- Optional UI hints are supported on parameters: `description`; and for numbers: `precision`, `unit`, `dragSpeed`.
- Actor reference parameters can constrain targets with `allowedActorTypes`.

### Plugin Scene Hooks (Optional)
Actor descriptors may provide `sceneHooks` for in-scene visualization and simulation:
1. `createObject({ actor, state })` -> returns a Three.js object to attach to scene graph.
2. `syncObject(context)` -> called each frame after core actor transforms are applied.
3. `disposeObject({ actor, state, object })` -> called when actor object is removed.

`syncObject` context includes:
- `actor`, `state`, `object`
- `simTimeSeconds`, `dtSeconds`
- `getActorById(actorId)`
- `getActorObject(actorId)`
- `sampleCurveWorldPoint(actorId, t)`
- `setActorStatus(status | null)`

## Loader Behavior
1. Host imports module path dynamically.
   - In Electron+Vite dev (`http://localhost`), local `file:///...` plugin URLs are normalized to Vite `@fs` specifiers before import.
2. Host resolves handshake from `default` or `handshake` export.
3. Host validates handshake + engine compatibility.
4. Host calls `createPlugin()`.
5. Host registers plugin descriptors.

## Reference Template
- `plugins/example-wave-plugin`
