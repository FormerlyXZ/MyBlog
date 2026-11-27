/**
 * 首页左侧栏「创作热力图」数据聚合（构建期）
 * ============================================================
 * 汇总站内带日期的公开活动，按权重计算每天的热力值（0–4 档）：
 *   · 发表文章（含系列导读与章节）：权重 4（最高）
 *   · 发布动态（config/moments.json）：权重 1
 *   · 更新文章（updated 与发布日不同天）：权重 1
 *   · 站点公告 / 更新日志（config/notices.json）：权重 1
 *   · 照片墙带日期的照片（config/gallery.json）：权重 1
 *
 * 时间统一按东八区（Asia/Shanghai）对齐，避免 CI 服务器在 UTC 下跨日偏移。
 */
import { getSortedPosts, isSeriesChapter, postUrl } from './posts';
import { getMoments, momentUrl, parseMomentTime } from './moments';
import { getAnnouncements, getChangelog, noticeHeadline } from './notices';
import { getPhotos } from './gallery';

export type ActivityKind = 'post' | 'postUpdate' | 'moment' | 'notice' | 'photo';

export interface ActivityItem {
  kind: ActivityKind;
  title: string;
  href?: string;
  weight: number;
}

export interface HeatmapDay {
  /** YYYY-MM-DD */
  date: string;
  /** 星期几（0=周日 … 6=周六） */
  weekday: number;
  /** 周序号（0 … weeks-1） */
  col: number;
  /** 行序号（0=周日 … 6=周六） */
  row: number;
  /** 加权总分 */
  score: number;
  /** 热力等级 0..4 */
  level: 0 | 1 | 2 | 3 | 4;
  /** 当天各类型计数 */
  counts: Record<ActivityKind, number>;
  /** 当天活动明细（按权重从高到低） */
  items: ActivityItem[];
  /** 是否今天 */
  isToday: boolean;
}

export interface HeatmapMonthLabel {
  col: number;
  label: string;
}

export interface HeatmapGrid {
  weeks: number;
  startDate: string;
  endDate: string;
  today: string;
  totalScore: number;
  activeDays: number;
  totalPosts: number;
  totalMoments: number;
  maxStreak: number;
  currentStreak: number;
  months: HeatmapMonthLabel[];
  cells: Array<HeatmapDay | null>;
}

/** 各类活动权重（文章权重显著高于动态与日常更新） */
export const ACTIVITY_WEIGHTS: Record<ActivityKind, number> = {
  post: 4,
  moment: 1,
  postUpdate: 1,
  notice: 1,
  photo: 1,
};

const WEEK_DAYS = 7;
const DEFAULT_WEEKS = 18;
const CN_TZ = 'Asia/Shanghai';

const pad = (n: number): string => String(n).padStart(2, '0');

/** 把任意 Date 转成东八区 YYYY-MM-DD（对只有日期的 UTC 午夜保留原年月日） */
function dateToKey(date: Date, preserveUtcDate = false): string {
  if (Number.isNaN(date.getTime())) return '';
  if (
    preserveUtcDate &&
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0
  ) {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/** 从 "YYYY-MM-DD..." 字符串提取日期键 */
function stringToDateKey(raw: string | undefined): string {
  if (!raw) return '';
  const match = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return `${match[1]}-${pad(Number(match[2]))}-${pad(Number(match[3]))}`;
  }
  const parsed = parseMomentTime(raw);
  return parsed ? dateToKey(parsed) : '';
}

function parseKeyUtc(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function formatKeyUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(key: string, days: number): string {
  const d = parseKeyUtc(key);
  d.setUTCDate(d.getUTCDate() + days);
  return formatKeyUtc(d);
}

/**
 * 权重分数 → 热力等级（0..4）：
 *   0       -> 0（无记录）
 *   1       -> 1（单条动态 / 更新 / 公告）
 *   2 ~ 3   -> 2（多条动态或日常叠加）
 *   4 ~ 5   -> 3（单篇新文章直接跨入第 3 档，明显高于普通动态）
 *   >= 6    -> 4（高产日：文章 + 动态 / 多篇文章等）
 */
export function scoreToLevel(score: number): 0 | 1 | 2 | 3 | 4 {
  if (score <= 0) return 0;
  if (score <= 1) return 1;
  if (score <= 3) return 2;
  if (score <= 5) return 3;
  return 4;
}

function emptyCounts(): Record<ActivityKind, number> {
  return { post: 0, postUpdate: 0, moment: 0, notice: 0, photo: 0 };
}

function clipText(text: string, max = 30): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** 构建近 N 周的首页热力图数据 */
export async function getHomeHeatmap(weeks = DEFAULT_WEEKS): Promise<HeatmapGrid> {
  const today = dateToKey(new Date());
  const todayUtc = parseKeyUtc(today);
  const todayDow = todayUtc.getUTCDay(); // 0=周日 .. 6=周六

  // 起点落在 (weeks - 1) 周前的周日，最后一列只填充到今天（周六及之后留空）
  const startDate = addDays(today, -(todayDow + (weeks - 1) * WEEK_DAYS));

  const dayMap = new Map<string, ActivityItem[]>();
  const pushItem = (key: string, item: ActivityItem): void => {
    if (!key) return;
    const list = dayMap.get(key);
    if (list) list.push(item);
    else dayMap.set(key, [item]);
  };

  // 1. 文章（新发布 + 异日更新）
  const posts = await getSortedPosts();
  for (const post of posts) {
    const pubKey = dateToKey(post.data.date, true);
    const label = isSeriesChapter(post)
      ? `${post.data.title}`
      : post.data.title;
    pushItem(pubKey, {
      kind: 'post',
      title: label,
      href: postUrl(post),
      weight: ACTIVITY_WEIGHTS.post,
    });

    if (post.data.updated) {
      const updKey = dateToKey(post.data.updated, true);
      if (updKey && updKey !== pubKey) {
        pushItem(updKey, {
          kind: 'postUpdate',
          title: `更新《${post.data.title}》`,
          href: postUrl(post),
          weight: ACTIVITY_WEIGHTS.postUpdate,
        });
      }
    }
  }

  // 2. 动态
  for (const moment of getMoments()) {
    const key = stringToDateKey(moment.time);
    const snippet = clipText(moment.text ?? '') || (moment.video ? '发布了一段视频动态' : '分享了一组照片');
    pushItem(key, {
      kind: 'moment',
      title: snippet,
      href: momentUrl(moment.id),
      weight: ACTIVITY_WEIGHTS.moment,
    });
  }

  // 3. 公告与更新日志
  for (const item of [...getAnnouncements(), ...getChangelog()]) {
    const key = stringToDateKey(item.time);
    const title = clipText(noticeHeadline(item) || item.title || '站点更新');
    pushItem(key, {
      kind: 'notice',
      title,
      weight: ACTIVITY_WEIGHTS.notice,
    });
  }

  // 4. 带日期的相册照片（可选字段）
  for (const photo of getPhotos()) {
    const key = stringToDateKey(photo.date);
    if (!key) continue;
    pushItem(key, {
      kind: 'photo',
      title: clipText(photo.title || '上传照片') || '上传照片',
      href: `/album/?p=${encodeURIComponent(photo.id)}`,
      weight: ACTIVITY_WEIGHTS.photo,
    });
  }

  // 组装网格（按列优先：col 0..weeks-1, row 0..6）
  const cells: Array<HeatmapDay | null> = [];
  const months: HeatmapMonthLabel[] = [];
  let lastMonthCol = -99;
  let totalScore = 0;
  let activeDays = 0;
  let totalPosts = 0;
  let totalMoments = 0;
  let maxStreak = 0;
  let runningStreak = 0;

  for (let col = 0; col < weeks; col++) {
    let monthHit: string | null = null;

    for (let row = 0; row < WEEK_DAYS; row++) {
      const offset = col * WEEK_DAYS + row;
      const date = addDays(startDate, offset);
      const utc = parseKeyUtc(date);

      if (utc.getUTCDate() === 1 || (col === 0 && row === 0 && utc.getUTCDate() <= 7)) {
        monthHit = `${utc.getUTCMonth() + 1}月`;
      }

      if (date > today) {
        cells.push(null);
        continue;
      }

      const rawItems = dayMap.get(date) ?? [];
      const items = [...rawItems].sort((a, b) => b.weight - a.weight);
      const counts = emptyCounts();
      let score = 0;
      for (const item of items) {
        counts[item.kind] += 1;
        score += item.weight;
      }

      const level = scoreToLevel(score);
      if (score > 0) {
        activeDays += 1;
        totalScore += score;
        totalPosts += counts.post;
        totalMoments += counts.moment;
        runningStreak += 1;
        if (runningStreak > maxStreak) maxStreak = runningStreak;
      } else {
        runningStreak = 0;
      }

      cells.push({
        date,
        weekday: row,
        col,
        row,
        score,
        level,
        counts,
        items,
        isToday: date === today,
      });
    }

    if (monthHit && col - lastMonthCol >= 3) {
      months.push({ col, label: monthHit });
      lastMonthCol = col;
    }
  }

  // 计算截至今天的连续活跃天数（若今天暂未记录，则看昨天是否延续）
  const activeCells = cells.filter((c): c is HeatmapDay => c !== null);
  let currentStreak = 0;
  for (let i = activeCells.length - 1; i >= 0; i--) {
    const day = activeCells[i]!;
    if (day.score > 0) {
      currentStreak += 1;
    } else if (day.isToday) {
      // 今天还没结束，不算断签
      continue;
    } else {
      break;
    }
  }

  return {
    weeks,
    startDate,
    endDate: today,
    today,
    totalScore,
    activeDays,
    totalPosts,
    totalMoments,
    maxStreak,
    currentStreak,
    months,
    cells,
  };
}
