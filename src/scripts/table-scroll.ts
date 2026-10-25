/**
 * 正文表格：包一层外框 + 溢出提示
 * ============================================================
 * 起因：`<table>` 自己没法做「圆角 + 边框 + 横向滚动 + 阴影」这一套
 *      （`overflow` 对表格根元素不生效，`border-radius` 也会被相邻单元格的
 *      边框盖掉），所以运行时在外面套一层 `.md-table` 当纸片：
 *
 *   <div class="md-table is-scrollable at-start">   ← 圆角 / 边框 / 阴影 / 滚动
 *     <table>…</table>                             ← 表格本体，宽度撑满
 *   </div>
 *
 * 三个状态类：
 *   .is-scrollable  内容确实超出去了（此时才允许键盘聚焦 + 右侧渐隐）
 *   .at-start       已经滚到最左（左端不渐隐）
 *   .at-end         已经滚到最右（右端不渐隐）
 *
 * 和 code-fold 一样，脚本没跑起来时就是一张普通表格 ——
 * table.css 里另有一份「裸表格」兜底样式，不会难看。
 */
import { onBeforeSwap, onPageLoad } from './pageload';

/** 当前页面上所有表格外框（换页时清空） */
const frames = new Set<HTMLElement>();

let resizeTimer = 0;
let globalBound = false;
let observer: ResizeObserver | null = null;

/* -------------------------------------------------------------------
 * 状态
 * ------------------------------------------------------------------- */

function sync(root: HTMLElement): void {
  if (!root.isConnected) {
    observer?.unobserve(root);
    frames.delete(root);
    return;
  }

  const overflow = root.scrollWidth - root.clientWidth;
  const scrollable = overflow > 2;

  root.classList.toggle('is-scrollable', scrollable);

  if (!scrollable) {
    root.classList.remove('at-start', 'at-end');
    return;
  }

  // 容器可滚动就得能被键盘聚焦，否则键盘用户永远滚不到右边的列
  if (!root.hasAttribute('tabindex')) {
    root.tabIndex = 0;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', '表格（可横向滚动）');
  }

  root.classList.toggle('at-start', root.scrollLeft <= 1);
  root.classList.toggle('at-end', root.scrollLeft >= overflow - 1);
}

/* -------------------------------------------------------------------
 * 生成结构
 * ------------------------------------------------------------------- */

function wrap(table: HTMLTableElement): HTMLElement {
  const parent = table.parentElement!;

  const root = document.createElement('div');
  root.className = 'md-table';

  // 先把外框放到表格原来的位置，再把表格搬进去 —— 顺序不能反
  parent.insertBefore(root, table);
  root.append(table);

  root.addEventListener('scroll', () => sync(root), { passive: true });

  return root;
}

/* -------------------------------------------------------------------
 * 生命周期
 * ------------------------------------------------------------------- */

/**
 * 给一批表格套上外框。scope 默认整页；
 * 写作页预览那边会传进来一个局部容器（每次预览重渲染都要重新套）。
 */
export function initTables(scope: ParentNode = document): void {
  bindGlobal();

  const tables = [...scope.querySelectorAll<HTMLTableElement>('table')].filter(
    (table) => table.closest('.prose-blog') && !table.closest('.md-table'),
  );

  for (const table of tables) {
    const root = wrap(table);
    frames.add(root);
    observer?.observe(root);
    sync(root);
  }
}

/**
 * 尺寸/排版变了要重新判断溢出。
 * 用 ResizeObserver 盯住每个外框自己：窗口缩放、侧栏收起、字体加载、
 * 主题切换导致的列宽变化都会走到这里，比只听 window.resize 靠谱得多。
 */
function bindGlobal(): void {
  if (globalBound) return;
  globalBound = true;

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) sync(entry.target as HTMLElement);
    });
  }

  // 兜底：ResizeObserver 没跑起来（老浏览器）时还能靠 resize 兜一下
  window.addEventListener(
    'resize',
    () => {
      if (!frames.size) return;
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => each(sync), 160);
    },
    { passive: true },
  );

  // 字体加载完列宽会变，重量一次
  document.fonts?.ready.then(() => each(sync));
}

function each(fn: (root: HTMLElement) => void): void {
  for (const root of frames) {
    if (!root.isConnected) {
      observer?.unobserve(root);
      frames.delete(root);
      continue;
    }
    fn(root);
  }
}

function teardown(): void {
  each((root) => observer?.unobserve(root));
  frames.clear();
  clearTimeout(resizeTimer);
  resizeTimer = 0;
}

onBeforeSwap(teardown);

onPageLoad(() => {
  teardown();
  initTables();
});
