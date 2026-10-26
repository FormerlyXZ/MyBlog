/**
 * 动态页交互
 * ============================================================
 * 做六件事：
 *   ① 相对时间：服务端渲染的是「10月24日 09:02」，这里升级成「3 小时前 / 昨天 21:10」
 *   ② 心情标签：点卡片上的 emoji，从侧面滑出一句中文说明（开心 / 平静 …）
 *   ③ 图片灯箱：点开九宫格任意一张，滚轮 / 双指缩放、拖动平移、左右翻看
 *   ④ 点赞：计数走 Worker 的 /api/like，必须用 GitHub 登录（每个账号每条一次）
 *   ⑤ 分享：把 /moments/#m-xxx 复制到剪贴板
 *   ⑥ 浏览量：卡片滚进视口才算一次（/api/view，后端按 IP 30 分钟去重）
 *
 * 和全站其他脚本一样，走 onPageLoad / onBeforeSwap：
 * ClientRouter 换页会换掉 DOM，所以每次进页面重新查元素、给新 DOM 绑事件。
 */

import { onBeforeSwap, onPageLoad } from './pageload';
import { copyText } from '../utils/clipboard';
import {
  ApiError,
  clearSession,
  fetchMeta,
  getSession,
  onAuthChange,
  openLogin,
  sendLike,
  sendView,
  showToast,
} from '../utils/site';

/* ============================================================
   ① 相对时间
   ============================================================ */

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * 服务端已经给了绝对时间，这里只在「最近 7 天」内换成更口语的说法。
 * 超过 7 天（或解析失败）就保留原样 —— 旧动态写「5月20日」比写「159 天前」好读。
 */
function relativeLabel(date: Date, now: Date): string | null {
  const diff = now.getTime() - date.getTime();
  if (Number.isNaN(diff)) return null;
  if (diff < 0) return null; // 未来时间（时钟不对）就别硬算，保留绝对时间

  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;

  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((today.getTime() - day.getTime()) / 86400000);

  if (dayDiff === 0) return `今天 ${clock}`;
  if (dayDiff === 1) return `昨天 ${clock}`;
  if (dayDiff < 7) return `${dayDiff} 天前`;
  return null;
}

function upgradeTimes(): void {
  const now = new Date();
  for (const el of document.querySelectorAll<HTMLTimeElement>('[data-moment-time]')) {
    if (el.dataset.upgraded === '1') continue;
    el.dataset.upgraded = '1';
    el.dataset.absolute ??= el.textContent?.trim() ?? '';

    const raw = el.getAttribute('datetime');
    if (!raw) continue;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) continue;

    const label = relativeLabel(date, now);
    if (label) {
      el.textContent = label;
      el.title = el.dataset.absolute;
    }
  }
}

/* ============================================================
   ② 心情标签弹层
   ------------------------------------------------------------
   卡片上那个 emoji 是个按钮：点一下从它右侧滑出一小片中文说明
   （🌿 → 平静、😀 → 开心）。同一时间只开一个，点空白 / Esc 收起。
   ============================================================ */

function closeMoodPops(except?: HTMLElement | null): void {
  for (const wrap of document.querySelectorAll<HTMLElement>('[data-moment-mood-wrap]')) {
    if (wrap === except || !wrap.classList.contains('is-open')) continue;
    wrap.classList.remove('is-open');
    wrap.querySelector<HTMLElement>('[data-moment-mood-btn]')?.setAttribute('aria-expanded', 'false');
  }
}

function bindMoodPops(): void {
  for (const wrap of document.querySelectorAll<HTMLElement>('[data-moment-mood-wrap]')) {
    if (wrap.dataset.bound === '1') continue;
    wrap.dataset.bound = '1';

    const btn = wrap.querySelector<HTMLButtonElement>('[data-moment-mood-btn]');
    const pop = wrap.querySelector<HTMLElement>('[data-moment-mood-pop]');
    if (!btn || !pop) continue;
    // 手写 JSON 塞了不在表里的 emoji：没有中文说法，就别弹个空框
    if (!pop.textContent?.trim()) continue;

    btn.addEventListener('click', (event) => {
      // 别让这次点击冒到 document，否则会立刻被「点空白收起」关掉
      event.stopPropagation();
      const wasOpen = wrap.classList.contains('is-open');
      closeMoodPops();
      if (wasOpen) return;
      wrap.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
    });
  }
}

/* 点空白 / 按 Esc 收起（document 级监听只绑一次） */
document.addEventListener('click', (event) => {
  const target = event.target as Node | null;
  if (!target) return;
  const open = document.querySelector<HTMLElement>('[data-moment-mood-wrap].is-open');
  if (open && !open.contains(target)) closeMoodPops();
});

/* ============================================================
   ③ 图片灯箱（可缩放，滚轮 / 双指）
   ============================================================ */

interface LightboxItem {
  src: string;
  alt: string;
}

let box: HTMLDialogElement | null = null;
let boxImg: HTMLImageElement | null = null;
let boxCaption: HTMLElement | null = null;
let boxHint: HTMLElement | null = null;
let boxList: LightboxItem[] = [];
let boxIndex = 0;
let boxOpener: HTMLElement | null = null;

/** 最多放大到适配大小的几倍 */
const MAX_SCALE = 4;
/** 双击 / 双指快速切到的大档位 */
const DOUBLE_SCALE = 2.4;

/* ---- 缩放状态：1× = 撑满视口的适配大小，之后只走 transform，不触发布局 ---- */
let scale = 1;
let pan = { x: 0, y: 0 };
/** 适配大小那一档的落点（每张图量一次），缩放 / 平移都相对它算 */
let base = { cx: 0, cy: 0, w: 1, h: 1 };
let drag: { id: number; x: number; y: number; panX: number; panY: number } | null = null;
let pinch: { dist: number; scale: number; midX: number; midY: number; panX: number; panY: number } | null =
  null;
/** 当前按在屏幕上的手指 / 鼠标（双指缩放要靠它） */
const pointers = new Map<number, { x: number; y: number }>();
let dragged = false;
let hintTimer = 0;
let zoomTimer = 0;
/** 换图计数：异步量尺寸回来时用它判断「还是不是同一张」 */
let paintToken = 0;

const CLOSE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>';
const PREV_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>';
const NEXT_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>';

function ensureBox(): void {
  if (box?.isConnected) return;
  box = null;
  boxImg = null;
  boxCaption = null;
  boxHint = null;

  const el = document.createElement('dialog');
  el.className = 'moment-lightbox';
  el.setAttribute('aria-label', '查看大图');
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  el.innerHTML =
    `<button type="button" class="moment-lightbox__nav moment-lightbox__nav--prev" data-ml-prev aria-label="上一张">${PREV_GLYPH}</button>` +
    `<button type="button" class="moment-lightbox__nav moment-lightbox__nav--next" data-ml-next aria-label="下一张">${NEXT_GLYPH}</button>` +
    `<button type="button" class="moment-lightbox__close" data-ml-close aria-label="关闭">${CLOSE_GLYPH}</button>` +
    `<span class="moment-lightbox__hint" data-ml-hint>${fine ? '滚轮放大 · 拖动平移 · Esc 关闭' : '双指放大 · 拖动平移 · 点空白关闭'}</span>` +
    '<img class="moment-lightbox__pic" data-ml-img alt="" decoding="async" draggable="false">' +
    '<p class="moment-lightbox__caption" data-ml-caption></p>';

  el.querySelector('[data-ml-close]')?.addEventListener('click', () => closeBox());
  el.querySelector('[data-ml-prev]')?.addEventListener('click', () => stepBox(-1));
  el.querySelector('[data-ml-next]')?.addEventListener('click', () => stepBox(1));

  // Esc：先走自己的收尾（清掉 src、把焦点还回去），再真正关闭
  el.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeBox();
  });

  // 点遮罩空白处关闭（点图片本身不关）
  el.addEventListener('click', (event) => {
    if (event.target === el) closeBox();
  });

  // 滚轮：放大缩小，且必须把事件吃掉 —— 否则后面的动态列表会跟着滚
  el.addEventListener('wheel', onBoxWheel, { passive: false });

  // 拖拽平移 / 双指缩放
  el.addEventListener('pointerdown', onBoxPointerDown);
  el.addEventListener('pointermove', onBoxPointerMove);
  el.addEventListener('pointerup', onBoxPointerUp);
  el.addEventListener('pointercancel', onBoxPointerUp);

  // 双击在「适配」和 2.4× 之间来回切
  el.addEventListener('dblclick', (event) => {
    if (event.target !== boxImg || !boxImg) return;
    event.preventDefault();
    if (scale > 1.01) resetZoom();
    else zoomAt(event.clientX, event.clientY, DOUBLE_SCALE);
  });

  // 放大后点一下图片：先回到适配大小（再点才是关闭）
  el.addEventListener('click', (event) => {
    if (event.target !== boxImg) return;
    if (dragged) {
      dragged = false;
      return;
    }
    if (scale > 1.01) resetZoom();
  });

  document.body.append(el);

  box = el;
  boxImg = el.querySelector<HTMLImageElement>('[data-ml-img]');
  boxCaption = el.querySelector<HTMLElement>('[data-ml-caption]');
  boxHint = el.querySelector<HTMLElement>('[data-ml-hint]');
}

/* ---------------- 缩放 / 平移 ---------------- */

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 平移不能把图拖出屏幕：比视口大的方向最多拖到边缘对齐，小就锁在正中间 */
function clampPan(): void {
  const limitX = Math.max(0, (base.w * scale - window.innerWidth) / 2);
  const limitY = Math.max(0, (base.h * scale - window.innerHeight) / 2);
  pan.x = clamp(pan.x, -limitX, limitX);
  pan.y = clamp(pan.y, -limitY, limitY);
}

/** 把 scale / pan 写到 transform 上（只动 transform，不触发布局） */
function paintZoom(): void {
  if (!boxImg || !box) return;
  boxImg.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
  box.classList.toggle('is-zoomed', scale > 1.01);
}

/** 量一次「适配大小」时的图片位置（只在 scale=1 / pan=0 时量） */
function measure(): void {
  if (!boxImg) return;
  const rect = boxImg.getBoundingClientRect();
  base = {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    w: rect.width || 1,
    h: rect.height || 1,
  };
}

/** 以 (px, py) 这一点为中心缩放：光标底下的那块画面原地不动 */
function zoomAt(px: number, py: number, next: number): void {
  const k = next / scale;
  const vx = px - base.cx - pan.x;
  const vy = py - base.cy - pan.y;
  pan.x = px - base.cx - k * vx;
  pan.y = py - base.cy - k * vy;
  scale = next;
  clampPan();
  paintZoom();
}

/** 回到「适配大小」 */
function resetZoom(): void {
  scale = 1;
  pan = { x: 0, y: 0 };
  paintZoom();
}

/** 等这张图解码完再量尺寸（换图时不然会量到上一张的位置） */
async function settleImage(token: number): Promise<void> {
  const img = boxImg;
  if (!img) return;
  if (typeof img.decode === 'function') {
    try {
      await img.decode();
    } catch {
      /* 解码失败就按已就绪处理 */
    }
  }
  // 期间用户翻了页 / 关了灯箱：这次量出来的尺寸已经没用了
  if (token !== paintToken || !img.isConnected) return;
  resetZoom();
  measure();
}

/* ---------------- 交互 ---------------- */

function onBoxWheel(event: WheelEvent): void {
  if (!box?.open) return;
  // 既放大图片，也拦住后面的列表（滚轮穿透会让页面跟着滚）
  event.preventDefault();
  event.stopPropagation();

  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
  const delta = event.deltaY * unit;
  if (!delta) return;

  const next = clamp(scale * Math.exp(-delta * 0.0018), 1, MAX_SCALE);
  if (Math.abs(next - scale) < 0.0015) return; // 已经顶到边界
  zoomAt(event.clientX, event.clientY, next);

  // 滚轮一格一格跳，挂一小会儿过渡会顺滑很多；停下来就摘掉，免得拖动发飘
  box.classList.add('is-zooming');
  window.clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => box?.classList.remove('is-zooming'), 160);
}

function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function onBoxPointerDown(event: PointerEvent): void {
  if (!box?.open || !boxImg) return;
  if (event.target !== boxImg) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  box.classList.add('is-dragging');
  try {
    boxImg.setPointerCapture(event.pointerId);
  } catch {
    /* 某些环境拿不到指针，忽略 */
  }

  if (pointers.size === 1) {
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    dragged = false;
  } else if (pointers.size === 2) {
    // 第二根手指按下：从拖动切成双指缩放
    drag = null;
    const [a, b] = [...pointers.values()];
    if (a && b) {
      pinch = {
        dist: pointerDistance(a, b),
        scale,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        panX: pan.x,
        panY: pan.y,
      };
    }
  }
}

function onBoxPointerMove(event: PointerEvent): void {
  if (!box?.open || !boxImg) return;
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  // ① 双指：按两指间距的比例缩放，同时跟着两指中点平移
  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const dist = pointerDistance(a, b);
    if (!pinch) {
      pinch = {
        dist,
        scale,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        panX: pan.x,
        panY: pan.y,
      };
      return;
    }
    if (pinch.dist < 8 || dist <= 0) return;
    event.preventDefault();

    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    pan.x = pinch.panX + (midX - pinch.midX);
    pan.y = pinch.panY + (midY - pinch.midY);
    const next = clamp(pinch.scale * (dist / pinch.dist), 1, MAX_SCALE);
    zoomAt(midX, midY, next);
    dragged = true;
    return;
  }

  // ② 单指 / 鼠标：放大之后才能拖
  if (!drag || drag.id !== event.pointerId) return;
  if (scale <= 1.01) return;

  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
  if (!dragged) return;

  pan.x = drag.panX + dx;
  pan.y = drag.panY + dy;
  clampPan();
  paintZoom();
}

function onBoxPointerUp(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (!pointers.size) box?.classList.remove('is-dragging');
  try {
    boxImg?.releasePointerCapture(event.pointerId);
  } catch {
    /* 指针已经没了，忽略 */
  }

  if (pointers.size < 2) pinch = null;
  if (drag && drag.id === event.pointerId) drag = null;

  // 双指松掉一根：剩下的那根接着能拖
  if (pointers.size === 1 && scale > 1.01) {
    const [id, point] = [...pointers.entries()][0] ?? [];
    if (typeof id === 'number' && point) {
      drag = { id, x: point.x, y: point.y, panX: pan.x, panY: pan.y };
    }
  }
}

function showHint(): void {
  if (!boxHint) return;
  boxHint.classList.remove('is-hidden');
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => boxHint?.classList.add('is-hidden'), 4200);
}

function paintBox(): void {
  if (!box || !boxImg) return;
  const item = boxList[boxIndex];
  if (!item) return;
  const token = ++paintToken;
  pointers.clear();
  drag = null;
  pinch = null;
  dragged = false;
  resetZoom();

  boxImg.src = item.src;
  boxImg.alt = item.alt;
  if (boxCaption) {
    boxCaption.textContent = boxList.length > 1 ? `${boxIndex + 1} / ${boxList.length}` : '';
    // 单张图时不用居中显示那串「1 / 1」
    boxCaption.hidden = boxList.length < 2;
  }
  const prev = box.querySelector<HTMLElement>('[data-ml-prev]');
  const next = box.querySelector<HTMLElement>('[data-ml-next]');
  const many = boxList.length > 1;
  if (prev) prev.hidden = !many;
  if (next) next.hidden = !many;

  void settleImage(token);
}

function openBox(items: LightboxItem[], index: number, opener: HTMLElement | null): void {
  if (!items.length) return;
  ensureBox();
  if (!box) return;
  boxList = items;
  boxIndex = Math.max(0, Math.min(index, items.length - 1));
  boxOpener = opener;
  paintBox();
  if (!box.open) box.showModal();
  box.classList.add('is-open');
  // 灯箱打开时锁住页面滚动（复用文章图片灯箱那套 .img-zoom-lock）
  document.documentElement.classList.add('img-zoom-lock');
  showHint();
}

function closeBox(): void {
  if (!box?.open) return;
  window.clearTimeout(hintTimer);
  window.clearTimeout(zoomTimer);
  box.classList.remove('is-open', 'is-zoomed', 'is-dragging', 'is-zooming');
  box.close();
  boxImg?.style.removeProperty('transform');
  boxImg?.removeAttribute('src');
  scale = 1;
  pan = { x: 0, y: 0 };
  pointers.clear();
  drag = null;
  pinch = null;
  dragged = false;
  document.documentElement.classList.remove('img-zoom-lock');
  const back = boxOpener;
  boxOpener = null;
  if (back?.isConnected) back.focus({ preventScroll: true });
}

function stepBox(direction: number): void {
  if (!box?.open || boxList.length < 2) return;
  boxIndex = (boxIndex + direction + boxList.length) % boxList.length;
  paintBox();
}

function destroyBox(): void {
  if (box?.open) box.close();
  box?.remove();
  box = null;
  boxImg = null;
  boxCaption = null;
  boxHint = null;
  boxList = [];
  boxIndex = 0;
  boxOpener = null;
  scale = 1;
  pan = { x: 0, y: 0 };
  pointers.clear();
  drag = null;
  pinch = null;
  window.clearTimeout(hintTimer);
  window.clearTimeout(zoomTimer);
  document.documentElement.classList.remove('img-zoom-lock');
}

/** 给一张卡里的所有格子绑「点开大图」 */
function bindGallery(): void {
  for (const media of document.querySelectorAll<HTMLElement>('[data-moment-media]')) {
    if (media.dataset.bound === '1') continue;
    media.dataset.bound = '1';

    const cells = [...media.querySelectorAll<HTMLButtonElement>('[data-moment-photo]')];
    const items: LightboxItem[] = cells.map((cell, index) => ({
      src: cell.dataset.src ?? '',
      alt: `第 ${index + 1} 张图片`,
    }));

    // 超过 9 张时，后面那几张没渲染出来（第 9 格是「+N」灰幕），
    // 这里把它们也接在灯箱列表后面，翻页照样能看到全部
    try {
      const extra = JSON.parse(media.dataset.extraSrcs ?? '[]');
      if (Array.isArray(extra)) {
        for (const src of extra) {
          if (typeof src === 'string' && src) items.push({ src, alt: `第 ${items.length + 1} 张图片` });
        }
      }
    } catch {
      /* 数据不对就不接，能看到 9 张也够用 */
    }

    for (const cell of cells) {
      cell.addEventListener('click', () => {
        openBox(items, Number(cell.dataset.index ?? 0), cell);
      });
    }
  }
}

/* 键盘：← → 翻页，0 回到适配大小，Esc 由 <dialog> 自己处理 */
function onBoxKey(event: KeyboardEvent): void {
  if (!box?.open) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepBox(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepBox(1);
  } else if (event.key === '0') {
    resetZoom();
  }
}

/* ============================================================
   ④⑤ 点赞 / 分享
   ============================================================ */

interface LikeItem {
  btn: HTMLButtonElement;
  count: HTMLElement | null;
  path: string;
  liked: boolean;
}

/** 每张卡上的点赞按钮（path 取卡片自己的 data-moment-path，和分享链接一致） */
function likeItems(): LikeItem[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-moment-like]')].map((btn) => {
    const card = btn.closest<HTMLElement>('[data-moment]');
    return {
      btn,
      count: btn.querySelector<HTMLElement>('[data-moment-like-count]'),
      path: card?.dataset.momentPath || btn.dataset.path || '',
      liked: btn.getAttribute('aria-pressed') === 'true',
    };
  });
}

function paintLike(item: LikeItem, count: number, liked: boolean): void {
  item.liked = liked;
  if (item.count) item.count.textContent = count.toLocaleString('zh-CN');
  item.btn.setAttribute('aria-pressed', String(liked));
  item.btn.classList.toggle('is-liked', liked);
  item.btn.setAttribute(
    'aria-label',
    liked ? '取消点赞这条动态' : '点赞这条动态',
  );
}

/** 读一次点赞数 / 浏览量（一个请求查多张卡；浏览量只是「显示」，真正记一次见 bindViews） */
async function refreshCounts(): Promise<void> {
  const items = likeItems().filter((item) => item.path);
  if (!items.length) return;

  const paths = [...new Set(items.map((item) => item.path))];
  try {
    const map = await fetchMeta(paths);
    for (const item of items) {
      const info = map[item.path];
      if (!info) continue;
      paintLike(item, info.likes, info.liked);

      const card = item.btn.closest<HTMLElement>('[data-moment]');
      const view = card?.querySelector<HTMLElement>('[data-moment-view]');
      const countEl = view?.querySelector<HTMLElement>('[data-moment-view-count]');
      if (view && countEl) {
        countEl.textContent = info.views.toLocaleString('zh-CN');
        view.hidden = false;
      }
    }
  } catch {
    /* 服务不可用时保留占位「—」，不打扰阅读 */
  }
}

function bindLikes(): void {
  for (const item of likeItems()) {
    if (!item.path || item.btn.dataset.bound === '1') continue;
    item.btn.dataset.bound = '1';

    let busy = false;
    item.btn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      item.btn.disabled = true;
      try {
        if (!getSession()) {
          try {
            await openLogin();
          } catch (error) {
            showToast(error instanceof Error ? error.message : '登录失败，请重试');
            return;
          }
        }

        // 登录后先取一次真实状态，避免重复点赞
        const current = getSession() ? await fetchMeta([item.path]) : {};
        const info = current[item.path];
        const shouldUnlike = info ? info.liked : item.liked;

        const result = await sendLike(item.path, shouldUnlike ? 'unlike' : 'like');
        paintLike(item, result.count, result.liked);
        if (shouldUnlike) showToast('已取消点赞');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          clearSession();
          showToast('登录已过期，请重新登录');
        } else {
          showToast(error instanceof Error ? error.message : '操作失败，请稍后再试');
        }
      } finally {
        busy = false;
        item.btn.disabled = false;
      }
    });
  }
}

function bindShare(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-moment-share]')) {
    if (btn.dataset.bound === '1') continue;
    btn.dataset.bound = '1';

    btn.addEventListener('click', async () => {
      const path = btn.dataset.path ?? location.pathname;
      const url = new URL(path, location.origin).href;
      const ok = await copyText(url);
      showToast(ok ? '链接已复制，发给朋友试试' : '复制失败，请手动复制地址栏');

      if (!ok) return;
      const label = btn.querySelector<HTMLElement>('[data-moment-share-label]');
      if (!label) return;
      const original = label.textContent ?? '分享';
      label.textContent = '已复制';
      window.setTimeout(() => {
        if (label.isConnected) label.textContent = original;
      }, 1600);
    });
  }
}

/* ============================================================
   ⑥ 浏览量：滚进视口才记一次
   ============================================================ */

/** 同一浏览器会话里，同一条动态只上报一次（后端还会按 IP 去重，这里是省请求） */
const VIEW_KEY = 'melodyxz-moment-seen:';

let viewQueue: HTMLElement[] = [];
let viewRunner = 0;

function markSeen(anchor: string): boolean {
  try {
    if (sessionStorage.getItem(VIEW_KEY + anchor)) return false;
    sessionStorage.setItem(VIEW_KEY + anchor, '1');
    return true;
  } catch {
    return true; // 隐私模式存不了，就每次都问问后端（后端自己会去重）
  }
}

async function drainViewQueue(): Promise<void> {
  window.clearTimeout(viewRunner);
  const card = viewQueue.shift();
  if (!card) return;

  const path = card.dataset.momentPath ?? '';
  const view = card.querySelector<HTMLElement>('[data-moment-view]');
  const countEl = view?.querySelector<HTMLElement>('[data-moment-view-count]');

  if (path) {
    try {
      const result = await sendView(path);
      if (countEl) countEl.textContent = result.count.toLocaleString('zh-CN');
      if (view) view.hidden = false;
    } catch {
      /* 统计服务不可用时静默跳过 */
    }
  }

  // 一条一条来，别一次糊上去一堆请求
  viewRunner = window.setTimeout(() => void drainViewQueue(), 380);
}

let viewObserver: IntersectionObserver | null = null;

function bindViews(): void {
  viewObserver?.disconnect();
  viewObserver = null;

  const cards = [...document.querySelectorAll<HTMLElement>('[data-moment]')].filter(
    (card) => card.dataset.momentPath,
  );
  if (!cards.length) return;
  if (!('IntersectionObserver' in window)) return;

  viewObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target as HTMLElement;
        viewObserver?.unobserve(card);
        const anchor = card.dataset.momentAnchor ?? '';
        if (!anchor || !markSeen(anchor)) continue;
        viewQueue.push(card);
        if (viewQueue.length === 1) void drainViewQueue();
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.35 },
  );

  for (const card of cards) viewObserver.observe(card);
}

/* ============================================================
   初始化
   ============================================================ */

function initMoments(): void {
  if (!document.querySelector('[data-moment]')) return;

  upgradeTimes();
  bindMoodPops();
  bindGallery();
  bindLikes();
  bindShare();
  void refreshCounts();
  bindViews();
}

/** 键盘：Esc 关灯箱 / 收心情弹层；← → 翻图；0 回到适配大小 */
function onDocumentKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMoodPops();
  onBoxKey(event);
}

/* window / document 级监听只注册一次（模块只执行一次） */
document.addEventListener('keydown', onDocumentKey);
onAuthChange(() => void refreshCounts());

onBeforeSwap(() => {
  window.clearTimeout(viewRunner);
  viewQueue = [];
  viewObserver?.disconnect();
  viewObserver = null;
  closeMoodPops();
  destroyBox();
});

onPageLoad(initMoments);
