# Template Artwork Actor Plugin

Starter template for artwork-specific Simularca plugins.

## Usage
1. Copy this folder into a new plugin repo.
2. Rename package, manifest id/name, and descriptor ids.
3. Implement schema, scene hooks, and status reporting.
4. Build with `npm run build`.
5. Load in Simularca console:
   - `plugin.load("file:///ABSOLUTE_PATH_TO_PLUGIN/dist/index.js")`
