/**
 * Banner：背景轮播 + 打字机
 * ============================================================
 * 参数从 Banner.astro 的 data-* 属性来（最终源头是 config/site.json）：
 *   data-images   JSON 数组，背景图列表
 *   data-interval 轮播间隔（毫秒，默认 8000）
 *   data-typewriter JSON 数组，打字机句子（没有就不打）
 *
 * 三个「不折腾用户」的细节：
 *   · 系统设置了「减少动态效果」→ 完全不动（不轮播、不打字）
 *   · 滚出屏幕 → 暂停轮播（IntersectionObserver）
 *   · 切到后台标签页 → 暂停（visibilitychange）
 * ============================================================
 */

import { onPageLoad, onBeforeSwap } from './pageload';

const FADE = 600; // 交叉淡入时长，与 tokens.css 的 --banner-fade 对应

type Cleanup = () => void;
const cleanups: Cleanup[] = [];

const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function preload(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`图片加载失败：${src}`));
    img.src = src;
  });
}

/* ---------------- 背景轮播 ---------------- */

/**
 * 首屏起始图的下标。
 * BaseLayout 的 <head> 里已经在第一次绘制前掷过骰子并写了 --banner-start，
 * 这里把它取回来，让轮播从同一张图接着往下走（否则首图是随机的、第二张却是 2 号图）。
 */
function startingIndex(count: number): number {
  const picked = (window as { __bannerStartIndex?: number }).__bannerStartIndex;
  return typeof picked === 'number' && Number.isInteger(picked) && picked >= 0 && picked < count
    ? picked
    : 0;
}

function initRotation(root: HTMLElement): void {
  const layers = [...root.querySelectorAll<HTMLElement>('[data-banner-layer]')];
  let images: string[] = [];
  try {
    images = JSON.parse(root.dataset.images || '[]');
  } catch {
    images = [];
  }

  if (layers.length < 2 || images.length < 2) return;

  const startIndex = startingIndex(images.length);

  // 首帧的随机图本来由 CSS 变量 --banner-start 决定；
  // ClientRouter 换页会把 <html style> 一起换掉，这里补写一次，
  // 免得换页后第一帧又回到 1 号图。
  if (startIndex > 0) {
    const url = `url("${images[startIndex]}")`;
    layers[0]!.style.backgroundImage = url;
    document.documentElement.style.setProperty('--banner-start', url);
  }

  if (reducedMotion()) return;

  const interval = Number(root.dataset.interval) || 8000;
  let current = startIndex;
  let timer: number | undefined;
  let visible = true;

  // 两层交替：前层显示当前图，后层加载下一张后淡入
  const [layerA, layerB] = layers as [HTMLElement, HTMLElement];
  let front = layerA;
  let back = layerB;

  const start = () => {
    stop();
    timer = window.setInterval(tick, interval);
  };

  const stop = () => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  const tick = async () => {
    if (!visible || document.hidden) return;
    const nextIndex = (current + 1) % images.length;
    const src = images[nextIndex];
    if (!src) return;

    try {
      await preload(src);
    } catch {
      return; // 坏图跳过这一轮，不打断轮播
    }

    back.style.backgroundImage = `url("${src}")`;
    back.style.opacity = '1';
    front.style.opacity = '0';

    window.setTimeout(() => {
      // 淡入完成后把底层也换成同一张，再复位透明度，等待下一轮
      front.style.transition = 'none';
      front.style.backgroundImage = `url("${src}")`;
      front.style.opacity = '1';
      back.style.opacity = '0';
      // 强制重绘后再恢复 transition
      void front.offsetHeight;
      front.style.transition = '';
      [front, back] = [back, front];
    }, FADE);

    current = nextIndex;
  };

  // 滚出屏幕就暂停，省电省流
  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) start();
      else stop();
    },
    { threshold: 0 },
  );
  observer.observe(root);

  const onVisibility = () => {
    if (document.hidden) stop();
    else if (visible) start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // 首屏先把下一张预热，第一次切换就不会卡
  preload(images[(current + 1) % images.length] ?? '').catch(() => {});

  start();

  cleanups.push(() => {
    stop();
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
  });
}

/* ---------------- 打字机 ---------------- */

function initTypewriter(root: HTMLElement): void {
  const el = root.querySelector<HTMLElement>('[data-typewriter]');
  if (!el) return;

  let lines: string[] = [];
  try {
    lines = JSON.parse(el.dataset.typewriter || '[]');
  } catch {
    lines = [];
  }
  if (!lines.length) return;

  // 减少动态效果时只显示第一句，不逐字打
  if (reducedMotion()) {
    el.textContent = lines[0] ?? '';
    return;
  }

  const TYPE = 150;
  const ERASE = 50;
  const HOLD = 2500;

  let lineIndex = 0;
  let charIndex = 0;
  let erasing = false;
  let timer: number | undefined;
  let stopped = false;

  /**
   * 按「码点」切分而不是按 UTF-16 索引 —— 句子开头有 emoji
   * （📚🌸🌿 都是代理对，占两个 code unit），用 `line.slice(0, n)` 会在
   * 打字过程中切出半个字符，屏幕上闪一个「�」。Array.from 按码点切就不会。
   */
  const glyphsOf = (text: string) => Array.from(text);

  const step = () => {
    if (stopped) return;
    const glyphs = glyphsOf(lines[lineIndex] ?? '');

    if (!erasing) {
      charIndex++;
      el.textContent = glyphs.slice(0, charIndex).join('');
      if (charIndex >= glyphs.length) {
        erasing = true;
        timer = window.setTimeout(step, HOLD);
        return;
      }
      timer = window.setTimeout(step, TYPE);
    } else {
      charIndex--;
      el.textContent = glyphs.slice(0, Math.max(charIndex, 0)).join('');
      if (charIndex <= 0) {
        erasing = false;
        lineIndex = (lineIndex + 1) % lines.length;
        timer = window.setTimeout(step, TYPE);
        return;
      }
      timer = window.setTimeout(step, ERASE);
    }
  };

  el.classList.add('is-typing');
  timer = window.setTimeout(step, TYPE);

  cleanups.push(() => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
    el.classList.remove('is-typing');
  });
}

/* ---------------- 启动 ---------------- */

export function initBanners(): void {
  for (const root of document.querySelectorAll<HTMLElement>('[data-banner]')) {
    initRotation(root);
    initTypewriter(root);
  }
}

onBeforeSwap(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* 忽略 */
    }
  }
});

onPageLoad(initBanners);
