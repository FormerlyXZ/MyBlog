/**
 * 目录滚动高亮
 * ============================================================
 * 做法：监听滚动，取「最后一个已经滚过判定线的标题」作为当前小节，
 * 给所有同 slug 的目录链接加 aria-current + 主色。
 *
 * 为什么不用 IntersectionObserver：
 *   带 rootMargin 的观察器在页面顶部一个标题都没进入判定区时
 *   会「谁都不选中」，目录看上去像坏了。用滚动位置判定，
 *   页面一打开就稳定高亮第一节。
 *
 * 细节：
 *   · 判定线 = 视口顶部往下 140px（让高亮的切换略早于标题贴顶）
 *   · requestAnimationFrame 节流
 *   · 点目录链接平滑滚动，并立刻把高亮切到目标
 */

import { onPageLoad, onBeforeSwap } from './pageload';

const ACTIVE_CLASSES = ['!text-primary', '!border-primary', 'font-medium'];
const OFFSET = 140;

type Cleanup = () => void;
let cleanup: Cleanup | null = null;

function setActive(slug: string | null): void {
  for (const link of document.querySelectorAll<HTMLElement>('[data-toc-link]')) {
    const on = slug !== null && link.dataset.tocLink === slug;
    for (const cls of ACTIVE_CLASSES) link.classList.toggle(cls, on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function initToc(): void {
  cleanup?.();
  cleanup = null;

  const headings = [...document.querySelectorAll<HTMLElement>('.prose-blog h2[id], .prose-blog h3[id]')];
  const links = document.querySelectorAll('[data-toc-link]');
  if (!headings.length || !links.length) return;

  let ticking = false;

  const update = () => {
    const line = window.scrollY + OFFSET;
    let current = headings[0]?.id ?? null;

    for (const heading of headings) {
      // offsetTop 相对最近的定位祖先，这里正文没有定位祖先，直接可用
      if (heading.getBoundingClientRect().top + window.scrollY <= line) current = heading.id;
      else break;
    }

    setActive(current);
    ticking = false;
  };

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  update();

  // 点击目录：平滑滚动 + 立刻高亮
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-toc-link]')) {
    if (link.dataset.bound === '1') continue;
    link.dataset.bound = '1';
    link.addEventListener('click', (event) => {
      const slug = link.dataset.tocLink;
      if (!slug) return;
      const target = document.getElementById(slug);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(slug);
      history.replaceState(null, '', `#${slug}`);
    });
  }

  cleanup = () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };
}

onBeforeSwap(() => {
  cleanup?.();
  cleanup = null;
});

onPageLoad(initToc);
