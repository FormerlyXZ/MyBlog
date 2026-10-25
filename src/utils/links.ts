/**
 * 导航页与项目页的数据读取
 * ============================================================
 * 数据在 config/navigation.json、config/projects.json。
 * 改完要重启 dev 或重新 build 才生效（静态站特性）；
 * 站长也可以直接在 /config →「网站导航」里可视化编辑并提交。
 * ============================================================
 */

import navigationJson from '../../config/navigation.json';
import projectsJson from '../../config/projects.json';

export interface LinkItem {
  name: string;
  url: string;
  /**
   * 站点图标（推荐）：站内路径，如 /nav/itdog.ico。
   * 有它就优先显示图片；没有才回落到 icon 的 Iconify 图标。
   */
  logo?: string;
  /** Iconify 图标名，如 material-symbols:code-blocks-outline（logo 缺失时的兜底） */
  icon?: string;
  description?: string;
}

export interface LinkGroup {
  category: string;
  /** 分组标题前的 Iconify 图标（可选） */
  icon?: string;
  items: LinkItem[];
}

export interface ProjectItem {
  name: string;
  description: string;
  icon: string;
  link?: string;
  repo?: string;
  tags?: string[];
  status?: string;
}

/** 只保留有站点的分组，空分组在页面上没有意义 */
export const LINK_GROUPS: LinkGroup[] = normalizeLinkGroups(navigationJson as unknown);

export const PROJECTS: ProjectItem[] = projectsJson as ProjectItem[];

/** 导航页所有分类名（用于筛选 chips） */
export function linkCategories(): string[] {
  return LINK_GROUPS.map((group) => group.category);
}

/** 取项目域名（用于显示域名或纯文字域名） */
export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 卡片上显示的域名：去掉协议与末尾斜杠，最长那一截 */
export function displayHost(url?: string): string {
  const host = hostOf(url);
  if (!host) return '';
  try {
    const { pathname } = new URL(url as string);
    const path = pathname.replace(/\/$/, '');
    return path && path !== '' ? `${host}${path}` : host;
  } catch {
    return host;
  }
}

/** 数据里允许写成数组或 { groups: [...] }，统一成数组 */
export function normalizeLinkGroups(raw: unknown): LinkGroup[] {
  const source = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { groups?: unknown }).groups)
      ? ((raw as { groups: unknown[] }).groups as unknown[])
      : [];

  return source.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const group = entry as Record<string, unknown>;
    const items = Array.isArray(group.items) ? group.items : [];
    const normalized: LinkGroup = {
      category: typeof group.category === 'string' ? group.category : '未命名分组',
      icon: typeof group.icon === 'string' ? group.icon : undefined,
      items: items.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const link = item as Record<string, unknown>;
        const url = typeof link.url === 'string' ? link.url : '';
        const name = typeof link.name === 'string' ? link.name : '';
        if (!name || !url) return [];
        return [
          {
            name,
            url,
            logo: typeof link.logo === 'string' && link.logo ? link.logo : undefined,
            icon: typeof link.icon === 'string' && link.icon ? link.icon : undefined,
            description: typeof link.description === 'string' ? link.description : undefined,
          },
        ];
      }),
    };
    return normalized.items.length ? [normalized] : [];
  });
}
