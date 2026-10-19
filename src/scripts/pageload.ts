/**
 * 页面生命周期小工具
 * ============================================================
 * 本站启用了 <ClientRouter />（SPA 式换页），
 * 换页时 DOM 会被替换，但打包脚本**只执行一次** —— 直接写
 * document.querySelector(...).addEventListener(...) 在第二次进入页面时就会失效。
 *
 * 所以所有交互脚本都走这里：
 *   onPageLoad(fn)  首次加载 + 每次换页后都执行（fn 里要自己做幂等判断）
 *   onBeforeSwap(fn) 换页前清理（定时器、Observer、全局监听）
 * ============================================================
 */

type Handler = () => void;

const beforeSwapHandlers: Handler[] = [];

/** 换页前注册清理逻辑（只会被调用一次） */
export function onBeforeSwap(fn: Handler): void {
  beforeSwapHandlers.push(fn);
}

let swapCleanupBound = false;

/** 首次加载 + 每次 ClientRouter 换页后执行 */
export function onPageLoad(fn: Handler): void {
  if (!swapCleanupBound) {
    swapCleanupBound = true;
    document.addEventListener('astro:before-swap', () => {
      for (const cleanup of beforeSwapHandlers.splice(0)) {
        try {
          cleanup();
        } catch {
          /* 清理失败不影响换页 */
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }

  document.addEventListener('astro:page-load', fn);
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
