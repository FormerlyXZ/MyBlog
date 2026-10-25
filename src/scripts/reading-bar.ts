/**
 * 阅读进度胶囊（目录下面那一条）
 * ============================================================
 * 三件事：
 *   ① 滚动 → 胶囊底色从左往右长 + 百分比数字（rAF 节流，只写 transform）
 *   ② 分享 → 复制本页链接
 *   ③ 复制 → 复制全文（含 Markdown 原文，原文由文章页塞进 #post-md）
 *
 * 页面上可能同时存在两份（桌面侧栏目录、手机版目录卡），只有一份可见，
 * 这里统一驱动所有 instance，滚动时只算一次进度。
 *
 * 丝滑要点：滚动时**不做任何布局读取**（正文区间只在 resize / 内容高度变化后重算），
 * 每帧只写 transform 和（数字变化时的）textContent。
 */
import { onPageLoad, onBeforeSwap } from './pageload';
import { showToast } from '../utils/site';
import { copyText } from '../utils/clipboard';

type Cleanup = () => void;
let cleanup: Cleanup | null = null;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 短暂点亮按钮，给一个「成功了」的反馈 */
function flash(button: HTMLElement | null, ms = 1200): void {
  if (!button) return;
  button.classList.add('is-done');
  window.setTimeout(() => button.classList.remove('is-done'), ms);
}

/** 读出页面里内联的 Markdown 原文（文章页写进 #post-md 的 JSON） */
function readMarkdown(): string {
  const raw = document.getElementById('post-md')?.textContent ?? '';
  if (!raw) return '';
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

interface BarRef {
  fill: HTMLElement;
  value: HTMLElement;
  share: HTMLButtonElement | null;
  copy: HTMLButtonElement | null;
  pct: HTMLButtonElement | null;
  url: string;
}

function initReadingBar(): void {
  cleanup?.();
  cleanup = null;

  const refs: BarRef[] = [];
  for (const bar of document.querySelectorAll<HTMLElement>('[data-read-bar]')) {
    const fill = bar.querySelector<HTMLElement>('[data-read-fill]');
    const value = bar.querySelector<HTMLElement>('[data-read-pct-value]');
    if (!fill || !value) continue;
    refs.push({
      fill,
      value,
      share: bar.querySelector<HTMLButtonElement>('[data-read-share]'),
      copy: bar.querySelector<HTMLButtonElement>('[data-read-copy]'),
      pct: bar.querySelector<HTMLButtonElement>('[data-read-pct]'),
      url: bar.dataset.readUrl || location.href,
    });
  }
  if (!refs.length) return;

  const body = document.querySelector<HTMLElement>('.prose-blog');

  // ---------- 正文区间（不每帧读，避免强制重排） ----------
  let start = 0;
  let end = 1;
  let measured = false;

  const measureRange = (): void => {
    measured = true;
    if (!body) {
      start = 0;
      end = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      return;
    }
    const rect = body.getBoundingClientRect();
    start = rect.top + window.scrollY;
    // 「读完」= 正文底部快要碰到视口底部那会儿
    end = Math.max(start + 1, start + rect.height - window.innerHeight + 160);
  };

  // ---------- 进度 ----------
  let lastPct = -1;
  let ticking = false;

  const render = (): void => {
    ticking = false;
    if (!measured) measureRange();

    const p = clamp((window.scrollY - start) / Math.max(1, end - start), 0, 1);
    const scale = p.toFixed(4);
    for (const ref of refs) ref.fill.style.transform = `scaleX(${scale})`;

    const pct = Math.round(p * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      const text = String(pct);
      for (const ref of refs) ref.value.textContent = text;
    }
  };

  const onScroll = (): void => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(render);
  };

  const onResize = (): void => {
    measured = false;
    onScroll();
  };

  // ---------- 事件 ----------
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

  bind(window, 'scroll', onScroll as EventListener, { passive: true });
  bind(window, 'resize', onResize as EventListener, { passive: true });

  // 图片 / 字体加载完之后正文高度会变，重新量一次
  if (typeof ResizeObserver !== 'undefined' && body) {
    const observer = new ResizeObserver(() => {
      measured = false;
      onScroll();
    });
    observer.observe(body);
    listeners.push(() => observer.disconnect());
  }

  const onShare = async (url: string, button: HTMLButtonElement | null): Promise<void> => {
    const ok = await copyText(url);
    if (ok) {
      showToast('链接已复制，可以分享给朋友了');
      flash(button);
    } else {
      showToast('复制失败，请手动复制地址栏链接');
    }
  };

  const onCopy = async (button: HTMLButtonElement | null): Promise<void> => {
    const markdown = readMarkdown();
    if (!markdown) {
      showToast('没有拿到原文，试试用浏览器自带的复制');
      return;
    }
    const ok = await copyText(markdown);
    if (ok) {
      showToast('已复制全文（Markdown）');
      flash(button);
    } else {
      showToast('复制失败，请手动选中正文复制');
    }
  };

  for (const ref of refs) {
    if (ref.share) {
      bind(ref.share, 'click', () => {
        void onShare(ref.url, ref.share);
      });
    }
    if (ref.copy) {
      bind(ref.copy, 'click', () => {
        void onCopy(ref.copy);
      });
    }
    if (ref.pct) {
      bind(ref.pct, 'click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  render();

  cleanup = () => {
    for (const off of listeners.splice(0)) off();
  };
}

onBeforeSwap(() => {
  cleanup?.();
  cleanup = null;
});

onPageLoad(initReadingBar);
