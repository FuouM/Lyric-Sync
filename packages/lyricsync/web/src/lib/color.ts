// packages/lyricsync/web/src/lib/color.ts
// Color math utilities for accent color calculation.
export function resolveAccentColorHex(color: string | null | undefined): string {
  if (!color || color === "default") return "#0078d4";
  return color;
}

export function parseHex(color: string): [number, number, number] {
  const c = color.replace(/^#/, "");
  if (c.length === 3) {
    return [parseInt(c[0]! + c[0]!, 16), parseInt(c[1]! + c[1]!, 16), parseInt(c[2]! + c[2]!, 16)];
  }
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

export function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return "#" + [r, g, b].map(x => clamp(x).toString(16).padStart(2, "0")).join("");
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255)];
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

export function adjustBrightness(hex: string, percent: number): string {
  const [r, g, b] = parseHex(hex);
  const factor = 1 + percent / 100;
  return toHex(r * factor, g * factor, b * factor);
}

export function getContrastText(hex: string): string {
  const [r, g, b] = parseHex(hex);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? "#000000" : "#ffffff";
}

export function getDeepAccentText(hex: string, _bgLightness?: number, _targetRatio?: number): string {
  return getContrastText(hex);
}

export function getAccessibleLinkColor(hex: string, _isDark?: boolean | string): string {
  return hex;
}
