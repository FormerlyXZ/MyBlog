/**
 * 文章归档 · 时之画廊（场景实现）
 * ---------------------------------------------------------------------------
 * 白天，城门之外是一座石铺庭院；推门进去，是一条带高窗的拱顶长廊。 * 左墙挂的不是「画」，而是每一篇文章的「海报」：封面、标题、日期、字数，
 * 站在画前能直接读出这是哪一篇。右墙开拱窗，日光斜切进来，尽头没入白雾。 * 全部几何与贴图都在这里程序化生成：没。GLTF，没有外部图片（封面除外）。 * 滚动 = 前行；点。= 走到画前；Esc = 退回长廊。 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/* ========================================================================== */
/*  数据                                                                      */
/* ========================================================================== */

interface ArcChapter {
  order: number;
  title: string;
  url: string;
  words: string;
}

interface ArcPost {
  id: string;
  slug: string;
  title: string;
  description: string;
  url: string;
  dateISO: string;
  dateLabel: string;
  dateShort: string;
  weekday: string;
  words: string;
  wordsRaw: number;
  cover?: string;
  categories: string[];
  series?: {
    slug: string;
    title: string;
    count: number;
    words: string;
    chapters: ArcChapter[];
  };
}

interface ArcMonth {
  key: string;
  label: string;
  year: number;
  month: number;
  count: number;
}

interface ArcData {
  posts: ArcPost[];
  months: ArcMonth[];
  total: number;
  seriesCount: number;
  chapterCount: number;
  totalWords: number;
  title: string;
  subtitle: string;
}

/** 展厅里的一幅「文章海报。*/
interface FrameItem {
  key: string;
  title: string;
  kicker: string;
  dateLabel: string;
  words: string;
  desc: string;
  url: string;
  cover?: string;
  chapter?: number;
  categories: string[];
  postIndex: number;
  chapters?: ArcChapter[];
}

const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif';
const MONO = '"JetBrains Mono", "SFMono-Regular", Consolas, monospace';
const SANS = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';

/* ========================================================================== */
/*  空间常量                                                                  */
/* ========================================================================== */

const ROOM = {
  /** 长廊净。*/
  width: 4.6,
  /** 半宽（墙面x = ±wall。*/
  wall: 2.3,
  /** 拱顶起拱高度 */
  spring: 4.9,
  /** 拱顶矢高 */
  rise: 0.95,
  /** 视平。*/
  eye: 1.62,
  /** 画与画的间距 */
  gap: 3.2,
  /** 第一幅画的z（门。，进门后负方向） */
  first: 5.2,
  /** 城门平台 / 室内地面标高，与门外台阶顶面对齐 */
  floor: 0.9,
};

/** 门外庭院 */
const YARD = {
  gateZ: 0,
  /** 相机起点 */
  startZ: 21,
  /** 地面铺装到哪 */
  groundZ: 46,
};

/* ========================================================================== */
/*  小工。                                                                  */
/* ========================================================================== */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const damp = (current: number, target: number, lambda: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** 固定种子，保证每次刷新纹路一。*/
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas2d(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  return { canvas, ctx };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function makeTexture(canvas: HTMLCanvasElement, srgb = true) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** 封面 / 任意图片画进指定矩形，裁剪填。*/
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const chars = Array.from(text);
  const lines: string[] = [];
  let line = '';
  for (const ch of chars) {
    if (ch === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const use = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    use[maxLines - 1] = use[maxLines - 1].slice(0, -1) + '…';
  }
  use.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return use.length;
}

/* ========================================================================== */
/*  程序化贴。                                                              */
/* ========================================================================== */

/**
 * 砖墙：现代砌法（顺砖、错缝半砖），砖 220×68mm，灰。12mm。 * 返回 { map, bump }，一张贴图覆。tileM × tileM 米。 */
function makeBrickTexture(tileM = 2.2, size = 1024, seed = 7) {
  const rand = mulberry32(seed);
  const brickW = 0.22;
  const brickH = 0.068;
  const mortar = 0.012;
  const ppm = size / tileM;

  const { canvas, ctx } = canvas2d(size, size);
  // 灰缝底色（石灰砂浆）
  ctx.fillStyle = '#c9c2b4';
  ctx.fillRect(0, 0, size, size);

  const bw = brickW * ppm;
  const bh = brickH * ppm;
  const m = mortar * ppm;

  const rows = Math.ceil(size / bh) + 1;
  for (let r = 0; r < rows; r++) {
    const y = r * bh;
    const shift = (r % 2) * (bw / 2) - bw / 2;
    for (let x = shift; x < size + bw; x += bw) {
      const bx = x + m / 2;
      const by = y + m / 2;
      const w = bw - m;
      const h = bh - m;

      const l = 54 + rand() * 12;
      const hue = 27 + rand() * 9;
      const sat = 7 + rand() * 8;
      ctx.fillStyle = `hsl(${hue} ${sat}% ${l}%)`;
      roundRect(ctx, bx, by, w, h, 2.5);
      ctx.fill();

      // 砖面斑驳
      for (let k = 0; k < 5; k++) {
        const gx = bx + rand() * w;
        const gy = by + rand() * h;
        const gr = (0.2 + rand() * 0.5) * w;
        const light = rand() > 0.5;
        const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
        grad.addColorStop(0, light ? 'rgba(255,248,232,0.10)' : 'rgba(40,30,22,0.10)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
      }

      // 上沿受光、下沿落。
ctx.fillStyle = 'rgba(255,250,238,0.18)';
      ctx.fillRect(bx + 1.5, by + 1.5, w - 3, 1.6);
      ctx.fillStyle = 'rgba(32,24,18,0.22)';
      ctx.fillRect(bx + 1.5, by + h - 3, w - 3, 2.4);

      // 偶发磕角
      if (rand() > 0.86) {
        ctx.fillStyle = 'rgba(60,48,38,0.5)';
        const cx = rand() > 0.5 ? bx : bx + w - 8;
        const cy = rand() > 0.5 ? by : by + h - 8;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + 7, cy);
        ctx.lineTo(cx, cy + 7);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // 整体脏旧与颗。
for (let i = 0; i < 24000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(20,14,10,0.05)';
    ctx.fillRect(x, y, 1.2, 1.2);
  }

  // 凹凸：砖亮、缝。
const bumpCanvas = canvas2d(size, size);
  const bctx = bumpCanvas.ctx;
  bctx.fillStyle = '#1d1d1d';
  bctx.fillRect(0, 0, size, size);
  for (let r = 0; r < rows; r++) {
    const y = r * bh;
    const shift = (r % 2) * (bw / 2) - bw / 2;
    for (let x = shift; x < size + bw; x += bw) {
      const v = 190 + rand() * 50;
      bctx.fillStyle = `rgb(${v},${v},${v})`;
      roundRect(bctx, x + m / 2, y + m / 2, bw - m, bh - m, 2.5);
      bctx.fill();
    }
  }

  const map = makeTexture(canvas);
  const bump = makeTexture(bumpCanvas.canvas, false);
  map.repeat.set(1, 1);
  bump.repeat.set(1, 1);
  // UV 以米为单位时，由调用方把 repeat 设为 1/tileM
  return { map, bump, tileM };
}

/** 大面积石材地面：浅色石灰岩大。 细缝 */
function makeFloorTexture(tileM = 3.2, size = 1024, seed = 21) {
  const rand = mulberry32(seed);
  const { canvas, ctx } = canvas2d(size, size);
  const ppm = size / tileM;
  ctx.fillStyle = '#b9b2a4';
  ctx.fillRect(0, 0, size, size);

  const slab = 0.8 * ppm;
  const joints: Array<[number, number, number, number]> = [];
  for (let y = 0; y < size + slab; y += slab * 0.9) {
    for (let x = 0; x < size + slab; x += slab) {
      const off = (Math.round(y / (slab * 0.9)) % 2) * (slab / 2);
      const bx = x + off;
      const l = 60 + rand() * 10;
      ctx.fillStyle = `hsl(${34 + rand() * 8} ${5 + rand() * 5}% ${l}%)`;
      roundRect(ctx, bx + 2, y + 2, slab - 4, slab * 0.9 - 4, 2);
      ctx.fill();

      // 石材纹理：斜向淡。 云斑
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx + 2, y + 2, slab - 4, slab * 0.9 - 4);
      ctx.clip();
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = `rgba(90,82,70,${0.05 + rand() * 0.05})`;
        ctx.lineWidth = 1 + rand() * 2;
        ctx.beginPath();
        const sx = bx + rand() * slab;
        const sy = y + rand() * slab;
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(sx + 40, sy + 10, sx + 90, sy - 20, sx + 160, sy + 6);
        ctx.stroke();
      }
      for (let k = 0; k < 6; k++) {
        const gx = bx + rand() * slab;
        const gy = y + rand() * slab;
        const gr = 20 + rand() * 60;
        const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
        grad.addColorStop(0, rand() > 0.5 ? 'rgba(255,252,244,0.10)' : 'rgba(96,88,76,0.08)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
      }
      ctx.restore();
      joints.push([bx, y]);
    }
  }

  // 。
ctx.strokeStyle = 'rgba(70,62,52,0.35)';
  ctx.lineWidth = 2;
  for (let y = 0, i = 0; y < size + slab; y += slab * 0.9, i++) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  // 颗粒
  for (let i = 0; i < 18000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(30,26,20,0.04)';
    ctx.fillRect(x, y, 1, 1);
  }

  const map = makeTexture(canvas);
  return { map, tileM };
}

/** 室外铺地：更长条的石板，缝隙里带土与。*/
function makePavingTexture(tileM = 3.6, size = 1024, seed = 33) {
  const rand = mulberry32(seed);
  const { canvas, ctx } = canvas2d(size, size);
  ctx.fillStyle = '#6f6a5e';
  ctx.fillRect(0, 0, size, size);
  const rows = 6;
  const cols = 4;
  const h = size / rows;
  const w = size / cols;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * (w / 2);
    for (let c = -1; c < cols + 1; c++) {
      const x = c * w + off;
      const l = 52 + rand() * 12;
      ctx.fillStyle = `hsl(${38 + rand() * 10} ${6 + rand() * 6}% ${l}%)`;
      roundRect(ctx, x + 3, r * h + 3, w - 6, h - 6, 3);
      ctx.fill();
      // 苔痕与磨。
for (let k = 0; k < 4; k++) {
        const gx = x + rand() * w;
        const gy = r * h + rand() * h;
        const gr = 10 + rand() * 40;
        const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
        grad.addColorStop(0, rand() > 0.6 ? 'rgba(92,104,66,0.16)' : 'rgba(255,250,234,0.08)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
      }
    }
  }
  for (let i = 0; i < 12000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(20,18,12,0.05)';
    ctx.fillRect(x, y, 1.2, 1.2);
  }
  return { map: makeTexture(canvas), tileM };
}

/** 灰泥拱顶：米白色，带污渍、抹刀痕与细裂纹 */
function makePlasterTexture(tileM = 3.2, size = 1024, seed = 44) {
  const rand = mulberry32(seed);
  const { canvas, ctx } = canvas2d(size, size);
  const grd = ctx.createLinearGradient(0, 0, 0, size);
  grd.addColorStop(0, '#e8e1d2');
  grd.addColorStop(0.55, '#ded5c4');
  grd.addColorStop(1, '#cabfa9');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);

  // 大块深浅（批灰不匀）
  for (let i = 0; i < 220; i++) {
    const gx = rand() * size;
    const gy = rand() * size;
    const gr = 40 + rand() * 220;
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    const dark = rand() > 0.45;
    grad.addColorStop(0, dark ? 'rgba(120,104,80,0.10)' : 'rgba(255,252,244,0.14)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
  }

  // 抹刀痕：细长的浅色弧线
  ctx.lineCap = 'round';
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 30 + rand() * 120;
    const a0 = rand() * Math.PI * 2;
    ctx.strokeStyle = rand() > 0.5 ? 'rgba(255,250,240,0.09)' : 'rgba(110,96,74,0.05)';
    ctx.lineWidth = 2 + rand() * 5;
    ctx.beginPath();
    ctx.arc(x, y, r, a0, a0 + 0.5 + rand() * 0.8);
    ctx.stroke();
  }

  // 裂纹
  ctx.strokeStyle = 'rgba(78,66,50,0.26)';
  for (let i = 0; i < 10; i++) {
    ctx.lineWidth = 0.7 + rand() * 1.3;
    ctx.beginPath();
    let x = rand() * size;
    let y = rand() * size;
    ctx.moveTo(x, y);
    for (let k = 0; k < 14; k++) {
      x += (rand() - 0.5) * 54;
      y += rand() * 28;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 细颗粒
  for (let i = 0; i < 26000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(40,32,22,0.06)';
    ctx.fillRect(x, y, 1.4, 1.4);
  }

  // 凹凸：与抹刀痕同频的粗糙度
  const { canvas: bump, ctx: bctx } = canvas2d(size, size);
  bctx.fillStyle = '#808080';
  bctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 4000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 2 + rand() * 10;
    const v = rand() > 0.5 ? 150 : 100;
    bctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    bctx.beginPath();
    bctx.arc(x, y, r, 0, Math.PI * 2);
    bctx.fill();
  }
  return { map: makeTexture(canvas), bump: makeTexture(bump, false), tileM };
}

/** 木纹：门。 横梁 / 家具 */
function makeWoodTexture(tileM = 1.6, size = 512, seed = 55, base = '#5b3a24') {
  const rand = mulberry32(seed);
  const { canvas, ctx } = canvas2d(size, size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const w = 1 + rand() * 5;
    ctx.strokeStyle = rand() > 0.5 ? 'rgba(255,222,180,0.07)' : 'rgba(24,12,6,0.16)';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let y = 0; y <= size; y += 32) {
      ctx.lineTo(x + Math.sin((y + i * 37) / 90) * 5 + (rand() - 0.5) * 3, y);
    }
    ctx.stroke();
  }
  // 板缝（四条）
  ctx.strokeStyle = 'rgba(16,8,4,0.4)';
  ctx.lineWidth = 3;
  for (let p = 1; p < 4; p++) {
    ctx.beginPath();
    ctx.moveTo((size / 4) * p, 0);
    ctx.lineTo((size / 4) * p, size);
    ctx.stroke();
  }
  return { map: makeTexture(canvas), tileM };
}

/** 屋顶瓦面：筒瓦竖向条。*/
function makeRoofTexture(tileM = 1.6, size = 512, seed = 66) {
  const rand = mulberry32(seed);
  const { canvas, ctx } = canvas2d(size, size);
  ctx.fillStyle = '#3c4046';
  ctx.fillRect(0, 0, size, size);
  const cols = 8;
  const w = size / cols;
  for (let c = 0; c < cols; c++) {
    const x = c * w;
    const l = 26 + rand() * 8;
    const grd = ctx.createLinearGradient(x, 0, x + w, 0);
    grd.addColorStop(0, `hsl(210 6% ${l}%)`);
    grd.addColorStop(0.45, `hsl(210 6% ${l + 10}%)`);
    grd.addColorStop(0.55, `hsl(210 6% ${l + 12}%)`);
    grd.addColorStop(1, `hsl(210 6% ${l - 4}%)`);
    ctx.fillStyle = grd;
    ctx.fillRect(x, 0, w, size);
    ctx.fillStyle = 'rgba(10,12,14,0.45)';
    ctx.fillRect(x + w - 3, 0, 3, size);
  }
  // 横向瓦垄
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let y = 0; y < size; y += size / 9) ctx.fillRect(0, y, size, 2);
  const map = makeTexture(canvas);
  return { map, tileM };
}

/** 波斯风长地毯：酒红底、金色边框、重复团。*/
function makeCarpetTexture(size = 1024, seed = 77) {
  const rand = mulberry32(seed);
  const { canvas, ctx } = canvas2d(size, size * 2);
  const W = size;
  const H = size * 2;

  // 。
const bg = ctx.createLinearGradient(0, 0, W, 0);
  bg.addColorStop(0, '#4a1417');
  bg.addColorStop(0.5, '#6d2024');
  bg.addColorStop(1, '#4a1417');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 内外边框
  const border = W * 0.11;
  ctx.fillStyle = '#2a1113';
  ctx.fillRect(0, 0, W, border);
  ctx.fillRect(0, H - border, W, border);
  ctx.fillRect(0, 0, border, H);
  ctx.fillRect(W - border, 0, border, H);

  ctx.strokeStyle = '#b98f4f';
  ctx.lineWidth = 3;
  ctx.strokeRect(border * 0.35, border * 0.35, W - border * 0.7, H - border * 0.7);

  // 边框里的卷草。
ctx.strokeStyle = 'rgba(206,170,110,0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 40; i++) {
    const t = i / 40;
    const y = t * H;
    ctx.beginPath();
    ctx.arc(border * 0.55, y, border * 0.18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(W - border * 0.55, y + border * 0.3, border * 0.18, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 中央团花（沿长度重复。
const cx = W / 2;
  const step = H / 3;
  for (let i = 0; i < 3; i++) {
    const cy = step * i + step / 2;
    // 外菱。
ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = 'rgba(214,178,116,0.5)';
    ctx.lineWidth = 3;
    ctx.strokeRect(-W * 0.16, -W * 0.16, W * 0.32, W * 0.32);
    ctx.strokeRect(-W * 0.11, -W * 0.11, W * 0.22, W * 0.22);
    ctx.restore();

    // 花瓣
    for (let p = 0; p < 8; p++) {
      const a = (p / 8) * Math.PI * 2;
      const px = cx + Math.cos(a) * W * 0.1;
      const py = cy + Math.sin(a) * W * 0.1;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, W * 0.07);
      grad.addColorStop(0, 'rgba(224,192,134,0.5)');
      grad.addColorStop(1, 'rgba(120,70,40,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(px, py, W * 0.075, W * 0.045, a, 0, Math.PI * 2);
      ctx.fill();
    }
    // 花心
    ctx.fillStyle = 'rgba(228,199,144,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, W * 0.035, 0, Math.PI * 2);
    ctx.fill();
  }

  // 散点小花
  for (let i = 0; i < 260; i++) {
    const x = border * 1.3 + rand() * (W - border * 2.6);
    const y = rand() * H;
    ctx.fillStyle = `rgba(${200 + rand() * 40},${160 + rand() * 40},${100 + rand() * 40},${0.12 + rand() * 0.2})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.5 + rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 磨损
  for (let i = 0; i < 20000; i++) {
    const x = rand() * W;
    const y = rand() * H;
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,235,210,0.03)' : 'rgba(20,6,6,0.05)';
    ctx.fillRect(x, y, 1, 1);
  }

  const map = makeTexture(canvas);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  return map;
}

/** 天空球用的顶点渐变（没有云也能有层次。*/
function makeSkyDome(radius = 240) {
  const geo = new THREE.SphereGeometry(radius, 32, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color('#5d93cf') },
      midColor: { value: new THREE.Color('#bcd4e8') },
      bottomColor: { value: new THREE.Color('#e9eee9') },
      sunDir: { value: new THREE.Vector3(-0.35, 0.42, 0.84).normalize() },
      sunColor: { value: new THREE.Color('#fff3d6') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 bottomColor;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(bottomColor, midColor, smoothstep(0.42, 0.58, h));
        col = mix(col, topColor, smoothstep(0.55, 0.95, h));
        float sun = pow(max(dot(normalize(vDir), sunDir), 0.0), 220.0);
        float glow = pow(max(dot(normalize(vDir), sunDir), 0.0), 8.0);
        col += sunColor * sun * 1.4 + sunColor * glow * 0.18;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/* -------------------------------------------------------------------------- */
/*  文章海报                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 一幅画的画面：不是「画」，是一张展览海报。
 * 上半是封面，下半是标题、日期、字数、摘要，远处也能认出是哪一篇。
 */
function makePosterCanvas(item: FrameItem, image?: HTMLImageElement) {
  const W = 900;
  const H = 1200;
  const { canvas, ctx } = canvas2d(W, H);
  const rand = mulberry32(hashString(item.key));

  // 纸底
  ctx.fillStyle = '#f2ecdd';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    const x = rand() * W;
    const y = rand() * H;
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(120,102,74,0.05)';
    ctx.fillRect(x, y, 1, 1);
  }

  // 封面。
const px = 54;
  const py = 54;
  const pw = W - px * 2;
  const ph = 560;
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, pw, ph);
  ctx.clip();
  if (image) {
    drawCover(ctx, image, px, py, pw, ph);
  } else {
    const g = ctx.createLinearGradient(px, py, px + pw, py + ph);
    g.addColorStop(0, '#3d4a5c');
    g.addColorStop(0.55, '#6d7a86');
    g.addColorStop(1, '#2a3038');
    ctx.fillStyle = g;
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = 'rgba(240,232,214,0.16)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.arc(px + pw * 0.72, py + ph * 0.3, 40 + i * 34, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // 封面压暗，便于压。
const shade = ctx.createLinearGradient(0, py + ph * 0.45, 0, py + ph);
  shade.addColorStop(0, 'rgba(8,10,14,0)');
  shade.addColorStop(1, 'rgba(8,10,14,0.72)');
  ctx.fillStyle = shade;
  ctx.fillRect(px, py + ph * 0.45, pw, ph * 0.55);

  // 封面上的栏目。
ctx.fillStyle = 'rgba(246,240,226,0.92)';
  ctx.font = `500 26px ${MONO}`;
  ctx.letterSpacing = '4px';
  ctx.fillText(item.kicker, px + 34, py + ph - 66);
  if (item.chapter) {
    ctx.font = `700 150px ${SERIF}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(246,240,226,0.9)';
    ctx.fillText(String(item.chapter).padStart(2, '0'), px + pw - 32, py + 150);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  // 金色细边
  ctx.strokeStyle = 'rgba(168,136,78,0.75)';
  ctx.lineWidth = 2;
  ctx.strokeRect(px - 8, py - 8, pw + 16, ph + 16);

  // 标题
  let y = py + ph + 92;
  ctx.fillStyle = '#15130f';
  ctx.font = `600 64px ${SERIF}`;
  ctx.letterSpacing = '1px';
  const lines = wrapText(ctx, item.title, px, y, pw, 76, 3);
  y += (lines - 1) * 76;

  // 分隔。
y += 52;
  ctx.strokeStyle = 'rgba(90,74,50,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, y);
  ctx.lineTo(px + pw, y);
  ctx.stroke();

  // 元信。
y += 42;
  ctx.fillStyle = '#6b5c43';
  ctx.font = `500 24px ${MONO}`;
  ctx.letterSpacing = '2px';
  ctx.fillText(`${item.dateLabel}   ·   ${item.words} 字 ·   ${item.categories[0] ?? '随笔'}`, px, y);

  // 摘要
  if (item.desc) {
    y += 54;
    ctx.fillStyle = '#4a4438';
    ctx.font = `400 27px ${SANS}`;
    ctx.letterSpacing = '0px';
    wrapText(ctx, item.desc, px, y, pw, 40, 2);
  }

  // 页脚
  ctx.fillStyle = '#8a7856';
  ctx.font = `500 22px ${MONO}`;
  ctx.letterSpacing = '3px';
  ctx.fillText('READ THE ARTICLE', px, H - 74);
  ctx.strokeStyle = 'rgba(168,136,78,0.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(px, H - 96);
  ctx.lineTo(px + 54, H - 96);
  ctx.stroke();

  return canvas;
}

function hashString(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 画框下的黄铜展签 */
function makePlaqueCanvas(item: FrameItem) {
  const W = 1024;
  const H = 256;
  const { canvas, ctx } = canvas2d(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2c2419');
  g.addColorStop(0.5, '#1d1811');
  g.addColorStop(1, '#241d14');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(198,162,96,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(14, 14, W - 28, H - 28);

  ctx.fillStyle = '#e9ddc4';
  ctx.font = `600 44px ${SERIF}`;
  ctx.letterSpacing = '2px';
  const title = item.title.length > 18 ? item.title.slice(0, 18) + '…' : item.title;
  ctx.fillText(title, 44, 104);

  ctx.fillStyle = 'rgba(198,162,96,0.92)';
  ctx.font = `500 22px ${MONO}`;
  ctx.letterSpacing = '3px';
  ctx.fillText(`${item.dateLabel}   ·   ${item.words} 字`, 44, 152);

  ctx.fillStyle = 'rgba(233,221,196,0.55)';
  ctx.font = `500 20px ${SANS}`;
  ctx.letterSpacing = '6px';
  ctx.textAlign = 'right';
  ctx.fillText('点击细看', W - 44, 200);
  ctx.textAlign = 'left';

  return canvas;
}

/** 城门上的匾额 */
function makeSignCanvas() {
  const W = 1024;
  const H = 300;
  const { canvas, ctx } = canvas2d(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#26201a');
  g.addColorStop(1, '#15110d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 双层金边
  ctx.strokeStyle = 'rgba(196,158,92,0.85)';
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, W - 24, H - 24);
  ctx.strokeStyle = 'rgba(196,158,92,0.35)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  ctx.fillStyle = '#e6d5ad';
  ctx.font = `600 118px ${SERIF}`;
  ctx.letterSpacing = '16px';
  ctx.textAlign = 'center';
  ctx.fillText('博客归档', W / 2, 158);

  ctx.fillStyle = 'rgba(214,186,132,0.85)';
  ctx.font = `500 34px ${MONO}`;
  ctx.letterSpacing = '14px';
  ctx.fillText('MEMORY GALLERY', W / 2, 232);
  return canvas;
}

/** 门上悬浮的进入提。*/
function makeEnterCanvas() {
  const W = 1024;
  const H = 320;
  const { canvas, ctx } = canvas2d(W, H);
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, W / 2);
  g.addColorStop(0, 'rgba(12,10,8,0.55)');
  g.addColorStop(0.7, 'rgba(12,10,8,0.28)');
  g.addColorStop(1, 'rgba(12,10,8,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(246,232,202,0.96)';
  ctx.font = `600 92px ${SERIF}`;
  ctx.letterSpacing = '12px';
  ctx.fillText('点击开启', W / 2, 158);
  ctx.fillStyle = 'rgba(220,196,150,0.9)';
  ctx.font = `500 34px ${MONO}`;
  ctx.letterSpacing = '12px';
  ctx.fillText('CLICK TO ENTER', W / 2, 226);
  return canvas;
}

/** 拱窗外的景色：天光 + 树冠 + 远处院墙 */
function makeWindowViewCanvas() {
  const W = 256;
  const H = 512;
  const { canvas, ctx } = canvas2d(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#8fb6d8');
  g.addColorStop(0.42, '#b9cfe0');
  g.addColorStop(0.62, '#c9d2c0');
  g.addColorStop(1, '#7d8a6a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 远处树冠（深色，压住高光）
  const rand = mulberry32(91);
  for (let i = 0; i < 34; i++) {
    const x = rand() * W;
    const y = H * 0.46 + rand() * H * 0.26;
    const r = 22 + rand() * 52;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${44 + rand() * 26},${66 + rand() * 26},${38 + rand() * 18},0.85)`);
    grad.addColorStop(1, 'rgba(70,90,58,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // 树干
  ctx.strokeStyle = 'rgba(42,32,24,0.6)';
  for (let i = 0; i < 6; i++) {
    ctx.lineWidth = 2 + rand() * 4;
    const x = rand() * W;
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x + (rand() - 0.5) * 16, H * 0.5);
    ctx.stroke();
  }
  return canvas;
}

/* -------------------------------------------------------------------------- */
/*  屋顶（重。 翘角。                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 一片带弧度的屋面：
 *  - 正脊到檐口是凹曲线（上陡下缓。 *  - 檐口两角向上。 *  - 前后各一片，两侧各一片三角翼。 */
function buildRoofSurface(
  halfW: number,
  depth: number,
  baseY: number,
  rise: number,
  upturn: number,
  material: THREE.Material,
  dir: 1 | -1,
) {
  const nx = 40;
  const nz = 12;
  const geo = new THREE.BufferGeometry();
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const ridgeHalf = Math.max(0.35, halfW - depth * 0.86);

  for (let j = 0; j <= nz; j++) {
    const t = j / nz; // 0 檐口 -> 1 正脊
    const z = dir * depth * (1 - t);
    const hw = lerp(halfW, ridgeHalf, t);
    for (let i = 0; i <= nx; i++) {
      const u = i / nx; // 0..1
      const x = (u * 2 - 1) * hw;
      const edge = Math.abs(u * 2 - 1);
      const y =
        baseY +
        rise * Math.pow(t, 0.82) +
        upturn * Math.pow(edge, 3.4) * Math.pow(1 - t, 3.2);
      pos.push(x, y, z);
      uv.push(u * (hw * 2) * 0.55, (1 - t) * depth * 0.55);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      if (dir > 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, ridgeHalf };
}

/** 檐口的封檐板 + 四角起翘 */
function buildEaveTrim(
  halfW: number,
  depth: number,
  baseY: number,
  upturn: number,
  dir: 1 | -1,
  material: THREE.Material,
) {
  const group = new THREE.Group();
  const n = 34;
  for (let i = 0; i < n; i++) {
    const u0 = i / n;
    const u1 = (i + 1) / n;
    const p = (u: number) => {
      const x = (u * 2 - 1) * halfW;
      const edge = Math.abs(u * 2 - 1);
      const y = baseY + upturn * Math.pow(edge, 3.4);
      return new THREE.Vector3(x, y, dir * depth);
    };
    const a = p(u0);
    const b = p(u1);
    const len = a.distanceTo(b) + 0.02;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.2, 0.26), material);
    bar.position.copy(a).lerp(b, 0.5);
    bar.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x);
    bar.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
    bar.castShadow = true;
    group.add(bar);
  }
  return group;
}

/** 正脊 + 两端吻兽 */
function buildRidge(length: number, y: number, material: THREE.Material, hornMat: THREE.Material) {
  const group = new THREE.Group();
  const beam = new THREE.Mesh(new THREE.BoxGeometry(length, 0.34, 0.42), material);
  beam.position.set(0, y + 0.12, 0);
  beam.castShadow = true;
  group.add(beam);

  [-1, 1].forEach((s) => {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.9, 5), hornMat);
    horn.position.set(s * (length / 2 - 0.1), y + 0.62, 0);
    horn.rotation.z = s * -0.42;
    horn.castShadow = true;
    group.add(horn);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.5), material);
    base.position.set(s * (length / 2 - 0.1), y + 0.34, 0);
    group.add(base);
  });
  return group;
}

/* -------------------------------------------------------------------------- */
/*  大理石贴图：浅色墙面 / 深色地面                                          */
/* -------------------------------------------------------------------------- */
function makeMarbleTexture(size = 1024, seed = 13, dark = false) {
  const rand = mulberry32(seed);
  const { canvas, ctx } = canvas2d(size, size);

  ctx.fillStyle = dark ? '#0d0f12' : '#d9d5cb';
  ctx.fillRect(0, 0, size, size);

  // 大块色斑：让石材有大面积明暗，而不是均匀噪点
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 60 + rand() * 220;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const l = dark ? 12 + rand() * 14 : 74 + rand() * 16;
    g.addColorStop(0, `hsla(40 6% ${l}% / ${0.16 + rand() * 0.2})`);
    g.addColorStop(1, 'hsla(40 6% 50% / 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 脉络：随机游走的主脉 + 分叉
  const vein = (
    x: number,
    y: number,
    ang: number,
    len: number,
    width: number,
    alpha: number,
  ) => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    let a = ang;
    let cx = x;
    let cy = y;
    for (let i = 0; i < len; i++) {
      a += (rand() - 0.5) * 0.55;
      cx += Math.cos(a) * 9;
      cy += Math.sin(a) * 9;
      ctx.lineTo(cx, cy);
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = dark
      ? `rgba(232,226,208,${alpha})`
      : `rgba(96,88,74,${alpha})`;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  const mainCount = 10;
  for (let i = 0; i < mainCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const ang = rand() * Math.PI * 2;
    const len = 60 + rand() * 90;
    vein(x, y, ang, len, 1.4 + rand() * 1.6, dark ? 0.5 : 0.34);
    // 分叉
    for (let k = 0; k < 3; k++) {
      const bx = x + Math.cos(ang + (rand() - 0.5)) * len * 3;
      const by = y + Math.sin(ang + (rand() - 0.5)) * len * 3;
      vein(bx, by, ang + (rand() - 0.5) * 1.6, 30 + rand() * 50, 0.8, 0.3);
    }
  }

  // 细碎裂纹与颗粒
  for (let i = 0; i < 220; i++) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.05)' : 'rgba(70,64,54,0.05)';
    ctx.fillRect(x, y, 1.5 + rand() * 2, 1 + rand());
  }
  for (let i = 0; i < 9000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(x, y, 1, 1);
  }

  const map = makeTexture(canvas);
  return { map, tileM: dark ? 3.2 : 2.8 };
}

/* -------------------------------------------------------------------------- */
/*  门外：庭院、树、栏。                                                    */
/* -------------------------------------------------------------------------- */

/** 腰檐（下檐）：四面围合、中间留出上层柱位的坡屋面 */
function buildSkirtRoof(
  innerW: number,
  innerD: number,
  outerW: number,
  outerD: number,
  y: number,
  rise: number,
  mat: THREE.Material,
  trimMat: THREE.Material,
) {
  const group = new THREE.Group();
  const nt = 8;
  const nx = 26;
  const upturn = 0.55;

  const makeSide = (dir: 1 | -1) => {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= nt; j++) {
      const t = j / nt;
      const z = dir * lerp(outerD, innerD, t);
      const w = lerp(outerW, innerW, t);
      for (let i = 0; i <= nx; i++) {
        const u = i / nx;
        const x = (u * 2 - 1) * w;
        const edge = Math.abs(u * 2 - 1);
        const yy = y + rise * Math.pow(t, 0.85) + upturn * Math.pow(edge, 3) * Math.pow(1 - t, 2.4);
        pos.push(x, yy, z);
        uv.push(u * w * 1.2, (1 - t) * depthUV);
      }
    }
    for (let j = 0; j < nt; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        if (dir > 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, mat);
  };

  const depthUV = 3.2;
  group.add(makeSide(1), makeSide(-1));

  // 两侧（沿 Z 方向的坡面）
  const makeFlank = (dir: 1 | -1) => {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= nt; j++) {
      const t = j / nt;
      const x = dir * lerp(outerW, innerW, t);
      const d = lerp(outerD, innerD, t);
      for (let i = 0; i <= nx; i++) {
        const u = i / nx;
        const z = (u * 2 - 1) * d;
        const edge = Math.abs(u * 2 - 1);
        const yy = y + rise * Math.pow(t, 0.85) + upturn * Math.pow(edge, 3) * Math.pow(1 - t, 2.4);
        pos.push(x, yy, z);
        uv.push(u * d * 1.2, (1 - t) * 3.2);
      }
    }
    for (let j = 0; j < nt; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        if (dir > 0) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, mat);
  };
  group.add(makeFlank(1), makeFlank(-1));

  // 檐口封檐板
  const trimF = new THREE.Mesh(new THREE.BoxGeometry(outerW * 2 + 0.2, 0.3, 0.2), trimMat);
  trimF.position.set(0, y - 0.12, outerD);
  group.add(trimF);
  const trimB = trimF.clone();
  trimB.position.z = -outerD;
  group.add(trimB);
  [-1, 1].forEach((s) => {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, outerD * 2 + 0.2), trimMat);
    trim.position.set(s * outerW, y - 0.12, 0);
    group.add(trim);
  });

  // 檐下：望板 + 露明椽头，让檐口有厚度
  const soffitMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.9 });
  const addSoffit = (zEdge: number, dir: 1 | -1) => {
    const w = outerW * 2 - (outerW - innerW) * 2 * 0.35;
    const board = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, 1.0), soffitMat);
    board.position.set(0, y - 0.1, dir * (zEdge - 0.5));
    group.add(board);
    for (let x = -outerW + 0.3; x <= outerW - 0.3; x += 0.34) {
      const rafter = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 1.05), trimMat);
      rafter.position.set(x, y - 0.16, dir * (zEdge - 0.5));
      group.add(rafter);
    }
  };
  addSoffit(outerD, 1);
  addSoffit(outerD, -1);

  return group;
}

/** 歇山顶：前后坡 + 两端山花 + 正脊/垂脊 */
function buildGableRoof(
  halfW: number,
  depth: number,
  y: number,
  rise: number,
  upturn: number,
  mat: THREE.Material,
  trimMat: THREE.Material,
  hornMat: THREE.Material,
) {
  const group = new THREE.Group();
  const front = buildRoofSurface(halfW, depth, y, rise, upturn, mat, 1);
  const back = buildRoofSurface(halfW, depth, y, rise, upturn, mat, -1);
  group.add(front.mesh, back.mesh);
  group.add(buildEaveTrim(halfW, depth, y, upturn, 1, trimMat));
  group.add(buildEaveTrim(halfW, depth, y, upturn, -1, trimMat));

  const ridgeHalf = front.ridgeHalf;
  // 山花：两端三角形封板
  const gableDepth = depth * 0.58;
  [-1, 1].forEach((s) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [0, y, gableDepth, 0, y, -gableDepth, 0, y + rise, 0],
        3,
      ),
    );
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0.5, 0], 2));
    g.setIndex([0, 1, 2]);
    g.computeVertexNormals();
    const panel = new THREE.Mesh(g, mat);
    panel.position.x = s * ridgeHalf;
    panel.scale.x = 1;
    // 保证两面可见
    const panelMat = mat as THREE.MeshStandardMaterial;
    panel.material = panelMat;
    group.add(panel);

    // 垂脊：从正脊端点到檐角
    const ridgeLen = Math.hypot(gableDepth, rise);
    const hip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, ridgeLen), trimMat);
    hip.position.set(s * (ridgeHalf + 0.02), y + rise / 2, gableDepth / 2);
    hip.rotation.x = -Math.atan2(rise, gableDepth);
    group.add(hip);
    const hip2 = hip.clone();
    hip2.position.z = -gableDepth / 2;
    hip2.rotation.x = Math.atan2(rise, gableDepth);
    group.add(hip2);
  });

  group.add(buildRidge(ridgeHalf * 2 + 0.3, y + rise, trimMat, hornMat));

  // 檐口厚度：封檐板 + 望板 + 露明椽头
  const soffitMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.9 });
  [1, -1].forEach((dir) => {
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2 + 0.2, 0.32, 0.18), trimMat);
    fascia.position.set(0, y - 0.12, dir * depth);
    group.add(fascia);
    const board = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2 - 0.4, 0.06, 1.05), soffitMat);
    board.position.set(0, y - 0.14, dir * (depth - 0.52));
    group.add(board);
    for (let x = -halfW + 0.3; x <= halfW - 0.3; x += 0.36) {
      const rafter = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 1.1), trimMat);
      rafter.position.set(x, y - 0.2, dir * (depth - 0.52));
      group.add(rafter);
    }
  });

  return group;
}

function buildTree(
  x: number,
  z: number,
  scale: number,
  barkMat: THREE.Material,
  leafMats: THREE.Material[],
  seed: number,
) {
  const rand = mulberry32(seed);
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22 * scale, 0.42 * scale, 4.2 * scale, 10, 3),
    barkMat,
  );
  trunk.position.y = 2.1 * scale;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  group.add(trunk);

  // 分枝
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rand();
    const br = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07 * scale, 0.15 * scale, 2.4 * scale, 6),
      barkMat,
    );
    br.position.set(Math.cos(a) * 0.7 * scale, 3.6 * scale, Math.sin(a) * 0.7 * scale);
    br.rotation.z = Math.cos(a) * 0.5;
    br.rotation.x = Math.sin(a) * 0.5;
    br.castShadow = true;
    group.add(br);
  }

  // 树冠：一堆压扁的。
const clusters = 9;
  for (let i = 0; i < clusters; i++) {
    const a = rand() * Math.PI * 2;
    const r = rand() * 2.1 * scale;
    const mat = leafMats[Math.floor(rand() * leafMats.length)];
    const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry((0.9 + rand() * 0.7) * scale, 1), mat);
    leaf.position.set(Math.cos(a) * r, (4.2 + rand() * 1.7) * scale, Math.sin(a) * r);
    leaf.scale.y = 0.7;
    leaf.castShadow = true;
    group.add(leaf);
  }
  return group;
}

/** 石栏杆：望柱 + 栏板 */
function buildBalustrade(
  fromX: number,
  toX: number,
  z: number,
  mat: THREE.Material,
) {
  const group = new THREE.Group();
  const length = toX - fromX;
  const count = Math.max(3, Math.round(length / 1.6));
  for (let i = 0; i <= count; i++) {
    const x = fromX + (length * i) / count;
    const post = new THREE.Mesh(new RoundedBoxGeometry(0.26, 1.0, 0.26, 2, 0.03), mat);
    post.position.set(x, 0.5, z);
    post.castShadow = true;
    group.add(post);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), mat);
    cap.position.set(x, 1.06, z);
    cap.scale.y = 1.2;
    cap.castShadow = true;
    group.add(cap);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(length, 0.16, 0.2), mat);
  rail.position.set(fromX + length / 2, 0.74, z);
  rail.castShadow = true;
  group.add(rail);
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(length, 0.3, 0.22), mat);
  bottom.position.set(fromX + length / 2, 0.2, z);
  bottom.castShadow = true;
  group.add(bottom);
  return group;
}

/** 石狮：从底座到鬃毛、爪、绣球，尽量能看出来是狮。*/
function buildLion(x: number, z: number, mat: THREE.Material, trim: THREE.Material) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);

  // 须弥。
const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 1.5), trim);
  base.position.y = 0.11;
  base.castShadow = true;
  g.add(base);
  const base2 = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.16, 1.26), mat);
  base2.position.y = 0.3;
  base2.castShadow = true;
  g.add(base2);
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.86, 1.1), mat);
  plinth.position.y = 0.8;
  plinth.castShadow = true;
  g.add(plinth);
  const collarBase = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.12, 1.22), trim);
  collarBase.position.y = 1.28;
  collarBase.castShadow = true;
  g.add(collarBase);

  const stone = mat;
  // 后胯：坐姿的基座体块
  const haunch = new THREE.Mesh(new THREE.SphereGeometry(0.46, 18, 14), stone);
  haunch.scale.set(1.02, 0.92, 1.12);
  haunch.position.set(0, 1.72, -0.16);
  haunch.castShadow = true;
  g.add(haunch);

  // 胸腔：向前上方挺起
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.4, 18, 14), stone);
  chest.scale.set(0.98, 1.06, 0.86);
  chest.position.set(0, 1.99, 0.16);
  chest.castShadow = true;
  g.add(chest);

  // 前腿：直立撑地
  [-1, 1].forEach((s) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.125, 0.72, 10), stone);
    leg.position.set(s * 0.26, 1.62, 0.3);
    leg.rotation.x = -0.06;
    leg.castShadow = true;
    g.add(leg);
    const paw = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.16, 0.4), stone);
    paw.position.set(s * 0.26, 1.3, 0.4);
    paw.castShadow = true;
    g.add(paw);
    // 爪趾
    for (let t = -1; t <= 1; t++) {
      const toe = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), stone);
      toe.position.set(s * 0.26 + t * 0.075, 1.29, 0.6);
      g.add(toe);
    }
  });

  // 头：略大，正面朝前
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 20, 16), stone);
  head.position.set(0, 2.5, 0.14);
  head.scale.set(1.02, 0.98, 0.94);
  head.castShadow = true;
  g.add(head);

  // 额头与眉骨
  const brow = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.12, 0.16), stone);
  brow.position.set(0, 2.63, 0.36);
  g.add(brow);

  // 吻部 + 张开的嘴
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.24, 0.24), stone);
  muzzle.position.set(0, 2.4, 0.42);
  muzzle.castShadow = true;
  g.add(muzzle);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.08), trim);
  mouth.position.set(0, 2.33, 0.52);
  g.add(mouth);
  [-1, 1].forEach((s) => {
    const fang = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.11, 6), stone);
    fang.position.set(s * 0.08, 2.34, 0.55);
    fang.rotation.x = Math.PI;
    g.add(fang);
  });
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), stone);
  nose.position.set(0, 2.47, 0.55);
  g.add(nose);

  // 眼睛
  [-1, 1].forEach((s) => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.058, 10, 8), trim);
    eye.position.set(s * 0.15, 2.55, 0.45);
    g.add(eye);
    // 耳朵
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.14, 8), stone);
    ear.position.set(s * 0.32, 2.72, 0.02);
    ear.rotation.z = s * 0.5;
    g.add(ear);
  });

  // 鬃毛：两圈卷，前面一圈贴脸，后面一圈压在后脑
  const maneRing = (count: number, radius: number, yBase: number, zBase: number, size: number) => {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const curl = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), stone);
      curl.scale.set(1, 0.85, 0.85);
      curl.position.set(
        Math.cos(a) * radius,
        yBase + Math.sin(a) * radius * 0.62,
        zBase + Math.sin(a) * radius * 0.42,
      );
      g.add(curl);
    }
  };
  maneRing(14, 0.44, 2.5, 0.06, 0.115);
  maneRing(10, 0.34, 2.6, -0.1, 0.13);

  // 背脊鬃毛
  for (let i = 0; i < 6; i++) {
    const curl = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), stone);
    curl.position.set(0, 2.42 - i * 0.1, -0.22 - i * 0.055);
    g.add(curl);
  }

  // 尾巴：贴背卷起
  const tail = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.055, 6, 14, Math.PI * 1.15), stone);
  tail.position.set(0, 1.92, -0.56);
  tail.rotation.set(0.2, 0, 0.4);
  g.add(tail);

  // 绣球
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), trim);
  ball.position.set(0.28, 1.42, 0.5);
  ball.castShadow = true;
  g.add(ball);

  // 项圈与铃铛
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 6, 20), trim);
  collar.position.set(0, 2.2, 0.16);
  collar.rotation.x = 1.25;
  g.add(collar);
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), trim);
  bell.position.set(0, 2.06, 0.46);
  g.add(bell);

  return g;
}

/** 檐下斗拱：一个block + 横栱 */
function buildDougong(
  halfW: number,
  y: number,
  z: number,
  mat: THREE.Material,
  step = 0.66,
) {
  const group = new THREE.Group();
  // 坐斗：柱头上承托整朵斗拱的方形大斗
  const seatGeo = new THREE.BoxGeometry(0.42, 0.2, 0.42);
  const blockGeo = new THREE.BoxGeometry(0.3, 0.24, 0.34);
  const armGeo = new THREE.BoxGeometry(0.86, 0.13, 0.24);
  const armGeo2 = new THREE.BoxGeometry(0.56, 0.12, 0.2);
  // 昂：向前斜挑出的尖嘴
  const angGeo = new THREE.BoxGeometry(0.16, 0.14, 0.62);
  for (let x = -halfW + 0.4; x <= halfW - 0.4; x += step) {
    const seat = new THREE.Mesh(seatGeo, mat);
    seat.position.set(x, y - 0.18, z);
    seat.castShadow = true;
    group.add(seat);

    const b = new THREE.Mesh(blockGeo, mat);
    b.position.set(x, y, z);
    b.castShadow = true;
    group.add(b);

    const a = new THREE.Mesh(armGeo, mat);
    a.position.set(x, y + 0.18, z + 0.06);
    a.castShadow = true;
    group.add(a);

    const a2 = new THREE.Mesh(armGeo2, mat);
    a2.position.set(x, y + 0.33, z + 0.14);
    a2.castShadow = true;
    group.add(a2);

    // 昂嘴：斜向下前方挑出
    const ang = new THREE.Mesh(angGeo, mat);
    ang.position.set(x, y + 0.3, z + 0.42);
    ang.rotation.x = 0.32;
    ang.castShadow = true;
    group.add(ang);
  }
  return group;
}

/* -------------------------------------------------------------------------- */
/*  世界装配                                                                   */
/* -------------------------------------------------------------------------- */

interface World {
  doorL: THREE.Group;
  doorR: THREE.Group;
  artHits: THREE.Mesh[];
  paintZ: (i: number) => number;
  lastPaintZ: number;
  endZ: number;
  groundY: number;
}

/** BoxGeometry 的UV 默认每面 0..1，按真实尺寸缩放后砖缝不会拉。*/
function scaleBoxUV(geo: THREE.BoxGeometry, w: number, h: number, d: number, tile: number) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const sizes: Array<[number, number]> = [
    [d / tile, h / tile],
    [d / tile, h / tile],
    [w / tile, d / tile],
    [w / tile, d / tile],
    [w / tile, h / tile],
    [w / tile, h / tile],
  ];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * sizes[f][0], uv.getY(k) * sizes[f][1]);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

function brickBox(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  tile = 2.2,
) {
  return new THREE.Mesh(scaleBoxUV(new THREE.BoxGeometry(w, h, d), w, h, d, tile), mat);
}

/** 平面几何：把 0..1 。UV 换成「贴图块数」，。scaleBoxUV 同一套约。*/
function planeMeters(geo: THREE.PlaneGeometry, w: number, h: number, tile: number) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (w / tile), uv.getY(i) * (h / tile));
  }
  uv.needsUpdate = true;
  return geo;
}

/** 拱顶：椭圆拱，内表面朝下 */
function buildVaultGeometry(zStart: number, zEnd: number) {
  const len = Math.abs(zEnd - zStart);
  const segZ = Math.max(10, Math.round(len / 1.4));
  const segA = 30;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  for (let j = 0; j <= segZ; j++) {
    const z = lerp(zStart, zEnd, j / segZ);
    for (let i = 0; i <= segA; i++) {
      const a = (i / segA) * Math.PI;
      pos.push(Math.cos(a) * ROOM.wall, ROOM.spring + Math.sin(a) * ROOM.rise, z);
      uv.push((a / Math.PI) * 6.4, (j / segZ) * len * 0.4);
    }
  }
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segA; i++) {
      const a = j * (segA + 1) + i;
      const b = a + 1;
      const c = a + segA + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** 拱肋：沿着拱顶走一圈的石肋 */
function buildRibGeometry() {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI;
    points.push(
      new THREE.Vector3(
        Math.cos(a) * (ROOM.wall - 0.03),
        ROOM.spring + Math.sin(a) * (ROOM.rise - 0.03),
        0,
      ),
    );
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, 28, 0.055, 6, false);
}

/** 拱脚托石（corbel。*/
function buildCorbel(mat: THREE.Material) {
  const g = new THREE.Group();
  // 四分之一外方内圆：外侧是方角，内侧随高度收成圆弧，顶部与横梁底贴合
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.62);
  shape.lineTo(0.46, 0.62);
  shape.lineTo(0.46, 0.44);
  shape.quadraticCurveTo(0.12, 0.30, 0, 0);

  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, {
      depth: 0.34,
      bevelEnabled: false,
      curveSegments: 10,
    }),
    mat,
  );
  body.position.set(0, 0, -0.17);
  g.add(body);

  // 顶部压板：让支撑与横梁严丝合缝
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 0.38), mat);
  cap.position.set(0.21, 0.62, 0);
  g.add(cap);

  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

/** 吊灯：铜。 玻璃球暖灯（替代蜡烛。*/
function buildChandelier(glassMat: THREE.Material, brassMat: THREE.Material, ironMat: THREE.Material) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.045, 8, 36), brassMat);
  ring.rotation.x = Math.PI / 2;
  ring.castShadow = true;
  g.add(ring);

  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.03, 8, 32), brassMat);
  ring2.rotation.x = Math.PI / 2;
  ring2.position.y = 0.16;
  g.add(ring2);

  // 吊链
  const chainTop = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.52, 6), ironMat);
  chainTop.position.y = 0.38;
  g.add(chainTop);
  const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.1, 10), brassMat);
  canopy.position.y = 0.66;
  g.add(canopy);

  // 六盏玻璃球：灯头朝上，球体自发光，看起来是亮着的
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xfff1d8,
    emissive: 0xffd9a6,
    emissiveIntensity: 2.4,
    roughness: 0.35,
  });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * 0.62;
    const z = Math.sin(a) * 0.62;
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.028, 0.09, 10), brassMat);
    cup.position.set(x, 0.045, z);
    g.add(cup);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.09, 5), brassMat);
    stem.position.set(x, 0.11, z);
    g.add(stem);
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.095, 16, 12), bulbMat);
    globe.position.set(x, 0.2, z);
    g.add(globe);
  }
  return g;
}

/** 长椅：木。 皮革坐垫 + 铸铁。*/
function buildBench(woodMat: THREE.Material, leatherMat: THREE.Material, ironMat: THREE.Material) {
  const g = new THREE.Group();
  const seat = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.12, 1.9, 2, 0.03), woodMat);
  seat.position.y = 0.44;
  seat.castShadow = true;
  g.add(seat);
  const cushion = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.1, 1.78, 2, 0.04), leatherMat);
  cushion.position.y = 0.53;
  cushion.castShadow = true;
  g.add(cushion);
  [-0.72, 0.72].forEach((z) => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.06), ironMat);
    leg.position.set(0, 0.21, z);
    g.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.42), ironMat);
    foot.position.set(0, 0.03, z);
    g.add(foot);
  });
  return g;
}

/**
 * 搭出整座「时之画廊」：
 * 白天庭院 →城。→拱顶长廊（右侧高窗采光）→无尽延伸。*/
function buildWorld(scene: THREE.Scene, items: FrameItem[]): World {
  const brick = makeBrickTexture();
  const floorTex = makeFloorTexture();
  const pavingTex = makePavingTexture();
  const plasterTex = makePlasterTexture();
  const woodTex = makeWoodTexture();
  const roofTex = makeRoofTexture();
  const carpetTex = makeCarpetTexture();

  const brickMat = new THREE.MeshStandardMaterial({
    map: brick.map,
    bumpMap: brick.bump,
    bumpScale: 0.5,
    roughness: 0.94,
    metalness: 0,
    color: 0xcfc4b0,
  });
  const brickDarkMat = brickMat.clone();
  brickDarkMat.color = new THREE.Color(0x9c9484);
  const plasterMat = new THREE.MeshStandardMaterial({
    map: plasterTex.map,
    roughness: 0.96,
    color: 0xd6cab5,
  });
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex.map,
    roughness: 0.45,
    metalness: 0.1,
    color: 0x8f887b,
  });

  // 现代展厅：浅色大理石墙 + 黑色大理石地面 + 木板平顶
  const marbleTex = makeMarbleTexture(1024, 13, false);
  const darkMarbleTex = makeMarbleTexture(1024, 29, true);
  const marbleWallMat = new THREE.MeshStandardMaterial({
    map: marbleTex.map,
    roughness: 0.16,
    metalness: 0.02,
    envMapIntensity: 1.5,
    color: 0xffffff,
  });
  const marbleFloorMat = new THREE.MeshStandardMaterial({
    map: darkMarbleTex.map,
    roughness: 0.1,
    metalness: 0.04,
    envMapIntensity: 1.9,
    color: 0xffffff,
  });
  const plankTex = makeWoodTexture(1.8, 1024, 41, '#6b4a30');
  const plankMat = new THREE.MeshStandardMaterial({
    map: plankTex.map,
    roughness: 0.78,
    color: 0xd8c6a8,
  });
  const pavingMat = new THREE.MeshStandardMaterial({
    map: pavingTex.map,
    roughness: 0.92,
    color: 0xd9d3c7,
  });
  const woodMat = new THREE.MeshStandardMaterial({
    map: woodTex.map,
    roughness: 0.72,
    metalness: 0.02,
    color: 0xffffff,
  });
  const darkWoodMat = new THREE.MeshStandardMaterial({
    map: woodTex.map,
    color: 0x6b4a33,
    roughness: 0.76,
  });
  const roofMat = new THREE.MeshStandardMaterial({
    map: roofTex.map,
    roughness: 0.86,
    metalness: 0.05,
    color: 0xb9bec6,
    side: THREE.DoubleSide,
  });
  const carpetMat = new THREE.MeshStandardMaterial({
    map: carpetTex,
    roughness: 0.98,
    color: 0xffffff,
  });
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x9d9483, roughness: 0.9 });
  const stoneDark = new THREE.MeshStandardMaterial({ color: 0x6f6759, roughness: 0.92 });
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xb98a44,
    metalness: 0.6,
    roughness: 0.38,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xc9a25e,
    metalness: 0.75,
    roughness: 0.34,
  });
  const ironMat = new THREE.MeshStandardMaterial({
    color: 0x2c2b2a,
    metalness: 0.55,
    roughness: 0.55,
  });
  const leatherMat = new THREE.MeshStandardMaterial({ color: 0x6b3a26, roughness: 0.62 });
  const billetGlassMat = new THREE.MeshStandardMaterial({
    color: 0xfff2d6,
    emissive: new THREE.Color(0xffd9a0),
    emissiveIntensity: 2.2,
    roughness: 0.25,
    metalness: 0,
  });
  const barkMat = new THREE.MeshStandardMaterial({ color: 0x5b4a3a, roughness: 0.95 });
  const leafMats = [0x6d8a4e, 0x7d9a58, 0x5c7a44].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true }),
  );

  // UV 采用「贴图块数」：scaleBoxUV 已按真实尺寸换算，repeat 保持 1。
for (const t of [brick.map, brick.bump, floorTex.map, pavingTex.map, plasterTex.map, woodTex.map, roofTex.map]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 1);
  }
  carpetTex.repeat.set(1, 1 / 9.6);

  /* ---------------------------------------------------------------- 天空 */

  const sky = makeSkyDome(260);
  scene.add(sky);

  /* ---------------------------------------------------------------- 。*/

  const sun = new THREE.DirectionalLight(0xffeed6, 1.9);
  sun.position.set(20, 24, 16);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -26;
  sun.shadow.camera.right = 26;
  sun.shadow.camera.top = 26;
  sun.shadow.camera.bottom = -26;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(0, 2, -4);

  const hemi = new THREE.HemisphereLight(0xcfe2f7, 0x6d6455, 0.42);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xfff6e8, 0.14);
  scene.add(ambient);

  // 门洞前的补光：城门退在檐下，纯靠太阳会整片压。
const gateFill = new THREE.DirectionalLight(0xe8eef7, 0.5);
  gateFill.position.set(-7, 5, 26);
  scene.add(gateFill);
  scene.add(gateFill.target);
  gateFill.target.position.set(0, 2.4, -1);

  /* ---------------------------------------------------------------- 地面 */

  const groundGeo = planeMeters(new THREE.PlaneGeometry(180, 180), 180, 180, pavingTex.tileM);
  const ground = new THREE.Mesh(groundGeo, pavingMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, -20);
  ground.receiveShadow = true;
  scene.add(ground);

  // 两侧草地
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x6f7f4a, roughness: 1 });
  [-1, 1].forEach((s) => {
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(46, 90), grassMat);
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(s * 30, 0.01, 16);
    grass.receiveShadow = true;
    scene.add(grass);
  });

  // 中轴御路：比两侧略亮、略。
const path = new THREE.Mesh(planeMeters(new THREE.PlaneGeometry(7, 40), 7, 40, pavingTex.tileM), pavingMat);
  path.rotation.x = -Math.PI / 2;
  path.position.set(0, 0.02, 18);
  path.receiveShadow = true;
  scene.add(path);

  /* ---------------------------------------------------------------- 台阶与台。*/

  const platformY = ROOM.floor;
  const platform = brickBox(27, platformY, 11, pavingMat, 3.6);
  platform.position.set(0, platformY / 2, -2.4);
  platform.receiveShadow = true;
  platform.castShadow = true;
  scene.add(platform);

  // 六级台阶：由外向内逐级升高，最上一级与平台齐平
  const stepTop = platformY;
  const stepRise = stepTop / 6;
  const stepRun = 0.42;
  for (let i = 0; i < 6; i++) {
    const h = stepRise * (i + 1);
    const step = brickBox(7.4 - i * 0.22, h, stepRun + 0.06, stoneMat, 3.6);
    step.position.set(0, h / 2, 3.05 + (5 - i) * stepRun + stepRun / 2);
    step.receiveShadow = true;
    step.castShadow = true;
    scene.add(step);
  }
  // 两侧垂带
  [-1, 1].forEach((s) => {
    const cheek = brickBox(0.5, platformY + 0.12, 6 * stepRun + 0.5, stoneDark, 3.6);
    cheek.position.set(s * 3.85, (platformY + 0.12) / 2, 3.05 + (6 * stepRun) / 2);
    cheek.rotation.z = 0;
    cheek.receiveShadow = true;
    cheek.castShadow = true;
    scene.add(cheek);
  });

  /* ---------------------------------------------------------------- 城墙与门。*/

  const wallTop = 8.4;
  const gateHalf = 1.9;
  const wallH = wallTop - platformY;
  const wallDepth = 3.4;
  const wallZ = -1.9;

  [-1, 1].forEach((s) => {
    const w = 12.4 - gateHalf;
    const seg = brickBox(w, wallH, wallDepth, brickMat);
    seg.position.set(s * (gateHalf + w / 2), platformY + wallH / 2, wallZ);
    seg.castShadow = true;
    seg.receiveShadow = true;
    scene.add(seg);
  });

  // 门楣上方的墙（一直砌到墙顶，避免门洞上方透空）
  const lintelH = wallTop - (platformY + 4.55);
  const lintel = brickBox(gateHalf * 2, lintelH, wallDepth, brickMat);
  lintel.position.set(0, platformY + 4.55 + lintelH / 2, wallZ);
  lintel.castShadow = true;
  lintel.receiveShadow = true;
  scene.add(lintel);

  // 门洞石框
  const jambGeo = new THREE.BoxGeometry(0.42, 4.55, 0.5);
  [-1, 1].forEach((s) => {
    const jamb = new THREE.Mesh(jambGeo, stoneMat);
    jamb.position.set(s * (gateHalf - 0.21), platformY + 2.27, wallZ + wallDepth / 2 + 0.04);
    jamb.castShadow = true;
    jamb.receiveShadow = true;
    scene.add(jamb);
  });
  const lintelStone = new THREE.Mesh(new THREE.BoxGeometry(gateHalf * 2 + 0.5, 0.46, 0.62), stoneMat);
  lintelStone.position.set(0, platformY + 4.72, wallZ + wallDepth / 2 + 0.06);
  lintelStone.castShadow = true;
  scene.add(lintelStone);

  // 门洞上方的弧形石。
const archRing = new THREE.Mesh(
    new THREE.TorusGeometry(gateHalf + 0.08, 0.18, 8, 30, Math.PI),
    stoneMat,
  );
  archRing.position.set(0, platformY + 4.9, wallZ + wallDepth / 2 + 0.06);
  archRing.scale.y = 0.55;
  archRing.castShadow = true;
  scene.add(archRing);

  // 墩台
  [-1, 1].forEach((s) => {
    const pier = brickBox(1.3, wallH + 0.8, wallDepth + 1.1, brickDarkMat);
    pier.position.set(s * 3.15, platformY + (wallH + 0.8) / 2, wallZ + 0.2);
    pier.castShadow = true;
    pier.receiveShadow = true;
    scene.add(pier);
  });

  // 墙顶压顶。
const coping = brickBox(33, 0.28, wallDepth + 0.5, stoneDark, 3.6);
  coping.position.set(0, wallTop + 0.14, wallZ);
  coping.receiveShadow = true;
  coping.castShadow = true;
  scene.add(coping);

  /* ---------------------------------------------------------------- 。*/

  const doorW = gateHalf - 0.004;
  const doorH = 4.5;
  const doorY = platformY + doorH / 2;

  const doorMat = new THREE.MeshStandardMaterial({
    map: woodTex.map,
    color: 0x8a5a38,
    roughness: 0.78,
    metalness: 0.05,
  });

  const makeDoor = (side: -1 | 1) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * gateHalf, platformY, wallZ + wallDepth / 2 - 0.16);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, 0.16), doorMat);
    panel.position.set(-side * (doorW / 2), doorH / 2, 0);
    panel.castShadow = true;
    panel.receiveShadow = true;
    pivot.add(panel);

    // 竖向木板。
for (let i = 1; i < 6; i++) {
      const groove = new THREE.Mesh(new THREE.BoxGeometry(0.02, doorH - 0.2, 0.02), ironMat);
      groove.position.set(-side * ((doorW / 6) * i), doorH / 2, 0.09);
      pivot.add(groove);
    }

    // 铁箍
    [0.72, doorH * 0.52, doorH - 0.72].forEach((y) => {
      const band = new THREE.Mesh(new THREE.BoxGeometry(doorW - 0.06, 0.12, 0.05), ironMat);
      band.position.set(-side * (doorW / 2), y, 0.1);
      pivot.add(band);
    });

    // 门钉
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 5; c++) {
        const stud = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), brassMat);
        stud.position.set(
          -side * (0.3 + c * ((doorW - 0.6) / 4)),
          0.62 + r * ((doorH - 1.2) / 5),
          0.1,
        );
        pivot.add(stud);
      }
    }

    // 门环
    const ringPlate = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.03, 14), brassMat);
    ringPlate.rotation.x = Math.PI / 2;
    ringPlate.position.set(-side * (doorW - 0.45), doorH * 0.52, 0.12);
    pivot.add(ringPlate);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.022, 8, 20), brassMat);
    ring.position.set(-side * (doorW - 0.45), doorH * 0.52 - 0.13, 0.14);
    ring.castShadow = true;
    pivot.add(ring);

    scene.add(pivot);
    return pivot;
  };

  const doorL = makeDoor(-1);
  const doorR = makeDoor(1);

  /* ---------------------------------------------------------------- 匾额 / 灯笼 / 石狮 */

  const signCanvas = makeSignCanvas();
  const signTex = makeTexture(signCanvas);
  const signMat = new THREE.MeshStandardMaterial({
    map: signTex,
    roughness: 0.7,
    metalness: 0.1,
    emissive: new THREE.Color(0x2b2418),
    emissiveIntensity: 0.4,
  });
  const signBack = brickBox(4.0, 1.3, 0.16, darkWoodMat, 1.6);
  signBack.position.set(0, 6.05, 0.16);
  signBack.castShadow = true;
  scene.add(signBack);
  const signPlane = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 1.08), signMat);
  signPlane.position.set(0, 6.05, 0.25);
  scene.add(signPlane);
  const signFrame = new THREE.Mesh(new THREE.BoxGeometry(4.1, 1.4, 0.08), goldMat);
  signFrame.position.set(0, 6.05, 0.12);
  scene.add(signFrame);

  // 灯笼
  const lanternMat = new THREE.MeshStandardMaterial({
    color: 0xd8452f,
    emissive: new THREE.Color(0xff7a3c),
    emissiveIntensity: 0.85,
    roughness: 0.65,
  });
  [-1, 1].forEach((s) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.09, 0.09), ironMat);
    arm.position.set(s * 2.75, 5.05, 0.75);
    scene.add(arm);
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.5, 6), ironMat);
    chain.position.set(s * 3.15, 4.8, 0.75);
    scene.add(chain);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), lanternMat);
    body.scale.y = 0.86;
    body.position.set(s * 3.15, 4.24, 0.75);
    body.castShadow = true;
    scene.add(body);
    const capTop = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.08, 12), goldMat);
    capTop.position.set(s * 3.15, 4.54, 0.75);
    scene.add(capTop);
    const capBottom = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.08, 12), goldMat);
    capBottom.position.set(s * 3.15, 3.94, 0.75);
    scene.add(capBottom);
    const tassel = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.3, 8), lanternMat);
    tassel.position.set(s * 3.15, 3.8, 0.75);
    scene.add(tassel);
  });

  // 石狮
  [-1, 1].forEach((s) => {
    const lion = buildLion(s * 3.95, 6.3, stoneMat, stoneDark);
    lion.position.y = 0;
    lion.scale.setScalar(0.86);
    lion.rotation.y = s * -0.16;
    scene.add(lion);
  });

  /* ---------------------------------------------------------------- 重檐屋顶 */

  const lowerEave = wallTop + 1.15;
  const lowerRoof = new THREE.Group();
  const lowerFront = buildRoofSurface(12.6, 4.0, lowerEave, 1.55, 1.15, roofMat, 1);
  lowerRoof.add(lowerFront.mesh);
  const lowerBack = buildRoofSurface(12.6, 4.0, lowerEave, 1.55, 1.15, roofMat, -1);
  lowerRoof.add(lowerBack.mesh);
  lowerRoof.add(buildEaveTrim(12.6, 4.0, lowerEave, 1.15, 1, stoneDark));
  lowerRoof.add(buildEaveTrim(12.6, 4.0, lowerEave, 1.15, -1, stoneDark));

  // 两侧坡（简化成三角面）
  [-1, 1].forEach((s) => {
    const geo = new THREE.BufferGeometry();
    const hw = 11.4;
    const rh = lowerFront.ridgeHalf;
    const zf = 4.0;
    const pts = new Float32Array([
      s * rh, lowerEave + 1.55, 0,
      s * hw, lowerEave + 0.1, zf,
      s * hw, lowerEave + 0.1, -zf,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1]), 2));
    geo.setIndex(s > 0 ? [0, 1, 2] : [0, 2, 1]);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, roofMat);
    m.castShadow = true;
    lowerRoof.add(m);
  });

  lowerRoof.add(buildRidge(lowerFront.ridgeHalf * 2 + 0.4, lowerEave + 1.55, stoneDark, goldMat));
  lowerRoof.add(buildDougong(12.2, lowerEave - 0.5, 1.78, darkWoodMat));
  lowerRoof.position.z = wallZ;
  scene.add(lowerRoof);

  /* ---------------- 城楼：重檐歇山楼阁（城台之上） ----------------
     结构参照正阳门/西安城门：城台 → 平座 → 檐柱一圈（周围廊）→ 额枋、平板枋
     → 斗拱 → 下檐（腰檐）→ 上层柱与格扇 → 上檐歇山 → 正脊吻兽。 */
  const pavY = wallTop + 0.12;
  const bayW = 2.08;
  const halfW1 = bayW * 2.5; // 面阔五间
  const depth1 = 2.55; // 进深三间（约 5.1）
  const colH1 = 2.75;
  const colTop = pavY + colH1;

  const towerWood = new THREE.MeshStandardMaterial({ color: 0x6d4128, roughness: 0.68 });
  const columnMat = new THREE.MeshStandardMaterial({ color: 0x7c3a26, roughness: 0.55 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x5c3320, roughness: 0.62 });
  const latticeMat = new THREE.MeshStandardMaterial({
    color: 0xe6d7b4,
    roughness: 0.9,
    emissive: 0xffd9a0,
    emissiveIntensity: 0.1,
  });
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x6d4128, roughness: 0.72 });

  // 台明（石质台基）
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(11.4, 0.16, 6.1), stoneMat);
  plinth.position.set(0, pavY - 0.08, wallZ);
  plinth.receiveShadow = true;
  plinth.castShadow = true;
  scene.add(plinth);

  // 楼板
  const deck = new THREE.Mesh(new THREE.BoxGeometry(10.9, 0.2, 5.7), towerWood);
  deck.position.set(0, pavY + 0.08, wallZ);
  deck.castShadow = true;
  deck.receiveShadow = true;
  scene.add(deck);

  // 柱础
  const baseGeo = new THREE.CylinderGeometry(0.2, 0.24, 0.14, 12);
  const colGeo = new THREE.CylinderGeometry(0.135, 0.155, colH1, 12);

  const colXs: number[] = [];
  for (let i = -2; i <= 2; i++) colXs.push(i * bayW);
  const colZs = [-depth1, depth1];

  // 一圈檐柱（前后各 5 根，两侧各 1 根）
  colXs.forEach((x) => {
    colZs.forEach((z) => {
      const b = new THREE.Mesh(baseGeo, stoneMat);
      b.position.set(x, pavY + 0.25, wallZ + z);
      scene.add(b);
      const col = new THREE.Mesh(colGeo, columnMat);
      col.position.set(x, pavY + colH1 / 2 + 0.28, wallZ + z);
      col.castShadow = true;
      scene.add(col);
    });
  });
  [-1, 1].forEach((sx) => {
    [-1, 1].forEach((sz) => {
      const b = new THREE.Mesh(baseGeo, stoneMat);
      b.position.set(sx * halfW1, pavY + 0.25, wallZ + sz * (depth1 - 0.02));
      scene.add(b);
    });
  });

  // 栏杆：檐柱之间的寻杖栏杆
  {
    const railPost = new THREE.BoxGeometry(0.09, 0.86, 0.09);
    const railBar = new THREE.BoxGeometry(bayW - 0.2, 0.07, 0.07);
    colZs.forEach((z) => {
      for (let i = 0; i < 4; i++) {
        const cx = -halfW1 + bayW * (i + 0.5);
        const p = new THREE.Mesh(railPost, columnMat);
        p.position.set(cx, pavY + 0.55, wallZ + z);
        scene.add(p);
        [0.5, 0.88].forEach((oy) => {
          const bar = new THREE.Mesh(railBar, columnMat);
          bar.position.set(cx, pavY + 0.18 + oy, wallZ + z);
          scene.add(bar);
        });
      }
    });
  }

  // 额枋 + 平板枋（四面成圈）
  {
    const archFront = new THREE.Mesh(new THREE.BoxGeometry(halfW1 * 2 + 0.3, 0.26, 0.2), beamMat);
    archFront.position.set(0, colTop - 0.02, wallZ + depth1);
    scene.add(archFront);
    const archBack = archFront.clone();
    archBack.position.z = wallZ - depth1;
    scene.add(archBack);
    [-1, 1].forEach((sx) => {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, depth1 * 2), beamMat);
      side.position.set(sx * halfW1, colTop - 0.02, wallZ);
      scene.add(side);
    });
    const plateF = new THREE.Mesh(new THREE.BoxGeometry(halfW1 * 2 + 0.5, 0.1, 0.3), beamMat);
    plateF.position.set(0, colTop + 0.14, wallZ + depth1);
    scene.add(plateF);
    const plateB = plateF.clone();
    plateB.position.z = wallZ - depth1;
    scene.add(plateB);
    [-1, 1].forEach((sx) => {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, depth1 * 2), beamMat);
      side.position.set(sx * halfW1, colTop + 0.14, wallZ);
      scene.add(side);
    });
  }


  // 下檐：四面围合的腰檐（中间留出上层柱位）
  const lowerEaveY = colTop + 0.42;
  const skirt = buildSkirtRoof(3.5, 2.15, 6.85, 4.05, lowerEaveY, 1.06, roofMat, stoneDark);
  skirt.position.z = wallZ;
  scene.add(skirt);

  // 上层：柱 + 格扇墙
  const upperW = 3.45;
  const upperD = 2.1;
  const upperBase = lowerEaveY + 0.72;
  const upperH = 2.05;
  const upperTop = upperBase + upperH;

  const upColGeo = new THREE.CylinderGeometry(0.13, 0.145, upperH, 12);
  [-1, 1].forEach((sx) => {
    [-1, 1].forEach((sz) => {
      const col = new THREE.Mesh(upColGeo, columnMat);
      col.position.set(sx * upperW, upperBase + upperH / 2, wallZ + sz * upperD);
      col.castShadow = true;
      scene.add(col);
    });
  });

  // 上层格扇：前后面各三间，两侧实墙
  const panelW = (upperW * 2) / 3;
  const panelH = upperH - 0.36;
  [-1, 1].forEach((sz) => {
    for (let i = 0; i < 3; i++) {
      const cx = -upperW + panelW * (i + 0.5);
      const zf = wallZ + sz * upperD;
      // 边框
      const frame = new THREE.Mesh(new THREE.BoxGeometry(panelW - 0.06, panelH, 0.06), towerWood);
      frame.position.set(cx, upperBase + upperH / 2, zf);
      scene.add(frame);
      // 上段透光纸
      const paperH = panelH * 0.6;
      const paper = new THREE.Mesh(new THREE.BoxGeometry(panelW - 0.18, paperH, 0.03), latticeMat);
      paper.position.set(cx, upperBase + upperH / 2 + panelH * 0.19, zf + sz * 0.04);
      scene.add(paper);
      // 棂条 5 竖 2 横
      for (let k = -2; k <= 2; k++) {
        const mull = new THREE.Mesh(new THREE.BoxGeometry(0.03, paperH, 0.03), towerWood);
        mull.position.set(cx + k * (panelW - 0.24) / 5, upperBase + upperH / 2 + panelH * 0.19, zf + sz * 0.05);
        scene.add(mull);
      }
      for (let k = -1; k <= 1; k++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(panelW - 0.18, 0.028, 0.03), towerWood);
        bar.position.set(cx, upperBase + upperH / 2 + panelH * 0.19 + k * (paperH / 3.4), zf + sz * 0.05);
        scene.add(bar);
      }
      // 下段裙板
      const skirtPanel = new THREE.Mesh(
        new THREE.BoxGeometry(panelW - 0.16, panelH * 0.34, 0.04),
        skirtMat,
      );
      skirtPanel.position.set(cx, upperBase + upperH / 2 - panelH * 0.3, zf + sz * 0.03);
      scene.add(skirtPanel);
    }
  });
  // 两侧山墙（暗红木板）
  [-1, 1].forEach((sx) => {
    const wallSide = new THREE.Mesh(new THREE.BoxGeometry(0.08, upperH, upperD * 2), skirtMat);
    wallSide.position.set(sx * upperW, upperBase + upperH / 2, wallZ);
    scene.add(wallSide);
  });

  // 上层额枋与斗拱
  const upArchF = new THREE.Mesh(new THREE.BoxGeometry(upperW * 2 + 0.2, 0.22, 0.16), beamMat);
  upArchF.position.set(0, upperTop - 0.02, wallZ + upperD);
  scene.add(upArchF);
  const upArchB = upArchF.clone();
  upArchB.position.z = wallZ - upperD;
  scene.add(upArchB);

  // 匾额（挂在正面两柱之间）
  const towerSignCanvas = canvas2d(512, 168);
  {
    const c = towerSignCanvas.ctx;
    c.fillStyle = '#2a1d12';
    c.fillRect(0, 0, 512, 168);
    c.strokeStyle = 'rgba(206,168,104,0.9)';
    c.lineWidth = 6;
    c.strokeRect(8, 8, 496, 152);
    c.fillStyle = '#eadcc0';
    c.font = `600 76px ${SERIF}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('时之画廊', 256, 90);
  }
  const towerSign = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 0.68),
    new THREE.MeshStandardMaterial({
      map: makeTexture(towerSignCanvas.canvas),
      roughness: 0.6,
      metalness: 0.1,
    }),
  );
  towerSign.position.set(0, upperBase + upperH - 0.5, wallZ + upperD + 0.12);
  scene.add(towerSign);

  // 上檐：歇山顶
  const upperEave = upperTop + 0.36;
  const upRoof = buildGableRoof(4.95, 3.35, upperEave, 1.62, 1.0, roofMat, stoneDark, goldMat);
  upRoof.position.z = wallZ;
  scene.add(upRoof);

  /* ---------------------------------------------------------------- 庭院陈设 */

  const treeSpots: Array<[number, number, number, number]> = [
    [-9.6, 4.2, 1.05, 11],
    [10.2, 3.6, 1.0, 12],
    [-14.5, 12, 0.9, 13],
    [15, 11, 0.9, 14],
    [-19, 22, 1.1, 15],
    [20, 21, 1.05, 16],
  ];
  for (const [x, z, sc, seed] of treeSpots) {
    scene.add(buildTree(x, z, sc, barkMat, leafMats, seed));
  }

  // 抱鼓石：须弥座 + 立起的鼓身 + 鼓钉，贴在大门两侧
  [-1, 1].forEach((s) => {
    const g = new THREE.Group();
    g.position.set(s * 2.45, platformY, 3.9);

    const base = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.24, 0.9), stoneDark);
    base.position.y = 0.12;
    base.castShadow = true;
    g.add(base);
    const mid = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.22, 0.74), stoneDark);
    mid.position.y = 0.34;
    mid.castShadow = true;
    g.add(mid);

    // 鼓身：立起来的圆鼓，轴向朝 X
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.2, 20), stoneMat);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0, 0.78, 0);
    drum.castShadow = true;
    g.add(drum);
    // 鼓面圆凸
    [-1, 1].forEach((d) => {
      const boss = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 10), stoneMat);
      boss.scale.set(0.28, 1, 1);
      boss.position.set(d * 0.11, 0.78, 0);
      g.add(boss);
    });
    // 鼓下的卷草托
    const curl = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.05, 6, 14, Math.PI), stoneMat);
    curl.position.set(0, 0.5, 0);
    curl.rotation.y = Math.PI / 2;
    curl.rotation.z = Math.PI;
    g.add(curl);
    scene.add(g);
  });

  /* ---------------------------------------------------------------- 长廊 */


  // 室内整体抬高到城门平台标高，和门外台阶衔。
const hall = new THREE.Group();
  hall.position.y = platformY;
  scene.add(hall);
  const zStart = -3.2;
  const endZ = -124;
  const corrLen = zStart - endZ;

  // 地面：黑色大理石，微反光
  const floor = new THREE.Mesh(
    planeMeters(new THREE.PlaneGeometry(ROOM.width, corrLen), ROOM.width, corrLen, 3.2),
    marbleFloorMat,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.001, (zStart + endZ) / 2);
  floor.receiveShadow = true;
  hall.add(floor);

  // 地毯
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(2.05, corrLen - 4), carpetMat);
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set(0, 0.012, (zStart + endZ) / 2 - 1);
  carpet.receiveShadow = true;
  hall.add(carpet);

  // 左墙（整面）
  const leftWall = brickBox(0.5, ROOM.spring, corrLen, marbleWallMat, 2.8);
  leftWall.position.set(-ROOM.wall - 0.25, ROOM.spring / 2, (zStart + endZ) / 2);
  leftWall.receiveShadow = true;
  leftWall.castShadow = true;
  hall.add(leftWall);

  // 右墙：开高窗
  const windowZ: number[] = [];
  for (let i = 0; i < 6; i++) windowZ.push(-15 - i * 12);
  const winW = 1.55;
  const sillY = 1.15;
  const headY = 3.55;

  const wallSegments: Array<[number, number]> = [];
  let cursor = zStart;
  for (const zc of windowZ) {
    const a = zc + winW / 2;
    const b = zc - winW / 2;
    wallSegments.push([cursor, a]);
    cursor = b;
  }
  wallSegments.push([cursor, endZ]);

  for (const [za, zb] of wallSegments) {
    const len = Math.abs(zb - za);
    if (len < 0.02) continue;
    const seg = brickBox(0.5, ROOM.spring, len, marbleWallMat, 2.8);
    seg.position.set(ROOM.wall + 0.25, ROOM.spring / 2, (za + zb) / 2);
    seg.receiveShadow = true;
    seg.castShadow = true;
    hall.add(seg);
  }

  // 窗下。 窗上。
for (const zc of windowZ) {
    const below = brickBox(0.5, sillY, winW, marbleWallMat, 2.8);
    below.position.set(ROOM.wall + 0.25, sillY / 2, zc);
    below.receiveShadow = true;
    below.castShadow = true;
    hall.add(below);

    const above = brickBox(0.5, ROOM.spring - headY, winW, marbleWallMat, 2.8);
    above.position.set(ROOM.wall + 0.25, (headY + ROOM.spring) / 2, zc);
    above.receiveShadow = true;
    above.castShadow = true;
    hall.add(above);
  }

  // 窗外：真正的室外背景（天。+ 远处树线），透过窗洞能看到，而不是贴一张亮。
const viewTex = makeTexture(makeWindowViewCanvas());
  viewTex.wrapS = THREE.RepeatWrapping;
  viewTex.wrapT = THREE.ClampToEdgeWrapping;
  viewTex.repeat.set(6, 1);
  const viewMat = new THREE.MeshBasicMaterial({ map: viewTex, color: 0x93a5b8, fog: false });
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(corrLen, 9), viewMat);
  backdrop.position.set(ROOM.wall + 11, 4.2 + ROOM.floor, (zStart + endZ) / 2);
  backdrop.rotation.y = -Math.PI / 2;
  scene.add(backdrop);

  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xcfe0ee,
    transparent: true,
    opacity: 0.06,
    roughness: 0.18,
    metalness: 0.05,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mullionMat = new THREE.MeshStandardMaterial({ color: 0x3b2f24, roughness: 0.7 });

  const windowLights: THREE.PointLight[] = [];
  windowZ.forEach((zc, idx) => {
    // 石框
    const jambGeo = new THREE.BoxGeometry(0.24, headY - sillY + 0.3, 0.18);
    [-1, 1].forEach((s) => {
      const j = new THREE.Mesh(jambGeo, stoneMat);
      j.position.set(ROOM.wall + 0.02, (sillY + headY) / 2 + 0.05, zc + (s * (winW / 2 + 0.09)));
      j.castShadow = true;
      j.receiveShadow = true;
      hall.add(j);
    });
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, winW + 0.5), stoneMat);
    sill.position.set(ROOM.wall, sillY - 0.02, zc);
    sill.castShadow = true;
    hall.add(sill);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.16, winW + 0.3), stoneMat);
    head.position.set(ROOM.wall, headY + 0.08, zc);
    hall.add(head);

    // 拱顶石券：贴在窗楣上方的半圆券脸
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(winW / 2 + 0.06, 0.07, 6, 20, Math.PI),
      stoneMat,
    );
    ring.position.set(ROOM.wall + 0.02, headY + 0.16, zc);
    ring.rotation.y = Math.PI / 2;
    ring.scale.set(1, 0.55, 1);
    hall.add(ring);

    // 玻璃：真正透光，窗外景色来。backdrop
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(winW - 0.05, headY - sillY), glassMat);
    glass.position.set(ROOM.wall + 0.28, (sillY + headY) / 2, zc);
    glass.rotation.y = -Math.PI / 2;
    hall.add(glass);

    // 木窗棂：两竖一。
[-0.34, 0.34].forEach((ox) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, headY - sillY, 0.05), mullionMat);
      bar.position.set(ROOM.wall + 0.26, (sillY + headY) / 2, zc + ox * winW);
      hall.add(bar);
    });
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, winW), mullionMat);
    cross.position.set(ROOM.wall + 0.26, (sillY + headY) / 2, zc);
    hall.add(cross);

    // 窗台溢出的光
    if (idx % 2 === 0) {
      const pl = new THREE.PointLight(0xfff0d2, 26, 16, 1.9);
      pl.position.set(ROOM.wall - 0.55, 2.2, zc);
      hall.add(pl);
      windowLights.push(pl);
    }
  });

  // 平顶：木板 + 横梁。拱顶改为水平木板天花，横梁两端落在墙顶托石上
  const ceilY = ROOM.spring;
  const ceiling = new THREE.Mesh(
    planeMeters(
      new THREE.PlaneGeometry(ROOM.width + 0.4, corrLen),
      ROOM.width + 0.4,
      corrLen,
      1.8,
    ),
    plankMat,
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, ceilY, (zStart + endZ) / 2);
  ceiling.receiveShadow = true;
  hall.add(ceiling);

  // 入口上方封口：天花到门洞上沿之间补一段墙，否则从门外往上看会透到天空。
  const entryH = Math.max(0.25, ceilY - 4.5);
  const entryHead = brickBox(ROOM.width + 1.4, entryH, 0.42, marbleWallMat, 2.8);
  entryHead.position.set(0, 4.5 + entryH / 2, zStart - 0.18);
  entryHead.castShadow = true;
  entryHead.receiveShadow = true;
  hall.add(entryHead);

  // 横梁 + 托石
  const corbel = buildCorbel(stoneMat);
  for (let z = zStart - 1.4; z > endZ; z -= 3.6) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(ROOM.width + 0.34, 0.26, 0.24),
      darkWoodMat,
    );
    beam.position.set(0, ceilY - 0.14, z);
    beam.castShadow = true;
    beam.receiveShadow = true;
    hall.add(beam);

    [-1, 1].forEach((s) => {
      const c = corbel.clone();
      c.position.set(s * (ROOM.wall - 0.02), ceilY - 0.89, z);
      c.scale.x = -s;
      hall.add(c);
    });
  }

  // 踢脚。
[-1, 1].forEach((s) => {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, corrLen), stoneDark);
    skirt.position.set(s * (ROOM.wall - 0.02), 0.11, (zStart + endZ) / 2);
    skirt.receiveShadow = true;
    hall.add(skirt);
  });

  /* ---------------------------------------------------------------- 画作 */

  const artHits: THREE.Mesh[] = [];
  const frameGold = new THREE.MeshStandardMaterial({
    color: 0xb08343,
    metalness: 0.62,
    roughness: 0.4,
  });
  const frameWood = new THREE.MeshStandardMaterial({
    color: 0x4b3324,
    roughness: 0.55,
    metalness: 0.1,
  });

  const artZ = (i: number) => -(ROOM.first + i * ROOM.gap);

  items.forEach((item, i) => {
    const z = artZ(i);
    const group = new THREE.Group();
    group.position.set(-ROOM.wall + 0.06, 0, z);

    const fw = 1.42;
    const fh = 1.84;
    const frameMat = i % 2 === 0 ? frameGold : frameWood;

    // 外框：四条边
    const bar = 0.075;
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.1, bar, fw + bar * 2), frameMat);
    top.position.set(0, ROOM.eye + fh / 2, 0);
    top.castShadow = true;
    group.add(top);
    const bottom = top.clone();
    bottom.position.y = ROOM.eye - fh / 2;
    group.add(bottom);
    [-1, 1].forEach((s) => {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.1, fh, bar), frameMat);
      side.position.set(0, ROOM.eye, s * (fw / 2 + bar / 2));
      side.castShadow = true;
      group.add(side);
    });

    // 内衬（卡纸）
    const matte = new THREE.Mesh(
      new THREE.PlaneGeometry(fw + 0.02, fh + 0.02),
      new THREE.MeshStandardMaterial({ color: 0xe8dcc2, roughness: 0.95 }),
    );
    matte.rotation.y = Math.PI / 2;
    matte.position.set(0.035, ROOM.eye, 0);
    group.add(matte);

    // 画面（海报）
    const posterTex = makeTexture(makePosterCanvas(item));
    const poster = new THREE.Mesh(
      new THREE.PlaneGeometry(fw - 0.14, fh - 0.14),
      new THREE.MeshStandardMaterial({
        map: posterTex,
        roughness: 0.86,
        color: 0xd9d2c2,
        emissive: new THREE.Color(0xffffff),
        emissiveMap: posterTex,
        emissiveIntensity: 0.06,
      }),
    );
    poster.rotation.y = Math.PI / 2;
    poster.position.set(0.052, ROOM.eye, 0);
    poster.userData.index = i;
    group.add(poster);
    artHits.push(poster);

    // 封面异步载入后，重绘海报贴图
    if (item.cover) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        const next = makePosterCanvas(item, img);
        const target = posterTex.image as HTMLCanvasElement;
        const tctx = target?.getContext('2d');
        if (!tctx) return;
        tctx.clearRect(0, 0, target.width, target.height);
        tctx.drawImage(next, 0, 0, target.width, target.height);
        posterTex.needsUpdate = true;
      };
      img.src = item.cover;
    }

    // 画灯：壁座 + 短臂 + 向下开口的半圆灯罩，压在画框上沿
    const lampY = ROOM.eye + fh / 2 + 0.26;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.12), brassMat);
    plate.position.set(0.03, lampY, 0);
    group.add(plate);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.22, 6), brassMat);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(0.14, lampY + 0.06, 0);
    group.add(arm);

    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.13, 0.1, 14, 1, true),
      brassMat,
    );
    shade.material = (brassMat as THREE.MeshStandardMaterial).clone();
    shade.material.side = THREE.DoubleSide;
    shade.position.set(0.24, lampY + 0.04, 0);
    group.add(shade);
    const shadeTop = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 12), brassMat);
    shadeTop.position.set(0.24, lampY + 0.1, 0);
    group.add(shadeTop);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), billetGlassMat);
    bulb.position.set(0.24, lampY - 0.02, 0);
    group.add(bulb);
    if (i % 3 === 0) {
      const accent = new THREE.PointLight(0xffdcb4, 5, 2.6, 1.9);
      accent.position.set(0.45, lampY - 0.06, 0);
      group.add(accent);
    }

    // 展签
    const plaqueTex = makeTexture(makePlaqueCanvas(item));
    const plaque = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.165),
      new THREE.MeshStandardMaterial({
        map: plaqueTex,
        roughness: 0.6,
        metalness: 0.15,
      }),
    );
    plaque.rotation.y = Math.PI / 2;
    plaque.position.set(0.04, ROOM.eye - fh / 2 - 0.22, 0);
    group.add(plaque);

    // 画框投影
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 1.25),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 }),
    );
    shadow.rotation.y = Math.PI / 2;
    shadow.position.set(0.005, ROOM.eye + 0.06, 0.02);
    group.add(shadow);

    hall.add(group);
  });

  // 长椅：每 4 幅一。
items.forEach((_, i) => {
    if (i % 4 !== 2) return;
    const bench = buildBench(woodMat, leatherMat, ironMat);
    bench.position.set(-ROOM.wall + 0.62, 0, artZ(i) + ROOM.gap / 2);
    hall.add(bench);
  });

  /* ---------------------------------------------------------------- 吊灯 */

  for (let z = zStart - 3.2; z > endZ + 4; z -= 10.8) {
    const ch = buildChandelier(glassMat, brassMat, ironMat);
    ch.position.set(0, ceilY - 0.42, z);
    hall.add(ch);
    const pl = new THREE.PointLight(0xffe0bd, 26, 12, 1.9);
    pl.position.set(0, ceilY - 0.66, z);
    hall.add(pl);
  }

  return {
    doorL,
    doorR,
    artHits,
    paintZ: artZ,
    lastPaintZ: artZ(Math.max(0, items.length - 1)),
    endZ,
    groundY: 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  数据 →画。                                                              */
/* -------------------------------------------------------------------------- */

function buildFrames(data: ArcData): FrameItem[] {
  const posts = [...data.posts].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  const out: FrameItem[] = [];

  posts.forEach((post, idx) => {
    const cats = post.categories?.length ? post.categories : ['随笔'];
    const kicker = post.series ? 'ARCHIVE SERIES' : 'ARCHIVE';
    const base = {
      dateLabel: post.dateLabel,
      words: post.words,
      desc: post.description,
      categories: cats,
      postIndex: idx,
    };

    if (post.series) {
      out.push({
        ...base,
        key: `series-${post.series.slug}`,
        title: post.series.title,
        kicker,
        desc: `系列（${post.series.chapters.length} 章 · ${post.series.words} 字）`,
        url: post.url,
        cover: post.cover,
        chapters: post.series.chapters,
      });

      ([] as typeof post.series.chapters).forEach((ch) => {
        out.push({
          ...base,
          key: `chapter-${post.series!.slug}-${ch.order}`,
          title: ch.title,
          kicker: `${post.series!.title} · 第 ${String(ch.order).padStart(2, '0')} 章`,
          words: ch.words,
          desc: `${post.series!.title} 系列的其中一章`,
          url: ch.url,
          chapter: ch.order,
          cover: post.cover,
        });
      });
    } else {
      out.push({
        ...base,
        key: `post-${post.slug}`,
        title: post.title,
        kicker,
        url: post.url,
        cover: post.cover,
      });
    }
  });

  return out;
}

function readData(): ArcData | null {
  const el = document.querySelector<HTMLScriptElement>('#arc-data');
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as ArcData;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  相机                                                                      */
/* -------------------------------------------------------------------------- */

interface Pose {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    pos: a.pos.clone().lerp(b.pos, t),
    look: a.look.clone().lerp(b.look, t),
    fov: lerp(a.fov, b.fov, t),
  };
}

function makeCurve(keys: Array<{ p: number; pose: Pose }>) {
  return (p: number): Pose => {
    if (p <= keys[0].p) return keys[0].pose;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (p <= b.p) {
        const t = (p - a.p) / Math.max(1e-6, b.p - a.p);
        return lerpPose(a.pose, b.pose, easeInOut(t));
      }
    }
    return keys[keys.length - 1].pose;
  };
}

const pose = (px: number, py: number, pz: number, lx: number, ly: number, lz: number, fov: number): Pose => ({
  pos: new THREE.Vector3(px, py, pz),
  look: new THREE.Vector3(lx, ly, lz),
  fov,
});

/* -------------------------------------------------------------------------- */
/*  启动                                                                      */
/* -------------------------------------------------------------------------- */

let activeCleanup: (() => void) | null = null;

async function init(root: HTMLElement) {
  const data = readData();
  if (!data) return;

  const sceneEl = root.querySelector<HTMLElement>('[data-arc-scene]');
  const stage = root.querySelector<HTMLElement>('[data-arc-stage]');
  const canvas = root.querySelector<HTMLCanvasElement>('[data-arc-canvas]');
  const loader = root.querySelector<HTMLElement>('[data-arc-loader]');
  const intro = root.querySelector<HTMLElement>('[data-arc-intro]');
  const inspectEl = root.querySelector<HTMLElement>('[data-arc-inspect]');
  const rail = root.querySelector<HTMLElement>('[data-arc-rail]');
  const railProgress = root.querySelector<HTMLElement>('[data-arc-rail-progress]');
  const enterBtn = root.querySelector<HTMLElement>('[data-arc-enter]');
  if (!sceneEl || !stage || !canvas) return;

  const items = buildFrames(data);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMobile = matchMedia('(max-width: 760px)').matches;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
  } catch {
    root.classList.add('is-no-webgl');
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9e4ef);
  scene.fog = new THREE.FogExp2(0xd8d3c6, 0.021);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.08, 320);
  camera.position.set(1.2, 1.72, 15.6);

  // 环境光照（金属反射不至于全黑。
const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0xdfe7ef);
  scene.environment = pmrem.fromScene(envScene, 0.05).texture;
  scene.environmentIntensity = 0.22;
  pmrem.dispose();

  const world = buildWorld(scene, items);

  /* ------------------------------------------------------------- 相机路径 */

  const portrait = () => window.innerWidth / Math.max(1, window.innerHeight) < 0.92;
  const lastZ = world.lastPaintZ;
  const browseStartZ = -3.0;
  const browseEndZ = lastZ - 4.2;

  const gateCurve = makeCurve([
    { p: 0, pose: pose(1.2, 2.75, 22.6, 0.2, 5.7, -1, 50) },
    { p: 0.06, pose: pose(0.95, 2.3, 14.2, 0.1, 3.9, -2, 50) },
    { p: 0.12, pose: pose(0.45, 2.05, 6.0, 0, 3.4, -4, 54) },
    { p: 0.18, pose: pose(0.0, 2.5, 1.1, 0, 2.9, -8, 56) },
    { p: 0.23, pose: pose(-0.45, ROOM.eye + ROOM.floor, -1.6, -1.6, 1.66 + ROOM.floor, -6.4, 58) },
  ]);

  const browsePose = (cz: number, p: number): Pose => {
    if (portrait()) {
      return pose(0.92, ROOM.eye + ROOM.floor, cz, -ROOM.wall - 3.6, ROOM.eye + ROOM.floor, cz - 2.8, 60);
    }
    const drift = Math.sin(p * 6.2) * 0.1;
    return pose(
      0.46 + drift,
      ROOM.eye + ROOM.floor,
      cz,
      -ROOM.wall - 2.6,
      ROOM.eye + ROOM.floor - 0.04,
      cz - 3.0,
      56,
    );
  };

  const gateEndPose = browsePose(browseStartZ, 0.24);

  const poseAt = (p: number): Pose => {
    if (p < 0.24) return gateCurve(p);
    const t = smoothstep(0.24, 1, p);
    const cz = lerp(browseStartZ, browseEndZ, t);
    return browsePose(cz, p);
  };

  const inspectPose = (i: number): Pose => {
    const z = world.paintZ(i);
    if (portrait()) {
      return pose(-ROOM.wall + 3.6, ROOM.eye + ROOM.floor, z, -ROOM.wall + 0.18, 1.12 + ROOM.floor, z, 50);
    }
    return pose(-ROOM.wall + 4.4, ROOM.eye + ROOM.floor, z, -ROOM.wall + 2.85, 1.52 + ROOM.floor, z, 44);
  };

  /* ------------------------------------------------------------- 状。*/

  let progress = 0;
  let smooth = 0;
  let entered = false;
  let inspecting = -1;
  let hovered = -1;
  let inspectBlend = 0;
  let pointerX = 0;
  let pointerY = 0;
  let camPose: Pose = poseAt(0);
  let inspectCam: Pose | null = null;
  let visible = true;
  let raf = 0;
  let lastTime = performance.now();
  let ready = false;

  const camPos = camPose.pos.clone();
  const camLook = camPose.look.clone();
  let camFov = camPose.fov;

  /* ------------------------------------------------------------- 滚动 */

  const setTravel = () => {
    const vh = Math.round(
      isMobile ? clamp(120 + items.length * 26, 200, 420) : clamp(140 + items.length * 30, 240, 520),
    );
    sceneEl.style.setProperty('--arc-travel', `${vh}svh`);
    sceneEl.style.height = `${vh}svh`;
  };
  setTravel();

  const readProgress = () => {
    const rect = sceneEl.getBoundingClientRect();
    const total = sceneEl.offsetHeight - window.innerHeight;
    progress = total > 0 ? clamp(-rect.top / total, 0, 1) : 0;
  };

  const scrollToProgress = (p: number) => {
    const total = sceneEl.offsetHeight - window.innerHeight;
    window.scrollTo({ top: p * total, behavior: 'smooth' });
  };

  /* ------------------------------------------------------------- 悬停高亮 */

  const hlMat = new THREE.MeshBasicMaterial({
    color: 0xffcf8a,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const highlight = new THREE.Mesh(new THREE.PlaneGeometry(1.34, 1.7), hlMat);
  highlight.rotation.y = Math.PI / 2;
  highlight.visible = false;
  scene.add(highlight);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const pick = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(world.artHits, false)[0];
    if (!hit) return -1;
    return Number(hit.object.userData.index ?? -1);
  };

  /* ------------------------------------------------------------- 特写 */

  const inspectKicker = root.querySelector<HTMLElement>('[data-arc-inspect-kicker]');
  const inspectTitle = root.querySelector<HTMLElement>('[data-arc-inspect-title]');
  const inspectMeta = root.querySelector<HTMLElement>('[data-arc-inspect-meta]');
  const inspectDesc = root.querySelector<HTMLElement>('[data-arc-inspect-desc]');
  const inspectSeries = root.querySelector<HTMLElement>('[data-arc-inspect-series]');
  const inspectLink = root.querySelector<HTMLAnchorElement>('[data-arc-inspect-link]');
  const inspectPrev = root.querySelector<HTMLButtonElement>('[data-arc-inspect-prev]');
  const inspectNext = root.querySelector<HTMLButtonElement>('[data-arc-inspect-next]');
  const inspectClose = root.querySelector<HTMLButtonElement>('[data-arc-inspect-close]');

  const fillInspect = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (inspectKicker) inspectKicker.textContent = `PAINTING NO. ${String(i + 1).padStart(2, '0')}`;
    if (inspectTitle) inspectTitle.textContent = item.title;
    if (inspectMeta) inspectMeta.textContent = `${item.dateLabel} · ${item.words} 字 · ${item.categories[0] ?? '随笔'}`;
    if (inspectDesc) inspectDesc.textContent = item.desc || '';
    if (inspectLink) inspectLink.href = item.url;
    if (inspectSeries) {
      inspectSeries.innerHTML = '';
      if (item.chapters?.length) {
        const list = document.createElement('ol');
        list.className = 'arc-inspect__chapters';
        item.chapters.forEach((ch) => {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = ch.url;
          a.textContent = `${String(ch.order).padStart(2, '0')} · ${ch.title}`;
          li.appendChild(a);
          list.appendChild(li);
        });
        inspectSeries.appendChild(list);
      }
    }
    if (inspectPrev) inspectPrev.disabled = i <= 0;
    if (inspectNext) inspectNext.disabled = i >= items.length - 1;
  };

  const openInspect = (i: number) => {
    if (i < 0 || i >= items.length) return;
    const first = inspecting < 0;
    inspecting = i;
    fillInspect(i);
    inspectCam = inspectPose(i);
    if (inspectEl) inspectEl.hidden = false;
    stage.classList.add('is-inspecting');
    document.documentElement.classList.add('arc-noscroll');
    if (first) inspectTitle?.focus?.({ preventScroll: true });
    // 换画时给铜牌一次淡入位移动画（移除再强制回流后重新加上）
    const card = root.querySelector<HTMLElement>('[data-arc-inspect-card]');
    if (card) {
      card.classList.remove('is-swap');
      void card.offsetWidth;
      card.classList.add('is-swap');
    }
  };

  /** 反解 smoothstep，把「目标相机 z」换算成滚动进度 */
  const progressForZ = (cz: number) => {
    const t = clamp((browseStartZ - cz) / Math.max(0.001, browseStartZ - browseEndZ), 0, 1);
    let lo = 0.24;
    let hi = 1;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (smoothstep(0.24, 1, mid) < t) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  // 相机沿 -Z 越过最后一幅画之后，才让场景淡出、交给文字列表
  const pastAt = clamp(progressForZ(lastZ - 0.8), 0.86, 0.995);

  let resumeScroll: number | null = null;
  let resumeTries = 0;

  const closeInspect = () => {
    const resumeAt = inspecting;
    inspecting = -1;
    inspectCam = null;
    if (inspectEl) inspectEl.hidden = true;
    stage.classList.remove('is-inspecting');
    document.documentElement.classList.remove('arc-noscroll');
    // 退出特写时回到「当前这一幅」的浏览位置，而不是最初进入的那幅
    if (resumeAt >= 0) {
      const target = clamp(world.paintZ(resumeAt) + 1.6, browseEndZ, browseStartZ);
      const total = sceneEl.offsetHeight - window.innerHeight;
      resumeScroll = progressForZ(target) * Math.max(0, total);
      resumeTries = 0;
    }
  };

  const stepInspect = (dir: number) => {
    if (inspecting < 0) return;
    const next = clamp(inspecting + dir, 0, items.length - 1);
    if (next === inspecting) return;
    openInspect(next);
  };

  /* ------------------------------------------------------------- 事件 */

  const onScroll = () => readProgress();
  const onPointerMove = (e: PointerEvent) => {
    pointerX = (e.clientX / window.innerWidth) * 2 - 1;
    pointerY = (e.clientY / window.innerHeight) * 2 - 1;
    if (e.pointerType === 'mouse') {
      hovered = pick(e.clientX, e.clientY);
      canvas.style.cursor = hovered >= 0 && hovered !== inspecting ? 'pointer' : '';
    }
  };
  const onPointerLeave = () => {
    hovered = -1;
    pointerX = 0;
    pointerY = 0;
    canvas.style.cursor = '';
  };
  const onClick = (e: PointerEvent) => {
    const hit = pick(e.clientX, e.clientY);
    if (inspecting >= 0) {
      // 特写里点到身边的另一幅，直接切过去
      if (hit >= 0 && hit !== inspecting) {
        openInspect(hit);
        return;
      }
      // 点在画与画之间的墙面：按左右半屏翻页
      const r = canvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / Math.max(1, r.width);
      if (fx < 0.3) stepInspect(-1);
      else if (fx > 0.52) stepInspect(1);
      return;
    }
    if (hit >= 0) {
      openInspect(hit);
      return;
    }
    // 还站在门外时，点画面任意处也推门
    if (smooth < 0.03) {
      entered = true;
      scrollToProgress(0.27);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (inspecting < 0) return;
    if (e.key === 'Escape') {
      closeInspect();
    } else if (e.key === 'ArrowLeft') {
      stepInspect(-1);
    } else if (e.key === 'ArrowRight') {
      stepInspect(1);
    }
  };

  const resize = () => {
    const w = stage.clientWidth || window.innerWidth;
    const h = stage.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };

  const onResize = () => {
    resize();
    readProgress();
  };

  const enter = () => {
    entered = true;
    scrollToProgress(0.27);
  };

  enterBtn?.addEventListener('click', enter);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKey);
  inspectClose?.addEventListener('click', closeInspect);
  inspectPrev?.addEventListener('click', () => stepInspect(-1));
  inspectNext?.addEventListener('click', () => stepInspect(1));

  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) visible = en.isIntersecting;
    },
    { threshold: 0 },
  );
  io.observe(stage);

  resize();
  readProgress();

  /* ------------------------------------------------------------- 主循。*/

  const tmpQ = new THREE.Quaternion();
  const tmpM = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);

  const applyCamera = (dt: number) => {
    const target = poseAt(progress);
    if (inspectCam) {
      inspectCam = inspectPose(inspecting);
      inspectBlend = damp(inspectBlend, 1, 5.2, dt);
    } else {
      inspectBlend = damp(inspectBlend, 0, 5.2, dt);
    }
    const base = inspectCam ? lerpPose(target, inspectCam, inspectBlend) : target;

    const parallaxX = portrait() ? 0 : pointerX * 0.16;
    const parallaxY = portrait() ? 0 : pointerY * 0.07;

    camPos.x = damp(camPos.x, base.pos.x + parallaxX, 7.5, dt);
    camPos.y = damp(camPos.y, base.pos.y - parallaxY, 7.5, dt);
    camPos.z = damp(camPos.z, base.pos.z, 7.5, dt);
    camLook.x = damp(camLook.x, base.look.x, 7.5, dt);
    camLook.y = damp(camLook.y, base.look.y, 7.5, dt);
    camLook.z = damp(camLook.z, base.look.z, 7.5, dt);
    camFov = damp(camFov, base.fov, 6, dt);

    camera.position.copy(camPos);
    camera.fov = camFov;
    camera.updateProjectionMatrix();
    camera.lookAt(camLook);
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    if (!visible || document.hidden) return;

    smooth = damp(smooth, progress, 8, dt);
    const doorT = smoothstep(0.015, 0.13, smooth);
    world.doorL.rotation.y = doorT * 1.38;
    world.doorR.rotation.y = -doorT * 1.38;

    if (resumeScroll !== null && resumeTries < 3) {
      resumeTries += 1;
      window.scrollTo({ top: resumeScroll, behavior: 'auto' });
      if (Math.abs(window.scrollY - resumeScroll) < 2) resumeScroll = null;
    }

    applyCamera(dt);

    // 悬停高亮
    if (hovered >= 0 && inspecting < 0) {
      const z = world.paintZ(hovered);
      highlight.visible = true;
      highlight.position.set(-ROOM.wall + 0.09, ROOM.eye + ROOM.floor, z);
      hlMat.opacity = damp(hlMat.opacity, 0.16, 12, dt);
    } else {
      hlMat.opacity = damp(hlMat.opacity, 0, 12, dt);
      if (hlMat.opacity < 0.01) highlight.visible = false;
    }

    // UI 状。
const walking = smooth > 0.012;
    stage.classList.toggle('is-walking', walking);
    stage.classList.toggle('is-past', smooth > pastAt);
    if (intro) intro.setAttribute('aria-hidden', walking ? 'true' : 'false');

    if (railProgress) railProgress.style.height = `${Math.round(smooth * 100)}%`;

    // 时间轴高。
if (rail) {
      const buttons = rail.querySelectorAll<HTMLElement>('[data-arc-rail-index]');
      const n = buttons.length;
      const active = Math.min(n - 1, Math.floor(smooth * n));
      buttons.forEach((b, i) => b.classList.toggle('is-active', i === active));
    }

    renderer.render(scene, camera);

    if (!ready) {
      ready = true;
      root.setAttribute('data-arc-ready', '');
      stage.classList.add('is-ready');
      window.setTimeout(() => loader?.setAttribute('aria-hidden', 'true'), 700);
    }
  };

  raf = requestAnimationFrame(tick);

  // 字体就绪后重绘海报（避免首帧回退字体。
document.fonts?.ready?.then(() => {
    const tex = makeTexture(makePosterCanvas(items[0] ?? ({} as FrameItem)));
    tex.dispose();
  });

  const cleanup = () => {
    cancelAnimationFrame(raf);
    io.disconnect();
    enterBtn?.removeEventListener('click', enter);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('click', onClick);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey);
    inspectClose?.removeEventListener('click', closeInspect);
    document.documentElement.classList.remove('arc-noscroll');
    root.removeAttribute('data-arc-ready');
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      }
    });
    scene.environment?.dispose();
    renderer.dispose();
    activeCleanup = null;
  };

  activeCleanup = cleanup;
}

/* -------------------------------------------------------------------------- */
/*  启动 / 清理                                                               */
/* -------------------------------------------------------------------------- */

function boot() {
  const root = document.querySelector<HTMLElement>('[data-arc]');
  if (!root) return;
  activeCleanup?.();
  void init(root);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

document.addEventListener('astro:page-load', boot);
document.addEventListener('astro:before-swap', () => {
  activeCleanup?.();
});



