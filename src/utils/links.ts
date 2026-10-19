/**
 * 导航页与项目页的数据读取
 * ============================================================
 * 数据在 config/navigation.json、config/projects.json。
 * 改完要重启 dev 或重新 build 才生效（静态站特性）。
 * ============================================================
 */

import navigationJson from '../../config/navigation.json';
import projectsJson from '../../config/projects.json';

export interface LinkItem {
  name: string;
  url: string;
  /** iconify 图标名，如 material-symbols:code-blocks-outline */
  icon: string;
  description?: string;
}

export interface LinkGroup {
  category: string;
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

export const LINK_GROUPS: LinkGroup[] = navigationJson as LinkGroup[];

export const PROJECTS: ProjectItem[] = projectsJson as ProjectItem[];

/** 导航页所有分类名（用于筛选 chips） */
export function linkCategories(): string[] {
  return LINK_GROUPS.map((group) => group.category);
}

/** 取项目域名（用于显示 favicon 或纯文字域名） */
export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
