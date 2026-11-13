/**
 * 图床客户端（Cloudflare R2，经 auth.melodyxz.top 中转）
 * ============================================================
 * 分工：
 *   写 —— 只能走 Worker（/api/media/*），Worker 用 R2 绑定直接写桶。
 *        桶保持私有，所以浏览器手里没有任何 R2 密钥，也不会泄露。
 *   读 —— 走 https://picture.melodyxz.top（EdgeOne 边缘 → 私有回源 R2）。
 *        国内实测单连接 4.9 MB/s，比直连 R2 快 60–200 倍。
 *
 * 关于「文件夹」：
 *   R2 是扁平的 key→对象 表，没有真正的目录。但 key 里带 / 再接上
 *   list({ delimiter: "/" }) 就能当目录用，所以这里的文件夹是「虚拟」的：
 *     · 建目录 = 写一个 0 字节的 <目录>/.folder 占位（空目录也能显示）
 *     · 移动/重命名 = 读出来 + 写新的 + 删旧的（R2 没有 rename 接口）
 *     · 删目录 = 删掉目录下所有 key（前缀匹配）
 *
 * 权限：所有写操作都带写作会话的 GitHub 令牌，
 *       Worker 那边验人 + 比对 OWNER_LOGINS，非站长一律 403。
 * ============================================================
 */

import { API_BASE } from '../consts';
import { getEditSession, ApiError } from './site';
import { compressImage, type CompressOptions, type ProcessedImage } from './imaging';

/** 公网访问域名（和 worker/wrangler.toml 的 MEDIA_PUBLIC_BASE 保持一致） */
export const MEDIA_PUBLIC_BASE = 'https://picture.melodyxz.top';

/**
 * 预置分类（新建的桶里没有这些目录时，媒体库会显示成快捷入口）。
 * 只是推荐用法，不是白名单 —— 想建别的目录随便建。
 */
export const MEDIA_FOLDERS: { key: string; label: string; hint: string }[] = [
  { key: 'posts', label: '文章配图', hint: '正文里插的图' },
  { key: 'covers', label: '封面', hint: '文章封面、Banner' },
  { key: 'moments', label: '动态', hint: '动态/说说里的图' },
  { key: 'gallery', label: '相册', hint: '照片墙' },
  { key: 'music', label: '音乐', hint: '音频与封面' },
  { key: 'files', label: '附件', hint: 'PDF 等' },
];

export interface MediaFile {
  /** 桶里的完整路径，如 posts/takagi-20260211-a1b2.webp */
  key: string;
  /** 当前目录下的文件名 */
  name: string;
  /** 可直接用的公网地址 */
  url: string;
  size: number;
  uploaded: string;
  type: string;
  /** 像素尺寸（上传时记下的；非图片或老对象可能是 0） */
  width?: number;
  height?: number;
}

export interface MediaFolder {
  /** 目录名（不含父路径） */
  name: string;
  /** 完整前缀，结尾带 / */
  prefix: string;
}

export interface MediaListing {
  prefix: string;
  folders: MediaFolder[];
  files: MediaFile[];
  cursor: string | null;
  truncated: boolean;
  /** 上一级前缀；根目录为 null */
  parent: string | null;
}

export interface MediaStats {
  files: number;
  bytes: number;
  byType: { image: number; audio: number; video: number; other: number };
  /** 一级目录汇总（分类栏用）。name 为空字符串代表「根目录下的散文件」 */
  folders: { name: string; files: number; bytes: number }[];
  quotaBytes: number;
  publicBase: string;
}

/* ------------------------------------------------------------------ */
/* 底层请求                                                            */
/* ------------------------------------------------------------------ */

function authToken(): string {
  const session = getEditSession();
  if (!session?.token) {
    throw new ApiError(401, '请先用 GitHub 授权写作权限，图床只对站长开放');
  }
  return session.token;
}

async function mediaCall<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${authToken()}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(API_BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '连不上图床服务，请检查网络后重试');
  }

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    /* 非 JSON */
  }

  if (!response.ok || (data && data.ok === false)) {
    const message =
      (data && typeof data.message === 'string' && data.message) || '图床服务暂时不可用，请稍后再试';
    throw new ApiError(response.status, message);
  }
  return data as T;
}

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

/** 列一个目录（prefix 结尾带不带 / 都行） */
export async function listMedia(prefix = '', cursor?: string): Promise<MediaListing> {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix.replace(/\/*$/, '/'));
  if (cursor) params.set('cursor', cursor);
  return mediaCall<MediaListing & { ok: true }>(`/api/media/list?${params}`);
}

/** 桶的用量（文件数、总体积） */
export async function mediaStats(): Promise<MediaStats> {
  const data = await mediaCall<MediaStats & { ok: true }>('/api/media/stats');
  return data;
}

/* ------------------------------------------------------------------ */
/* 写                                                                  */
/* ------------------------------------------------------------------ */

export interface UploadProgress {
  /** 0–100；拿不到总长度时为 null（显示成不定进度） */
  percent: number | null;
  loaded: number;
  total: number;
}

/**
 * 传二进制。用 XHR 而不是 fetch —— 只有 XHR 能拿到真实的上传进度，
 * 传 50MB 音乐时那个百分比条就是从这儿来的。
 */
export function uploadBlob(
  blob: Blob,
  key: string,
  options: {
    name?: string;
    /** 像素尺寸（只有图片有），存进 R2 的 customMetadata，预览时能显示 */
    width?: number;
    height?: number;
    onProgress?: (info: UploadProgress) => void;
  } = {},
): Promise<{ key: string; url: string; size: number; type: string }> {
  const token = authToken();
  const params = new URLSearchParams({ key });
  if (options.name) params.set('name', options.name);
  if (options.width && options.height) {
    params.set('w', String(options.width));
    params.set('h', String(options.height));
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/media/upload?${params}`, true);
    // 别让它无限挂着：卡住就报错，交给上面的重试逻辑
    xhr.timeout = 180000;
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', blob.type || 'application/octet-stream');
    xhr.setRequestHeader('accept', 'application/json');

    xhr.upload.onprogress = (event) => {
      options.onProgress?.({
        percent: event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null,
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : 0,
      });
    };

    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* 非 JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
        resolve(data);
        return;
      }
      const message =
        (data && typeof data.message === 'string' && data.message) ||
        `上传失败（HTTP ${xhr.status}）`;
      reject(new ApiError(xhr.status, message));
    };

    xhr.onerror = () => reject(new ApiError(0, '上传中断，请检查网络后重试'));
    xhr.ontimeout = () => reject(new ApiError(0, '上传超时（网络太慢），压缩后再试或换个网络'));
    xhr.onabort = () => reject(new ApiError(0, '已取消上传'));
    xhr.send(blob);
  });
}

/**
 * 传失败重试几次。
 * 从国内传到 Cloudflare 偶尔会被中途掐断（尤其大文件），
 * 重试一次基本就好；三次都失败才认为是真的不行。
 * 每次重试前等一会儿，别在同一个坏连接上死磕。
 */
export async function withRetry<T>(task: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      // 401/403/413 这类是"再试也没用"的错误，直接抛
      if (error instanceof ApiError && [401, 403, 413, 415].includes(error.status)) throw error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new ApiError(0, '上传失败，请稍后重试');
}

/** 新建一个空目录 */
export async function createFolder(key: string): Promise<void> {
  await mediaCall('/api/media/folder', { key });
}

/**
 * 目录改名：Worker 会把 from/ 下的对象一个个搬到 to/。
 * R2 没有目录，所以这实际上是批量移动，文件多时会慢一点。
 */
export async function renameFolder(
  from: string,
  to: string,
): Promise<{ moved: number; total: number; failed: number }> {
  return mediaCall('/api/media/folder/rename', { from, to });
}

/** 目录连同里面的文件一起删掉 */
export async function deleteFolder(key: string): Promise<number> {
  const data = await mediaCall<{ ok: true; deleted: number }>('/api/media/folder/delete', { key });
  return data.deleted;
}

/** 批量删除（最多 200 个） */
export async function deleteMedia(keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  const data = await mediaCall<{ ok: true; deleted: number }>('/api/media/delete', { keys });
  return data.deleted;
}

/** 移动 / 重命名 */
export async function moveMedia(from: string, to: string): Promise<{ key: string; url: string }> {
  return mediaCall('/api/media/move', { from, to });
}

/**
 * 把仓库里已经上线的文件搬进图床（服务器到服务器）。
 * 不经过浏览器带宽 —— 243MB 音乐用浏览器传要几个小时，让 Worker 自己去取几十秒就完事。
 * `from` 只允许本站域名，防止这个接口被当成任意 URL 下载器。
 */
export async function importMedia(
  from: string,
  key: string,
): Promise<{ key: string; url: string; size: number; type: string }> {
  return mediaCall('/api/media/import', { from, key });
}

/* ------------------------------------------------------------------ */
/* 文件名 / 路径                                                       */
/* ------------------------------------------------------------------ */

/** 从原始文件名取一个安全的名字：保留中英文数字，其余折成 - */
export function safeBaseName(name: string): string {
  const withoutExt = name.replace(/\.[^.]+$/, '');
  const cleaned = withoutExt
    .trim()
    .toLowerCase()
    .replace(/['"’]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'file';
}

function randomSuffix(length = 4): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/**
 * 拼一个新文件名：<原名>-<日期>-<4位随机>.<扩展名>
 * 带随机后缀是为了「同样的图传两次不会撞车」——
 * 图床的缓存是 30 天 immutable，同名覆盖会导致线上一直看到旧图。
 */
export function buildMediaKey(folder: string, name: string, ext: string): string {
  const dir = folder.replace(/^\/+|\/+$/g, '');
  const fileName = `${safeBaseName(name)}-${stamp()}-${randomSuffix()}.${ext}`;
  return dir ? `${dir}/${fileName}` : fileName;
}

/** 公网地址：把非 ASCII 分段做百分号编码 */
export function mediaUrl(key: string): string {
  return `${MEDIA_PUBLIC_BASE}/${key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

/**
 * 反解：图床地址 → 桶里的 key。不是图床地址就返回 null。
 * 用来判断「这条旧资源该删 R2 还是该删仓库」。
 */
export function mediaKeyFromUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  const base = `${MEDIA_PUBLIC_BASE}/`;
  if (!url.startsWith(base)) return null;
  const rest = url.slice(base.length).split(/[?#]/)[0];
  if (!rest) return null;
  try {
    return rest
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return rest;
  }
}

/* ------------------------------------------------------------------ */
/* 一步到位：压缩 + 上传                                               */
/* ------------------------------------------------------------------ */

export interface UploadedImage extends ProcessedImage {
  key: string;
  url: string;
}

/**
 * 压成 WebP 再传上去，返回公网地址和压缩情况。
 * 编辑器里「选一张图 → 得到 https://picture.melodyxz.top/…」走的就是它。
 */
export async function uploadImage(
  file: File,
  options: CompressOptions & {
    folder?: string;
    /** 生成文件名时用这个名字代替原始文件名（原始名可能是「头像.jpg」这种） */
    name?: string;
    onProgress?: (info: UploadProgress) => void;
    onStage?: (stage: 'compress' | 'upload') => void;
  } = {},
): Promise<UploadedImage> {
  const { folder = 'posts', name, onProgress, onStage, ...compressOptions } = options;

  onStage?.('compress');
  const processed = await compressImage(file, compressOptions);

  const key = buildMediaKey(folder, name ?? file.name, processed.ext);
  onStage?.('upload');

  // 每次重试换一个新的 key：失败了半截的对象就留在那儿，
  // 用同一个 key 覆盖反而可能读到自己写坏的版本。
  const result = await withRetry(() =>
    uploadBlob(processed.blob, attemptsKey(key), {
      name: file.name,
      width: processed.width,
      height: processed.height,
      onProgress,
    }),
  );

  return { ...processed, key: result.key, url: result.url || mediaUrl(result.key) };
}

/** key 加一个重试后缀，保证每次试都是新对象 */
let attemptCounter = 0;
function attemptsKey(key: string): string {
  attemptCounter += 1;
  if (attemptCounter === 1) return key;
  const dot = key.lastIndexOf('.');
  const suffix = `-r${attemptCounter}`;
  return dot === -1 ? key + suffix : `${key.slice(0, dot)}${suffix}${key.slice(dot)}`;
}

/** 非图片文件（音乐、PDF、视频）直接传，不压缩 */
export async function uploadFile(
  file: File,
  options: {
    folder?: string;
    name?: string;
    onProgress?: (info: UploadProgress) => void;
  } = {},
): Promise<{ key: string; url: string; size: number; type: string }> {
  const folder = options.folder ?? 'files';
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = buildMediaKey(folder, options.name ?? file.name, ext || 'bin');
  return withRetry(() =>
    uploadBlob(file, attemptsKey(key), { name: file.name, onProgress: options.onProgress }),
  );
}
