/**
 * 远航（LoadingTide）· 时间轴状态机
 * ============================================================
 * 整屏海天场景是换页时的过渡遮罩，这个文件负责两件事：
 *   ① 什么时候涨潮 / 靠岸 / 退潮（**时间轴驱动**：哪怕页面早就加载完了，
 *      也把整套动画演完再显示 —— 保证动画完整）
 *   ② 船的位置 = 真实进度；船的浮沉俯仰 = 脚下浪面的实时高度与斜率
 *
 * 一次完整的时间轴（约 2.4s，页面再快也一样）：
 *   涨潮 400ms → 航行 900ms（页面慢就继续航行，最多再蹭 4s）→
 *   靠岸 320ms → 停 120ms → 退潮 650ms
 *   页面就绪事件只是「允许进入靠岸」的信号，不会把动画掐断。
 *
 * 性能：船/太阳只写 transform、天空只写 opacity、海面整块平移 + canvas 绘制，
 * 全走合成层；不使用任何 filter / 大 box-shadow。
 * 头顶的像素大字是第二根进度条：船的中线开到哪个字母，哪个字母就点亮。
 *
 * 演示：?tide=4200（毫秒）自动播一遍；控制台 __tideDemo(4200) 随时重播。
 * 降级：prefers-reduced-motion 下浪不漂、船不摇，但涨潮/退潮仍然完整播放。
 * ============================================================
 */

type TideState = 'idle' | 'sailing' | 'dock' | 'drain';

/** 时间轴（毫秒）—— 想调节奏就改这几个数 */
const RISE_MS = 400; // 涨潮：海面升到满
const SAIL_MS = 900; // 航行：至少开这么久（页面再快也要走完）
const DOCK_MS = 320; // 靠岸：船冲到终点、太阳涨满
const HOLD_MS = 120; // 停一拍
const DRAIN_MS = 650; // 退潮：海面落回、天空淡出
const CREEP_MS = 4000; // 页面迟迟不就绪时，船再慢慢往前蹭的时间
const HARD_STOP = 12000; // 硬兜底：无论多慢都要让出页面

/** 满潮时海面占视口高度的比例（和 CSS 里 .tide__sea 的 height 保持一致） */
const SEA_RATIO = 0.46;

let el: HTMLElement | null = null;
let skyEl: HTMLElement | null = null;
let sunEl: HTMLElement | null = null;
let seaEl: HTMLElement | null = null;
let boatEl: HTMLElement | null = null;
let tiltEl: HTMLElement | null = null;
let captionText: HTMLElement | null = null;
let pctEl: HTMLElement | null = null;
let fillEl: HTMLElement | null = null;
let wordEl: HTMLElement | null = null;
let bladeEl: HTMLElement | null = null;
let letters: Element[] = [];

/* ---- 海：canvas 与浪面参数 ---- */
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let cw = 0; // canvas 的 CSS 宽度
let ch = 0; // canvas 的 CSS 高度
let seaCfg: {
  bands: { baseY: number; amp: number; len: number; speed: number; opacity: number }[];
} | null = null;
let colors = { far: '', mid: '', near: '', deep: '', crest: '' };
let boatW = 300;

/* ---- 运行状态 ---- */
let state: TideState = 'idle';
let seaY = 0; // 海面整块的平移量（px）：0 = 满潮，H = 沉到视口下方
let seaT = 0;
let sky = 0;
let skyT = 0;
let prog = 0; // 船的进度 0..1
let progT = 0;
let pitchNow = 0; // 平滑后的俯仰角（大船慢半拍）
let phase = 0; // 秒：波浪相位
let t0 = 0; // 本轮时间轴起点
let raf = 0;
let lastT = 0;
let reduced = false;
let timers: number[] = [];
let readyScheduled = false;
let demoOn = false;

const viewportH = () => window.innerHeight;
const viewportW = () => window.innerWidth;

/** 海面元素的**实际**高度：CSS 断点会改它，别再用固定比例算（手机 46vh / 桌面 55vh） */
const seaHeight = () => {
  const h = seaEl?.clientHeight ?? 0;
  return h > 0 ? h : viewportH() * SEA_RATIO;
};

/* ---------------- 小工具 ---------------- */

function later(fn: () => void, ms: number): void {
  timers.push(window.setTimeout(fn, ms));
}

function cancelTimers(): void {
  for (const id of timers) window.clearTimeout(id);
  timers = [];
}

/** 帧率无关的指数收敛系数 */
function easeK(speed: number, dt: number): number {
  return 1 - Math.pow(1 - speed, dt / 16.7);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function setCaption(text: string): void {
  if (captionText) captionText.textContent = text;
}

function setState(next: TideState): void {
  state = next;
  if (!el) return;
  el.dataset.state = next;
  el.classList.toggle('is-live', next === 'sailing' || next === 'dock');
}

/* ---------------- 像素大字：船开到哪个字母，就点亮哪个 ----------------
 * 「点亮」的判据和船的位置是同一个数：船的中线 x 越过字母中心就算点亮。
 * 所以大字是第二根进度条 —— 方向和节奏都和船、胶囊填充一致。
 * 光刃停在「已经亮完」的那一格右缘，靠 CSS transition 慢慢挪过去。
 * ------------------------------------------------------------------ */

let letterMid: number[] = []; // 每个字母中心（视口坐标 px）
let letterEnd: number[] = []; // 每个字母右缘（相对大字左缘 px）
const letterLit: boolean[] = [];
const lastWord = { blade: '', bladeOp: '' };

/** 量一次字母位置：只在初始化和 resize 时做，别放进帧循环 */
function measureWord(): void {
  if (!wordEl || !letters.length) return;
  const box = wordEl.getBoundingClientRect();
  letterMid = letters.map((g) => {
    const r = g.getBoundingClientRect();
    return r.left + r.width / 2;
  });
  letterEnd = letters.map((g) => g.getBoundingClientRect().right - box.left);
}

function resetWord(): void {
  for (let i = 0; i < letters.length; i++) {
    letters[i].classList.remove('is-lit');
    letterLit[i] = false;
  }
  if (bladeEl) {
    bladeEl.style.opacity = '0';
    bladeEl.style.transform = 'translate3d(0px, 0, 0)';
  }
  lastWord.blade = '';
  lastWord.bladeOp = '';
}

function lightWord(x: number): void {
  if (!letters.length) return;

  for (let i = 0; i < letters.length; i++) {
    // reduced-motion 下直接全亮，不做逐字点亮
    const lit = reduced || letterMid[i] === undefined || x >= letterMid[i];
    if (lit === letterLit[i]) continue;
    letterLit[i] = lit;
    letters[i].classList.toggle('is-lit', lit);
  }

  if (!bladeEl) return;
  let litCount = 0;
  for (let i = 0; i < letters.length; i++) if (letterLit[i]) litCount++;
  const all = litCount >= letters.length;

  const edge = all ? 0 : letterEnd[litCount - 1] ?? 0;
  const bxStr = `translate3d(${edge.toFixed(1)}px, 0, 0)`;
  if (bxStr !== lastWord.blade) {
    bladeEl.style.transform = bxStr;
    lastWord.blade = bxStr;
  }
  const op = all ? '0' : '1';
  if (op !== lastWord.bladeOp) {
    bladeEl.style.opacity = op;
    lastWord.bladeOp = op;
  }
}

/* ---------------- 海面：画在 canvas 上 ----------------
 * 波长/振幅按**像素**算，不按 canvas 的百分比：
 *   · 手机竖屏只有 390px 宽，百分比波长会被压成 78px 一排小尖峰（就是「波浪太高」的成因）
 *   · 这里给波长设 220px 下限、窄屏再把振幅收一档 —— 浪才是开阔的长涌
 * ------------------------------------------------------------------ */

interface BandMetric {
  len: number;
  amp: number;
}

const metrics: BandMetric[] = [];

function computeMetrics(): void {
  metrics.length = 0;
  if (!seaCfg) return;
  const narrow = cw < 640;
  for (const b of seaCfg.bands) {
    metrics.push({
      len: clamp((b.len / 100) * cw, 220, 420), // 波长：至少 220px，别碎成小尖峰
      amp: clamp((b.amp / 100) * ch * (narrow ? 0.45 : 1), 6, 70), // 振幅：窄屏收一档
    });
  }
}

/** 第 i 层浪此刻的横向偏移（px）：按像素/秒推进，窄屏不会变得跟爬一样 */
function shiftOf(i: number): number {
  const b = seaCfg?.bands[i];
  const m = metrics[i];
  if (!b || !m) return 0;
  return reduced ? 0 : (b.speed * phase * 14) % m.len;
}

/** 第 i 层浪在 x（px）处的浪面高度（px，从 canvas 顶部算） */
function surfPxAt(x: number, i: number, shiftPx: number): number {
  if (!seaCfg) return 0;
  const b = seaCfg.bands[i];
  const m = metrics[i];
  if (!b || !m) return 0;
  return (b.baseY / 100) * ch - m.amp * Math.cos((2 * Math.PI * (x + shiftPx)) / m.len);
}

function sizeCanvas(): void {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = viewportW();
  ch = Math.round(seaHeight());
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  computeMetrics();
}

/** 从隐藏探针读「解析后」的颜色（canvas 用不了 CSS 变量） */
function readColors(): void {
  if (!el) return;
  const pick = (cls: string, fallback: string): string => {
    const node = el!.querySelector<HTMLElement>('.' + cls);
    const bg = node ? getComputedStyle(node).backgroundColor : '';
    return bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : fallback;
  };
  colors = {
    far: pick('tide__probe--far', 'rgba(255,255,255,0.5)'),
    mid: pick('tide__probe--mid', 'rgba(255,255,255,0.65)'),
    near: pick('tide__probe--near', 'rgba(255,255,255,0.8)'),
    deep: pick('tide__probe--deep', 'rgba(120,120,160,0.9)'),
    crest: pick('tide__probe--crest', '#ffffff'),
  };
}

function drawSea(): void {
  if (!ctx || !seaCfg) return;
  const W = cw;
  const H = ch;
  ctx.clearRect(0, 0, W, H);

  const bands = seaCfg.bands;
  const fills = [colors.far, colors.mid, colors.near];
  const step = 12;

  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const m = metrics[i];
    if (!m) continue;
    const shift = shiftOf(i);

    // 浪面折线（步长 12px 足够平滑，比逐像素便宜得多）
    ctx.beginPath();
    for (let x = 0; x <= W + step; x += step) {
      const y = surfPxAt(x, i, shift);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // 封口到画布底部
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();

    const basePx = (b.baseY / 100) * H;
    const grad = ctx.createLinearGradient(0, basePx - m.amp, 0, H);
    grad.addColorStop(0, fills[i] || fills[fills.length - 1]);
    grad.addColorStop(1, colors.deep);
    ctx.globalAlpha = b.opacity;
    ctx.fillStyle = grad;
    ctx.fill();

    // 浪沿亮边（月光/反光）
    ctx.beginPath();
    for (let x = 0; x <= W + step; x += step) {
      const y = surfPxAt(x, i, shift);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = Math.min(1, b.opacity + 0.1);
    ctx.strokeStyle = colors.crest;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/* ---------------- 每帧绘制 ---------------- */

// 上一帧写过的值：没变就不重复写 style（减少每帧的样式失效）
const last = {
  seaY: '',
  sky: '',
  skyOp: '',
  sun: '',
  boat: '',
  tilt: '',
  boatOp: '',
  pct: -1,
  fill: '',
};

function paint(dt = 16.7): void {
  if (!el) return;

  const H = seaHeight();
  const visibleSea = clamp(H - seaY, 0, H);

  // 天空 / 太阳 / 海面：全是合成层属性
  const skyStr = sky.toFixed(3);
  if (skyEl && skyStr !== last.sky) {
    skyEl.style.opacity = skyStr;
    last.sky = skyStr;
  }
  // 大字和太阳都是「场景的一部分」：跟着天空一起淡入淡出
  if (skyStr !== last.skyOp) {
    if (sunEl) sunEl.style.opacity = skyStr;
    if (wordEl) wordEl.style.opacity = skyStr;
    last.skyOp = skyStr;
  }
  if (sunEl) {
    const sunStr = `translate(-50%, -50%) scale(${(0.55 + prog * 0.5).toFixed(3)})`;
    if (sunStr !== last.sun) {
      sunEl.style.transform = sunStr;
      last.sun = sunStr;
    }
  }
  if (seaEl) {
    const seaStr = `translate3d(0, ${seaY.toFixed(1)}px, 0)`;
    if (seaStr !== last.seaY) {
      seaEl.style.transform = seaStr;
      last.seaY = seaStr;
    }
  }

  // 进度：胶囊里的百分比 + 填充（和船的位置同一个数）
  const pct = Math.round(clamp(prog, 0, 1) * 100);
  if (pctEl && pct !== last.pct) {
    pctEl.textContent = String(pct);
    last.pct = pct;
  }
  if (fillEl) {
    const fillStr = `${(clamp(prog, 0, 1) * 100).toFixed(1)}%`;
    if (fillStr !== last.fill) {
      fillEl.style.width = fillStr;
      last.fill = fillStr;
    }
  }

  if (!boatEl || !tiltEl) return;

  // 船的水平位置 = 进度（留出船身宽度，别被屏幕边切掉）
  const half = boatW / 2;
  const minX = half + 10;
  const maxX = Math.max(minX + 1, viewportW() - half - 10);
  const surge = reduced ? 0 : Math.sin(phase * 0.8 + 0.6) * 3.5;
  const x = minX + (maxX - minX) * prog + surge;

  // 脚下那一点的浪面（和 canvas 用同一套公式、同一套像素参数）
  const bi = seaCfg ? seaCfg.bands.length - 1 : 0;
  let surfacePx = 0;
  let pitchTarget = 0;
  if (seaCfg && metrics[bi]) {
    const shift = shiftOf(bi);
    surfacePx = surfPxAt(x, bi, shift);
    // 斜率 → 俯仰角：±2px 采样，加个增益；夹在 ±6.5°
    const slopePx = (surfPxAt(x + 2, bi, shift) - surfPxAt(x - 2, bi, shift)) / 4;
    pitchTarget = clamp((Math.atan(slopePx * 0.12) * 180) / Math.PI, -6.5, 6.5);
  }

  // 俯仰做阻尼：大船不会跟着每个浪尖急转，慢半拍才像真的
  pitchNow += (pitchTarget - pitchNow) * easeK(0.09, dt);

  const bob = reduced ? 0 : Math.sin(phase * 1.15) * 4.5;
  // 船底（龙骨）压进水里 6px：
  //   从视口底部算起，水面高度 = (海块高 - 平移量) - 浪面在画布里距顶部的像素
  const y = H - seaY - surfacePx - 6 + bob;

  const opStr = clamp((visibleSea - 60) / 140, 0, 1).toFixed(3);
  if (opStr !== last.boatOp) {
    boatEl.style.opacity = opStr;
    last.boatOp = opStr;
  }
  const boatStr = `translate3d(${x.toFixed(1)}px, ${(-y).toFixed(1)}px, 0) translateX(-50%)`;
  if (boatStr !== last.boat) {
    boatEl.style.transform = boatStr;
    last.boat = boatStr;
  }
  const tiltStr = `rotate(${pitchNow.toFixed(2)}deg)`;
  if (tiltStr !== last.tilt) {
    tiltEl.style.transform = tiltStr;
    last.tilt = tiltStr;
  }

  // 大字：船的中线开到哪一格，哪一格点亮（和上面同一个 x）
  if (state === 'sailing' || state === 'dock') lightWord(x);

  drawSea();
}

function frame(now: number): void {
  raf = 0;
  const dt = Math.max(8, Math.min(48, now - lastT || 16.7));
  lastT = now;
  phase += dt / 1000;

  const elapsed = now - t0;

  if (state === 'sailing') {
    seaT = 0;
    skyT = 1;
    // 航行阶段：潮水已满，船按时间轴匀速往前开；页面迟迟不到就慢慢蹭
    const t = clamp((elapsed - RISE_MS) / SAIL_MS, 0, 1);
    const creep = clamp((elapsed - RISE_MS - SAIL_MS) / CREEP_MS, 0, 1) * 0.16;
    progT = Math.max(prog, 0.2 + 0.42 * t + creep);
  } else if (state === 'dock') {
    progT = 1;
  }

  // 弹簧：海面、天空、进度
  seaY += (seaT - seaY) * easeK(0.12, dt);
  if (Math.abs(seaT - seaY) < 0.4) seaY = seaT;
  sky += (skyT - sky) * easeK(0.14, dt);
  if (Math.abs(skyT - sky) < 0.004) sky = skyT;
  prog += (progT - prog) * easeK(0.06, dt);

  paint(dt);

  if (state !== 'idle') raf = window.requestAnimationFrame(frame);
}

function start(): void {
  if (raf) return;
  lastT = performance.now();
  raf = window.requestAnimationFrame(frame);
}

function stop(): void {
  if (raf) window.cancelAnimationFrame(raf);
  raf = 0;
}

/* ---------------- 时间轴 ---------------- */

/** 「页面就绪」只是允许进入靠岸的信号：至少要航行完 SAIL_MS */
function ready(): void {
  if (state !== 'sailing' || readyScheduled) return;
  readyScheduled = true;
  const due = Math.max(0, t0 + RISE_MS + SAIL_MS - performance.now());
  later(() => {
    if (state === 'sailing') dock();
  }, due);
}

function dock(): void {
  if (state !== 'sailing') return;
  setState('dock');
  later(drain, DOCK_MS + HOLD_MS);
}

function drain(): void {
  if (state === 'idle' || state === 'drain') return;
  setState('drain');
  seaT = seaHeight();
  skyT = 0;
  setCaption('');
  contentRise();
  later(finishToIdle, DRAIN_MS + 120);
}

function finishToIdle(): void {
  stop();
  setState('idle');
  seaY = seaHeight();
  seaT = seaY;
  sky = 0;
  skyT = 0;
  prog = 0;
  progT = 0;
  pitchNow = 0;
  setCaption('');
  resetWord();
  paint();
}

/** 硬兜底：无论网络多慢，12s 后也把动画走完、把页面让出来 */
function hardStop(): void {
  if (!el || state === 'idle' || state === 'drain') return;
  if (state === 'sailing') {
    ready();
    // ready() 若已被调用，就强制进入靠岸
    if (state === 'sailing') dock();
    return;
  }
  drain();
}

/** 正文从下方浮起：潮水退掉时内容「长」出来，而不是啪地出现 */
function contentRise(): void {
  if (reduced) return;
  const main = document.querySelector<HTMLElement>('#main');
  if (!main || typeof main.animate !== 'function') return;
  try {
    main.animate(
      [
        { opacity: 0.001, transform: 'translateY(16px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 680, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  } catch {
    /* 老浏览器不支持 Web Animations：跳过，不影响页面可用 */
  }
}

/* ---------------- 事件：一次换页（每次都播完整动画） ---------------- */

function begin(ev: Event): void {
  const nav = ev as Event & { to?: URL };
  // 同页锚点（只换 #hash）不凑热闹
  if (nav.to && nav.to.pathname === location.pathname && nav.to.search === location.search) return;
  if (!el) return;

  cancelTimers();
  demoOn = false;
  readyScheduled = false;
  t0 = performance.now();

  // 新的一轮：海面从视口下方升起来（上一轮如果还没退完，就从当前位置接着涨）
  seaT = 0;
  skyT = 1;
  // 进度往回压到起点（上一轮要是还停在终点，船会从右边突然出现、大字一上来就全亮）
  prog = Math.min(prog, 0.2);
  progT = Math.max(prog, 0.2);
  setState('sailing');
  setCaption('正在驶向下一站…');
  resetWord();
  readColors();
  start();

  later(() => {
    if (state === 'sailing') setCaption('海面有点挤，正在靠岸…');
  }, RISE_MS + SAIL_MS + 1500);

  later(hardStop, HARD_STOP);
}

/** 新文档可用了：把要去的文章名写进说明文字 */
function beforeSwap(ev: Event): void {
  if (state !== 'sailing' && state !== 'dock') return;
  const doc = (ev as Event & { newDocument?: Document }).newDocument;
  const title = doc?.querySelector('title')?.textContent?.split('·')[0]?.trim() ?? '';
  if (title) setCaption(`正在靠岸：《${title}》`);
}

function pageLoad(): void {
  if (!el || demoOn) return;
  // 兜底：万一 after-swap 没来（比如首屏），也允许进入靠岸
  ready();
}

/** DOM 换完了就算「页面就绪」——不等图片，更不等 astro:page-load（它要等 runScripts 跑完） */
function afterSwap(): void {
  if (!el || demoOn) return;
  ready();
}

/* ---------------- 首屏：一进来就是满潮 ---------------- */

function intro(): void {
  // 写作 / 配置 / 媒体 / 后台这些工具页不挡
  if (/^\/(write|config|media|admin)(\/|$)/.test(location.pathname)) {
    finishToIdle();
    return;
  }
  // 页面已经整页加载完了（多为缓存命中）：没必要再挡一下
  if (document.readyState === 'complete') {
    finishToIdle();
    return;
  }
  if (!el) return;

  cancelTimers();
  demoOn = false;
  readyScheduled = false;
  t0 = performance.now();

  seaY = 0; // 首屏第一帧就是满潮（CSS 默认也是）
  seaT = 0;
  sky = 1;
  skyT = 1;
  prog = 0.16;
  progT = 0.2;
  setState('sailing');
  resetWord();
  readColors();
  const title = document.title.split('·')[0]?.trim();
  setCaption(title ? `正在载入《${title}》` : '正在载入…');
  paint();
  start();

  // 首屏不等 window.load（大图多时能等十几秒，那才是「卡住」的感觉）：
  // 直接按时间轴走完 —— 涨潮已经在 CSS 里就位，航行满 900ms 后自然靠岸。
  ready();
  later(hardStop, HARD_STOP);
}

/* ---------------- 演示：?tide / __tideDemo ---------------- */

function demo(ms = 4200): void {
  if (!el) return;
  cancelTimers();
  demoOn = true;
  readyScheduled = false;
  t0 = performance.now();

  seaY = seaHeight();
  seaT = 0;
  sky = 0;
  skyT = 1;
  prog = 0.02;
  progT = 0.2;
  setState('sailing');
  resetWord();
  setCaption('正在驶向《示例：第四章 I2C：协议、读写数据与 OLED 显示》');
  readColors();
  paint();
  start();

  later(() => {
    if (state === 'sailing') setCaption('海面有点挤，正在靠岸…');
  }, Math.max(RISE_MS + SAIL_MS + 1500, ms));
  // 演示：到点就当作「页面就绪」，时间轴会保证之后的靠岸/退潮照样走完
  later(ready, Math.max(RISE_MS + SAIL_MS, ms));
  later(hardStop, HARD_STOP);
}

/* ---------------- 启动 ---------------- */

function init(): void {
  el = document.querySelector<HTMLElement>('[data-tide]');
  if (!el) return;

  skyEl = el.querySelector<HTMLElement>('.tide__sky');
  sunEl = el.querySelector<HTMLElement>('[data-tide-sun]');
  seaEl = el.querySelector<HTMLElement>('[data-tide-sea]');
  canvas = el.querySelector<HTMLCanvasElement>('[data-tide-canvas]');
  boatEl = el.querySelector<HTMLElement>('[data-tide-boat]');
  tiltEl = el.querySelector<HTMLElement>('[data-tide-tilt]');
  captionText = el.querySelector<HTMLElement>('[data-tide-caption-text]');
  pctEl = el.querySelector<HTMLElement>('[data-tide-pct]');
  fillEl = el.querySelector<HTMLElement>('[data-tide-fill]');
  wordEl = el.querySelector<HTMLElement>('[data-tide-word]');
  bladeEl = el.querySelector<HTMLElement>('[data-tide-blade]');
  letters = wordEl ? Array.from(wordEl.querySelectorAll('.tide__letter')) : [];

  try {
    seaCfg = JSON.parse(el.dataset.sea ?? 'null');
  } catch {
    seaCfg = null;
  }

  boatW = boatEl?.offsetWidth ?? 300;
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  sizeCanvas();
  measureWord();
  window.addEventListener('resize', () => {
    boatW = boatEl?.offsetWidth ?? 300;
    sizeCanvas();
    measureWord();
    readColors();
  });

  // 先把海藏起来（首屏除外：首屏由 intro() 抬起）
  seaY = seaHeight();
  seaT = seaY;
  sky = 0;
  skyT = 0;

  document.addEventListener('astro:before-preparation', begin);
  document.addEventListener('astro:before-swap', beforeSwap);
  document.addEventListener('astro:after-swap', afterSwap);
  document.addEventListener('astro:page-load', pageLoad);

  const raw = new URLSearchParams(location.search).get('tide');
  if (raw !== null) {
    const ms = Number.parseInt(raw, 10);
    demo(Number.isFinite(ms) && ms > 0 ? ms : 4200);
  } else {
    intro();
  }
}

declare global {
  interface Window {
    __tideDemo?: (ms?: number) => void;
    /** 调试用：手动推进 n 帧（无头浏览器里 rAF 会被节流，拿它取景/验帧） */
    __tidePulse?: (frames?: number, at?: number) => void;
  }
}

window.__tideDemo = demo;
// 只有演示模式才挂这个：把「看帧」能力留给调参的人
// at >= 0 时直接把进度钉在该值（取某一刻的静态画面用，比如大字亮到一半）
window.__tidePulse = (frames = 1, at = -1) => {
  for (let i = 0; i < frames; i++) {
    phase += 1 / 60;
    if (at >= 0) prog = progT = clamp(at, 0, 1);
    seaY += (seaT - seaY) * easeK(0.12, 16.7);
    sky += (skyT - sky) * easeK(0.14, 16.7);
    prog += (progT - prog) * easeK(0.06, 16.7);
    paint(16.7);
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
