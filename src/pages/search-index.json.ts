/**
 * 站内搜索索引：/search-index.json
 * ============================================================
 * 为什么不用 Pagefind：
 *   Pagefind 的索引是 `pagefind --site dist` 在 build **之后**生成的，
 *   本地 `npm run dev` 时 /pagefind/ 根本不存在 —— 开发环境里搜索永远搜不到东西。
 *   这个博客文章量很小，直接输出一份 JSON 索引，页面端自己过滤即可，
 *   dev 和线上行为完全一致，也不需要额外依赖。
 *
 * 输出：[{ title, description, url, date, categories, tags, text }]
 *   · text = 正文去掉 markdown 记号后截断到 6000 字（够搜索用，文件不大）
 *   · 只在构建时生成一份，客户端按需 fetch 一次并缓存
 */
import type { APIRoute } from 'astro';
import { getSortedPosts, postUrl } from '../utils/posts';
import { formatDate } from '../utils/date';
import { SITE } from '../site.config';

/** 把 Markdown 洗成纯文本（代码块整体丢掉，避免代码里的英文单词污染搜索） */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, ' '))
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const GET: APIRoute = async () => {
  const posts = await getSortedPosts();

  const items = posts.map((post) => ({
    title: post.data.title,
    description: post.data.description ?? '',
    url: postUrl(post),
    date: formatDate(post.data.date, SITE.dateFormat),
    categories: post.data.categories ?? [],
    tags: post.data.tags ?? [],
    text: stripMarkdown(post.body ?? '').slice(0, 6000),
  }));

  return new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
