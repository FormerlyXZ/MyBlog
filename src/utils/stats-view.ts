/**
 * 站点统计页（/stats/）纯数据与图表计算层
 * ============================================================
 * 不触碰 DOM，只负责：
 *   1. 将 Worker /api/stats（含 /moments/ 等杂项）严格过滤为「仅站内文章」；
 *   2. 按系列归组（主标题导读 + 子级章节明细）；
 *   3. 日期趋势过滤（7/14/30 天、全部/工作日/周末）、累计值与今日标记；
 *   4. 多维透视聚合（分类、文章形态、系列章节、星期规律）；
 *   5. 排行筛选与排序、响应式坐标轴刻度间距计算。
 */

export interface CatalogPost {
  path: string;
  title: string;
  shortTitle?: string;
  date: string;
  timestamp: number;
  categories: string[];
  words: number;
  minutes: number;
  series?: string;
  isSeriesIndex?: boolean;
  seriesOrder?: number | null;
}

export interface CatalogChapter {
  path: string;
  order: number;
  title: string;
  shortTitle: string;
  date: string;
  words: number;
  minutes: number;
}

export interface CatalogSeries {
  slug: string;
  title: string;
  url: string;
  date: string;
  timestamp: number;
  categories: string[];
  totalChapters: number;
  words: number;
  minutes: number;
  guidePath: string | null;
  chapters: CatalogChapter[];
}

export interface StatsCatalog {
  posts: CatalogPost[];
  series: CatalogSeries[];
}

export interface RawPostStat {
  path: string;
  views: number;
  likes: number;
}

export interface RawDailyStat {
  date: string;
  views: number;
}

export type DateRangeFilter = '7d' | '14d' | 'all';
export type DayTypeFilter = 'all' | 'weekday' | 'weekend';
export type TrendChartKind = 'bar' | 'area' | 'heatmap' | 'cumulative';

export type BreakdownDimension = 'category' | 'shape' | 'chapters' | 'weekday';
export type BreakdownChartKind = 'donut' | 'hbar' | 'compare';
export type BreakdownMetric = 'views' | 'likes';

export type RankingKindFilter = 'all' | 'series' | 'post';
export type RankingSort = 'views' | 'likes' | 'rate' | 'date';
export type SeriesChildSort = 'rank' | 'order';

export interface DailyPoint {
  date: string;
  shortDate: string;
  dayNum: string;
  views: number;
  cumulative: number;
  isToday: boolean;
  /** 0 = 周一 .. 6 = 周日 */
  weekdayIndex: number;
  weekdayLabel: string;
  isWeekend: boolean;
  share: number;
  deltaFromPrev: number | null;
}

export interface SeriesChildStat {
  kind: 'guide' | 'chapter';
  badge: string;
  order: number;
  path: string;
  title: string;
  date: string;
  words: number;
  minutes: number;
  views: number;
  likes: number;
  likeRate: number;
  seriesShare: number;
}

export interface RankingEntry {
  id: string;
  kind: 'series' | 'post';
  path: string;
  title: string;
  date: string;
  timestamp: number;
  categories: string[];
  words: number;
  minutes: number;
  views: number;
  likes: number;
  likeRate: number;
  totalShare: number;
  barRatio: number;
  totalChapters: number;
  children: SeriesChildStat[];
  autoExpand?: boolean;
  matchedChildPaths?: Set<string>;
}

export interface ArticleStatsSummary {
  entries: RankingEntry[];
  totalArticleViews: number;
  totalArticleLikes: number;
  totalPostsCount: number;
  seriesCount: number;
  standaloneCount: number;
  categories: string[];
  chapterStats: SeriesChildStat[];
  shapeTotals: {
    guide: { views: number; likes: number; count: number };
    chapter: { views: number; likes: number; count: number };
    standalone: { views: number; likes: number; count: number };
  };
}

export interface BreakdownItem {
  key: string;
  label: string;
  sublabel: string;
  views: number;
  likes: number;
  count: number;
  value: number;
  share: number;
  likeRate: number;
}

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

/** 将 YYYY-MM-DD 解析为稳定的周几序号（0 = 周一 .. 6 = 周日） */
export function parseWeekdayIndex(dateStr: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return 0;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const jsDay = new Date(utc).getUTCDay(); // 0 = 周日 .. 6 = 周六
  return (jsDay + 6) % 7;
}

/** 取得中国时区（UTC+8）下某个时间戳的 YYYY-MM-DD */
export function chinaDateString(isoOrMs: string | number = Date.now()): string {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  const safe = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safe + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 过滤并归组文章统计：
 * - 严格只保留 catalog 中存在的文章（过滤掉 /moments/... 等所有非文章路径）；
 * - 系列长文合并到其「主标题（导读）」下，导读本身与各章节都放进 children，保证数字完全对账。
 */
export function buildArticleStats(
  catalog: StatsCatalog,
  apiPosts: RawPostStat[],
  extraMeta: Record<string, { views: number; likes: number }> = {},
): ArticleStatsSummary {
  const knownPaths = new Set<string>(catalog.posts.map((p) => p.path));
  const statByPath = new Map<string, { views: number; likes: number }>();

  for (const row of apiPosts) {
    if (!knownPaths.has(row.path)) continue;
    statByPath.set(row.path, {
      views: Math.max(0, Number(row.views) || 0),
      likes: Math.max(0, Number(row.likes) || 0),
    });
  }

  for (const [path, meta] of Object.entries(extraMeta)) {
    if (!knownPaths.has(path)) continue;
    const prev = statByPath.get(path);
    statByPath.set(path, {
      views: Math.max(prev?.views ?? 0, Number(meta.views) || 0),
      likes: Math.max(prev?.likes ?? 0, Number(meta.likes) || 0),
    });
  }

  const getStat = (path: string) => statByPath.get(path) ?? { views: 0, likes: 0 };

  const seriesBySlug = new Map<string, CatalogSeries>();
  for (const item of catalog.series) seriesBySlug.set(item.slug, item);

  const rawEntries: RankingEntry[] = [];
  const allChapterStats: SeriesChildStat[] = [];
  const categorySet = new Set<string>();

  const shapeTotals = {
    guide: { views: 0, likes: 0, count: 0 },
    chapter: { views: 0, likes: 0, count: 0 },
    standalone: { views: 0, likes: 0, count: 0 },
  };

  let totalArticleViews = 0;
  let totalArticleLikes = 0;

  // 1. 系列长文（主标题导读 + 下拉子级）
  for (const series of catalog.series) {
    for (const cat of series.categories) categorySet.add(cat);

    const children: SeriesChildStat[] = [];
    let seriesViews = 0;
    let seriesLikes = 0;

    if (series.guidePath) {
      const guidePost = catalog.posts.find((p) => p.path === series.guidePath);
      const gs = getStat(series.guidePath);
      seriesViews += gs.views;
      seriesLikes += gs.likes;
      shapeTotals.guide.views += gs.views;
      shapeTotals.guide.likes += gs.likes;
      shapeTotals.guide.count += 1;

      children.push({
        kind: 'guide',
        badge: '导读',
        order: 0,
        path: series.guidePath,
        title: guidePost?.title && guidePost.title !== series.title
          ? `导读：${guidePost.title}`
          : '系列导读正文',
        date: series.date,
        words: guidePost?.words ?? 0,
        minutes: guidePost?.minutes ?? 1,
        views: gs.views,
        likes: gs.likes,
        likeRate: gs.views > 0 ? gs.likes / gs.views : 0,
        seriesShare: 0,
      });
    }

    for (const ch of series.chapters) {
      const cs = getStat(ch.path);
      seriesViews += cs.views;
      seriesLikes += cs.likes;
      shapeTotals.chapter.views += cs.views;
      shapeTotals.chapter.likes += cs.likes;
      shapeTotals.chapter.count += 1;

      const childRow: SeriesChildStat = {
        kind: 'chapter',
        badge: String(ch.order).padStart(2, '0'),
        order: ch.order,
        path: ch.path,
        title: ch.shortTitle || ch.title,
        date: ch.date,
        words: ch.words,
        minutes: ch.minutes,
        views: cs.views,
        likes: cs.likes,
        likeRate: cs.views > 0 ? cs.likes / cs.views : 0,
        seriesShare: 0,
      };
      children.push(childRow);
      allChapterStats.push(childRow);
    }

    for (const child of children) {
      child.seriesShare = seriesViews > 0 ? child.views / seriesViews : 0;
    }

    totalArticleViews += seriesViews;
    totalArticleLikes += seriesLikes;

    rawEntries.push({
      id: `series:${series.slug}`,
      kind: 'series',
      path: series.url,
      title: series.title,
      date: series.date,
      timestamp: series.timestamp,
      categories: series.categories.length ? series.categories : ['未分类'],
      words: series.words,
      minutes: series.minutes,
      views: seriesViews,
      likes: seriesLikes,
      likeRate: seriesViews > 0 ? seriesLikes / seriesViews : 0,
      totalShare: 0,
      barRatio: 0,
      totalChapters: series.totalChapters,
      children,
    });
  }

  // 2. 普通单篇文章
  const standalonePosts = catalog.posts.filter((p) => !p.series || !seriesBySlug.has(p.series));
  for (const post of standalonePosts) {
    const cats = post.categories.length ? post.categories : ['未分类'];
    for (const cat of post.categories) categorySet.add(cat);

    const st = getStat(post.path);
    totalArticleViews += st.views;
    totalArticleLikes += st.likes;
    shapeTotals.standalone.views += st.views;
    shapeTotals.standalone.likes += st.likes;
    shapeTotals.standalone.count += 1;

    rawEntries.push({
      id: `post:${post.path}`,
      kind: 'post',
      path: post.path,
      title: post.title,
      date: post.date,
      timestamp: post.timestamp,
      categories: cats,
      words: post.words,
      minutes: post.minutes,
      views: st.views,
      likes: st.likes,
      likeRate: st.views > 0 ? st.likes / st.views : 0,
      totalShare: 0,
      barRatio: 0,
      totalChapters: 0,
      children: [],
    });
  }

  for (const entry of rawEntries) {
    entry.totalShare = totalArticleViews > 0 ? entry.views / totalArticleViews : 0;
  }

  return {
    entries: rawEntries,
    totalArticleViews,
    totalArticleLikes,
    totalPostsCount: catalog.posts.length,
    seriesCount: catalog.series.length,
    standaloneCount: standalonePosts.length,
    categories: [...categorySet].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    chapterStats: allChapterStats,
    shapeTotals,
  };
}

/**
 * 清洗并按时间跨度、工作日/周末筛选每日趋势序列，计算今日标记与累计值
 */
export function filterDailySeries(
  rawDaily: RawDailyStat[],
  range: DateRangeFilter,
  dayType: DayTypeFilter,
  generatedAt?: string,
): DailyPoint[] {
  if (!rawDaily.length) return [];

  const todayChina = generatedAt ? chinaDateString(generatedAt) : rawDaily[rawDaily.length - 1]!.date;
  const sliced =
    range === '7d'
      ? rawDaily.slice(-7)
      : range === '14d'
        ? rawDaily.slice(-14)
        : rawDaily;

  const filtered = sliced.filter((item) => {
    const weekdayIndex = parseWeekdayIndex(item.date);
    const isWeekend = weekdayIndex >= 5;
    if (dayType === 'weekday') return !isWeekend;
    if (dayType === 'weekend') return isWeekend;
    return true;
  });

  const totalViews = filtered.reduce((sum, item) => sum + Math.max(0, Number(item.views) || 0), 0);
  let running = 0;

  return filtered.map((item, idx) => {
    const views = Math.max(0, Number(item.views) || 0);
    running += views;
    const weekdayIndex = parseWeekdayIndex(item.date);
    const prevViews = idx > 0 ? Math.max(0, Number(filtered[idx - 1]!.views) || 0) : null;
    return {
      date: item.date,
      shortDate: item.date.slice(5),
      dayNum: item.date.slice(8),
      views,
      cumulative: running,
      isToday: item.date === todayChina,
      weekdayIndex,
      weekdayLabel: WEEKDAY_NAMES[weekdayIndex] ?? '周一',
      isWeekend: weekdayIndex >= 5,
      share: totalViews > 0 ? views / totalViews : 0,
      deltaFromPrev: prevViews === null ? null : views - prevViews,
    };
  });
}

/**
 * 计算多维透视数据（分类、文章形态、系列章节、星期分布）
 */
export function computeBreakdown(
  summary: ArticleStatsSummary,
  rawDaily: RawDailyStat[],
  dimension: BreakdownDimension,
  metric: BreakdownMetric,
): BreakdownItem[] {
  const rows: Array<{ key: string; label: string; sublabel: string; views: number; likes: number; count: number }> = [];

  if (dimension === 'category') {
    const map = new Map<string, { views: number; likes: number; count: number }>();
    for (const entry of summary.entries) {
      const cats = entry.categories.length ? entry.categories : ['未分类'];
      for (const cat of cats) {
        const cur = map.get(cat) ?? { views: 0, likes: 0, count: 0 };
        cur.views += entry.views;
        cur.likes += entry.likes;
        cur.count += 1;
        map.set(cat, cur);
      }
    }
    for (const [cat, val] of map.entries()) {
      rows.push({
        key: cat,
        label: cat,
        sublabel: `${val.count} 篇${val.count > 0 ? '' : ''}`,
        views: val.views,
        likes: val.likes,
        count: val.count,
      });
    }
  } else if (dimension === 'shape') {
    const { guide, chapter, standalone } = summary.shapeTotals;
    if (standalone.count > 0) {
      rows.push({
        key: 'standalone',
        label: '普通文章',
        sublabel: `${standalone.count} 篇独立文章`,
        ...standalone,
      });
    }
    if (chapter.count > 0) {
      rows.push({
        key: 'chapter',
        label: '系列章节',
        sublabel: `${chapter.count} 篇长文章节`,
        ...chapter,
      });
    }
    if (guide.count > 0) {
      rows.push({
        key: 'guide',
        label: '系列导读',
        sublabel: `${guide.count} 篇系列目录页`,
        ...guide,
      });
    }
  } else if (dimension === 'chapters') {
    const seriesEntries = summary.entries.filter((e) => e.kind === 'series');
    for (const s of seriesEntries) {
      for (const ch of s.children) {
        if (ch.kind !== 'chapter') continue;
        rows.push({
          key: ch.path,
          label: `${ch.badge} ${ch.title}`,
          sublabel: s.title,
          views: ch.views,
          likes: ch.likes,
          count: 1,
        });
      }
    }
    // 章节太多时只取 Top 10（或按当前指标排序后取前 10）
  } else if (dimension === 'weekday') {
    const buckets = WEEKDAY_NAMES.map((name, index) => ({
      key: `wd-${index}`,
      label: name,
      sublabel: index >= 5 ? '周末' : '工作日',
      views: 0,
      likes: 0,
      count: 0,
    }));
    for (const item of rawDaily) {
      const idx = parseWeekdayIndex(item.date);
      const bucket = buckets[idx];
      if (bucket) {
        bucket.views += Math.max(0, Number(item.views) || 0);
        bucket.count += 1;
      }
    }
    for (const b of buckets) {
      b.sublabel = `${b.count} 天 · 均 ${(b.count > 0 ? b.views / b.count : 0).toFixed(1)}`;
      rows.push(b);
    }
  }

  const pickVal = (item: { views: number; likes: number }) =>
    dimension === 'weekday' ? item.views : metric === 'likes' ? item.likes : item.views;

  let sorted = rows.map((r) => ({
    ...r,
    value: pickVal(r),
    share: 0,
    likeRate: r.views > 0 ? r.likes / r.views : 0,
  }));

  if (dimension !== 'weekday') {
    sorted.sort((a, b) => b.value - a.value || b.views - a.views || a.label.localeCompare(b.label, 'zh-CN'));
    if (dimension === 'chapters' && sorted.length > 10) {
      sorted = sorted.slice(0, 10);
    }
  }

  const sumVal = sorted.reduce((acc, item) => acc + item.value, 0);
  for (const item of sorted) {
    item.share = sumVal > 0 ? item.value / sumVal : 0;
  }
  return sorted;
}

/**
 * 筛选并排序文章排行列表，支持按标题/章节关键词自动展开命中系列
 */
export function filterAndSortRanking(
  entries: RankingEntry[],
  opts: {
    kind: RankingKindFilter;
    category: string;
    sort: RankingSort;
    childSort: SeriesChildSort;
    query: string;
    onlyNonZero: boolean;
  },
): RankingEntry[] {
  const q = opts.query.trim().toLowerCase();

  const filtered = entries
    .filter((entry) => {
      if (opts.kind !== 'all' && entry.kind !== opts.kind) return false;
      if (opts.category !== 'all' && !entry.categories.includes(opts.category)) return false;
      if (opts.onlyNonZero && entry.views === 0 && entry.likes === 0) return false;
      if (!q) return true;
      const parentHit =
        entry.title.toLowerCase().includes(q) ||
        entry.categories.some((c) => c.toLowerCase().includes(q));
      const childHit = entry.children.some((c) => c.title.toLowerCase().includes(q));
      return parentHit || childHit;
    })
    .map((entry) => {
      const matchedChildPaths = new Set<string>();
      let autoExpand = false;
      if (q && entry.children.length > 0) {
        for (const ch of entry.children) {
          if (ch.title.toLowerCase().includes(q)) {
            matchedChildPaths.add(ch.path);
            autoExpand = true;
          }
        }
      }

      const sortedChildren = [...entry.children].sort((a, b) => {
        if (opts.childSort === 'order') {
          return a.order - b.order;
        }
        // 按当前排行指标排序子项（导读与章节统一按热度排行，章节编号明确标识）
        if (opts.sort === 'likes') {
          return b.likes - a.likes || b.views - a.views || a.order - b.order;
        }
        if (opts.sort === 'rate') {
          return b.likeRate - a.likeRate || b.views - a.views || a.order - b.order;
        }
        return b.views - a.views || b.likes - a.likes || a.order - b.order;
      });

      return {
        ...entry,
        children: sortedChildren,
        autoExpand,
        matchedChildPaths,
      };
    });

  filtered.sort((a, b) => {
    if (opts.sort === 'likes') {
      return b.likes - a.likes || b.views - a.views || b.timestamp - a.timestamp;
    }
    if (opts.sort === 'rate') {
      return b.likeRate - a.likeRate || b.likes - a.likes || b.views - a.views;
    }
    if (opts.sort === 'date') {
      return b.timestamp - a.timestamp || b.views - a.views;
    }
    return b.views - a.views || b.likes - a.likes || b.timestamp - a.timestamp;
  });

  const maxMetric = Math.max(
    1,
    ...filtered.map((item) => (opts.sort === 'likes' ? item.likes : item.views)),
  );
  for (const item of filtered) {
    const val = opts.sort === 'likes' ? item.likes : item.views;
    item.barRatio = val > 0 ? Math.max(0.03, val / maxMetric) : 0;
  }

  return filtered;
}

/**
 * 计算 X 轴显示哪些下标，保证窄屏不重叠、不溢出，且优先保留「今日」与首尾节点
 */
export function selectVisibleTickIndices(
  points: DailyPoint[],
  plotWidth: number,
  minSpacingPx = 46,
): Set<number> {
  const n = points.length;
  const visible = new Set<number>();
  if (n === 0) return visible;
  if (n === 1) {
    visible.add(0);
    return visible;
  }

  const maxTicks = Math.max(2, Math.floor(plotWidth / minSpacingPx));
  if (maxTicks >= n) {
    for (let i = 0; i < n; i++) visible.add(i);
    return visible;
  }

  const last = n - 1;
  visible.add(last);
  visible.add(0);

  const step = Math.ceil((n - 1) / Math.max(1, maxTicks - 1));
  const minGapRatio = minSpacingPx / Math.max(1, plotWidth);
  for (let i = step; i < last; i += step) {
    const distToLast = (last - i) / (n - 1);
    if (distToLast >= minGapRatio * 0.9) {
      visible.add(i);
    }
  }
  return visible;
}

/** 紧凑数字格式（坐标轴用） */
export function formatCompactNumber(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** 百分比格式化 */
export function formatPercent(ratio: number): string {
  const pct = Math.max(0, ratio * 100);
  if (pct === 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  return `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(1)}%`;
}
