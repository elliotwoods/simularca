export type MistLookupNoisePreset = "off" | "cloudy" | "wispy" | "rolling" | "custom";

export interface MistLookupNoiseSettings {
  strength: number;
  scale: number;
  speed: number;
  scroll: [number, number, number];
  contrast: number;
  bias: number;
}

export const MIST_LOOKUP_NOISE_PRESET_KEYS = [
  "lookupNoiseStrength",
  "lookupNoiseScale",
  "lookupNoiseSpeed",
  "lookupNoiseScroll",
  "lookupNoiseContrast",
  "lookupNoiseBias"
] as const;

export type MistLookupNoisePresetKey = typeof MIST_LOOKUP_NOISE_PRESET_KEYS[number];

export const MIST_LOOKUP_NOISE_PRESETS: Record<Exclude<MistLookupNoisePreset, "custom">, MistLookupNoiseSettings> = {
  off: {
    strength: 0,
    scale: 1.6,
    speed: 0.12,
    scroll: [0.03, 0.06, 0.02],
    contrast: 1,
    bias: 0
  },
  cloudy: {
    strength: 0.45,
    scale: 1.6,
    speed: 0.12,
    scroll: [0.03, 0.06, 0.02],
    contrast: 0.9,
    bias: 0.08
  },
  wispy: {
    strength: 0.65,
    scale: 3.1,
    speed: 0.18,
    scroll: [0.02, 0.09, 0.03],
    contrast: 1.6,
    bias: -0.06
  },
  rolling: {
    strength: 0.55,
    scale: 2.1,
    speed: 0.24,
    scroll: [0.08, 0.02, 0.04],
    contrast: 1.2,
    bias: 0.04
  }
};

export function getMistLookupNoisePresetSettings(preset: MistLookupNoisePreset): MistLookupNoiseSettings {
  return MIST_LOOKUP_NOISE_PRESETS[preset === "custom" ? "cloudy" : preset];
}

export function buildMistLookupNoiseParams(
  preset: MistLookupNoisePreset
): Record<MistLookupNoisePresetKey | "lookupNoisePreset", number | string | [number, number, number]> {
  const settings = getMistLookupNoisePresetSettings(preset);
  return {
    lookupNoisePreset: preset,
    lookupNoiseStrength: settings.strength,
    lookupNoiseScale: settings.scale,
    lookupNoiseSpeed: settings.speed,
    lookupNoiseScroll: settings.scroll,
    lookupNoiseContrast: settings.contrast,
    lookupNoiseBias: settings.bias
  };
}
