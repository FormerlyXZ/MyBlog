/**
 * 目录树（纯数据，不碰 DOM）
 * ============================================================
 * Astro 的 render() 已经把标题解析好了，这里只负责把「一串平铺的标题」
 * 变成「一棵可以折叠的树」：
 *
 *   文章标题（根，不在这个文件里）
 *     一、重点            ← level 1
 *       1、首页           ← level 2
 *       2、音乐播放器      ← level 2
 *     二、用到的 AI 模型   ← level 1
 *
 * 做法：维护一个栈。新标题比栈顶浅就弹栈，比栈顶深就挂到栈顶下面。
 * 于是 h1→h3 跳级、h2→h4→h2 来回跳都不会挂错爹 —— **新文章怎么写都能认出来**。
 *
 * 两个概念别混：
 *   depth = markdown 里的标题级别（h2 → 2，h6 → 6）
 *   level = 它在目录树里的第几层（1 = 直接挂在标题下面）
 * 圆点大小按 level 走，所以只写 h2/h3 的文章和写了 h1~h4 的文章，
 * 视觉层级都是一致的。
 *
 * 跳级会被自动补齐：正文写 h1 → h3，h3 依然是 level 2，和写 h1 → h2
 * 看起来完全一样。展示上限（maxLevel）同样按 level 算，而不是按
 * markdown 的 depth —— 这样「只显示 2 级」对 h1/h3 和 h1/h2 都成立。
 *
 * 文章标题 / 文件名是目录树的第 0 级（根节点，不在这个文件里，也不占上限）。
 * ============================================================
 */

export interface TocHeading {
  depth: number;
  slug: string;
  text: string;
}

export interface TocNode {
  /** markdown 标题级别（h2 = 2） */
  depth: number;
  /** 树里的层级：1 = 直接挂在文章标题下 */
  level: number;
  slug: string;
  text: string;
  children: TocNode[];
}

/** 正文里 h1~h6 全都收：新文章不管用哪几级，目录都能自动认出来 */
export const TOC_MIN_DEPTH = 1;
export const TOC_MAX_DEPTH = 6;
/** 目录树最多能显示到第几层（根节点「文章名」是第 0 级，不占这个数） */
export const TOC_MAX_LEVEL = 6;

/**
 * 把平铺标题列表整理成树。
 * 保序：先序（父在前、子在后的文档顺序），脚本靠这个顺序算轨迹。
 *
 * @param minDepth 只收 markdown 级别 >= 这个值的标题（默认 h1 起）
 * @param maxLevel 只保留目录树里前几层（按 level，不按 markdown depth）
 */
export function buildTocTree(
  headings: TocHeading[],
  minDepth: number = TOC_MIN_DEPTH,
  maxLevel: number = TOC_MAX_LEVEL,
): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];

  for (const heading of headings) {
    if (heading.depth < minDepth || heading.depth > TOC_MAX_DEPTH) continue;

    // 同级或更深的旧标题都不是它的爹，弹掉
    while (stack.length && stack[stack.length - 1]!.depth >= heading.depth) stack.pop();

    const node: TocNode = {
      depth: heading.depth,
      // 跳级时栈的高度就是补齐后的层级：h1 → h3 依然落在第 2 层
      level: stack.length + 1,
      slug: heading.slug,
      text: heading.text,
      children: [],
    };

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);

    stack.push(node);
  }

  const limit = Number.isFinite(maxLevel)
    ? Math.min(TOC_MAX_LEVEL, Math.max(1, Math.floor(maxLevel)))
    : TOC_MAX_LEVEL;

  return limit >= TOC_MAX_LEVEL ? roots : pruneTocLevels(roots, limit);
}

/** 按「目录树层级」裁掉更深的节点；level 在建树时已经补齐，所以裁的是展示层 */
function pruneTocLevels(nodes: TocNode[], maxLevel: number): TocNode[] {
  const kept: TocNode[] = [];
  for (const node of nodes) {
    if (node.level > maxLevel) continue;
    kept.push({ ...node, children: pruneTocLevels(node.children, maxLevel) });
  }
  return kept;
}

/** 树里一共多少个节点（不算根标题），用于「N 节」这类小字 */
export function countTocNodes(nodes: TocNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countTocNodes(node.children);
  return total;
}
