/**
 * 归档 · 时之壁
 * ------------------------------------------------------------
 * 一条沿黑石壁向前的路：
 *   石壁 = 档案，发光碑 = 文章，浅水 = 倒影，
 *   浑天仪 = 天上的时间，拱门 = 月份。
 *
 * 滚动只做一件事：把相机沿 x 轴往前推。碑的位置、墙的纹理、
 * 年份、月份拱门都是场景里的实物，不是 DOM 假 3D。
 *
 * 设计约束：
 * - 文字始终有一份服务端渲染的平面索引（.arc-list），这里只负责场景；
 * - 明暗主题都可用：换主题时重绘碑面、墙色、水色和雾；
 * - 移动端降 dpr、关 bloom，保留场景；
 * - prefers-reduced-motion 时相机不阻尼、浑天仪不转、粒子不动。
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

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

interface Palette {
  light: boolean;
  bg: THREE.Color;
  ink: THREE.Color;
  muted: THREE.Color;
  brass: THREE.Color;
  warm: THREE.Color;
  cool: THREE.Color;
  wall: THREE.Color;
  stele: THREE.Color;
  floor: THREE.Color;
  reflect: THREE.Color;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a || 1), 0, 1);
  return t * t * (3 - 2 * t);
};

function canvas2d(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
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
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
  const iw = image.naturalWidth * scale;
  const ih = image.naturalHeight * scale;
  ctx.drawImage(image, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let line = '';

  for (const char of chars) {
    const next = line + char;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = char;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);

  if (lines.length === maxLines && chars.length) {
    const joined = lines.join('');
    if (joined.length < chars.length) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
    }
  }
  return lines;
}

function colorFromVar(styles: CSSStyleDeclaration, name: string, fallback: string): THREE.Color {
  const value = styles.getPropertyValue(name).trim();
  try {
    return new THREE.Color(value || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  const light = document.documentElement.dataset.themeType === 'light';

  return {
    light,
    bg: colorFromVar(styles, '--arc-bg', light ? '#e7dfd0' : '#05070c'),
    ink: colorFromVar(styles, '--arc-ink', light ? '#241d14' : '#efe6d3'),
    muted: colorFromVar(styles, '--arc-muted', light ? '#6f6556' : '#9aa3b2'),
    brass: colorFromVar(styles, '--arc-brass', light ? '#7a5a2e' : '#c9a468'),
    warm: colorFromVar(styles, '--arc-warm', light ? '#b98a45' : '#ffd39a'),
    cool: colorFromVar(styles, '--arc-cool', light ? '#5f7fa8' : '#b9d4ff'),
    wall: new THREE.Color(light ? '#a99b86' : '#2f3746'),
    stele: new THREE.Color(light ? '#2a2620' : '#0b0f17'),
    floor: new THREE.Color(light ? '#b7a992' : '#0a0e16'),
    reflect: new THREE.Color(light ? '#b9ad98' : '#8b96a6'),
  };
}

/* ------------------------------------------------------------------ */
/* 纹理绘制                                                             */
/* ------------------------------------------------------------------ */

/** 墙面：灰度石纹，靠材质 color 染色，这样换主题不用重画 */
function makeWallTexture(): THREE.CanvasTexture {
  const W = 2048;
  const H = 1024;
  const { canvas, ctx } = canvas2d(W, H);

  ctx.fillStyle = '#8f8f8f';
  ctx.fillRect(0, 0, W, H);

  // 大块石面明暗
  for (let i = 0; i < 90; i += 1) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 60 + Math.random() * 260;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, `rgba(255,255,255,${0.02 + Math.random() * 0.03})`);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // 横向石缝
  ctx.strokeStyle = 'rgba(38,38,38,0.65)';
  ctx.lineWidth = 3;
  for (let y = 92; y < H; y += 96) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(215,215,215,0.18)';
    ctx.beginPath();
    ctx.moveTo(0, y + 3);
    ctx.lineTo(W, y + 3);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(38,38,38,0.65)';
  }

  // 竖向错缝
  for (let row = 0; row < 11; row += 1) {
    const offset = row % 2 === 0 ? 0 : 128;
    for (let x = offset; x < W; x += 256) {
      ctx.strokeStyle = 'rgba(30,30,30,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, row * 96);
      ctx.lineTo(x, row * 96 + 96);
      ctx.stroke();
    }
  }

  // 大块石面的不规则凹陷（少量，避免变成窗格）
  for (let i = 0; i < 7; i += 1) {
    const x = 120 + Math.random() * (W - 360);
    const y = 140 + Math.random() * (H - 420);
    const w = 180 + Math.random() * 220;
    const h = 120 + Math.random() * 180;
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = 'rgba(40,40,40,0.5)';
    roundRect(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(210,210,210,0.1)';
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, w, h, 3);
    ctx.stroke();
  }

  // 噪点
  const image = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    image.data[i] = clamp(image.data[i] + n, 0, 255);
    image.data[i + 1] = clamp(image.data[i + 1] + n, 0, 255);
    image.data[i + 2] = clamp(image.data[i + 2] + n, 0, 255);
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** 碑面：封面 + 日期 + 竖排标题 + 系列光痕 + 印章 */
function drawSteleFace(
  canvas: HTMLCanvasElement,
  post: ArcPost,
  index: number,
  palette: Palette,
  image: HTMLImageElement | null,
) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dark = true;
  const paper = '#fff7e8';
  const faint = 'rgba(239,230,211,0.46)';
  const brass = '#e6c58a';
  const bg = '#080b12';

  ctx.clearRect(0, 0, W, H);

  const bgGradient = ctx.createLinearGradient(0, 0, W, H);
  bgGradient.addColorStop(0, dark ? '#101722' : '#f3ece0');
  bgGradient.addColorStop(0.55, bg);
  bgGradient.addColorStop(1, dark ? '#05070c' : '#ddd2c0');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, W, H);

  // 石面细颗粒
  for (let i = 0; i < 900; i += 1) {
    ctx.fillStyle = dark
      ? `rgba(255,255,255,${Math.random() * 0.035})`
      : `rgba(40,30,20,${Math.random() * 0.035})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }

  // 内框
  ctx.strokeStyle = dark ? 'rgba(201,164,104,0.55)' : 'rgba(122,90,46,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(38, 38, W - 76, H - 76);
  ctx.strokeStyle = dark ? 'rgba(201,164,104,0.18)' : 'rgba(122,90,46,0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(52, 52, W - 104, H - 104);

  // 封面
  const coverX = 84;
  const coverY = 92;
  const coverW = W - 168;
  const coverH = 740;
  ctx.save();
  roundRect(ctx, coverX, coverY, coverW, coverH, 4);
  ctx.clip();
  if (image && image.complete && image.naturalWidth > 0) {
    drawCover(ctx, image, coverX, coverY, coverW, coverH);
    // 压暗，保证白字可读
    const shade = ctx.createLinearGradient(0, coverY, 0, coverY + coverH);
    shade.addColorStop(0, 'rgba(4,6,10,0.25)');
    shade.addColorStop(0.55, 'rgba(4,6,10,0.04)');
    shade.addColorStop(1, 'rgba(4,6,10,0.8)');
    ctx.fillStyle = shade;
    ctx.fillRect(coverX, coverY, coverW, coverH);
  } else {
    const placeholder = ctx.createLinearGradient(coverX, coverY, coverX + coverW, coverY + coverH);
    placeholder.addColorStop(0, dark ? '#1d3448' : '#b7c6d0');
    placeholder.addColorStop(1, dark ? '#2b1d2e' : '#d8c3ae');
    ctx.fillStyle = placeholder;
    ctx.fillRect(coverX, coverY, coverW, coverH);
  }
  ctx.restore();

  // 封面上的编号与档案字样
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '500 24px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = 'rgba(255,246,230,0.9)';
  ctx.fillText('ARCHIVE / 2026', coverX + 28, coverY + 26);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,214,160,0.95)';
  ctx.fillText(`NO.${String(index + 1).padStart(2, '0')}`, coverX + coverW - 28, coverY + 26);

  // 标题：横排最多 4 行；日期/星期交给 readout 与详情，碑面只保留大字
  const titleX = 100;
  const titleTop = 880;
  const titleSize = 176;
  const titleLine = 200;
  const titleMax = W - 200;
  const rawChars = Array.from(post.title);
  const titleFont = `${titleSize}px "Songti SC", "Noto Serif CJK SC", "SimSun", Georgia, serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = paper;
  ctx.font = titleFont;

  const titleLines: string[] = [];
  let line = '';
  for (const char of rawChars) {
    const next = line + char;
    if (line && ctx.measureText(next).width > titleMax) {
      titleLines.push(line);
      line = char;
    } else {
      line = next;
    }
    if (titleLines.length === 4) break;
  }
  if (titleLines.length < 4 && line) titleLines.push(line);
  if (titleLines.length === 4) {
    const joined = titleLines.join('');
    if (joined.length < rawChars.length) {
      titleLines[3] = `${titleLines[3].slice(0, -1)}…`;
    }
  }
  titleLines.forEach((text, i) => {
    ctx.fillText(text, titleX, titleTop + i * titleLine);
  });

  // 描述
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = faint;
  ctx.font = '400 27px "Songti SC", "Noto Serif CJK SC", "SimSun", Georgia, serif';
  const lines = wrapLines(ctx, post.description || ' ', 760, 2);
  lines.forEach((line, i) => {
    ctx.fillText(line, 100, 1800 + i * 42);
  });

  // 底部编号线
  ctx.strokeStyle = dark ? 'rgba(201,164,104,0.28)' : 'rgba(122,90,46,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(100, 1912);
  ctx.lineTo(W - 100, 1912);
  ctx.stroke();

  ctx.fillStyle = faint;
  ctx.font = '400 21px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(post.dateISO.replace(/-/g, '.'), 100, 1938);

  // 印章
  const seal = 76;
  const sx = W - 100 - seal;
  const sy = H - 100 - seal;
  ctx.strokeStyle = dark ? 'rgba(184,69,47,0.9)' : 'rgba(150,52,38,0.9)';
  ctx.lineWidth = 3;
  ctx.strokeRect(sx, sy, seal, seal);
  ctx.fillStyle = dark ? 'rgba(184,69,47,0.92)' : 'rgba(150,52,38,0.92)';
  ctx.font = '600 34px "Songti SC", "SimSun", Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('墨', sx + seal / 2, sy + seal / 2 + 1);
}

/** 年份大字 */
function makeYearTexture(year: number, color: string): THREE.CanvasTexture {
  const { canvas, ctx } = canvas2d(1024, 512);
  ctx.clearRect(0, 0, 1024, 512);
  ctx.fillStyle = color;
  ctx.font = '600 300px "Songti SC", "Noto Serif CJK SC", "SimSun", Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(year), 512, 268);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 光柱 / 光晕用的软渐变 */
function makeGlowTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = canvas2d(128, 512);
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, 'rgba(255,235,200,0)');
  gradient.addColorStop(0.35, 'rgba(255,225,180,0.5)');
  gradient.addColorStop(1, 'rgba(255,210,150,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 碑脚接触阴影 */
function makeShadowTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = canvas2d(256, 128);
  const gradient = ctx.createRadialGradient(128, 64, 4, 128, 64, 120);
  gradient.addColorStop(0, 'rgba(0,0,0,0.65)');
  gradient.addColorStop(0.5, 'rgba(0,0,0,0.28)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ------------------------------------------------------------------ */
/* 初始化                                                               */
/* ------------------------------------------------------------------ */

let activeCleanup: (() => void) | null = null;

function readData(): ArcData | null {
  const element = document.getElementById('arc-data');
  if (!element?.textContent) return null;
  try {
    return JSON.parse(element.textContent) as ArcData;
  } catch {
    return null;
  }
}

function init(root: HTMLElement): () => void {
  if (root.dataset.arcReady === '1') return () => {};
  root.dataset.arcReady = '1';

  const data = readData();
  const stage = root.querySelector<HTMLElement>('[data-arc-stage]');
  const sceneEl = root.querySelector<HTMLElement>('[data-arc-scene]');
  const canvas = root.querySelector<HTMLCanvasElement>('[data-arc-canvas]');
  const intro = root.querySelector<HTMLElement>('[data-arc-intro]');
  const readout = root.querySelector<HTMLElement>('[data-arc-readout]');
  const readoutIndex = root.querySelector<HTMLElement>('[data-arc-readout-index]');
  const readoutDate = root.querySelector<HTMLElement>('[data-arc-readout-date]');
  const readoutTitle = root.querySelector<HTMLElement>('[data-arc-readout-title]');
  const readoutWords = root.querySelector<HTMLElement>('[data-arc-readout-words]');
  const hitsEl = root.querySelector<HTMLElement>('[data-arc-hits]');
  const loader = root.querySelector<HTMLElement>('[data-arc-loader]');
  const rail = root.querySelector<HTMLElement>('[data-arc-rail]');
  const railProgress = root.querySelector<HTMLElement>('[data-arc-rail-progress]');
  const dialog = root.querySelector<HTMLDialogElement>('[data-arc-dialog]');
  const dialogMeta = root.querySelector<HTMLElement>('[data-arc-dialog-meta]');
  const dialogTitle = root.querySelector<HTMLElement>('[data-arc-dialog-title]');
  const dialogDesc = root.querySelector<HTMLElement>('[data-arc-dialog-desc]');
  const dialogSeries = root.querySelector<HTMLElement>('[data-arc-dialog-series]');
  const dialogLink = root.querySelector<HTMLAnchorElement>('[data-arc-dialog-link]');

  if (!data || !stage || !sceneEl || !canvas || !hitsEl || !dialog) {
    root.dataset.arcReady = '0';
    return () => {};
  }

  const posts = data.posts;
  if (!posts.length) {
    root.dataset.arcReady = '0';
    loader?.remove();
    return () => {};
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let palette = readPalette();
  let isMobile = window.innerWidth < 761;

  /* ---------- 渲染器 ---------- */

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
  } catch (error) {
    console.warn('[archive] WebGL unavailable', error);
    root.classList.add('is-no-webgl');
    loader?.remove();
    return () => {};
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  scene.background = palette.bg.clone();
  scene.fog = new THREE.FogExp2(palette.bg.getHex(), isMobile ? 0.024 : 0.019);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 140);
  camera.position.set(0, 3.6, 17);

  /* ---------- 尺寸 ---------- */

  const compact = window.innerWidth < 761;
  const spacing = compact ? 2.5 : 3.9;
  const count = posts.length;
  const span = (count - 1) * spacing;
  const xOf = (index: number) => (index - (count - 1) / 2) * spacing + (compact ? -1.4 : 3.2);
  const heights = posts.map((post) =>
    3.0 + clamp(Math.log10(post.wordsRaw + 10) * 0.55, 0.34, 2.6),
  );

  const wallWidth = Math.max(60, span + 38);
  const wallTexture = makeWallTexture();

  let width = 1;
  let height = 1;

  function resize() {
    width = stage!.clientWidth || window.innerWidth;
    height = stage!.clientHeight || window.innerHeight;
    isMobile = window.innerWidth < 761;

    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
    renderer.setSize(width, height, false);
    composer?.setSize(width, height);
  }

  /* ---------- 材质与灯光 ---------- */

  const wallMaterial = new THREE.MeshStandardMaterial({
    map: wallTexture,
    color: palette.wall.clone(),
    roughness: 0.94,
    metalness: 0.03,
  });
  wallTexture.repeat.set(Math.max(2, wallWidth / 24), 1.15);
  wallTexture.needsUpdate = true;

  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: palette.wall.clone().multiplyScalar(0.72),
    roughness: 0.9,
    metalness: 0.04,
  });

  const brassMaterial = new THREE.MeshStandardMaterial({
    color: palette.brass.clone(),
    emissive: palette.brass.clone(),
    emissiveIntensity: 0.18,
    roughness: 0.36,
    metalness: 0.86,
  });

  const ambient = new THREE.AmbientLight(0xffffff, palette.light ? 0.78 : 0.34);
  scene.add(ambient);

  scene.add(new THREE.HemisphereLight(palette.cool.clone(), palette.bg.clone(), palette.light ? 0.5 : 0.24));

  const keyLight = new THREE.DirectionalLight(palette.warm.clone(), palette.light ? 2.1 : 2.9);
  keyLight.position.set(7, 13, 9);
  keyLight.target.position.set(0, 4, -4);
  scene.add(keyLight, keyLight.target);

  const fillLight = new THREE.PointLight(palette.cool.clone(), palette.light ? 18 : 30, 42, 2);
  fillLight.position.set(-8, 6, -2);
  scene.add(fillLight);

  const frontLight = new THREE.PointLight(palette.warm.clone(), palette.light ? 14 : 34, 36, 2);
  frontLight.position.set(2, 4.2, 6);
  scene.add(frontLight);

  // 沿墙的洗墙光，让石纹与壁柱在暗部也有层次
  [-12, 0, 12].forEach((x) => {
    const wash = new THREE.PointLight(palette.warm.clone(), palette.light ? 10 : 18, 22, 2);
    wash.position.set(x, 6.4, -2.4);
    scene.add(wash);
  });

  /* ---------- 墙 ---------- */

  const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallWidth, 8.8), wallMaterial);
  wall.position.set(0, 4.4, -6);
  scene.add(wall);

  // 壁柱
  const pilasterGeo = new THREE.BoxGeometry(0.46, 8.0, 0.55);
  const pilasters = new THREE.InstancedMesh(
    pilasterGeo,
    new THREE.MeshStandardMaterial({
      color: palette.wall.clone().multiplyScalar(0.62),
      roughness: 0.92,
    }),
    Math.max(2, Math.floor(wallWidth / 6) + 1),
  );
  {
    const matrix = new THREE.Matrix4();
    let i = 0;
    for (let x = -wallWidth / 2 + 3; x <= wallWidth / 2; x += 6) {
      matrix.makeTranslation(x, 4.0, -5.72);
      pilasters.setMatrixAt(i, matrix);
      i += 1;
    }
    pilasters.count = i;
    pilasters.instanceMatrix.needsUpdate = true;
  }
  scene.add(pilasters);

  const cornice = new THREE.Mesh(new THREE.BoxGeometry(wallWidth, 0.55, 1.3), stoneMaterial);
  cornice.position.set(0, 8.55, -5.78);
  scene.add(cornice);

  const base = new THREE.Mesh(new THREE.BoxGeometry(wallWidth, 0.72, 1.7), stoneMaterial);
  base.position.set(0, 0.36, -5.55);
  scene.add(base);

  // 顶部石梁与格状天花：把“墙顶以上”封成大厅，而不是留一块背景
  const ceilingTexture = wallTexture.clone();
  ceilingTexture.wrapS = THREE.RepeatWrapping;
  ceilingTexture.wrapT = THREE.RepeatWrapping;
  ceilingTexture.repeat.set(10, 5);
  ceilingTexture.needsUpdate = true;
  const ceilingMaterial = new THREE.MeshBasicMaterial({
    map: ceilingTexture,
    color: palette.light ? '#cbbda5' : '#6a5741',
  });
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(wallWidth + 8, 70), ceilingMaterial);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 9.0, -2);
  scene.add(ceiling);

  // 顶部暖光槽：让“梁以上”有面，而不是一块黑场
  const cofferCanvas = document.createElement('canvas');
  cofferCanvas.width = 512;
  cofferCanvas.height = 512;
  const cctx = cofferCanvas.getContext('2d')!;
  const cgrad = cctx.createRadialGradient(256, 256, 8, 256, 256, 250);
  cgrad.addColorStop(0, 'rgba(255, 211, 154, 0.55)');
  cgrad.addColorStop(0.45, 'rgba(255, 190, 130, 0.22)');
  cgrad.addColorStop(1, 'rgba(255, 180, 120, 0)');
  cctx.fillStyle = cgrad;
  cctx.fillRect(0, 0, 512, 512);
  const cofferTexture = new THREE.CanvasTexture(cofferCanvas);
  cofferTexture.colorSpace = THREE.SRGBColorSpace;
  const cofferMaterial = new THREE.MeshBasicMaterial({
    map: cofferTexture,
    transparent: true,
    opacity: palette.light ? 0.34 : 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const coffer = new THREE.Mesh(new THREE.PlaneGeometry(wallWidth * 0.9, 20), cofferMaterial);
  coffer.rotation.x = Math.PI / 2;
  coffer.position.set(0, 8.985, -2);
  coffer.renderOrder = 1;
  scene.add(coffer);

  const beamMaterial = new THREE.MeshStandardMaterial({
    color: palette.wall.clone().multiplyScalar(palette.light ? 0.42 : 0.32),
    roughness: 0.9,
    metalness: 0.04,
  });
  const beamGeoZ = new THREE.BoxGeometry(0.42, 0.55, 28);
  const beamGeoX = new THREE.BoxGeometry(wallWidth + 8, 0.32, 0.32);
  const beams: THREE.Mesh[] = [];
  for (let x = -wallWidth / 2; x <= wallWidth / 2; x += 5.2) {
    const beam = new THREE.Mesh(beamGeoZ, beamMaterial);
    beam.position.set(x, 8.72, 7);
    scene.add(beam);
    beams.push(beam);
  }
  for (let z = -5.6; z <= 20; z += 4.2) {
    const beam = new THREE.Mesh(beamGeoX, beamMaterial);
    beam.position.set(0, 8.66, z);
    scene.add(beam);
    beams.push(beam);
  }

  // 墙上的年份
  const yearTexture = makeYearTexture(2026, '#ffffff');
  const yearMaterial = new THREE.MeshBasicMaterial({
    map: yearTexture,
    color: palette.light ? new THREE.Color('#2b2116') : palette.brass,
    transparent: true,
    opacity: palette.light ? 0.46 : 0.14,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  const yearPlane = new THREE.Mesh(new THREE.PlaneGeometry(14, 6), yearMaterial);
  yearPlane.position.set(0, 5.4, -5.55);
  scene.add(yearPlane);

  /* ---------- 地面 ---------- */

  const floor = new Reflector(new THREE.PlaneGeometry(130, 70), {
    clipBias: 0.003,
    textureWidth: isMobile ? 512 : 1024,
    textureHeight: isMobile ? 512 : 1024,
    color: palette.reflect.getHex(),
  });
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.012, -5);
  scene.add(floor);

  // 一层可见的石地坪：让“地面”不是纯镜面，而是湿石
  const floorTexture = wallTexture.clone();
  floorTexture.wrapS = THREE.RepeatWrapping;
  floorTexture.wrapT = THREE.RepeatWrapping;
  floorTexture.repeat.set(16, 8);
  floorTexture.needsUpdate = true;
  const floorStoneMaterial = new THREE.MeshBasicMaterial({
    map: floorTexture,
    color: palette.light ? '#c8bca6' : '#4a505c',
    transparent: true,
    opacity: palette.light ? 0.52 : 0.46,
    depthWrite: false,
  });
  const floorStone = new THREE.Mesh(new THREE.PlaneGeometry(130, 70), floorStoneMaterial);
  floorStone.rotation.x = -Math.PI / 2;
  floorStone.position.set(0, 0.02, -5);
  floorStone.renderOrder = 1;
  scene.add(floorStone);

  // 一层很薄的暗水色，压掉镜面反射的“复制感”
  const waterHazeMaterial = new THREE.MeshBasicMaterial({
    color: palette.bg.clone(),
    transparent: true,
    opacity: palette.light ? 0.18 : 0.22,
    depthWrite: false,
  });
  const waterHaze = new THREE.Mesh(new THREE.PlaneGeometry(130, 70), waterHazeMaterial);
  waterHaze.rotation.x = -Math.PI / 2;
  waterHaze.position.set(0, 0.035, -5);
  waterHaze.renderOrder = 2;
  scene.add(waterHaze);

  const shadowTexture = makeShadowTexture();
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });

  /* ---------- 碑 ---------- */

  const steles: {
    group: THREE.Group;
    post: ArcPost;
    index: number;
    height: number;
    faceCanvas: HTMLCanvasElement;
    faceTexture: THREE.CanvasTexture;
    faceMaterial: THREE.MeshStandardMaterial;
    bodyMaterial: THREE.MeshStandardMaterial;
    ripple: THREE.Mesh;
  }[] = [];

  const coverImages: (HTMLImageElement | null)[] = posts.map((post) => {
    if (!post.cover) return null;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    return image;
  });

  const redrawFaces = () => {
    steles.forEach((stele) => {
      drawSteleFace(
        stele.faceCanvas,
        stele.post,
        stele.index,
        palette,
        coverImages[stele.index],
      );
      stele.faceTexture.needsUpdate = true;
      stele.bodyMaterial.color.copy(palette.stele);
    });
  };

  posts.forEach((post, index) => {
    const group = new THREE.Group();
    const steleHeight = heights[index];
    group.position.set(xOf(index), 0, -5.35);

    // 嵌进墙里的暗龛：碑不再是贴在墙前的灯箱
    const niche = new THREE.Mesh(
      new THREE.PlaneGeometry(2.9, steleHeight + 0.9),
      new THREE.MeshBasicMaterial({
        color: 0x04060a,
        transparent: true,
        opacity: palette.light ? 0.32 : 0.62,
        depthWrite: false,
      }),
    );
    niche.position.set(0, (steleHeight + 0.9) / 2, -0.52);
    group.add(niche);

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: palette.stele.clone(),
      roughness: 0.78,
      metalness: 0.06,
    });

    const baseY = 0.34;
    const body = new THREE.Mesh(
      new RoundedBoxGeometry(2.2, steleHeight, 0.34, 4, 0.06),
      bodyMaterial,
    );
    body.position.y = baseY + steleHeight / 2;
    group.add(body);

    const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.58, 0.34, 0.92), bodyMaterial);
    plinth.position.set(0, 0.17, 0.12);
    group.add(plinth);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.24, 0.5), bodyMaterial);
    cap.position.set(0, baseY + steleHeight - 0.12, 0.08);
    group.add(cap);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(body.geometry, 18),
      new THREE.LineBasicMaterial({
        color: palette.warm.clone(),
        transparent: true,
        opacity: 0.34,
      }),
    );
    edges.position.copy(body.position);
    group.add(edges);

    const { canvas: faceCanvas } = canvas2d(1024, 2048);
    const faceTexture = new THREE.CanvasTexture(faceCanvas);
    faceTexture.colorSpace = THREE.SRGBColorSpace;
    faceTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    const faceMaterial = new THREE.MeshStandardMaterial({
      map: faceTexture,
      emissiveMap: faceTexture,
      emissive: palette.warm.clone(),
      emissiveIntensity: palette.light ? 0.2 : 0.5,
      roughness: 0.82,
      metalness: 0.02,
      fog: false,
    });

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(2.02, steleHeight - 0.4),
      faceMaterial,
    );
    face.position.set(0, baseY + steleHeight / 2, 0.181);
    group.add(face);

    // 碑脚接触阴影
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.7), shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, 0.028, 0.2);
    group.add(shadow);

    // 涟漪
    const ripple = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 0.86, 64),
      new THREE.MeshBasicMaterial({
        color: palette.warm.clone(),
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ripple.rotation.x = -Math.PI / 2;
    ripple.position.set(0, 0.04, 0.35);
    group.add(ripple);

    scene.add(group);

    steles.push({
      group,
      post,
      index,
      height: steleHeight,
      faceCanvas,
      faceTexture,
      faceMaterial,
      bodyMaterial,
      ripple,
    });
  });

  // 先画一遍（封面可能还没加载，加载后会重画）
  redrawFaces();

  // 断点变化时重新排布碑群（窄屏压缩间距，保证 4 块碑同屏）
  function layoutSteles() {
    const mobile = window.innerWidth < 761;
    const step = mobile ? 2.5 : 3.9;
    const offset = mobile ? -1.4 : 3.2;
    steles.forEach((stele, index) => {
      stele.group.position.x = (index - (count - 1) / 2) * step + offset;
    });
  }
  layoutSteles();

  coverImages.forEach((image, index) => {
    if (!image) return;
    image.onload = () => {
      const stele = steles[index];
      if (!stele) return;
      drawSteleFace(stele.faceCanvas, stele.post, index, palette, image);
      stele.faceTexture.needsUpdate = true;
    };
    image.src = posts[index].cover!;
  });

  /* ---------- 月份拱门（省略：单月时半径过大，右端会被视口裁切） ---------- */

  /* ---------- 浑天仪 ---------- */

  function makeArmillary(radius: number, position: THREE.Vector3, opacity: number) {
    const group = new THREE.Group();
    group.position.copy(position);

    const material = brassMaterial.clone();
    material.transparent = true;
    material.opacity = opacity;

    const rings: THREE.Mesh[] = [];
    const orientations: [number, number, number][] = [
      [0, 0, 0],
      [Math.PI / 2, 0, 0],
      [0.38, 0.72, 0.2],
    ];

    orientations.forEach((rotation, index) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius - index * radius * 0.1, radius * 0.034, 10, 160),
        material,
      );
      ring.rotation.set(rotation[0], rotation[1], rotation[2]);
      group.add(ring);
      rings.push(ring);
    });

    // 刻度
    const tickGeo = new THREE.BoxGeometry(0.05, radius * 0.09, 0.05);
    const tickMat = new THREE.MeshBasicMaterial({
      color: palette.brass.clone(),
      transparent: true,
      opacity: opacity * 0.8,
    });
    for (let i = 0; i < 24; i += 1) {
      const angle = (i / 24) * Math.PI * 2;
      const tick = new THREE.Mesh(tickGeo, tickMat);
      tick.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
      tick.rotation.z = angle;
      group.add(tick);
    }

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.055, 16, 16),
      new THREE.MeshBasicMaterial({ color: palette.warm.clone() }),
    );
    group.add(core);

    scene.add(group);
    return { group, rings, material };
  }

  const armillaryMain = makeArmillary(1.7, new THREE.Vector3(4.6, 8.2, -5.4), palette.light ? 0.72 : 0.85);
  const armillarySmall = makeArmillary(1.05, new THREE.Vector3(-11.6, 8.6, -5.8), palette.light ? 0.5 : 0.62);

  /* ---------- 光柱 ---------- */

  const glowTexture = makeGlowTexture();
  const shaftMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture,
    transparent: true,
    opacity: palette.light ? 0.05 : 0.08,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  [-6.4, 5.8].forEach((x) => {
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 12), shaftMaterial);
    shaft.position.set(x, 6, -4.6);
    shaft.rotation.z = x < 0 ? -0.12 : 0.1;
    scene.add(shaft);
  });

  /* ---------- 星尘 ---------- */

  const dustCount = reducedMotion ? 220 : isMobile ? 420 : 900;
  const dustPositions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i += 1) {
    dustPositions[i * 3] = (Math.random() - 0.5) * (span + 28);
    dustPositions[i * 3 + 1] = Math.random() * 11;
    dustPositions[i * 3 + 2] = -6 + Math.random() * 13;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dustMaterial = new THREE.PointsMaterial({
    color: palette.warm.clone(),
    size: 0.055,
    transparent: true,
    opacity: palette.light ? 0.34 : 0.62,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  scene.add(dust);

  // 星点
  const starCount = 600;
  const starPositions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i += 1) {
    starPositions[i * 3] = (Math.random() - 0.5) * 80;
    starPositions[i * 3 + 1] = 4 + Math.random() * 26;
    starPositions[i * 3 + 2] = -16 - Math.random() * 32;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  const starMaterial = new THREE.PointsMaterial({
    color: palette.cool.clone(),
    size: 0.08,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  scene.add(stars);

  /* ---------- 后期 ---------- */

  let composer: EffectComposer | null = null;
  let bloomPass: UnrealBloomPass | null = null;

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(Math.max(1, width), Math.max(1, height)),
    palette.light ? 0.24 : 0.52,
    0.62,
    0.82,
  );
  bloomPass.enabled = !isMobile && !reducedMotion;
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  /* ---------- 交互 ---------- */

  const hitButtons: HTMLButtonElement[] = [];
  hitsEl.replaceChildren();
  posts.forEach((post, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'arc-hit';
    button.tabIndex = -1;
    button.dataset.arcHit = String(index);
    button.addEventListener('pointerenter', () => {
      hovered = index;
      button.classList.add('is-hot');
    });
    button.addEventListener('pointerleave', () => {
      if (hovered === index) hovered = -1;
      button.classList.remove('is-hot');
    });
    button.addEventListener('click', () => openDialog(index));
    hitsEl.appendChild(button);
    hitButtons.push(button);
  });

  let hovered = -1;
  let activeIndex = 0;
  let lastReadout = -1;
  let lastMonth = '';
  let lastFocus: HTMLElement | null = null;

  function updateReadout(index: number) {
    if (index === lastReadout) return;
    lastReadout = index;
    const post = posts[index];
    if (!post) return;
    if (readout) readout.hidden = false;
    if (readoutIndex) readoutIndex.textContent = String(index + 1).padStart(2, '0');
    if (readoutDate) readoutDate.textContent = `${post.dateLabel} · ${post.weekday}`;
    if (readoutTitle) readoutTitle.textContent = post.title;
    if (readoutWords) {
      readoutWords.textContent = post.series ? `系列 ${post.series.count} 章` : `${post.words} 字`;
    }
  }

  function updateRail(index: number) {
    const post = posts[index];
    if (!post || !rail) return;
    const key = post.dateISO.slice(0, 7);
    if (key === lastMonth) return;
    lastMonth = key;

    rail.querySelectorAll<HTMLElement>('[data-arc-month]').forEach((item) => {
      const active = item.dataset.arcMonth === key;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    });
  }

  rail?.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-arc-month]');
    if (!item) return;
    const key = item.dataset.arcMonth;
    const index = posts.findIndex((post) => post.dateISO.startsWith(key ?? ''));
    if (index < 0) return;

    const travel = Math.max(0, sceneEl.offsetHeight - window.innerHeight);
    const progress = count > 1 ? index / (count - 1) : 0;
    entered = true;
    window.scrollTo({
      top: window.scrollY + sceneEl.getBoundingClientRect().top + travel * progress * 0.98,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  });

  root.querySelector<HTMLElement>('[data-arc-enter]')?.addEventListener('click', () => {
    entered = true;
    stage?.classList.add('is-walking');
    intro?.setAttribute('aria-hidden', 'true');
    updateReadout(activeIndex);
  });

  /* ---------- 对话框 ---------- */

  function openDialog(index: number) {
    const post = posts[index];
    if (!post) return;

    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (dialogMeta) {
      dialogMeta.textContent = [
        post.dateLabel,
        post.weekday,
        post.series ? `系列 · ${post.series.count} 章` : `${post.words} 字`,
        post.categories.length ? post.categories.join(' / ') : '',
      ]
        .filter(Boolean)
        .join('  ·  ');
    }
    if (dialogTitle) dialogTitle.textContent = post.title;
    if (dialogDesc) dialogDesc.textContent = post.description || '这一页还没有写说明。';
    if (dialogLink) dialogLink.href = post.url;

    if (dialogSeries) {
      dialogSeries.replaceChildren();
      if (post.series) {
        const label = document.createElement('p');
        label.textContent = `系列 · ${post.series.title} · 共 ${post.series.count} 章`;
        const list = document.createElement('ol');
        post.series.chapters.forEach((chapter) => {
          const item = document.createElement('li');
          const link = document.createElement('a');
          const no = document.createElement('span');
          no.textContent = String(chapter.order).padStart(2, '0');
          link.href = chapter.url;
          link.append(no, document.createTextNode(chapter.title));
          item.appendChild(link);
          list.appendChild(item);
        });
        dialogSeries.append(label, list);
      }
    }

    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }

    dialogTitle?.setAttribute('tabindex', '-1');
    dialogTitle?.focus();
  }

  function closeDialog() {
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  dialog.querySelectorAll('[data-arc-dialog-close]').forEach((button) => {
    button.addEventListener('click', closeDialog);
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });

  dialog.addEventListener('close', () => {
    lastFocus?.focus();
  });

  // 深链 #post-xxx
  function openHashTarget() {
    const hash = window.location.hash;
    if (!hash.startsWith('#post-')) return;
    const index = posts.findIndex((post) => `#post-${post.slug}` === hash);
    if (index >= 0) window.setTimeout(() => openDialog(index), 240);
  }

  /* ---------- 相机 / 进度 ---------- */

  let progress = 0;
  let smoothProgress = 0;
  let entered = false;
  let pointerX = 0;
  let pointerY = 0;
  let targetPointerX = 0;
  let targetPointerY = 0;

  function readProgress() {
    const travel = Math.max(0, sceneEl.offsetHeight - window.innerHeight);
    const top = sceneEl.getBoundingClientRect().top;
    progress = travel > 0 ? clamp(-top / travel, 0, 1) : 0;
  }

  function applyCamera(dt: number) {
    const damp = reducedMotion ? 1 : 1 - Math.exp(-dt * 4.2);
    smoothProgress = reducedMotion ? progress : lerp(smoothProgress, progress, damp);

    pointerX = reducedMotion ? 0 : lerp(pointerX, targetPointerX, 1 - Math.exp(-dt * 3.4));
    pointerY = reducedMotion ? 0 : lerp(pointerY, targetPointerY, 1 - Math.exp(-dt * 3.4));

    const compact = window.innerWidth < 761;
    const camX = lerp(-4.2, -3.2, smoothProgress) * (compact ? 0.3 : 1);
    const lookX = lerp(-3.0, -2.2, smoothProgress) * (compact ? 0.3 : 1);
    const camY = compact ? 3.55 : 3.85;
    const camZ = compact ? 23 - smoothProgress * 0.6 : 17.4 - smoothProgress * 0.8;

    camera.position.set(camX + pointerX * 0.42, camY + pointerY * 0.16, camZ);
    camera.lookAt(lookX + pointerX * 0.12, 3.05 + pointerY * 0.06, -4.4);
    camera.updateMatrixWorld();

    const active = clamp(Math.round(smoothProgress * (count - 1)), 0, count - 1);
    if (active !== activeIndex) activeIndex = active;
    updateReadout(activeIndex);
    updateRail(activeIndex);

    if (railProgress) railProgress.style.width = `${smoothProgress * 100}%`;

    const walking = smoothProgress > 0.035 || entered;
    stage!.classList.toggle('is-walking', walking);
    stage!.classList.toggle('is-past', smoothProgress > 0.995);
    if (intro) intro.setAttribute('aria-hidden', walking ? 'true' : 'false');
  }

  /* ---------- 点击热区 ---------- */

  const projected = new THREE.Vector3();
  const projectedBottom = new THREE.Vector3();

  function updateHits() {
    for (const stele of steles) {
      const button = hitButtons[stele.index];
      if (!button) continue;

      projected.set(stele.group.position.x, stele.height + 0.34, -5.35).project(camera);
      projectedBottom.set(stele.group.position.x, 0, -5.35).project(camera);

      if (projected.z > 1 || projected.z < -1) {
        button.style.display = 'none';
        continue;
      }

      const x = (projected.x * 0.5 + 0.5) * width;
      const top = (-projected.y * 0.5 + 0.5) * height;
      const bottom = (-projectedBottom.y * 0.5 + 0.5) * height;
      const h = Math.abs(bottom - top);
      const w = h * 0.42;

      if (x < -w || x > width + w) {
        button.style.display = 'none';
        continue;
      }

      button.style.display = 'block';
      button.style.width = `${w}px`;
      button.style.height = `${h}px`;
      button.style.transform = `translate3d(${x - w / 2}px, ${Math.min(top, bottom)}px, 0)`;
    }
  }

  /* ---------- 主题 ---------- */

  function applyTheme() {
    palette = readPalette();
    scene.background = palette.bg.clone();
    if (scene.fog instanceof THREE.FogExp2) scene.fog.color.copy(palette.bg);

    wallMaterial.color.copy(palette.wall);
    stoneMaterial.color.copy(palette.wall).multiplyScalar(0.72);
    (pilasters.material as THREE.MeshStandardMaterial).color.copy(palette.wall).multiplyScalar(0.62);
    ceilingMaterial.color.set(palette.light ? '#cbbda5' : '#6a5741');
    cofferMaterial.opacity = palette.light ? 0.34 : 0.5;
    beamMaterial.color.copy(palette.wall).multiplyScalar(palette.light ? 0.42 : 0.26);
    ambient.intensity = palette.light ? 0.78 : 0.34;
    keyLight.color.copy(palette.warm);
    keyLight.intensity = palette.light ? 2.1 : 2.9;
    fillLight.color.copy(palette.cool);
    fillLight.intensity = palette.light ? 18 : 30;
    frontLight.color.copy(palette.warm);
    frontLight.intensity = palette.light ? 14 : 34;

    yearMaterial.color.copy(palette.light ? new THREE.Color('#2b2116') : palette.brass);
    yearMaterial.opacity = palette.light ? 0.46 : 0.14;

    (floor.material as THREE.ShaderMaterial).uniforms.color.value.copy(palette.reflect);
    floorStoneMaterial.color.set(palette.light ? '#c8bca6' : '#4a505c');
    floorStoneMaterial.opacity = palette.light ? 0.52 : 0.46;
    waterHazeMaterial.opacity = palette.light ? 0.16 : 0.2;

    steles.forEach((stele) => {
      stele.bodyMaterial.color.copy(palette.stele);
      stele.faceMaterial.emissive.copy(palette.warm);
      stele.faceMaterial.emissiveIntensity = palette.light ? 0.2 : 0.5;
      (stele.ripple.material as THREE.MeshBasicMaterial).color.copy(palette.warm);
      drawSteleFace(stele.faceCanvas, stele.post, stele.index, palette, coverImages[stele.index]);
      stele.faceTexture.needsUpdate = true;
    });

    brassMaterial.color.copy(palette.brass);
    brassMaterial.emissive.copy(palette.brass);

    armillaryMain.material.color.copy(palette.brass);
    armillaryMain.material.emissive.copy(palette.brass);
    armillarySmall.material.color.copy(palette.brass);
    armillarySmall.material.emissive.copy(palette.brass);
    armillaryMain.group.children.forEach((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
        child.material.color.copy(palette.warm);
      }
    });

    dustMaterial.color.copy(palette.warm);
    dustMaterial.opacity = palette.light ? 0.34 : 0.62;
    starMaterial.color.copy(palette.cool);

    if (bloomPass) bloomPass.strength = palette.light ? 0.24 : 0.52;

    renderer.toneMappingExposure = palette.light ? 1.02 : 1.06;
  }

  /* ---------- 动画 ---------- */

  let raf = 0;
  let lastTime = performance.now();
  let visible = true;
  let ready = false;

  function frame(now: number) {
    raf = window.requestAnimationFrame(frame);
    const dt = Math.min((now - lastTime) / 1000, 0.06);
    lastTime = now;

    if (!visible || document.hidden) return;

    applyCamera(dt);

    if (!reducedMotion) {
      armillaryMain.group.rotation.y += dt * 0.075;
      armillaryMain.group.rotation.x = Math.sin(now * 0.00018) * 0.08;
      armillarySmall.group.rotation.y -= dt * 0.052;
      dust.rotation.y += dt * 0.008;
      stars.rotation.y += dt * 0.0015;

      steles.forEach((stele) => {
        const material = stele.ripple.material as THREE.MeshBasicMaterial;
        const phase = (now * 0.00055 + stele.index * 0.19) % 1;
        material.opacity = (1 - phase) * 0.24;
        const scale = 0.9 + phase * 0.55;
        stele.ripple.scale.setScalar(scale);
      });
    }

    if (hovered >= 0) {
      const stele = steles[hovered];
      if (stele) stele.group.position.z = -5.35 + 0.12;
    }
    steles.forEach((stele) => {
      if (stele.index !== hovered) stele.group.position.z = lerp(stele.group.position.z, -5.35, 0.2);
    });

    updateHits();

    if (composer) composer.render();
    else renderer.render(scene, camera);

    if (!ready) {
      ready = true;
      stage!.classList.add('is-ready');
      window.setTimeout(() => loader?.setAttribute('hidden', ''), 900);
      openHashTarget();
    }
  }

  /* ---------- 事件 ---------- */

  const onScroll = () => readProgress();
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    targetPointerX = (event.clientX / window.innerWidth) * 2 - 1;
    targetPointerY = (event.clientY / window.innerHeight) * 2 - 1;
  };

  const onResize = () => {
    resize();
    layoutSteles();
    readProgress();
  };

  const themeObserver = new MutationObserver(() => applyTheme());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-theme-type'],
  });
  window.addEventListener('melodyxz:theme', applyTheme as EventListener);

  const io = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
    },
    { rootMargin: '120px' },
  );
  io.observe(stage);

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('visibilitychange', () => {
    lastTime = performance.now();
  });

  resize();
  readProgress();
  applyCamera(0);
  updateHits();
  raf = window.requestAnimationFrame(frame);

  // 字体就绪后重画一次，避免宋体回退
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => redrawFaces()).catch(() => {});
  }

  // 等主题脚本切完再读一次颜色
  window.setTimeout(() => applyTheme(), 60);

  /* ---------- 清理 ---------- */

  return () => {
    window.cancelAnimationFrame(raf);
    io.disconnect();
    themeObserver.disconnect();
    window.removeEventListener('melodyxz:theme', applyTheme as EventListener);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onPointerMove);
    dialog.close();
    composer?.dispose();
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
        object.geometry?.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      }
    });
    wallTexture.dispose();
    yearTexture.dispose();
    glowTexture.dispose();
    shadowTexture.dispose();
    steles.forEach((stele) => stele.faceTexture.dispose());
    renderer.dispose();
    root.dataset.arcReady = '0';
    stage?.classList.remove('is-ready', 'is-walking');
  };
}

/* ------------------------------------------------------------------ */
/* 启动 / 清理                                                          */
/* ------------------------------------------------------------------ */

function boot() {
  const root = document.querySelector<HTMLElement>('[data-arc]');
  if (!root) return;
  if (root.dataset.arcReady === '1') return;
  activeCleanup?.();
  activeCleanup = init(root);
}

document.addEventListener('astro:before-swap', () => {
  activeCleanup?.();
  activeCleanup = null;
});

document.addEventListener('astro:page-load', boot);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
