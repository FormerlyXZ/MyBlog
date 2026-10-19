/**
 * /config 页面逻辑
 * ============================================================
 * 读 → 改 → 校验 → 提交。
 * 校验是硬门槛：JSON 不合法就不发请求，避免把站点配置写坏导致下次构建失败。
 */

import { onPageLoad } from './pageload';
import { clearEditSession, getEditSession, openEditLogin, showToast } from '../utils/site';
import { getFile, putFile } from '../utils/github';

function setStatus(text: string): void {
  const el = document.querySelector<HTMLElement>('[data-config-status]');
  if (el) el.textContent = text;
}

function renderGate(): void {
  const authed = Boolean(getEditSession());
  const gate = document.querySelector<HTMLElement>('[data-config-gate]');
  const form = document.querySelector<HTMLElement>('[data-config-form]');
  const logoutBtn = document.querySelector<HTMLElement>('[data-edit-logout]');

  if (gate) gate.hidden = authed;
  if (form) {
    form.hidden = !authed;
    form.classList.toggle('hidden', !authed);
    form.classList.toggle('flex', authed);
  }
  if (logoutBtn) logoutBtn.hidden = !authed;
}

const textEl = () => document.querySelector<HTMLTextAreaElement>('[data-config-text]');

interface LoadedFile {
  sha: string;
}

let current: LoadedFile | null = null;

async function loadConfig(root: HTMLElement): Promise<void> {
  if (!getEditSession()) return;
  const path = root.dataset.configPath ?? 'config/site.json';
  setStatus('读取中…');
  try {
    const file = await getFile(path);
    if (!file) {
      setStatus('仓库里没找到配置文件');
      return;
    }
    current = { sha: file.sha };
    const el = textEl();
    if (el) el.value = file.text;
    setStatus('已读取最新配置');
  } catch (error) {
    setStatus('');
    showToast(error instanceof Error ? error.message : '读取失败');
  }
}

/** 校验并返回解析结果；不合法返回 null 并提示 */
function validate(silent = false): Record<string, unknown> | null {
  const el = textEl();
  if (!el) return null;
  try {
    const parsed = JSON.parse(el.value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      if (!silent) showToast('配置应该是一个 JSON 对象');
      return null;
    }
    if (!silent) showToast('格式没问题');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (!silent) {
      showToast(error instanceof Error ? `JSON 格式错误：${error.message}` : 'JSON 格式错误');
    }
    return null;
  }
}

let initialized = false;

async function initConfig(): Promise<void> {
  const root = document.querySelector<HTMLElement>('[data-config-root]');
  if (!root) return;

  renderGate();
  if (getEditSession()) await loadConfig(root);

  if (initialized) return;
  initialized = true;

  document.querySelector('[data-edit-login]')?.addEventListener('click', async () => {
    try {
      await openEditLogin();
      showToast('写作授权成功');
      renderGate();
      await loadConfig(root);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '授权失败');
    }
  });

  document.querySelector('[data-edit-logout]')?.addEventListener('click', () => {
    clearEditSession();
    renderGate();
    showToast('已退出写作授权');
  });

  document.querySelector('[data-config-format]')?.addEventListener('click', () => {
    const parsed = validate(false);
    if (!parsed) return;
    const el = textEl();
    if (el) el.value = `${JSON.stringify(parsed, null, 2)}\n`;
    setStatus('已格式化');
  });

  document.querySelector('[data-config-validate]')?.addEventListener('click', () => {
    if (validate(false)) setStatus('格式正确');
  });

  document.querySelector('[data-config-reload]')?.addEventListener('click', () => {
    void loadConfig(root);
  });

  document.querySelector('[data-config-save]')?.addEventListener('click', async () => {
    if (!getEditSession()) {
      showToast('请先授权');
      return;
    }

    const parsed = validate(true);
    if (!parsed) {
      showToast('JSON 格式不对，先修好再保存');
      setStatus('格式错误，未提交');
      return;
    }

    const path = root.dataset.configPath ?? 'config/site.json';
    setStatus('提交中…');
    try {
      const file = await getFile(path);
      await putFile(
        path,
        `${JSON.stringify(parsed, null, 2)}\n`,
        'config: update site.json',
        file?.sha ?? current?.sha,
      );
      setStatus('已提交，等自动部署完成后生效');
      showToast('配置已提交，约 1 分钟后生效');
    } catch (error) {
      setStatus('');
      showToast(error instanceof Error ? error.message : '保存失败');
    }
  });
}

onPageLoad(() => {
  void initConfig();
});
