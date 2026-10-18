import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

/** 取所有已发布文章，按日期从新到旧排序 */
export async function getSortedPosts(): Promise<Post[]> {
  const posts = await getCollection('posts', ({ data }) => data.draft !== true);
  return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
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
