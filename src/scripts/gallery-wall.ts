/**
 * 照片墙引擎
 * ============================================================
 * 一整块可以拖着走的照片海。所有位置都在客户端算，DOM 只负责渲染。
 *
 * 一、排版
 * ------------------------------------------------------------
 * 瀑布流：列宽固定、列对齐、行不对齐。每列维护一份「已占用区间」表，
 * 放一张照片就是往区间表里插一段，找位置就是顺着区间表往下跳 ——
 * 这样放大时在中间挖出来的洞，上面剩余的空隙还能被后来的照片填上，
 * 不会留下死角。见 firstFit / occupy / clearFrom。
 *
 * 二、放大（本页的灵魂）
 * ------------------------------------------------------------
 * 点一张照片，它**原地扩大成整数列宽**：
 *   宽 = k 列 + (k-1) 个间隙，高 = 宽 ÷ 宽高比（绝不拉伸、不裁剪）
 * 于是左右两条边正好落在列的分界上、四周只剩一个标准间隙。
 * 它下方这一段列里的照片整体往下让，重新在「这几列」里找位置 ——
 * 只动被挤到的那几列，其它列一动不动，所以看起来是「旁边几张被推开」，
 * 而不是整页重排。
 *
 * 三、相机
 * ------------------------------------------------------------
 * cam = 画布坐标里「视口左上角」的位置；screen = canvas - cam。
 * stage 只做 translate3d，全是合成层，拖几百张图也不掉帧。
 * 桌面端：左键拖动 = 二维平移（带橡皮筋回弹），滚轮**完全不接管**（只滚页面）。
 * 窄屏：不做相机，退化成竖向瀑布，靠页面自己滚。
 *
 * 四、进入
 * ------------------------------------------------------------
 * 桌面端整页只有 100svh + 幕布高度 的可视高度：滚轮往下，波浪 banner
 * 像幕布一样升起来，照片海整屏接管；初始落在画布正中，可以往任意方向拖。
 *
 * ⚠ 和 album.astro 的 DOM 契约：
 *   [data-gal] [data-gal-settings]
 *   [data-gal-curtain] [data-gal-spacer] [data-gal-stars]
 *   [data-gal-view] [data-gal-stage] [data-gal-dim] [data-gal-glow]
 *   [data-gal-cell] + data-id / -w / -h / -tags / -src / -title / -desc / -date
 *   [data-gal-rail] [data-gal-rail-toggle] [data-gal-chips] [data-gal-tag] [data-gal-count]
 *   [data-gal-action="reset"], [data-gal-hint], [data-gal-empty]
 *   [data-gal-lb] 及 -canvas / -img / -cap / -count / -prev / -next / -close / -zin / -zout / -fit
 * ============================================================
 */

import { onPageLoad, onBeforeSwap } from './pageload';
import {
  DEFAULT_SETTINGS,
  SETTING_RANGE,
  clampNumber,
  type GallerySettings,
} from '../utils/gallery-shared';

/** 位移超过这个值就算拖拽，不再当成点击（px） */
const DRAG_START = 5;
/** 程序化移动相机的过渡时长（要和 gallery.css 里的 --gal-dur 一致） */
const CAM_DUR = 500;
/** 被顶到的那一列，顶上那张最多能裁到多高还留着（再矮就干脆让它整张下移） */
const MIN_KEEP = 48;
/** 拖出边界之后还能拉出去多少（0 = 拉不动，1 = 完全自由），松开回弹 */
const RUBBER = 0.34;
/** 灯箱最大放大倍数 */
const LB_MAX_ZOOM = 6;
/** 窄屏 / 触屏走「竖着滚」的模式，不开相机 */
const SCROLL_QUERY = '(max-width: 899px), (pointer: coarse)';
/** 竖向标签栏展开状态存在这儿 */
const RAIL_KEY = 'melodyxz-gal-rail';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell {
  el: HTMLElement;
  id: string;
  aspect: number;
  tags: string[];
  rect: Rect;
  /** 元素的基准宽度（px）：transform 里的 scale 是相对它算的 */
  baseW: number;
  /** 上一次写进 style 的高度，没变就不重复写（减少样式失效） */
  boxH: number;
  visible: boolean;
}

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  camX: number;
  camY: number;
  moved: boolean;
}

/** 已占用区间：[起, 止]，同一列内按起点升序 */
type Span = [number, number];

function must<T extends HTMLElement>(scope: ParentNode, selector: string): T {
  const el = scope.querySelector<T>(selector);
  if (!el) throw new Error(`照片墙缺少元素 ${selector}`);
  return el;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 读设置：逐项夹到合理区间，缺的用缺省值 */
function readSettings(raw: string | undefined): GallerySettings {
  let source: Partial<GallerySettings> = {};
  try {
    source = raw ? (JSON.parse(raw) as Partial<GallerySettings>) : {};
  } catch {
    source = {};
  }
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof GallerySettings>) {
    const range = SETTING_RANGE[key];
    const value = source[key];
    out[key] = clampNumber(
      typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SETTINGS[key],
      range.min,
      range.max,
    );
  }
  return out;
}

/* ============================================================
   背景里的星尘 / 星云
   ------------------------------------------------------------
   照片海外面那圈「空白」不能真是一片死黑：
   越往外拖，星尘和星云也在跟着缓慢移动，看起来像这片海没有边界，
   但橡皮筋又明确告诉你「到头了」。
   色值从主题里探一次（oklch(var(--bc)) / var(--p)），canvas 用 globalAlpha
   控制浓度，所以明暗两套主题都不用改代码。
   ============================================================ */

class Dust {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dots: Array<{ x: number; y: number; r: number; a: number; d: number; ph: number }> = [];
  private glow: HTMLCanvasElement | null = null;
  private raf = 0;
  private time = 0;
  private last = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private camX = 0;
  private camY = 0;
  private fg = '#9fb4d4';
  private tint = '#7aa2ff';
  private reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('照片墙：取不到 2D 画布');
    this.ctx = ctx;
    this.readColors();
    this.resize();
    if (this.reduced) this.drawOnce();
    else this.start();
  }

  /** 从主题变量里探两个颜色（探针元素交给浏览器解析成 canvas 认识的写法） */
  private readColors(): void {
    try {
      const probe = document.createElement('i');
      probe.setAttribute(
        'style',
        'position:absolute;left:-9999px;top:0;width:0;height:0;' +
          'color:oklch(var(--bc));background-color:oklch(var(--p));',
      );
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const fg = style.color.trim();
      const tint = style.backgroundColor.trim();
      probe.remove();
      if (fg) this.fg = fg;
      if (tint) this.tint = tint;
    } catch {
      /* 探不到就用缺省色 */
    }
  }

  /** 换主题：重新探色 + 重画星云 */
  recolor(): void {
    this.readColors();
    this.buildGlow();
    if (this.reduced) this.drawOnce();
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    // 星尘数量跟面积走，大屏多一点，手机上少一点（省电）
    const count = clamp(Math.round((width * height) / 11000), 50, 180);
    this.dots = Array.from({ length: count }, () => {
      // 一小部分是「大颗浮尘」，其余是细碎的亮点
      const bokeh = Math.random() < 0.14;
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        r: bokeh ? 3 + Math.random() * 5 : 0.5 + Math.random() * 1.9,
        a: bokeh ? 0.06 + Math.random() * 0.08 : 0.16 + Math.random() * 0.5,
        // 视差深度：越大的点离镜头越近、跟着相机动得越快
        d: bokeh ? 0.16 + Math.random() * 0.2 : 0.03 + Math.random() * 0.16,
        ph: Math.random() * Math.PI * 2,
      };
    });

    this.buildGlow();
    if (this.reduced) this.drawOnce();
  }

  /** 预渲染一层「星云」：几个大而软的径向色团，每帧直接 drawImage，便宜 */
  private buildGlow(): void {
    const { width, height } = this;
    if (!width || !height) return;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * this.dpr);
    canvas.height = Math.round(height * this.dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(this.dpr, this.dpr);

    const blobs = [
      { x: 0.18, y: 0.22, r: 0.42, a: 0.2 },
      { x: 0.82, y: 0.72, r: 0.5, a: 0.17 },
      { x: 0.62, y: 0.1, r: 0.3, a: 0.13 },
      { x: 0.26, y: 0.86, r: 0.34, a: 0.12 },
    ];
    for (const blob of blobs) {
      const radius = Math.max(width, height) * blob.r;
      const cx = width * blob.x;
      const cy = height * blob.y;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, this.tint);
      gradient.addColorStop(1, 'transparent');
      ctx.globalAlpha = blob.a;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.glow = canvas;
  }

  /** 相机动了，星尘跟着动一点点（视差） */
  setCamera(x: number, y: number): void {
    this.camX = x;
    this.camY = y;
    if (this.reduced) this.drawOnce();
    else if (!this.raf) this.start();
  }

  private start(): void {
    if (this.raf) return;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    const delta = this.last ? Math.min(now - this.last, 64) : 16;
    this.last = now;
    this.time += delta;
    this.draw();
  };

  private drawOnce(): void {
    this.draw();
  }

  private draw(): void {
    const { ctx, width, height, dpr } = this;
    if (!width || !height) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (this.glow) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.drawImage(this.glow, -this.camX * 0.02, -this.camY * 0.02, width, height);
      ctx.restore();
    }

    ctx.fillStyle = this.fg;
    for (const dot of this.dots) {
      // 每颗星按自己的深度反着推：相机往右走，星尘往左漂
      const x = mod(dot.x - this.camX * dot.d, width);
      const y = mod(dot.y - this.camY * dot.d, height);
      const twinkle = this.reduced ? 1 : 0.72 + 0.28 * Math.sin(this.time * 0.0009 + dot.ph);
      ctx.globalAlpha = dot.a * twinkle;
      ctx.beginPath();
      ctx.arc(x, y, dot.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  destroy(): void {
    this.stop();
  }
}

function mod(value: number, size: number): number {
  if (!size) return 0;
  return ((value % size) + size) % size;
}

/* ============================================================
   主引擎
   ============================================================ */

class Wall {
  private root: HTMLElement;
  private view: HTMLElement;
  private stage: HTMLElement;
  private dim: HTMLElement;
  private glow: HTMLElement | null;
  private rail: HTMLElement | null;
  private curtain: HTMLElement | null;
  private spacer: HTMLElement | null;
  private hint: HTMLElement | null;
  private lb: HTMLElement | null;
  private dust: Dust | null = null;

  private settings: GallerySettings;
  private cells: Cell[] = [];
  private byId = new Map<string, Cell>();

  private mode: 'camera' | 'scroll' = 'camera';
  private query = window.matchMedia(SCROLL_QUERY);

  /** 视口尺寸（相机模式 = 整屏；滚动模式 = 页面宽 × 画布高） */
  private vw = 0;
  private vh = 0;
  /** 一列多宽、缝多宽、一共几列、画布多大 */
  private colW = 232;
  private gap = 8;
  private cols = 12;
  private boardW = 0;
  private boardH = 0;
  /** 滚动模式下画布的左右留白 */
  private originX = 0;

  /** 每列的已占用区间 */
  private occ: Span[][] = [];

  /** 相机：画布坐标里视口左上角的位置 */
  private cam = { x: 0, y: 0 };
  /** 进聚焦之前相机在哪（退出时回去） */
  private camBefore = { x: 0, y: 0 };
  private focusId: string | null = null;
  private focusRect: Rect | null = null;
  /** 最近一次 fitColumn 的诊断串（只写进 data-gal-focus，排查底边对齐时用） */
  private fitDebug = '';

  private activeTag: string | null = null;
  private drag: Drag | null = null;
  private suppressClick = false;
  private resizeTimer = 0;
  private hintTimer = 0;

  /** 灯箱状态 */
  private lbIds: string[] = [];
  private lbIndex = -1;
  private lbZoom = 1;
  private lbPan = { x: 0, y: 0 };
  private lbDrag: { id: number; x: number; y: number; px: number; py: number } | null = null;

  private curtainH = 0;
  /** 幕布的 rAF 跟随（见 followCurtain） */
  private curtainRaf = 0;
  private curtainScrollY = -1;
  private destroyed = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.view = must(root, '[data-gal-view]');
    this.stage = must(root, '[data-gal-stage]');
    this.dim = must(root, '[data-gal-dim]');
    this.glow = root.querySelector<HTMLElement>('[data-gal-glow]');
    this.rail = root.querySelector<HTMLElement>('[data-gal-rail]');
    this.curtain = root.querySelector<HTMLElement>('[data-gal-curtain]') ??
      document.querySelector<HTMLElement>('[data-gal-curtain]');
    this.spacer = document.querySelector<HTMLElement>('[data-gal-spacer]');
    this.hint = root.querySelector<HTMLElement>('[data-gal-hint]');
    this.lb = document.querySelector<HTMLElement>('[data-gal-lb]');

    this.settings = readSettings(root.dataset.galSettings);
    this.gap = this.settings.gap;

    this.collectCells();
    this.initRail();
    this.initStars();
    this.initLightbox();
    this.bind();

    this.applyMode();
    this.layout({ instant: true });
    this.reveal();
    this.restoreFromUrl();
    this.updateHint();
  }

  /* ---------------- 初始化 ---------------- */

  private collectCells(): void {
    const nodes = this.root.querySelectorAll<HTMLElement>('[data-gal-cell]');
    nodes.forEach((el, index) => {
      const w = Number(el.dataset.w);
      const h = Number(el.dataset.h);
      const aspect = w > 0 && h > 0 ? clamp(w / h, 0.28, 4) : 3 / 4;
      const cell: Cell = {
        el,
        id: el.dataset.id ?? `p${index}`,
        aspect,
        tags: (el.dataset.tags ?? '').split(' ').filter(Boolean),
        rect: { x: 0, y: 0, w: 0, h: 0 },
        baseW: 232,
        boxH: 0,
        visible: true,
      };
      el.style.setProperty('--gal-i', String(Math.min(index, 40)));
      this.cells.push(cell);
      this.byId.set(cell.id, cell);
    });
  }

  private initRail(): void {
    if (!this.rail) return;
    const saved = (() => {
      try {
        return localStorage.getItem(RAIL_KEY);
      } catch {
        return null;
      }
    })();
    // 窄屏（竖着滚的模式）分类栏默认收起，别一上来就压住半屏照片
    const open = this.query.matches ? saved === 'open' : saved !== 'closed';
    this.root.classList.toggle('gal-rail-open', open);
    const toggleEl = this.rail.querySelector<HTMLElement>('[data-gal-rail-toggle]');
    toggleEl?.setAttribute('aria-expanded', String(open));

    const toggle = toggleEl;
    toggle?.addEventListener('click', () => {
      const next = !this.root.classList.contains('gal-rail-open');
      this.root.classList.toggle('gal-rail-open', next);
      toggle.setAttribute('aria-expanded', String(next));
      try {
        localStorage.setItem(RAIL_KEY, next ? 'open' : 'closed');
      } catch {
        /* 隐私模式下写不进去就算了 */
      }
      // 展开/收起会改变画布左边的可用区域，拖拽边界不用变，但提示要更新
      this.clampCam(false);
    });

    for (const chip of this.rail.querySelectorAll<HTMLElement>('[data-gal-tag]')) {
      chip.addEventListener('click', () => {
        this.setTag(chip.dataset.galTag || null);
      });
    }
  }

  private initStars(): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>('[data-gal-stars]');
    if (!canvas || this.query.matches) {
      canvas?.classList.add('is-off');
      return;
    }
    try {
      this.dust = new Dust(canvas);
    } catch (error) {
      console.warn('[gallery] 星尘图层初始化失败', error);
    }
    // 换主题要重新探色（星尘颜色是从 --bc / --p 探出来的）
    this.themeObserver = new MutationObserver(() => this.dust?.recolor());
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  private themeObserver: MutationObserver | null = null;

  private initLightbox(): void {
    const lb = this.lb;
    if (!lb) return;
    // 挪到 body 下：`main` 有自己的 z-index 叠层，灯箱留在里面会被悬浮导航盖住
    document.body.append(lb);

    must(lb, '[data-gal-lb-close]').addEventListener('click', () => this.closeLb());
    must(lb, '[data-gal-lb-prev]').addEventListener('click', () => this.stepLb(-1));
    must(lb, '[data-gal-lb-next]').addEventListener('click', () => this.stepLb(1));
    must(lb, '[data-gal-lb-zin]').addEventListener('click', () => this.zoomLb(1.5));
    must(lb, '[data-gal-lb-zout]').addEventListener('click', () => this.zoomLb(1 / 1.5));
    must(lb, '[data-gal-lb-fit]').addEventListener('click', () => this.resetLb());

    const canvas = must(lb, '[data-gal-lb-canvas]');
    canvas.addEventListener('wheel', this.onLbWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onLbDown);
    canvas.addEventListener('pointermove', this.onLbMove);
    canvas.addEventListener('pointerup', this.onLbUp);
    canvas.addEventListener('pointercancel', this.onLbUp);
    canvas.addEventListener('dblclick', this.onLbDouble);
    // 点空白处关闭（点图不关，方便继续放大看）
    canvas.addEventListener('click', (event) => {
      if (event.target === canvas) this.closeLb();
    });
    lb.addEventListener('click', (event) => {
      if (event.target === lb) this.closeLb();
    });
  }

  private bind(): void {
    this.view.addEventListener('pointerdown', this.onPointerDown);
    this.view.addEventListener('pointermove', this.onPointerMove);
    this.view.addEventListener('pointerup', this.onPointerUp);
    this.view.addEventListener('pointercancel', this.onPointerUp);
    this.stage.addEventListener('click', this.onClick);
    window.addEventListener('resize', this.onResize, { passive: true });
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('keydown', this.onKeyDown);
    this.query.addEventListener('change', this.onResize);

    for (const button of this.root.querySelectorAll<HTMLElement>('[data-gal-action]')) {
      button.addEventListener('click', () => {
        if (button.dataset.galAction === 'reset') this.resetCam();
      });
    }
  }

  /* ---------------- 尺寸与网格 ---------------- */

  private measure(): void {
    if (this.mode === 'camera') {
      // ⚠ 这里读的是 .gal 自己的盒子（= 视口），**不是** .gal-view 的 clientHeight。
      // 滚动模式下脚本会给 .gal-view 写内联 height（= 画布高），窗口一变宽切回
      // 相机模式时那串内联高还留着，量出来就是一万多像素 —— 于是 spacer 被撑成
      // 一万多，页面能滚出去几十屏，滚轮再也回不到最上面的 Banner（修过的坑）。
      // ⚠ 视口尺寸只信 window.innerHeight / CSS 的 100svh：
      // 绝不能拿 .gal 的 clientHeight 当视口高（祖先临时变成 fixed 包含块时它会变成
      // 整个 main 的高度，vh 被一步步带偏 → 列数缩水 → 整片墙挪位，踩过这个坑）。
      this.vw = Math.round(this.root.clientWidth || window.innerWidth);
      this.vh = Math.round(window.innerHeight || this.root.clientHeight || 800);
      this.view.style.height = '';
      const banner = this.curtain?.getBoundingClientRect().height ?? 0;
      this.curtainH = Math.round(banner);
      // 幕布自己就在文档流里，占掉 bannerH；再补一屏，页面正好能滚过 banner 的高度。
      // （滚到底 = 幕布整块出了视口 = 照片海整屏；往回滚一定回得到顶）
      if (this.spacer) this.spacer.style.height = `${Math.round(this.vh)}px`;
    } else {
      this.vw = Math.round(this.view.clientWidth || window.innerWidth);
      this.vh = Math.round(window.innerHeight);
      this.curtainH = 0;
      if (this.spacer) this.spacer.style.height = '0px';
    }
  }

  /** 列宽 / 列数：横向铺 boardWidth 个屏幕宽，竖向上至少能拖得动一屏 */
  private computeGrid(): void {
    const s = this.settings;
    const gap = this.gap;

    if (this.mode === 'scroll') {
      // 手机：列宽给到「一屏两列」的大图（照片墙在手机上要够大才好看）
      const scale = clamp(this.vw / 1440, 0.6, 1);
      this.colW = clamp(s.columnWidth * scale, 168, 300);
      this.cols = Math.max(2, Math.round((this.vw + gap) / (this.colW + gap)));
      this.colW = (this.vw - gap * (this.cols - 1)) / this.cols;
      this.originX = 0;
      this.boardW = this.vw;
      return;
    }

    this.originX = 0;
    this.colW = clamp(s.columnWidth * clamp(this.vw / 1440, 0.72, 1.16), 150, 340);
    const byWidth = Math.round((s.boardWidth * this.vw + gap) / (this.colW + gap));
    this.cols = clamp(byWidth, 4, 90);

    // 照片太少的话照这个列数排会「又宽又扁」，竖着根本拖不动；
    // 拿总高度反推一个更窄的列数，宁可变窄也要让上下有事可做。
    // ⚠ 只统计「当前可见」的那些：筛完只剩 30 张时还要摊成 19 列就成了一条横幅。
    const totalH = this.visibleCells().reduce((sum, cell) => sum + this.colW / cell.aspect, 0);
    const targetH = this.vh * 1.45;
    if (totalH > 0) {
      const byHeight = Math.ceil(totalH / targetH);
      this.cols = clamp(Math.min(this.cols, byHeight), 4, 90);
    }
    this.boardW = this.cols * this.colW + (this.cols - 1) * gap;
  }

  private resetOcc(): void {
    this.occ = Array.from({ length: this.cols }, () => [] as Span[]);
  }

  /** 在第 col 列里找第一个 ≥ from、且能放下高 h 的位置 */
  private firstFit(col: number, h: number, from: number): number {
    const gaps = this.gap;
    const spans = this.occ[col];
    if (!spans) return Math.max(0, from);
    let y = Math.max(0, from);
    for (let guard = 0; guard < 500; guard += 1) {
      let hit: Span | null = null;
      for (const span of spans) {
        if (span[1] <= y - gaps) continue; // 完全在上面
        if (span[0] >= y + h + gaps) break; // 已经完全在下面（区间有序）
        hit = span;
        break;
      }
      if (!hit) return y;
      y = hit[1] + gaps;
    }
    return y;
  }

  private occupy(col: number, y: number, h: number): void {
    const spans = this.occ[col];
    let index = 0;
    while (index < spans.length && spans[index][0] < y) index += 1;
    spans.splice(index, 0, [y, y + h]);
  }

  /** 把第 col 列 y 以下（含 y）的占用全部清掉（放大排版 / 以后要插队时用） */
  private clearFrom(col: number, y: number): void {
    this.occ[col] = this.occ[col].filter((span) => span[0] < y);
  }

  private visibleCells(): Cell[] {
    return this.cells.filter((cell) => cell.visible);
  }

  /* ---------------- 排版 ---------------- */

  private layout(options: { instant?: boolean } = {}): void {
    this.measure();
    this.computeGrid();
    this.setBase();
    if (this.focusId) this.packFocus();
    else this.packNormal();
    this.paint(options.instant === true);
    this.updateBoard();
    // 调试用：一行就能看出这次的网格参数（排查「列数自己会变」这类问题时救命）
    this.root.dataset.galGrid =
      `${this.vw}x${this.vh} mode=${this.mode} colW=${Math.round(this.colW * 10) / 10} ` +
      `cols=${this.cols} board=${Math.round(this.boardW)}x${Math.round(this.boardH)}`;
    this.dim.classList.toggle('is-on', this.focusId !== null);
    this.root.classList.toggle('gal-focus', this.focusId !== null);
  }

  /** 元素的基础宽度只在列宽变化时才写；高度在 paint 里按排版结果写（可能要裁切） */
  private setBase(): void {
    for (const cell of this.cells) {
      const width = Math.round(this.colW * 100) / 100;
      if (cell.baseW === width) continue;
      cell.baseW = width;
      cell.el.style.width = `${width}px`;
    }
  }

  /** 普通排版：按顺序往下铺，每张落在「最先能放下」的那一列 */
  private packNormal(): void {
    this.resetOcc();
    this.focusRect = null;
    for (const cell of this.cells) {
      if (!cell.visible) continue;
      const h = Math.round(this.colW / cell.aspect);
      let bestCol = 0;
      let bestY = Infinity;
      for (let col = 0; col < this.cols; col += 1) {
        const y = this.firstFit(col, h, 0);
        if (y < bestY - 0.5 || (Math.abs(y - bestY) <= 0.5 && col < bestCol)) {
          bestY = y;
          bestCol = col;
        }
      }
      this.occupy(bestCol, bestY, h);
      cell.rect = {
        x: bestCol * (this.colW + this.gap),
        y: bestY,
        w: this.colW,
        h,
      };
    }
    this.alignBottom();
  }

  /**
   * 「谁更能裁」：一张缩略图最多能牺牲多少（比例是相对它自己的高度）
   * ------------------------------------------------------------
   * 缩略图是 `object-fit: cover` 的**取景框**，把框改矮/改高只是换了个取景范围，
   * 图片本身不会变形。所以底边差多少，就按下面这套余量分摊掉：
   *   · 竖图（9:16）上下本来就有富余 —— 缩掉 45% 正好就是「9:16 变 1:1」的方裁；
   *   · 方图次之；3:2 一类横图压扁一点就是宽幅取景，给 26%；全景几乎没有余量。
   * 这些只是上限，实际每一列通常只摊到 5%~10%，肉眼基本看不出来。
   */
  private cropRoom(cell: Cell): { down: number; up: number } {
    const a = cell.aspect;
    if (a <= 0.8) return { down: 0.45, up: 0.32 }; // 竖图：可以一路牺牲到方裁
    if (a <= 1.15) return { down: 0.34, up: 0.3 }; // 方图
    if (a <= 1.8) return { down: 0.26, up: 0.28 }; // 3:2 一类横图：压扁一点就是宽幅取景
    return { down: 0.2, up: 0.24 }; // 全景：几乎没有余量
  }

  /** 按列分组，每列按 y 升序（排版阶段每一列都是一条互不重叠的纵向队列） */
  private groupColumns(): Cell[][] {
    const pitch = this.colW + this.gap;
    const cols: Cell[][] = Array.from({ length: this.cols }, () => [] as Cell[]);
    for (const cell of this.cells) {
      if (!cell.visible) continue;
      const col = Math.round(cell.rect.x / pitch);
      if (col >= 0 && col < this.cols) cols[col].push(cell);
    }
    for (const list of cols) list.sort((a, b) => a.rect.y - b.rect.y);
    return cols;
  }

  /** 一列还能缩 / 还能涨多少像素（按 cropRoom 的余量累加） */
  private columnRoom(list: Cell[]): { down: number; up: number } {
    let down = 0;
    let up = 0;
    for (const cell of list) {
      const room = this.cropRoom(cell);
      down += Math.max(0, Math.min(cell.rect.h * room.down, cell.rect.h - MIN_KEEP));
      up += cell.rect.h * room.up;
    }
    return { down, up };
  }

  /**
   * 把 list（已按 y 升序）从 y0 开始按 8px 的缝**重堆**，总高正好落在 bottom：
   * 差多少就按「可裁余量」分摊到每一张的高度上（= 换取景框，不变形），
   * 于是列内只会上下挪几十像素，列与列之间的水平对齐一点都不动。
   * `roomScale` > 1 是「实在不够了，允许再深一点」的第二档（只给放大态兜底用）。
   * 返回没消化掉的差值（已取绝对值）：0 = 正好齐，>0 = 余量用尽，还差这么多。
   */
  private fitColumn(list: Cell[], y0: number, bottom: number, roomScale = 1): number {
    const n = list.length;
    if (!n) return 0;
    const gaps = this.gap * (n - 1);
    const cur = list.reduce((sum, cell) => sum + cell.rect.h, 0);
    const delta = Math.max(0, bottom - y0 - gaps) - cur;
    if (Math.abs(delta) <= 0.75) {
      // 高度不用动，但位置可能被前面的排版挪过，顺手重堆一遍
      let y = y0;
      for (const cell of list) {
        cell.rect.y = y;
        y += cell.rect.h + this.gap;
      }
      return 0;
    }
    const sign = delta < 0 ? -1 : 1;
    const caps = list.map((cell) => {
      const room = this.cropRoom(cell);
      return sign < 0
        ? Math.max(0, Math.min(cell.rect.h * room.down * roomScale, cell.rect.h - MIN_KEEP))
        : Math.max(0, cell.rect.h * room.up * roomScale);
    });
    const total = caps.reduce((sum, v) => sum + v, 0);
    if (total <= 0.5) {
      this.fitDebug = `n${n} cur${Math.round(cur)} t${Math.round(Math.max(0, bottom - y0 - gaps))} d${Math.round(delta)} cap0`;
      return Math.abs(delta);
    }
    const used = Math.min(1, Math.abs(delta) / total);
    this.fitDebug = `n${n} cur${Math.round(cur)} t${Math.round(Math.max(0, bottom - y0 - gaps))} d${Math.round(delta)} cap${Math.round(total)} u${used.toFixed(2)}`;
    let y = y0;
    for (let i = 0; i < n; i += 1) {
      const cell = list[i];
      cell.rect.h += sign * caps[i] * used;
      cell.rect.y = y;
      y += cell.rect.h + this.gap;
    }
    return Math.abs(delta) - total * used;
  }

  /**
   * 底边对齐（idle：「最下面的边框也要齐」，而且不许整片墙一起变胖）
   * ------------------------------------------------------------
   * 瀑布流各列的底边天然是锯齿。以前是「整列等比拉长到最长那列」——
   * 短列要被拉 30%~90%，看起来就是刻意拉出来的。现在改成：
   *   ① 在 [最矮的列底, 最高的列底] 之间解一个 **minimax** 目标线：
   *      让「裁得最狠的那一列」裁得最少（19 列各自摊 5%~10%，谁都不显眼）；
   *   ② 每列用 fitColumn 分摊 —— 竖图多担一点（9:16 → 3:4 → 1:1），
   *      横图几乎不动，缝仍然是 8px，从列顶重新堆。
   * 和照片数量无关：三张的列、十张的列、筛完只剩几张都一样成立。
   * ⚠ 放大照（hero）在 fitColumn 里不会被特殊照顾 —— 基准版面它是普通一张，
   *   放大排版时才把它排除（那时它必须保持原比例）。
   */
  private alignBottom(): void {
    interface Entry {
      list: Cell[];
      top: number;
      natural: number;
      down: number;
      up: number;
    }
    const entries: Entry[] = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (const list of this.groupColumns()) {
      if (!list.length) continue;
      const last = list[list.length - 1];
      const natural = last.rect.y + last.rect.h;
      const room = this.columnRoom(list);
      entries.push({ list, top: list[0].rect.y, natural, down: room.down, up: room.up });
      lo = Math.min(lo, natural);
      hi = Math.max(hi, natural);
    }
    if (!entries.length || hi - lo < 1) return;

    // 目标线越靠近某列的自然底边，那一列就越省事；取「最费事的列」最省事的那个点
    const worst = (target: number): number => {
      let w = 0;
      for (const e of entries) {
        const d = target - e.natural;
        if (Math.abs(d) < 1) continue;
        const room = d < 0 ? e.down : e.up;
        w = Math.max(w, room <= 0.5 ? 99 : Math.abs(d) / room);
      }
      return w;
    };
    let a = lo;
    let b = hi;
    for (let i = 0; i < 48; i += 1) {
      const m1 = a + (b - a) / 3;
      const m2 = b - (b - a) / 3;
      if (worst(m1) <= worst(m2)) b = m2;
      else a = m1;
    }
    const target = (a + b) / 2;
    for (const e of entries) this.fitColumn(e.list, e.top, target);
  }

  /**
   * 放大排版（整个引擎最关键的一段）
   * ------------------------------------------------------------
   * 原则四条：
   *   ① **原地放大**：放大照不会「飞」到别处 —— 它的上下边沿用 idle 时的高度，
   *      左右边只有一格，靠左（默认往右长）或者靠右（往左长）时那条边钉死不动。
   *      相机和重排**同时**进行（两个位移叠在一起才流畅），放大照在长、镜头在滑，
   *      最后它正好停在屏幕正中。
   *   ② **只动被顶到的那 k 列**：基准版面直接用普通排版的结果（和 idle 一模一样），
   *      于是除了这 k 列，其它照片连 transform 都不变。
   *   ③ **上下两边行对齐**：这 k 列里
   *        · 跨着放大照上边的照片 → 原地裁短（只改缩略图高度，位置不动），
   *          底边正好停在放大照上边留一格缝的位置；
   *        · 其余被挤到的照片 → 整列整体下移，第一张正好贴在放大照下边留一格缝的位置。
   *      于是放大照的上、下、左、右四条边都和网格线/邻居的边齐平。
   *   ④ **至少 2 列**：1 列等于没放大（竖图以前就吃了这个亏）。
   *      放大照自己永远保持原比例（看大图这点不让步），高度超上限只往少列退，
   *      退到 2 列还超高就让它超出屏幕 —— 那正是灯箱存在的意义。
   */
  private packFocus(): void {
    const hero = this.focusId ? this.byId.get(this.focusId) : null;
    if (!hero || !hero.visible) {
      this.focusId = null;
      this.packNormal();
      return;
    }

    // ① 基准版面 = 普通排版（确定性，所以就是 idle 里那些位置）
    this.packNormal();

    const gap = this.gap;
    const pitch = this.colW + gap;
    const maxH = this.settings.focusMaxHeight * this.vh;
    // 竖着滚的窄屏没有相机，放大直接到接近满宽
    const ratio =
      this.mode === 'scroll' ? Math.max(0.88, this.settings.focusWidth) : this.settings.focusWidth;
    const targetW = ratio * this.vw;

    // ② 目标宽度 → 整数列数：最少 2 列，最多 cols 列
    let k = clamp(Math.round((targetW + gap) / pitch), 2, Math.max(2, this.cols));
    while (k > 2 && (k * this.colW + (k - 1) * gap) / hero.aspect > maxH) k -= 1;
    const heroW = k * this.colW + (k - 1) * gap;
    const heroH = heroW / hero.aspect; // 永远是原比例，不裁

    // ③ 方向：默认从它自己的那一列往右长；右边放不下（贴在最右那几列）就改成
    //    **往左长**。不管哪种，**靠边的那条边一点都不动** —— 照片海不会被顶出边界，
    //    只会向内推挤（以前是硬把 originCol 夹回画布里，整张照片会突然往左跳一格）。
    let originCol = Math.round(hero.rect.x / pitch);
    const growRight = originCol + k <= this.cols;
    if (!growRight) originCol = Math.max(0, this.cols - k);
    const x = growRight ? hero.rect.x : hero.rect.x + this.colW - heroW;

    // ④ 纵向：带的**下边一根线都不许越过基准底线**。
    //    放得下就原地放大；放不下（照片本来就贴着下边那几排）就把整条带往上让一点点 ——
    //    让的量只够「底边正好落在基准底线上」，多一像素都不给。
    //    ⚠ 千万别再把带上方的照片整体压紧（`openBandUp` 那套）：那等于把 k 列的内容
    //      全都挤到带上方，放大照旁边立刻空出一块几百像素的缺口 —— 「空白」就是这么来的。
    const idleBottom = hero.rect.y + hero.rect.h;
    let boardBottom = 0;
    for (const cell of this.cells) {
      if (cell.visible) boardBottom = Math.max(boardBottom, cell.rect.y + cell.rect.h);
    }
    const line = boardBottom; // 基准底线（alignBottom 之后是一根直线）
    const yTop = clamp(Math.min(hero.rect.y, line - heroH), 0, Math.max(0, line));
    const yBot = yTop + heroH;

    // ⑤ 被顶到的每一列各自让位（挤得开就挤，挤不开就让放大照盖住，底线不动）
    for (let col = originCol; col < originCol + k; col += 1) {
      this.openBand(col, yTop, yBot, line, hero);
    }

    hero.rect = { x, y: yTop, w: heroW, h: heroH };
    this.focusRect = { ...hero.rect };
    this.root.dataset.galFocus =
      `idle=${Math.round(hero.rect.y)}..${Math.round(idleBottom)} line=${Math.round(line)} ` +
      `heroH=${Math.round(heroH)} band=${Math.round(yTop)}..${Math.round(yBot)} k=${k} col=${originCol}` +
      ` fit=${this.fitDebug}`;
  }

  /**
   * 在第 col 列里给放大照腾出 [yTop, yBot] 这一段，**而且下边一根线都不许越过 `line`**。
   *
   * · 跨着带上边的那张：原地裁到 yTop − gap（缝还是一格）—— 这就是「改缩略图比例」，
   *   裁剩不到 MIN_KEEP 的就不裁，归到下面「让不开」那一堆。
   * · 上边补缝：整张都在带上方的最后一张接到 yTop − gap（拉伸不超过 1.6 倍），
   *   换来放大照上边一条干干净净的直线。
   * · 带里 / 带下面那些（`rest`）分两种命运：
   *     ① **挤得开**：带下面还有地方（yBot < 底线），而且它们的总高按「谁更能裁」
   *        压得进去 → 整堆下移到 yBot + gap，再压回底线。这就是普通放大时
   *        「邻居被排挤、让位」的观感（中途只会被裁掉 5%~30%）。
   *     ② **挤不开**：放大照本来就贴着底线那几排，带下面根本没地方 →
   *        它们留在原地（全在放大照底下，一点都看不见），只把最后一张拉到基准底线上，
   *        这样下边缘依然是齐的、也不会顶出去；退出放大它们原样回来。
   *   两种情况都不动带上方、不动上边（0），所以「上下两条边都是直线」永远成立。
   */
  private openBand(col: number, yTop: number, yBot: number, line: number, hero: Cell): void {
    const gap = this.gap;
    const pitch = this.colW + gap;
    const list = this.cells
      .filter((cell) => cell.visible && cell !== hero && Math.round(cell.rect.x / pitch) === col)
      .sort((a, b) => a.rect.y - b.rect.y);
    if (!list.length) return;

    const above: Cell[] = [];
    const rest: Cell[] = [];
    list.forEach((cell, i) => {
      const top = cell.rect.y;
      const bottom = top + cell.rect.h;
      const hasAfter = i < list.length - 1; // 后面还有照片，底线还得靠它们撑住
      if (bottom <= yTop + 0.5) {
        above.push(cell); // 整张都在放大照上方，不动
        return;
      }
      if (hasAfter && top < yTop - 0.5) {
        const keep = yTop - gap - top; // 裁到放大照上边留一格缝
        if (keep >= MIN_KEEP) {
          cell.rect.h = keep;
          above.push(cell);
          return;
        }
      }
      rest.push(cell);
    });

    const tail = above[above.length - 1];
    if (tail && rest.length) {
      // 补缝不能顶进下面那张（跨着带上边、但短到裁不了的那张还留在原地）
      const want = Math.min(yTop - gap - tail.rect.y, rest[0].rect.y - gap - tail.rect.y);
      if (want > tail.rect.h + 0.5 && want / tail.rect.h <= 1.6) tail.rect.h = want;
    }
    if (!rest.length) return;

    // ① 挤得动吗：把 rest 整堆塞进 [yBot + gap, line]
    //    ⚠ 带上方一张照片都没有（放大照就贴着照片海的上边那条线）时也不能挤：
    //      挤下去这 k 列的上边就空出一块，上边缘那条直线就断了 —— 同理让它盖住。
    const from = yBot + gap;
    const room = line - from;
    const span = rest.reduce((sum, cell) => sum + cell.rect.h, 0) + gap * (rest.length - 1);
    const need = span - Math.max(0, room);
    const cap = Math.min(this.columnRoom(rest).down, span - rest.length * MIN_KEEP);
    if (above.length && room > 0.5 && (need <= 0.5 || need <= cap + 0.5)) {
      const delta = from - rest[0].rect.y;
      if (delta > 0.5) for (const cell of rest) cell.rect.y += delta;
      this.fitColumn(rest, from, line);
      return;
    }

    // ② 挤不开：这一堆全在放大照底下（一点都看不见），把最后一张拉到基准底线上，
    //    这一列的下边缘照样是齐的 —— 它们一个像素都不占版面，退出放大原样回来。
    const last = rest[rest.length - 1];
    const want = line - last.rect.y;
    if (want > last.rect.h + 0.5) last.rect.h = want;
  }

  /* ---------------- 画到屏幕上 ---------------- */

  private paint(instant: boolean): void {
    if (instant) {
      this.stage.classList.add('is-instant');
      // 连着两帧之后再摘：一帧之内摘掉的话，浏览器会把这次位移也当成「过渡」去补间
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => this.stage.classList.remove('is-instant'));
      });
    }
    for (const cell of this.cells) {
      const rect = cell.rect;
      if (!rect.w) continue;
      const scale = rect.w / cell.baseW;
      const x = Math.round((rect.x + this.originX) * 100) / 100;
      const y = Math.round(rect.y * 100) / 100;

      // 高度写的是「缩放前的盒子高」：等比缩放之后正好等于 rect.h。
      // 如果 rect 的宽高比和照片本身不一样（放大时要给别的照片腾地方），
      // 这里就会短一点/长一点，img 的 object-fit: cover 负责裁切 —— 不变形。
      const boxH = Math.round((rect.h / scale) * 100) / 100;
      if (Math.abs(boxH - cell.boxH) > 0.5) {
        cell.boxH = boxH;
        cell.el.style.height = `${boxH}px`;
      }

      cell.el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    }
    this.updateGlow();
  }

  /** 放大那张背后的光晕（跟着画布一起走，所以放在 stage 里） */
  private updateGlow(): void {
    const el = this.glow;
    if (!el) return;
    const rect = this.focusRect;
    if (!rect) {
      el.style.opacity = '0';
      return;
    }
    const pad = Math.min(rect.w, rect.h) * 0.45;
    el.style.width = `${rect.w + pad * 2}px`;
    el.style.height = `${rect.h + pad * 2}px`;
    el.style.transform = `translate3d(${rect.x + this.originX - pad}px, ${rect.y - pad}px, 0)`;
    el.style.opacity = '1';
  }

  private updateBoard(): void {
    let bottom = 0;
    for (const cell of this.cells) {
      if (!cell.visible) continue;
      bottom = Math.max(bottom, cell.rect.y + cell.rect.h);
    }
    this.boardH = bottom;
    this.stage.style.width = `${Math.round(this.boardW)}px`;
    this.stage.style.height = `${Math.round(this.boardH)}px`;

    if (this.mode === 'scroll') {
      this.view.style.height = `${Math.round(this.boardH + this.gap)}px`;
      this.clampCam(false);
      return;
    }

    this.clampCam(!this.focusId);
    this.updateCurtain();
  }

  private reveal(): void {
    window.requestAnimationFrame(() => {
      this.stage.classList.add('is-ready');
    });
  }

  /* ---------------- 相机 ---------------- */

  /**
   * 相机的合法范围。
   * `withFocus` = true（拖动 / 回弹用）时把「让放大照居中」的那个 cam 值并进区间，
   * 这样贴边的照片也能被推到正中（越出去的那片交给星尘兜着）。
   * `withFocus` = false 是**程序化居中**用的：只允许露出画布边框外 pad 那么一点点，
   * 于是放大最下面那几排时，镜头不会把「照片海的下边缘」推到屏幕中间、
   * 让下面半屏空着（那半屏空着很容易被看成排版破了）。
   */
  private camBounds(withFocus = true): { minX: number; maxX: number; minY: number; maxY: number } {
    const padX = this.vw * 0.06;
    const padY = this.vh * 0.06;
    const spanX = this.boardW - this.vw;
    const spanY = this.boardH - this.vh;

    // 画布比视口小的时候（比如刚筛完只剩几张）把它摆在正中，
    // 别贴着左上角、下面留一大片空
    let minX = spanX >= 0 ? -padX : spanX / 2 - padX * 0.35;
    let maxX = spanX >= 0 ? spanX + padX : spanX / 2 + padX * 0.35;
    let minY = spanY >= 0 ? -padY : spanY / 2 - padY * 0.35;
    let maxY = spanY >= 0 ? spanY + padY : spanY / 2 + padY * 0.35;

    // 放大那张可能贴在画布边上，相机要能把它推到正中（外面交给星尘兜着）；
    // 竖图放大后可能比视口还高，所以上下两端都得能拖到
    if (withFocus && this.focusRect) {
      const fx = this.focusRect.x;
      const fy = this.focusRect.y;
      const fw = this.focusRect.w;
      const fh = this.focusRect.h;
      const cx = fx + fw / 2 - this.vw / 2;
      const cy = fy + fh / 2 - this.vh / 2;
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy, fy - padY);
      maxY = Math.max(maxY, cy, fy + fh - this.vh + padY);
    }
    return { minX, maxX, minY, maxY };
  }

  private clampCam(animate: boolean): void {
    const bounds = this.camBounds();
    const target = {
      x: clamp(this.cam.x, bounds.minX, bounds.maxX),
      y: clamp(this.cam.y, bounds.minY, bounds.maxY),
    };
    if (Math.abs(target.x - this.cam.x) < 0.5 && Math.abs(target.y - this.cam.y) < 0.5) {
      this.applyCam();
      return;
    }
    this.moveCam(target.x, target.y, animate);
  }

  private applyCam(): void {
    if (this.mode === 'scroll') {
      this.stage.style.transform = 'none';
      return;
    }
    this.stage.style.transform = `translate3d(${-Math.round(this.cam.x * 100) / 100}px, ${
      -Math.round(this.cam.y * 100) / 100
    }px, 0)`;
    this.dust?.setCamera(this.cam.x, this.cam.y);
  }

  private moveCam(x: number, y: number, animate: boolean): void {
    this.cam.x = x;
    this.cam.y = y;
    if (animate && this.mode === 'camera') {
      this.stage.classList.add('is-moving');
      window.clearTimeout(this.moveTimer);
      this.moveTimer = window.setTimeout(() => {
        this.stage.classList.remove('is-moving');
      }, CAM_DUR + 40);
    } else {
      this.stage.classList.remove('is-moving');
    }
    this.applyCam();
  }

  private moveTimer = 0;

  /** 弹性：超出边界之后越拉越拉不动 */
  private elastic(value: number, min: number, max: number): number {
    if (value < min) return min - (min - value) * RUBBER;
    if (value > max) return max + (value - max) * RUBBER;
    return value;
  }

  private centerCamera(animate: boolean): void {
    if (this.mode === 'scroll') return;
    const bounds = this.camBounds();
    this.moveCam(
      clamp(this.boardW / 2 - this.vw / 2, bounds.minX, bounds.maxX),
      clamp(this.boardH / 2 - this.vh / 2, bounds.minY, bounds.maxY),
      animate,
    );
  }

  private resetCam(): void {
    if (this.focusId) {
      this.unfocus(true);
      return;
    }
    this.centerCamera(true);
  }

  /* ---------------- 交互 ---------------- */

  private onPointerDown = (event: PointerEvent): void => {
    if (this.mode !== 'camera' || event.button !== 0) return;
    if (this.lb?.classList.contains('is-open')) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-gal-rail], [data-gal-hint], [data-gal-lb]')) return;

    this.drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      camX: this.cam.x,
      camY: this.cam.y,
      moved: false,
    };
    this.suppressClick = false;
    // 注意：这里**不能**捕获指针。捕获会让随后的 click 事件落到 .gal-view 上，
    // 照片按钮就永远收不到点击了。等真的拖起来（超过阈值）再捕获。
  };

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;

    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_START && Math.abs(dy) < DRAG_START) return;
      drag.moved = true;
      this.suppressClick = true;
      this.stage.classList.remove('is-moving');
      this.view.classList.add('is-dragging');
      this.hideHint();
      try {
        this.view.setPointerCapture(event.pointerId);
      } catch {
        /* 某些合成事件没有捕获权，忽略 */
      }
    }

    const bounds = this.camBounds();
    this.cam.x = this.elastic(drag.camX - dx, bounds.minX, bounds.maxX);
    this.cam.y = this.elastic(drag.camY - dy, bounds.minY, bounds.maxY);
    this.applyCam();
  };

  private onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    this.view.classList.remove('is-dragging');
    try {
      this.view.releasePointerCapture(event.pointerId);
    } catch {
      /* 没捕获过就算了 */
    }
    if (drag.moved) this.clampCam(true);
  };

  private onClick = (event: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-gal-cell]');
    if (!target) return;
    const id = target.dataset.id;
    if (!id) return;
    event.preventDefault();
    this.handleTap(id);
  };

  private handleTap(id: string): void {
    if (this.focusId === id) {
      // 第二次点：进灯箱
      this.openLb(id);
      return;
    }
    this.focus(id);
  }

  private onScroll = (): void => {
    this.followCurtain();
  };

  /**
   * 幕布本身是普通滚动内容（见 gallery.css），不需要脚本搬它。
   * 这里只用滚动进度喂两件纯装饰的事：分类栏/提示的淡入（--gal-enter）、
   * 以及「已经完全进场」这个类。
   * 排一帧 rAF 再读位置：程序化滚动/平滑滚动时，scroll 事件回调里读到的
   * window.scrollY 常常还是上一帧的值，直接读会让淡入慢一拍。
   * 位置还在变就继续排下一帧，稳住就自己停 —— 不常驻 rAF。
   */
  private followCurtain(): void {
    if (this.curtainRaf) return;
    this.curtainRaf = window.requestAnimationFrame(this.tickCurtain);
  }

  private tickCurtain = (): void => {
    this.curtainRaf = 0;
    this.updateCurtain();
    const y = Math.round(window.scrollY);
    if (y !== this.curtainScrollY) {
      this.curtainScrollY = y;
      this.curtainRaf = window.requestAnimationFrame(this.tickCurtain);
    }
  };

  /** 进场进度（0 = 幕布还挡着，1 = 整屏都是照片） */
  private updateCurtain(): void {
    if (this.mode !== 'camera' || !this.curtainH) return;
    const progress = clamp(window.scrollY / this.curtainH, 0, 1);
    this.root.classList.toggle('gal-entered', progress > 0.98);
    this.root.style.setProperty('--gal-enter', String(progress));
  }

  private onResize = (): void => {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.applyMode();
      this.layout({ instant: true });
      if (this.focusId) this.centerOnFocus(false);
      else this.clampCam(false);
      this.dust?.resize();
    }, 140);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.lb?.classList.contains('is-open')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (this.lbZoom > 1.01) this.resetLb();
        else this.closeLb();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.stepLb(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.stepLb(1);
      }
      return;
    }
    if (event.key === 'Escape' && this.focusId) {
      event.preventDefault();
      this.unfocus(false);
    }
  };

  /* ---------------- 聚焦 / 取消 ---------------- */

  /**
   * 点一下 → 重排 + 镜头平移**同时**开始：
   * 照片直接在原地长成 k 列宽（周围的照片裁短/下移让开），
   * 同一时刻镜头滑过去把它摆到正中。两个位移叠成一段连续动画，
   * 中间没有任何「等一拍」的空档，所以是流畅的一条。
   */
  private focus(id: string): void {
    const cell = this.byId.get(id);
    if (!cell || !cell.visible) return;
    if (!this.focusId) this.camBefore = { ...this.cam };
    this.focusId = id;

    // 点照片就是想用照片海了：如果幕布还挡着，顺手把它推上去
    if (this.mode === 'camera' && this.curtainH && window.scrollY < this.curtainH - 6) {
      window.scrollTo({ top: this.curtainH, behavior: 'smooth' });
    }

    for (const other of this.cells) {
      other.el.classList.toggle('is-focus', other === cell);
    }
    this.stage.classList.add('is-focused');
    this.hideHint();

    this.layout();
    this.centerOnFocus(true);
    this.syncUrl();
  }

  private unfocus(animate: boolean): void {
    if (!this.focusId) return;
    const previous = this.focusId;
    this.focusId = null;
    for (const cell of this.cells) cell.el.classList.remove('is-focus');
    this.stage.classList.remove('is-focused');

    this.layout();
    this.moveCam(this.camBefore.x, this.camBefore.y, animate);
    this.clampCam(animate);
    this.syncUrl();

    const cell = this.byId.get(previous);
    if (cell) {
      cell.el.focus?.({ preventScroll: true });
      cell.el.classList.add('is-pinged');
      window.setTimeout(() => cell.el.classList.remove('is-pinged'), 720);
    }
  }

  private centerOnFocus(animate: boolean): void {
    const rect = this.focusRect;
    if (!rect) return;

    if (this.mode === 'scroll') {
      // 竖向瀑布里没有相机，直接把它滚到视口中间偏上
      const top = this.view.getBoundingClientRect().top + window.scrollY + rect.y;
      window.scrollTo({
        top: Math.max(0, top - this.vh * 0.16),
        behavior: animate ? 'smooth' : 'auto',
      });
      return;
    }

    const bounds = this.camBounds(false);
    let x = clamp(rect.x + rect.w / 2 - this.vw / 2, bounds.minX, bounds.maxX);
    let y = clamp(rect.y + rect.h / 2 - this.vh / 2, bounds.minY, bounds.maxY);
    // 尽量居中，但**绝不把放大照切掉**（它要是比视口还大就按上边对齐，看全图交给灯箱）
    if (rect.y + rect.h > y + this.vh) y = rect.y + rect.h - this.vh;
    if (rect.x + rect.w > x + this.vw) x = rect.x + rect.w - this.vw;
    if (rect.y < y) y = rect.y;
    if (rect.x < x) x = rect.x;
    this.moveCam(x, y, animate);
  }

  /* ---------------- 标签筛选 ---------------- */

  private setTag(tag: string | null): void {
    const next = tag && tag !== '全部' ? tag : null;
    if (next === this.activeTag) return;
    this.activeTag = next;

    for (const chip of this.root.querySelectorAll<HTMLElement>('[data-gal-tag]')) {
      const chipTag = chip.dataset.galTag || null;
      chip.setAttribute('aria-pressed', String((chipTag || null) === next));
    }
    for (const cell of this.cells) {
      const match = !next || cell.tags.includes(next);
      cell.visible = match;
      cell.el.classList.toggle('is-filtered', !match);
      cell.el.setAttribute('tabindex', match ? '0' : '-1');
    }

    if (this.focusId && !this.byId.get(this.focusId)?.visible) {
      this.focusId = null;
      for (const cell of this.cells) cell.el.classList.remove('is-focus');
      this.stage.classList.remove('is-focused');
    }

    this.layout();
    this.centerCamera(true);
    this.syncUrl();
    this.hideHint();
  }

  /* ---------------- 地址栏 ---------------- */

  private syncUrl(): void {
    const url = new URL(window.location.href);
    if (this.focusId) url.searchParams.set('p', this.focusId);
    else url.searchParams.delete('p');
    if (this.activeTag) url.searchParams.set('tag', this.activeTag);
    else url.searchParams.delete('tag');
    if (url.href === window.location.href) return;
    window.history.replaceState(window.history.state, '', url.href);
  }

  private restoreFromUrl(): void {
    const params = new URLSearchParams(window.location.search);
    const tag = params.get('tag');
    if (tag) this.setTag(tag);

    const id = params.get('p');
    if (!id) {
      // 初始落在画布正中（不是左上角）
      if (this.mode === 'camera') this.centerCamera(false);
      return;
    }
    const cell = this.byId.get(id);
    if (!cell || !cell.visible) {
      if (this.mode === 'camera') this.centerCamera(false);
      return;
    }
    // 深链进来要立刻到位，不能从左上角飞过去
    this.stage.classList.add('is-instant');
    if (this.mode === 'camera' && this.curtainH) {
      // 幕布也直接掀到底
      window.scrollTo(0, this.curtainH);
      this.curtainScrollY = -1;
      this.followCurtain();
    }
    this.focusId = id;
    cell.el.classList.add('is-focus');
    this.stage.classList.add('is-focused');
    this.layout({ instant: true });
    this.centerOnFocus(false);
    window.requestAnimationFrame(() => this.stage.classList.remove('is-instant'));
  }

  /* ---------------- 模式 / 提示 ---------------- */

  private applyMode(): void {
    this.mode = this.query.matches ? 'scroll' : 'camera';
    this.root.dataset.galMode = this.mode;
    document.documentElement.classList.toggle('gal-camera', this.mode === 'camera');

    if (this.mode === 'scroll') {
      // 窄屏：幕布就是普通的一屏高首图，照片海在它下面接着排，spacer 不需要
      if (this.spacer) this.spacer.style.height = '0px';
      this.root.style.removeProperty('--gal-enter');
    } else {
      this.cam.x = this.boardW / 2 - this.vw / 2;
      this.cam.y = this.boardH / 2 - this.vh / 2;
    }
  }

  private updateHint(): void {
    if (!this.hint) return;
    // 一张照片都没有的时候就别提示「点一下放大」了
    if (!this.visibleCells().length) {
      this.hideHint();
      return;
    }
    this.hint.textContent =
      this.mode === 'camera'
        ? '按住左键拖动 · 点一下放大 · 再点看大图'
        : '点一下放大 · 再点看大图';
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hideHint(), 7000);
  }

  private hideHint(): void {
    this.hint?.classList.add('is-hidden');
  }

  /* ---------------- 灯箱 ---------------- */

  private openLb(id: string): void {
    if (!this.lb) return;
    this.lbIds = this.visibleCells().map((cell) => cell.id);
    const index = this.lbIds.indexOf(id);
    this.lbIndex = index < 0 ? 0 : index;
    this.lb.hidden = false;
    // 先显示（display 变了）再加类，否则过渡不触发
    window.requestAnimationFrame(() => this.lb?.classList.add('is-open'));
    document.documentElement.classList.add('gal-lb-open');
    this.showLb(false);
  }

  private closeLb(): void {
    if (!this.lb) return;
    this.lb.classList.remove('is-open');
    document.documentElement.classList.remove('gal-lb-open');
    window.setTimeout(() => {
      if (this.lb && !this.lb.classList.contains('is-open')) this.lb.hidden = true;
    }, 260);
    const cell = this.focusId ? this.byId.get(this.focusId) : null;
    cell?.el.focus?.({ preventScroll: true });
  }

  private showLb(animate: boolean): void {
    if (!this.lb) return;
    const id = this.lbIds[this.lbIndex];
    const cell = id ? this.byId.get(id) : null;
    if (!cell) return;

    const img = must<HTMLImageElement>(this.lb, '[data-gal-lb-img]');
    img.src = cell.el.dataset.src ?? '';
    img.alt = cell.el.dataset.title || '照片';
    this.lbZoom = 1;
    this.lbPan = { x: 0, y: 0 };

    const cap = this.lb.querySelector<HTMLElement>('[data-gal-lb-cap]');
    if (cap) {
      const title = cell.el.dataset.title ?? '';
      const desc = cell.el.dataset.desc ?? '';
      const date = cell.el.dataset.date ?? '';
      cap.innerHTML = `${title ? `<strong>${escapeHtml(title)}</strong>` : ''}${
        desc ? `<span>${escapeHtml(desc)}</span>` : ''
      }${date ? `<span>${escapeHtml(date)}</span>` : ''}`;
    }
    const count = this.lb.querySelector<HTMLElement>('[data-gal-lb-count]');
    if (count) count.textContent = `${this.lbIndex + 1} / ${this.lbIds.length}`;

    this.applyLb(animate);
  }

  private applyLb(animate: boolean): void {
    if (!this.lb) return;
    const img = this.lb.querySelector<HTMLImageElement>('[data-gal-lb-img]');
    if (!img) return;
    img.classList.toggle('is-animating', animate);
    img.style.transform = `translate(-50%, -50%) translate(${this.lbPan.x}px, ${
      this.lbPan.y
    }px) scale(${this.lbZoom})`;
  }

  private resetLb(): void {
    this.lbZoom = 1;
    this.lbPan = { x: 0, y: 0 };
    this.applyLb(true);
  }

  private stepLb(direction: number): void {
    if (!this.lbIds.length) return;
    const next = (this.lbIndex + direction + this.lbIds.length) % this.lbIds.length;
    this.lbIndex = next;
    const img = this.lb?.querySelector<HTMLImageElement>('[data-gal-lb-img]');
    if (img) img.classList.remove('is-animating');
    this.showLb(true);
  }

  private zoomLb(factor: number, clientX?: number, clientY?: number): void {
    if (!this.lb) return;
    const next = clamp(this.lbZoom * factor, 1, LB_MAX_ZOOM);
    if (Math.abs(next - this.lbZoom) < 0.0001) return;

    const canvas = this.lb.querySelector<HTMLElement>('[data-gal-lb-canvas]');
    if (canvas && typeof clientX === 'number' && typeof clientY === 'number') {
      const box = canvas.getBoundingClientRect();
      // 以光标为中心缩放：先算光标相对图片中心的偏移，再按倍数修正平移
      const cx = clientX - (box.left + box.width / 2);
      const cy = clientY - (box.top + box.height / 2);
      const ratio = next / this.lbZoom;
      this.lbPan.x = cx - (cx - this.lbPan.x) * ratio;
      this.lbPan.y = cy - (cy - this.lbPan.y) * ratio;
    }
    this.lbZoom = next;
    if (this.lbZoom === 1) this.lbPan = { x: 0, y: 0 };
    this.applyLb(true);
  }

  private onLbWheel = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const factor = Math.exp(-event.deltaY * 0.0016);
    this.zoomLb(factor, event.clientX, event.clientY);
  };

  private onLbDown = (event: PointerEvent): void => {
    if (this.lbZoom <= 1.01) return;
    const canvas = event.currentTarget as HTMLElement;
    this.lbDrag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      px: this.lbPan.x,
      py: this.lbPan.y,
    };
    canvas.classList.add('is-dragging');
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };

  private onLbMove = (event: PointerEvent): void => {
    const drag = this.lbDrag;
    if (!drag || drag.id !== event.pointerId) return;
    this.lbPan.x = drag.px + (event.clientX - drag.x);
    this.lbPan.y = drag.py + (event.clientY - drag.y);
    this.applyLb(false);
  };

  private onLbUp = (event: PointerEvent): void => {
    if (!this.lbDrag) return;
    this.lbDrag = null;
    (event.currentTarget as HTMLElement).classList.remove('is-dragging');
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };

  private onLbDouble = (): void => {
    if (this.lbZoom > 1.01) this.resetLb();
    else this.zoomLb(2.4);
  };

  /* ---------------- 销毁 ---------------- */

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearTimeout(this.resizeTimer);
    window.clearTimeout(this.hintTimer);
    window.clearTimeout(this.moveTimer);
    if (this.curtainRaf) window.cancelAnimationFrame(this.curtainRaf);
    this.dust?.destroy();
    this.themeObserver?.disconnect();
    this.view.removeEventListener('pointerdown', this.onPointerDown);
    this.view.removeEventListener('pointermove', this.onPointerMove);
    this.view.removeEventListener('pointerup', this.onPointerUp);
    this.view.removeEventListener('pointercancel', this.onPointerUp);
    this.stage.removeEventListener('click', this.onClick);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('keydown', this.onKeyDown);
    this.query.removeEventListener('change', this.onResize);
    document.documentElement.classList.remove('gal-camera', 'gal-lb-open');
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/* ============================================================
   启动
   ============================================================ */

let wall: Wall | null = null;

function boot(): void {
  wall?.destroy();
  wall = null;

  const root = document.querySelector<HTMLElement>('[data-gal]');
  if (!root) return;

  try {
    wall = new Wall(root);
  } catch (error) {
    // 引擎挂了也别让页面变成一片空白：退回 CSS 瀑布
    console.error('[gallery] 排版引擎初始化失败，退回普通瀑布', error);
    root.classList.add('gal--fallback');
    root.dataset.galMode = 'scroll';
  }
}

onBeforeSwap(() => {
  wall?.destroy();
  wall = null;
});

onPageLoad(boot);
