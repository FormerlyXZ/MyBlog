/**
 * 导航隐现：只在页面最上面出现
 * ============================================================
 * 规则很简单：
 *   ① **页面还在最上面**（还没滚过 Banner 文字）→ 露着；
 *   ② 已经滚下去了 → 收起，并且**不会因为上滑而重新弹出**；
 *   ③ 只有回到页面顶部、导航重新位于 Banner 文字上方时才会再出现。
 *
 * 唯一例外：键盘用户 Tab 进导航时强制显示。
 * 收起态只是 translateY + opacity，元素仍然可聚焦 —— 焦点进去了还藏着，
 * 等于让人对着空气敲键盘。
 *
 * 没有 Banner 的页面（工具页之类）同样退化成「贴近顶部就露着」。
 * ============================================================
 */

import { onPageLoad, onBeforeSwap } from './pageload';

/** 没有横幅的页面：滚过这么远就当离开了「最上面」 */
const FALLBACK_THRESHOLD = 80;

let cleanup: (() => void) | null = null;

export function initNav(): void {
  // 上一轮的监听先拆掉（换页后会重新初始化）
  cleanup?.();
  cleanup = null;

  const shell = document.querySelector<HTMLElement>('[data-nav-shell]');
  if (!shell) return;

  let waiting = false; // rAF 节流
  let heldFocus: Element | null = null; // 键盘送进来、还握着焦点的那个控件

  /**
   * 现在是不是还在「页面最上面」。
   * 只用滚动距离判断：离开顶部就收起，不再因为 Banner 标题还在视口里
   * 或用户往上翻而重新弹出，目录也不会跟着导航上下跳。
   */
  const atTop = (): boolean => window.scrollY < FALLBACK_THRESHOLD;

  /** 键盘送上来的焦点是不是还站在原地（还在导航里就锁住不收） */
  const focusHeld = (): boolean => heldFocus !== null && document.activeElement === heldFocus;

  const render = (): void => {
    if (focusHeld() || atTop()) {
      shell.classList.remove('is-hidden');
      return;
    }
    shell.classList.add('is-hidden');
  };

  const update = (): void => {
    waiting = false;
    render();
  };

  const schedule = (): void => {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(update);
  };

  const onFocusIn = (): void => {
    heldFocus = document.activeElement;
    render();
  };

  const onFocusOut = (event: FocusEvent): void => {
    // 焦点还在导航内部（Tab 走到下一个控件）：锁继续有效
    const next = event.relatedTarget as Node | null;
    if (next && shell.contains(next)) return;
    heldFocus = null;
    render();
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  shell.addEventListener('focusin', onFocusIn);
  shell.addEventListener('focusout', onFocusOut);

  cleanup = () => {
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    shell.removeEventListener('focusin', onFocusIn);
    shell.removeEventListener('focusout', onFocusOut);
    shell.classList.remove('is-hidden');
  };

  // 进入页面先按当前位置定一次状态（浏览器可能带着滚动位置恢复页面）
  render();
}

onBeforeSwap(() => {
  cleanup?.();
  cleanup = null;
});

onPageLoad(initNav);
