/**
 * 文章图片放大查看（灯箱）
 * ============================================================
 * 点正文里的图 → 图从原位「长」到屏幕中央；再点一下 / Esc / 点空白原路缩回去。
 *
 * 交互一览：
 *   · 点开      → FLIP 动画（从原图那一块原地长大）
 *   · 滚轮      → 以鼠标为中心继续放大 / 缩小（1× ~ 4×；1× = 撑满视口的适配大小）
 *   · 双指      → 手机上两指捏合缩放（同滚轮，以两指正中为轴；松掉一根还能接着拖）
 *   · 拖动      → 放大之后用鼠标 / 手指平移看细节
 *   · 双击      → 在「适配」和 2.4× 之间来回切
 *   · 点图片    → 适配大小下 = 关闭；已经放大了 = 回到适配大小
 *   · 点空白 / Esc / 右上角 × = 关闭
 *   · ← →      → 多图时翻到上一张 / 下一张
 *
 * 三个关键决定：
 *
 * ① 用 <dialog> 而不是自己铺一层 div
 *    · 自带顶层（top layer）：写作页的预览弹窗也是 dialog，
 *      自己写的 div 会被它压住，而 showModal() 的 dialog 不会；
 *    · Esc 关闭、焦点陷阱、遮罩都是浏览器给的，不用自己造。
 *
 * ② 动画 / 缩放全部走 transform，不动 width/height
 *    图片先按「适配大小」摆好（left/top/width/height 只写一次），
 *    之后开合是 FLIP、放大是 translate(pan) + scale(s) —— 每一帧都不触发布局，
 *    放大到 4× 也不掉帧。
 *
 * ③ 以光标为中心缩放
 *    滚轮时让「光标底下那一点」原地不动（zoomAt 里的推导），
 *    手感才像地图，而不是「放大后再自己去找刚才看的位置」。
 *
 * 另外：滚轮事件必须在灯箱里被吃掉（preventDefault + stopPropagation），
 * 否则站点的惯性滚动脚本会接着把文章滚起来。
 */
import { onBeforeSwap, onPageLoad } from './pageload';

/** 放大后距离视口边缘的留白（px） */
const PAD = 24;
/** 小于这个尺寸的图不参与放大（图标、徽标、二维码之类） */
const MIN_SIDE = 140;
/** 收放动画时长（毫秒），和 image-zoom.css 里的过渡保持一致 */
const DUR = 340;
/** 最多能放到适配大小的几倍 */
const MAX_SCALE = 4;
/** 双击直达的倍率 */
const DOUBLE_SCALE = 2.4;
/**
 * 「双击」的判定窗口（毫秒）。
 * 也是「单击关闭」要等的时长：要先留出被双击打断的余地，
 * 所以点图片关闭会比点 × 慢这么一点。
 */
const DOUBLE_MS = 280;
/** 操作提示挂多久（毫秒） */
const HINT_MS = 4200;

const CLOSE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>';
const PREV_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>';
const NEXT_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let dialog: HTMLDialogElement | null = null;
let pic: HTMLImageElement | null = null;
let captionEl: HTMLElement | null = null;
let hintEl: HTMLElement | null = null;
let closeBtn: HTMLButtonElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;

/** 当前这一组可放大的图（同一篇正文里的） */
let list: HTMLImageElement[] = [];
let index = 0;
/** 打开前焦点在哪，关掉之后还回去 */
let opener: HTMLElement | null = null;

let closeTimer = 0;
let hintTimer = 0;
let wheelTimer = 0;
let clickTimer = 0;

/* ---- 视图状态（1× = 撑满视口的适配大小） ---- */
/** 适配大小那一档的落点，缩放 / 平移都相对它算 */
let base: Rect = { x: 0, y: 0, w: 1, h: 1 };
let scale = 1;
let pan = { x: 0, y: 0 };
let drag: { x: number; y: number; panX: number; panY: number } | null = null;
let dragged = false;
/** 上一次点图片的时间，用来自己判「双击」（不依赖浏览器的 dblclick 节奏） */
let lastClickAt = 0;

/**
 * 同时按在屏幕上的指针（手机双指缩放靠它）。
 * 一支手是「拖动平移」，两支手就是「捏合缩放」。
 */
const pointers = new Map<number, { x: number; y: number }>();
/** 双指缩放的起点：两指间距、当时的倍率、中点与平移量 */
let pinch: { dist: number; scale: number; midX: number; midY: number; panX: number; panY: number } | null =
  null;

/* -------------------------------------------------------------------
 * 结构
 * ------------------------------------------------------------------- */

function build(): void {
  const el = document.createElement('dialog');
  el.className = 'img-zoom';
  el.dataset.imgZoom = '';
  el.setAttribute('aria-label', '图片放大查看');
  // 自己接住焦点（见 open 里的说明）：tabindex="-1" 让它可聚焦但不在 Tab 顺序里
  el.tabIndex = -1;

  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const hint = fine ? '滚轮放大 · 双击切换 · Esc 关闭' : '双指放大 · 拖动查看 · 点 × 关闭';

  el.innerHTML =
    `<button type="button" class="img-zoom__nav img-zoom__nav--prev" data-iz-prev aria-label="上一张">${PREV_GLYPH}</button>` +
    `<button type="button" class="img-zoom__nav img-zoom__nav--next" data-iz-next aria-label="下一张">${NEXT_GLYPH}</button>` +
    `<button type="button" class="img-zoom__close" data-iz-close aria-label="关闭（Esc）">${CLOSE_GLYPH}</button>` +
    `<span class="img-zoom__hint" data-iz-hint>${hint}</span>` +
    '<img class="img-zoom__pic" data-iz-pic alt="" draggable="false" decoding="async">' +
    '<p class="img-zoom__caption" data-iz-caption></p>';

  document.body.append(el);

  dialog = el;
  pic = el.querySelector<HTMLImageElement>('[data-iz-pic]');
  captionEl = el.querySelector<HTMLElement>('[data-iz-caption]');
  hintEl = el.querySelector<HTMLElement>('[data-iz-hint]');
  closeBtn = el.querySelector<HTMLButtonElement>('[data-iz-close]');
  prevBtn = el.querySelector<HTMLButtonElement>('[data-iz-prev]');
  nextBtn = el.querySelector<HTMLButtonElement>('[data-iz-next]');

  closeBtn?.addEventListener('click', () => close());
  prevBtn?.addEventListener('click', () => void step(-1));
  nextBtn?.addEventListener('click', () => void step(1));

  el.addEventListener('click', onClick);
  // 滚轮：先吃掉，别让站点的惯性滚动接手（见文件头）
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);

  // 接住 Esc：先播收起的动画，动画放完再真正关掉
  el.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
}

/** 换页之后旧灯箱已经不在 DOM 里了，重建一份 */
function ensure(): void {
  if (dialog?.isConnected) return;
  dialog = null;
  pic = null;
  captionEl = null;
  hintEl = null;
  closeBtn = null;
  prevBtn = null;
  nextBtn = null;
  build();
}

/* -------------------------------------------------------------------
 * 挑选可放大的图
 * ------------------------------------------------------------------- */

function zoomable(img: HTMLImageElement): boolean {
  if (!img.getAttribute('src')) return false;
  if (img.hasAttribute('data-no-zoom')) return false;
  // 图片外面套着链接：链接优先，别把人家的跳转抢了
  if (img.closest('a')) return false;
  const rect = img.getBoundingClientRect();
  return rect.width >= MIN_SIDE && rect.height >= MIN_SIDE;
}

/** 同一个 .prose-blog 里的所有可放大图（写作页预览也走这条路） */
function group(img: HTMLImageElement): HTMLImageElement[] {
  const scope: ParentNode = img.closest('.prose-blog') ?? document;
  return [...scope.querySelectorAll<HTMLImageElement>('img')].filter(zoomable);
}

/* -------------------------------------------------------------------
 * 缩放 / 平移
 * ------------------------------------------------------------------- */

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 平移不能把图拖出屏幕：比视口大的方向最多拖到边缘对齐，比视口小就锁在正中间 */
function clampPan(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const limitX = Math.max(0, (base.w * scale - vw) / 2);
  const limitY = Math.max(0, (base.h * scale - vh) / 2);
  pan.x = clamp(pan.x, -limitX, limitX);
  pan.y = clamp(pan.y, -limitY, limitY);
}

/** 把当前 scale / pan 写到 transform 上 */
function paint(): void {
  if (!pic || !dialog) return;
  pic.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
  dialog.classList.toggle('is-zoomed', scale > 1.01);
}

/**
 * 以 (px, py) 这一点为中心缩放。
 * 推导：设图片中心 C = base 中心 + pan，光标下的图内偏移 u = (p - C - pan) / s；
 * 缩放后要求 p 仍指向同一个 u：p = C + pan' + s'·u
 *   → pan' = p - C - (s'/s)·(p - C - pan)
 */
function zoomAt(px: number, py: number, next: number): void {
  const k = next / scale;
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  const vx = px - cx - pan.x;
  const vy = py - cy - pan.y;

  pan.x = px - cx - k * vx;
  pan.y = py - cy - k * vy;
  scale = next;
  clampPan();
  paint();
}

/** 滚轮时挂一会儿过渡，手感更顺；停下来就摘掉，免得拖动发飘 */
function settleWheel(): void {
  if (!dialog) return;
  dialog.classList.add('is-zooming');
  window.clearTimeout(wheelTimer);
  wheelTimer = window.setTimeout(() => dialog?.classList.remove('is-zooming'), 150);
}

/** 回到「适配大小」 */
function resetZoom(animate = true): void {
  scale = 1;
  pan = { x: 0, y: 0 };
  if (animate && dialog) {
    dialog.classList.add('is-anim');
    window.setTimeout(() => dialog?.classList.remove('is-anim'), DUR);
  }
  paint();
}

/* -------------------------------------------------------------------
 * 尺寸计算
 * ------------------------------------------------------------------- */

/** 图片在视口里「看得见」的那一块（超高的图别从屏幕外飞进来） */
function clampRect(rect: DOMRect): Rect {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  return {
    x: left,
    y: top,
    w: Math.max(1, right - left),
    h: Math.max(1, bottom - top),
  };
}

/** 等图片解码完（同一张图已经在缓存里，通常这一帧就好了） */
async function ready(img: HTMLImageElement): Promise<boolean> {
  if (img.complete && img.naturalWidth) return true;
  if (typeof img.decode === 'function') {
    try {
      await img.decode();
    } catch {
      /* 解码失败就走下面的判断 */
    }
  }
  return img.complete && img.naturalWidth > 0;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 图注：figure 的 figcaption 优先，其次 alt，多图时再补「第几张」 */
function setCaption(target: HTMLImageElement, at: number): void {
  if (!captionEl) return;
  const fig =
    target.closest('figure')?.querySelector('figcaption')?.textContent?.trim() ||
    (target.alt ?? '').trim();
  const counter = list.length > 1 ? `${at + 1} / ${list.length}` : '';
  const text = [fig, counter].filter(Boolean).join('  ·  ');
  captionEl.textContent = text;
  captionEl.hidden = !text;
}

/* -------------------------------------------------------------------
 * 开 / 关 / 翻页
 * ------------------------------------------------------------------- */

/**
 * 把当前这张摆到屏幕中央（from 给定时从 from 那块「长」出来）。
 * 无论哪条路，缩放都先回到 1×，本地重新量一次。
 */
async function place(from: Rect | null): Promise<void> {
  const img = pic;
  const host = dialog;
  if (!img || !host) return;

  if (!(await ready(img))) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const capH = captionEl && !captionEl.hidden ? 34 : 0;

  const nw = img.naturalWidth || 1;
  const nh = img.naturalHeight || 1;
  // 不放大到超出原图尺寸：小图拉大只会糊
  const k = Math.min((vw - PAD * 2) / nw, (vh - PAD * 2 - capH) / nh, 1);
  const w = Math.max(1, Math.round(nw * k));
  const h = Math.max(1, Math.round(nh * k));
  const x = Math.round((vw - w) / 2);
  const y = Math.round((vh - h - capH) / 2);

  base = { x, y, w, h };
  scale = 1;
  pan = { x: 0, y: 0 };
  // 换图 / 重开时把手势状态清干净，免得上一张的捏合残留到这一张
  pointers.clear();
  pinch = null;
  drag = null;
  dragged = false;

  if (!host.open) host.showModal();
  host.classList.remove('is-anim', 'is-swap', 'is-closing', 'is-zoomed', 'is-dragging', 'is-zooming');

  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
  img.style.left = `${x}px`;
  img.style.top = `${y}px`;
  img.style.opacity = '1';

  if (!from) {
    paint();
    host.classList.add('is-open');
    return;
  }

  // FLIP：先摆成「缩回起点」的样子，一帧之后再归零
  const sx = from.w / w;
  const sy = from.h / h;
  const dx = from.x + from.w / 2 - (x + w / 2);
  const dy = from.y + from.h / 2 - (y + h / 2);
  img.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

  void img.offsetWidth; // 强制算一次布局，保证下面这帧是从起点开始过渡的

  requestAnimationFrame(() => {
    host.classList.add('is-anim');
    paint();
    host.classList.add('is-open');
  });
}

async function open(source: HTMLImageElement): Promise<void> {
  ensure();
  if (!pic) return;

  const pics = group(source);
  const at = pics.indexOf(source);
  if (at < 0) return;

  list = pics;
  index = at;
  lastClickAt = 0;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : source;

  const start = clampRect(source.getBoundingClientRect());

  pic.src = source.currentSrc || source.src;
  pic.alt = source.alt ?? '';
  setCaption(source, at);
  syncNav();

  document.documentElement.classList.add('img-zoom-lock');
  await place(start);

  // 图片没解码出来（坏图 / 被拦了）就别把页面锁死
  if (!dialog?.open) {
    document.documentElement.classList.remove('img-zoom-lock');
    return;
  }

  // 焦点落在对话框本身（而不是某个按钮上）：
  // 浏览器默认会把焦点丢给第一个可聚焦的子元素，鼠标点开图片时
  // 那圈 :focus-visible 白框会糊在「上一张」按钮上，看着像 bug。
  // 落在 dialog 上则没有可见焦点样式，键盘用户按一下 Tab 照样进到按钮里。
  dialog?.focus({ preventScroll: true });
  showHint();
}

function syncNav(): void {
  const many = list.length > 1;
  if (prevBtn) prevBtn.hidden = !many;
  if (nextBtn) nextBtn.hidden = !many;
}

function showHint(): void {
  if (!hintEl) return;
  hintEl.classList.remove('is-hidden');
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hintEl?.classList.add('is-hidden'), HINT_MS);
}

/** 翻到上 / 下一张（换图时先淡出再淡入，不播 FLIP） */
async function step(dir: number): Promise<void> {
  if (list.length < 2 || !dialog || !pic) return;
  const next = (index + dir + list.length) % list.length;
  const target = list[next];
  if (!target) return;

  index = next;
  dialog.classList.add('is-swap');
  await wait(140);

  pic.src = target.currentSrc || target.src;
  pic.alt = target.alt ?? '';
  setCaption(target, next);
  await place(null);

  requestAnimationFrame(() => dialog?.classList.remove('is-swap'));
}

function close(): void {
  if (!dialog || !dialog.open || !pic) return;

  window.clearTimeout(closeTimer);
  window.clearTimeout(clickTimer);
  window.clearTimeout(hintTimer);
  dialog.classList.remove('is-open');
  // 薄雾先淡掉，图片自己按 FLIP 缩回去（见 image-zoom.css 的 ::backdrop 动画）
  dialog.classList.add('is-closing');

  const thumb = list[index];
  const rect = thumb?.isConnected ? thumb.getBoundingClientRect() : null;
  const visible = rect && rect.width > 4 && rect.bottom > 0 && rect.top < window.innerHeight;

  if (visible && rect) {
    // 原路缩回去。
    // 目标 transform 直接按「适配大小」那套基准算（transform-origin 都是图片中心），
    // 于是无论当前是 1× 还是 4×，浏览器都会从眼下这一帧平滑过渡过去，
    // 不用先跳回适配大小再缩。
    const start = clampRect(rect);
    const dx = start.x + start.w / 2 - (base.x + base.w / 2);
    const dy = start.y + start.h / 2 - (base.y + base.h / 2);
    dialog.classList.add('is-anim');
    pic.style.transform = `translate(${dx}px, ${dy}px) scale(${start.w / base.w}, ${start.h / base.h})`;
    closeTimer = window.setTimeout(finishClose, DUR);
    return;
  }

  // 原图已经不在视口里（或者被换掉了）：直接淡出
  dialog.classList.add('is-closing');
  pic.style.opacity = '0';
  closeTimer = window.setTimeout(finishClose, 200);
}

function finishClose(): void {
  window.clearTimeout(closeTimer);
  closeTimer = 0;
  if (!dialog) return;

  dialog.classList.remove('is-anim', 'is-swap', 'is-closing', 'is-open', 'is-zoomed', 'is-dragging');
  scale = 1;
  pan = { x: 0, y: 0 };
  pointers.clear();
  pinch = null;
  drag = null;
  dragged = false;
  lastClickAt = 0;
  if (pic) {
    pic.style.transform = '';
    pic.style.opacity = '';
  }
  if (dialog.open) dialog.close();

  document.documentElement.classList.remove('img-zoom-lock');
  const back = opener;
  opener = null;
  if (back?.isConnected) back.focus({ preventScroll: true });
}

/* -------------------------------------------------------------------
 * 交互
 * ------------------------------------------------------------------- */

function onClick(event: MouseEvent): void {
  const target = event.target;

  // 点空白处直接关
  if (target === dialog) {
    close();
    return;
  }
  if (target !== pic) return;

  // 刚拖着平移过：这一下不算点击
  if (dragged) {
    dragged = false;
    return;
  }

  const now = Date.now();
  const isDouble = now - lastClickAt < DOUBLE_MS;
  lastClickAt = now;
  window.clearTimeout(clickTimer);

  // 双击：在「适配」和 2.4× 之间来回切
  if (isDouble) {
    if (scale > 1.01) {
      resetZoom();
    } else {
      zoomAt(event.clientX, event.clientY, DOUBLE_SCALE);
      settleWheel();
    }
    return;
  }

  // 已经放大了：单击先回到「适配大小」
  if (scale > 1.01) {
    resetZoom();
    return;
  }

  // 适配大小下单击 = 关闭；但先等一小会儿，接到双击就改主意
  clickTimer = window.setTimeout(() => close(), DOUBLE_MS);
}

function onWheel(event: WheelEvent): void {
  if (!dialog?.open) return;
  // 吃掉滚轮：既放大图片，也拦住站点的惯性滚动（否则文章会跟着滚）
  event.preventDefault();
  event.stopPropagation();

  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
  const delta = event.deltaY * unit;
  if (!delta) return;

  const next = clamp(scale * Math.exp(-delta * 0.0018), 1, MAX_SCALE);
  if (Math.abs(next - scale) < 0.0015) return; // 已经顶到边界

  zoomAt(event.clientX, event.clientY, next);
  settleWheel();
}

function onPointerDown(event: PointerEvent): void {
  if (event.target !== pic || !pic) return;
  if (event.button !== 0 && event.pointerType === 'mouse') return;

  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  try {
    pic.setPointerCapture(event.pointerId);
  } catch {
    /* 有些环境拿不到指针，忽略 */
  }

  if (pointers.size === 1) {
    // 新的一次触摸 / 按下：先清掉上一轮「刚拖过」的标记，
    // 否则捏合松手后的第一下点击会被当成"拖动结束"吞掉
    dragged = false;
    // 只有放大之后才谈得上拖动；1× 时按下不动，等第二根手指
    if (scale <= 1.01) return;
    drag = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    dialog?.classList.remove('is-zooming');
    dialog?.classList.add('is-dragging');
    return;
  }

  if (pointers.size === 2) {
    // 第二根手指按下：从「拖动」切成「双指缩放」
    drag = null;
    dialog?.classList.remove('is-dragging');
    const [a, b] = [...pointers.values()];
    if (a && b) {
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        panX: pan.x,
        panY: pan.y,
      };
    }
  }
}

/** 两指间距小于这个值（px）时不动，避免开局抖一下 */
const PINCH_MIN_SPAN = 8;

function onPointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  // ① 双指：按两指间距的比例缩放，同时跟着两指中点平移（相当于「以两指正中为轴」）
  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    if (!pinch) {
      pinch = { dist, scale, midX, midY, panX: pan.x, panY: pan.y };
      return;
    }
    if (pinch.dist < PINCH_MIN_SPAN || dist <= 0) return;

    event.preventDefault();
    dialog?.classList.remove('is-zooming');

    pan.x = pinch.panX + (midX - pinch.midX);
    pan.y = pinch.panY + (midY - pinch.midY);
    zoomAt(midX, midY, clamp(pinch.scale * (dist / pinch.dist), 1, MAX_SCALE));
    dragged = true;
    return;
  }

  // ② 单指 / 鼠标：放大之后才能拖
  if (!drag) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 5) dragged = true;

  pan.x = drag.panX + dx;
  pan.y = drag.panY + dy;
  clampPan();
  paint();
}

function onPointerUp(event: PointerEvent): void {
  if (pointers.has(event.pointerId)) {
    pointers.delete(event.pointerId);
    try {
      pic?.releasePointerCapture(event.pointerId);
    } catch {
      /* 指针已经没了，忽略 */
    }
  }

  if (pointers.size < 2) pinch = null;
  drag = null;
  dialog?.classList.remove('is-dragging');

  // 双指松掉一根：剩下那根接着能拖（放大状态下）
  if (pointers.size === 1 && scale > 1.01) {
    const [point] = [...pointers.values()];
    if (point) drag = { x: point.x, y: point.y, panX: pan.x, panY: pan.y };
  }

  // dragged 留着不清：紧跟着的那次 click 要认出「这是拖完 / 捏合松手，不是点击」，
  // 下一次 pointerdown 会把它复位
}

function onDocClick(event: MouseEvent): void {
  if (dialog?.open) return; // 灯箱里的点击由它自己处理
  const target = event.target instanceof Element ? event.target : null;
  const img = target?.closest('img');
  if (!img || !(img instanceof HTMLImageElement)) return;
  if (!img.closest('.prose-blog') || !zoomable(img)) return;

  event.preventDefault();
  void open(img);
}

function onDocKey(event: KeyboardEvent): void {
  if (!dialog?.open) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    void step(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    void step(1);
  } else if (event.key === '0') {
    resetZoom();
  }
}

// window / document 级监听只注册一次（换页不重建 document，模块也只执行一次）
document.addEventListener('click', onDocClick);
document.addEventListener('keydown', onDocKey);

onBeforeSwap(() => {
  window.clearTimeout(closeTimer);
  window.clearTimeout(hintTimer);
  window.clearTimeout(wheelTimer);
  window.clearTimeout(clickTimer);
  closeTimer = 0;
  if (dialog?.open) dialog.close();
  dialog?.remove();
  dialog = null;
  pic = null;
  captionEl = null;
  hintEl = null;
  closeBtn = null;
  prevBtn = null;
  nextBtn = null;
  list = [];
  index = 0;
  opener = null;
  scale = 1;
  pan = { x: 0, y: 0 };
  pointers.clear();
  pinch = null;
  drag = null;
  dragged = false;
  document.documentElement.classList.remove('img-zoom-lock');
});

// 首屏兜底：万一上一页残留了滚动锁，进来先解开
onPageLoad(() => {
  document.documentElement.classList.remove('img-zoom-lock');
});
