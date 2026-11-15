/**
 * 导航隐现：只跟滚动位置走
 * ============================================================
 * 规则只有一条 —— **Banner 里那行大标题还在视口里，导航就露着；
 * 标题被滚出视口，导航收起。** 于是效果上就是「只在页面最上面才有导航栏」。
 *
 * 和旧版的区别：旧版还有一整路「鼠标召唤」输入（指针滑到标题上方就常驻、
 * 滑到下面就让位、贴到页面顶部就唤回、还要和悬浮目录互斥）。那套已经删掉了，
 * 现在不看指针，只看滚动。
 *
 * 唯一例外：键盘用户 Tab 进导航时强制显示。
 * 收起态只是 translateY + opacity，元素仍然可聚焦 —— 焦点进去了还藏着，
 * 等于让人对着空气敲键盘。
 *
 * 没有 Banner 的页面（工具页之类）退化成「贴近顶部才显示」。
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
   * 判据就是 Banner 大标题的下边缘：只要它还 > 0，说明标题还在屏幕里，
   * 用户还在看横幅，导航该陪着；滚过去之后就不必了。
   */
  const atTop = (): boolean => {
    const title = document.querySelector<HTMLElement>('[data-banner] .banner__title');
    if (!title) return window.scrollY < FALLBACK_THRESHOLD;
    const rect = title.getBoundingClientRect();
    // 高度为 0 说明标题所在的横幅被隐藏了，同样退回滚动距离判断
    if (rect.height <= 0) return window.scrollY < FALLBACK_THRESHOLD;
    return rect.bottom > 0;
  };

  /** 键盘送上来的焦点是不是还站在原地（还在导航里就锁住不收） */
  const focusHeld = (): boolean => heldFocus !== null && document.activeElement === heldFocus;

  const render = (): void => {
    shell.classList.toggle('is-hidden', !atTop() && !focusHeld());
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
