// Static reference data for the ETC Source Four ellipsoidal.
// Convention follows the host's src/features/actors/mistVolumeLookupNoise.ts:
// module-level Record/array constants plus small getter helpers.
//
// NOTE: gel sRGB hex values are APPROXIMATE — theatre gels are physical filters and
// their appearance depends on lamp, batch, and viewing conditions. They are flagged
// `approximate: true` and surfaced as such in the inspector.

export interface LensSpec {
  id: string;
  label: string;
  angleDeg: number;
}

export interface ZoomBarrelSpec {
  id: string;
  label: string;
  minDeg: number;
  maxDeg: number;
}

export interface LampSpec {
  id: string;
  label: string;
  watts: number;
  lumens: number;
  cct: number;
  kind: "incandescent" | "led";
}

export interface GelSpec {
  id: string;
  label: string;
  hex: string;
  brand: "lee" | "rosco";
  approximate: boolean;
}

// Fixed lens tubes (degree field angle). Keyed by `<deg>deg`.
export const LENS_TUBES: Record<string, LensSpec> = {
  "5deg": { id: "5deg", label: "5°", angleDeg: 5 },
  "10deg": { id: "10deg", label: "10°", angleDeg: 10 },
  "14deg": { id: "14deg", label: "14°", angleDeg: 14 },
  "19deg": { id: "19deg", label: "19°", angleDeg: 19 },
  "26deg": { id: "26deg", label: "26°", angleDeg: 26 },
  "36deg": { id: "36deg", label: "36°", angleDeg: 36 },
  "50deg": { id: "50deg", label: "50°", angleDeg: 50 },
  "70deg": { id: "70deg", label: "70°", angleDeg: 70 },
  "90deg": { id: "90deg", label: "90°", angleDeg: 90 }
};

// Zoom barrels (variable field angle). Keyed by `<min>-<max>`.
export const ZOOM_BARRELS: Record<string, ZoomBarrelSpec> = {
  "15-30": { id: "15-30", label: "15–30° Zoom", minDeg: 15, maxDeg: 30 },
  "25-50": { id: "25-50", label: "25–50° Zoom", minDeg: 25, maxDeg: 50 }
};

// Lamp/power options. HPL incandescent lumens/CCT are nominal manufacturer figures;
// LED figures are approximate white-output equivalents.
export const LAMPS: Record<string, LampSpec> = {
  HPL750: { id: "HPL750", label: "HPL 750W", watts: 750, lumens: 21000, cct: 3250, kind: "incandescent" },
  HPL575: { id: "HPL575", label: "HPL 575W", watts: 575, lumens: 16520, cct: 3250, kind: "incandescent" },
  HPL375: { id: "HPL375", label: "HPL 375W", watts: 375, lumens: 10540, cct: 3050, kind: "incandescent" },
  HPL550: { id: "HPL550", label: "HPL 550W (long life)", watts: 550, lumens: 13000, cct: 3200, kind: "incandescent" },
  "LED-S2": { id: "LED-S2", label: "LED Series 2 Lustr", watts: 175, lumens: 9000, cct: 3200, kind: "led" },
  "LED-S3": { id: "LED-S3", label: "LED Series 3 Lustr X8", watts: 307, lumens: 12000, cct: 3200, kind: "led" }
};

// Curated common Lee (L###) + Rosco/Roscolux (R###) gels. Hex is approximate.
export const GELS: GelSpec[] = [
  { id: "L201", label: "L201 Full C.T.Blue", hex: "#cfe0ff", brand: "lee", approximate: true },
  { id: "L202", label: "L202 Half C.T.Blue", hex: "#dcecff", brand: "lee", approximate: true },
  { id: "L204", label: "L204 Full C.T.Orange", hex: "#ffb066", brand: "lee", approximate: true },
  { id: "L205", label: "L205 Half C.T.Orange", hex: "#ffcb8f", brand: "lee", approximate: true },
  { id: "L024", label: "L024 Scarlet", hex: "#e8362a", brand: "lee", approximate: true },
  { id: "L106", label: "L106 Primary Red", hex: "#e11f22", brand: "lee", approximate: true },
  { id: "L079", label: "L079 Just Blue", hex: "#1430a0", brand: "lee", approximate: true },
  { id: "L119", label: "L119 Dark Blue", hex: "#122a78", brand: "lee", approximate: true },
  { id: "L116", label: "L116 Medium Blue-Green", hex: "#1fb9a6", brand: "lee", approximate: true },
  { id: "L090", label: "L090 Dark Yellow Green", hex: "#6fbf3b", brand: "lee", approximate: true },
  { id: "L101", label: "L101 Yellow", hex: "#ffe21f", brand: "lee", approximate: true },
  { id: "L134", label: "L134 Golden Amber", hex: "#ffae3a", brand: "lee", approximate: true },
  { id: "R80", label: "R80 Primary Blue", hex: "#0e2fae", brand: "rosco", approximate: true },
  { id: "R26", label: "R26 Light Red", hex: "#ff4536", brand: "rosco", approximate: true },
  { id: "R27", label: "R27 Medium Red", hex: "#df1c22", brand: "rosco", approximate: true },
  { id: "R383", label: "R383 Sapphire Blue", hex: "#142a86", brand: "rosco", approximate: true },
  { id: "R3202", label: "R3202 Full Blue (CTB)", hex: "#cfe0ff", brand: "rosco", approximate: true },
  { id: "R3407", label: "R3407 RoscoSun 3/4 CTO", hex: "#ffbf80", brand: "rosco", approximate: true },
  { id: "R02", label: "R02 Bastard Amber", hex: "#ffe1c0", brand: "rosco", approximate: true },
  { id: "R90", label: "R90 Dark Yellow Green", hex: "#5fae3a", brand: "rosco", approximate: true }
];

const GEL_BY_ID: Record<string, GelSpec> = Object.fromEntries(GELS.map((gel) => [gel.id, gel]));
const LENS_BY_LABEL: Record<string, LensSpec> = Object.fromEntries(Object.values(LENS_TUBES).map((l) => [l.label, l]));
const ZOOM_BY_LABEL: Record<string, ZoomBarrelSpec> = Object.fromEntries(Object.values(ZOOM_BARRELS).map((z) => [z.label, z]));
const LAMP_BY_LABEL: Record<string, LampSpec> = Object.fromEntries(Object.values(LAMPS).map((l) => [l.label, l]));

// Selects render the option string as both value and label, so option values are the
// readable labels. Getters accept either the id (used by tests/seeding) or that label.
export function getLensSpec(idOrLabel: string): LensSpec | null {
  return LENS_TUBES[idOrLabel] ?? LENS_BY_LABEL[idOrLabel] ?? null;
}

export function getZoomBarrel(idOrLabel: string): ZoomBarrelSpec | null {
  return ZOOM_BARRELS[idOrLabel] ?? ZOOM_BY_LABEL[idOrLabel] ?? null;
}

export function getLampSpec(idOrLabel: string): LampSpec | null {
  return LAMPS[idOrLabel] ?? LAMP_BY_LABEL[idOrLabel] ?? null;
}

/** Accepts either a bare gel id ("L201") or a composite option label ("L201 Full C.T.Blue"). */
export function getGelSpec(idOrLabel: string): GelSpec | null {
  if (!idOrLabel) {
    return null;
  }
  const token = idOrLabel.split(" ")[0] ?? idOrLabel;
  return GEL_BY_ID[token] ?? GEL_BY_ID[idOrLabel] ?? null;
}

/** Readable select options for the fixed lens tubes, in ascending angle order. */
export function listLensTubeOptions(): string[] {
  return Object.values(LENS_TUBES)
    .slice()
    .sort((a, b) => a.angleDeg - b.angleDeg)
    .map((lens) => lens.label);
}

/** Readable select options for the zoom barrels. */
export function listZoomBarrelOptions(): string[] {
  return Object.values(ZOOM_BARRELS).map((barrel) => barrel.label);
}

/** Readable select options for the lamps. */
export function listLampOptions(): string[] {
  return Object.values(LAMPS).map((lamp) => lamp.label);
}

/** Readable select options for the gel preset picker ("L201 Full C.T.Blue", ...). */
export function listGelOptions(): string[] {
  return GELS.map((gel) => gel.label);
}
