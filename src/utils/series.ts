/**
 * 系列（多文件长文）· 纯数据层
 * ============================================================
 * 一个系列 = src/content/posts/<series>/ 下的若干个 .md：
 *
 *   stm32/index.md       ← 系列目录 / 说明页（seriesOrder: 0）
 *   stm32/01-xxx.md      ← 第 1 章（seriesOrder: 1）
 *   stm32/02-xxx.md      ← 第 2 章（seriesOrder: 2）
 *   …
 *
 * frontmatter 只多三个可选字段（见 content.config.ts）：
 *   series: stm32
 *   seriesTitle: "STM32 单片机学习笔记"   ← 只在 index.md 写
 *   seriesOrder: 3
 *
 * 不写 series 的文章 = 普通单篇文章，行为与以前完全一致。
 *
 * 这里只负责「查与排」，不碰 DOM、不碰样式；
 * 侧栏渲染在 components/series/SeriesNav.astro。
 */
import { getCollection } from 'astro:content';
import type { Post } from './posts';
import {
  isSeriesChapter,
  isSeriesIndex,
  postUrl,
  readingTime,
  seriesSortKey,
  wordCount,
} from './posts';

export interface SeriesChapter {
  post: Post;
  /** 章节序号（1 起）；没有写 seriesOrder 时用排序后的位置兜底 */
  order: number;
  url: string;
  title: string;
}

export interface SeriesInfo {
  /** 系列标识（= 子目录名） */
  slug: string;
  /** 系列标题：优先 index.md 的 seriesTitle，其次章节目录名 */
  title: string;
  /** 目录 / 说明页；没有 index.md 时为 null */
  index: Post | null;
  /** 章节（已按 seriesOrder 排好） */
  chapters: SeriesChapter[];
  /** 系列入口地址 */
  url: string;
  /** 系列简介：优先 index.md 的 description */
  description: string;
  /** 封面：优先 index.md 的 image，其次第一章的图 */
  image: string | undefined;
  /** 整个系列的发布时间（取目录页或最早一章） */
  date: Date;
}

/**
 * 列表页（分类 / 标签）里的一条记录：
 * 普通文章是一条，整个系列也只占一条（章节收在它下面）。
 */
export type SeriesListingEntry =
  | { kind: 'series'; series: SeriesInfo; date: Date }
  | { kind: 'post'; post: Post; date: Date };

/**
 * 章节标题去掉开头的「第 N 章」。
 * 列表行已经有 01 / 02 的序号，标题里再重复一次「第一章」很啰嗦；
 * 去掉之后是「准备：环境搭建与芯片认识」，像真正的目录。
 * 标题本身不以「第 N 章」开头时原样返回。
 */
export function chapterShortTitle(chapter: SeriesChapter): string {
  const short = chapter.title
    .replace(/^第\s*[0-9一二三四五六七八九十百千零两]+\s*章[\s:：、.．·-]*/u, '')
    .trim();
  return short || chapter.title;
}

/** 构建期缓存：getCollection 本身有缓存，这里再把分组结果存一份，避免每页重复分组 */
let cache: Promise<SeriesInfo[]> | null = null;

function chaptersOf(posts: Post[]): SeriesChapter[] {
  const list = posts
    .filter(isSeriesChapter)
    .sort((a, b) => {
      const diff = seriesSortKey(a) - seriesSortKey(b);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });

  return list.map((post, i) => ({
    post,
    order: Number.isFinite(seriesSortKey(post)) ? seriesSortKey(post) : i + 1,
    url: postUrl(post),
    title: post.data.title,
  }));
}

function buildSeries(slug: string, posts: Post[]): SeriesInfo {
  const index = posts.find(isSeriesIndex) ?? null;
  const chapters = chaptersOf(posts);
  const first = index ?? chapters[0]?.post ?? posts[0]!;

  const title =
    index?.data.seriesTitle?.trim() ||
    first.data.seriesTitle?.trim() ||
    index?.data.title ||
    slug;

  const image = index?.data.image ?? chapters[0]?.post.data.image;

  return {
    slug,
    title,
    index,
    chapters,
    /**
     * 正常情况导读页就是入口；万一某个系列还没有 index.md（例如手动加章节），
     * 至少落到第一章，而不是一个 404 的 /posts/<slug>/。
     */
    url: index ? postUrl(index) : (chapters[0]?.url ?? `/posts/${slug}/`),
    description: index?.data.description?.trim() || '',
    image,
    date: index?.data.date ?? chapters[0]?.post.data.date ?? first.data.date,
  };
}

/** 所有系列（按目录页日期从新到旧） */
export function getSeriesList(): Promise<SeriesInfo[]> {
  cache ??= (async () => {
    const posts = await getCollection('posts', ({ data }) => data.draft !== true);
    const groups = new Map<string, Post[]>();

    for (const post of posts) {
      const slug = post.data.series;
      if (!slug) continue;
      const list = groups.get(slug);
      if (list) list.push(post);
      else groups.set(slug, [post]);
    }

    return [...groups.entries()]
      .map(([slug, list]) => buildSeries(slug, list))
      .sort((a, b) => b.date.valueOf() - a.date.valueOf());
  })();

  return cache;
}

/** 按 slug 取一个系列 */
export async function getSeries(slug: string): Promise<SeriesInfo | null> {
  const all = await getSeriesList();
  return all.find((item) => item.slug === slug) ?? null;
}

/** 这篇文章属于哪个系列（普通文章返回 null） */
export async function getPostSeries(post: Post): Promise<SeriesInfo | null> {
  const slug = post.data.series;
  if (!slug) return null;
  return getSeries(slug);
}

export interface SeriesPosition {
  /** 当前是第几章（1 起）；目录页为 0 */
  position: number;
  total: number;
  prev: SeriesChapter | null;
  next: SeriesChapter | null;
}

/**
 * 整个系列的字数 / 阅读时长（导读 + 全部章节）。
 * 首页那张「系列长文」卡片要显示的是**整个系列**的分量：
 * 只算导读自己的几百字，旁边又写着「共 10 章」，读的人会以为十分钟能看完。
 * 把正文拼起来一次性算 —— 分章各算再相加会把每章的最小 1 分钟累加成几分钟误差。
 */
export function seriesTotals(series: SeriesInfo): { words: number; minutes: number } {
  const text = [series.index?.body, ...series.chapters.map((chapter) => chapter.post.body)]
    .filter(Boolean)
    .join('\n\n');
  return { words: wordCount(text), minutes: readingTime(text) };
}

/** 当前文章在系列里的位置 + 上一章 / 下一章（章节间的「上一篇 / 下一篇」用） */
export function getSeriesPosition(series: SeriesInfo, post: Post): SeriesPosition {
  const total = series.chapters.length;
  const i = series.chapters.findIndex((chapter) => chapter.post.id === post.id);

  if (i === -1) {
    // 目录页：没有上一章，下一章是第一篇
    return { position: 0, total, prev: null, next: series.chapters[0] ?? null };
  }

  return {
    position: i + 1,
    total,
    prev: i > 0 ? series.chapters[i - 1]! : null,
    next: i < total - 1 ? series.chapters[i + 1]! : null,
  };
}

/**
 * 把一组已排好序的文章折叠成列表记录：
 * 普通文章一条；同一系列的所有文章只在第一次出现的位置占一条，
 * 具体章节由调用方从 SeriesInfo.chapters 里取（默认全部）。
 *
 * 分类页 / 标签页 / 以后任何「按文章列表」的页面都走这里，
 * 不再需要各自判断 seriesOrder、index.md、章节去重。
 */
export async function groupSeriesPosts(posts: Post[]): Promise<SeriesListingEntry[]> {
  const allSeries = await getSeriesList();
  const bySlug = new Map(allSeries.map((series) => [series.slug, series]));
  const placed = new Set<string>();
  const entries: SeriesListingEntry[] = [];

  for (const post of posts) {
    const slug = post.data.series;
    if (!slug) {
      entries.push({ kind: 'post', post, date: post.data.date });
      continue;
    }

    if (placed.has(slug)) continue;

    const series = bySlug.get(slug);
    if (!series) {
      // 理论上不会发生（系列成员一定在 getSeriesList 里）；保险起见按普通文章处理
      entries.push({ kind: 'post', post, date: post.data.date });
      continue;
    }

    placed.add(slug);
    entries.push({ kind: 'series', series, date: series.date });
  }

  return entries;
}
