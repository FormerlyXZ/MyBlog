/**
 * 目录树轨迹（圆点 / 虚线 / 实线 / 箭头）
 * ============================================================
 * 目标效果（对齐参考稿）：
 *   · 一棵树：文章标题 → 一级标题（一、二、…）→ 二级标题（1、2、…）
 *   · 没读到的部分：虚线 + 空心圆；读过的部分：主色实线 + 实心圆
 *   · 一个箭头沿着这条轨迹走，走到哪一节就自动展开哪一节
 *     往上滑就自动缩回去 —— 默认始终只有「当前这一支」是展开的
 *
 * 头部两个开关（状态存 localStorage，两棵树共享）：
 *   · 自动收起：开 = 手风琴（过了就折叠）；关 = 展开过的保持展开
 *   · 展开全部 / 收起全部
 *
 * **三份目录共用这一个脚本**（同一页可以同时有三棵树，状态天然同步）：
 *   · sidebar  左侧栏粘性卡（桌面）
 *   · inline   正文顶部折叠卡（竖屏）
 *   · float    竖屏悬浮窗：inline 卡整体滑出视口之后，把同一棵树钉在屏幕顶部，
 *              纸飞机钉在窗口正中，可以滚轮 / 手指上下翻，也能收起成一颗小胶囊
 *
 * 几个关键实现决定：
 *
 * ① 轨迹只有一根 SVG 曲线
 *    整棵树画一根 path：父圆点竖直下来，到子圆点处用一段圆角拐弯。
 *    下面垫一条虚线（ghost）表示「还没走到」，上面盖一条同形状的实线（fill），
 *    用 stroke-dashoffset 让它一点点「长」出来 —— 只改一个数字，不重排。
 *
 * ② 箭头用「整条路径的百分比」定位
 *    滚动位置 → 落在哪两个节点之间 → 换算成路径长度百分比 p；
 *    p 做一次指数平滑（每帧追 28%）再写到 transform 上。
 *    于是：普通滚动时箭头跟着走不抖，点目录跳转 / 展开折叠时箭头也是滑过去的。
 *
 * ③ 展开 / 折叠用 grid-template-rows，箭头靠「逐帧重算」跟住动画
 *    高度是 CSS 过渡出来的，兄弟节点的位置在动画期间一直在动，
 *    所以动画那 460ms 里逐帧重算坐标（每帧几十次 getBoundingClientRect，很便宜）。
 *    被折叠盒子裁掉的那部分节点不画进路径，避免线「跑出」折叠区域。
 */
import { onPageLoad, onBeforeSwap } from './pageload';

/** 判定线：视口顶部往下多少像素算「读到这里」 */
const OFFSET = 140;
/** 箭头「几何中心」在 svg 里的坐标：箭头永远以这里为轴心旋转 */
const ARROW_CX = 9;
const ARROW_CY = 10.5;
/** 45° 折角的小圆角半径 */
const CORNER = 3.2;

/* -------------------------------------------------------------------
 * 弹簧参数（晚到一点点 + 速度曲线下降，**不过冲**）
 * -------------------------------------------------------------------
 * 半隐式欧拉积分，按小步长反复迭代，所以跟屏幕刷新率无关。
 *   stiffness 越大 → 追得越快（ω = √k，ω 越小「晚到」越明显）
 *   damping   取 2ζ√k：ζ略大于 1 = 临界阻尼，
 *             表现为「速度一路平滑下降、刚好停在目标上」，绝不回弹。
 */
/** 位置弹簧：文章到点了，箭头再滑一小段减速抵达（ω≈11，ζ≈1.03） */
const POS_SPRING = { stiffness: 125, damping: 23 };
/** 朝向弹簧：掉头同样是减速收住，一点不摆回来（ω≈13，ζ≈1.11） */
const ROT_SPRING = { stiffness: 170, damping: 29 };
/** 弹簧收敛阈值 */
const SPRING_EPS = 0.0006;
/** 单帧最大积分步长（秒） */
const STEP = 1 / 240;

interface Spring {
  value: number;
  velocity: number;
}
/** 展开/折叠动画时长，与 toc.css 保持一致 */
const ANIM_MS = 460;

/* -------------------------------------------------------------------
 * 目录窗口（长目录的「跟随」策略）
 * -------------------------------------------------------------------
 * 问题：目录很长的时候（最典型的就是「展开全部」之后），整棵树比一屏还高，
 *       纸飞机跟着阅读位置往下走，走到某处就掉出网页底部 —— 眼睛跟丢了。
 *
 * 做法：把树关进一个「窗口」——
 *   · 头部（标题 + 两个开关）和底部阅读进度留在窗口**外面**，永远固定不动
 *   · 窗口高度 = min(树高, 卡片到窗口底部还剩多少地方)
 *   · 纸飞机越过 pinY 之后，树整体往上滑同样的距离（目录往上走）
 *     → 纸飞机贴住 pinY 不动，后面的小节一行行从下面顶上来
 *   · 反过来往上滑时位移回收，滑到 0 就恢复成「整棵树摊开」的原样
 *
 * 树没超过一屏时窗口高度 = 树高、位移 = 0，也就是完全不触发，行为和以前一样。
 */
/** 纸飞机允许落到的最大位置（占窗口高度的比例） */
const PIN_RATIO = 0.72;
/** 窗口底部给页面留的空隙 */
const PIN_GAP = 16;
/** 窗口最矮多高（窗口太矮时目录就没法看了，宁可让卡片略微超出屏幕） */
const PIN_MIN = 240;

/* -------------------------------------------------------------------
 * 竖屏悬浮目录（顶部那张折叠卡滑出视口之后接管）
 * -------------------------------------------------------------------
 * 窗口高度 = min(树高, 视口 36%)，夹在 [FLOAT_WINDOW_MIN, FLOAT_WINDOW_MAX]：
 *   · 树短 → 窗口贴着树高，卡片不大、底下不留白；
 *   · 树长 → 固定成一条窗口，正文还能剩 2/3 屏往下读。
 *
 * 窗口里纸飞机钉在**正中**（FLOAT_PIN_RATIO），文章往下滚 = 目录内容往上滑，
 * 和横屏侧栏「长目录」的观感一致，但居中更容易一眼扫到「现在读到哪」。
 *
 * 滚轮 / 手指压在这个窗口上时**只滑目录、页面一格都不动**（滑到顶/底也只是停住）——
 * 并且和正文那套（scripts/smooth-wheel.ts）一样做指数平滑：滚轮一格是一百多像素的
 * 跳变，直接贴上去就是「一格一顿」，换成每帧朝目标追一段才有惯性。
 * 松手后停在原地，等文章翻到**下一节**（或点了某一行）再平滑回到跟随状态。
 */
const FLOAT_PIN_RATIO = 0.5;
const FLOAT_WINDOW_RATIO = 0.36;
const FLOAT_WINDOW_MIN = 176;
const FLOAT_WINDOW_MAX = 352;
/**
 * 滚轮翻目录的时间常数（毫秒）。和 smooth-wheel.ts 的 TAU 取同一个量级，
 * 于是「滚正文」和「滚目录」是同一只手感：指数逼近 1 - e^(-dt/τ)，与帧率无关。
 */
const FLOAT_WHEEL_TAU = 105;
/** 手动翻目录后回中的时间常数（毫秒）：比滚轮慢一档，看得出来是在「自己回去」 */
const FLOAT_RETURN_TAU = 240;
/** 顶部内联卡的下边缘要滑到视口上方这么多像素才露面（和收起线留一点滞回） */
const FLOAT_SHOW_GAP = 10;
/** 导航胶囊露出来时，悬浮窗往下让的空隙（px） */
const NAV_CLEARANCE = 8;
/** 导航胶囊的 top 偏移（layout.css 里 .nav-shell 的 top: 0.75rem） */
const NAV_TOP = 12;
/** 悬浮窗展开/收起记在哪个 key 上 */
const FLOAT_KEY = 'melodyxz-toc-float';

/* -------------------------------------------------------------------
 * 全局偏好：目录的展开策略
 * -------------------------------------------------------------------
 *   auto    手风琴（默认）：只展开「正在读的那一节」，过了就折叠
 *   manual  手动：读到就展开，但**不会自动折叠**（往上滑也保持展开）
 *           行尾小箭头 / 「展开全部」「收起全部」都能直接干预
 */
type TocMode = 'auto' | 'manual';

const MODE_KEY = 'melodyxz-toc-mode';

let mode: TocMode = 'auto';
try {
  if (localStorage.getItem(MODE_KEY) === 'manual') mode = 'manual';
} catch {
  /* 隐私模式：用默认值 */
}

/** manual 模式下展开着的分支（slug 集合） */
const manualOpen = new Set<string>();

/** 点了「收起全部」之后，停在当前这一节期间不再自动展开 */
let pauseOpenForSlug: string | null = null;

/* -------------------------------------------------------------------
 * 悬浮窗的「展开 / 收起」偏好（跨文章记住）
 * ------------------------------------------------------------------- */
function readFloatOpen(): boolean {
  try {
    return localStorage.getItem(FLOAT_KEY) !== '0';
  } catch {
    return true;
  }
}

function persistFloatOpen(open: boolean): void {
  try {
    localStorage.setItem(FLOAT_KEY, open ? '1' : '0');
  } catch {
    /* 隐私模式：只影响下次 */
  }
}

/** 滚轮一格换算成多少像素（同 smooth-wheel.ts 的换算） */
function wheelPx(event: WheelEvent, page: number): number {
  if (event.deltaMode === 1) return event.deltaY * 33;
  if (event.deltaMode === 2) return event.deltaY * page;
  return event.deltaY;
}

interface NodeGeo {
  /** <li>；根节点没有 li，直接用 <a> */
  item: HTMLElement;
  link: HTMLElement;
  dot: HTMLElement;
  /** 行尾小箭头（有子项才有） */
  caret: HTMLElement | null;
  slug: string;
  isRoot: boolean;
  /** 自己下面有没有折叠盒子（= 有没有子标题） */
  hasBranch: boolean;
  /** 对应标题在文档里的绝对 Y */
  anchor: number;
  /** 父节点下标（-1 表示顶层） */
  parent: number;
  /** 相对轨迹左上角的圆点坐标 */
  x: number;
  y: number;
  /** 沿路径累计长度 */
  cum: number;
  /** cum / total，0~1 */
  norm: number;
  /** 当前是否被折叠盒子裁掉 */
  drawn: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

class TocTree {
  private tree: HTMLElement;
  private rail: SVGSVGElement;
  private ghost: SVGPathElement;
  private fill: SVGPathElement;
  private playhead: HTMLElement;
  private arrow: SVGElement;
  private viewport: HTMLElement | null;
  private foldable: HTMLElement | null;
  private card: HTMLElement | null;
  /** 移动端折叠卡：自己有限高 + 内滚动，不参与「目录窗口」 */
  private inline: boolean;
  /** 目录窗口的可用高度（缓存；0 = 还没算） */
  private pinRoomH = 0;
  private pinInnerH = -1;
  private foldBtn: HTMLButtonElement | null;
  private autoBtn: HTMLButtonElement | null;
  private expandBtn: HTMLButtonElement | null;

  private nodes: NodeGeo[] = [];
  private total = 0;
  /** 浏览器自己算的路径总长（dasharray / getPointAtLength 都用它） */
  private svgLength = 0;

  /* ---- 竖屏悬浮窗（variant="float" 才有） ---- */
  /** 这棵树是不是悬浮窗里的那一份 */
  private float = false;
  /** 悬浮窗的整条带子（.toc-float） */
  private floatWrap: HTMLElement | null = null;
  /** 悬浮窗里的面板本身（.toc-float__panel） */
  private floatPanel: HTMLElement | null = null;
  /** 顶部那张内联卡：它的下边缘滑出视口 = 该放悬浮窗了 */
  private inlineCard: HTMLElement | null = null;
  /** 悬浮窗现在露着没有 */
  private floatShown = false;
  /** 悬浮窗是展开的还是一颗小胶囊 */
  private floatOpen = true;
  /** 自动跟随算出来的位移（树坐标系里，纸飞机居中 → 需要往上滑多少） */
  private floatAutoShift = 0;
  /** 窗口最多能滑多少（树高 - 窗口高） */
  private floatMaxShift = 0;
  /** 手动翻目录叠上去的额外位移（相对自动跟随；回中时衰减到 0） */
  private floatOffset = 0;
  /** 手动位移的**目标**：滚轮/手指每来一格加到这里，floatOffset 每帧朝它追 */
  private floatOffsetTarget = 0;
  /** 是否正在把手动位移收回到自动跟随（用更慢的那条时间常数） */
  private floatReturning = false;
  /** 上一次事件里手指的 Y（触屏滑目录用） */
  private touchY = 0;
  private touchActive = false;
  /** 写进根元素的那条 scroll-padding-top（0 = 没写） */
  private floatPadH = 0;
  /** 导航胶囊占位的高度（= 写进 --toc-float-y 的那个值） */
  private floatNavY = 0;
  /* ---- 收起态那颗胶囊的阅读进度 ---- */
  /** 胶囊的进度填充条 */
  private pillFill: HTMLElement | null = null;
  /** 胶囊里的百分比数字 */
  private pillPct: HTMLElement | null = null;
  /** 正文的进度区间（绝对 Y）：只在 resize / 正文变高时重量 */
  private proseStart = 0;
  private proseEnd = 1;
  private proseMeasured = false;
  private lastPct = -1;
  /** 导航胶囊的显隐观察者（露出来时要给悬浮窗让位） */
  private navObserver: MutationObserver | null = null;

  /** 沿轨迹的位置（0~1），弹簧驱动 → 自带惯性 */
  private position: Spring = { value: 0, velocity: 0 };
  private targetP = 0;
  /** 箭头朝向（deg，连续累加），弹簧驱动 → 掉头有惯性 */
  private rotation: Spring = { value: 0, velocity: 0 };
  private started = false;
  private lastTick = 0;
  private lastActiveIndex = -2;

  private raf = 0;
  private geoDirty = true;
  private anchorsDirty = true;
  private animUntil = 0;
  private ready = false;

  private observer: ResizeObserver | null = null;

  /** 真正在滚的容器（找不到就是 null；几何变化时重新找） */
  private scroller: HTMLElement | null = null;

  constructor(tree: HTMLElement) {
    this.tree = tree;
    this.rail = tree.querySelector<SVGSVGElement>('[data-toc-rail]')!;
    this.ghost = tree.querySelector<SVGPathElement>('[data-toc-rail-ghost]')!;
    this.fill = tree.querySelector<SVGPathElement>('[data-toc-rail-fill]')!;
    this.playhead = tree.querySelector<HTMLElement>('[data-toc-playhead]')!;
    this.arrow = tree.querySelector<SVGElement>('.toc-playhead__arrow')!;
    this.viewport = tree.closest('[data-toc-viewport]');
    this.foldable = tree.closest('[data-toc-foldable]');

    const card = tree.closest<HTMLElement>('[data-toc]');
    this.card = card;
    this.float = card?.dataset.tocVariant === 'float';
    this.inline = !this.float && Boolean(tree.closest('.toc-card--inline'));
    this.foldBtn = card?.querySelector<HTMLButtonElement>('[data-toc-fold]') ?? null;
    this.autoBtn = card?.querySelector<HTMLButtonElement>('[data-toc-auto]') ?? null;
    this.expandBtn = card?.querySelector<HTMLButtonElement>('[data-toc-expand]') ?? null;

    if (this.float && card) {
      this.floatWrap = card;
      this.floatPanel = card.querySelector<HTMLElement>('.toc-float__panel');
      this.pillFill = card.querySelector<HTMLElement>('[data-toc-float-fill]');
      this.pillPct = card.querySelector<HTMLElement>('[data-toc-float-pct-value]');
      // 同一篇文章里最多只有一张内联卡（TOC.astro 才会带这个标记）
      this.inlineCard = document.querySelector<HTMLElement>('[data-toc-inline-card]');
      this.floatOpen = readFloatOpen();
      card.dataset.tocOpen = this.floatOpen ? '1' : '0';
    }

    this.collect();
    this.bind();
  }

  // ---------------------------------------------------------------
  // 收集节点 & 绑事件
  // ---------------------------------------------------------------

  private collect(): void {
    const nodes: NodeGeo[] = [];
    const indexOf = new Map<HTMLElement, number>();

    /**
     * 按**文档顺序**收所有圆点（不是按 a[data-toc-link] 收）：
     * 系列文章的侧栏里，章节列表是普通链接（不带圆点、不进轨迹），
     * 只有「当前这一章」那一行才带圆点、作为整棵树的根 ——
     * 这样轨迹的起点就正好落在正在读的那一章上。
     */
    for (const dot of this.tree.querySelectorAll<HTMLElement>('[data-toc-dot]')) {
      const link = dot.closest<HTMLElement>('a');
      if (!link) continue;

      const isRoot = link.hasAttribute('data-toc-root');
      const item = isRoot ? link : (link.closest('[data-toc-item]') as HTMLElement | null) ?? link;
      const parentItem = (link.closest('.toc-branch')?.parentElement as HTMLElement | null) ?? null;
      const parent = parentItem ? (indexOf.get(parentItem) ?? -1) : -1;
      const hasBranch = Boolean(item.querySelector(':scope > [data-toc-branch]'));

      indexOf.set(item, nodes.length);
      nodes.push({
        item,
        link,
        dot,
        caret: hasBranch ? item.querySelector<HTMLElement>(':scope > [data-toc-caret]') : null,
        slug: link.dataset.tocLink ?? '',
        isRoot,
        hasBranch,
        anchor: Number.POSITIVE_INFINITY,
        parent,
        x: 0,
        y: 0,
        cum: 0,
        norm: 0,
        drawn: true,
      });
    }

    this.nodes = nodes;
  }

  private bind(): void {
    // 点目录：平滑滚动 + URL 同步（不新增历史记录）
    for (const node of this.nodes) {
      node.link.addEventListener('click', (event) => {
        event.preventDefault();

        if (node.isRoot) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          try {
            history.replaceState(null, '', location.pathname + location.search);
          } catch {
            /* 忽略 */
          }
          return;
        }

        const target = document.getElementById(node.slug);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        try {
          history.replaceState(null, '', `#${node.slug}`);
        } catch {
          /* 忽略 */
        }
      });

      // 行尾小箭头：手动展开 / 收起这一支
      node.caret?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleBranch(node.slug);
      });
    }

    this.autoBtn?.addEventListener('click', () => {
      setMode(mode === 'auto' ? 'manual' : 'auto');
    });

    this.expandBtn?.addEventListener('click', () => {
      setAllOpen(!this.isAllOpen());
    });

    this.foldBtn?.addEventListener('click', () => {
      if (!this.foldable) return;
      const collapsed = this.foldable.classList.toggle('is-collapsed');
      this.foldBtn?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this.foldBtn?.setAttribute('aria-label', collapsed ? '展开目录' : '收起目录');
      this.markAnimating();
      this.requestUpdate();
    });

    /* ---------- 悬浮窗自己的那几个开关 ---------- */
    if (this.float) {
      const wrap = this.floatWrap;
      const panel = this.floatPanel;

      wrap?.querySelector('[data-toc-float-fold]')?.addEventListener('click', () => {
        this.setFloatOpen(false);
      });
      wrap?.querySelector('[data-toc-float-pill]')?.addEventListener('click', () => {
        this.setFloatOpen(true);
      });

      if (panel) {
        // 滚轮压在窗口上：只滑目录，页面一格都不动（见 onFloatWheel）
        panel.addEventListener('wheel', this.onFloatWheel, { passive: false });
        // 触屏同理：手指在窗口上上下拖 = 滑目录
        panel.addEventListener('touchstart', this.onFloatTouchStart, { passive: true });
        panel.addEventListener('touchmove', this.onFloatTouchMove, { passive: false });
        panel.addEventListener('touchend', this.onFloatTouchEnd, { passive: true });
        panel.addEventListener('touchcancel', this.onFloatTouchEnd, { passive: true });
      }

      // 导航胶囊露出来 / 收起来：悬浮窗跟着上下让位（两边一起动才不打架）
      if (typeof MutationObserver !== 'undefined') {
        const shell = document.querySelector<HTMLElement>('[data-nav-shell]');
        if (shell) {
          this.navObserver = new MutationObserver(() => this.syncNavOffset());
          this.navObserver.observe(shell, { attributes: true, attributeFilter: ['class'] });
        }
      }
      // 竖屏 ↔ 横屏 / 窗口缩放：导航高度会变（手机上那颗比桌面矮一截）
      window.addEventListener('resize', this.onFloatResize, { passive: true });
      this.syncNavOffset();
    }

    if (typeof ResizeObserver !== 'undefined') {
      let first = true;
      this.observer = new ResizeObserver(() => {
        this.geoDirty = true;
        // 布局变了：目录窗口的可用高度要重新量
        this.pinRoomH = 0;
        // 视口尺寸变了，之前认定的滚动容器可能已经不该由它滚了
        this.scroller = null;
        if (first) {
          // 元素刚出现（例如从 display:none 切成可见）：箭头直接放到位，别从 0 滑过来
          first = false;
          this.started = false;
        }
        this.requestUpdate();
      });
      this.observer.observe(this.tree);
    }
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.navObserver?.disconnect();
    this.navObserver = null;
    window.removeEventListener('resize', this.onFloatResize);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.float && this.floatPadH) {
      document.documentElement.classList.remove('toc-float-open');
      document.documentElement.style.removeProperty('--toc-float-pad');
      this.floatPadH = 0;
    }
  }

  private markAnimating(): void {
    this.animUntil = performance.now() + ANIM_MS;
  }

  // ---------------------------------------------------------------
  // 几何：圆点坐标 + 轨迹路径
  // ---------------------------------------------------------------

  private measure(): void {
    this.geoDirty = false;

    const base = this.rail.getBoundingClientRect();
    if (base.width < 2 || base.height < 2) {
      this.ready = false;
      this.playhead.classList.add('is-hidden');
      return;
    }
    this.ready = true;
    this.playhead.classList.remove('is-hidden');

    for (const node of this.nodes) {
      node.drawn = this.isDrawn(node);
      const rect = node.dot.getBoundingClientRect();
      node.x = rect.left + rect.width / 2 - base.left;
      node.y = rect.top + rect.height / 2 - base.top;
    }

    const parts: string[] = [];
    let cum = 0;
    let prev: NodeGeo | null = null;
    /** 上一个节点被折叠裁掉了 —— 断开子路径，别画出一根乱窜的线 */
    let broken = false;

    for (const node of this.nodes) {
      if (!node.drawn) continue;

      if (node.y > this.clipBottom(node, base.top) + 0.5) {
        // 这一支还没展开：不画
        node.drawn = false;
        broken = true;
        continue;
      }

      if (broken || !prev) {
        parts.push(`M ${node.x.toFixed(2)} ${node.y.toFixed(2)}`);
        broken = false;
        node.cum = cum;
        prev = node;
        continue;
      }

      const dy = node.y - prev.y;
      const dx = node.x - prev.x;
      const adx = Math.abs(dx);

      if (adx < 0.6) {
        // 同级：一条直线
        parts.push(`L ${node.x.toFixed(2)} ${node.y.toFixed(2)}`);
        cum += Math.abs(dy);
      } else if (dy > adx + CORNER + 2) {
        /**
         * 分级：竖向下来 → 小圆角 → 正负 45° 斜线直接扎进子圆点。
         * （不画大圆弧：45° 折线的「树杈」感更利落，也和箭头跟着线走向 45° 呼应）
         *   斜线横向走 adx，纵向也走 adx，所以合流点 = (prev.x, node.y - adx)
         */
        const dirX = dx > 0 ? 1 : -1;
        const cy = node.y - adx; // 45° 段的起点（在竖向轨道上）

        parts.push(`L ${prev.x.toFixed(2)} ${(cy - CORNER).toFixed(2)}`);
        cum += cy - CORNER - prev.y;

        // 竖向切线 → 45° 切线的小圆角（二次贝塞尔，两端切线都对得上）
        const bx = prev.x + 0.7071 * CORNER * dirX;
        const by = cy + 0.7071 * CORNER;
        parts.push(
          `Q ${prev.x.toFixed(2)} ${cy.toFixed(2)} ${bx.toFixed(2)} ${by.toFixed(2)}`,
        );
        cum += 1.9 * CORNER;

        // 45° 斜线，终点就是子圆点的圆心
        parts.push(`L ${node.x.toFixed(2)} ${node.y.toFixed(2)}`);
        cum += Math.hypot(node.x - bx, node.y - by);
      } else {
        // 行高太矮（塞不下 45° 折线）：退化成一条带小圆角的斜线
        parts.push(`L ${node.x.toFixed(2)} ${node.y.toFixed(2)}`);
        cum += Math.hypot(dx, dy);
      }

      node.cum = cum;
      prev = node;
    }

    this.total = cum;
    for (const node of this.nodes) {
      if (!node.drawn) continue;
      node.norm = this.total > 0 ? node.cum / this.total : 0;
    }

    const d = parts.join(' ');
    this.ghost.setAttribute('d', d);
    this.fill.setAttribute('d', d);
    this.svgLength = d ? this.fill.getTotalLength() : 0;

    // 实线段：先铺满整条路径，再用 dashoffset 把它「缩」成 p 的比例
    this.fill.style.strokeDasharray = `${this.svgLength} ${this.svgLength}`;
  }

  /** 这个节点是否被某个「没展开的」折叠盒子裁掉 */
  private isDrawn(node: NodeGeo): boolean {
    let el: HTMLElement | null = node.item.parentElement;
    while (el && el !== this.tree) {
      if (el.classList.contains('toc-branch') && !el.parentElement?.classList.contains('is-open')) {
        return false;
      }
      el = el.parentElement;
    }
    return true;
  }

  /** 被折叠盒子裁到的下边界（相对轨迹顶部）；没被裁返回 Infinity */
  private clipBottom(node: NodeGeo, top: number): number {
    let limit = Number.POSITIVE_INFINITY;
    let el: HTMLElement | null = node.item.parentElement;
    while (el && el !== this.tree) {
      if (el.classList.contains('toc-branch')) {
        limit = Math.min(limit, el.getBoundingClientRect().bottom - top);
      }
      el = el.parentElement;
    }
    return limit;
  }

  // ---------------------------------------------------------------
  // 滚动位置 → 状态 / 箭头目标
  // ---------------------------------------------------------------

  private refreshAnchors(): void {
    this.anchorsDirty = false;
    const scrollY = window.scrollY;
    const prose = document.querySelector<HTMLElement>('.prose-blog');
    const proseTop = prose ? prose.getBoundingClientRect().top + scrollY : scrollY;

    for (const node of this.nodes) {
      if (node.isRoot) {
        node.anchor = proseTop - 160;
        continue;
      }
      const el = document.getElementById(node.slug);
      node.anchor = el ? el.getBoundingClientRect().top + scrollY : Number.POSITIVE_INFINITY;
    }

    // 保险：锚点必须单调不减，否则算出来的进度会来回跳
    let last = Number.NEGATIVE_INFINITY;
    for (const node of this.nodes) {
      if (!Number.isFinite(node.anchor)) continue;
      if (node.anchor < last) node.anchor = last;
      last = node.anchor;
    }
  }

  update(): void {
    // 悬浮窗没露面就别算：它在 DOM 里始终有布局，但白白量一遍没意义
    if (this.float && !this.syncFloat()) return;

    if (this.geoDirty) this.measure();
    if (!this.ready) return;
    if (this.anchorsDirty) this.refreshAnchors();

    const s = window.scrollY + this.readLine();
    this.syncState(s);
    this.computeTarget(s);
    // 弹簧还在路上时也要先把窗口摆对（滚轮翻目录、刚露面都要立刻生效）
    this.syncWindow(this.samplePath()?.y ?? 0);
    this.syncPillProgress();
    this.ensureLoop();
  }

  /**
   * 收起态那颗胶囊的阅读进度（底色从左往右长）
   * ---------------------------------------------------------------
   * 算法和 scripts/reading-bar.ts 一模一样（正文页底部那颗进度条），
   * 这样两颗的百分比永远一致：
   *   起点 = 正文顶端；终点 = 正文底部快要触到视口底部那会儿
   * 正文区间只在 resize / 正文变高时重量，滚动时只写 transform（+ 数字变了才改文本）。
   */
  private syncPillProgress(): void {
    if (!this.float) return;
    const fill = this.pillFill;
    if (!fill) return;

    if (!this.proseMeasured) this.measureProse();

    const span = Math.max(1, this.proseEnd - this.proseStart);
    const p = clamp((window.scrollY - this.proseStart) / span, 0, 1);
    fill.style.transform = `scaleX(${p.toFixed(4)})`;

    const pct = Math.round(p * 100);
    if (pct !== this.lastPct) {
      this.lastPct = pct;
      if (this.pillPct) this.pillPct.textContent = String(pct);
    }
  }

  private measureProse(): void {
    this.proseMeasured = true;
    const prose = document.querySelector<HTMLElement>('.prose-blog');
    if (!prose) {
      this.proseStart = 0;
      this.proseEnd = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      return;
    }
    const rect = prose.getBoundingClientRect();
    this.proseStart = rect.top + window.scrollY;
    this.proseEnd = Math.max(
      this.proseStart + 1,
      this.proseStart + rect.height - window.innerHeight + 160,
    );
  }

  /**
   * 「读到这儿了」那条判定线的位置
   * ---------------------------------------------------------------
   * 平时就是视口顶部往下 OFFSET（140px）。
   * 悬浮窗露着的时候它盖住了正文顶部好几百像素 —— 那一段其实看不见，
   * 判定线要挪到面板下边缘，否则高亮/纸飞机总比眼睛看到的慢一节。
   */
  private readLine(): number {
    if (!this.float) return OFFSET;
    if (!this.floatShown || !this.floatOpen) return OFFSET;
    return this.floatPadH ? Math.max(OFFSET, this.floatPadH) : OFFSET;
  }

  /** 高亮 / 展开 / 折叠：只在状态真的变了时才写 DOM */
  private syncState(s: number): void {
    let activeIdx = -1;
    for (let i = 0; i < this.nodes.length; i += 1) {
      if (this.nodes[i]!.anchor <= s) activeIdx = i;
    }

    const ancestors = new Set<number>();
    let cursor = activeIdx >= 0 ? this.nodes[activeIdx]!.parent : -1;
    while (cursor >= 0) {
      ancestors.add(cursor);
      cursor = this.nodes[cursor]!.parent;
    }

    // 手动模式下：读到哪一节就自动展开哪一节，但**不再自动折叠**
    // （这就是「自动收起：关」的意思 —— 往上滑也不会把看过的收回去）
    const activeSlug = activeIdx >= 0 ? this.nodes[activeIdx]!.slug : null;
    if (mode === 'manual' && pauseOpenForSlug !== activeSlug) {
      for (let i = 0; i < this.nodes.length; i += 1) {
        const node = this.nodes[i]!;
        if (node.hasBranch && (i === activeIdx || ancestors.has(i))) manualOpen.add(node.slug);
      }
    }

    let openedChanged = false;

    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i]!;
      const isActive = i === activeIdx;
      const isAncestor = ancestors.has(i);
      const passed = node.isRoot || node.anchor <= s + 0.5;

      node.item.classList.toggle('is-active', isActive);
      node.item.classList.toggle('is-ancestor', isAncestor);
      node.item.classList.toggle('is-passed', passed);

      if (!node.hasBranch) continue;

      // auto：当前这一节（以及它的父级）展开，其他支折叠
      // manual：只看 manualOpen
      const shouldOpen = mode === 'auto' ? isActive || isAncestor : manualOpen.has(node.slug);

      if (shouldOpen !== node.item.classList.contains('is-open')) {
        node.item.classList.toggle('is-open', shouldOpen);
        openedChanged = true;
      }
    }

    if (activeIdx !== this.lastActiveIndex) {
      const changed = this.lastActiveIndex !== -2; // 首次落位不算「换了一节」
      this.lastActiveIndex = activeIdx;
      if (activeIdx >= 0) this.scrollIntoViewport(this.nodes[activeIdx]!);
      // 换到另一节了 → 悬浮窗结束「手动翻目录」，目标归零，平滑回到跟随状态
      if (this.float && changed && this.floatOffsetTarget !== 0) {
        this.floatOffsetTarget = 0;
        this.floatReturning = true;
      }
    }

    if (openedChanged) {
      this.markAnimating();
      this.refreshHeader();
      // 展开后子节点立刻回到自己该在的位置，按新几何重算一次
      this.measure();
    }
  }

  /** 「展开全部」用的：所有带子项的 slug */
  getBranchSlugs(): string[] {
    return this.nodes.filter((n) => n.hasBranch).map((n) => n.slug);
  }

  /** 当前展开着的分支 slug（切到手动模式时接管用） */
  getOpenSlugs(): string[] {
    return this.nodes
      .filter((n) => n.hasBranch && n.item.classList.contains('is-open'))
      .map((n) => n.slug);
  }

  /** 是否已经「全部展开」 */
  isAllOpen(): boolean {
    const branches = this.nodes.filter((n) => n.hasBranch);
    if (!branches.length) return false;
    return branches.every((n) => n.item.classList.contains('is-open'));
  }

  /** 同步头部两个开关按钮的显示状态 */
  refreshHeader(): void {
    const allOpen = this.isAllOpen();
    // 全是同级标题（没有任何可折叠的分支）时，两个开关都没有意义，直接藏起来
    const hasBranches = this.nodes.some((n) => n.hasBranch);

    if (this.autoBtn) {
      const on = mode === 'auto';
      this.autoBtn.hidden = !hasBranches;
      this.autoBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      this.autoBtn.title = on
        ? '自动收起：开（只展开正在读的那一节）'
        : '自动收起：关（展开后保持，不自动折叠）';
    }

    if (this.expandBtn) {
      this.expandBtn.hidden = !hasBranches;
      this.expandBtn.setAttribute('aria-pressed', allOpen ? 'true' : 'false');
      const label = allOpen ? '收起全部' : '展开全部';
      this.expandBtn.title = label;
      this.expandBtn.setAttribute('aria-label', label);
    }

    for (const node of this.nodes) {
      if (!node.caret) continue;
      node.caret.setAttribute(
        'aria-expanded',
        node.item.classList.contains('is-open') ? 'true' : 'false',
      );
    }
  }

  /**
   * 目标位置 p：s 落在哪两个「画出来的、且有真实锚点的节点」之间。
   * 跨页章节没有锚点，只当路标画线，不参与插值（否则中间会算出 Infinity 跳跃）。
   */
  private computeTarget(s: number): void {
    const drawn = this.nodes.filter((n) => n.drawn && Number.isFinite(n.anchor));
    if (!drawn.length) {
      this.targetP = 0;
      return;
    }

    let j = 0;
    for (let i = 0; i < drawn.length; i += 1) {
      if (drawn[i]!.anchor <= s) j = i;
    }

    const current = drawn[j]!;
    const next = drawn[j + 1];

    if (!next) {
      // 最后一节：一路走到文章底部，轨迹才会画满
      const doc = document.documentElement;
      const maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
      const span = Math.max(1, maxScroll + OFFSET - current.anchor);
      const t = clamp((s - current.anchor) / span, 0, 1);
      this.targetP = current.norm + (1 - current.norm) * t;
      return;
    }

    const span = next.anchor - current.anchor;
    const t = span > 1 ? clamp((s - current.anchor) / span, 0, 1) : 1;
    this.targetP = current.norm + (next.norm - current.norm) * t;
  }

  // ---------------------------------------------------------------
  // 箭头 / 实线的弹簧动画
  // ---------------------------------------------------------------

  /** 半步进弹簧积分（按小步长迭代，和刷新率无关） */
  private integrate(spring: Spring, target: number, cfg: { stiffness: number; damping: number }, dt: number): boolean {
    const steps = Math.min(16, Math.max(1, Math.ceil(dt / STEP)));
    const h = dt / steps;

    for (let i = 0; i < steps; i += 1) {
      const accel = (target - spring.value) * cfg.stiffness - spring.velocity * cfg.damping;
      spring.velocity += accel * h;
      spring.value += spring.velocity * h;
    }

    if (Math.abs(target - spring.value) < SPRING_EPS && Math.abs(spring.velocity) < SPRING_EPS) {
      spring.value = target;
      spring.velocity = 0;
      return false;
    }
    return true;
  }

  private ensureLoop(): void {
    if (this.raf) return;

    if (!this.started) {
      // 首次：直接落位，不要从 0 弹过来
      this.started = true;
      this.position = { value: this.targetP, velocity: 0 };
      const sample = this.samplePath();
      this.rotation = { value: sample ? this.continuousAngle(sample.angle) : 0, velocity: 0 };
      this.lastTick = performance.now();
      this.apply();
      return;
    }

    const now = performance.now();
    const sample = this.samplePath();
    const settled =
      Math.abs(this.targetP - this.position.value) < SPRING_EPS &&
      Math.abs(this.position.velocity) < SPRING_EPS &&
      (sample === null ||
        (Math.abs(this.continuousAngle(sample.angle) - this.rotation.value) < 0.02 &&
          Math.abs(this.rotation.velocity) < 0.02));
    // 悬浮窗手动翻的位置还在往回收 / 还在追滚轮：这一小段也要逐帧跑
    const easing = this.float && this.floatOffset !== this.floatOffsetTarget;

    if (settled && !easing && now >= this.animUntil) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (): void => {
    this.raf = 0;

    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTick) / 1000));
    this.lastTick = now;

    const animating = now < this.animUntil;
    if (animating) {
      // 展开/折叠动画期间几何在变（后面的兄弟节点在往下挪），逐帧重算
      this.measure();
      this.computeTarget(window.scrollY + this.readLine());
    }

    // ① 沿轨迹的位置（弹簧 → 轻微跟手惯性）
    let moving = this.integrate(this.position, this.targetP, POS_SPRING, dt);

    // ② 朝向（弹簧 → 掉头时回弹一下）
    const sample = this.samplePath();
    if (sample) {
      const target = this.continuousAngle(sample.angle);
      if (this.integrate(this.rotation, target, ROT_SPRING, dt)) moving = true;
    }

    // ③ 悬浮窗的手动位移：每帧朝目标追一段（同 smooth-wheel 的指数逼近）
    //    · 滚轮：target 一格一格加，这里追过去 → 有惯性、不「哒哒」跳
    //    · 回中：换到下一节时 target 归零，同一条平滑顺手把位置送回自动跟随
    if (this.float && this.floatOffset !== this.floatOffsetTarget) {
      const tau = this.floatReturning ? FLOAT_RETURN_TAU : FLOAT_WHEEL_TAU;
      const gap = this.floatOffsetTarget - this.floatOffset;
      if (Math.abs(gap) < 0.4) {
        this.floatOffset = this.floatOffsetTarget;
        this.floatReturning = false;
      } else {
        this.floatOffset += gap * (1 - Math.exp(-(dt * 1000) / tau));
      }
      moving = true;
    }

    this.apply();
    if (moving || animating) this.raf = requestAnimationFrame(this.tick);
  };

  /** 轨迹当前点 + 切线方向（deg，已含「往上滑反 180°」） */
  private samplePath(): { x: number; y: number; angle: number } | null {
    if (!this.svgLength) return null;

    const len = clamp(this.position.value, 0, 1) * this.svgLength;
    try {
      const span = Math.min(1.2, this.svgLength / 2);
      const p0 = this.fill.getPointAtLength(Math.max(0, len - span));
      const p1 = this.fill.getPointAtLength(Math.min(this.svgLength, len + span));
      const point = this.fill.getPointAtLength(len);

      let ax = p1.x - p0.x;
      let ay = p1.y - p0.y;
      if (Math.hypot(ax, ay) < 1e-3) {
        ax = 0;
        ay = 1;
      }

      // 往上滑时整条轨迹反着走：箭头也跟着反向
      const sign = scrollDir === 'up' ? -1 : 1;
      return {
        x: point.x,
        y: point.y,
        angle: (Math.atan2(-ax * sign, ay * sign) * 180) / Math.PI,
      };
    } catch {
      return null;
    }
  }

  /**
   * 把 -180~180 的角度接到「离当前角度最近」的连续角度上。
   * 掉头（差值接近 180°）时固定走**顺时针**（角度取正），观感统一；
   * 只有 45° 分级这种小角度变化才按最近的走法。
   */
  private continuousAngle(raw: number): number {
    const base = this.rotation.value;
    let delta = ((((raw - base) % 360) + 540) % 360) - 180;

    // 差值超过 90° = 这次是掉头：一律顺时针（+180 而不是 -180）
    if (Math.abs(delta) > 90) delta = Math.abs(delta);

    return base + delta;
  }

  private apply(): void {
    if (!this.svgLength) {
      this.syncWindow(0);
      return;
    }

    const len = clamp(this.position.value, 0, 1) * this.svgLength;
    this.fill.style.strokeDashoffset = `${this.svgLength - len}`;

    const sample = this.samplePath();
    if (!sample) {
      this.syncWindow(0);
      return;
    }

    /**
     * 位置：**箭头的几何中心压在轨迹点上**（盒子位置与朝向无关）。
     * 于是掉头时盒子一动不动，是纯粹的「绕自身中心转」；
     * 而尖端沿着轨迹线超前半个箭身高，永远落在线上（45° 分级时也一样）。
     */
    const boxX = (sample.x - ARROW_CX).toFixed(2);
    const boxY = (sample.y - ARROW_CY).toFixed(2);

    this.arrow.style.transform = `translate3d(${boxX}px, ${boxY}px, 0) rotate(${this.rotation.value.toFixed(
      2,
    )}deg)`;

    // 箭头落到哪儿了 —— 目录窗口据此决定要不要把整棵树往上滑
    this.syncWindow(sample.y);
  }

  /** 纸飞机走到 arrowY 了：让所在的「窗口」重新摆一次（侧栏 / 悬浮窗各有各的算法） */
  private syncWindow(arrowY: number): void {
    if (this.float) this.updateFloat(arrowY);
    else this.updatePin(arrowY);
  }

  /**
   * 目录窗口：长目录不把纸飞机丢到网页外面
   * ---------------------------------------------------------------
   * arrowY 是纸飞机在**树坐标系**里的绝对高度（和位移无关，所以不会自激）。
   * 判定链：
   *   ① 可用高度 room = 卡片粘住后，窗口底部到视口顶端还剩多少（再减掉阅读进度条）
   *   ② 窗口高度 windowH = min(树高, room) —— 树没超过一屏时 windowH 就等于树高
   *   ③ 位移 shift = clamp(箭头 - windowH × PIN_RATIO, 0, 树高 - windowH)
   *      下限 0：还没越过 pinY 就一点都不滑（保持「整棵树摊开」的原样）
   *      上限「树高 - windowH」：滑到底部时正好把最后一段露完，不会滑过头留白
   *   ④ 位移直接贴上去（不过渡）：纸飞机和树在同一帧里移动，
   *      于是纸飞机稳稳钉在 pinY 上，往上走的是目录本身，看起来就是「目录在滑」
   */
  private updatePin(arrowY: number): void {
    const viewport = this.viewport;
    const card = this.card;
    // 移动端折叠卡有自己的一套：CSS 限高 + 内滚动条（见 toc.css），不掺和
    if (!viewport || !card || this.inline) return;

    const viewportRect = viewport.getBoundingClientRect();
    // 侧栏在窄屏是被 display:none 藏起来的，别去量它
    if (viewportRect.width < 40) return;

    const foot = card.querySelector<HTMLElement>('.toc-foot');
    const footH = foot ? foot.getBoundingClientRect().height : 0;
    const room = this.pinRoom(footH, viewportRect);
    const treeH = this.tree.getBoundingClientRect().height;

    const windowH = Math.min(treeH, room);
    const maxShift = Math.max(0, treeH - windowH);
    const pinned = maxShift > 1;

    const height = pinned ? `${Math.round(windowH)}px` : '';
    if (viewport.style.maxHeight !== height) viewport.style.maxHeight = height;
    viewport.classList.toggle('is-pinned', pinned);

    let shift = 0;
    if (pinned) shift = clamp(arrowY - windowH * PIN_RATIO, 0, maxShift);

    this.tree.style.transform = shift > 0.4 ? `translate3d(0, ${(-shift).toFixed(2)}px, 0)` : '';

    // 上下各有没露完的半行 → 让 CSS 在那一侧补一条淡出，看起来像被窗口裁住而不是断掉
    viewport.classList.toggle('is-clipped-top', pinned && shift > 0.5);
    viewport.classList.toggle('is-clipped-bottom', pinned && shift < maxShift - 0.5);
  }

  /**
   * 目录窗口的可用高度（缓存：只有视口尺寸 / 布局变了才重算）
   * ---------------------------------------------------------------
   * 必须按「卡片粘住之后」的顶端坐标算，而不是当前坐标：
   * 页面顶部还没粘住（横幅还占着一屏）、卡片在很下面，
   * 拿当前坐标算出来的可用高度会随着滚动一路变大 ——
   * 于是目录卡边滚边「长高」，看着像 bug。
   * 粘住之后顶端是固定的，可用高度也就是一个常量。
   */
  private pinRoom(footH: number, viewportRect: DOMRect): number {
    if (!this.pinRoomH || this.pinInnerH !== window.innerHeight) {
      const top = this.stuckTop(viewportRect);
      this.pinRoomH = clamp(
        window.innerHeight - top - footH - PIN_GAP,
        PIN_MIN,
        Math.max(PIN_MIN, window.innerHeight - 120),
      );
      this.pinInnerH = window.innerHeight;
    }
    return this.pinRoomH;
  }

  /** 目录视口顶端「粘住之后」在屏幕上的固定坐标（找不到粘性父级就用当前坐标） */
  private stuckTop(viewportRect: DOMRect): number {
    const card = this.card;
    if (!card) return viewportRect.top;

    let holder = card.parentElement;
    while (holder && holder !== document.body) {
      if (getComputedStyle(holder).position === 'sticky') break;
      holder = holder.parentElement;
    }
    if (!holder) return viewportRect.top;

    const stickyTop = Number.parseFloat(getComputedStyle(holder).top);
    if (!Number.isFinite(stickyTop)) return viewportRect.top;

    const cardRect = card.getBoundingClientRect();
    // 两个布局常量（和滚动无关）：卡片相对粘性层的偏移、视口相对卡片顶端的偏移
    const inHolder = cardRect.top - holder.getBoundingClientRect().top;
    const inCard = viewportRect.top - cardRect.top;
    return stickyTop + inHolder + inCard;
  }

  /** 滚动方向变了：箭头原地掉头（位置不动，只让朝向弹簧去追） */
  refreshDirection(): void {
    this.requestUpdate();
  }

  // ---------------------------------------------------------------
  // 竖屏悬浮窗
  // ---------------------------------------------------------------

  /**
   * 悬浮窗要不要露面
   * ---------------------------------------------------------------
   * 判据只有一条：顶部那张内联卡（竖屏里正文顶上那张折叠目录）的**下边缘**
   * 已经滑到视口上方 —— 这时它已经彻底看不见了，悬浮窗才接上。
   * 上下各留一条线做滞回（FLOAT_SHOW_GAP），临界位置来回抖也不会闪。
   *
   * 宽屏（≥1024px）那张卡连着悬浮窗一起是 display:none：面板量出来的宽度是 0，
   * 直接判「不出面」，顺带把这一整轮计算都省掉。
   */
  private syncFloat(): boolean {
    const panel = this.floatPanel;
    if (!panel) return false;

    if (panel.getBoundingClientRect().width < 40) {
      this.setFloatShown(false);
      return false;
    }

    const card = this.inlineCard;
    // 卡片刚滑出视口时 bottom ≈ 0：再用两条线区分「该露」和「该收」
    const bottom = card ? card.getBoundingClientRect().bottom : -window.innerHeight;
    const shown = this.floatShown ? bottom <= 0 : bottom < -FLOAT_SHOW_GAP;
    this.setFloatShown(shown);

    return shown;
  }

  private setFloatShown(shown: boolean): void {
    if (shown === this.floatShown) return;
    this.floatShown = shown;
    const wrap = this.floatWrap;
    if (!wrap) return;
    wrap.dataset.tocShown = shown ? '1' : '0';

    if (shown) {
      // 刚露面：从「自动跟随」重新开始，别把上一轮手动翻的位置带进来
      this.floatOffset = 0;
      this.floatOffsetTarget = 0;
      this.floatReturning = false;
      this.lastActiveIndex = -2;
      this.started = false;
      this.syncNavOffset();
    }
    // 露面 / 收起都要重算「跳转时让开多少」（面板高度这时候可能还没量出来，
    // 下一帧 updateFloat 里会再补一次）
    this.syncScrollPadding();
  }

  /** 导航胶囊现在露着没有 → 悬浮窗往下让位（两边一起动，才不会叠在一起） */
  private syncNavOffset(): void {
    const wrap = this.floatWrap;
    if (!wrap) return;

    const shell = document.querySelector<HTMLElement>('[data-nav-shell]');
    if (!shell) {
      this.floatNavY = 0;
      wrap.style.setProperty('--toc-float-y', '0px');
      return;
    }

    // offsetHeight 不含 transform：导航收起（translateY(-120%)）时它照样报真实高度
    const hidden = shell.classList.contains('is-hidden');
    const y = hidden ? 0 : shell.offsetHeight + NAV_TOP + NAV_CLEARANCE;
    this.floatNavY = y;
    wrap.style.setProperty('--toc-float-y', `${Math.round(y)}px`);
  }

  /**
   * 悬浮窗的窗口与位移
   * ---------------------------------------------------------------
   * 比侧栏那套简单一档（它只需要管一屏之内的事）：
   *   ① 窗口高 = min(树高, 视口 36%)，夹在 [176, 352] —— 树短就贴树高，不留白
   *   ② 位移 = clamp(箭头 - 窗口高 × 0.5, 0, 树高 - 窗口高)
   *      下限 0：还没读到中间就一点都不滑；上限：滑到底正好露完最后一段
   *   ③ 再叠上用户手动翻出来的 floatOffset（滚轮 / 手指），一起夹在同样的范围里
   *   ④ 位移直接贴上去（不过渡）：纸飞机和树在同一帧里动，
   *      于是纸飞机稳稳钉在窗口正中，往上走的是目录内容本身
   */
  private updateFloat(arrowY: number): void {
    const viewport = this.viewport;
    if (!viewport) return;

    // 收起成小胶囊了：看不见就别算（展开时 requestUpdate 会立刻补一次）
    if (!this.floatOpen) return;
    // 面板还没布局（宽屏隐藏）：不量
    if (viewport.getBoundingClientRect().width < 40) return;

    const treeH = this.tree.getBoundingClientRect().height;
    const maxH = clamp(window.innerHeight * FLOAT_WINDOW_RATIO, FLOAT_WINDOW_MIN, FLOAT_WINDOW_MAX);
    const windowH = Math.min(treeH, maxH);
    const maxShift = Math.max(0, treeH - windowH);
    const pinned = maxShift > 1;

    const height = `${Math.round(windowH)}px`;
    if (viewport.style.maxHeight !== height) {
      viewport.style.maxHeight = height;
      // 窗口高度变了（分支展开 / 折叠、换屏）：跳转让开的高度跟着改
      this.syncScrollPadding();
    }
    viewport.classList.toggle('is-pinned', pinned);

    const auto = pinned ? clamp(arrowY - windowH * FLOAT_PIN_RATIO, 0, maxShift) : 0;
    this.floatAutoShift = auto;
    this.floatMaxShift = maxShift;

    const shift = clamp(auto + this.floatOffset, 0, maxShift);
    this.tree.style.transform = shift > 0.4 ? `translate3d(0, ${(-shift).toFixed(2)}px, 0)` : '';

    // 上下各有没露完的半行 → 让 CSS 在那一侧补一条淡出
    viewport.classList.toggle('is-clipped-top', pinned && shift > 0.5);
    viewport.classList.toggle('is-clipped-bottom', pinned && shift < maxShift - 0.5);
  }

  /**
   * 把一次纵向位移（像素）加到窗口上（滚轮 / 手指共用）
   * ---------------------------------------------------------------
   * 只改**目标**，真正的位移由 tick 里的指数平滑一帧帧追过去 ——
   * 滚轮一格是 100~120px 的跳变，直接贴上去就是「一格一顿」；
   * 手指（touchmove）来的本来就是连续小位移，那就不用再缓一次，直接跟手。
   *
   * 返回 true = 位置真的动了；false = 已经在头 / 尾（或者根本没得滑）。
   * 撞到边界就不再往那个方向叠，免得松手后要「往回摇」半天。
   */
  private scrollFloat(delta: number, smooth = true): boolean {
    if (!delta || !this.floatShown || !this.floatOpen) return false;

    const maxShift = this.floatMaxShift;
    if (maxShift <= 1) return false;

    const current = clamp(this.floatAutoShift + this.floatOffsetTarget, 0, maxShift);
    const next = clamp(current + delta, 0, maxShift);
    if (Math.abs(next - current) < 0.5) return false;

    this.floatOffsetTarget = next - this.floatAutoShift;
    this.floatReturning = false;
    if (!smooth) this.floatOffset = this.floatOffsetTarget;
    this.requestUpdate();
    return true;
  }

  private onFloatWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    // 横向为主的滚轮（触控板横扫、Shift + 滚轮）不插手
    if (Math.abs(event.deltaY) < Math.abs(event.deltaX) * 0.5) return;
    if (!this.floatShown || !this.floatOpen) return;
    // 树本来就比窗口矮：没什么可翻的，这一格算页面的
    if (this.floatMaxShift <= 1) return;

    /**
     * 指针压在悬浮窗上，滚轮就**只归目录**：滑到顶 / 滑到底也只是停住，
     * 不再把这一格甩给页面 —— 读者在翻目录时正文突然跟着动一下很难受。
     * 想接着读，把指针挪出窗口（窗口只占屏幕顶部约 1/3）再滚就行。
     */
    event.preventDefault();
    const page = this.viewport?.clientHeight ?? window.innerHeight;
    this.scrollFloat(wheelPx(event, page), true);
  };

  private onFloatTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch) return;
    this.touchY = touch.clientY;
    this.touchActive = this.floatShown && this.floatOpen;
  };

  private onFloatTouchMove = (event: TouchEvent): void => {
    if (!this.touchActive) return;
    const touch = event.touches[0];
    if (!touch) return;

    // 手指往上推 → 内容往上滚（同原生）；跟手，不再做一次平滑
    const delta = this.touchY - touch.clientY;
    this.touchY = touch.clientY;
    if (this.scrollFloat(delta, false)) event.preventDefault();
  };

  private onFloatTouchEnd = (): void => {
    this.touchActive = false;
  };

  /** 视口尺寸变了：导航高度 / 安全区都可能变，让位距离重算一次 */
  private onFloatResize = (): void => {
    this.proseMeasured = false;
    this.syncNavOffset();
  };

  /** 展开 / 收起悬浮窗（状态记住，下次还按这个来） */
  private setFloatOpen(open: boolean): void {
    if (open === this.floatOpen) return;
    this.floatOpen = open;
    persistFloatOpen(open);

    const wrap = this.floatWrap;
    if (wrap) {
      wrap.dataset.tocOpen = open ? '1' : '0';
      wrap
        .querySelector('[data-toc-float-fold]')
        ?.setAttribute('aria-expanded', open ? 'true' : 'false');
      wrap
        .querySelector('[data-toc-float-pill]')
        ?.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    // 展开时让树重新量一遍（收起期间几何没动过，但分支/窗口可能已经变了）
    if (open) this.geoDirty = true;
    this.syncScrollPadding();
    this.markAnimating();
    this.requestUpdate();
  }

  /**
   * 点目录跳转时，标题不能落在悬浮窗底下
   * ---------------------------------------------------------------
   * 正文标题只写了 `scroll-margin-top: 导航高 + 1rem`（prose.css），
   * 那是给「没有悬浮窗」的情况留的位置。悬浮窗一露，它正好盖住正文顶部 ——
   * 于是给 <html> 挂一个 .toc-float-open，让 CSS 把标题的 scroll-margin-top
   * 换成 --toc-float-pad（= 面板下边缘 + 一点空隙），点哪一节都停在窗下面。
   *
   * 用 offsetTop / offsetHeight 而不是 getBoundingClientRect：
   * 后者算的是「这一刻画到屏幕上的位置」，而悬浮窗出场那 380ms 还在
   * translateY(-130%) 往回滑 —— 拿它算出来是个负数（= 无效值，直接被丢掉）。
   * offsetTop / offsetHeight 不含 transform，动画中途也是最终位置。
   */
  private syncScrollPadding(): void {
    const root = document.documentElement;
    const panel = this.floatPanel;

    if (!panel || !this.floatShown || !this.floatOpen) {
      root.classList.remove('toc-float-open');
      root.style.removeProperty('--toc-float-pad');
      this.floatPadH = 0;
      return;
    }

    const pad = Math.round(this.floatNavY + panel.offsetTop + panel.offsetHeight) + 12;
    if (pad === this.floatPadH) return;
    this.floatPadH = pad;
    root.style.setProperty('--toc-float-pad', `${pad}px`);
    root.classList.add('toc-float-open');
  }

  /** 目录自己滚一下，让当前这一节始终露在可视区里 */
  private scrollIntoViewport(node: NodeGeo): void {
    const scroller = this.scroller ?? this.findScroller(node.link);
    if (!scroller) return;

    const box = scroller.getBoundingClientRect();
    if (box.height < 60) return; // 收起了 / 不可见

    const rect = node.link.getBoundingClientRect();
    if (rect.top >= box.top + 6 && rect.bottom <= box.bottom - 6) return;

    const delta = rect.top - box.top - box.height * 0.36;
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: 'smooth' });
  }

  /**
   * 找「真正在滚」的那个容器。
   * 普通文章是目录卡自己的 .toc-viewport；
   * 系列文章（合成目录）把视口撑开、由外层侧栏统一滚动，
   * 这时要滚的是侧栏，不然活动项跑到可视区外面去了。
   */
  private findScroller(from: HTMLElement): HTMLElement | null {
    let el: HTMLElement | null = this.viewport ?? from.parentElement;
    while (el && el !== this.tree) {
      if (el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        this.scroller = el;
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /** 正文高度变了（图片加载完等）→ 标题的绝对位置、胶囊进度都要重算 */
  invalidateAnchors(): void {
    this.anchorsDirty = true;
    this.proseMeasured = false;
    this.update();
  }

  requestUpdate(): void {
    this.update();
    this.refreshHeader();
  }
}

// -------------------------------------------------------------------
// 生命周期
// -------------------------------------------------------------------

const trees = new Set<TocTree>();
let scrollRaf = 0;
let cleanupListeners: (() => void) | null = null;

/** 上一次的滚动位置：用来判断「往下滑还是往上滑」 */
let lastScrollY = 0;
/** 箭头朝向（下滑 = 朝下，上滑 = 调头朝上） */
let scrollDir: 'down' | 'up' = 'down';

function onScroll(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;

    // 先判方向：小于 1.5px 的抖动不触发调头，避免箭头来回抽搐
    const y = window.scrollY;
    const delta = y - lastScrollY;
    lastScrollY = y;
    if (Math.abs(delta) > 1.5) {
      const next: 'down' | 'up' = delta > 0 ? 'down' : 'up';
      if (next !== scrollDir) {
        scrollDir = next;
        // 方向变了：箭头原地掉头（位置不动，只翻朝向）
        for (const tree of trees) tree.refreshDirection();
      }
    }

    for (const tree of trees) tree.update();
  });
}

function teardown(): void {
  for (const tree of trees) tree.destroy();
  trees.clear();
  cleanupListeners?.();
  cleanupListeners = null;
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
}

function persistMode(): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* 忽略 */
  }
}

/** 切到手动模式前，把「当前展开着的」接管过来，画面不会突然一缩 */
function adoptOpenBranches(): void {
  for (const tree of trees) {
    for (const slug of tree.getOpenSlugs()) manualOpen.add(slug);
    break;
  }
}

function refreshAll(): void {
  for (const tree of trees) tree.requestUpdate();
}

/** 自动收起（手风琴）开 / 关 */
function setMode(next: TocMode): void {
  if (mode === next) return;
  if (next === 'manual') adoptOpenBranches();
  mode = next;
  pauseOpenForSlug = null;
  persistMode();
  refreshAll();
}

/** 手动展开 / 收起某一支 */
function toggleBranch(slug: string): void {
  if (mode !== 'manual') {
    adoptOpenBranches();
    mode = 'manual';
    persistMode();
  }
  if (manualOpen.has(slug)) manualOpen.delete(slug);
  else manualOpen.add(slug);
  refreshAll();
}

/** 展开全部 / 收起全部 */
function setAllOpen(open: boolean): void {
  adoptOpenBranches();
  mode = 'manual';
  persistMode();
  manualOpen.clear();

  if (open) {
    pauseOpenForSlug = null;
    for (const tree of trees) {
      for (const slug of tree.getBranchSlugs()) manualOpen.add(slug);
      break;
    }
  } else {
    // 收起全部：停在当前这一节期间不再自动展开，滚到下一节才恢复
    const active = document.querySelector<HTMLElement>('.toc-node.is-active');
    pauseOpenForSlug = active?.dataset.tocSlug ?? null;
  }

  refreshAll();
}

function initToc(): void {
  const els = [...document.querySelectorAll<HTMLElement>('[data-toc-tree]')];
  if (!els.length) {
    teardown();
    return;
  }

  // ⚠ onPageLoad 在首屏会触发两次（DOMContentLoaded + astro:page-load）：
  //   同一批元素重复 init 会让每个按钮挂上两份 click 监听，
  //   点一下 = 切换两次 = 看起来「没反应」。所以这里做一次幂等判断。
  if (trees.size && els.every((el) => el.dataset.tocReady === '1')) {
    for (const tree of trees) tree.requestUpdate();
    return;
  }

  teardown();

  // 换了一篇文章：上一页记下的手动展开状态不再适用
  manualOpen.clear();
  pauseOpenForSlug = null;
  lastScrollY = window.scrollY;
  scrollDir = 'down';

  for (const el of els) {
    el.dataset.tocReady = '1';
    trees.add(new TocTree(el));
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  window.addEventListener('orientationchange', onScroll, { passive: true });

  // 正文里图片/字体加载完会改动标题位置 —— 拿正文的高度变化当信号，重算锚点
  let proseObserver: ResizeObserver | null = null;
  const prose = document.querySelector<HTMLElement>('.prose-blog');
  if (prose && typeof ResizeObserver !== 'undefined') {
    proseObserver = new ResizeObserver(() => {
      for (const tree of trees) tree.invalidateAnchors();
    });
    proseObserver.observe(prose);
  }

  cleanupListeners = () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('orientationchange', onScroll);
    proseObserver?.disconnect();
    proseObserver = null;
  };

  for (const tree of trees) tree.requestUpdate();
}

onBeforeSwap(teardown);
onPageLoad(initToc);
