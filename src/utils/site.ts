/**
 * 前台与 Cloudflare Worker 打交道的小工具库
 * 负责：GitHub 登录弹窗、令牌存取、点赞/阅读数/统计接口调用、小提示条。
 *
 * 令牌存在 localStorage 里（key: melodyxz-user），只含 read:user 权限，
 * 只用来点赞和看统计，不碰后台编辑器（后台令牌是编辑器自己保管的）。
 */

import { API_BASE } from '../consts';

export interface Viewer {
  /** 后端 /api/me 返回的用户 id */
  id: number;
  /** GitHub 用户名 */
  login: string;
  /** 昵称（没设置就是用户名） */
  name: string;
  /** 头像图片地址 */
  avatar: string;
}

export interface Session extends Viewer {
  /** GitHub access token（read:user） */
  token: string;
  /** 登录时间戳 */
  at: number;
}

const STORAGE_KEY = 'melodyxz-user';
const AUTH_EVENT = 'melodyxz:auth';

// ---------------------------------------------------------------------------
// 会话存取
// ---------------------------------------------------------------------------

/** 读本机保存的登录会话，没有或格式不对返回 null */
export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<Session>;
    if (!data || typeof data.token !== 'string' || !data.token) return null;
    if (typeof data.login !== 'string' || !data.login) return null;
    return {
      id: Number(data.id) || 0,
      login: data.login,
      name: typeof data.name === 'string' ? data.name : data.login,
      avatar: typeof data.avatar === 'string' ? data.avatar : '',
      token: data.token,
      at: Number(data.at) || 0,
    };
  } catch {
    return null;
  }
}

function saveSession(session: Session): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* 隐私模式下写不进去，忽略即可 */
  }
}

/** 退出登录 */
export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  dispatchAuthChange();
}

/** 登录状态变化时通知页面上的组件（页头、点赞按钮等） */
export function onAuthChange(callback: () => void): void {
  window.addEventListener(AUTH_EVENT, callback);
}

function dispatchAuthChange(): void {
  window.dispatchEvent(new CustomEvent(AUTH_EVENT));
}

// ---------------------------------------------------------------------------
// 接口调用
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** 是否带上登录令牌 */
  withToken?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, withToken = false } = options;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  if (withToken) {
    const session = getSession();
    if (session) headers.authorization = `Bearer ${session.token}`;
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10000);

  let response: Response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    window.clearTimeout(timer);
    if ((error as Error).name === 'AbortError') {
      throw new ApiError(0, '请求超时，请检查网络后重试');
    }
    throw new ApiError(0, '连不上服务，请检查网络后重试');
  }
  window.clearTimeout(timer);

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    /* 非 JSON 响应 */
  }

  if (!response.ok || (data && data.ok === false)) {
    const message = (data && typeof data.message === 'string' && data.message) || '服务暂时不可用，请稍后再试';
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export interface MetaResult {
  likes: number;
  views: number;
  liked: boolean;
}

interface MetaResponse {
  ok: boolean;
  viewer: { login: string } | null;
  items: Record<string, { likes: number; views: number; liked: boolean }>;
}

/** 批量读取点赞数、阅读数、我是否点过赞 */
export async function fetchMeta(paths: string[]): Promise<Record<string, MetaResult>> {
  if (!paths.length) return {};
  const query = new URLSearchParams({ paths: paths.join(',') });
  const data = await request<MetaResponse>(`/api/meta?${query.toString()}`, { withToken: true });
  const result: Record<string, MetaResult> = {};
  for (const path of paths) {
    const item = data.items && data.items[path];
    if (item) result[path] = { likes: item.likes, views: item.views, liked: item.liked };
  }
  return result;
}

/** 点赞 / 取消点赞 */
export async function sendLike(path: string, action: 'like' | 'unlike'): Promise<{ liked: boolean; count: number }> {
  return request<{ ok: boolean; liked: boolean; count: number }>('/api/like', {
    method: 'POST',
    body: { path, action },
    withToken: true,
  });
}

/** 上报一次阅读（后端按 IP 30 分钟去重，同一人反复刷新不会重复计数） */
export async function sendView(path: string): Promise<{ counted: boolean; count: number }> {
  return request<{ ok: boolean; counted: boolean; count: number }>('/api/view', {
    method: 'POST',
    body: { path },
  });
}

export interface StatsPayload {
  ok: boolean;
  viewer: { login: string; name: string; avatar: string };
  totalViews: number;
  todayViews: number;
  totalLikes: number;
  posts: Array<{ path: string; views: number; likes: number }>;
  daily: Array<{ date: string; views: number }>;
  generatedAt: string;
}

/** 站长统计（只有站长账号能拿到数据，不是站长会抛 403） */
export async function fetchStats(): Promise<StatsPayload> {
  return request<StatsPayload>('/api/stats', { withToken: true });
}

/** 登录后取自己的信息 */
async function fetchMe(token: string): Promise<Viewer> {
  const response = await fetch(`${API_BASE}/api/me`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiError(response.status, '登录验证失败，请重试');
  const data = await response.json();
  if (!data || data.ok === false || !data.viewer) throw new ApiError(response.status, '登录验证失败，请重试');
  return {
    id: Number(data.viewer.id) || 0,
    login: String(data.viewer.login || ''),
    name: String(data.viewer.name || data.viewer.login || ''),
    avatar: String(data.viewer.avatar || ''),
  };
}

// ---------------------------------------------------------------------------
// GitHub 登录弹窗
// ---------------------------------------------------------------------------

let loginPromise: Promise<Session> | null = null;

/**
 * 打开 GitHub 登录弹窗，登录成功后 resolve 并写入本地会话。
 * 同一时间只允许一个登录流程。
 *
 * 几个容易出错的细节都在这里处理掉了：
 * - 弹窗每 400ms 会被"敲门"一次，授权页只回一次结果，我们只处理第一条
 * - 授权页会把令牌交出来，然后稍后自动关窗；关窗可能和"正在处理令牌"撞车，
 *   所以关窗检测要留 4 秒宽限，等令牌处理完再判定失败
 */
export function openLogin(): Promise<Session> {
  if (loginPromise) return loginPromise;

  loginPromise = new Promise<Session>((resolve, reject) => {
    let popup: Window | null = null;
    try {
      popup = window.open(
        `${API_BASE}/auth?provider=github&scope=read:user`,
        'melodyxz-site-login',
        'width=560,height=720,menubar=no,toolbar=no,location=yes,status=no'
      );
    } catch {
      popup = null;
    }

    if (!popup) {
      loginPromise = null;
      reject(new ApiError(0, '登录窗口被浏览器拦截了，请允许弹出窗口后重试'));
      return;
    }

    let done = false; // Promise 是否已经结束
    let processing = false; // 是否已收到"登录结果"并正在处理
    let ticks = 0;
    let graceTimer: number | undefined;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.clearInterval(knockTimer);
      if (graceTimer !== undefined) window.clearTimeout(graceTimer);
      window.removeEventListener('message', onMessage);
      try {
        popup?.close();
      } catch {}
      loginPromise = null;
      fn();
    };

    // 每 400ms 向授权页"敲门"，它收到后才会把登录结果交回来
    const knockTimer = window.setInterval(() => {
      ticks += 1;
      if (ticks > 900) {
        finish(() => reject(new ApiError(0, '登录超时，请重试')));
        return;
      }
      // 已经收到结果 / 已经结束，就不用再敲了
      if (processing) return;

      if (popup?.closed) {
        // 弹窗关了，但登录结果可能还在路上（授权页回传后会自动关窗）
        // 给 4 秒宽限，期间收到成功消息就正常完成，否则判定为"没登录完"
        if (graceTimer === undefined) {
          graceTimer = window.setTimeout(() => {
            if (!done && !processing) {
              finish(() => reject(new ApiError(0, '登录窗口已关闭，没有完成登录')));
            }
          }, 4000);
        }
        return;
      }

      try {
        popup?.postMessage('authorizing:github', API_BASE);
      } catch {}
    }, 400);

    const onMessage = async (event: MessageEvent) => {
      if (done || event.origin !== API_BASE) return;
      const data = event.data;
      if (typeof data !== 'string') return;

      if (data.startsWith('authorization:github:error:')) {
        if (processing) return;
        processing = true;
        let message = 'GitHub 登录失败，请重试';
        try {
          const payload = JSON.parse(data.slice('authorization:github:error:'.length));
          if (payload && typeof payload.error === 'string' && payload.error) message = payload.error;
        } catch {}
        finish(() => reject(new ApiError(0, message)));
        return;
      }

      if (!data.startsWith('authorization:github:success:')) return;
      if (processing) return; // 只处理第一条成功消息，避免重复请求
      processing = true;

      let payload: { token?: string } = {};
      try {
        payload = JSON.parse(data.slice('authorization:github:success:'.length));
      } catch {}
      if (!payload.token) {
        finish(() => reject(new ApiError(0, '没有拿到登录令牌，请重试')));
        return;
      }

      try {
        const viewer = await fetchMe(payload.token);
        const session: Session = { ...viewer, token: payload.token, at: Date.now() };
        saveSession(session);
        finish(() => resolve(session));
        dispatchAuthChange();
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new ApiError(0, '登录验证失败')));
      }
    };

    window.addEventListener('message', onMessage);
  });

  return loginPromise;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;

/** 页面底部弹一条简短提示，3 秒后自动消失 */
export function showToast(message: string): void {
  let toast = document.getElementById('melodyxz-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'melodyxz-toast';
    toast.className = 'melodyxz-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast?.classList.remove('is-visible');
  }, 3200);
}
