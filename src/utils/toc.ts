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

/**
 * 把平铺标题列表整理成树。
 * 保序：先序（父在前、子在后的文档顺序），脚本靠这个顺序算轨迹。
 */
export function buildTocTree(
  headings: TocHeading[],
  minDepth: number = TOC_MIN_DEPTH,
  maxDepth: number = TOC_MAX_DEPTH,
): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];

  for (const heading of headings) {
    if (heading.depth < minDepth || heading.depth > maxDepth) continue;

    // 同级或更深的旧标题都不是它的爹，弹掉
    while (stack.length && stack[stack.length - 1]!.depth >= heading.depth) stack.pop();

    const node: TocNode = {
      depth: heading.depth,
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

  return roots;
}

/** 树里一共多少个节点（不算根标题），用于「N 节」这类小字 */
export function countTocNodes(nodes: TocNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countTocNodes(node.children);
  return total;
}
