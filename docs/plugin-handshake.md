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
- Descriptor schemas support parameter types: `number`, `boolean`, `string`, `select`, and `file`.
- `file` parameters can provide `accept`, `dialogTitle`, and `import` metadata to use host file-import widgets.
- Optional UI hints are supported on parameters: `description`; and for numbers: `precision`, `unit`, `dragSpeed`.

## Loader Behavior
1. Host imports module path dynamically.
2. Host resolves handshake from `default` or `handshake` export.
3. Host validates handshake + engine compatibility.
4. Host calls `createPlugin()`.
5. Host registers plugin descriptors.

## Reference Template
- `plugins/example-wave-plugin`
