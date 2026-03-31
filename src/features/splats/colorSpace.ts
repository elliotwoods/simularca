export type SplatColorInputSpace = "linear" | "srgb" | "iphone-sdr" | "apple-log";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function linearChannelToSrgb(value: number): number {
  const safeValue = Math.max(0, value);
  if (safeValue <= 0.0031308) {
    return safeValue * 12.92;
  }
  return 1.055 * Math.pow(safeValue, 1 / 2.4) - 0.055;
}

function appleLogEncode(value: number): number {
  const r0 = -0.05641088;
  const rt = 0.01;
  const c = 47.28711236;
  const beta = 0.00964052;
  const gamma = 0.08550479;
  const delta = 0.69336945;
  const safeValue = Math.max(0, value);

  if (safeValue >= rt) {
    return gamma * Math.log2(safeValue + beta) + delta;
  }
  return c * (safeValue - r0) ** 2;
}

function linearSrgbToRec2020(r: number, g: number, b: number): [number, number, number] {
  return [
    clamp01(0.6274018484653516 * r + 0.32929195634007197 * g + 0.043306195211340874 * b),
    clamp01(0.06909546764265984 * r + 0.9195442442082263 * g + 0.011360288153511802 * b),
    clamp01(0.016392112176216878 * r + 0.08802752955722451 * g + 0.8955803586132608 * b)
  ];
}

export function parseSplatColorInputSpace(value: unknown): SplatColorInputSpace {
  return value === "linear" || value === "srgb" || value === "iphone-sdr" || value === "apple-log"
    ? value
    : "srgb";
}

export function applySplatOutputTransform(
  rgb: [number, number, number],
  outputTransform: SplatColorInputSpace
): [number, number, number] {
  if (outputTransform === "linear") {
    return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  }
  if (outputTransform === "srgb" || outputTransform === "iphone-sdr") {
    return [
      clamp01(linearChannelToSrgb(rgb[0])),
      clamp01(linearChannelToSrgb(rgb[1])),
      clamp01(linearChannelToSrgb(rgb[2]))
    ];
  }
  const linear2020 = linearSrgbToRec2020(clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2]));
  return [
    clamp01(appleLogEncode(linear2020[0])),
    clamp01(appleLogEncode(linear2020[1])),
    clamp01(appleLogEncode(linear2020[2]))
  ];
}
