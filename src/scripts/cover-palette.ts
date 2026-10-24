/**
 * 封面取色 → 毛玻璃底色
 * ============================================================
 * 音乐页那一整块玻璃（.mu-glass）和左下角迷你碟片的小窗（.mp-panel）
 * 用的是同一套变量：
 *
 *   --mu-hue    色相，用来把 daisyUI 的 --bc/--b1/--p 就地换成同色系
 *   --mu-base   玻璃底色（很深，约 15% 亮度）
 *   --mu-base2  渐变另一端（更深）
 *   --mu-glow   左上那团光
 *   --mu-glow2  右下那团光
 *
 * 拿到这五个值，CSS 里就只剩「怎么画」了，两边共用同一份取色逻辑，
 * 换歌时小窗和音乐页的玻璃会是同一个颜色。
 * ============================================================
 */

export interface Palette {
  hue: number;
  base: string;
  base2: string;
  glow: string;
  glow2: string;
}

export const FALLBACK_PALETTE: Palette = {
  hue: 265,
  base: '28 30 38',
  base2: '16 17 22',
  glow: '96 100 118',
  glow2: '58 64 82',
};

/** 取过的封面记下来，同一张图不重复画 canvas */
const paletteCache = new Map<string, Palette | null>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rgbToHue(r: number, g: number, b: number, max: number, min: number): number | null {
  if (max === min) return null;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ];
}

const cssRgb = (rgb: [number, number, number]): string => `${rgb[0]} ${rgb[1]} ${rgb[2]}`;

/**
 * 从封面缩略图里取一组颜色。
 *
 * 权重 = 饱和度^1.4 ×（1 - 亮度×0.55）：
 * 浅色 / 灰白色封面里那些深色、饱和的块会被放大，
 * 所以「白色封面 + 一点深蓝」也能调出一块够深、够有颜色的玻璃。
 * 色相用圆周平均取，避免 350° 和 10° 平均成 180°。
 */
function sampleCover(img: HTMLImageElement): Palette | null {
  const N = 28;
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, N, N);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, N, N).data;
  } catch {
    return null; // 跨域图片画不进 canvas
  }

  let weight = 0;
  let satSum = 0;
  let sinSum = 0;
  let cosSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 128) continue;
    const r = (data[i] ?? 0) / 255;
    const g = (data[i + 1] ?? 0) / 255;
    const b = (data[i + 2] ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);

    const w = s ** 1.4 * (1 - l * 0.55) + 0.003;
    weight += w;
    satSum += s * w;

    const hue = rgbToHue(r, g, b, max, min);
    if (hue !== null) {
      const hw = w * s;
      sinSum += Math.sin((hue * Math.PI) / 180) * hw;
      cosSum += Math.cos((hue * Math.PI) / 180) * hw;
    }
  }

  if (!weight) return null;

  const avgSat = satSum / weight;
  const hue = sinSum || cosSum ? (((Math.atan2(sinSum, cosSum) * 180) / Math.PI) + 360) % 360 : 265;
  // 玻璃底色要「有颜色但很沉」：彩度封顶，亮度压到 15% 左右，
  // 这样白字永远是白的，而且不管封面多花哨都不会变成一块糖果色。
  const sat = clamp(avgSat * 1.05 + 0.08, 0.12, 0.28);

  return {
    hue: Math.round(hue),
    base: cssRgb(hslToRgb(hue, sat, 0.145)),
    base2: cssRgb(hslToRgb(hue, sat * 0.9, 0.09)),
    glow: cssRgb(hslToRgb(hue, Math.min(0.5, sat + 0.12), 0.34)),
    glow2: cssRgb(hslToRgb((hue + 38) % 360, sat * 0.85, 0.28)),
  };
}

function writePalette(el: HTMLElement, palette: Palette | null): void {
  const p = palette ?? FALLBACK_PALETTE;
  const style = el.style;
  style.setProperty('--mu-hue', String(p.hue));
  style.setProperty('--mu-base', p.base);
  style.setProperty('--mu-base2', p.base2);
  style.setProperty('--mu-glow', p.glow);
  style.setProperty('--mu-glow2', p.glow2);
}

/**
 * 把某个封面转成玻璃底色，写到 el 的行内样式上。
 *
 * 每次都调用没关系：地址没变就直接返回（迷你小窗跟着 tick 每帧刷，
 * 这里是一行字符串比较）。图片是异步解码的，所以用 dataset 记住
 * 「这张元素现在要哪个封面」，慢一步的旧回调不会覆盖新颜色。
 */
export function applyCoverPalette(el: HTMLElement, url: string): void {
  if (el.dataset.paletteUrl === url) return;
  el.dataset.paletteUrl = url;

  if (!url) {
    writePalette(el, null);
    return;
  }

  const cached = paletteCache.get(url);
  if (cached !== undefined) {
    writePalette(el, cached);
    return;
  }

  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    let palette: Palette | null = null;
    try {
      palette = sampleCover(img);
    } catch {
      palette = null;
    }
    paletteCache.set(url, palette);
    if (el.dataset.paletteUrl === url) writePalette(el, palette);
  };
  img.onerror = () => {
    paletteCache.set(url, null);
    if (el.dataset.paletteUrl === url) writePalette(el, null);
  };
  img.src = url;
}
