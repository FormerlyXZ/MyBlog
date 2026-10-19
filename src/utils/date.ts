/**
 * 日期格式化
 * ============================================================
 * 不引入 dayjs（省 20KB 依赖），自己实现够用的一套 token：
 *
 *   YYYY  2026          MM  05（补零）      M   5
 *   YY    26            DD  09（补零）      D   9
 *   MMM   5月           ddd 周六            HH  14（补零）
 *   mm    07（补零）    ss  03（补零）
 *
 * 格式串在 config/site.json → site.dateFormat 里配。
 * 参考站用的是 "ddd MMM DD YYYY" → 「周六 5月 31 2025」
 * 本站默认用 "YYYY年MM月DD日" → 「2026年10月20日」
 * ============================================================
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 把 Date 按格式串格式化。
 * @param date   Date 或能被 new Date() 解析的字符串
 * @param format 格式串，见文件头
 */
export function formatDate(date: Date | string, format = 'YYYY年MM月DD日'): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';

  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    MMM: `${d.getMonth() + 1}月`,
    ddd: WEEKDAYS[d.getDay()] ?? '',
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };

  // 长的 token 先替换，避免 MM 被 M 抢先匹配
  return format.replace(/YYYY|YY|MMM|MM|M|DD|D|ddd|HH|mm|ss/g, (token) => map[token] ?? token);
}

/** 机器可读格式，给 <time datetime="..."> 用 */
export function isoDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** 归档分组用的键：2026-10 */
export function yearMonthKey(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 归档分组的显示标题：2026年10月 */
export function yearMonthLabel(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}
