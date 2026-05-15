import * as THREE from "three";
import { PLUGIN_VERSION } from "./pluginBuildInfo.generated";
import { computeSunDirection } from "./sunPosition";
import { resolveTimezone } from "./timezoneResolver";

// ----- Plugin handshake contract (mirrors host's narrow ParameterSchema) -----

export interface ParameterSchema {
  id: string;
  title: string;
  params: Array<
    | {
        key: string;
        label: string;
        description?: string;
        type: "number";
        min?: number;
        max?: number;
        step?: number;
        precision?: number;
        unit?: string;
        dragSpeed?: number;
        defaultValue?: number;
      }
    | {
        key: string;
        label: string;
        description?: string;
        type: "boolean" | "string" | "color";
        defaultValue?: boolean | string;
      }
    | {
        key: string;
        label: string;
        description?: string;
        type: "select";
        options: string[];
        defaultValue?: string;
      }
    | {
        key: string;
        label: string;
        description?: string;
        type: "actor-ref" | "actor-ref-list";
        allowedActorTypes?: string[];
      }
    | {
        key: string;
        label: string;
        description?: string;
        type: "location";
        showElevation?: boolean;
        defaultLat?: number;
        defaultLng?: number;
        defaultValue?: { lat: number; lng: number; elevation?: number };
        dateTimeKey?: string;
        timezoneKey?: string;
      }
    | {
        key: string;
        label: string;
        description?: string;
        type: "datetime";
        defaultValue?: string;
        locationKey?: string;
        timezoneKey?: string;
      }
    | {
        key: string;
        label: string;
        description?: string;
        type: "timezone";
        defaultValue?: { mode: "auto" | "manual"; ianaName?: string };
      }
  >;
}

export interface ReloadableDescriptor {
  id: string;
  kind: "actor" | "component" | "system";
  version: number;
  schema: ParameterSchema;
  spawn?: {
    actorType: "plugin" | "empty" | "environment" | "gaussian-splat" | "gaussian-splat-spark" | "mesh" | "primitive" | "curve";
    pluginType?: string;
    label?: string;
    description?: string;
    iconGlyph?: string;
    fileExtensions?: string[];
  };
  createRuntime(args: { params: Record<string, unknown> }): unknown;
  updateRuntime(runtime: unknown, args: { params: Record<string, unknown>; dtSeconds: number }): void;
  createInitialParams?(): Record<string, unknown>;
  sceneHooks?: {
    createObject?(args: { actor: unknown; state: unknown }): unknown;
    syncObject?(context: PluginSyncContext): void;
    disposeObject?(args: { actor: unknown; state: unknown; object: unknown }): void;
  };
  status?: { build(args: { actor: unknown; state: unknown; runtimeStatus?: unknown }): Array<{ label: string; value: unknown; tone?: string }> };
}

export interface PluginSyncContext {
  actor: { id: string; params: Record<string, unknown>; transform: { position: [number, number, number] } };
  state: unknown;
  object: unknown;
  runtime: unknown | null;
  simTimeSeconds: number;
  dtSeconds: number;
  getActorById(actorId: string): unknown | null;
  getActorObject(actorId: string): unknown | null;
  setActorStatus(status: { values: Record<string, unknown>; updatedAtIso: string; error?: string } | null): void;
  readAssetBytes(assetId: string): Promise<Uint8Array>;
  setEnvironmentTexture(texture: unknown | null): void;
  getRenderer(): unknown | null;
  getPmremGenerator(): unknown | null;
  generateSkyIbl(params: {
    turbidity: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
    sunDirection: [number, number, number];
    sigma?: number;
  }): unknown | null;
}

export interface PluginDefinition {
  id: string;
  name: string;
  actorDescriptors: ReloadableDescriptor[];
  componentDescriptors: ReloadableDescriptor[];
}

export interface PluginManifest {
  handshakeVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  engine: { minApiVersion: number; maxApiVersion: number };
}

export interface PluginHandshakeModule {
  manifest: PluginManifest;
  createPlugin(): PluginDefinition;
}

// ----- Schema -----

const PLANETARY_ENVIRONMENT_SCHEMA: ParameterSchema = {
  id: "plugin.planetaryEnvironment.actor",
  title: "Planetary Environment",
  params: [
    {
      key: "location",
      label: "Location",
      type: "location",
      showElevation: false,
      defaultLat: 51.5074,
      defaultLng: -0.1278,
      dateTimeKey: "dateTime",
      timezoneKey: "timezone"
    },
    {
      key: "dateTime",
      label: "Date / Time",
      type: "datetime",
      description: "Local wall-clock time in the resolved timezone.",
      locationKey: "location",
      timezoneKey: "timezone"
    },
    {
      key: "timezone",
      label: "Timezone",
      type: "timezone",
      description: "Auto-resolves from location, or pick an IANA name manually."
    },
    {
      key: "northRotationDeg",
      label: "North Rotation",
      type: "number",
      min: -180,
      max: 180,
      step: 0.1,
      precision: 1,
      unit: "°",
      defaultValue: 0,
      description: "Rotates the sky/sun around the up axis. Default South = -Z."
    },
    {
      key: "turbidity",
      label: "Turbidity",
      type: "number",
      min: 1,
      max: 20,
      step: 0.1,
      precision: 1,
      defaultValue: 2
    },
    {
      key: "rayleigh",
      label: "Rayleigh",
      type: "number",
      min: 0,
      max: 4,
      step: 0.01,
      precision: 2,
      defaultValue: 1
    },
    {
      key: "mieCoefficient",
      label: "Mie Coefficient",
      type: "number",
      min: 0,
      max: 0.1,
      step: 0.001,
      precision: 3,
      defaultValue: 0.005
    },
    {
      key: "mieDirectionalG",
      label: "Mie Directional G",
      type: "number",
      min: 0,
      max: 1,
      step: 0.01,
      precision: 2,
      defaultValue: 0.8
    },
    {
      key: "sigma",
      label: "PMREM Sigma",
      description: "Optional blur radius (radians) applied to the IBL.",
      type: "number",
      min: 0,
      max: 0.2,
      step: 0.001,
      precision: 3,
      defaultValue: 0
    }
  ]
};

// ----- Descriptor -----

interface PlanetaryRuntime {
  lastSignature: string;
  lastDirection: [number, number, number];
  lastSunAltitudeDeg: number;
  lastSunAzimuthDeg: number;
  lastResolvedTimezone: string;
  lastUtcIso: string;
  lastRenderMs: number;
  lastTextureRef: unknown | null;
}

const planetaryEnvironmentDescriptor: ReloadableDescriptor = {
  id: "plugin.planetaryEnvironment.actor",
  kind: "actor",
  version: 1,
  schema: PLANETARY_ENVIRONMENT_SCHEMA,
  spawn: {
    actorType: "plugin",
    pluginType: "plugin.planetaryEnvironment.actor",
    label: "Planetary Environment",
    description: "Sky environment from physical sun position (location/date/time).",
    iconGlyph: "PLN",
    fileExtensions: []
  },
  createRuntime: () => ({
    lastSignature: "",
    lastDirection: [0, 1, 0],
    lastSunAltitudeDeg: 0,
    lastSunAzimuthDeg: 0,
    lastResolvedTimezone: "",
    lastUtcIso: "",
    lastRenderMs: 0,
    lastTextureRef: null
  } as PlanetaryRuntime),
  updateRuntime: () => {
    // No per-frame state outside what the syncObject loop maintains.
  },
  createInitialParams: () => ({
    location: { lat: 51.5074, lng: -0.1278 },
    dateTime: new Date().toISOString(),
    timezone: { mode: "auto" }
  }),
  sceneHooks: {
    createObject: () => {
      // Empty container — no 3D representation. The env IBL is published via
      // context.generateSkyIbl + setEnvironmentTexture. We still need to return an Object3D
      // so the host registers the actor in actorObjects and calls syncObject each frame.
      const group = new THREE.Group();
      group.name = "planetary-environment-container";
      return group;
    },
    syncObject: (context: PluginSyncContext) => {
      const runtime = context.runtime as PlanetaryRuntime | null;
      if (!runtime) {
        return;
      }
      const params = context.actor.params;
      const location = readLocation(params.location);
      const dateTimeIso = typeof params.dateTime === "string" && params.dateTime.length > 0
        ? params.dateTime
        : new Date().toISOString();
      const tzInput = readTimezone(params.timezone);
      const northRotationDeg = readNumber(params.northRotationDeg, 0);
      const turbidity = readNumber(params.turbidity, 2);
      const rayleigh = readNumber(params.rayleigh, 1);
      const mieCoefficient = readNumber(params.mieCoefficient, 0.005);
      const mieDirectionalG = readNumber(params.mieDirectionalG, 0.8);
      const sigma = Math.max(0, readNumber(params.sigma, 0));

      const ianaName = resolveTimezone({
        mode: tzInput.mode,
        ianaName: tzInput.ianaName,
        latitude: location.lat,
        longitude: location.lng
      });
      // params.dateTime is stored as a true UTC ISO by DateTimeField (which converts
      // local-wall-clock-in-zone → UTC at write time). Read it as a UTC instant directly;
      // do NOT pass through localDateInZoneToUtc (that would re-subtract the zone offset).
      let utcDate = new Date(dateTimeIso);
      if (!Number.isFinite(utcDate.getTime())) {
        utcDate = new Date();
      }
      const sun = computeSunDirection({
        utcDate,
        latitude: location.lat,
        longitude: location.lng,
        northRotationDeg
      });

      // Build a signature so we only re-render when something actually changed.
      const signature = [
        location.lat.toFixed(5),
        location.lng.toFixed(5),
        utcDate.toISOString(),
        ianaName,
        northRotationDeg.toFixed(3),
        turbidity.toFixed(3),
        rayleigh.toFixed(3),
        mieCoefficient.toFixed(4),
        mieDirectionalG.toFixed(3),
        sigma.toFixed(4)
      ].join("|");

      runtime.lastDirection = sun.direction;
      runtime.lastSunAltitudeDeg = sun.altitudeDeg;
      runtime.lastSunAzimuthDeg = sun.azimuthDeg;
      runtime.lastResolvedTimezone = ianaName;
      runtime.lastUtcIso = utcDate.toISOString();

      if (signature === runtime.lastSignature && runtime.lastTextureRef) {
        return;
      }

      const t0 = performance.now();
      const texture = context.generateSkyIbl({
        turbidity,
        rayleigh,
        mieCoefficient,
        mieDirectionalG,
        sunDirection: sun.direction,
        sigma
      });
      runtime.lastRenderMs = performance.now() - t0;

      if (texture) {
        context.setEnvironmentTexture(texture);
        runtime.lastSignature = signature;
        runtime.lastTextureRef = texture;
      }

      context.setActorStatus({
        values: {
          resolvedTimezone: ianaName,
          localTime: dateTimeIso,
          utcTime: utcDate.toISOString(),
          sunAltitudeDeg: round1(sun.altitudeDeg),
          sunAzimuthDeg: round1(sun.azimuthDeg),
          sigma: round1(sigma * 1000) / 1000,
          lastRenderMs: round1(runtime.lastRenderMs)
        },
        updatedAtIso: new Date().toISOString()
      });
    },
  },
  status: {
    build: ({ runtimeStatus }) => {
      const values = (runtimeStatus as { values?: Record<string, unknown> } | undefined)?.values ?? {};
      return [
        { label: "Type", value: "Planetary Environment" },
        { label: "Resolved Timezone", value: (values.resolvedTimezone as string) ?? "n/a" },
        { label: "Local Time", value: (values.localTime as string) ?? "n/a" },
        { label: "UTC Time", value: (values.utcTime as string) ?? "n/a" },
        { label: "Sun Altitude", value: formatDeg(values.sunAltitudeDeg) },
        { label: "Sun Azimuth", value: formatDeg(values.sunAzimuthDeg) },
        { label: "PMREM Sigma", value: typeof values.sigma === "number" ? values.sigma.toFixed(3) : "n/a" },
        { label: "Last Render", value: typeof values.lastRenderMs === "number" ? `${values.lastRenderMs} ms` : "n/a" }
      ];
    }
  }
};

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readLocation(value: unknown): { lat: number; lng: number } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as { lat?: unknown; lng?: unknown };
    const lat = typeof obj.lat === "number" ? obj.lat : 51.5074;
    const lng = typeof obj.lng === "number" ? obj.lng : -0.1278;
    return { lat, lng };
  }
  return { lat: 51.5074, lng: -0.1278 };
}

function readTimezone(value: unknown): { mode: "auto" | "manual"; ianaName?: string } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as { mode?: unknown; ianaName?: unknown };
    const mode = obj.mode === "manual" ? "manual" : "auto";
    const ianaName = typeof obj.ianaName === "string" ? obj.ianaName : undefined;
    return { mode, ianaName };
  }
  return { mode: "auto" };
}

function formatDeg(value: unknown): string {
  return typeof value === "number" ? `${value.toFixed(1)}°` : "n/a";
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ----- Handshake -----

const handshake: PluginHandshakeModule = {
  manifest: {
    handshakeVersion: 1,
    id: "simularca.planetary-environment",
    name: "Planetary Environment",
    version: PLUGIN_VERSION,
    description: "Procedural sky environment driven by physical sun position (location, date, time).",
    engine: { minApiVersion: 1, maxApiVersion: 1 }
  },
  createPlugin() {
    return {
      id: "simularca.planetary-environment",
      name: "Planetary Environment",
      actorDescriptors: [planetaryEnvironmentDescriptor],
      componentDescriptors: []
    };
  }
};

export { handshake };
export default handshake;
