# Plugin Packages

This folder contains reference plugin package layouts that can be moved into independent Git repositories.

## Included
- `beam-crossover-plugin`
- `example-wave-plugin`
- `template-artwork-actor-plugin`

## External Plugin Workspace (Gitignored)
- Use `plugins-external/` for plugin repos developed alongside the app but not tracked in this repository.
- Each plugin in `plugins-external/` should be its own Git repository with its own `.gitignore`.
- Desktop app auto-discovers built plugin entries at startup:
  - `plugins-external/*/dist/index.js`
  - `plugins/*/dist/index.js`

## Suggested Separate-Repo Structure
1. `package.json`
2. `tsconfig.json`
3. `src/index.ts` exporting handshake
4. `README.md` with build/load instructions

## Host Compatibility
- Must implement handshake contract described in `docs/plugin-handshake.md`.
- Built output should provide a module path loadable by the host plugin loader.
