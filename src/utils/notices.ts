/**
 * 站点公告 / 更新日志的数据读取（构建时）
 * ============================================================
 * 只做一件「构建时」的事：把 config/notices.json 读进来、规整、排好序。
 * 类型、常量、纯函数都在 ./notice-meta 里 —— 浏览器脚本引用那一份，
 * 不会因为 import 这个小模块就把整份公告数据打进来。
 *
 * 站点上「新建 / 编辑 / 删除公告」走的是 GitHub 提交（config/notices.json），
 * 提交后自动触发重建，约 1 分钟生效；改本地文件则要重启 dev 或重新 build。
 * ============================================================
 */

import noticesJson from '../../config/notices.json';
import { normalizeNoticeBook, sortNotices, type NoticeBook, type NoticeItem } from './notice-meta';

export * from './notice-meta';

const NORMALIZED: NoticeBook = normalizeNoticeBook(noticesJson);

/** 排好序的全部数据（置顶在前，其余从新到旧） */
export const NOTICE_BOOK: NoticeBook = {
  announcements: sortNotices(NORMALIZED.announcements),
  changelog: sortNotices(NORMALIZED.changelog),
};

/** 两个列表（页面同时要公告和日志时省一次 import） */
export function getNoticeBook(): NoticeBook {
  return {
    announcements: NOTICE_BOOK.announcements,
    changelog: NOTICE_BOOK.changelog,
  };
}

/** 站点公告（首页胶囊滚动展示的就是它） */
export function getAnnouncements(): NoticeItem[] {
  return NOTICE_BOOK.announcements;
}

/** 更新日志 */
export function getChangelog(): NoticeItem[] {
  return NOTICE_BOOK.changelog;
}
