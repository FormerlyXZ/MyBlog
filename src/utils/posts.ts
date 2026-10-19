import { getCollection, type CollectionEntry } from 'astro:content';
import { yearMonthKey, yearMonthLabel } from './date';

export type Post = CollectionEntry<'posts'>;

/**
 * 取所有已发布文章，按日期从新到旧排序。
 * 置顶规则：frontmatter 里写了 `badge: Pin` 的文章排在最前面（多个置顶之间仍按日期排）。
 */
export async function getSortedPosts(): Promise<Post[]> {
  const posts = await getCollection('posts', ({ data }) => data.draft !== true);
  return posts.sort((a, b) => {
    const pinA = a.data.badge === 'Pin' ? 1 : 0;
    const pinB = b.data.badge === 'Pin' ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    return b.data.date.valueOf() - a.data.date.valueOf();
  });
}

/** 文章 URL：/posts/文件名/ */
export function postUrl(post: Post): string {
  return `/posts/${post.id}/`;
}

/** 估算阅读时长（中英混排），返回分钟数 */
export function readingTime(body: string | undefined): number {
  if (!body) return 1;
  const cjk = (body.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = body
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(cjk / 400 + words / 220));
}

export interface TagCount {
  tag: string;
  count: number;
}

/** 统计所有标签及其文章数 */
export async function getTags(): Promise<TagCount[]> {
  const posts = await getSortedPosts();
  const map = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      map.set(tag, (map.get(tag) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
}

/** 统计正文字数（中文按字、英文按词），用于「约 X 字」 */
export function wordCount(body: string | undefined): number {
  if (!body) return 0;
  const cjk = (body.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = body
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ') // 代码块不计入
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + words;
}

/** 统计所有分类及其文章数（按数量降序） */
export async function getCategories(): Promise<TagCount[]> {
  const posts = await getSortedPosts();
  const map = new Map<string, number>();
  for (const post of posts) {
    for (const category of post.data.categories ?? []) {
      map.set(category, (map.get(category) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([category, count]) => ({ tag: category, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
}

export interface ArchiveGroup {
  /** 2026-10 */
  key: string;
  /** 2026年10月 */
  label: string;
  posts: Post[];
}

/** 按「年-月」分组，用于归档页 */
export async function getArchiveGroups(): Promise<ArchiveGroup[]> {
  const posts = await getSortedPosts();
  const map = new Map<string, Post[]>();
  for (const post of posts) {
    const key = yearMonthKey(post.data.date);
    const list = map.get(key);
    if (list) list.push(post);
    else map.set(key, [post]);
  }
  return [...map.entries()].map(([key, list]) => ({
    key,
    label: yearMonthLabel(list[0]!.data.date),
    posts: list,
  }));
}

/** 按分类取文章（用于 /categories/[category]/） */
export async function getPostsByCategory(category: string): Promise<Post[]> {
  const posts = await getSortedPosts();
  return posts.filter((post) => (post.data.categories ?? []).includes(category));
}

