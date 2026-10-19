/**
 * melodyxz-cms-auth —— MelodyZzX 博客的 Cloudflare Worker
 * 部署地址：https://auth.melodyxz.top
 *
 * 它一共做四件事：
 *
 * ① 后台登录中转（原来就有）
 *   GET /auth      → 把编辑器弹出的窗口转到 GitHub 授权页
 *   GET /callback  → GitHub 带着 code 回来，换成 access_token，再交还给编辑器
 *
 * ② 前台 GitHub 登录（站内点赞用）——复用同一套 OAuth App，scope 换成了 read:user
 *   前台页面打开弹窗 → 用户点 Authorize → 结果页把令牌通过 postMessage 交回前台
 *
 * ③ 点赞 + 阅读数（存在 KV 里，命名空间绑定名 BLOG_KV）
 *   GET  /api/meta   ?paths=/posts/a/,/posts/b/   读点赞数、阅读数、我是否点过赞
 *   POST /api/like   { path, action: "like"|"unlike" }   需要 Bearer 令牌
 *   POST /api/view   { path }                    记录一次阅读（按 IP 30 分钟内去重）
 *
 * ④ 站长统计
 *   GET  /api/stats  → 总阅读、今日阅读、总点赞、每篇排行、近 14 天趋势
 *   （只有环境变量 OWNER_LOGINS 里列出的 GitHub 账号能看到）
 *
 * 令牌只在这个弹窗里经手一次：不写 KV、不落库、不打日志。
 * 除站点自己的来源外，任何网站都收不到令牌（见 ALLOWED_ORIGINS）。
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

/** 防 CSRF 用的临时 cookie 名 */
const STATE_COOKIE = 'cms_oauth_state';
const STATE_MAX_AGE = 600; // 10 分钟内必须完成登录

/** 允许的 OAuth scope：repo 给后台编辑器；read:user 给前台点赞登录 */
const ALLOWED_SCOPES = new Set(['repo', 'read:user', 'user:email', 'user']);

/** 记录"这个人 30 分钟内看过这一页"，用于阅读数去重 */
const VIEW_DEDUPE_TTL = 1800;

/** 统计页展示最近多少天的趋势 */
const DAILY_WINDOW = 14;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return preflight();

    try {
      if (path === '/auth') return await handleAuth(request, url, env);
      if (path === '/callback') return await handleCallback(request, url, env);

      if (path === '/api/me') return await handleMe(request, env);
      if (path === '/api/meta') return await handleMeta(request, url, env);
      if (path === '/api/like') return await handleLike(request, env);
      if (path === '/api/view') return await handleView(request, env);
      if (path === '/api/stats') return await handleStats(request, env);

      if (path === '/') {
        return text(
          'MelodyZzX 博客服务运行正常。\n' +
            '后台登录：https://melodyxz.top/admin/\n' +
            '接口：/api/meta  /api/like  /api/view  /api/stats',
          200,
          corsHeaders()
        );
      }
      return text('Not found', 404, corsHeaders());
    } catch (error) {
      console.error('worker_error', error);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// ① / ② OAuth：后台登录和前台登录共用
// ---------------------------------------------------------------------------

/** 第 1 步：把弹窗送去 GitHub 授权页 */
function handleAuth(request, url, env) {
  if (!env.GH_CLIENT_ID) return text('Worker 缺少 GH_CLIENT_ID 环境变量', 500);

  const provider = url.searchParams.get('provider') || 'github';
  if (provider !== 'github') return text('只支持 GitHub 登录', 400);

  // scope 白名单：前台只允许 read:user，后台编辑器用 repo
  const scope = url.searchParams.get('scope') || 'repo';
  for (const item of scope.split(/\s+/).filter(Boolean)) {
    if (!ALLOWED_SCOPES.has(item)) return text(`不支持的 scope：${item}`, 400);
  }

  // state 一次性随机串，回程时比对，防止别人伪造回调
  const state = randomState();

  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set('client_id', env.GH_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', callbackUrl(url, env));
  authorize.searchParams.set('scope', scope);
  authorize.searchParams.set('state', state);
  // 后台登录（repo）不允许从登录流程顺带注册新号；前台点赞允许新用户注册 GitHub
  authorize.searchParams.set('allow_signup', scope === 'read:user' ? 'true' : 'false');

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.href,
      'cache-control': 'no-store',
      'set-cookie': [
        `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_MAX_AGE}`,
      ].join(', '),
    },
  });
}

/** 第 2 步：GitHub 带着 code 回来，换成令牌并交给页面 */
async function handleCallback(request, url, env) {
  const allowed = allowedOrigins(env);

  const ghError = url.searchParams.get('error');
  if (ghError) {
    const desc = url.searchParams.get('error_description') || ghError;
    return resultPage({ ok: false, locale: allowed, message: `GitHub 返回了错误：${desc}` });
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = readCookie(request, STATE_COOKIE);

  if (!code) {
    return resultPage({ ok: false, locale: allowed, message: '回调里没有 code 参数，登录未完成。' });
  }
  if (!state || !cookieState || state !== cookieState) {
    return resultPage({
      ok: false,
      locale: allowed,
      message: '登录状态校验失败（state 不匹配或已过期），请回到页面重新点一次登录。',
    });
  }
  if (!env.GH_CLIENT_ID || !env.GH_CLIENT_SECRET) {
    return resultPage({ ok: false, locale: allowed, message: 'Worker 缺少 GH_CLIENT_ID / GH_CLIENT_SECRET。' });
  }

  // 用 code 换 access_token
  let data = {};
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'melodyxz-cms-auth',
      },
      body: new URLSearchParams({
        client_id: env.GH_CLIENT_ID,
        client_secret: env.GH_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl(url, env),
      }),
    });
    data = await response.json();
  } catch (error) {
    return resultPage({
      ok: false,
      locale: allowed,
      message: `向 GitHub 换取令牌时网络出错：${error instanceof Error ? error.message : error}`,
    });
  }

  if (data.error || !data.access_token) {
    const reason = data.error_description || data.error || 'GitHub 没有返回 access_token';
    return resultPage({ ok: false, locale: allowed, message: `换取令牌失败：${reason}` });
  }

  // 顺手问一下是谁登录的，只用于页面上显示，失败也不影响登录
  const login = await fetchLogin(data.access_token);

  return resultPage({
    ok: true,
    locale: allowed,
    token: data.access_token,
    login,
    scope: data.scope,
  });
}

/** 结果页：把令牌按 Decap / Sveltia 的 postMessage 协议交回页面 */
function resultPage({ ok, locale, token, login, scope, message }) {
  const payload = ok
    ? { provider: 'github', token }
    : { provider: 'github', error: message || '登录失败' };
  const status = ok ? 'success' : 'error';

  const title = ok ? '授权成功' : '授权失败';
  const heading = ok ? '授权完成' : '登录没有成功';
  const detail = ok
    ? `已登录为 <b>${escapeHtml(login || 'GitHub 账号')}</b>${scope ? `（权限：${escapeHtml(scope)}）` : ''}<br />可以关闭这个窗口，回到页面继续了。`
    : escapeHtml(message || '请关闭这个窗口，回到页面重新登录。');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; font-family: system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif; background:#f6f8fa; color:#24292f; }
  .card { max-width:26rem; padding:2rem 1.75rem; background:#fff; border:1px solid #d0d7de; border-radius:12px; text-align:center; line-height:1.8; }
  .mark { font-size:2rem; line-height:1; margin-bottom:.6rem; }
  h1 { font-size:1.1rem; margin:0 0 .6rem; }
  p { margin:0; color:#57606a; font-size:.95rem; }
  .hint { margin-top:1rem; font-size:.8rem; color:#8c959f; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">${ok ? '✅' : '⚠️'}</div>
    <h1>${heading}</h1>
    <p id="detail">${detail}</p>
    <p class="hint" id="hint">正在与页面通信…</p>
  </div>
  <script>
    (function () {
      var PROVIDER = 'github';
      var STATUS = ${JSON.stringify(status)};
      var PAYLOAD = ${jsonToScript(payload)};
      var ALLOWED = ${jsonToScript(locale)};
      var done = false;
      var hint = document.getElementById('hint');

      function setHint(t) { if (hint) hint.textContent = t; }

      function receive(event) {
        // 页面回敲的那一刻，说明对面是活的，可以把结果交出去了
        if (event.data !== 'authorizing:' + PROVIDER) return;
        if (ALLOWED.indexOf(event.origin) === -1) return;
        if (!window.opener) return;
        window.opener.postMessage(
          'authorization:' + PROVIDER + ':' + STATUS + ':' + JSON.stringify(PAYLOAD),
          event.origin
        );
        done = true;
        setHint(PAYLOAD.token ? '已把登录结果交给页面，可以关闭这个窗口了。' : '请关闭这个窗口，回到页面重新登录。');
        // 留一点时间让消息真正送达，再自动关窗
        setTimeout(function () {
          try { window.close(); } catch (e) {}
        }, 900);
      }

      window.addEventListener('message', receive, false);

      // 敲门：页面可能比我们晚准备好，重试几次
      var tries = 0;
      var timer = setInterval(function () {
        if (done || tries++ > 30) { clearInterval(timer); return; }
        if (!window.opener) {
          clearInterval(timer);
          setHint('这个页面需要从博客页面打开，直接访问无效。');
          return;
        }
        try { window.opener.postMessage('authorizing:' + PROVIDER, '*'); } catch (e) {}
      }, 250);
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: ok ? 200 : 400,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // 登录结果页不允许被任何页面嵌套
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'set-cookie': `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}

// ---------------------------------------------------------------------------
// ③ 点赞 / 阅读数
// ---------------------------------------------------------------------------

/** 校验登录令牌，返回 { id, login, name, avatar } 或 null。结果在 KV 里缓存 1 小时 */
async function verifyViewer(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;

  const token = match[1].trim();
  if (!token || token.length > 512) return null;

  const cacheKey = `user:${await sha256(token)}`;
  if (env.BLOG_KV) {
    try {
      const cached = await env.BLOG_KV.get(cacheKey, 'json');
      if (cached) return cached;
    } catch {
      /* KV 不可用时继续走 GitHub 校验 */
    }
  }

  try {
    const response = await fetch(USER_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'melodyxz-blog',
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || typeof data.login !== 'string') return null;

    const viewer = {
      id: data.id,
      login: data.login,
      name: typeof data.name === 'string' && data.name ? data.name : data.login,
      avatar: typeof data.avatar_url === 'string' ? data.avatar_url : '',
    };
    if (env.BLOG_KV) {
      try {
        await env.BLOG_KV.put(cacheKey, JSON.stringify(viewer), { expirationTtl: 3600 });
      } catch {
        /* 缓存失败不影响登录 */
      }
    }
    return viewer;
  } catch {
    return null;
  }
}

/** GET /api/me —— 前台登录后用来取自己的头像、昵称 */
async function handleMe(request, env) {
  const viewer = await verifyViewer(request, env);
  if (!viewer) return json({ ok: false, error: 'unauthorized', message: '登录已过期，请重新登录' }, 401);
  return json({ ok: true, viewer });
}

/** GET /api/meta?paths=/posts/a/,/posts/b/ —— 点赞数、阅读数、我是否点过赞 */
async function handleMeta(request, url, env) {
  if (!env.BLOG_KV) return json({ ok: false, error: 'kv_not_configured' }, 503);

  const paths = readPaths(url.searchParams.get('paths'));
  if (!paths.length) return json({ ok: false, error: 'missing_paths', message: '缺少 paths 参数' }, 400);

  const viewer = await verifyViewer(request, env);
  const items = {};

  for (const path of paths) {
    const [likes, record, liked] = await Promise.all([
      getCounter(env, `pl:${path}`),
      readViewRecord(env, path),
      viewer ? env.BLOG_KV.get(`like:${viewer.id}:${path}`) : Promise.resolve(null),
    ]);
    items[path] = { likes, views: record.count, liked: Boolean(liked) };
  }

  return json({ ok: true, viewer: viewer ? { login: viewer.login } : null, items });
}

/** POST /api/like —— 登录后点赞 / 取消点赞 */
async function handleLike(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.BLOG_KV) return json({ ok: false, error: 'kv_not_configured' }, 503);

  const viewer = await verifyViewer(request, env);
  if (!viewer) {
    return json({ ok: false, error: 'unauthorized', message: '请先登录 GitHub 再点赞' }, 401);
  }

  const body = await readJson(request);
  const path = cleanPath(body && body.path);
  if (!path) return json({ ok: false, error: 'bad_path', message: '文章地址不合法' }, 400);

  const action = body && body.action === 'unlike' ? 'unlike' : 'like';
  const userKey = `like:${viewer.id}:${path}`;
  const countKey = `pl:${path}`;

  const existing = await env.BLOG_KV.get(userKey);
  let count = await getCounter(env, countKey);

  if (action === 'like' && existing) {
    // 已经点过，直接返回，不重复计数
    return json({ ok: true, liked: true, count });
  }
  if (action === 'unlike' && !existing) {
    return json({ ok: true, liked: false, count });
  }

  if (action === 'like') {
    await env.BLOG_KV.put(userKey, '1');
    count += 1;
  } else {
    await env.BLOG_KV.delete(userKey);
    count = Math.max(0, count - 1);
  }
  await env.BLOG_KV.put(countKey, String(count));

  return json({ ok: true, liked: action === 'like', count });
}

/** POST /api/view —— 记录一次阅读（同一 IP 30 分钟内只算一次） */
async function handleView(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.BLOG_KV) return json({ ok: false, error: 'kv_not_configured' }, 503);

  const body = await readJson(request);
  const path = cleanPath(body && body.path);
  if (!path) return json({ ok: false, error: 'bad_path', message: '文章地址不合法' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const seenKey = `seen:${await sha1(`${ip}|${path}`)}`;
  const seen = await env.BLOG_KV.get(seenKey);

  const record = await readViewRecord(env, path);
  let counted = false;

  if (!seen) {
    await env.BLOG_KV.put(seenKey, '1', { expirationTtl: VIEW_DEDUPE_TTL });
    const today = todayInChina();
    record.count += 1;
    record.days[today] = (record.days[today] || 0) + 1;
    record.days = trimDays(record.days);
    await env.BLOG_KV.put(`v:${path}`, JSON.stringify(record));
    counted = true;
  }

  return json({ ok: true, counted, count: record.count });
}

/** GET /api/stats —— 站长统计（只有 OWNER_LOGINS 里的账号能看） */
async function handleStats(request, env) {
  if (!env.BLOG_KV) return json({ ok: false, error: 'kv_not_configured' }, 503);

  const viewer = await verifyViewer(request, env);
  if (!viewer) {
    return json({ ok: false, error: 'unauthorized', message: '请先登录 GitHub' }, 401);
  }

  const owners = String(env.OWNER_LOGINS || 'FormerlyXZ')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!owners.includes(String(viewer.login).toLowerCase())) {
    return json({ ok: false, error: 'forbidden', message: '这不是站长账号，看不到统计' }, 403);
  }

  // 逐篇阅读数
  const records = new Map();
  let cursor;
  do {
    const page = await env.BLOG_KV.list({ prefix: 'v:', cursor, limit: 1000 });
    for (const item of page.keys) {
      const path = item.name.slice(2);
      if (!path.startsWith('/')) continue;
      const record = await env.BLOG_KV.get(item.name, 'json');
      if (record) records.set(path, record);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  // 逐篇点赞数
  const likeCounts = new Map();
  cursor = undefined;
  do {
    const page = await env.BLOG_KV.list({ prefix: 'pl:', cursor, limit: 1000 });
    for (const item of page.keys) {
      const path = item.name.slice(3);
      const value = await env.BLOG_KV.get(item.name);
      likeCounts.set(path, parseInt(value || '0', 10) || 0);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const today = todayInChina();
  let totalViews = 0;
  let todayViews = 0;
  let totalLikes = 0;
  const daily = new Map();
  const posts = [];

  for (const [path, record] of records) {
    const count = Number(record.count) || 0;
    totalViews += count;
    if (record.days && record.days[today]) todayViews += Number(record.days[today]) || 0;
    for (const [day, value] of Object.entries(record.days || {})) {
      daily.set(day, (daily.get(day) || 0) + (Number(value) || 0));
    }
    const likes = likeCounts.get(path) || 0;
    totalLikes += likes;
    posts.push({ path, views: count, likes });
  }
  // 有点赞但还没阅读记录的文章（极少见）也要算进总点赞
  for (const [path, likes] of likeCounts) {
    if (!records.has(path)) totalLikes += likes;
  }

  posts.sort((a, b) => b.views - a.views || b.likes - a.likes);

  const series = [];
  for (let offset = DAILY_WINDOW - 1; offset >= 0; offset -= 1) {
    const date = dateOffsetInChina(-offset);
    series.push({ date, views: daily.get(date) || 0 });
  }

  return json({
    ok: true,
    viewer: { login: viewer.login, name: viewer.name, avatar: viewer.avatar },
    totalViews,
    todayViews,
    totalLikes,
    posts: posts.slice(0, 60),
    daily: series,
    generatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// KV 小工具
// ---------------------------------------------------------------------------

async function getCounter(env, key) {
  const value = await env.BLOG_KV.get(key);
  return parseInt(value || '0', 10) || 0;
}

async function readViewRecord(env, path) {
  const record = await env.BLOG_KV.get(`v:${path}`, 'json');
  if (record && typeof record === 'object') {
    return {
      count: Number(record.count) || 0,
      days: record.days && typeof record.days === 'object' ? record.days : {},
    };
  }
  return { count: 0, days: {} };
}

/** 只保留最近 30 天，避免 KV 值无限变大 */
function trimDays(days) {
  const keys = Object.keys(days).sort();
  while (keys.length > 30) {
    delete days[keys.shift()];
  }
  return days;
}

/** 中国时区的今天，格式 YYYY-MM-DD */
function todayInChina() {
  return dateOffsetInChina(0);
}

function dateOffsetInChina(offsetDays) {
  const now = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return now.toISOString().slice(0, 10);
}

/** paths 参数：/posts/a/,/posts/b/ 这种逗号分隔 */
function readPaths(value) {
  if (typeof value !== 'string' || !value) return [];
  const paths = [];
  for (const raw of value.split(',')) {
    const path = cleanPath(raw.trim());
    if (path && paths.length < 30 && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** 只接受站内路径（以 / 开头、无空格和控制字符、长度不超过 300） */
function cleanPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path || path.length > 300) return null;
  if (!path.startsWith('/')) return null;
  if (/[\u0000-\u0020\u007f]/.test(path)) return null;
  return path;
}

// ---------------------------------------------------------------------------
// 网络 / 加密小工具
// ---------------------------------------------------------------------------

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || 'https://melodyxz.top,https://www.melodyxz.top')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function callbackUrl(url, env) {
  if (env.CALLBACK_URL) return env.CALLBACK_URL;
  return new URL('/callback', url).href;
}

function randomState() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

async function fetchLogin(token) {
  try {
    const response = await fetch(USER_URL, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'melodyxz-cms-auth' },
    });
    if (!response.ok) return '';
    const user = await response.json();
    return typeof user?.login === 'string' ? user.login : '';
  } catch {
    return '';
  }
}

async function sha256(value) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha1(value) {
  const buffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// HTTP 响应小工具
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
  };
}

function preflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(),
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 把值塞进 <script> 里：转义 < 防止提前闭合标签 */
function jsonToScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function text(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}
