/**
 * GitHub 仓库读写（在线写作 / 站点配置 / 相册编辑共用）
 * ============================================================
 * 两种提交方式，按场景选：
 *
 * ① 单文件（Contents API）
 *    getFile → 带 sha 的 putFile
 *    改一篇文章、改一个 JSON 就用它，一次请求搞定。
 *
 * ② 多文件（Git Data API）
 *    createBlob → createTree → createCommit → updateRef
 *    批量上传相册照片 + 同时改 albums.json，要么全成功要么全不动。
 *
 * 令牌来自写作会话（localStorage['melodyxz-edit']，scope=repo），
 * 只在浏览器与本仓库之间流动，不经过任何第三方。
 * ============================================================
 */

import { REPO } from '../consts';
import { getEditSession, ApiError } from './site';

const API = 'https://api.github.com';

interface RequestOptions {
  method?: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/** 带令牌调用 GitHub API，统一错误处理 */
async function call<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = getEditSession();
  if (!session) throw new ApiError(401, '请先用 GitHub 授权写作权限');

  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${session.token}`,
      'x-github-api-version': '2022-11-28',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) return {} as T;

  if (!response.ok) {
    let message = `GitHub 接口出错（${response.status}）`;
    try {
      const data = await response.json();
      if (data && typeof data.message === 'string' && data.message) message = data.message;
    } catch {
      /* 忽略 */
    }
    if (response.status === 401) message = '写作授权已失效，请重新授权';
    if (response.status === 404) message = '仓库里找不到这个文件（可能已被重命名或删除）';
    if (response.status === 403) message = '没有写入权限：确认授权时勾选了仓库写入，且你是仓库所有者';
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

/* ---------------- UTF-8 ←→ base64 ---------------- */

/** 文本转 base64（含中文，不能用 btoa 直转） */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64 转文本（utf-8 安全） */
export function base64ToText(value: string): string {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** ArrayBuffer 转 base64（上传图片用） */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ---------------- ① 单文件读写 ---------------- */

export interface RepoFile {
  /** 文件正文（文本） */
  text: string;
  /** 当前内容的 sha，更新时必须带上 */
  sha: string;
}

/** 读一个文件；不存在返回 null */
export async function getFile(path: string): Promise<RepoFile | null> {
  try {
    const data = await call<{ content: string; sha: string; encoding: string }>(
      `/repos/${REPO.owner}/${REPO.name}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${REPO.branch}`,
    );
    const text = data.encoding === 'base64' ? base64ToText(data.content) : data.content;
    return { text, sha: data.sha };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** 写一个文件（新建或更新）。传了 sha 就是更新 */
export async function putFile(
  path: string,
  content: string,
  message: string,
  sha?: string,
): Promise<{ sha: string }> {
  const data = await call<{ content: { sha: string } }>(
    `/repos/${REPO.owner}/${REPO.name}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
    {
      method: 'PUT',
      body: {
        message,
        content: textToBase64(content),
        branch: REPO.branch,
        ...(sha ? { sha } : {}),
      },
    },
  );
  return { sha: data.content.sha };
}

/** 删除一个文件 */
export async function deleteFile(path: string, message: string, sha: string): Promise<void> {
  await call(`/repos/${REPO.owner}/${REPO.name}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    method: 'DELETE',
    body: { message, sha, branch: REPO.branch },
  });
}

/** 写一个二进制文件（图片）；同名已存在时 GitHub 需要 sha，这里自动取一次 */
export async function putBinary(
  path: string,
  buffer: ArrayBuffer,
  message: string,
): Promise<{ sha: string }> {
  const existing = await getFile(path);
  const data = await call<{ content: { sha: string } }>(
    `/repos/${REPO.owner}/${REPO.name}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
    {
      method: 'PUT',
      body: {
        message,
        content: bufferToBase64(buffer),
        branch: REPO.branch,
        ...(existing ? { sha: existing.sha } : {}),
      },
    },
  );
  return { sha: data.content.sha };
}

/** 列目录，返回文件名（不带路径） */
export async function listDir(dir: string): Promise<string[]> {
  try {
    const data = await call<{ name: string; type: string }[]>(
      `/repos/${REPO.owner}/${REPO.name}/contents/${dir}?ref=${REPO.branch}`,
    );
    return data.filter((item) => item.type === 'file').map((item) => item.name);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
}

/* ---------------- ② 多文件一次性提交 ---------------- */

export interface FileChange {
  /** 仓库内路径，如 public/image/albums/a1.jpg */
  path: string;
  /** 文本内容（与 binary 二选一） */
  text?: string;
  /** 二进制内容（图片） */
  binary?: ArrayBuffer;
  /** true = 删除这个文件 */
  remove?: boolean;
}

interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  sha?: string;
  content?: string;
}

/**
 * 一次提交多个文件变更（全成功或全不动）。
 * 相册「保存并同步」用它：上传照片 + 改写 albums.json 在同一次 commit 里。
 */
export async function commitFiles(changes: FileChange[], message: string): Promise<{ commitSha: string }> {
  if (!changes.length) throw new ApiError(400, '没有任何改动');

  // 1) 取当前分支头
  const refData = await call<{ object: { sha: string } }>(
    `/repos/${REPO.owner}/${REPO.name}/git/ref/heads/${REPO.branch}`,
  );
  const headSha = refData.object.sha;

  // 2) 头提交的 tree
  const commitData = await call<{ tree: { sha: string } }>(
    `/repos/${REPO.owner}/${REPO.name}/git/commits/${headSha}`,
  );
  const baseTree = commitData.tree.sha;

  // 3) 逐个建 blob
  const entries: TreeEntry[] = [];
  for (const change of changes) {
    if (change.remove) {
      // path 置 null 才是删除；这里用 sha 缺省 + 特殊写法由 GitHub 处理
      entries.push({ path: change.path, mode: '100644', type: 'blob', sha: undefined });
      continue;
    }

    const blob = await call<{ sha: string }>(`/repos/${REPO.owner}/${REPO.name}/git/blobs`, {
      method: 'POST',
      body: change.binary
        ? { content: bufferToBase64(change.binary), encoding: 'base64' }
        : { content: change.text ?? '', encoding: 'utf-8' },
    });

    entries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // 4) 建 tree（删除的文件用 sha:null 表达）
  const tree = await call<{ sha: string }>(`/repos/${REPO.owner}/${REPO.name}/git/trees`, {
    method: 'POST',
    body: {
      base_tree: baseTree,
      tree: entries.map((entry) =>
        entry.sha === undefined
          ? { path: entry.path, mode: entry.mode, type: entry.type, sha: null }
          : entry,
      ),
    },
  });

  // 5) 建 commit
  const commit = await call<{ sha: string }>(`/repos/${REPO.owner}/${REPO.name}/git/commits`, {
    method: 'POST',
    body: { message, tree: tree.sha, parents: [headSha] },
  });

  // 6) 移动分支
  await call(`/repos/${REPO.owner}/${REPO.name}/git/refs/heads/${REPO.branch}`, {
    method: 'PATCH',
    body: { sha: commit.sha },
  });

  return { commitSha: commit.sha };
}
