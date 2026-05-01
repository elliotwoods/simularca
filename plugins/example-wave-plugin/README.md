# Example Wave Plugin

Reference plugin package for the Simularca app.

## Purpose
- Demonstrates the handshake contract expected by the host loader.
- Shows how to export actor descriptors from an external package/repo.

## Export Contract
- Default export: `PluginHandshakeModule`
- Optional named export: `handshake` (same object)

Required shape:
1. `manifest`
2. `createPlugin()`

## Build
1. `npm install`
2. `npm run build`

## Load in Host App
Use the host loader with a module path, for example:
- Local dev file path to built module
- Package path resolved from `node_modules`
