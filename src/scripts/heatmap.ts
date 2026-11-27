/**
 * 首页侧栏「创作热力图」交互脚本
 * ============================================================
 * · 适配 Astro <ClientRouter />（通过 onPageLoad / onBeforeSwap 管理生命周期）
 * · 悬停 / 键盘聚焦任意方格 → 弹出智能防溢出浮窗，显示日期、各类型计数与热度分
 * · 悬停图例档位 → 按档位高亮对应方块
 */
import { onBeforeSwap, onPageLoad } from './pageload';

type ActivityKind = 'post' | 'postUpdate' | 'moment' | 'notice' | 'photo';

interface DayRecord {
  score: number;
  counts: Record<ActivityKind, number>;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let cleanupActive: (() => void) | null = null;

function summarizeCounts(counts: Record<ActivityKind, number>): string {
  const parts: string[] = [];
  if (counts.post) parts.push(`${counts.post} 篇文章`);
  if (counts.moment) parts.push(`${counts.moment} 条动态`);
  if (counts.postUpdate) parts.push(`${counts.postUpdate} 次更新`);
  if (counts.notice) parts.push(`${counts.notice} 条公告`);
  if (counts.photo) parts.push(`${counts.photo} 张照片`);
  return parts.length ? parts.join(' · ') : '暂无创作记录';
}

function formatDateHeading(dateStr: string, weekday: number, isToday: boolean): string {
  const wd = WEEKDAYS[weekday] ?? '';
  return isToday ? `${dateStr} · ${wd}（今天）` : `${dateStr} · ${wd}`;
}

function readDayMap(card: HTMLElement): Record<string, DayRecord> {
  const dataEl = card.querySelector<HTMLScriptElement>('[data-hm-data]');
  if (!dataEl?.textContent) return {};
  try {
    return JSON.parse(dataEl.textContent) as Record<string, DayRecord>;
  } catch {
    return {};
  }
}

function initHeatmap(): void {
  cleanupActive?.();
  cleanupActive = null;

  const card = document.querySelector<HTMLElement>('[data-heatmap]');
  if (!card || card.dataset.init === '1') return;
  card.dataset.init = '1';

  const stage = card.querySelector<HTMLElement>('[data-hm-stage]');
  const grid = card.querySelector<HTMLElement>('.hm-grid');
  const tooltip = card.querySelector<HTMLElement>('[data-hm-tooltip]');
  const tipDate = card.querySelector<HTMLElement>('[data-hm-tip-date]');
  const tipScore = card.querySelector<HTMLElement>('[data-hm-tip-score]');
  const tipSummary = card.querySelector<HTMLElement>('[data-hm-tip-summary]');

  if (!stage || !grid || !tooltip || !tipDate || !tipScore || !tipSummary) return;

  const dayMap = readDayMap(card);
  const todayStr = card.dataset.hmToday ?? '';
  let tipHideTimer: number | undefined;

  const showTooltip = (cell: HTMLElement): void => {
    window.clearTimeout(tipHideTimer);
    const date = cell.dataset.date ?? '';
    const weekday = Number(cell.dataset.weekday ?? '0');
    const row = Number(cell.dataset.row ?? '0');
    const isToday = cell.dataset.today === '1' || date === todayStr;
    const record = dayMap[date];

    tipDate.textContent = formatDateHeading(date, weekday, isToday);
    tipScore.textContent = record ? `热度 ${record.score}` : '';
    tipSummary.textContent = record ? summarizeCounts(record.counts) : '暂无创作记录';

    tooltip.hidden = false;
    const stageRect = stage.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const tipW = tooltip.offsetWidth || 168;
    const tipH = tooltip.offsetHeight || 52;

    const rawLeft = cellRect.left - stageRect.left + cellRect.width / 2 - tipW / 2;
    const clampedLeft = Math.max(0, Math.min(stageRect.width - tipW, rawLeft));

    const placeBelow = row <= 1 && cellRect.top - stageRect.top < tipH + 8;
    const top = placeBelow
      ? cellRect.bottom - stageRect.top + 8
      : cellRect.top - stageRect.top - tipH - 8;

    tooltip.style.left = `${Math.round(clampedLeft)}px`;
    tooltip.style.top = `${Math.round(top)}px`;

    requestAnimationFrame(() => {
      tooltip.classList.add('is-open');
    });
  };

  const hideTooltip = (): void => {
    tooltip.classList.remove('is-open');
    window.clearTimeout(tipHideTimer);
    tipHideTimer = window.setTimeout(() => {
      if (!tooltip.classList.contains('is-open')) {
        tooltip.hidden = true;
      }
    }, 150);
  };

  const onPointerOver = (event: Event): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-hm-cell]');
    if (target) showTooltip(target);
  };

  const onFocusIn = (event: FocusEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-hm-cell]');
    if (target) showTooltip(target);
  };

  const onPointerLeave = (): void => {
    hideTooltip();
  };

  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (!next || !grid.contains(next)) hideTooltip();
  };

  const legendSwatches = card.querySelectorAll<HTMLElement>('[data-hm-legend]');
  const onLegendEnter = (event: Event): void => {
    const el = event.currentTarget as HTMLElement;
    const lvl = el.dataset.hmLegend;
    if (lvl !== undefined) card.dataset.filterLevel = lvl;
  };
  const onLegendLeave = (): void => {
    delete card.dataset.filterLevel;
  };

  grid.addEventListener('pointerover', onPointerOver);
  grid.addEventListener('pointerleave', onPointerLeave);
  grid.addEventListener('focusin', onFocusIn);
  grid.addEventListener('focusout', onFocusOut);

  for (const swatch of legendSwatches) {
    swatch.addEventListener('pointerenter', onLegendEnter);
    swatch.addEventListener('pointerleave', onLegendLeave);
    swatch.addEventListener('focus', onLegendEnter);
    swatch.addEventListener('blur', onLegendLeave);
  }

  cleanupActive = () => {
    window.clearTimeout(tipHideTimer);
    grid.removeEventListener('pointerover', onPointerOver);
    grid.removeEventListener('pointerleave', onPointerLeave);
    grid.removeEventListener('focusin', onFocusIn);
    grid.removeEventListener('focusout', onFocusOut);
    for (const swatch of legendSwatches) {
      swatch.removeEventListener('pointerenter', onLegendEnter);
      swatch.removeEventListener('pointerleave', onLegendLeave);
      swatch.removeEventListener('focus', onLegendEnter);
      swatch.removeEventListener('blur', onLegendLeave);
    }
    delete card.dataset.init;
    delete card.dataset.filterLevel;
  };
}

onBeforeSwap(() => {
  cleanupActive?.();
  cleanupActive = null;
});

onPageLoad(initHeatmap);
