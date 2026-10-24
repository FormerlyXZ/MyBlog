/**
 * 页面生命周期小工具
 * ============================================================
 * 本站启用了 <ClientRouter />（SPA 式换页），
 * 换页时 DOM 会被替换，但打包脚本**只执行一次** —— 直接写
 * document.querySelector(...).addEventListener(...) 在第二次进入页面时就会失效。
 *
 * 所以所有交互脚本都走这里：
 *   onPageLoad(fn)  每次页面加载**只执行一次**（首屏 + 每次换页后各一次）
 *   onBeforeSwap(fn) 每次换页前清理（定时器、Observer、全局监听）
 * ============================================================
 */

type Handler = () => void;

/**
 * 换页前清理逻辑。
 * 这里**不清空**：绝大多数脚本在模块顶层注册一次（模块只执行一次），
 * 清空了就意味着「只有第一次换页会清理，之后全泄漏」
 * （Banner 的轮播定时器、打字机定时器会跟着旧页面的 DOM 一直跑）。
 */
const beforeSwapHandlers: Handler[] = [];

/** 换页前注册清理逻辑（每次换页都会执行；只注册一次，别放进 init 里反复注册） */
export function onBeforeSwap(fn: Handler): void {
  beforeSwapHandlers.push(fn);
}

let swapBound = false;

/**
 * 「页面世代」：首屏是第 0 代，之后每换一次页 +1。
 *
 * 为什么需要它：ClientRouter 的 astro:page-load 在**首屏也会触发一次**
 * （它挂在 window 的 load 上，见 astro/dist/transitions/router.js），
 * 而脚本执行 / DOMContentLoaded 时已经跑过一遍了 —— 于是首屏会 init 两次。
 * 两套初始化叠在同一个元素上，典型症状：
 *   · Banner 副标题像两台不同步的打字机在抢（首屏乱跳，点进别的页面又正常）
 *   · 同一个按钮挂两份 click，点一下等于点两下
 *
 * 本地 dev 不容易复现：Vite 的模块图要一段段请求，脚本常常在 window load
 * **之后**才执行，那时已经错过首屏那次 astro:page-load 了；
 * 线上的打包产物很小，先于 load 执行，于是必然吃两次。
 *
 * 有了世代号，同一个回调在同一个世代里只会跑一次，
 * 不用每个脚本各自写 dataset 幂等判断（那层保险还留着，防手滑）。
 */
let pageGen = 0;

function bindSwap(): void {
  if (swapBound) return;
  swapBound = true;
  document.addEventListener('astro:before-swap', () => {
    // 先推进世代：换页后的 astro:page-load 属于新的世代
    pageGen++;
    for (const handler of beforeSwapHandlers) {
      try {
        handler();
      } catch {
        /* 清理失败不影响换页 */
      }
    }
  });
}

/** 首次加载 + 每次 ClientRouter 换页后执行（每个世代只有一次） */
export function onPageLoad(fn: Handler): void {
  bindSwap();

  let ranGen = -1;
  const run = () => {
    // 同一世代已经跑过（首屏 DOMContentLoaded / 立即执行 与 astro:page-load 重复）
    if (ranGen === pageGen) return;
    ranGen = pageGen;
    fn();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }

  document.addEventListener('astro:page-load', run);
}

/** 给一批元素绑定事件，返回解绑函数 */
export function bind<K extends keyof DocumentEventMap>(
  root: EventTarget,
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  root.addEventListener(type, handler as EventListener, options);
  return () => root.removeEventListener(type, handler as EventListener, options);
}
