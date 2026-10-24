/**
 * 明暗切换的「波纹扩散」过渡
 * ============================================================
 * 点太阳 / 月亮按钮换明暗时，不希望整屏「啪」一下就换成另一种配色，
 * 而是以按钮（波源）为圆心，像水面波纹一样把新配色摊开 ——
 * 波前推到哪，哪就变成新配色，波还没到的地方保持原样。
 *
 * 用的是浏览器原生 View Transitions API：
 *   ① 给 <html> 加 .theme-wave（styles/theme-wave.css 关掉默认的整屏交叉淡入）
 *   ② document.startViewTransition(改主题)：浏览器把「换之前」和「换之后」
 *      各拍一张全屏快照，叠在同一位置上
 *   ③ 给上层（::view-transition-new(root)）跑一个 clip-path 动画，
 *      圆半径从 0 拉到「刚好盖满整屏」，圆心就是点击位置
 *
 * 降级（这几条都走「直接切」，不播动画）：
 *   · 浏览器不支持 startViewTransition（Chrome < 111 / Safari < 18.2 等）
 *   · 用户开了系统级「减少动态效果」（prefers-reduced-motion: reduce）
 *   · 上一波还没播完又点了一次（两次动画互相打断会闪）
 * ============================================================
 */

/** 波源：视口坐标系里的一个像素点 */
export interface WaveOrigin {
  x: number;
  y: number;
}

/** 波纹盖满整屏用的时长（ms）：再长就拖沓，再短就看不出「扩散」 */
const WAVE_DURATION = 700;

/**
 * 缓动近乎匀速、两头略软 —— 波前基本是「匀速推进」的，
 * 不会像纯 ease-out 那样开头一冲就把屏幕盖完，后半段只剩停着等。
 */
const WAVE_EASING = 'cubic-bezier(0.4, 0.25, 0.55, 1)';

/** 波纹播放期间挂在 <html> 上，styles/theme-wave.css 只认这个类 */
const WAVE_CLASS = 'theme-wave';

/** 同一时刻只播一波：上一波还没播完又点了，就直接切（两波叠加会互相打断） */
let playing = false;

/* ---------------- 环境判断 ---------------- */

/**
 * 只用到 startViewTransition / ready / finished，
 * 自己声明一份最小结构，省得依赖 TS 版本里有没有 View API 的类型。
 */
interface ViewTransitionLike {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition: () => void;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionLike;
};

/** WAAPI 的 pseudoElement 选项：较老的 lib.dom 里没有，补上 */
type WaveAnimationOptions = KeyframeAnimationOptions & { pseudoElement: string };

function viewTransitionDoc(): ViewTransitionDocument {
  return document as ViewTransitionDocument;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/* ---------------- 波源与半径 ---------------- */

function clampToViewport({ x, y }: WaveOrigin): WaveOrigin {
  return {
    x: Math.min(Math.max(x, 0), window.innerWidth),
    y: Math.min(Math.max(y, 0), window.innerHeight),
  };
}

/**
 * 算出波源。
 * 优先用鼠标 / 手指的点击坐标；键盘回车触发时 clientX / clientY 都是 0，
 * 就退到按钮中心 —— 所以按钮被滚到屏幕外也不会算歪。
 */
export function waveOrigin(event?: Event | null, source?: Element | null): WaveOrigin {
  const point = event as MouseEvent | null | undefined;
  const clientX = point?.clientX ?? 0;
  const clientY = point?.clientY ?? 0;
  if (clientX || clientY) return clampToViewport({ x: clientX, y: clientY });

  const rect = source?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return clampToViewport({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/** 波源到视口四角的最远距离：圆扩到这个半径就一定盖满整屏 */
function coverRadius({ x, y }: WaveOrigin): number {
  const dx = Math.max(x, window.innerWidth - x);
  const dy = Math.max(y, window.innerHeight - y);
  return Math.hypot(dx, dy);
}

/* ---------------- 主流程 ---------------- */

/**
 * 播放一次波纹扩散。apply() 负责真正改主题（要同步改完 DOM）。
 * 返回 true 表示这次走了动画，false 表示降级成直接切换。
 */
export function playThemeWave(apply: () => void, origin: WaveOrigin): boolean {
  const doc = viewTransitionDoc();
  const start = doc.startViewTransition;

  if (!start || playing || prefersReducedMotion()) {
    apply();
    return false;
  }

  const root = document.documentElement;
  const { x, y } = origin;
  // 半径至少 1px：0 → 0 的动画没意义，也可能被浏览器直接跳过
  const radius = Math.max(coverRadius(origin), 1);

  root.classList.add(WAVE_CLASS);
  playing = true;

  let transition: ViewTransitionLike;
  try {
    // 回调必须同步改完 DOM，浏览器才知道「新一帧」长什么样
    transition = start.call(document, apply);
  } catch {
    // 极端情况（同时还在换页等）：退回直接切，别把主题卡住
    root.classList.remove(WAVE_CLASS);
    playing = false;
    apply();
    return false;
  }

  transition.ready
    .then(() => {
      const options: WaveAnimationOptions = {
        duration: WAVE_DURATION,
        easing: WAVE_EASING,
        // 播完保持「盖满」，否则快照销毁前那一帧会闪回旧配色
        fill: 'forwards',
        // 动画作用在这层快照上，而不是 <html> 本身
        pseudoElement: '::view-transition-new(root)',
      };
      root.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${radius}px at ${x}px ${y}px)`,
          ],
        },
        options,
      );
    })
    .catch(() => {
      /* ready 被拒 = 这波过渡被取消了（比如同时发生了换页），不用管 */
    });

  transition.finished
    .catch(() => {
      /* 被取消时 finished 也会 reject */
    })
    .then(() => {
      playing = false;
      root.classList.remove(WAVE_CLASS);
    });

  return true;
}
