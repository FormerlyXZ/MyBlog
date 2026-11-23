/**
 * 站内搜索索引：/search-index.json
 * ============================================================
 * 为什么不用 Pagefind：
 *   Pagefind 的索引是 `pagefind --site dist` 在 build **之后**生成的，
 *   本地 `npm run dev` 时 /pagefind/ 根本不存在 —— 开发环境里搜索永远搜不到东西。
 *   这个博客文章量很小，直接输出一份 JSON 索引，页面端自己过滤即可，
 *   dev 和线上行为完全一致，也不需要额外依赖。
 *
 * 输出结构（2026-11 起）：
 *   {
 *     items:  [{ title, description, url, date, sort, categories, tags, text, series?, seriesOrder? }],
 *     series: { [slug]: { title, url, image, description, total, categories, tags, date } }
 *   }
 *
 *   · items 仍然包含**每一章**，所以章节正文照样能被搜到；
 *     同一系列的章节通过 series + seriesOrder 归组，搜索页把导读放在上面、
 *     命中的章节放在下面，不会把 10 章摊成 10 条互不相干的文章。
 *   · series 单独存一份系列元信息，避免每一章都重复一遍标题/封面/简介。
 *   · text = 正文去掉 markdown 记号后截断到 6000 字；h1~h6 的标题文字全量
 *     放在前面，长文后半章的小节也能被搜到。
 *   · 只在构建时生成一份，客户端按需 fetch 一次并缓存。
 */
import type { APIRoute } from 'astro';
import {
  effectiveCategories,
  effectiveTags,
  getSortedPosts,
  isSeriesIndex,
  postUrl,
} from '../utils/posts';
import { getSeriesList } from '../utils/series';
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
  const [posts, seriesList] = await Promise.all([getSortedPosts(), getSeriesList()]);

  /** post.id -> 章节序号（1 起）；导读页单独记为 0 */
  const chapterOrder = new Map<string, number>();
  for (const series of seriesList) {
    for (const chapter of series.chapters) chapterOrder.set(chapter.post.id, chapter.order);
  }

  const items = posts.map((post) => {
    const body = post.body ?? '';
    const headings = headingsOf(body);
    const plain = stripMarkdown(body).slice(0, 6000);
    const series = post.data.series;
    const order = series ? (isSeriesIndex(post) ? 0 : (chapterOrder.get(post.id) ?? null)) : null;

    return {
      title: post.data.title,
      description: post.data.description ?? '',
      url: postUrl(post),
      date: formatDate(post.data.date, SITE.dateFormat),
      sort: post.data.date.valueOf(),
      // 分类/标签只挂在导读页；章节即使 frontmatter 里残留了也不参与搜索命中
      categories: effectiveCategories(post),
      tags: effectiveTags(post),
      // 标题全量在前，正文按长度截断（见文件头说明）
      text: headings ? `${headings} ${plain}` : plain,
      ...(series ? { series, seriesOrder: order } : {}),
    };
  });

  const series = Object.fromEntries(
    seriesList.map((item) => [
      item.slug,
      {
        title: item.title,
        url: item.url,
        image: item.image ?? '',
        description: item.description,
        total: item.chapters.length,
        categories: item.index ? (item.index.data.categories ?? []) : [],
        tags: item.index ? (item.index.data.tags ?? []) : [],
        date: item.date.valueOf(),
      },
    ]),
  );

  return new Response(JSON.stringify({ items, series }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
