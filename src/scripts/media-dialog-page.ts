/**
 * /media/ 图床管理页的启动脚本
 * ============================================================
 * 真正的界面逻辑全在 media-dialog.ts（和编辑器里的选图弹窗共用），
 * 这里只负责「进来的时候把面板点着」。
 *
 * 走 onPageLoad 而不是直接执行，是因为本站用 ClientRouter 做 SPA 式换页：
 * 打包脚本只跑一次，直接 querySelector 在第二次进入页面时就找不到了。
 */

import { onPageLoad } from './pageload';
import { initMediaPage } from './media-dialog';

onPageLoad(() => {
  // 不在 /media/ 页面上（其它页面也引了这个脚本时）直接跳过
  if (!document.querySelector('[data-media-page]') && !document.querySelector('[data-media-gate]')) {
    return;
  }
  initMediaPage();
});
