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

/** 文章 URL：/posts/文件名/；系列目录页（xx/index.md）是 /posts/xx/ */
export function postUrl(post: Post): string {
  return `/posts/${postSlug(post)}/`;
}

/**
 * 路由用的 slug：默认就是 post.id（= src/content/posts 下的相对路径去掉 .md），
 * 只有系列目录页（stm32/index）要抹掉末尾的 /index，
 * 让它落在 /posts/stm32/ 而不是 /posts/stm32/index/。
 */
export function postSlug(post: Post): string {
  return post.id.replace(/\/index$/, '');
}

/** 是不是系列（多文件长文）的成员（目录页或章节都算） */
export function isSeriesMember(post: Post): boolean {
  return Boolean(post.data.series);
}

/**
 * 是不是系列目录 / 说明页（约定：<series>/index.md，或用 seriesOrder: 0 显式声明）。
 * 目录页在首页只占「一张入口卡」，不会把整个系列的章节灌进文章列表。
 */
export function isSeriesIndex(post: Post): boolean {
  if (!post.data.series) return false;
  return /\/index$/.test(post.id) || post.data.seriesOrder === 0;
}

/** 是不是系列里的某一章 */
export function isSeriesChapter(post: Post): boolean {
  return isSeriesMember(post) && !isSeriesIndex(post);
}

/** 章节排序键：按 seriesOrder 升序，没写就按文件名兜底 */
export function seriesSortKey(post: Post): number {
  const order = post.data.seriesOrder;
  if (typeof order === 'number' && Number.isFinite(order)) return order;
  return Number.POSITIVE_INFINITY;
}


/**
 * 估算阅读时长（中英混排），返回分钟数。
 * 口径和 wordCount 一致：**围栏代码块不算阅读量**。
 * 以前这里把代码也算进去，于是出现过「8108 字 · 55 分钟」这种对不上的数字
 * （8108 字按 400 字/分钟应该是 20 分钟）—— 字数和时长必须用同一把尺子。
 */
export function readingTime(body: string | undefined): number {
  if (!body) return 1;
  const text = body.replace(/```[\s\S]*?```/g, ' ');
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = text
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(cjk / 400 + words / 220));
}

/**
 * 列表用的文章（首页 / 分页 / 归档 / RSS）：
 * 把系列的「章节」折叠掉，只留系列的目录页当一张入口卡。
 * 于是 10 篇的系列在首页只占 1 个位置，不再淹没普通文章，
 * 而且它走的还是普通文章那张卡（PostCard），只是多一个系列角标。
 * 标签页 / 分类页 / 站内搜索仍然能看到每一章（它们用的是 getSortedPosts）。
 */
export async function getListingPosts(): Promise<Post[]> {
  const posts = await getSortedPosts();
  return posts.filter((post) => !isSeriesChapter(post));
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

/**
 * 字数怎么显示：一万以内照原样写，超过一万用 k 简写（12 480 → 12.5k）。
 * 一长串数字（20611 字）在卡片上既占地方又容易被误读成两个数字。
 */
export function formatWords(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value <= 10_000) return String(value);
  const k = value / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
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

/** 按「年-月」分组，用于归档页（系列章节折叠，只显示目录页） */
export async function getArchiveGroups(): Promise<ArchiveGroup[]> {
  const posts = await getListingPosts();
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

