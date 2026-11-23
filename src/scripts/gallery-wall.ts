/**
 * 照片墙引擎
 * ============================================================
 * 一整块可以拖着走的照片海。所有位置都在客户端算，DOM 只负责渲染。
 *
 * 一、排版（格点 + 比例吸附）
 * ------------------------------------------------------------
 * 瀑布流：列宽固定、列对齐、行不对齐。每列维护一份「已占用区间」表，
 * 放一张照片就是往区间表里插一段，找位置就是顺着区间表往下跳 ——
 * 这样放大时在中间挖出来的洞，上面剩余的空隙还能被后来的照片填上，
 * 不会留下死角。见 firstFit / occupy。
 *
 * 和上一版的关键区别：**缩略图一律裁成比例菜单里的一档**（9:16 … 3:1），
 * 于是每张的高度 = colW ÷ 比例，全是整数；所有格子的上下沿都是
 * gcd(每档高度 + gap, gap) 的整数倍（288 / 8 → 2px）。
 * 「不重叠 / 不留缝 / 上下两条边齐」因此是构造上成立的，不是调参调出来的。
 *
 * 二、放大（本页的灵魂）
 * ------------------------------------------------------------
 * 点一张照片，它**原地**变大：宽度吸附到整数列（必要时最后一列变窄），
 * 高度是同一档比例，上下沿落在格点上；然后**以它为障碍**把其余照片重排一遍 ——
 * 打包器不会把任何一张塞进它里面，所以「重叠 / 留缝 / 保底盖住」这三种
 * 上一版修不好的缺陷，在构造上就不存在。见 heroLayout / packGrid。
 * 整盘重排 + 500ms FLIP = 「照片海让开」的观感。
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
/**
 * 比例菜单（宽 ÷ 高）
 * ------------------------------------------------------------
 * 缩略图一律裁成其中一档：挑「最接近原比例」的那一档（log 距离，不偏袒宽/窄），
 * 只有灯箱回到原比例。于是每张的高度 = colW ÷ 比例，全是整数 ——
 * 「格子的上下沿都落在格点上」这条就从「调参调出来的」变成构造上成立的。
 */
const RATIOS: readonly number[] = [9 / 16, 2 / 3, 3 / 4, 1, 4 / 3, 3 / 2, 16 / 9, 2 / 1, 3 / 1];
/** 列宽吸附到它的倍数（72 的倍数时九档高度 + 缝 的 gcd 仍是 2px，格点对得齐） */
const COL_SNAP = 72;
/** 画布横向最多铺几个屏幕宽（以前是配置项 boardWidth；列数实际由「竖向能拖 1.45 屏」定） */
const BOARD_SCREENS = 3.2;
/** 底线对齐时最后一格最多能缩到多高（再矮就干脆把 line 抬上来） */
const MIN_LAST = 96;
/** 最后一格最多能拉到原来的几倍高（换取景框，不变形） */
const MAX_STRETCH = 2.5;
/**
 * 放大照「装不下」时的兜底门槛：最多允许比可用区高多少倍
 * ------------------------------------------------------------
 * 放大照只占**整列**（左右必须铺满，不能留空档），所以高度是被列宽除出来的。
 * 正常情况一律选「整个装得进可用区」的整数列数（不可能超出屏幕）；
 * 只有当窗口矮到**一档都装不下**（竖图 + 矮窗口）时才退到这条：
 * 允许最多高出 1.35 倍，然后把盒子**裁到可用区高度** ——
 * 宁可少看一截照片（灯箱里能看全），也不让它整块顶出屏幕。
 */
const HERO_OVERFLOW = 1.35;
/**
 * 带上沿那一列的「末张」为了接住放大照的直角，允许裁短多少 / 最短留多少
 * ------------------------------------------------------------
 * 瀑布流各列末张天然错开，放大照的上沿得靠把这一张拉长或裁短才接得上。
 * 裁短只是换取景框（`object-fit: cover`），照片不变形，所以两头都放宽一点：
 * 拉长上限用 `MAX_STRETCH`（2.5 倍），裁短下限 `TAIL_SHRINK` + `TAIL_MIN`。
 * 两头都够宽之后，「接不住、留一条空白」这种情况实际上就不会再出现了。
 */
const TAIL_SHRINK = 0.45;
const TAIL_MIN = 64;
/** 拖出边界之后还能拉出去多少（0 = 拉不动，1 = 完全自由），松开回弹 */
const RUBBER = 0.34;
/** 灯箱最大放大倍数 */
const LB_MAX_ZOOM = 6;
/** 位移超过这么多像素的格子，用更短更晚的过渡（否则会像横穿画面） */
const FAR_MOVE = 1100;
/** 那段短过渡结束后再留一会儿才摘掉 class */
const FAR_TAIL = 260;
/** 窄屏 / 触屏走「竖着滚」的模式，不开相机 */
const SCROLL_QUERY = '(max-width: 899px), (pointer: coarse)';
/** 竖向标签栏展开状态存在这儿 */
const RAIL_KEY = 'melodyxz-gal-rail';
/**
 * 照片海的排序方式也存在这儿：'sequence'（gallery.json 的数组顺序）/ 'random'（每张洗一遍）
 * ------------------------------------------------------------
 * 只影响**排版顺序**（谁先占位、灯箱里 ← → 的先后），不写进仓库 ——
 * 它是个「看照片的习惯」，不是照片墙的数据，所以和分类栏一样只存本机。
 */
const ORDER_KEY = 'melodyxz-gal-order';

/** 排序方式：顺序（配置里的数组顺序）/ 随机（每次点都重新洗一遍） */
type OrderMode = 'sequence' | 'random';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell {
  el: HTMLElement;
  id: string;
  /** 原图比例（宽 ÷ 高）：只给灯箱和「吸附到哪一档」用 */
  aspect: number;
  /** 吸附后的比例（比例菜单里的某一档）：照片墙上用这个 */
  snapped: number;
  /** 当前列宽下这一档比例应有的高度（整数）—— 排版只用它 */
  menuH: number;
  tags: string[];
  rect: Rect;
  /**
   * 静止时的位置（快照）
   * ------------------------------------------------------------
   * 放大重排时靠它「能不动就不动」：先在静止时那一格试试，空着就原地不动。
   * 只有被放大照压到的那几列会被顶出来，其余照片连 transform 都不变 ——
   * 动画才像「照片海在放大照旁边让开」，而不是整片海重新洗牌。
   */
  idle: Rect;
  /** 元素的基准宽度（px）：transform 里的 scale 是相对它算的 */
  baseW: number;
  /** 上一次写进 style 的高度，没变就不重复写（减少样式失效） */
  boxH: number;
  /** 上一次写进 style 的位置：用来判断这一张是不是「一次要走很远」 */
  px: number;
  py: number;
  /** 「走得很远」那段的 class 清理定时器 */
  dartTimer: number;
  visible: boolean;
}

/** 放大照占住的那块：跨 col .. col+k-1 列，纵向 [top, bottom] */
interface Barrier {
  col: number;
  k: number;
  top: number;
  bottom: number;
}

interface HeroInfo {
  rect: Rect;
  barrier: Barrier;
  k: number;
  /** 用了哪种取法：columns / one / mobile（只进调试数据集） */
  note: string;
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

/** 把原图比例吸附到比例菜单里最近的一档（log 距离：2:1 不会跑到 1:1 去） */
function snapRatio(aspect: number): number {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 3 / 4;
  let best = RATIOS[0];
  let bestErr = Number.POSITIVE_INFINITY;
  for (const ratio of RATIOS) {
    const err = Math.abs(Math.log(safe / ratio));
    if (err < bestErr - 1e-9) {
      bestErr = err;
      best = ratio;
    }
  }
  return best;
}

/** 吸附到 step 的整数倍（所有格子的上下沿都是它的倍数 → 残差恒为 0） */
function snapTo(value: number, step: number): number {
  const size = Math.max(1, Math.round(step));
  return Math.round(value / size) * size;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
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
  /**
   * 当前排版顺序下的照片
   * ------------------------------------------------------------
   * 排版（packGrid 的 placeShallowest）是按这个数组的顺序往下铺的，
   * 所以「随机」只要换一份洗过的数组再重排一遍就行，几何算法一行都不用动。
   */
  private cells: Cell[] = [];
  /** 原始顺序（= gallery.json 里 photos[] 的数组顺序，DOM 的先后）：切回「顺序」时照它复原 */
  private source: Cell[] = [];
  private byId = new Map<string, Cell>();
  /** 排序方式（本机记忆） */
  private order: OrderMode = 'sequence';
  /** 右下角胶囊里那颗「随机 / 顺序」按钮 */
  private orderBtn: HTMLElement | null = null;

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
  /** 放大照的完整信息（带 barrier / k / gutter，只进调试数据集） */
  private heroInfo: HeroInfo | null = null;
  /** 最后一版底线（normalizeBottom 的结果） */
  private boardBottom = 0;
  /** 格点步长：所有格子的上下沿都是它的整数倍（288 / 8 → 2，144 / 8 → 1） */
  private step = 2;
  /**
   * 视口顶部被固定导航占掉的高度（px，0 = 没有导航）
   * ------------------------------------------------------------
   * 放大照要避开它：「四边只剩一个标准间隙」这条对导航栏同样成立。
   * 不避开的话，放大照的上沿会被玻璃胶囊压住二三十像素 ——
   * 排版其实是对齐的，但看起来就是「没对齐」。
   */
  private safeTop = 0;

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
  /** 灯箱里按着的手指：pointerId → 最新坐标（双指缩放靠它算间距和中点） */
  private lbTouches = new Map<number, { x: number; y: number }>();
  /**
   * 双指手势的基准（按第二根手指时的快照）
   * ------------------------------------------------------------
   * 缩放按「当前间距 / 基准间距」算；平移以**两指中点**为锚点，
   * 和滚轮那套「以光标为中心缩放」是同一个算式（见 zoomLb）。
   */
  private lbPinch: {
    dist: number;
    zoom: number;
    panX: number;
    panY: number;
    midX: number;
    midY: number;
    /** 画布中心（client 坐标），只在手势开始时量一次 */
    cx: number;
    cy: number;
  } | null = null;
  /** 手势刚结束的这段时间里，别把「松手」当成「点空白关闭」 */
  private lbIgnoreClickUntil = 0;

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
    this.orderBtn = root.querySelector<HTMLElement>('[data-gal-action="order"]');

    this.settings = readSettings(root.dataset.galSettings);
    this.gap = this.settings.gap;

    this.collectCells();
    this.initRail();
    this.initOrder();
    this.initStars();
    this.initLightbox();
    this.bind();

    this.applyMode();
    this.layout({ instant: true });
    this.reveal();
    this.restoreFromUrl();
    this.updateHint();
    // 按钮的文案和行为都跟着模式走（手机上不是「正中」而是「开头」），先同步一次
    this.syncResetLabel();
    this.watchWidth();
  }

  /* ---------------- 初始化 ---------------- */

  private collectCells(): void {
    const nodes = this.root.querySelectorAll<HTMLElement>('[data-gal-cell]');
    nodes.forEach((el, index) => {
      const w = Number(el.dataset.w);
      const h = Number(el.dataset.h);
      const aspect = w > 0 && h > 0 ? clamp(w / h, 0.28, 4) : 3 / 4;
      const snapped = snapRatio(aspect);
      const cell: Cell = {
        el,
        id: el.dataset.id ?? `p${index}`,
        aspect,
        snapped,
        menuH: Math.round(this.colW / snapped),
        tags: (el.dataset.tags ?? '').split(' ').filter(Boolean),
        rect: { x: 0, y: 0, w: 0, h: 0 },
        idle: { x: 0, y: 0, w: 0, h: 0 },
        baseW: 232,
        boxH: 0,
        px: 0,
        py: 0,
        dartTimer: 0,
        visible: true,
      };
      el.dataset.galRatio = `${Math.round(snapped * 100) / 100}`;
      el.style.setProperty('--gal-i', String(Math.min(index, 40)));
      this.cells.push(cell);
      this.byId.set(cell.id, cell);
    });
    // 记下原始顺序（gallery.json 的数组顺序）：切成「顺序」时照它复原
    this.source = this.cells.slice();
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

    /** 同步把手（侧面那根长条 + 箭头）的无障碍状态 */
    const syncToggle = (isOpen: boolean): void => {
      const label = isOpen ? '收起分类' : '展开分类';
      toggleEl?.setAttribute('aria-expanded', String(isOpen));
      toggleEl?.setAttribute('aria-label', label);
      toggleEl?.setAttribute('title', label);
    };
    syncToggle(open);

    const toggle = toggleEl;
    toggle?.addEventListener('click', () => {
      const next = !this.root.classList.contains('gal-rail-open');
      this.root.classList.toggle('gal-rail-open', next);
      syncToggle(next);
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

  /* ---------------- 排序：顺序 / 随机 ---------------- */

  /**
   * 开局先读本机记着的排序方式（缺省 = 顺序，也就是配置里的数组顺序）。
   * 只重排数组、不排版 —— 紧接着 constructor 里那次 layout() 会按新顺序铺。
   */
  private initOrder(): void {
    const saved = (() => {
      try {
        return localStorage.getItem(ORDER_KEY);
      } catch {
        return null;
      }
    })();
    this.order = saved === 'random' ? 'random' : 'sequence';
    this.applyOrder();
    this.syncOrderButton();
  }

  /**
   * 按当前排序方式重排 this.cells
   * ------------------------------------------------------------
   * 这里动的是**数组顺序**，不是 DOM 顺序：照片全是绝对定位的按钮，
   * 谁排在数组前面只决定「谁先挑位置」（见 placeShallowest），
   * 于是「随机」不需要另写一套排版，洗一遍数组就够了。
   */
  private applyOrder(): void {
    if (this.order === 'random' && this.source.length > 1) {
      const list = this.source.slice();
      // Fisher–Yates：每点一次重洗，不记住上一次的结果
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const swap = list[i];
        list[i] = list[j];
        list[j] = swap;
      }
      this.cells = list;
      return;
    }
    this.cells = this.source.slice();
  }

  /** 按钮的图标 / 文案 / 按下态跟着排序方式走（图标切换靠 CSS 的 [data-gal-order]） */
  private syncOrderButton(): void {
    const el = this.orderBtn;
    if (!el) return;
    const random = this.order === 'random';
    el.dataset.galOrder = this.order;
    el.setAttribute('aria-pressed', String(random));
    const text = random ? '恢复顺序排列' : '随机打乱照片';
    el.setAttribute('title', text);
    el.setAttribute('aria-label', text);
  }

  /**
   * 切排序：顺序 ⇄ 随机
   * ------------------------------------------------------------
   * 换顺序 = 整片海重新铺一遍，每张照片按 CSS 里那 500ms 的 transform 过渡滑到新位置
   * （和点开放大时「邻居让开」用的是同一条动画，观感一致）。
   * 放大中的那张在新版面里位置会变，先退出放大，免得相机跟着乱跳。
   */
  private toggleOrder(): void {
    if (this.focusId) this.unfocus(false);
    this.order = this.order === 'random' ? 'sequence' : 'random';
    try {
      localStorage.setItem(ORDER_KEY, this.order);
    } catch {
      /* 隐私模式下写不进去就算了 */
    }
    this.applyOrder();
    // dart = false：整片海是一起挪的，不要让「走得远的那几张」改成快速滑走
    this.layout({ dart: false });
    this.syncOrderButton();
    this.hideHint();
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
  /**
   * 视口宽度的兜底观测
   * ------------------------------------------------------------
   * 滚动模式下 `.gal-view` 的宽度就是排版用的 vw，但它会被页面滚动条偷走 15px：
   * 首屏排版那一刻照片海还没撑开、页面还没出滚动条 → 量到 390；
   * 排完版照片海一长，滚动条冒出来 → 只剩 375。
   * 这时候整片墙是按 390 排的，右边那一列就被推出屏幕 15px（页面能左右晃、
   * 明明不该有的横向滚动条出现了）。窗口 resize 事件不会来，所以自己盯着宽度。
   * 只在宽度真的变了的时候重排（写高度也会触发回调，靠宽度比较挡掉）。
   */
  private widthObserver: ResizeObserver | null = null;
  /** 滚动模式里自己那段滚动动画的帧句柄（0 = 没在滚） */
  private scrollAnim = 0;

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
    // 点空白处关闭（点图不关，方便继续放大看）。
    // 刚做完双指缩放 / 拖动的那一下不算 —— 手机上松手指经常会补一个 click。
    canvas.addEventListener('click', (event) => {
      if (performance.now() < this.lbIgnoreClickUntil) return;
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
        else if (button.dataset.galAction === 'order') this.toggleOrder();
      });
    }
  }

  /* ---------------- 尺寸与网格 ---------------- */

  /**
   * 盯着 `.gal-view` 的宽度：页面滚动条出现 / 消失会让它变一截，
   * 而那次变化不会触发 window.resize —— 不补这一手，右边那一列会一直悬在屏幕外。
   * 宽度没变就不动（这个方法里的写高度同样会触发回调，靠宽度比较挡掉）。
   */
  private watchWidth(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.widthObserver = new ResizeObserver(() => {
      if (this.destroyed || this.mode !== 'scroll') return;
      const width = Math.round(this.view.clientWidth);
      if (!width || Math.abs(width - this.vw) < 0.5) return;
      this.layout({ instant: true });
    });
    this.widthObserver.observe(this.view);
  }

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
      this.safeTop = this.measureSafeTop();
    } else {
      this.vw = Math.round(this.view.clientWidth || window.innerWidth);
      this.vh = Math.round(window.innerHeight);
      this.curtainH = 0;
      // 竖着滚的时候照片本来就在文档流里往下排，导航挡不到放大照（见 centerOnFocus）
      this.safeTop = 0;
      if (this.spacer) this.spacer.style.height = '0px';
    }
  }

  /**
   * 悬浮导航挡住了视口顶部多高
   * ------------------------------------------------------------
   * 用的是 offsetTop + offsetHeight，**不是** getBoundingClientRect：
   * 导航往下滚时会整体 translateY(-120%) 收起来，rect 会变成负数，
   * 而排版结果不能因为「导航现在是收起还是展开」就跟着变 —— 照片会跳。
   */
  private measureSafeTop(): number {
    const shell =
      document.querySelector<HTMLElement>('[data-nav-shell]') ??
      document.querySelector<HTMLElement>('.nav-shell');
    if (!shell) return 0;
    const top = shell.offsetTop + shell.offsetHeight;
    // 最多让出四分之一屏：导航能收起、布局不能塌
    return clamp(Math.round(top), 0, Math.round(this.vh * 0.25));
  }

  /** 列宽 / 列数：横向最多铺 3.2 个屏幕宽，竖向上至少能拖得动一屏 */
  private computeGrid(): void {
    const s = this.settings;
    const gap = this.gap;

    if (this.mode === 'scroll') {
      // 手机：列宽给到「一屏两列」的大图（照片墙在手机上要够大才好看）。
      // 这里列宽不吸附 144（屏宽除不尽），高度用「比例精确 + 像素取整」，
      // 格点步长会被算成 1px —— 手机上不需要横向让位，够用。
      const scale = clamp(this.vw / 1440, 0.6, 1);
      this.colW = clamp(s.columnWidth * scale, 168, 300);
      this.cols = Math.max(2, Math.round((this.vw + gap) / (this.colW + gap)));
      this.colW = (this.vw - gap * (this.cols - 1)) / this.cols;
      this.originX = 0;
      this.boardW = this.vw;
      this.step = this.latticeStep();
      return;
    }

    this.originX = 0;
    // ⚠ 列宽吸附到 72 的倍数（144 / 216 / 288 / 360 / 432）：
    //    格点步长 = gcd(九档高度 + 缝, 缝)，只有 72 的倍数才让这个 gcd 保持在 2px，
    //    邻居被裁短 / 拉长时「残差恒为 0」。216 时是 392/332/296/224/170/152/130/116/80。
    const want = s.columnWidth * clamp(this.vw / 1440, 0.72, 1.16);
    this.colW = clamp(snapTo(want, COL_SNAP), COL_SNAP * 2, COL_SNAP * 6);
    // 横向最多铺几屏宽 = 常量（以前是配置项 boardWidth）：
    // 列数其实由下面的「竖向至少能拖 1.45 屏」定，这个上限大多数时候根本不起作用，
    // 留一个滑块只会让人以为调它能改变什么 —— 删掉，写成常量。
    const byWidth = Math.round((BOARD_SCREENS * this.vw + gap) / (this.colW + gap));
    this.cols = clamp(byWidth, 4, 90);

    // 照片太少的话照这个列数排会「又宽又扁」，竖着根本拖不动；
    // 拿总高度反推一个更窄的列数，宁可变窄也要让上下有事可做。
    // ⚠ 只统计「当前可见」的那些：筛完只剩 30 张时还要摊成 19 列就成了一条横幅。
    const totalH = this.visibleCells().reduce((sum, cell) => sum + this.colW / cell.snapped, 0);
    const targetH = this.vh * 1.45;
    if (totalH > 0) {
      const byHeight = Math.ceil(totalH / targetH);
      this.cols = clamp(Math.min(this.cols, byHeight), 4, 90);
    }
    this.boardW = this.cols * this.colW + (this.cols - 1) * gap;
    this.step = this.latticeStep();
  }

  /**
   * 格点步长 = gcd(每档高度 + gap, gap)
   * ------------------------------------------------------------
   * 288 / 8 时九档高度是 512/432/384/288/216/192/162/144/96，
   * 加缝之后 520/440/392/296/224/200/170/152/104 的最大公约数是 2 ——
   * 于是所有格子的上下沿都是 2px 的整数倍，放大照把边吸附到 2px 之后，
   * 邻居的裁剪量必然是 2px 的整数倍，**残差恒为 0**（不会再有 1.3px 那种对不齐）。
   */
  private latticeStep(): number {
    let size = 0;
    const gap = Math.max(0, Math.round(this.gap));
    for (const ratio of RATIOS) {
      size = gcd(size, Math.max(1, Math.round(this.colW / ratio)) + gap);
    }
    return Math.max(1, gcd(size, Math.max(1, gap)));
  }

  /** 列宽一变，每张照片的「菜单高度」就跟着变（它永远是整数） */
  private refreshHeights(): void {
    for (const cell of this.cells) {
      cell.menuH = Math.max(24, Math.round(this.colW / cell.snapped));
    }
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

  private visibleCells(): Cell[] {
    return this.cells.filter((cell) => cell.visible);
  }

  /* ---------------- 排版 ---------------- */

  private layout(options: { instant?: boolean; dart?: boolean } = {}): void {
    this.measure();
    this.computeGrid();
    this.refreshHeights();
    this.setBase();
    if (this.focusId) this.packFocus();
    else this.packIdle();
    this.paint(options.instant === true, options.dart !== false);
    this.updateBoard();
    // 调试用：一行就能看出这次的网格参数（排查「列数自己会变」这类问题时救命）
    this.root.dataset.galGrid =
      `${this.vw}x${this.vh} mode=${this.mode} colW=${Math.round(this.colW * 10) / 10} ` +
      `cols=${this.cols} step=${this.step} ` +
      `board=${Math.round(this.boardW)}x${Math.round(this.boardH)} line=${Math.round(this.boardBottom)}`;
    this.dim.classList.toggle('is-on', this.focusId !== null);
    this.root.classList.toggle('gal-focus', this.focusId !== null);
    this.checkInvariants();
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

  /* ---------------- 排版：格点 + 比例吸附 ---------------- */

  /**
   * 初排：静止时的那张版面
   * ------------------------------------------------------------
   * 和「点开一张」走的是同一个 packGrid，区别只是没有障碍矩形。
   */
  private packIdle(): void {
    this.focusRect = null;
    this.heroInfo = null;
    // 调试属性要清掉：留着上一张的 band 会让外部校验脚本以为还在放大态
    delete this.root.dataset.galFocus;
    this.packGrid(null, null, 0);
  }

  /**
   * 唯一的排版函数（初排 / 放大 / 取消放大 / 筛选 / 窗口缩放都走它）
   * ------------------------------------------------------------
   * 每张照片挑「第一个放得下的位置最靠上」的那一列（一样早就选靠左的）。
   * firstFit 是**障碍感知**的：放大照那 k 列在 [top, bottom] 上被占住，
   * 于是「有照片被塞进放大照里面」这条路在构造上就不存在 ——
   * 上一版那一整套 bandFitsDown / bandFitsUp / cover / nudge 分支全部不需要了。
   *
   * 因为每张照片的高度都是比例菜单里的整数（colW ÷ 比例），
   * 而所有格子的上下沿 = Σ(高度 + gap)，都是格点步长的整数倍，
   * 所以「不重叠 / 不留缝 / 上下两条边齐」是三件构造上成立的事，不是调出来的。
   */
  private packGrid(
    barrier: Barrier | null,
    skip: Cell | null,
    extraBottom: number,
    sticky = barrier !== null,
  ): void {
    this.resetOcc();
    const pitch = this.colW + this.gap;

    if (barrier) {
      // 放大照按列占位：跨 k 列，每列占 [top, bottom]
      for (let i = 0; i < barrier.k; i += 1) {
        const col = barrier.col + i;
        if (col >= 0 && col < this.cols) {
          this.occupy(col, barrier.top, barrier.bottom - barrier.top);
        }
      }
    }

    // ① 「能不动就不动」：每张照片先试着待在静止时那一格。
    //    放大照只占了 k 列，所以其余 13 列的每张照片**连 transform 都不变** ——
    //    观感才是「照片海在放大照旁边让开」，而不是整片海重新洗牌。
    const deferred: Cell[] = [];
    for (const cell of this.cells) {
      if (!cell.visible) continue;
      if (cell === skip) continue;
      const h = cell.menuH;
      if (sticky && cell.idle.w > 0) {
        const col = Math.round(cell.idle.x / pitch);
        if (
          col >= 0 &&
          col < this.cols &&
          Math.abs(this.firstFit(col, h, cell.idle.y) - cell.idle.y) <= 0.5
        ) {
          this.occupy(col, cell.idle.y, h);
          cell.rect = { x: col * pitch, y: cell.idle.y, w: this.colW, h };
          continue;
        }
        // 原位被放大照占了 → 让开（等别人都站好之后再找地方）
        deferred.push(cell);
        continue;
      }
      this.placeShallowest(cell, h, pitch);
    }

    // ② 被顶走的照片会在自己那一列留下空洞 —— 把带那几列按原顺序重贴一遍（跳过放大照）。
    //    于是这一列看起来是「顺着放大照滑上去」，不会破一个洞。
    if (sticky && barrier) {
      const held = new Set(deferred);
      for (let i = 0; i < barrier.k; i += 1) this.reflowColumn(barrier.col + i, barrier, skip, held);
    }

    // ③ 让开的那几张：落到**板子下沿那一排**。那是整片海里唯一没人的地方，
    //    所以不会把任何已经站好的照片再挤下去（插进别处会引发一串连锁下沉，反而更乱）。
    for (const cell of deferred) this.placeShallowest(cell, cell.menuH, pitch);

    this.boardBottom = this.normalizeBottom(barrier, skip, extraBottom);
  }

  /**
   * 把一列的照片按原顺序重贴一遍（跳过放大照那一块）
   * ------------------------------------------------------------
   * 只在一列被放大照压过之后用：被顶走的照片留下的空洞由后面的照片补上，
   * 于是这一列是「整体顺着放大照滑过去」，而不是「破了个洞」。
   */
  private reflowColumn(col: number, barrier: Barrier, skip: Cell | null, held: Set<Cell>): void {
    if (col < 0 || col >= this.cols) return;
    const pitch = this.colW + this.gap;
    const list = this.cells
      .filter(
        (cell) =>
          cell.visible && cell !== skip && !held.has(cell) && Math.round(cell.rect.x / pitch) === col,
      )
      .sort((a, b) => a.rect.y - b.rect.y);
    if (!list.length) return;
    // 清掉这一列普通照片的占用，只留放大照那一块
    this.occ[col] = [];
    if (col >= barrier.col && col < barrier.col + barrier.k) {
      this.occ[col] = [[barrier.top, barrier.bottom]];
    }
    for (const cell of list) {
      const y = this.firstFit(col, cell.menuH, 0);
      this.occupy(col, y, cell.menuH);
      cell.rect = { ...cell.rect, y, h: cell.menuH };
    }
  }

  /** 落到「原地最浅」的那一列（同一高度取靠左） */
  private placeShallowest(cell: Cell, h: number, pitch: number): void {
    let bestCol = 0;
    let bestY = Number.POSITIVE_INFINITY;
    for (let col = 0; col < this.cols; col += 1) {
      const y = this.firstFit(col, h, 0);
      if (y < bestY - 0.5 || (Math.abs(y - bestY) <= 0.5 && col < bestCol)) {
        bestY = y;
        bestCol = col;
      }
    }
    this.occupy(bestCol, bestY, h);
    cell.rect = { x: bestCol * pitch, y: bestY, w: this.colW, h };
  }

  /**
   * 底线对齐：每列只挪「最后一格」
   * ------------------------------------------------------------
   * 瀑布流每列的底边天然是锯齿。这里让**最后一格破例**长成非菜单高度，
   * 把各列底边拉到同一条 line 上（放大态里放大照的下沿也算进这条线）。
   *
   * · 只动一格、列内独立 → 不可能制造空洞，也不可能影响别的列；
   * · line 在 [最矮能缩到, 最高能拉到] 之间按 **minimax** 选：
   *   让「被改得最狠的那一列」改得最少（19 列各摊 5%~10%，肉眼看不出来）；
   * · 一列最后那格被放大照挡住、下面又没有照片时**不许再拉**（拉了会盖住放大照）。
   *
   * 上一版是在「每张缩略图还能裁多少」之间分摊（cropRoom / fitColumn），
   * 那套要算一堆比例余量；格点化之后只需要「最后一格能缩到多少 / 拉到多少」两个数。
   */
  private normalizeBottom(
    barrier: Barrier | null,
    skip: Cell | null,
    extraBottom: number,
  ): number {
    const pitch = this.colW + this.gap;
    const lists: Cell[][] = Array.from({ length: this.cols }, () => [] as Cell[]);
    for (const cell of this.cells) {
      if (!cell.visible || cell === skip || !cell.rect.w) continue;
      const col = Math.round(cell.rect.x / pitch);
      if (col >= 0 && col < this.cols) lists[col].push(cell);
    }

    interface Tail {
      last: Cell;
      bottom: number;
      minH: number;
      /**
       * 这一列被放大照横着挡住、下面又没有照片：它的下沿**就是放大照的下沿**
       * （照片只到带上边为止，底下那截由放大照自己撑着），所以这一列的底边动不了。
       */
      fixed: boolean;
    }

    const tails: Tail[] = [];
    let lo = Math.max(0, extraBottom);
    let hi = Number.POSITIVE_INFINITY;
    /** 有「底边钉死」的列时，它们共同的下沿（= 放大照的下沿） */
    let pinned = Number.NEGATIVE_INFINITY;

    lists.forEach((list, index) => {
      let last: Cell | null = null;
      let bottom = 0;
      for (const cell of list) {
        const cellBottom = cell.rect.y + cell.rect.h;
        if (!last || cellBottom > bottom) {
          last = cell;
          bottom = cellBottom;
        }
      }
      if (!last) return; // 这一列一张照片都没有（筛完只剩几张时会有）

      const inBand =
        !!barrier && index >= barrier.col && index < barrier.col + barrier.k;
      const fixed = inBand && bottom < barrier!.top - 0.5;
      const minH = Math.min(MIN_LAST, last.menuH);

      if (fixed) {
        // 钉死在放大照的下沿：整列的视觉下边缘就是它
        const bottomEdge = barrier!.bottom;
        tails.push({ last, bottom: bottomEdge, minH, fixed: true });
        pinned = Math.max(pinned, bottomEdge);
        return;
      }

      tails.push({ last, bottom, minH, fixed: false });
      lo = Math.max(lo, last.rect.y + minH);
      hi = Math.min(hi, last.rect.y + last.menuH * MAX_STRETCH);
    });

    if (!tails.length) return Math.max(0, extraBottom);
    if (!Number.isFinite(hi) || hi < lo) hi = lo;

    // 代价 = 「这一列被拉/压了多少 ÷ 它还能拉/压多少」的最大值
    const room = (tail: Tail, target: number): number =>
      target < tail.bottom
        ? tail.bottom - (tail.last.rect.y + tail.minH)
        : tail.last.rect.y + tail.last.menuH * MAX_STRETCH - tail.bottom;
    const reachable = (tail: Tail, target: number): boolean =>
      room(tail, target) >= Math.abs(target - tail.bottom) - 0.5;
    const cost = (target: number): number => {
      let worst = 0;
      for (const tail of tails) {
        if (tail.fixed) continue;
        const delta = target - tail.bottom;
        if (Math.abs(delta) < 0.5) continue;
        const avail = room(tail, target);
        worst = Math.max(worst, avail <= 0.5 ? 99 : Math.abs(delta) / avail);
      }
      return worst;
    };

    let line = -1;
    // 有钉死的列（放大照下面没照片）→ 底线必须正好落在放大照下沿，
    // 否则放大照下方会空出一块（就是用户说的「空白」）。其它列缩/拉到位就成立。
    if (Number.isFinite(pinned) && tails.every((tail) => reachable(tail, pinned))) {
      line = pinned;
    } else {
      let a = lo;
      let b = hi;
      for (let i = 0; i < 44 && b - a > 0.5; i += 1) {
        const m1 = a + (b - a) / 3;
        const m2 = b - (b - a) / 3;
        if (cost(m1) <= cost(m2)) b = m2;
        else a = m1;
      }
      line = Math.round(((a + b) / 2) * 100) / 100;
    }

    for (const tail of tails) {
      if (tail.fixed) continue;
      const want = line - tail.last.rect.y;
      if (Math.abs(want - tail.last.rect.h) > 0.5) tail.last.rect.h = Math.max(1, want);
    }
    return line;
  }

  /**
   * 放大照的矩形
   * ------------------------------------------------------------
   * 三条约束：① 保持**比例菜单那一档**（全景按 16:9，否则是一条看不清的横条）；
   * ② 宽度是**整数列**，高度 = 宽 ÷ 比例，上下沿落在格点上；
   * ③ 整块矩形把它占的那 k 列**铺满** —— 左右不留一条空档。
   *
   * ⚠ 为什么不再用「边界列变窄」（v3 初版做过，已废弃）：
   * 那样能让宽度精确到 1px，但放大照两侧会留下 (colW − lastW) 的空条，
   * 9:16 时是左右各 60px、4:3 是各 43px —— 照片墙上出现两条「空缺」，
   * 看着就是没对齐。宁可把盒子裁矮一点（`crop`），也不让网格破一个洞：
   * **每张图（含放大那张）都严格按整列扑上去**。
   *
   * 横向：取「最宽、且整块**装得进可用区**」的整数列数（高度优先）；
   *       从左往右长，右边放不下就按整列左移（`clamp` 到底）。
   *       一档都装不下时才裁盒子（见 HERO_OVERFLOW），绝不顶出屏幕。
   * 纵向：优先「左上角钉住、往下长」；会顶出基线时再往上让，永远不需要第二种模式。
   */
  private heroLayout(hero: Cell, idle: Rect, idleLine: number, forcedTop?: number): HeroInfo {
    const pitch = this.colW + this.gap;
    const step = this.step;

    let ratio = hero.snapped;
    // 2:1 / 3:1 的全景放大后按 16:9 取景（照原比例放大只是一条扁横条，看不清）
    if (ratio > 16 / 9 + 1e-6) ratio = 16 / 9;

    const boxW = clamp(this.settings.focusWidth, 0.3, 0.95) * this.vw;
    // 可用区 = 导航底下到视口底部。放大照**必须装得进这一块** ——
    // 以前允许它高出 35%，竖图放大后上下两条边都切在屏幕外，看着就是「超出屏幕、也没居中」。
    // 这条就是高度上限，不再有单独的 focusMaxHeight 配置项：
    // 把它调小只会让放大照提前被裁，甚至退回「整块顶出屏幕」那条老路。
    const bandH = Math.max(240, snapTo(this.vh - this.safeTop, step));

    /** 第 kk 列宽（整列：左右铺满，不留空档） */
    const widthOf = (kk: number) => (kk - 1) * pitch + this.colW;

    let k = 1;
    let width = Math.min(this.colW, boxW);
    let note = 'one';
    /** 装不进可用区时把盒子裁到可用区高度：少看一截照片，而不是整块顶出屏幕 */
    let crop = false;

    if (this.mode === 'scroll') {
      // 没有相机时默认「占满屏宽」：手机两列正好铺满，观感也最像大图。
      const fullK = clamp(Math.round((this.vw + this.gap) / pitch), 1, this.cols);
      const fullW = widthOf(fullK);
      // 但平板横屏这种「宽 + 矮」的视口，占满屏宽后竖图会高出一两屏
      // （1180×820 上的 3:4 竖图 = 1553px，只能看见中间一截 —— 这就是要修的问题）。
      // 只要还有 3 列以上可选，就换相机模式那把尺子：取「整张装得进可用区」的最宽整数列。
      // 横图（3:2 / 16:9）高度本来就装得下，仍然铺满整屏宽，和手机完全一致。
      if (this.cols >= 3 && fullW / ratio > bandH + 0.5) {
        for (let kk = 1; kk <= this.cols; kk += 1) {
          const w = widthOf(kk);
          if (w / ratio > bandH + 0.5) break;
          k = kk;
          width = w;
          note = kk === this.cols ? 'mobile' : 'fit';
        }
        // 连 2 列都装不下（极矮的触屏窗口，正常平板不会遇到）：
        // 像相机模式那样裁到可用区高度 —— 至少别缩成 1 列，那和缩略图一样大 = 点了没反应。
        if (k < 2) {
          k = 2;
          width = widthOf(2);
          note = 'crop';
          crop = true;
        }
      } else {
        k = fullK;
        width = fullW;
        note = 'mobile';
      }
    } else {
      // ① 高度优先：在「整个装得进可用区」的整数列里取**最宽**的一档。
      //    宽度仍是整列（左右不留空档），但高度不再随口一开就超出屏幕。
      for (let kk = 1; kk <= this.cols; kk += 1) {
        const w = widthOf(kk);
        if (w > boxW + 0.5) break;
        if (w / ratio > bandH + 0.5) continue;
        k = kk;
        width = w;
        note = kk === 1 ? 'one' : 'columns';
      }
      // ② 一档都装不下（矮窗口 + 竖图）：允许最多高出 HERO_OVERFLOW 倍，
      //    但盒子**裁到可用区高度** —— 照片上少看一截（灯箱能看全），不会顶出屏幕。
      if (k === 1) {
        for (let kk = this.cols; kk >= 2; kk -= 1) {
          const w = widthOf(kk);
          if (w > boxW + 0.5) continue;
          if (w / ratio > bandH * HERO_OVERFLOW + 0.5) continue;
          k = kk;
          width = w;
          note = 'crop';
          crop = true;
          break;
        }
      }
      // 竖图至少 2 列：1 列和缩略图一样大，等于「点了没反应」（窗口极矮时会退到这一步）。
      if (ratio < 1 && k < 2 && this.cols >= 2 && pitch + this.colW <= boxW + 0.5) {
        k = 2;
        width = pitch + this.colW;
        note = 'columns';
        crop = false;
      }
    }

    // 高度也吸附到格点：上下两条边都落在 2px 的整数倍上（柱高差恒为 0）
    const natural = width / ratio;
    const height = Math.max(step, snapTo(crop ? Math.min(natural, bandH) : natural, step));
    const col = clamp(Math.round(idle.x / pitch), 0, Math.max(0, this.cols - k));
    // 整列 → 横向正好铺满 col .. col+k-1 这 k 列（bandW === width，没有空档）
    const x = col * pitch;
    // 纵向默认「左上角钉住、往下长」；顶出基线就往上让一点点。
    // forcedTop 是「放大照下面空着」时用的：把它的下沿直接压到底线上（见 packFocus）。
    const wanted =
      forcedTop !== undefined
        ? forcedTop
        : clamp(idle.y, 0, Math.max(0, idleLine - height));
    const top = Math.max(0, snapTo(wanted, step));

    return {
      rect: { x, y: top, w: width, h: height },
      barrier: { col, k, top, bottom: top + height },
      k,
      note,
    };
  }

  /**
   * 放大排版 = 五行
   * ------------------------------------------------------------
   * ① 基准版面（和静止时一模一样，确定性）；
   * ② 算放大照的矩形；
   * ③ 以它为障碍把其余**所有**照片重排一遍；
   * ④ 放大照自己上位（它不参与打包，所以不会挤到自己）；
   * ⑤ paint() —— transform / height 各自过渡，就是一段 FLIP。
   *
   * 整盘重排是「对所有输入都成立」的唯一做法：任一列被压到多深都不需要额外的
   * 可行性判断（以前的 nudge 搜索、cover 保底、MIN_KEEP 下限全是为了那个判断）。
   */
  private packFocus(): void {
    const hero = this.focusId ? this.byId.get(this.focusId) : null;
    if (!hero || !hero.visible) {
      this.focusId = null;
      this.packIdle();
      return;
    }

    // ① 基准版面：就是 idle 里那些位置，顺便把它拍成快照（sticky 重排要用）
    this.packGrid(null, null, 0);
    for (const cell of this.cells) {
      if (cell.visible) cell.idle = { ...cell.rect };
    }
    this.focusRect = null;
    const idle = { ...hero.rect };
    const idleLine = this.boardBottom;

    // ② 放大照的矩形
    let info = this.heroLayout(hero, idle, idleLine);

    // ③ 其余照片重排：**能不动就不动**，只有被放大照压到的那几张会让开
    this.packGrid(info.barrier, hero, info.rect.y + info.rect.h);

    // ③′ 放大照的下沿要落在板底线上：它那几列的内容要是都在它上方，
    //    那一列的"视觉下沿"就是放大照的下沿 —— 不在线上就会在下方空出一块。
    info = this.pinBandBottom(hero, idle, idleLine, info);
    const pinnedBottom = this.bandOpenBelow(info.barrier, hero);

    // ③″ 上沿：把带上方那几列的末张接到「上沿 − gap」（拉长 / 裁短），上边才是一条直线
    info = this.flushBandTop(hero, idle, idleLine, info, pinnedBottom);

    // ④ 放大照上位
    hero.rect = { ...info.rect };
    this.focusRect = { ...info.rect };
    this.heroInfo = info;
    // 比可用区还高（竖图 → 见 HERO_OVERFLOW）时，底部的标题条会落在屏幕外，改挂到顶上
    const bandH = Math.max(120, this.vh - this.safeTop);
    hero.el.classList.toggle(
      'is-tall',
      this.mode === 'camera' && info.rect.h > bandH + 1,
    );

    this.root.dataset.galFocus =
      `idle=${Math.round(idle.x)},${Math.round(idle.y)} line=${Math.round(idleLine)} ` +
      `hero=${Math.round(info.rect.w)}x${Math.round(info.rect.h)} ` +
      `r=${(info.rect.w / info.rect.h).toFixed(3)} ` +
      `band=${Math.round(info.rect.y)}..${Math.round(info.barrier.bottom)} ` +
      `k=${info.k} col=${info.barrier.col} ${info.note}`;
  }

  /** 放大照那 k 列里，有没有哪一列下面已经没照片了（= 放大照下沿就是这块的底） */
  private bandOpenBelow(barrier: Barrier, hero: Cell): boolean {
    const pitch = this.colW + this.gap;
    for (let col = barrier.col; col < barrier.col + barrier.k; col += 1) {
      const below = this.cells.some(
        (cell) =>
          cell.visible &&
          cell !== hero &&
          Math.round(cell.rect.x / pitch) === col &&
          cell.rect.y + cell.rect.h > barrier.top + 0.5,
      );
      if (!below) return true;
    }
    return false;
  }

  /**
   * 放大照的下沿钉在板底线上（③′）
   * ------------------------------------------------------------
   * 带那几列下面要是没照片了，它们的下边缘就是放大照的下沿 ——
   * 那就必须等于板底线，否则放大照下方会空出一条「凹口」。
   *
   * 往上往下都试（以前只往下推，推过头就再也回不来）；每挪一次整盘重排一次，
   * 板底线自己也会动，所以是个不动点迭代 —— 六轮足够（每轮误差按三分之一收敛）。
   */
  private pinBandBottom(
    hero: Cell,
    idle: Rect,
    idleLine: number,
    start: HeroInfo,
  ): HeroInfo {
    let info = start;
    for (let i = 0; i < 6; i += 1) {
      if (!this.bandOpenBelow(info.barrier, hero)) break;
      const want = snapTo(this.boardBottom - info.rect.h, this.step);
      if (Math.abs(want - info.rect.y) <= 1) break;
      const next = this.heroLayout(hero, idle, idleLine, want);
      if (Math.abs(next.rect.y - info.rect.y) < 2) break;
      info = next;
      this.packGrid(info.barrier, hero, info.rect.y + info.rect.h);
    }
    return info;
  }

  /** 放大照那 k 列里，每一列「带上方最后一张」（没有就跳过） */
  private bandTails(barrier: Barrier, hero: Cell): Cell[] {
    const pitch = this.colW + this.gap;
    const tails: Cell[] = [];
    for (let col = barrier.col; col < barrier.col + barrier.k; col += 1) {
      let last: Cell | null = null;
      for (const cell of this.cells) {
        if (!cell.visible || cell === hero) continue;
        if (Math.round(cell.rect.x / pitch) !== col) continue;
        if (cell.rect.y + cell.rect.h > barrier.top + 0.5) continue;
        if (!last || cell.rect.y + cell.rect.h > last.rect.y + last.rect.h) last = cell;
      }
      if (last) tails.push(last);
    }
    return tails;
  }

  /**
   * 带上沿对齐（③″）：把 k 列的「末张」接到「上沿 − 一格缝」
   * ------------------------------------------------------------
   * 放大照是个直角矩形，它上方那 k 列的照片必须一条线停在同一个 y 上。
   * 瀑布流各列末张天然错开几十上百像素 —— 只能把那一张**拉长或裁短**到刚好接住。
   *
   * 上沿本身也可以挪（吸附格点），所以先试几个候选位置（每列的「自然接住位置」
   * + 最低 / 最高 / 中位），选「被改得最狠的那一张也改得最少」的那个；
   * 下沿已经钉在板底线上时（③′）上沿**不许再动**，只把末张调整到位。
   */
  private flushBandTop(
    hero: Cell,
    idle: Rect,
    idleLine: number,
    current: HeroInfo,
    pinnedBottom: boolean,
  ): HeroInfo {
    const gap = this.gap;

    /** 试一个上沿：重排一遍，量每列末张要改多少（0 = 正好接住，1 = 刚好用光余量） */
    const probe = (top: number) => {
      const info = this.heroLayout(hero, idle, idleLine, top);
      this.packGrid(info.barrier, hero, info.rect.y + info.rect.h);
      const tails = this.bandTails(info.barrier, hero);
      let cost = 0;
      for (const cell of tails) {
        const want = info.rect.y - gap - cell.rect.y;
        const h = cell.rect.h;
        const stretch = Math.max(1, cell.menuH * MAX_STRETCH - h);
        const shrink = Math.max(1, h - Math.max(TAIL_MIN, h * (1 - TAIL_SHRINK)));
        const delta = want - h;
        cost = Math.max(cost, delta >= 0 ? delta / stretch : -delta / shrink);
      }
      return { info, tails, cost, top };
    };

    let best = probe(current.rect.y);

    if (!pinnedBottom) {
      const tried = new Set<number>([Math.round(best.top)]);
      const naturals: number[] = [];
      for (const cell of best.tails) {
        naturals.push(snapTo(cell.rect.y + cell.rect.h + gap, this.step));
      }
      if (naturals.length > 1) {
        const lo = Math.min(...naturals);
        const hi = Math.max(...naturals);
        naturals.push(lo, hi, snapTo((lo + hi) / 2, this.step));
      }
      for (const top of naturals) {
        const want = Math.max(0, top);
        if (tried.has(want)) continue;
        tried.add(want);
        const cand = probe(want);
        if (cand.cost < best.cost - 0.02) best = cand;
      }
      // 挑中的方案再排一次（上面最后一轮 probe 是别的候选，rect 现在停在它身上）
      best = probe(best.top);
    }

    const top = best.info.rect.y;
    for (const cell of best.tails) {
      const lo = Math.min(cell.rect.h, Math.max(TAIL_MIN, cell.rect.h * (1 - TAIL_SHRINK)));
      const hi = Math.max(cell.rect.h, cell.menuH * MAX_STRETCH);
      cell.rect.h = clamp(top - gap - cell.rect.y, lo, hi);
    }
    return best.info;
  }

  /**
   * 排完版自检（只在 dev 里跑）
   * ------------------------------------------------------------
   * 五条硬指标：不重叠、不越界、放大照铺满整列、每列顶部齐、不出空洞、
   * 放大照上下两条边贴齐邻居、底线齐。任何一条被破坏都会在控制台点名是哪几张、
   * 差多少像素，同时写进 [data-gal-check]（Playwright 一遍就能扫出全部）。
   *
   * ⚠ 别把「放大照附近留白」一律当合法：曾经这么放过一次，
   * 结果带上方留了 100~170px 的空档，而且只在某些窗口尺寸下才出现。
   */
  private checkInvariants(): void {
    if (!import.meta.env.DEV) return;
    const pitch = this.colW + this.gap;
    const gap = this.gap;
    const hero = this.focusId ? this.byId.get(this.focusId) ?? null : null;
    const list = this.cells.filter((cell) => cell.visible && cell.rect.w > 0);
    const others = list.filter((cell) => cell !== hero);
    const bad: string[] = [];

    // ① 重叠
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (a.rect.y < -0.5) bad.push(`top:${a.id}`);
      if (a.rect.x < -0.5) bad.push(`left:${a.id}`);
      if (a.rect.x + a.rect.w > this.boardW + 1) bad.push(`right:${a.id}`);
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        const ox =
          Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w) -
          Math.max(a.rect.x, b.rect.x);
        const oy =
          Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h) -
          Math.max(a.rect.y, b.rect.y);
        if (ox > 1 && oy > 1) {
          bad.push(`overlap:${a.id}x${b.id}:${Math.round(ox)}x${Math.round(oy)}`);
        }
      }
    }

    // ①′ 放大照必须**铺满**它占的那 k 列：左边对齐列边、右边对齐最后一列的右边。
    //     否则两侧会留一条空档（曾经为了「宽度精确到 1px」收窄边界列，就留过 60px 的空条）。
    if (hero && this.heroInfo) {
      const bandLeft = this.heroInfo.barrier.col * pitch;
      const bandRight = (this.heroInfo.barrier.col + this.heroInfo.k) * pitch - gap;
      const dl = hero.rect.x - bandLeft;
      const dr = bandRight - (hero.rect.x + hero.rect.w);
      if (Math.abs(dl) > 1) bad.push(`bandLeft:${hero.id}:${Math.round(dl)}`);
      if (Math.abs(dr) > 1) bad.push(`bandRight:${hero.id}:${Math.round(dr)}`);
    }

    // ② 每列：顶部齐、缝是一格、放大照上下两条边贴齐邻居、底线齐
    const barrier = this.heroInfo?.barrier ?? null;
    const line = this.boardBottom;
    for (let col = 0; col < this.cols; col += 1) {
      const inBand = barrier !== null && col >= barrier.col && col < barrier.col + barrier.k;
      const column = others
        .filter((cell) => Math.round(cell.rect.x / pitch) === col)
        .sort((a, b) => a.rect.y - b.rect.y);
      if (!column.length) continue;
      const bandAtTop = inBand && column[0].rect.y < barrier!.top - 0.5;
      const wantTop = inBand && !bandAtTop ? barrier!.bottom + gap : 0;
      if (Math.abs(column[0].rect.y - wantTop) > (inBand ? 1 : gap + 4)) {
        bad.push(`gapTop:c${col}:${Math.round(column[0].rect.y - wantTop)}`);
      }
      for (let i = 1; i < column.length; i += 1) {
        const prev = column[i - 1];
        const next = column[i];
        const space = next.rect.y - (prev.rect.y + prev.rect.h);
        if (space <= gap + 4) continue;
        if (inBand) {
          // 这一段空白就是放大照那一块：上下两张都必须**正好**贴着它
          const above = Math.abs(prev.rect.y + prev.rect.h + gap - barrier!.top);
          const below = Math.abs(next.rect.y - (barrier!.bottom + gap));
          if (above > 1) bad.push(`bandTop:c${col}:${Math.round(above)}`);
          if (below > 1) bad.push(`bandBottom:c${col}:${Math.round(below)}`);
          continue;
        }
        bad.push(`hole:c${col}:${prev.id}->${next.id}:${Math.round(space)}`);
      }
      const lowest = column[column.length - 1];
      const bottom = lowest.rect.y + lowest.rect.h;
      // 带那几列要是整列都在放大照上方，它的视觉下沿就是放大照的下沿
      const atLine = inBand && bottom <= barrier!.top + 0.5 ? barrier!.bottom : bottom;
      if (line - atLine > 1) bad.push(`bottom:c${col}:${Math.round(line - atLine)}`);
    }

    this.root.dataset.galCheck = bad.length ? bad.slice(0, 6).join(' ') : 'ok';
    if (bad.length) console.warn('[gallery] 排版不变量被破坏', bad.slice(0, 6));
  }

  /* ---------------- 画到屏幕上 ---------------- */

  private paint(instant: boolean, dart = true): void {
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

      // 上一次到这一次要走多远？走得很远的那几张（被放大照顶出来、只能去板子下沿的）
      // 走同样的 500ms 会像「横穿整个画面」，所以给它们一段更短、稍晚的过渡：
      // 等放大照先长好，它们再快速滑走，眼睛跟不过去，就不显得乱。
      if (dart && !instant && (Math.abs(x - cell.px) > 1 || Math.abs(y - cell.py) > 1)) {
        const far = Math.hypot(x - cell.px, y - cell.py) > FAR_MOVE;
        if (far !== cell.el.classList.contains('is-darting')) {
          cell.el.classList.toggle('is-darting', far);
          if (far) {
            window.clearTimeout(cell.dartTimer);
            cell.dartTimer = window.setTimeout(
              () => cell.el.classList.remove('is-darting'),
              CAM_DUR + FAR_TAIL,
            );
          }
        }
      }
      cell.px = x;
      cell.py = y;

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
   * `withFocus` = true 时把「让放大照居中」的那个 cam 值并进区间 ——
   * 贴边的照片也能被推到正中（越出去的那片交给星尘兜着）。
   * 放大 / 拖动 / 回弹都用它；`withFocus` = false 只用在不带放大照的复位。
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
      // 「摆到正中」指的是在**可用区**（导航底下那一块）正中，和 centerOnFocus 同一把尺子 ——
      // 用整屏正中算出来的 cy 会低 bandTop/2，于是贴顶的照片只能居中到偏下一点。
      const bandTop = this.safeTop;
      const cx = fx + fw / 2 - this.vw / 2;
      const cy = fy + fh / 2 - bandTop - (this.vh - bandTop) / 2;
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

  /**
   * 右下角那个「回到正中」：**两段式**，电脑和手机一模一样
   * ------------------------------------------------------------
   * ① 有放大照 → 退出放大，镜头落到这张刚缩回去的缩略图上（把它摆进可用区正中）。
   *    手机上这一步是「滚到那一格的正中」，电脑上就是「把那一格挪到画布正中」——
   *    缩回网格后照片会挪位，镜头不跟过去的话人就不知道刚才点的是哪张。
   * ② 没有放大照 → 相机回到初始位（= 载入时那片海的正中）。
   *
   * 以前这里还有一段「放大照没居中就只居中、不退出」，离「点一下就走」太远：
   * 拖开画面之后想退出放大得点两次。现在第一下永远是退出 + 定位，
   * 和手机那颗按钮的行为对齐。
   */
  private resetCam(): void {
    if (this.mode === 'scroll') {
      // 滚动模式没有相机：
      //   放大中 → 退出放大，再按缩略图的新位置重新滚到视口正中
      //            （照片缩回网格后那一格会挪位，不跟着滚的话人还站在原地发懵）
      //   平时   → 回到照片海开头（浪头下面第一排），等于这片海的「正中」
      const cell = this.focusId ? this.byId.get(this.focusId) : null;
      if (this.focusId) {
        this.unfocus(true);
        if (cell) this.centerScrollOn(cell.rect.y, cell.rect.h, true);
      } else {
        this.scrollToY(0, true, 0);
      }
      this.syncResetLabel();
      return;
    }
    if (this.focusId) {
      const cell = this.focusId ? this.byId.get(this.focusId) : null;
      this.unfocus(true);
      if (cell) this.centerOnCell(cell, true);
      this.syncResetLabel();
      return;
    }
    this.centerCamera(true);
    this.syncResetLabel();
  }

  /**
   * 按钮的提示文案跟着那两段走：
   * 放大中 → 「退出放大并居中」；常态 → 「回到照片海正中」
   * 滚动模式（手机）同构：放大中 → 「退出放大」（同时滚到那一格）；平时 → 「回到照片海开头」。
   */
  private syncResetLabel(): void {
    const el = this.root.querySelector<HTMLElement>('[data-gal-action="reset"]');
    if (!el) return;
    // 滚动模式（手机）里没有相机：放大时退出，平时就是滚回这片海的开头
    if (this.mode === 'scroll') {
      const text = this.focusId ? '退出放大' : '回到照片海开头';
      el.setAttribute('title', text);
      el.setAttribute('aria-label', text);
      return;
    }
    const text = this.focusId ? '退出放大并居中' : '回到照片海正中';
    el.setAttribute('title', text);
    el.setAttribute('aria-label', text);
  }

  /* ---------------- 交互 ---------------- */

  private onPointerDown = (event: PointerEvent): void => {
    if (this.mode !== 'camera' || event.button !== 0) return;
    if (this.lb?.classList.contains('is-open')) return;
    const target = event.target as HTMLElement | null;
    // 分类抽屉、操作提示、灯箱、右下角那颗胶囊（随机 / 回到正中）都不是画布的一部分，别从这里开始拖
    if (
      target?.closest('[data-gal-rail], [data-gal-hint], [data-gal-lb], [data-gal-dock], [data-gal-action]')
    ) {
      return;
    }

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
    if (drag.moved) {
      this.clampCam(true);
      // 拖过之后这颗按钮的含义没变（放大中就是「退出放大并居中」），
      // 但滚动模式那边文案只跟放大状态走，顺手刷一下省得漏
      this.syncResetLabel();
    }
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
      this.syncResetLabel();
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
    this.syncResetLabel();
    this.syncUrl();
  }

  private unfocus(animate: boolean): void {
    if (!this.focusId) return;
    const previous = this.focusId;
    this.focusId = null;
    for (const cell of this.cells) cell.el.classList.remove('is-focus', 'is-tall');
    this.stage.classList.remove('is-focused');

    this.layout();
    this.moveCam(this.camBefore.x, this.camBefore.y, animate);
    this.clampCam(animate);
    this.syncResetLabel();
    this.syncUrl();

    const cell = this.byId.get(previous);
    if (cell) {
      cell.el.focus?.({ preventScroll: true });
      cell.el.classList.add('is-pinged');
      window.setTimeout(() => cell.el.classList.remove('is-pinged'), 720);
    }
  }

  /**
   * 滚动模式专用：自己算帧、自己写位置地滚过去
   * ------------------------------------------------------------
   * 为什么不用 `behavior: 'smooth'`：那条路在这页上会被掐掉 ——
   * 点击的照片/按钮一拿到焦点，浏览器会顺手做一次「把焦点元素滚进视口」，
   * 它会把刚开始的原生平滑滚动直接取消，表现是「点了按钮，页面纹丝不动」。
   * 自己的循环每帧写一次位置，被取消也只是少一帧，下一帧补上。
   * 每帧用 `behavior: 'instant'`：站点全局开着 CSS `scroll-behavior: smooth`，
   * 不写 instant 的话每帧的落点又会被浏览器插值一次，变成粘滞的慢镜头。
   */
  private animateScrollTo(top: number, duration = 380): void {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const to = clamp(top, 0, max);
    const from = window.scrollY;
    if (Math.abs(to - from) < 1) return;
    if (this.scrollAnim) window.cancelAnimationFrame(this.scrollAnim);

    const start = performance.now();
    const step = (now: number): void => {
      this.scrollAnim = 0;
      if (this.destroyed) return;
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic：起手快、收尾稳
      const y = Math.round(from + (to - from) * eased);
      try {
        window.scrollTo({ top: y, behavior: 'instant' });
      } catch {
        window.scrollTo(0, y); // 老浏览器不认识 instant，慢一点也得滚
      }
      if (p < 1) this.scrollAnim = window.requestAnimationFrame(step);
    };
    this.scrollAnim = window.requestAnimationFrame(step);
  }

  private scrollToY(y: number, animate: boolean, inset = this.vh * 0.16): void {
    // 竖向瀑布里没有相机，镜头平移的等价物就是滚页面：
    // inset = 这一格的上沿离视口上沿多少像素（居中用 centerScrollOn 算，回到开头给 0）
    const top = this.view.getBoundingClientRect().top + window.scrollY + y - inset;
    if (Math.abs(top - window.scrollY) < 2) return;
    if (animate) this.animateScrollTo(top);
    else this.animateScrollTo(top, 0);
  }

  /**
   * 滚动模式：把 y 处、高 h 的那一格滚到**视口正中**（上下留白相等）
   * ------------------------------------------------------------
   * 以前固定按「视口上方 16%」对齐，看着就是偏上 —— 矮照片尤其明显
   * （一张 210px 高的横图，顶边压在 135px 处，下面空一大片）。
   * 现在按「(屏高 − 照片高) ÷ 2」算留白：装得下就正正好在中间；
   * 比屏幕还高的竖图留白归 0，贴着上沿、下沿交给灯箱看。
   */
  private centerScrollOn(y: number, h: number, animate: boolean): void {
    this.scrollToY(y, animate, Math.max(0, (this.vh - h) / 2));
  }

  private centerOnFocus(animate: boolean): void {
    const rect = this.focusRect;
    if (!rect) return;

    if (this.mode === 'scroll') {
      // 竖向瀑布里没有相机，直接把它滚到视口正中
      this.centerScrollOn(rect.y, rect.h, animate);
      return;
    }

    const target = this.focusCamTarget();
    if (target) this.moveCam(target.x, target.y, animate);
  }

  /**
   * 「把某个矩形摆进可用区正中」对应的相机位置（只算，不动相机）
   * ------------------------------------------------------------
   * `withFocus = true`：聚焦中的放大照 —— 相机范围要**包含「把它摆到正中」那个值**
   * （照片原本贴着画布上沿 / 下沿时，只按画布边框限位就永远推不到中间，
   * 表现是「放大照贴着导航下沿、上下不居中」；越出去的那片交给星尘兜着）。
   * `withFocus = false`：退出放大后那张缩略图 —— 只用画布的正常边界，不额外放宽。
   */
  private camForRect(rect: Rect, withFocus: boolean): { x: number; y: number } {
    const bounds = this.camBounds(withFocus);
    // 可用区 = 导航底下到视口底部。照片在**这一块**里居中，
    // 而不是在整屏里居中 —— 否则它的上沿会被玻璃导航胶囊压住（看着像没对齐）。
    const bandTop = this.safeTop;
    const bandH = Math.max(120, this.vh - bandTop);
    let x = clamp(rect.x + rect.w / 2 - this.vw / 2, bounds.minX, bounds.maxX);
    let y = clamp(rect.y + rect.h / 2 - (bandTop + bandH / 2), bounds.minY, bounds.maxY);
    // 尽量居中，但**绝不把照片切掉**（比可用区还大就按上边对齐，看全图交给灯箱）
    if (rect.h <= bandH) {
      if (rect.y < y + bandTop) y = rect.y - bandTop;
      if (rect.y + rect.h > y + bandTop + bandH) y = rect.y + rect.h - bandTop - bandH;
    } else {
      y = rect.y - bandTop;
    }
    if (rect.x + rect.w > x + this.vw) x = rect.x + rect.w - this.vw;
    if (rect.x < x) x = rect.x;
    return { x, y };
  }

  /**
   * 「把放大照摆到可用区正中」对应的相机位置（只算，不动相机）
   */
  private focusCamTarget(): { x: number; y: number } | null {
    const rect = this.focusRect;
    if (!rect || this.mode === 'scroll') return null;
    return this.camForRect(rect, true);
  }

  /** 退出放大后镜头落在哪：把刚缩回网格的那张摆进可用区正中（手机上就是滚到视口正中） */
  private centerOnCell(cell: Cell, animate: boolean): void {
    if (this.mode !== 'camera') return;
    const target = this.camForRect(cell.rect, false);
    this.moveCam(target.x, target.y, animate);
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
    // 收起时也让人看得出来「现在筛过」：把手上的箭头染成主色（这个状态没有文字）
    this.rail?.classList.toggle('gal-rail--filtered', next !== null);
    for (const cell of this.cells) {
      const match = !next || cell.tags.includes(next);
      cell.visible = match;
      cell.el.classList.toggle('is-filtered', !match);
      cell.el.setAttribute('tabindex', match ? '0' : '-1');
    }

    if (this.focusId && !this.byId.get(this.focusId)?.visible) {
      this.focusId = null;
      for (const cell of this.cells) cell.el.classList.remove('is-focus', 'is-tall');
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
    this.syncResetLabel();
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
        : '点一下放大 · 再点看大图 · 大图里双指可放大';
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
    // 关掉时把双指 / 拖动的状态一并清掉，免得下次打开带着旧手势
    this.lbDrag = null;
    this.lbTouches.clear();
    this.lbPinch = null;
    this.lbIgnoreClickUntil = 0;
    this.lb.querySelector<HTMLElement>('[data-gal-lb-canvas]')?.classList.remove(
      'is-dragging',
      'is-pinching',
    );
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
    this.lbDrag = null;
    this.lbTouches.clear();
    this.lbPinch = null;
    this.lb.querySelector<HTMLElement>('[data-gal-lb-canvas]')?.classList.remove(
      'is-dragging',
      'is-pinching',
    );

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
    const canvas = event.currentTarget as HTMLElement;
    this.lbTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // 第二根手指按下 → 转成「双指缩放」，原本的单指拖动让位
    if (this.lbTouches.size === 2) {
      this.lbDrag = null;
      canvas.classList.remove('is-dragging');
      canvas.classList.add('is-pinching');
      this.lbIgnoreClickUntil = performance.now() + 400;
      this.startLbPinch();
      return;
    }
    // 三根以上：不管（避免第三根手指把基准算乱），等松开
    if (this.lbTouches.size > 2) return;

    // 单指：只有放大过才拖动查看
    if (this.lbZoom <= 1.01) return;
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

  /** 记下双指手势的基准：间距 / 中点 / 当前缩放和平移 / 画布中心 */
  private startLbPinch(): void {
    const pts = [...this.lbTouches.values()];
    const canvas = this.lb?.querySelector<HTMLElement>('[data-gal-lb-canvas]');
    if (pts.length < 2 || !canvas) return;
    const [a, b] = pts;
    const box = canvas.getBoundingClientRect();
    this.lbPinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: this.lbZoom,
      panX: this.lbPan.x,
      panY: this.lbPan.y,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      cx: box.left + box.width / 2,
      cy: box.top + box.height / 2,
    };
  }

  /**
   * 双指移动：间距比 → 缩放倍数；两指中点 → 锚点。
   * 手势开始时中点下面那个像素，整个过程中始终黏在手指中间；
   * 顺带也就支持了「双指一起平移」（间距不变、中点移动 = 只平移）。
   */
  private applyLbPinch(): void {
    const pinch = this.lbPinch;
    const pts = [...this.lbTouches.values()];
    if (!pinch || pts.length < 2) return;
    const [a, b] = pts;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    const next = clamp((pinch.zoom * dist) / pinch.dist, 1, LB_MAX_ZOOM);
    const ratio = next / pinch.zoom;

    // 相对画布中心的偏移（和中点/光标坐标口径一致）
    const startX = pinch.midX - pinch.cx;
    const startY = pinch.midY - pinch.cy;
    const nowX = midX - pinch.cx;
    const nowY = midY - pinch.cy;

    this.lbZoom = next;
    this.lbPan.x = nowX - (startX - pinch.panX) * ratio;
    this.lbPan.y = nowY - (startY - pinch.panY) * ratio;
    // 缩回原尺寸就归中，别留半像素偏移
    if (next <= 1.01) this.lbPan = { x: 0, y: 0 };
    this.applyLb(false);
  }

  /** 双指手势收尾：还有一根手指按着就接着当拖动，否则整个收干净 */
  private endLbPinch(canvas: HTMLElement): void {
    this.lbPinch = null;
    canvas.classList.remove('is-pinching');
    this.lbIgnoreClickUntil = performance.now() + 350;

    const rest = this.lbTouches.entries().next();
    if (rest.done) {
      this.lbDrag = null;
      // 一路缩回原尺寸：顺手归位（带过渡，看着是「弹回去」）
      if (this.lbZoom <= 1.01) this.resetLb();
      return;
    }

    const [id, pos] = rest.value;
    if (this.lbZoom <= 1.01) {
      this.lbDrag = null;
      return;
    }
    this.lbDrag = { id, x: pos.x, y: pos.y, px: this.lbPan.x, py: this.lbPan.y };
    canvas.classList.add('is-dragging');
    try {
      canvas.setPointerCapture(id);
    } catch {
      /* ignore */
    }
  }

  private onLbMove = (event: PointerEvent): void => {
    const pointer = this.lbTouches.get(event.pointerId);
    if (!pointer) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    if (this.lbPinch && this.lbTouches.size >= 2) {
      this.applyLbPinch();
      return;
    }

    const drag = this.lbDrag;
    if (!drag || drag.id !== event.pointerId) return;
    this.lbPan.x = drag.px + (event.clientX - drag.x);
    this.lbPan.y = drag.py + (event.clientY - drag.y);
    // 真拖开了就别再当成点击（否则松手时点空白会把灯箱关掉）
    if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 4) {
      this.lbIgnoreClickUntil = performance.now() + 220;
    }
    this.applyLb(false);
  };

  private onLbUp = (event: PointerEvent): void => {
    const canvas = event.currentTarget as HTMLElement;
    this.lbTouches.delete(event.pointerId);

    if (this.lbPinch) {
      this.endLbPinch(canvas);
      return;
    }
    if (!this.lbDrag) return;
    this.lbDrag = null;
    canvas.classList.remove('is-dragging');
    try {
      canvas.releasePointerCapture(event.pointerId);
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
    if (this.scrollAnim) window.cancelAnimationFrame(this.scrollAnim);
    this.dust?.destroy();
    this.themeObserver?.disconnect();
    this.widthObserver?.disconnect();
    this.widthObserver = null;
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
