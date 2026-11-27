/**
 * 站点统计页交互与可视化脚本（/stats/）
 * ============================================================
 * · 适配 ClientRouter：通过 onPageLoad / onBeforeSwap 管理生命周期与 Observer；
 * · 支持多种图表图样切换、多维度/时间范围/日期类型/文章类型/分类筛选；
 * · 严格过滤掉非文章路径，系列长文采用「主标题（导读）→ 下拉子级章节」展示；
 * · 响应式 SVG 根据真实容器宽度渲染（ResizeObserver），杜绝移动端溢出。
 */
import { onBeforeSwap, onPageLoad } from './pageload';
import {
  ApiError,
  clearSession,
  fetchMeta,
  fetchStats,
  getSession,
  onAuthChange,
  openLogin,
  showToast,
  type StatsPayload,
} from '../utils/site';
import {
  buildArticleStats,
  computeBreakdown,
  filterAndSortRanking,
  filterDailySeries,
  formatCompactNumber,
  formatPercent,
  selectVisibleTickIndices,
  type ArticleStatsSummary,
  type BreakdownChartKind,
  type BreakdownDimension,
  type BreakdownMetric,
  type DailyPoint,
  type DateRangeFilter,
  type DayTypeFilter,
  type RankingKindFilter,
  type RankingSort,
  type SeriesChildSort,
  type StatsCatalog,
  type TrendChartKind,
} from '../utils/stats-view';

const SVG_NS = 'http://www.w3.org/2000/svg';

const DONUT_PALETTE = [
  'oklch(var(--p))',
  'oklch(var(--s))',
  'oklch(var(--a))',
  'color-mix(in oklab, oklch(var(--p)) 62%, oklch(var(--bc)) 22%)',
  'color-mix(in oklab, oklch(var(--s)) 58%, oklch(var(--bc)) 24%)',
  'oklch(var(--bc) / 34%)',
];

interface StatsState {
  payload: StatsPayload | null;
  extraMeta: Record<string, { views: number; likes: number }>;
  summary: ArticleStatsSummary | null;
  trendKind: TrendChartKind;
  trendRange: DateRangeFilter;
  trendDayType: DayTypeFilter;
  selectedDate: string | null;
  bdKind: BreakdownChartKind;
  bdDim: BreakdownDimension;
  bdMetric: BreakdownMetric;
  selectedSliceKey: string | null;
  rankKind: RankingKindFilter;
  rankCategory: string;
  rankSort: RankingSort;
  rankChildSort: SeriesChildSort;
  rankQuery: string;
  onlyNonZero: boolean;
  expandedSeries: Set<string>;
}

const fmt = (value: number): string => Math.max(0, Math.round(value)).toLocaleString('zh-CN');

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

function niceCeil(raw: number): number {
  const n = Math.max(1, Math.ceil(raw));
  if (n <= 5) return Math.max(2, n);
  const mag = 10 ** Math.floor(Math.log10(n));
  const norm = n / mag;
  const step = norm <= 1.2 ? 1.2 : norm <= 1.5 ? 1.5 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 3 ? 3 : norm <= 4 ? 4 : norm <= 5 ? 5 : norm <= 6 ? 6 : norm <= 8 ? 8 : 10;
  return Math.ceil(step * mag);
}

function createIcon(pathD: string, className = 'h-3.5 w-3.5'): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  svg.setAttribute('class', className);
  svg.appendChild(svgEl('path', { d: pathD }));
  return svg;
}

const CHEVRON_RIGHT_PATH = 'M9 18l6-6-6-6';
const DOC_ICON_PATH = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6';

let activeCleanup: (() => void) | null = null;
let authListenerBound = false;
let currentReload: (() => void) | null = null;

function readCatalog(): StatsCatalog {
  const el = document.getElementById('stats-catalog');
  if (!el?.textContent) return { posts: [], series: [] };
  try {
    const parsed = JSON.parse(el.textContent) as Partial<StatsCatalog>;
    return {
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      series: Array.isArray(parsed.series) ? parsed.series : [],
    };
  } catch {
    return { posts: [], series: [] };
  }
}

function initStatsPage(): void {
  activeCleanup?.();
  activeCleanup = null;

  const page = document.querySelector<HTMLElement>('[data-stats-page]');
  if (!page || page.dataset.init === '1') return;
  page.dataset.init = '1';

  const gate = page.querySelector<HTMLElement>('[data-stats-gate]');
  const gateMsg = page.querySelector<HTMLElement>('[data-stats-gate-msg]');
  const loginBtn = page.querySelector<HTMLButtonElement>('[data-stats-login]');
  const body = page.querySelector<HTMLElement>('[data-stats-body]');
  const metaEl = page.querySelector<HTMLElement>('[data-stats-meta]');
  const actionsEl = page.querySelector<HTMLElement>('[data-stats-actions]');
  const refreshBtn = page.querySelector<HTMLButtonElement>('[data-stats-refresh]');

  const kpiEls = {
    totalViews: page.querySelector<HTMLElement>('[data-kpi="totalViews"]'),
    totalViewsSub: page.querySelector<HTMLElement>('[data-kpi-sub="totalViews"]'),
    todayViews: page.querySelector<HTMLElement>('[data-kpi="todayViews"]'),
    todayViewsSub: page.querySelector<HTMLElement>('[data-kpi-sub="todayViews"]'),
    totalLikes: page.querySelector<HTMLElement>('[data-kpi="totalLikes"]'),
    totalLikesSub: page.querySelector<HTMLElement>('[data-kpi-sub="totalLikes"]'),
    dailyAvg: page.querySelector<HTMLElement>('[data-kpi="dailyAvg"]'),
    dailyAvgSub: page.querySelector<HTMLElement>('[data-kpi-sub="dailyAvg"]'),
  };

  const trendSub = page.querySelector<HTMLElement>('[data-trend-sub]');
  const trendReadout = page.querySelector<HTMLElement>('[data-trend-readout]');
  const trendStage = page.querySelector<HTMLElement>('[data-trend-stage]');
  const trendSummary = page.querySelector<HTMLElement>('[data-trend-summary]');
  const trendAllRangeBtn = page.querySelector<HTMLButtonElement>('[data-trend-range="all"]');

  const bdSub = page.querySelector<HTMLElement>('[data-bd-sub]');
  const bdStage = page.querySelector<HTMLElement>('[data-bd-stage]');
  const bdNote = page.querySelector<HTMLElement>('[data-bd-note]');
  const bdSummary = page.querySelector<HTMLElement>('[data-bd-summary]');

  const rankSub = page.querySelector<HTMLElement>('[data-rank-sub]');
  const rankList = page.querySelector<HTMLElement>('[data-rank-list]');
  const rankCatSelect = page.querySelector<HTMLSelectElement>('[data-rank-category]');
  const rankSortSelect = page.querySelector<HTMLSelectElement>('[data-rank-sort]');
  const rankSearchInput = page.querySelector<HTMLInputElement>('[data-rank-search]');
  const rankNonZeroBtn = page.querySelector<HTMLButtonElement>('[data-rank-nonzero]');
  const rankExpandAllBtn = page.querySelector<HTMLButtonElement>('[data-rank-expand-all]');

  if (!gate || !body || !trendStage || !bdStage || !rankList) return;

  const catalog = readCatalog();

  const state: StatsState = {
    payload: null,
    extraMeta: {},
    summary: null,
    trendKind: 'bar',
    trendRange: '14d',
    trendDayType: 'all',
    selectedDate: null,
    bdKind: 'donut',
    bdDim: 'category',
    bdMetric: 'views',
    selectedSliceKey: null,
    rankKind: 'all',
    rankCategory: 'all',
    rankSort: 'views',
    rankChildSort: 'rank',
    rankQuery: '',
    onlyNonZero: false,
    expandedSeries: new Set<string>(),
  };

  let lastTrendWidth = 0;
  let resizeTimer: number | undefined;
  let aborted = false;

  const setPressedGroup = (selector: string, attr: string, value: string): void => {
    for (const btn of page.querySelectorAll<HTMLButtonElement>(selector)) {
      const match = btn.getAttribute(attr) === value;
      btn.setAttribute('aria-pressed', String(match));
    }
  };

  const showGate = (message = '需要登录站长 GitHub 账号才能查看统计。', withButton = true): void => {
    gate.hidden = false;
    body.hidden = true;
    if (actionsEl) actionsEl.hidden = true;
    if (refreshBtn) refreshBtn.hidden = true;
    if (gateMsg) gateMsg.textContent = message;
    if (loginBtn) loginBtn.hidden = !withButton;
  };

  const showBody = (): void => {
    gate.hidden = true;
    body.hidden = false;
    if (actionsEl) actionsEl.hidden = false;
    if (refreshBtn) refreshBtn.hidden = false;
  };

  /** 同步 4 枚总览指标卡 */
  const renderKpis = (): void => {
    const data = state.payload;
    const summary = state.summary;
    if (!data || !summary) return;

    const articleViews = summary.totalArticleViews;
    const articleLikes = summary.totalArticleLikes;
    const articleShare = data.totalViews > 0 ? articleViews / data.totalViews : 0;

    if (kpiEls.totalViews) kpiEls.totalViews.textContent = fmt(data.totalViews);
    if (kpiEls.totalViewsSub) {
      kpiEls.totalViewsSub.textContent = `文章合计 ${fmt(articleViews)} · 占全站 ${formatPercent(articleShare)}`;
    }

    const daily = data.daily;
    const prevDay = daily.length >= 2 ? daily[daily.length - 2] : undefined;
    const delta = prevDay ? data.todayViews - prevDay.views : null;
    if (kpiEls.todayViews) kpiEls.todayViews.textContent = fmt(data.todayViews);
    if (kpiEls.todayViewsSub) {
      const deltaText =
        delta === null
          ? '暂无昨日对比'
          : delta > 0
            ? `较昨日 +${fmt(delta)}`
            : delta < 0
              ? `较昨日 -${fmt(Math.abs(delta))}`
              : '与昨日持平';
      const windowSum = daily.reduce((s, d) => s + d.views, 0);
      const todayPct = windowSum > 0 ? formatPercent(data.todayViews / windowSum) : '0%';
      kpiEls.todayViewsSub.textContent = `${deltaText} · 占近 ${daily.length} 日 ${todayPct}`;
    }

    if (kpiEls.totalLikes) kpiEls.totalLikes.textContent = fmt(data.totalLikes);
    if (kpiEls.totalLikesSub) {
      const rate = articleViews > 0 ? formatPercent(articleLikes / articleViews) : '0%';
      kpiEls.totalLikesSub.textContent = `文章获赞 ${fmt(articleLikes)} · 赞读比 ${rate}`;
    }

    const activeWindow = filterDailySeries(data.daily, state.trendRange, state.trendDayType, data.generatedAt);
    const wSum = activeWindow.reduce((s, d) => s + d.views, 0);
    const wAvg = activeWindow.length > 0 ? wSum / activeWindow.length : 0;
    const peak = activeWindow.reduce<DailyPoint | null>(
      (best, cur) => (!best || cur.views > best.views ? cur : best),
      null,
    );
    if (kpiEls.dailyAvg) {
      kpiEls.dailyAvg.textContent = wAvg >= 100 ? fmt(wAvg) : wAvg.toFixed(1).replace(/\.0$/, '');
    }
    if (kpiEls.dailyAvgSub) {
      kpiEls.dailyAvgSub.textContent = peak
        ? `当前筛选峰值 ${fmt(peak.views)}（${peak.shortDate}）`
        : '当前筛选下无数据';
    }
  };

  /** 更新日期读数条 */
  const updateTrendReadout = (points: DailyPoint[]): void => {
    if (!trendReadout) return;
    trendReadout.textContent = '';

    if (!points.length) {
      const empty = document.createElement('span');
      empty.className = 'text-base-content/50';
      empty.textContent = '当前筛选条件下没有可展示的日期数据';
      trendReadout.appendChild(empty);
      return;
    }

    const active =
      (state.selectedDate && points.find((p) => p.date === state.selectedDate)) ||
      points.find((p) => p.isToday) ||
      points[points.length - 1]!;

    state.selectedDate = active.date;

    const left = document.createElement('div');
    left.className = 'st-readout__left';
    const dateSpan = document.createElement('span');
    dateSpan.textContent = `${active.date}（${active.weekdayLabel}）`;
    const badge = document.createElement('span');
    badge.className = `st-readout__badge ${active.isToday ? 'st-readout__badge--today' : 'st-readout__badge--past'}`;
    badge.textContent = active.isToday ? '今日' : '往日';
    left.appendChild(dateSpan);
    left.appendChild(badge);

    const right = document.createElement('div');
    right.className = 'st-readout__right';

    const valWrap = document.createElement('span');
    valWrap.append('当日 ');
    const valStrong = document.createElement('strong');
    valStrong.className = 'st-readout__val';
    valStrong.textContent = fmt(active.views);
    valWrap.appendChild(valStrong);
    valWrap.append(' 次');

    const extra = document.createElement('span');
    if (state.trendKind === 'cumulative') {
      extra.textContent = `累计 ${fmt(active.cumulative)} 次`;
    } else {
      const deltaTxt =
        active.deltaFromPrev === null
          ? ''
          : active.deltaFromPrev > 0
            ? ` · 较前项 +${fmt(active.deltaFromPrev)}`
            : active.deltaFromPrev < 0
              ? ` · 较前项 -${fmt(Math.abs(active.deltaFromPrev))}`
              : ' · 较前项持平';
      extra.textContent = `占比 ${formatPercent(active.share)}${deltaTxt}`;
    }

    right.appendChild(valWrap);
    right.appendChild(extra);

    trendReadout.appendChild(left);
    trendReadout.appendChild(right);

    for (const col of trendStage.querySelectorAll<HTMLElement | SVGGElement>('[data-date-key]')) {
      const match = col.getAttribute('data-date-key') === active.date;
      col.classList.toggle('is-active', match);
    }
  };

  /** 绘制日期趋势图（柱状 / 折线面积 / 日历热力 / 累计） */
  const renderTrendChart = (): void => {
    const data = state.payload;
    if (!data) return;

    const points = filterDailySeries(data.daily, state.trendRange, state.trendDayType, data.generatedAt);
    const allInWindow = filterDailySeries(data.daily, state.trendRange, 'all', data.generatedAt);

    if (trendSub) {
      const rangeLabel =
        state.trendRange === '7d'
          ? '近 7 天'
          : state.trendRange === '14d'
            ? '近 14 天'
            : `近 ${data.daily.length} 天`;
      const dayLabel =
        state.trendDayType === 'weekday'
          ? ' · 仅工作日'
          : state.trendDayType === 'weekend'
            ? ' · 仅周末'
            : '';
      trendSub.textContent = `${rangeLabel}${dayLabel} · 今日加深、往日较浅`;
    }

    if (trendSummary) {
      const sum = points.reduce((acc, p) => acc + p.views, 0);
      const avg = points.length > 0 ? sum / points.length : 0;
      trendSummary.textContent = `周期合计 ${fmt(sum)} · 日均 ${avg.toFixed(1).replace(/\.0$/, '')}`;
    }

    trendStage.textContent = '';

    // 热力图用 7 列周历对齐，不受 SVG 测量宽度限制
    if (state.trendKind === 'heatmap') {
      renderHeatmap(allInWindow);
      updateTrendReadout(points);
      return;
    }

    if (!points.length) {
      const empty = document.createElement('div');
      empty.className = 'st-empty';
      empty.textContent = '当前筛选条件没有匹配的日期数据';
      trendStage.appendChild(empty);
      updateTrendReadout(points);
      return;
    }

    const W = Math.max(240, Math.floor(trendStage.clientWidth || 320));
    lastTrendWidth = W;
    const H = W < 440 ? 196 : 220;
    const isCumulative = state.trendKind === 'cumulative';
    const rawMax = Math.max(1, ...points.map((p) => (isCumulative ? p.cumulative : p.views)));
    const maxY = niceCeil(rawMax);
    const padL = formatCompactNumber(maxY).length >= 4 ? 38 : 32;
    const padR = 18;
    const padT = 20;
    const padB = 26;
    const plotW = Math.max(120, W - padL - padR);
    const plotH = Math.max(80, H - padT - padB);

    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': '日期阅读趋势图',
    });

    // Y 轴参考线（0、1/2、maxY）
    const ticksY = [0, maxY / 2, maxY];
    for (const val of ticksY) {
      const y = padT + plotH - (val / maxY) * plotH;
      svg.appendChild(
        svgEl('line', {
          x1: padL,
          y1: y.toFixed(1),
          x2: W - padR,
          y2: y.toFixed(1),
          class: 'st-grid-line',
        }),
      );
      const label = svgEl('text', {
        x: padL - 6,
        y: (y + 3).toFixed(1),
        'text-anchor': 'end',
        class: 'st-axis-y',
      });
      label.textContent = formatCompactNumber(val);
      svg.appendChild(label);
    }

    // 日均虚线（柱状图 & 折线图展示）
    if (!isCumulative) {
      const avg = points.reduce((s, p) => s + p.views, 0) / points.length;
      if (avg > 0 && avg < maxY) {
        const avgY = padT + plotH - (avg / maxY) * plotH;
        svg.appendChild(
          svgEl('line', {
            x1: padL,
            y1: avgY.toFixed(1),
            x2: W - padR,
            y2: avgY.toFixed(1),
            class: 'st-avg-line',
          }),
        );
      }
    }

    const visibleTicks = selectVisibleTickIndices(points, plotW, W < 400 ? 50 : 44);
    const slotW = plotW / points.length;

    const bindDayGroup = (g: SVGGElement, p: DailyPoint) => {
      const activate = () => {
        state.selectedDate = p.date;
        updateTrendReadout(points);
      };
      g.addEventListener('pointerenter', activate);
      g.addEventListener('click', activate);
      g.addEventListener('focusin', activate);
    };

    if (state.trendKind === 'bar' || state.trendKind === 'cumulative') {
      const barW = Math.max(4, Math.min(28, slotW * 0.62));
      const lineCoords: Array<{ x: number; y: number; p: DailyPoint }> = [];

      points.forEach((p, idx) => {
        const val = isCumulative ? p.cumulative : p.views;
        const slotX = padL + idx * slotW;
        const cx = slotX + slotW / 2;
        const barX = cx - barW / 2;
        const barH = val > 0 ? Math.max(4, (val / maxY) * plotH) : 2;
        const barY = padT + plotH - barH;
        lineCoords.push({ x: cx, y: barY, p });

        const g = svgEl('g', {
          class: 'st-day-col',
          'data-date-key': p.date,
        });

        g.appendChild(
          svgEl('rect', {
            x: slotX.toFixed(1),
            y: padT,
            width: slotW.toFixed(1),
            height: plotH,
            rx: 4,
            class: 'st-guide-beam',
          }),
        );

        g.appendChild(
          svgEl('rect', {
            x: barX.toFixed(1),
            y: barY.toFixed(1),
            width: barW.toFixed(1),
            height: barH.toFixed(1),
            rx: Math.min(4, barW / 2).toFixed(1),
            class: p.isToday ? 'st-bar-today' : 'st-bar-past',
          }),
        );

        if (p.isToday) {
          const valLbl = svgEl('text', {
            x: cx.toFixed(1),
            y: Math.max(11, barY - 5).toFixed(1),
            'text-anchor': 'middle',
            class: 'st-axis-x st-axis-x--today',
          });
          valLbl.textContent = formatCompactNumber(val);
          g.appendChild(valLbl);
        }

        if (visibleTicks.has(idx)) {
          const tick = svgEl('text', {
            x: cx.toFixed(1),
            y: H - 6,
            'text-anchor': 'middle',
            class: p.isToday ? 'st-axis-x st-axis-x--today' : 'st-axis-x',
          });
          tick.textContent = p.isToday ? '今日' : p.shortDate;
          g.appendChild(tick);
        }

        const hit = svgEl('rect', {
          x: slotX.toFixed(1),
          y: padT,
          width: slotW.toFixed(1),
          height: plotH,
          tabindex: 0,
          role: 'button',
          'aria-label': `${p.date} ${p.isToday ? '今日' : p.weekdayLabel} ${val} 次阅读`,
          class: 'st-hit-rect',
        });
        g.appendChild(hit);
        bindDayGroup(g, p);
        svg.appendChild(g);
      });

      // 累计视图叠加一条细连线增强递进感
      if (isCumulative && lineCoords.length >= 2) {
        const dPast = lineCoords
          .slice(0, Math.max(1, lineCoords.length - (lineCoords[lineCoords.length - 1]!.p.isToday ? 1 : 0)))
          .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
          .join(' ');
        if (dPast) {
          svg.appendChild(svgEl('path', { d: dPast, class: 'st-line-past' }));
        }
        const last = lineCoords[lineCoords.length - 1]!;
        const prev = lineCoords[lineCoords.length - 2]!;
        if (last.p.isToday) {
          svg.appendChild(
            svgEl('path', {
              d: `M${prev.x.toFixed(1)},${prev.y.toFixed(1)} L${last.x.toFixed(1)},${last.y.toFixed(1)}`,
              class: 'st-line-today',
            }),
          );
          svg.appendChild(svgEl('circle', { cx: last.x.toFixed(1), cy: last.y.toFixed(1), r: 7, class: 'st-dot-today-halo' }));
          svg.appendChild(svgEl('circle', { cx: last.x.toFixed(1), cy: last.y.toFixed(1), r: 3.5, class: 'st-dot-today' }));
        }
      }
    } else {
      // 折线面积图
      const gradId = `st-area-grad-${Math.random().toString(36).slice(2, 7)}`;
      const defs = svgEl('defs');
      const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
      grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'oklch(var(--p))', 'stop-opacity': '0.24' }));
      grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': 'oklch(var(--p))', 'stop-opacity': '0.01' }));
      defs.appendChild(grad);
      svg.appendChild(defs);

      const insetX = Math.min(12, slotW / 2);
      const innerW = Math.max(20, plotW - insetX * 2);
      const coords = points.map((p, idx) => {
        const x =
          points.length === 1
            ? padL + plotW / 2
            : padL + insetX + (idx / (points.length - 1)) * innerW;
        const y = padT + plotH - (p.views / maxY) * plotH;
        return { x, y, p };
      });

      const baseLineY = padT + plotH;
      const areaPath =
        coords.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ') +
        ` L${coords[coords.length - 1]!.x.toFixed(1)},${baseLineY.toFixed(1)} L${coords[0]!.x.toFixed(1)},${baseLineY.toFixed(1)} Z`;

      svg.appendChild(svgEl('path', { d: areaPath, fill: `url(#${gradId})` }));

      if (coords.length >= 2) {
        const lastIsToday = coords[coords.length - 1]!.p.isToday;
        const pastEnd = lastIsToday ? coords.length - 1 : coords.length;
        if (pastEnd >= 2) {
          const pastD = coords
            .slice(0, pastEnd)
            .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
            .join(' ');
          svg.appendChild(svgEl('path', { d: pastD, class: 'st-line-past' }));
        }
        if (lastIsToday) {
          const prev = coords[coords.length - 2]!;
          const cur = coords[coords.length - 1]!;
          svg.appendChild(
            svgEl('path', {
              d: `M${prev.x.toFixed(1)},${prev.y.toFixed(1)} L${cur.x.toFixed(1)},${cur.y.toFixed(1)}`,
              class: 'st-line-today',
            }),
          );
        }
      }

      coords.forEach((pt, idx) => {
        const slotX = padL + idx * slotW;
        const g = svgEl('g', {
          class: 'st-day-col',
          'data-date-key': pt.p.date,
        });

        g.appendChild(
          svgEl('rect', {
            x: slotX.toFixed(1),
            y: padT,
            width: slotW.toFixed(1),
            height: plotH,
            rx: 4,
            class: 'st-guide-beam',
          }),
        );

        if (pt.p.isToday) {
          g.appendChild(svgEl('circle', { cx: pt.x.toFixed(1), cy: pt.y.toFixed(1), r: 8, class: 'st-dot-today-halo' }));
          g.appendChild(svgEl('circle', { cx: pt.x.toFixed(1), cy: pt.y.toFixed(1), r: 4, class: 'st-dot-today' }));
          const valLbl = svgEl('text', {
            x: pt.x.toFixed(1),
            y: Math.max(11, pt.y - 8).toFixed(1),
            'text-anchor': 'middle',
            class: 'st-axis-x st-axis-x--today',
          });
          valLbl.textContent = formatCompactNumber(pt.p.views);
          g.appendChild(valLbl);
        } else {
          g.appendChild(svgEl('circle', { cx: pt.x.toFixed(1), cy: pt.y.toFixed(1), r: 3, class: 'st-dot-past' }));
        }

        if (visibleTicks.has(idx)) {
          const tick = svgEl('text', {
            x: pt.x.toFixed(1),
            y: H - 6,
            'text-anchor': 'middle',
            class: pt.p.isToday ? 'st-axis-x st-axis-x--today' : 'st-axis-x',
          });
          tick.textContent = pt.p.isToday ? '今日' : pt.p.shortDate;
          g.appendChild(tick);
        }

        g.appendChild(
          svgEl('rect', {
            x: slotX.toFixed(1),
            y: padT,
            width: slotW.toFixed(1),
            height: plotH,
            tabindex: 0,
            role: 'button',
            'aria-label': `${pt.p.date} ${pt.p.isToday ? '今日' : pt.p.weekdayLabel} ${pt.p.views} 次阅读`,
            class: 'st-hit-rect',
          }),
        );
        bindDayGroup(g, pt.p);
        svg.appendChild(g);
      });
    }

    trendStage.appendChild(svg);
    updateTrendReadout(points);
  };

  /** 绘制 7 列周历热力图（周一至周日对齐，今日深色实心，往日较浅） */
  const renderHeatmap = (allInWindow: DailyPoint[]): void => {
    if (!allInWindow.length) {
      const empty = document.createElement('div');
      empty.className = 'st-empty';
      empty.textContent = '暂无每日趋势数据';
      trendStage.appendChild(empty);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'st-heatmap';

    const wdRow = document.createElement('div');
    wdRow.className = 'st-heatmap__weekdays';
    for (const label of ['一', '二', '三', '四', '五', '六', '日']) {
      const cell = document.createElement('div');
      cell.className = 'st-heatmap__wd';
      cell.textContent = label;
      wdRow.appendChild(cell);
    }
    wrap.appendChild(wdRow);

    const grid = document.createElement('div');
    grid.className = 'st-heatmap__grid';

    const leadingPads = allInWindow[0]!.weekdayIndex;
    for (let i = 0; i < leadingPads; i++) {
      const pad = document.createElement('div');
      pad.className = 'st-heat-cell st-heat-cell--pad';
      pad.setAttribute('aria-hidden', 'true');
      grid.appendChild(pad);
    }

    const pastMax = Math.max(
      1,
      ...allInWindow.filter((p) => !p.isToday).map((p) => p.views),
    );

    const matchingPoints = allInWindow.filter((p) => {
      if (state.trendDayType === 'weekday') return !p.isWeekend;
      if (state.trendDayType === 'weekend') return p.isWeekend;
      return true;
    });

    for (const p of allInWindow) {
      const matchesFilter =
        state.trendDayType === 'all' ||
        (state.trendDayType === 'weekday' ? !p.isWeekend : p.isWeekend);

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.setAttribute('data-date-key', p.date);
      cell.setAttribute('aria-label', `${p.date} ${p.isToday ? '今日' : p.weekdayLabel} ${p.views} 次阅读`);

      let levelClass = 'st-heat-cell--lvl-0';
      if (p.isToday) {
        levelClass = 'st-heat-cell--today';
      } else if (p.views > 0) {
        const ratio = p.views / pastMax;
        levelClass =
          ratio >= 0.75
            ? 'st-heat-cell--lvl-4'
            : ratio >= 0.45
              ? 'st-heat-cell--lvl-3'
              : ratio >= 0.2
                ? 'st-heat-cell--lvl-2'
                : 'st-heat-cell--lvl-1';
      }

      cell.className = `st-heat-cell ${levelClass}${matchesFilter ? '' : ' st-heat-cell--muted'}`;

      const dateSpan = document.createElement('span');
      dateSpan.className = 'st-heat-cell__date';
      dateSpan.textContent = p.isToday ? '今日' : `${Number(p.dayNum)}日`;

      const valSpan = document.createElement('span');
      valSpan.className = 'st-heat-cell__val';
      valSpan.textContent = formatCompactNumber(p.views);

      cell.appendChild(dateSpan);
      cell.appendChild(valSpan);

      if (matchesFilter) {
        const activate = () => {
          state.selectedDate = p.date;
          updateTrendReadout(matchingPoints);
        };
        cell.addEventListener('pointerenter', activate);
        cell.addEventListener('click', activate);
      }

      grid.appendChild(cell);
    }

    const trailingPads = (7 - ((leadingPads + allInWindow.length) % 7)) % 7;
    for (let i = 0; i < trailingPads; i++) {
      const pad = document.createElement('div');
      pad.className = 'st-heat-cell st-heat-cell--pad';
      pad.setAttribute('aria-hidden', 'true');
      grid.appendChild(pad);
    }

    wrap.appendChild(grid);
    trendStage.appendChild(wrap);
  };

  /** 绘制多维透视区（环形占比 / 横向条形 / 赞读对比） */
  const renderBreakdown = (): void => {
    const data = state.payload;
    const summary = state.summary;
    if (!data || !summary) return;

    const isWeekdayDim = state.bdDim === 'weekday';
    for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-bd-metric]')) {
      const m = btn.getAttribute('data-bd-metric');
      btn.disabled = isWeekdayDim && m === 'likes';
    }
    if (isWeekdayDim && state.bdMetric === 'likes') {
      state.bdMetric = 'views';
      setPressedGroup('[data-bd-metric]', 'data-bd-metric', 'views');
    }

    const items = computeBreakdown(summary, data.daily, state.bdDim, state.bdMetric);
    const metricLabel = state.bdMetric === 'likes' && !isWeekdayDim ? '点赞' : '阅读';

    if (bdSub) {
      const dimMap: Record<BreakdownDimension, string> = {
        category: '按文章分类分布',
        shape: '导读 · 章节 · 单篇构成',
        chapters: '系列章节热度 Top 10',
        weekday: '近周期周一至周日分布',
      };
      bdSub.textContent = `${dimMap[state.bdDim]}（${metricLabel}）`;
    }

    if (bdNote) {
      bdNote.textContent = isWeekdayDim
        ? '统计近周期全站每日阅读按星期聚合'
        : '仅统计站内文章（已过滤动态与杂项）';
    }

    if (bdSummary) {
      const total = items.reduce((s, item) => s + item.value, 0);
      bdSummary.textContent = `共 ${items.length} 项 · 合计 ${fmt(total)} ${metricLabel}`;
    }

    bdStage.textContent = '';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'st-empty';
      empty.textContent = '当前维度下暂无可展示数据';
      bdStage.appendChild(empty);
      return;
    }

    if (state.bdKind === 'donut') {
      const donutItems =
        items.length > 6
          ? [
              ...items.slice(0, 5),
              (() => {
                const rest = items.slice(5);
                const views = rest.reduce((s, r) => s + r.views, 0);
                const likes = rest.reduce((s, r) => s + r.likes, 0);
                const value = rest.reduce((s, r) => s + r.value, 0);
                const share = rest.reduce((s, r) => s + r.share, 0);
                return {
                  key: '__other__',
                  label: `其余 ${rest.length} 项`,
                  sublabel: '',
                  views,
                  likes,
                  count: rest.length,
                  value,
                  share,
                  likeRate: views > 0 ? likes / views : 0,
                };
              })(),
            ]
          : items;

      const totalVal = donutItems.reduce((s, item) => s + item.value, 0);
      const wrap = document.createElement('div');
      wrap.className = 'st-donut-wrap';

      const svgBox = document.createElement('div');
      svgBox.className = 'st-donut-svg-box';

      const svg = svgEl('svg', {
        viewBox: '0 0 160 160',
        role: 'img',
        'aria-label': '占比环形图',
      });

      const r = 58;
      const circ = 2 * Math.PI * r;
      svg.appendChild(
        svgEl('circle', {
          cx: 80,
          cy: 80,
          r,
          fill: 'none',
          stroke: 'oklch(var(--bc) / 7%)',
          'stroke-width': 18,
        }),
      );

      const centerBox = document.createElement('div');
      centerBox.className = 'st-donut-center';
      const centerVal = document.createElement('span');
      centerVal.className = 'st-donut-center__val';
      centerVal.textContent = formatCompactNumber(totalVal);
      const centerLbl = document.createElement('span');
      centerLbl.className = 'st-donut-center__lbl';
      centerLbl.textContent = `总${metricLabel}`;
      centerBox.appendChild(centerVal);
      centerBox.appendChild(centerLbl);

      const legend = document.createElement('ul');
      legend.className = 'st-donut-legend';

      const highlightSlice = (key: string | null) => {
        state.selectedSliceKey = key;
        const found = key ? donutItems.find((d) => d.key === key) : null;
        centerVal.textContent = found ? formatCompactNumber(found.value) : formatCompactNumber(totalVal);
        centerLbl.textContent = found ? found.label : `总${metricLabel}`;

        for (const li of legend.querySelectorAll<HTMLElement>('[data-slice-key]')) {
          li.classList.toggle('is-active', li.getAttribute('data-slice-key') === key);
        }
        for (const seg of svg.querySelectorAll<SVGCircleElement>('[data-slice-key]')) {
          const segKey = seg.getAttribute('data-slice-key');
          seg.style.opacity = !key || segKey === key ? '1' : '0.38';
        }
      };

      let offsetAcc = 0;
      donutItems.forEach((item, idx) => {
        const color = DONUT_PALETTE[idx % DONUT_PALETTE.length]!;
        if (totalVal > 0 && item.value > 0) {
          const dashLen = Math.max(2, (item.value / totalVal) * circ - (donutItems.length > 1 ? 2 : 0));
          const seg = svgEl('circle', {
            cx: 80,
            cy: 80,
            r,
            fill: 'none',
            stroke: color,
            'stroke-width': 18,
            'stroke-dasharray': `${dashLen.toFixed(2)} ${circ.toFixed(2)}`,
            'stroke-dashoffset': (-offsetAcc).toFixed(2),
            transform: 'rotate(-90 80 80)',
            'data-slice-key': item.key,
          });
          seg.style.cursor = 'pointer';
          seg.style.transition = 'opacity 160ms ease';
          seg.addEventListener('pointerenter', () => highlightSlice(item.key));
          seg.addEventListener('click', () =>
            highlightSlice(state.selectedSliceKey === item.key ? null : item.key),
          );
          svg.appendChild(seg);
          offsetAcc += (item.value / totalVal) * circ;
        }

        const li = document.createElement('li');
        li.className = 'st-donut-item';
        li.setAttribute('data-slice-key', item.key);

        const dot = document.createElement('span');
        dot.className = 'st-donut-dot';
        dot.style.backgroundColor = color;

        const name = document.createElement('span');
        name.className = 'st-donut-name';
        name.textContent = item.label;
        name.title = item.label;

        const val = document.createElement('span');
        val.className = 'st-donut-val';
        val.textContent = fmt(item.value);

        const pct = document.createElement('span');
        pct.className = 'st-donut-pct';
        pct.textContent = formatPercent(item.share);

        li.appendChild(dot);
        li.appendChild(name);
        li.appendChild(val);
        li.appendChild(pct);

        li.addEventListener('pointerenter', () => highlightSlice(item.key));
        li.addEventListener('click', () =>
          highlightSlice(state.selectedSliceKey === item.key ? null : item.key),
        );
        legend.appendChild(li);
      });

      svgBox.addEventListener('pointerleave', () => highlightSlice(null));
      legend.addEventListener('pointerleave', () => highlightSlice(null));

      svgBox.appendChild(svg);
      svgBox.appendChild(centerBox);
      wrap.appendChild(svgBox);
      wrap.appendChild(legend);
      bdStage.appendChild(wrap);
      return;
    }

    // 横向条形图 或 赞读对比图
    const list = document.createElement('div');
    list.className = 'st-hbars';
    const maxPrimary = Math.max(1, ...items.map((i) => i.value));
    const maxViews = Math.max(1, ...items.map((i) => i.views));
    const maxLikes = Math.max(1, ...items.map((i) => i.likes));

    items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'st-hbar-row';

      const head = document.createElement('div');
      head.className = 'st-hbar-head';

      const lbl = document.createElement('span');
      lbl.className = 'st-hbar-label';
      lbl.textContent = item.label;
      lbl.title = item.sublabel ? `${item.label}（${item.sublabel}）` : item.label;

      const nums = document.createElement('span');
      nums.className = 'st-hbar-nums';

      if (state.bdKind === 'compare' && !isWeekdayDim) {
        const strongV = document.createElement('strong');
        strongV.textContent = `${fmt(item.views)} 阅`;
        const likesSpan = document.createElement('span');
        likesSpan.textContent = `· ${fmt(item.likes)} 赞 · ${formatPercent(item.likeRate)}`;
        nums.appendChild(strongV);
        nums.appendChild(likesSpan);
      } else {
        const strong = document.createElement('strong');
        strong.textContent = fmt(item.value);
        const pct = document.createElement('span');
        pct.textContent = formatPercent(item.share);
        nums.appendChild(strong);
        nums.appendChild(pct);
      }

      head.appendChild(lbl);
      head.appendChild(nums);
      row.appendChild(head);

      if (state.bdKind === 'compare' && !isWeekdayDim) {
        const dual = document.createElement('div');
        dual.className = 'st-hbar-dual';

        const trackV = document.createElement('div');
        trackV.className = 'st-hbar-track';
        const fillV = document.createElement('div');
        fillV.className = 'st-hbar-fill';
        fillV.style.width = `${item.views > 0 ? Math.max(3, (item.views / maxViews) * 100) : 0}%`;
        trackV.appendChild(fillV);

        const trackL = document.createElement('div');
        trackL.className = 'st-hbar-track';
        const fillL = document.createElement('div');
        fillL.className = 'st-hbar-fill st-hbar-fill--secondary';
        fillL.style.width = `${item.likes > 0 ? Math.max(3, (item.likes / maxLikes) * 100) : 0}%`;
        trackL.appendChild(fillL);

        dual.appendChild(trackV);
        dual.appendChild(trackL);
        row.appendChild(dual);
      } else {
        const track = document.createElement('div');
        track.className = 'st-hbar-track';
        const fill = document.createElement('div');
        fill.className = 'st-hbar-fill';
        fill.style.backgroundColor = DONUT_PALETTE[idx % DONUT_PALETTE.length]!;
        fill.style.width = `${item.value > 0 ? Math.max(3, (item.value / maxPrimary) * 100) : 0}%`;
        track.appendChild(fill);
        row.appendChild(track);
      }

      list.appendChild(row);
    });

    bdStage.appendChild(list);
  };

  /** 渲染分类选项 */
  const syncCategoryOptions = (): void => {
    const summary = state.summary;
    if (!rankCatSelect || !summary) return;
    const prev = state.rankCategory;
    rankCatSelect.textContent = '';

    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = '全部分类';
    rankCatSelect.appendChild(allOpt);

    for (const cat of summary.categories) {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      rankCatSelect.appendChild(opt);
    }

    rankCatSelect.value = summary.categories.includes(prev) ? prev : 'all';
    state.rankCategory = rankCatSelect.value;
  };

  /** 渲染文章排行（仅文章 + 系列导读下拉子级） */
  const renderRanking = (): void => {
    const summary = state.summary;
    if (!summary) return;

    const rows = filterAndSortRanking(summary.entries, {
      kind: state.rankKind,
      category: state.rankCategory,
      sort: state.rankSort,
      childSort: state.rankChildSort,
      query: state.rankQuery,
      onlyNonZero: state.onlyNonZero,
    });

    const visibleSeries = rows.filter((r) => r.kind === 'series');
    const allExpanded =
      visibleSeries.length > 0 &&
      visibleSeries.every((s) => s.autoExpand || state.expandedSeries.has(s.id));

    if (rankExpandAllBtn) {
      rankExpandAllBtn.hidden = visibleSeries.length === 0;
      rankExpandAllBtn.textContent = allExpanded ? '收起全部系列' : '展开全部系列';
    }

    if (rankSub) {
      const totalChapters = visibleSeries.reduce((acc, s) => acc + s.totalChapters, 0);
      rankSub.textContent = `仅保留站内文章 · 当前 ${rows.length} 条主项${
        visibleSeries.length ? `（含 ${visibleSeries.length} 个系列共 ${totalChapters} 章）` : ''
      }`;
    }

    rankList.textContent = '';

    if (!rows.length) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'st-empty';
      emptyLi.textContent = '没有符合当前筛选条件的文章';
      rankList.appendChild(emptyLi);
      return;
    }

    rows.forEach((entry, index) => {
      const li = document.createElement('li');
      li.className = 'st-rank-item';

      const row = document.createElement('div');
      row.className = 'st-rank-row';

      // 第 1 列：排名序号
      const idxCell = document.createElement('div');
      idxCell.className = 'st-rank-idx-cell';
      const idxBadge = document.createElement('span');
      idxBadge.className = `st-rank-idx${index < 3 ? ' st-rank-idx--top' : ''}`;
      idxBadge.textContent = String(index + 1);
      idxCell.appendChild(idxBadge);
      row.appendChild(idxCell);

      // 第 2 列：展开图标 / 文档图标 + 主标题 + 元信息 + 比例条
      const mainCell = document.createElement('div');
      mainCell.className = 'st-rank-main';

      const isSeries = entry.kind === 'series';
      const isExpanded = isSeries && (entry.autoExpand || state.expandedSeries.has(entry.id));

      let childrenPanel: HTMLDivElement | null = null;
      let toggleBtn: HTMLButtonElement | null = null;

      if (isSeries) {
        toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'st-rank-lead st-rank-toggle';
        toggleBtn.setAttribute('aria-expanded', String(isExpanded));
        toggleBtn.setAttribute('aria-label', `${isExpanded ? '收起' : '展开'}「${entry.title}」子级章节`);
        toggleBtn.appendChild(createIcon(CHEVRON_RIGHT_PATH, 'h-4 w-4'));
        mainCell.appendChild(toggleBtn);
      } else {
        const leadIcon = document.createElement('span');
        leadIcon.className = 'st-rank-lead';
        leadIcon.appendChild(createIcon(DOC_ICON_PATH, 'h-3.5 w-3.5'));
        mainCell.appendChild(leadIcon);
      }

      const titleCol = document.createElement('div');
      titleCol.className = 'st-rank-title-col';

      const titleLine = document.createElement('div');
      titleLine.className = 'st-rank-title-line';

      const link = document.createElement('a');
      link.className = 'st-rank-link';
      link.href = entry.path;
      link.textContent = entry.title;
      titleLine.appendChild(link);

      if (isSeries) {
        const badge = document.createElement('span');
        badge.className = 'st-rank-badge';
        badge.textContent = `系列导读 · ${entry.totalChapters} 章`;
        titleLine.appendChild(badge);
      }

      titleCol.appendChild(titleLine);

      const subLine = document.createElement('div');
      subLine.className = 'st-rank-sub';
      const cats = entry.categories.join(' / ');
      const rateTxt = entry.views > 0 ? ` · 赞读比 ${formatPercent(entry.likeRate)}` : '';
      subLine.textContent = `${entry.date} · ${cats} · ${formatCompactNumber(entry.words)} 字${rateTxt}`;
      titleCol.appendChild(subLine);

      const bar = document.createElement('div');
      bar.className = 'st-rank-bar';
      const barFill = document.createElement('span');
      barFill.style.width = `${Math.round(entry.barRatio * 100)}%`;
      bar.appendChild(barFill);
      titleCol.appendChild(bar);

      mainCell.appendChild(titleCol);
      row.appendChild(mainCell);

      // 第 3 列：阅读
      const viewsCell = document.createElement('div');
      viewsCell.className = 'st-rank-num-cell st-rank-metric';
      viewsCell.textContent = fmt(entry.views);
      row.appendChild(viewsCell);

      // 第 4 列：点赞
      const likesCell = document.createElement('div');
      likesCell.className = 'st-rank-num-cell st-rank-metric st-rank-metric--muted';
      likesCell.textContent = fmt(entry.likes);
      row.appendChild(likesCell);

      // 第 5 列：占比（桌面端）
      const shareCell = document.createElement('div');
      shareCell.className = 'st-rank-num-cell st-rank-share st-rank-col-share';
      shareCell.textContent = formatPercent(entry.totalShare);
      row.appendChild(shareCell);

      li.appendChild(row);

      // 系列长文的子级下拉容器
      if (isSeries) {
        childrenPanel = document.createElement('div');
        childrenPanel.className = 'st-rank-children';
        childrenPanel.hidden = !isExpanded;

        const childBar = document.createElement('div');
        childBar.className = 'st-rank-children__bar';
        const childLabel = document.createElement('span');
        childLabel.textContent = `导读与章节明细（共 ${entry.children.length} 项）`;

        const orderSeg = document.createElement('div');
        orderSeg.className = 'st-seg';
        const rankBtn = document.createElement('button');
        rankBtn.type = 'button';
        rankBtn.className = 'st-seg__item';
        rankBtn.textContent = '按热度';
        rankBtn.setAttribute('aria-pressed', String(state.rankChildSort === 'rank'));
        const seqBtn = document.createElement('button');
        seqBtn.type = 'button';
        seqBtn.className = 'st-seg__item';
        seqBtn.textContent = '按章节';
        seqBtn.setAttribute('aria-pressed', String(state.rankChildSort === 'order'));

        rankBtn.addEventListener('click', () => {
          state.rankChildSort = 'rank';
          renderRanking();
        });
        seqBtn.addEventListener('click', () => {
          state.rankChildSort = 'order';
          renderRanking();
        });

        orderSeg.appendChild(rankBtn);
        orderSeg.appendChild(seqBtn);
        childBar.appendChild(childLabel);
        childBar.appendChild(orderSeg);
        childrenPanel.appendChild(childBar);

        const childList = document.createElement('ol');
        childList.className = 'st-rank-children__list';

        for (const ch of entry.children) {
          const cLi = document.createElement('li');
          const isHit = Boolean(entry.matchedChildPaths?.has(ch.path));
          cLi.className = `st-rank-child${isHit ? ' is-hit' : ''}`;

          const cIndent = document.createElement('div');
          cIndent.className = 'st-rank-child__indent';
          cIndent.setAttribute('aria-hidden', 'true');
          cIndent.textContent = '└';
          cLi.appendChild(cIndent);

          const cMain = document.createElement('div');
          cMain.className = 'st-rank-child__main';

          const cBadge = document.createElement('span');
          cBadge.className = `st-rank-child__badge${ch.kind === 'guide' ? ' st-rank-child__badge--guide' : ''}`;
          cBadge.textContent = ch.badge;

          const cText = document.createElement('div');
          cText.className = 'st-rank-child__text';

          const cLink = document.createElement('a');
          cLink.className = 'st-rank-child__link';
          cLink.href = ch.path;
          cLink.textContent = ch.title;

          const cBar = document.createElement('div');
          cBar.className = 'st-rank-child__bar';
          const cFill = document.createElement('span');
          cFill.style.width = `${ch.seriesShare > 0 ? Math.max(3, Math.round(ch.seriesShare * 100)) : 0}%`;
          cBar.appendChild(cFill);

          cText.appendChild(cLink);
          cText.appendChild(cBar);

          cMain.appendChild(cBadge);
          cMain.appendChild(cText);
          cLi.appendChild(cMain);

          const cViews = document.createElement('div');
          cViews.className = 'st-rank-num-cell st-rank-metric';
          cViews.textContent = fmt(ch.views);
          cLi.appendChild(cViews);

          const cLikes = document.createElement('div');
          cLikes.className = 'st-rank-num-cell st-rank-metric st-rank-metric--muted';
          cLikes.textContent = fmt(ch.likes);
          cLi.appendChild(cLikes);

          const cShare = document.createElement('div');
          cShare.className = 'st-rank-num-cell st-rank-share st-rank-col-share';
          cShare.title = '占本系列阅读比例';
          cShare.textContent = formatPercent(ch.seriesShare);
          cLi.appendChild(cShare);

          childList.appendChild(cLi);
        }

        childrenPanel.appendChild(childList);
        li.appendChild(childrenPanel);

        if (toggleBtn && childrenPanel) {
          const panelRef = childrenPanel;
          const btnRef = toggleBtn;
          btnRef.addEventListener('click', () => {
            const next = panelRef.hidden;
            panelRef.hidden = !next;
            btnRef.setAttribute('aria-expanded', String(next));
            if (next) state.expandedSeries.add(entry.id);
            else state.expandedSeries.delete(entry.id);

            if (rankExpandAllBtn) {
              const nowAll = visibleSeries.every(
                (s) => s.autoExpand || state.expandedSeries.has(s.id),
              );
              rankExpandAllBtn.textContent = nowAll ? '收起全部系列' : '展开全部系列';
            }
          });
        }
      }

      rankList.appendChild(li);
    });
  };

  /** 全量重算并渲染 */
  const renderAll = (): void => {
    const data = state.payload;
    if (!data) return;

    state.summary = buildArticleStats(catalog, data.posts, state.extraMeta);

    if (trendAllRangeBtn) {
      const hasMoreThan14 = data.daily.length > 14;
      trendAllRangeBtn.hidden = !hasMoreThan14;
      if (hasMoreThan14) trendAllRangeBtn.textContent = `${data.daily.length}天`;
      else if (state.trendRange === 'all') state.trendRange = '14d';
    }

    setPressedGroup('[data-trend-kind]', 'data-trend-kind', state.trendKind);
    setPressedGroup('[data-trend-range]', 'data-trend-range', state.trendRange);
    setPressedGroup('[data-trend-day]', 'data-trend-day', state.trendDayType);
    setPressedGroup('[data-bd-kind]', 'data-bd-kind', state.bdKind);
    setPressedGroup('[data-bd-dim]', 'data-bd-dim', state.bdDim);
    setPressedGroup('[data-bd-metric]', 'data-bd-metric', state.bdMetric);
    setPressedGroup('[data-rank-kind]', 'data-rank-kind', state.rankKind);

    if (metaEl) {
      const time = new Date(data.generatedAt).toLocaleString('zh-CN');
      metaEl.textContent = `统计时间：${time}`;
    }

    // 先显示容器，确保 SVG 图表能读取到真实容器宽度，避免首帧闪动
    showBody();
    syncCategoryOptions();
    renderKpis();
    renderTrendChart();
    renderBreakdown();
    renderRanking();
  };

  /** 若 KV 中存在仅点赞无阅读或被前 60 截断的文章，用 /api/meta 补齐 */
  const hydrateMissingPosts = async (data: StatsPayload): Promise<void> => {
    const returned = new Set(data.posts.map((p) => p.path));
    const missing = catalog.posts.map((p) => p.path).filter((path) => !returned.has(path));
    if (!missing.length) return;

    const batches: string[][] = [];
    for (let i = 0; i < missing.length && batches.length < 2; i += 30) {
      batches.push(missing.slice(i, i + 30));
    }

    try {
      const results = await Promise.all(batches.map((chunk) => fetchMeta(chunk)));
      if (aborted) return;
      let changed = false;
      for (const map of results) {
        for (const [path, info] of Object.entries(map)) {
          if (info.views > 0 || info.likes > 0) {
            state.extraMeta[path] = { views: info.views, likes: info.likes };
            changed = true;
          }
        }
      }
      if (changed && state.payload) {
        renderAll();
      }
    } catch {
      /* 补全失败不影响主统计展示 */
    }
  };

  const loadStats = async (): Promise<void> => {
    if (!getSession()) {
      showGate();
      return;
    }

    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('st-btn--icon-spin');
    }

    try {
      const data = await fetchStats();
      if (aborted) return;
      state.payload = data;
      state.extraMeta = {};
      state.selectedDate = null;
      renderAll();
      void hydrateMissingPosts(data);
    } catch (error) {
      if (aborted) return;
      if (error instanceof ApiError && error.status === 403) {
        showGate(`${error.message}（请用站点所有者的 GitHub 账号登录）`, false);
      } else if (error instanceof ApiError && error.status === 401) {
        clearSession();
        showGate('登录已过期，请重新登录。');
      } else {
        showGate(error instanceof Error ? error.message : '统计服务暂时不可用', false);
      }
    } finally {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('st-btn--icon-spin');
      }
    }
  };

  currentReload = () => {
    if (page.isConnected) void loadStats();
  };

  // ---- 绑定控件事件 ----

  loginBtn?.addEventListener('click', () => {
    openLogin()
      .then(() => loadStats())
      .catch((error) => showToast(error instanceof Error ? error.message : '登录失败，请重试'));
  });

  refreshBtn?.addEventListener('click', () => {
    void loadStats();
  });

  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-trend-kind]')) {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-trend-kind') as TrendChartKind | null;
      if (!val || val === state.trendKind) return;
      state.trendKind = val;
      setPressedGroup('[data-trend-kind]', 'data-trend-kind', val);
      renderTrendChart();
    });
  }

  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-trend-range]')) {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-trend-range') as DateRangeFilter | null;
      if (!val || val === state.trendRange) return;
      state.trendRange = val;
      state.selectedDate = null;
      setPressedGroup('[data-trend-range]', 'data-trend-range', val);
      renderKpis();
      renderTrendChart();
    });
  }

  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-trend-day]')) {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-trend-day') as DayTypeFilter | null;
      if (!val || val === state.trendDayType) return;
      state.trendDayType = val;
      state.selectedDate = null;
      setPressedGroup('[data-trend-day]', 'data-trend-day', val);
      renderKpis();
      renderTrendChart();
    });
  }

  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-bd-kind]')) {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-bd-kind') as BreakdownChartKind | null;
      if (!val || val === state.bdKind) return;
      state.bdKind = val;
      state.selectedSliceKey = null;
      setPressedGroup('[data-bd-kind]', 'data-bd-kind', val);
      renderBreakdown();
    });
  }

  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-bd-dim]')) {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-bd-dim') as BreakdownDimension | null;
      if (!val || val === state.bdDim) return;
      state.bdDim = val;
      state.selectedSliceKey = null;
      setPressedGroup('[data-bd-dim]', 'data-bd-dim', val);
      renderBreakdown();
    });
  }

  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-bd-metric]')) {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-bd-metric') as BreakdownMetric | null;
      if (!val || val === state.bdMetric || btn.disabled) return;
      state.bdMetric = val;
      state.selectedSliceKey = null;
      setPressedGroup('[data-bd-metric]', 'data-bd-metric', val);
      renderBreakdown();
    });
  }

  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-rank-kind]')) {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-rank-kind') as RankingKindFilter | null;
      if (!val || val === state.rankKind) return;
      state.rankKind = val;
      setPressedGroup('[data-rank-kind]', 'data-rank-kind', val);
      renderRanking();
    });
  }

  rankCatSelect?.addEventListener('change', () => {
    state.rankCategory = rankCatSelect.value || 'all';
    renderRanking();
  });

  rankSortSelect?.addEventListener('change', () => {
    state.rankSort = (rankSortSelect.value as RankingSort) || 'views';
    renderRanking();
  });

  rankSearchInput?.addEventListener('input', () => {
    state.rankQuery = rankSearchInput.value;
    renderRanking();
  });

  rankNonZeroBtn?.addEventListener('click', () => {
    state.onlyNonZero = !state.onlyNonZero;
    rankNonZeroBtn.setAttribute('aria-pressed', String(state.onlyNonZero));
    renderRanking();
  });

  rankExpandAllBtn?.addEventListener('click', () => {
    if (!state.summary) return;
    const rows = filterAndSortRanking(state.summary.entries, {
      kind: state.rankKind,
      category: state.rankCategory,
      sort: state.rankSort,
      childSort: state.rankChildSort,
      query: state.rankQuery,
      onlyNonZero: state.onlyNonZero,
    });
    const seriesIds = rows.filter((r) => r.kind === 'series').map((r) => r.id);
    const allOpen = seriesIds.length > 0 && seriesIds.every((id) => state.expandedSeries.has(id));
    if (allOpen) {
      for (const id of seriesIds) state.expandedSeries.delete(id);
    } else {
      for (const id of seriesIds) state.expandedSeries.add(id);
    }
    renderRanking();
  });

  // 监听趋势画布宽度变化，响应式重绘 SVG，彻底杜绝手机端宽度变更时溢出错位
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      if (!state.payload || state.trendKind === 'heatmap') return;
      const w = Math.floor(trendStage.clientWidth);
      if (w > 0 && Math.abs(w - lastTrendWidth) >= 2) {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          if (!aborted && state.payload) renderTrendChart();
        }, 60);
      }
    });
    observer.observe(trendStage);
  }

  if (!authListenerBound) {
    authListenerBound = true;
    onAuthChange(() => {
      currentReload?.();
    });
  }

  activeCleanup = () => {
    aborted = true;
    window.clearTimeout(resizeTimer);
    observer?.disconnect();
    currentReload = null;
  };

  void loadStats();
}

onBeforeSwap(() => {
  activeCleanup?.();
  activeCleanup = null;
});

onPageLoad(initStatsPage);
