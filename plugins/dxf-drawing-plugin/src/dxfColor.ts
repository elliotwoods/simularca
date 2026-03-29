const ACI_OVERRIDES: Record<number, string> = {
  1: "#ff0000",
  2: "#ffff00",
  3: "#00ff00",
  4: "#00ffff",
  5: "#0000ff",
  6: "#ff00ff",
  7: "#ffffff",
  8: "#808080",
  9: "#c0c0c0"
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (value: number) => Math.round(clamp01(value) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hsvToHex(h: number, s: number, v: number): string {
  const hue = ((h % 1) + 1) % 1;
  const i = Math.floor(hue * 6);
  const f = hue * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return rgbToHex(v, t, p);
    case 1:
      return rgbToHex(q, v, p);
    case 2:
      return rgbToHex(p, v, t);
    case 3:
      return rgbToHex(p, q, v);
    case 4:
      return rgbToHex(t, p, v);
    default:
      return rgbToHex(v, p, q);
  }
}

export function normalizeHexColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase();
  }
  return "#ffffff";
}

export function resolveAciColor(index: number): string {
  if (ACI_OVERRIDES[index]) {
    return ACI_OVERRIDES[index];
  }
  if (!Number.isFinite(index) || index <= 0) {
    return "#ffffff";
  }
  const hue = ((index - 1) % 24) / 24;
  const band = Math.floor((index - 1) / 24);
  const saturation = band % 2 === 0 ? 1 : 0.65;
  const value = 1 - Math.min(0.55, Math.floor(band / 2) * 0.08);
  return hsvToHex(hue, saturation, value);
}

export function resolveTrueColor(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(0xffffff, Math.floor(value))) : 0xffffff;
  return `#${safe.toString(16).padStart(6, "0")}`;
}

export function invertHexColor(value: string): string {
  const normalized = normalizeHexColor(value);
  const r = 255 - Number.parseInt(normalized.slice(1, 3), 16);
  const g = 255 - Number.parseInt(normalized.slice(3, 5), 16);
  const b = 255 - Number.parseInt(normalized.slice(5, 7), 16);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
