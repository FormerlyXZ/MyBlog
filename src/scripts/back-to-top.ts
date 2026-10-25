/**
 * 回到顶部（右下角圆钮）
 * ============================================================
 * 两件事：
 *   ① 滚动 → 滚过一段距离才露面，回到页首附近再收起来
 *   ② 点击 → 平滑回到页首（系统开了「减少动态效果」就直接跳，别跟用户对着干）
 *
 * 丝滑要点：
 *   · 滚动回调只做一次比较，露面/收起交给 class（过渡全在 CSS 里）；
 *   · 每帧最多算一次（rAF 节流），滚动时不读布局。
 *
 * 换页（<ClientRouter />）时元素会被整块换掉，
 * 所以每次换代都重新取元素、重新挂监听，换页前把上一代的监听清干净。
 */
import { onPageLoad, onBeforeSwap } from './pageload';

/** 滚过这么多像素才露面：太早出现挡视线，太晚又等不到它 */
const SHOW_AFTER = 420;

type Cleanup = () => void;
let cleanup: Cleanup | null = null;

function initBackToTop(): void {
  cleanup?.();
  cleanup = null;

  const button = document.querySelector<HTMLButtonElement>('[data-back-to-top]');
  if (!button) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const listeners: Array<() => void> = [];

  const bind = (
    target: Window | Document | Element,
    type: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler));
  };

  let visible = false;
  let ticking = false;

  const apply = (show: boolean): void => {
    if (show === visible) return;
    visible = show;
    button.classList.toggle('is-visible', show);
    // 藏起来的时候一并摘掉 Tab 顺序，键盘用户不会停在一个看不见的按钮上
    button.tabIndex = show ? 0 : -1;
  };

  const render = (): void => {
    ticking = false;
    apply(window.scrollY > SHOW_AFTER);
  };

  const onScroll = (): void => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(render);
  };

  bind(window, 'scroll', onScroll as EventListener, { passive: true });

  bind(
    button,
    'click',
    () => {
      window.scrollTo({
        top: 0,
        behavior: reducedMotion.matches ? 'auto' : 'smooth',
      });
    },
    { passive: true },
  );

  // 首屏如果是被浏览器还原在中途（刷新 / 前进后退），一进来就该是「已露面」
  render();

  cleanup = () => {
    for (const off of listeners.splice(0)) off();
  };
}

onBeforeSwap(() => {
  cleanup?.();
  cleanup = null;
});

onPageLoad(initBackToTop);
