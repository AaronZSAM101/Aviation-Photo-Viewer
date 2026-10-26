export interface Histograms {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  L: Uint32Array;
}

type HistogramSource = HTMLImageElement | HTMLCanvasElement;

export function computeHistograms(src: HistogramSource | null): Histograms | null {
  if (!src) return null;
  const width = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const height = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  if (!width || !height) return null;

  const MAX = 512;
  const scale = Math.min(1, MAX / Math.max(width, height));
  const cw = Math.max(1, Math.round(width * scale));
  const ch = Math.max(1, Math.round(height * scale));
  const tmp = document.createElement('canvas');
  tmp.width = cw;
  tmp.height = ch;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(src, 0, 0, cw, ch);
    data = ctx.getImageData(0, 0, cw, ch).data;
  } catch {
    return null;
  }

  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const L = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i];
    const G = data[i + 1];
    const B = data[i + 2];
    r[R] += 1;
    g[G] += 1;
    b[B] += 1;
    L[Math.min(255, (0.299 * R + 0.587 * G + 0.114 * B) | 0)] += 1;
  }
  return { r, g, b, L };
}

export function buildAreaPath(values: Uint32Array, vbW: number, vbH: number, peak: number): string {
  const trimmed = Math.max(1, peak);
  let d = `M 0 ${vbH} L 0 ${((vbH - (values[0] / trimmed) * vbH)).toFixed(2)}`;
  for (let i = 1; i < 256; i += 1) {
    const x = (i / 255) * vbW;
    const y = vbH - (Math.min(values[i], trimmed) / trimmed) * vbH;
    d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  d += ` L ${vbW} ${vbH} Z`;
  return d;
}

export function peakOf(arr: Uint32Array): number {
  const sorted = Array.from(arr).slice(1, 255).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.995)] || Math.max(...arr);
}
