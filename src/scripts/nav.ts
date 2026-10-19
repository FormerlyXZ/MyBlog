/**
 * 导航滚动隐现
 * ============================================================
 * 规则（与参考站一致）：
 *   · 向下滚动且累计位移 > 80px → 收起
 *   · 一开始向上滚 → 立刻恢复
 *   · 位移 < 5px 的抖动直接忽略（移动端回弹、触摸板微动不触发）
 *   · requestAnimationFrame 节流，不阻塞滚动
 * ============================================================
 */

import { onPageLoad, onBeforeSwap } from './pageload';

const THRESHOLD = 80;
const MIN_DELTA = 5;

let cleanupScroll: (() => void) | null = null;

export function initNav(): void {
  // 上一轮的监听先拆掉（换页后会重新初始化）
  cleanupScroll?.();
  cleanupScroll = null;

  const shell = document.querySelector<HTMLElement>('[data-nav-shell]');
  if (!shell) return;

  let lastY = window.scrollY;
  let ticking = false;

  const update = () => {
    const y = window.scrollY;

    if (Math.abs(y - lastY) >= MIN_DELTA) {
      const goingDown = y > lastY && y > THRESHOLD;
      shell.classList.toggle('is-hidden', goingDown);
      lastY = y;
    }

    ticking = false;
  };

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };

  window.addEventListener('scroll', onScroll, { passive: true });

  cleanupScroll = () => {
    window.removeEventListener('scroll', onScroll);
    shell.classList.remove('is-hidden');
  };
}

onBeforeSwap(() => {
  cleanupScroll?.();
  cleanupScroll = null;
});

onPageLoad(initNav);
