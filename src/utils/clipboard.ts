/**
 * 复制文本到剪贴板
 * ============================================================
 * 两套路子：
 *   ① Clipboard API —— https 或 localhost 下优先用，干净利落；
 *   ② textarea + execCommand —— http（比如手机连局域网 IP 预览）也能用，
 *      虽然这 API 已经废弃，但它是唯一不依赖安全上下文的办法。
 *
 * 返回值 = 到底复制成功没有（调用方据此决定提示什么）。
 * 阅读进度胶囊的「复制链接 / 复制全文」和代码块的复制按钮共用这一份。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走兜底 */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
