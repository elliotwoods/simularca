# Theatre Lights Plugin

Internal Simularca plugin that adds theatre-lighting fixtures. v1 ships a single
fixture: the **ETC Source Four** ellipsoidal, rendered as a wireframe visualisation
(body + beam outline) — a layout/planning aid, not a real light source.

## Features (v1)

- Lens selection: fixed tubes (5°/10°/14°/19°/26°/36°/50°/70°/90°) and zoom barrels
  (15–30°, 25–50°).
- Lamp/power selection (HPL 750/575/375/550 W incandescent, LED Series 2/3).
- Dimming (0–100 %) and gel (Lee + Rosco common presets, or a custom colour). Gel
  colours are **approximate** sRGB and flagged as such.
- Four framing shutters (ETC's term for "blades") that shape the beam outline.
- Focus/throw distance and hard/soft edge.
- "Look at" — keeps the fixture aimed at a referenced actor every frame.

Computed optics (field angle, throw, field diameter, output) appear in the inspector
status panel.

## Build

The host dev flow (`npm run dev` from the repo root) auto-builds this plugin via
`node scripts/plugins.mjs watch`. To build once:

```
npm run build
```

This generates `src/pluginBuildInfo.generated.ts`, type-checks with `tsc`, and emits
`dist/index.js`, which the desktop app auto-discovers and loads (enabled by default).

## Export Contract

- Default export: `PluginHandshakeModule`
- Named export: `handshake` (same object)

See `docs/plugin-handshake.md` in the host repo.
