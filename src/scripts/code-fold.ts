/**
 * 代码块折叠（过长的代码只露一截，其余「展开全部」）
 * ============================================================
 * 站里的代码块动辄几十上百行（STM32 那几章最长的一块 256 行、近 6000px），
 * 全铺开会把正文切成两半，读的人得一路滚到底才能看到下面的说明。
 *
 * 这里在**运行时**给过长的代码块加一层折叠：不改 Markdown 渲染管线、
 * 不动 shiki 配置，也没有 JS 依赖 —— 脚本没跑起来时就是普通代码块。
 *
 *   <div class="code-fold is-foldable">          ← 包裹层
 *     <div class="code-fold__body">              ← 限高 + 裁切（高度由脚本写）
 *       <pre class="astro-code">…</pre>
 *       <span class="code-fold__fade"></span>     ← 底部渐隐，压住被切断的半行
 *     </div>
 *     <button class="code-fold__btn">展开全部 · 256 行</button>
 *   </div>
 *
 * 两个关键决定：
 *
 * ① 判断标准用**渲染后的高度**，不用行数
 *    astro.config 里 shiki 开了 wrap，一行超长代码会折成好几行，
 *    行数少不代表占的地方少 —— 高度才是「挤不挤」的真正指标。
 *    行数只写在按钮上，让人知道展开后有多少东西。
 *
 * ② 高度一路写 inline max-height，不靠 class 切
 *    折叠 = 固定 FOLD_PX；展开 = 量出来的真实高度。
 *    窗口变窄（代码重新折行）时重量一次就够，退出展开态也不用记状态。
 *
 * ③ 收起时把页面「回正」
 *    展开后按钮在很下面，人滚过去点「收起」时块顶早就出屏了；
 *    高度一收，视口里剩下的是后面的内容，看着像跳页。
 *    所以展开时记一次 scrollY，收起时如果块顶已经不在视口里就滚回去。
 */
import { onBeforeSwap, onPageLoad } from './pageload';

/** 折叠后露出多高（px）；行高 22.4px 时约 14 行 */
const FOLD_PX = 340;
/** 至少还能再藏这么多才有折的必要（否则按钮省不了地方，反而碍事） */
const MIN_HIDDEN = 100;

/** 折一下的小箭头（展开后翻上去） */
const ICON =
  '<svg class="code-fold__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 9l6 6 6-6"/></svg>';

interface Fold {
  root: HTMLElement;
  body: HTMLElement;
  pre: HTMLElement;
  fade: HTMLElement;
  btn: HTMLButtonElement;
  label: HTMLElement;
  /** 代码块一共多少行（只用来写按钮上的小字） */
  lines: number;
  /** 用户手动展开过 —— 窗口变化时保持展开 */
  expanded: boolean;
  /** 展开那一刻的页面滚动位置（收起时用它「回正」，见 restoreAnchor） */
  anchorScroll: number;
}

/** 当前页面上所有折叠块（换页时清空） */
const folds = new Set<Fold>();

let uid = 0;
let resizeTimer = 0;
let globalBound = false;

/* -------------------------------------------------------------------
 * 尺寸与状态
 * ------------------------------------------------------------------- */

/** 行数：shiki 每行一个 <span class="line">，没高亮时退回数换行 */
function countLines(pre: HTMLElement): number {
  const spans = pre.querySelectorAll('.line').length;
  if (spans) return spans;
  const text = (pre.textContent ?? '').replace(/\n+$/, '');
  return text ? text.split('\n').length : 0;
}

/**
 * 底部渐隐的颜色 = 代码块自己的底色。
 * shiki 把底色写成 --shiki-light-bg / --shiki-dark-bg（#fff / #24292e），
 * 明暗切换会换一套 —— 所以这里直接量，并在切主题时重新量。
 */
function syncFade(fold: Fold): void {
  const bg = getComputedStyle(fold.pre).backgroundColor;
  if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return;
  fold.fade.style.setProperty('--code-fold-bg', bg);
}

/** 按当前排版重新判断「要不要折」，并把高度写到 inline 上 */
function refresh(fold: Fold): void {
  const { root, body, btn } = fold;
  const full = body.scrollHeight;
  if (!full) return; // 还没排版出来（例如藏在收起的面板里）

  const foldable = full - FOLD_PX >= MIN_HIDDEN;

  root.classList.toggle('is-foldable', foldable);
  btn.hidden = !foldable;

  if (!foldable) {
    root.classList.remove('is-expanded');
    fold.expanded = false;
    body.style.maxHeight = '';
    syncButton(fold);
    return;
  }

  body.style.maxHeight = fold.expanded ? `${full}px` : `${FOLD_PX}px`;
  root.classList.toggle('is-expanded', fold.expanded);
  syncButton(fold);
}

/** 按钮上的文字 / 语义 */
function syncButton(fold: Fold): void {
  const open = fold.expanded;
  fold.label.textContent = open ? '收起' : '展开全部';
  fold.btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  fold.btn.setAttribute(
    'aria-label',
    open
      ? `收起代码块（共 ${fold.lines} 行）`
      : `展开全部代码（共 ${fold.lines} 行）`,
  );
}

/** 展开 / 收起 */
function toggle(fold: Fold): void {
  const expanding = !fold.expanded;

  // 展开之前记下当前位置 —— 收起时要还回这里（见 restoreAnchor）
  if (expanding) fold.anchorScroll = window.scrollY;

  fold.expanded = expanding;
  refresh(fold);
  syncFade(fold);

  if (!expanding) restoreAnchor(fold);
}

/**
 * 收起时的「回正」
 * ------------------------------------------------------------
 * 折叠只改 max-height，浏览器不会动 scrollY：上面的高度一收，
 * 视口里剩下的就是「原本在很下面」的内容 —— 读的人会觉得一下子跳到了后面，
 * 明明只想把这段代码收起来。
 *
 * 所以：只有当代码块顶部已经滚出视口（块顶和「收起」按钮不在同一屏）时，
 * 才把滚动位置还回展开之前那一下；块顶还在屏幕里就什么都不做 ——
 * 那时折叠只是把下面内容往上提，视线是连着的。
 */
function restoreAnchor(fold: Fold): void {
  if (fold.root.getBoundingClientRect().top >= 0) return;
  jumpTo(Math.max(0, fold.anchorScroll));
}

/**
 * 立刻跳到某个位置。
 * 站里 html 开了 scroll-behavior: smooth（锚点跳转要用），
 * 这里必须临时压掉它，否则会一边收一边滑，反而更晕。
 */
function jumpTo(top: number): void {
  const root = document.documentElement;
  const prev = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  void root.offsetHeight; // 逼浏览器先认下这个 inline 值，再滚
  window.scrollTo(0, top);
  root.style.scrollBehavior = prev;
}

/* -------------------------------------------------------------------
 * 生成结构
 * ------------------------------------------------------------------- */

function wrap(pre: HTMLElement): Fold | null {
  const parent = pre.parentElement;
  if (!parent) return null;

  const root = document.createElement('div');
  root.className = 'code-fold';
  root.dataset.codeFold = '';

  const body = document.createElement('div');
  body.className = 'code-fold__body';
  body.id = `code-fold-${(uid += 1)}`;

  const fade = document.createElement('span');
  fade.className = 'code-fold__fade';
  fade.setAttribute('aria-hidden', 'true');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-fold__btn';
  btn.setAttribute('aria-controls', body.id);
  btn.setAttribute('aria-expanded', 'false');
  btn.hidden = true;
  btn.innerHTML = `<span class="code-fold__label">展开全部</span><span class="code-fold__count"></span>${ICON}`;

  // 先把包裹层放到 <pre> 原来的位置，再把 pre 搬进 body —— 顺序不能反
  parent.insertBefore(root, pre);
  body.append(pre, fade);
  root.append(body, btn);

  const fold: Fold = {
    root,
    body,
    pre,
    fade,
    btn,
    label: btn.querySelector<HTMLElement>('.code-fold__label')!,
    lines: countLines(pre),
    expanded: false,
    anchorScroll: 0,
  };

  btn.querySelector<HTMLElement>('.code-fold__count')!.textContent = fold.lines
    ? `${fold.lines} 行`
    : '';

  btn.addEventListener('click', () => toggle(fold));

  return fold;
}

/* -------------------------------------------------------------------
 * 生命周期
 * ------------------------------------------------------------------- */

/**
 * 给一批代码块套上折叠。
 * root 默认整页；写作页预览那边会传进来一个局部容器（每次预览重渲染都要重新套）。
 */
export function initCodeFolds(scope: ParentNode = document): void {
  bindGlobal();

  const pres = [...scope.querySelectorAll<HTMLElement>('pre')].filter(
    (pre) => pre.closest('.prose-blog') && !pre.closest('.code-fold'),
  );

  for (const pre of pres) {
    const fold = wrap(pre);
    if (!fold) continue;
    folds.add(fold);

    refresh(fold);
    syncFade(fold);

    // 第一帧先别上过渡：否则页面一打开，代码块会「唰」地折一下
    requestAnimationFrame(() => fold.root.classList.add('is-ready'));
  }
}

/** 窗口尺寸 / 主题变了 */
function bindGlobal(): void {
  if (globalBound) return;
  globalBound = true;

  window.addEventListener(
    'resize',
    () => {
      if (!folds.size) return;
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => each(refresh), 160);
    },
    { passive: true },
  );

  // 切主题会换代码底色，渐隐要跟着换
  document.addEventListener('melodyxz:theme', () => each(syncFade));

  // 字体加载完行高会变，重量一次
  document.fonts?.ready.then(() => each(refresh));
}

/**
 * 手动重量一次。
 * 写作页预览先出「纯文本」，语法高亮异步替换内容后行高/折行会变，
 * 那边换完会调用它（不然折叠的可见高度还是按旧内容算的）。
 */
export function refreshCodeFolds(): void {
  each(refresh);
  each(syncFade);
}

/** 遍历还挂在文档上的折叠块（写作页预览每次重渲染都会换掉一批旧节点） */
function each(fn: (fold: Fold) => void): void {
  for (const fold of folds) {
    if (!fold.root.isConnected) {
      folds.delete(fold);
      continue;
    }
    fn(fold);
  }
}

function teardown(): void {
  folds.clear();
  clearTimeout(resizeTimer);
  resizeTimer = 0;
}

onBeforeSwap(teardown);

onPageLoad(() => {
  teardown();
  initCodeFolds();
});
