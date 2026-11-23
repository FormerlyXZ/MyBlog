/**
 * 文章底部的上 / 下篇跳转目标。
 *
 * 不直接传 Post，是因为系列的第一章、最后一章、导读页都需要补一个
 * 「出口」：上一章可能是导读，下一章可能是别的文章，甚至归档页。
 * 统一成这个轻量结构，组件只管画卡片，不再判断系列逻辑。
 */
export type NavKind = 'post' | 'chapter' | 'guide' | 'archive';

export interface NavLink {
  href: string;
  title: string;
  /** 卡片右上角的短标签：上一篇 / 下一章 / 系列导读 / 文章归档 */
  label: string;
  /** 标题下面那行小字：日期、第 N 章 · 共 M 章 等 */
  meta: string;
  kind: NavKind;
}
