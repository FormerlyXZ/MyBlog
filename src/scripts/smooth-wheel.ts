/**
 * 鼠标滚轮惯性滚动
 * ============================================================
 * 原生滚轮是「一档一跳」：手一停，页面就硬生生钉住。
 * 这里把纵向滚轮接管下来，只记「本来要滚到哪」（target），
 * 真正的滚动位置每帧朝 target 指数逼近 ——
 * 于是滚轮停下之后，页面还会顺着原方向自己滑一小段才收住，像有质量。
 *
 * 手感由 TAU（时间常数，毫秒）决定：
 *   · 数值越大 → 追得越慢、滑得越远、越「飘」；
 *   · 数值越小 → 越贴近原生。
 * 120ms 大约是「快速搓三下滚轮，松手后还能滑过小半屏」的程度。
 *
 * 为什么不用 CSS scroll-behavior:smooth / 现成的平滑滚动库：
 *   · CSS 只能把一次跳转抹平，没有「松手后继续滑行再收尾」的惯性；
 *   · 现成库（Lenis 之类）要的是整站接管，连锚点、键盘都得自己实现，
 *     这里只要滚轮那点手感，十几行就够，不引依赖。
 *
 * 几个必须照顾到的地方：
 *   ① 只管纵向。Ctrl/⌘ + 滚轮是缩放，纯横向滚轮是别的东西，一律放过。
 *   ② 轮子压在「自己会滚」的容器上（文章目录、歌单、侧栏、图片墙）
 *      时不抢它的滚动；它已经滚到头了，这一格就直接交给页面
 *      （除非它写了 overscroll-behavior: contain —— 那是作者有意拦住的）。
 *   ③ 别人挪了滚动位置就立刻停手、让位：拖滚动条、PageDown、
 *      锚点跳转的平滑滚动、触屏手势。判断方式是每帧记住「我写进去的位置」，
 *      下次 scroll 事件里真实位置对不上就说明不是我在滚 —— 比监听一堆事件可靠。
 *   ④ prefers-reduced-motion: reduce 的用户完全不接管。
 *   ⑤ 换页（<ClientRouter />）不会重建 window，所以窗口级监听只在本模块
 *      顶层注册一次；模块只执行一次，天然不会重复绑定。
 *
 * ⚠️ 动画期间给 <html> 挂 .wheel-animating，把 CSS 的 scroll-behavior:smooth
 *    临时关掉（见 styles/global.css）：否则我们逐帧写进去的位置
 *    会被浏览器的平滑滚动再插值一次，整页慢半拍、还带明显的粘滞感。
 * ============================================================
 */

/** 时间常数（毫秒）：每帧朝目标走 1 - e^(-dt/τ)，与帧率无关 */
const TAU = 120;

/** 离目标小于这个距离就直接锁定，避免「永远差一点点」的无穷小尾巴 */
const STOP_EPSILON = 0.4;

/** 单行高度：Firefox 的鼠标滚轮是 deltaMode=1（行），换算成像素用 */
const LINE_HEIGHT = 33;

/** 真实位置和「我写进去的位置」差多少，判定为「别人动的」 */
const DRIFT_TOLERANCE = 2.5;

const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** 站点的根滚动容器（<html> 还是 <body> 由浏览器决定） */
function rootScroller(): HTMLElement {
  return (document.scrollingElement as HTMLElement | null) ?? root;
}

/** 某个容器在这个方向还能不能滚（dir > 0 向下） */
function room(el: HTMLElement, dir: number): number {
  const max = el.scrollHeight - el.clientHeight;
  return dir > 0 ? max - el.scrollTop : el.scrollTop;
}

/** 能不能滚（有溢出才算，overflow: hidden 的装饰性容器不算） */
function scrollable(el: HTMLElement): boolean {
  if (el.scrollHeight - el.clientHeight <= 1) return false;
  const oy = getComputedStyle(el).overflowY;
  return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
}

/**
 * 从事件目标往上找最近的可滚容器（找不到说明该滚页面本身）。
 * 遇到 <html>/<body> 就停 —— 那是根滚动，交给 rootScroller()。
 */
function findInnerScroller(start: EventTarget | null): HTMLElement | null {
  const stop = rootScroller();
  let node = start instanceof Element ? start : null;
  while (node && node !== root && node !== document.body && node !== stop) {
    if (node instanceof HTMLElement && scrollable(node)) return node;
    node = node.parentElement;
  }
  return null;
}

/** 滚轮一格换算成多少像素 */
function deltaToPx(event: WheelEvent, viewport: number): number {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT;
  if (event.deltaMode === 2) return event.deltaY * viewport;
  return event.deltaY;
}

/* ---------------- 惯性引擎（同一时刻只接管一个容器） ---------------- */

let scroller: HTMLElement | null = null; // 当前接管的滚动容器
let target = 0; // 想去的位置
let current = 0; // 上一帧写进去的位置
let rafId = 0;
let lastTs = 0;

function release(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  scroller = null;
  root.classList.remove('wheel-animating');
}

function frame(ts: number): void {
  rafId = 0;
  const el = scroller;
  if (!el) return;

  const dt = lastTs ? Math.min(64, Math.max(0, ts - lastTs)) : 16.7;
  lastTs = ts;

  // 指数逼近：dt 越长时间常数不变，所以 60Hz / 120Hz / 掉帧都是同一个手感
  current += (target - current) * (1 - Math.exp(-dt / TAU));
  if (Math.abs(target - current) < STOP_EPSILON) current = target;

  // 逐帧落点。这里刻意不传 behavior：'instant' —— 那是个比较新的枚举值，
  // 老浏览器会直接抛错（一抛错整个惯性就死了，滚轮还会因为 preventDefault 变哑）。
  // 「立刻生效」交给 .wheel-animating 把 CSS 的 scroll-behavior 改成 auto，
  // 只写 top，横向位置由浏览器保持原样。
  el.scrollTo({ top: current });

  if (current === target) {
    root.classList.remove('wheel-animating');
    lastTs = 0;
    return; // 停在这儿，但 scroller 留着：下次滚轮从这里接着算
  }
  rafId = requestAnimationFrame(frame);
}

function start(): void {
  if (rafId) return;
  lastTs = 0;
  root.classList.add('wheel-animating');
  rafId = requestAnimationFrame(frame);
}

/* ---------------- 事件 ---------------- */

function onWheel(event: WheelEvent): void {
  if (reducedMotion.matches) return; // 用户要求别动 → 原生怎么滚就怎么滚
  if (event.ctrlKey || event.metaKey) return; // 缩放手势
  if (!event.cancelable || event.defaultPrevented) return;
  if (event.deltaY === 0) return;
  // 横向为主的滚轮（触控板横扫、Shift+滚轮）不插手
  if (Math.abs(event.deltaY) < Math.abs(event.deltaX) * 0.5) return;

  const dir = event.deltaY > 0 ? 1 : -1;
  const rootEl = rootScroller();
  const inner = findInnerScroller(event.target);

  // 内层容器还能走就走内层，走到头了才轮到页面
  let el = rootEl;
  if (inner) {
    const contained = getComputedStyle(inner)
      .getPropertyValue('overscroll-behavior-y')
      .includes('contain');
    if (room(inner, dir) > 0 || contained) el = inner;
  }

  const delta = deltaToPx(event, el.clientHeight || window.innerHeight);
  if (delta === 0) return;

  // 已经接管别的容器 → 先交接，从它的真实位置重新起算。
  // 同一个容器但已经空闲 → 也要对一次真实位置，
  // 否则「按了 PageDown / 拖了滚动条之后再滚轮」会把页面拽回旧位置。
  if (scroller !== el) {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    scroller = el;
    current = el.scrollTop;
    target = current;
  } else if (!rafId) {
    current = el.scrollTop;
    target = current;
  }

  event.preventDefault();

  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  target = Math.min(max, Math.max(0, target + delta));

  // 撞到边界（页首 / 页尾）就什么都不用做，但也别让浏览器接着滚
  if (target === current) {
    if (!rafId) {
      root.classList.remove('wheel-animating');
      lastTs = 0;
    }
    return;
  }

  start();
}

/**
 * 外部滚动检测：真实位置和上一帧写进去的不一致 → 不是我在滚，交还控制权。
 * 用捕获阶段挂在 document 上，一次就能看到所有容器的 scroll。
 */
function onScroll(): void {
  if (!scroller || !rafId) return;
  // 收尾那一帧（rafId 已清零）也可能还有一次 scroll 在路上，用 current 做基准
  if (Math.abs(scroller.scrollTop - current) > DRIFT_TOLERANCE) release();
}

/** 手指 / 触控笔 / 拖滚动条一碰，立刻停手，别跟用户抢 */
function onPointerDown(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') release();
}

let bound = false;

/** 幂等绑定：模块只执行一次，这里再上一层保险 */
export function initSmoothWheel(): void {
  if (bound) return;
  // 纯触屏设备没有滚轮，别白挂监听
  if (window.matchMedia('(hover: none)').matches) return;
  bound = true;

  window.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('blur', release);

  // 系统里中途打开「减少动态效果」→ 正在滑行的这一段也立刻停住，之后按原生滚。
  // 反过来（关掉）不用做任何事：监听一直挂着，onWheel 每次都会重新判断。
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) release();
  });
}

initSmoothWheel();
