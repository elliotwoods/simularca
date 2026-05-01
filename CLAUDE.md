# Claude Code - Simularca Development Guidelines

## Live Session Debugging
- When Simularca is running in local Electron dev mode, prefer the live debug bridge over asking the user for manual DevTools snippets.
- Start with `logs/codex-debug-session.json`, then use `node scripts/debug-session.mjs ...`.
- Agent-facing instructions live in `AGENTS.md`.
- Full bridge details and examples live in `docs/live-debug-bridge.md`.

## General Conventions

### Per-frame Status Reporting Pattern
Actors that have per-frame operational state (e.g., GPU sort decisions, render mode
selection, adaptive thresholds) should surface this in the inspector status display.

**Pattern:**
1. The sort/compute module returns a stats object from its per-frame method
2. The controller stores the stats and periodically calls `setActorStatus()` with
   both static (load-time) and dynamic (per-frame) values
3. The descriptor's `status.build()` displays the dynamic values in the inspector
4. Throttle status updates (e.g., every 10 frames or on mode change) to avoid UI churn

This makes it possible to validate optimization thresholds (e.g., temporal sort
coherence angle threshold, skip frame count) by observing the inspector in real time.

### Incremental Optimization Testing
When implementing GPU/rendering pipeline optimizations:
- Apply **one change at a time** and test before moving to the next
- Never combine geometry type changes (e.g., instanced -> flat draw), shader
  restructuring, and sort algorithm changes in a single commit
- Keep the working version accessible (either as a fallback code path or in git)
- If a change produces a blank screen, revert it immediately - don't try to debug
  on top of multiple simultaneous changes

### Three.js TSL (WebGPU) Limitations Encountered
These are known limitations of Three.js v0.173.0 TSL that affect what optimizations
are feasible:

1. **`workgroupArray` does not support atomic types**: `workgroupArray("uint", N)`
   generates `var<workgroup> arr: array<u32, N>` in WGSL, but `atomicAdd` requires
   `array<atomic<u32>, N>`. This blocks GPU radix sort implementations that need
   workgroup-level histogram atomics.

2. **`vertexIndex` with non-instanced `BufferGeometry`**: Using `vertexIndex` in a
   vertex shader with a plain `BufferGeometry` (non-instanced, flat draw call via
   `drawRange.count`) produces blank output. Vertex pulling must use
   `InstancedBufferGeometry` + `instanceIndex` instead.

3. **Storage buffer update workaround**: `Three.js Bindings._update()` does not
   re-sync storage buffers after initialization. Use
   `renderer.backend.updateAttribute(attr)` to manually trigger GPU upload for
   buffers that change per frame (e.g., chunk visibility).

4. **WGSL vec3 alignment**: `array<vec3<f32>>` has 16-byte stride in WGSL. All
   vec3 data must be padded to vec4 (4 floats per element) to avoid misaligned
   reads. Use `StorageBufferAttribute(data, 4)` and `storage(buf, "vec4", count)`.
