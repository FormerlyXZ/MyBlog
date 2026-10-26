/**
 * 动态（说说 / 朋友圈）数据读取
 * ============================================================
 * 这里只做一件「构建时」的事：把 config/moments.json 读进来并排好序。
 * 常量、类型、纯函数都在 ./moment-meta 里 —— 客户端脚本引用那一份，
 * 不会把整份动态数据打进浏览器包。
 *
 * 注意：改完 config/moments.json 要重启 dev 或重新 build 才生效；
 * 站点上「发布动态」走的是 GitHub 提交，会自动触发重建。
 * ============================================================
 */

import momentsJson from '../../config/moments.json';
import { momentTimestamp, type Moment } from './moment-meta';

export * from './moment-meta';

/** 原始数据（未排序，顺序就是 JSON 里的顺序） */
export const MOMENTS: Moment[] = momentsJson as Moment[];

/** 全部动态：置顶优先，其余按时间从新到旧 */
export function getMoments(): Moment[] {
  return [...MOMENTS].sort((a, b) => {
    const pinA = a.pinned ? 1 : 0;
    const pinB = b.pinned ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    return momentTimestamp(b.time) - momentTimestamp(a.time);
  });
}
