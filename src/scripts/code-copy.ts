/**
 * 代码块复制按钮
 * ============================================================
 * 文章里的代码块右上角挂一个小圆钮，点一下把整段代码复制走。
 * 复制成功不是弹 toast，而是按钮自己「变形」：
 *
 *   复制图标 ──淡出+缩一下──▶ 对勾（浅色）
 *   透明底 ──渐变成──▶ 主题的深色填充（oklch(var(--n))，勾用 --nc）
 *   同时一圈光环往外散开，1.8 秒后整套动画自己退回去
 *
 * 几个刻意的选择：
 *
 * ① 成功态里按钮仍然是「活的」：勾还亮着的时候再点一下就是又复制一次
 *    （动画重放、计时重来），不会出现「点了一下没反应」的空窗期。
 *
 * ② 颜色全部走 daisyUI 语义变量：深色填充 = --n，勾 = --nc，
 *    明暗主题 / 换配色时自动配对，永远是一深一浅、有对比。
 *
 * ③ 按钮挂在 .code-fold 外壳上（代码块折叠那层），不是塞进 <pre> 里面：
 *    <pre> 有 overflow-x，绝对定位的子元素会跟着代码横向滚走。
 *    写作页预览这种没经过折叠的代码块，这里自己补一层 .code-copy-shell。
 *
 * ④ 结构在运行时生成：脚本没跑起来 = 普通代码块，正文照常可读。
 */
import { onBeforeSwap, onPageLoad } from './pageload';
import { showToast } from '../utils/site';
import { copyText } from '../utils/clipboard';

/** 成功态停留多久（毫秒） */
const COPIED_MS = 1800;

const COPY_GLYPH =
  '<svg class="code-copy__glyph code-copy__glyph--copy" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.6" />' +
  '<path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></svg>';

const CHECK_GLYPH =
  '<svg class="code-copy__glyph code-copy__glyph--check" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><path d="M5 12.6l4.4 4.4L19 7.4" /></svg>';

/** 每个按钮的「恢复原状」计时器 */
const timers = new WeakMap<HTMLButtonElement, number>();

/* -------------------------------------------------------------------
 * 结构
 * ------------------------------------------------------------------- */

/** 代码正文（shiki 每行一个 span，textContent 就是原样的多行文本） */
function codeText(pre: HTMLElement): string {
  const code = pre.querySelector('code');
  const raw = (code ?? pre).textContent ?? '';
  return raw.replace(/\n+$/, '');
}

/**
 * 按钮的定位宿主：
 *   · 正常情况 = 外面那层 .code-fold（折叠脚本一定会套上它）
 *   · 万一没有 = 现包一层 .code-copy-shell 兜底
 */
function ensureHost(pre: HTMLElement): HTMLElement | null {
  const fold = pre.closest<HTMLElement>('.code-fold');
  if (fold) return fold;

  const parent = pre.parentElement;
  if (!parent) return null;

  const shell = document.createElement('div');
  shell.className = 'code-copy-shell';
  parent.insertBefore(shell, pre);
  shell.append(pre);
  return shell;
}

/** 生成按钮并挂到宿主右上角 */
function attach(pre: HTMLElement): HTMLButtonElement | null {
  // 同一块代码只挂一次（写作页预览会反复重渲染，靠 pre 上的标记去重）
  if (pre.dataset.codeCopy === '1') return null;
  const host = ensureHost(pre);
  if (!host) return null;
  pre.dataset.codeCopy = '1';

  const text = codeText(pre);
  if (!text) return null;

  const lines = text.split('\n').length;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-copy';
  button.dataset.codeCopyButton = '';
  button.title = '复制代码';
  button.setAttribute('aria-label', `复制代码（共 ${lines} 行）`);
  button.innerHTML =
    '<span class="code-copy__ring" aria-hidden="true"></span>' +
    `<span class="code-copy__icons">${COPY_GLYPH}${CHECK_GLYPH}</span>` +
    '<span class="code-copy__status sr-only" role="status"></span>';

  button.addEventListener('click', () => {
    void run(button, pre, lines);
  });

  host.classList.add('code-copy-host');
  host.append(button);
  return button;
}

/* -------------------------------------------------------------------
 * 交互
 * ------------------------------------------------------------------- */

/** 换文案（对读屏用户来说，这就是「复制成功」的提示） */
function label(button: HTMLButtonElement, done: boolean, lines: number): void {
  button.setAttribute('aria-label', done ? '已复制，点一下可再次复制' : `复制代码（共 ${lines} 行）`);
  const status = button.querySelector<HTMLElement>('.code-copy__status');
  if (status) status.textContent = done ? '已复制' : '';
}

/** 播一遍成功动画（已经在成功态时重放，不打断再点一次的手感） */
function celebrate(button: HTMLButtonElement, lines: number): void {
  button.classList.add('is-done');
  label(button, true, lines);

  // 光环：先摘掉再挂回去，强制重置动画时间轴
  button.classList.remove('is-ring');
  void button.offsetWidth;
  button.classList.add('is-ring');

  const pending = timers.get(button);
  if (pending) window.clearTimeout(pending);
  timers.set(
    button,
    window.setTimeout(() => {
      timers.delete(button);
      button.classList.remove('is-done', 'is-ring');
      label(button, false, lines);
    }, COPIED_MS),
  );
}

async function run(button: HTMLButtonElement, pre: HTMLElement, lines: number): Promise<void> {
  const text = codeText(pre);
  if (!text.trim()) {
    showToast('这段代码是空的，没什么可复制');
    return;
  }

  const ok = await copyText(text);
  if (!ok) {
    showToast('复制失败，请手动选中代码再复制');
    return;
  }

  celebrate(button, lines);
}

/* -------------------------------------------------------------------
 * 生命周期
 * ------------------------------------------------------------------- */

/**
 * 给一批代码块挂上复制按钮。
 * scope 默认整页；写作页预览会传进来一个局部容器（每次预览重渲染都要重新挂）。
 */
export function initCodeCopy(scope: ParentNode = document): void {
  const pres = [...scope.querySelectorAll<HTMLElement>('pre')].filter(
    (pre) => pre.closest('.prose-blog') || pre.classList.contains('md-code'),
  );

  for (const pre of pres) attach(pre);
}

onBeforeSwap(() => {
  // 按钮随 DOM 一起被换掉，这里只需把还挂着的计时器放掉
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-code-copy-button]')) {
    const pending = timers.get(button);
    if (pending) window.clearTimeout(pending);
    timers.delete(button);
  }
});

onPageLoad(() => initCodeCopy());
