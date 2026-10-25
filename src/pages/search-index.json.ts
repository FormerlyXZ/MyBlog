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
 *   · **小标题永远全量入索引**：系列长文一章就好几万字，只留开头 6000 字的话，
 *     后半章（比如第四章的 OLED 那一节）根本搜不到；把 h2~h6 的标题文字单独拼在
 *     正文前面，等于给每个小节都留了"路标"，正文本身再按 6000 字截断。
 *   · 只在构建时生成一份，客户端按需 fetch 一次并缓存
 */
import type { APIRoute } from 'astro';
import { getSortedPosts, postUrl } from '../utils/posts';
import { formatDate } from '../utils/date';
import { SITE } from '../site.config';

/** 正文里所有 h1~h6 的标题文字（去掉 # 和行内 markdown 记号），用空格连起来 */
function headingsOf(md: string): string {
  const found: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (!match) continue;
    const text = (match[2] ?? '')
      .replace(/`[^`]*`/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[*_~]{1,3}/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) found.push(text);
  }
  return found.join(' ');
}

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

  const items = posts.map((post) => {
    const body = post.body ?? '';
    const headings = headingsOf(body);
    const plain = stripMarkdown(body).slice(0, 6000);

    return {
      title: post.data.title,
      description: post.data.description ?? '',
      url: postUrl(post),
      date: formatDate(post.data.date, SITE.dateFormat),
      categories: post.data.categories ?? [],
      tags: post.data.tags ?? [],
      // 标题全量在前，正文按长度截断（见文件头说明）
      text: headings ? `${headings} ${plain}` : plain,
    };
  });

  return new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
