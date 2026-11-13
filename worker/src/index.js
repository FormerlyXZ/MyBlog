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
 * ⑤ 站点总览（公开）
 *   GET  /api/site   → { views, likes }  首页侧栏「总阅读 / 总点赞」用，60 秒缓存
 *
 * ⑥ 图床（私有 R2 桶 MEDIA_BUCKET，只有站长能用）
 *   POST   /api/media/upload?key=<路径>   body = 文件二进制，回 { key, url, size }
 *   GET    /api/media/list?prefix=&cursor=  列目录（prefix + "/" 当文件夹用）
 *   POST   /api/media/delete  { keys: [...] }        批量删
 *   POST   /api/media/folder  { key }                建空文件夹（写一个 0 字节占位）
 *   POST   /api/media/move    { from, to }           移动 / 重命名
 *   GET    /api/media/stats   → 已用容量、文件数
 *
 *   读流量白送：公网读的是 picture.melodyxz.top（EdgeOne 边缘 → 私有回源 R2），
 *   写只有这条路 —— 所以桶不用开公开访问，也不需要 R2 的 S3 密钥。
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

/** 文件类型白名单（图床只收这些，避免桶被当成任意网盘） */
const MEDIA_TYPE_PREFIXES = ['image/', 'audio/', 'video/'];
const MEDIA_TYPE_EXACT = new Set([
  'application/pdf',
  'application/zip',
  'application/json',
  'application/epub+zip',
  'text/plain',
  'text/markdown',
  'application/octet-stream',
]);

/** 目录名占位对象的名字：R2 没有目录，靠这个让空目录也能被列出来 */
const FOLDER_MARKER = '.folder';

/**
 * 扩展名 → MIME。
 * list() 拿到的对象不一定带 httpMetadata（实测为空），所以文件名兜底：
 * 我们自己生成的文件名一定带扩展名，用它判断类型足够可靠。
 */
const EXT_MIME = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  pdf: 'application/pdf',
  zip: 'application/zip',
  epub: 'application/epub+zip',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
};

function typeFromKey(key) {
  const dot = key.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = key.slice(dot + 1).toLowerCase();
  return EXT_MIME[ext] || '';
}

/** 对象是不是目录占位（自己写的 .folder、或 R2 控制台建目录时留的空 key） */
function isFolderMarker(key) {
  return key.endsWith(`/${FOLDER_MARKER}`) || key.endsWith('/');
}

/** 一次删多少个键（R2 delete 单次上限 1000） */
const MEDIA_DELETE_LIMIT = 200;

/** 目录级操作（改名 / 整个删掉）一次最多涉及多少个对象 */
const MEDIA_FOLDER_MAX = 500;

/**
 * /api/media/import 允许的源站白名单。
 * 只允许从自己的站点往回搬 —— 不然这个接口就成了任意 URL 的下载器（SSRF）。
 */
const MEDIA_IMPORT_HOSTS = new Set(['www.melodyxz.top', 'melodyxz.top']);

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
      if (path === '/api/site') return await handleSite(env);

      // 图床
      if (path === '/api/media/upload') return await handleMediaUpload(request, url, env);
      if (path === '/api/media/list') return await handleMediaList(request, url, env);
      if (path === '/api/media/delete') return await handleMediaDelete(request, env);
      if (path === '/api/media/folder') return await handleMediaFolder(request, env);
      if (path === '/api/media/folder/rename') return await handleMediaFolderRename(request, env);
      if (path === '/api/media/folder/delete') return await handleMediaFolderDelete(request, env);
      if (path === '/api/media/move') return await handleMediaMove(request, env);
      if (path === '/api/media/import') return await handleMediaImport(request, env);
      if (path === '/api/media/stats') return await handleMediaStats(request, env);

      if (path === '/') {
        return text(
          'MelodyZzX 博客服务运行正常。\n' +
            '后台登录：https://www.melodyxz.top/write/\n' +
            '接口：/api/meta  /api/like  /api/view  /api/stats  /api/site\n' +
            '图床：/api/media/upload  /api/media/list  /api/media/delete  ' +
            '/api/media/folder  /api/media/move  /api/media/stats',
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
  // 注意 Sveltia 会传 "repo,user" 这种逗号分隔的写法，要按逗号和空格都拆分
  const scope = url.searchParams.get('scope') || 'repo';
  const scopeList = scope.split(/[,\s]+/).filter(Boolean);
  for (const item of scopeList) {
    if (!ALLOWED_SCOPES.has(item)) return text(`不支持的 scope：${item}`, 400);
  }

  // state 一次性随机串，回程时比对，防止别人伪造回调
  const state = randomState();

  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set('client_id', env.GH_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', callbackUrl(url, env));
  authorize.searchParams.set('scope', scope);
  authorize.searchParams.set('state', state);
  // 后台登录（含 repo 权限）不允许从登录流程顺带注册新号；前台点赞允许新用户注册 GitHub
  authorize.searchParams.set('allow_signup', scopeList.includes('read:user') ? 'true' : 'false');

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
        // 只把登录结果交出去一次（页面会每 400ms 敲一次门，不能每次都重发）
        if (done) return;
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
        }, 2500);
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
/**
 * 站点总览（公开接口，不需要登录）
 *   GET /api/site → { ok, views, likes }
 *
 * 首页侧栏个人卡的「总阅读 / 总点赞」用它。
 * 只汇总数字，不暴露任何文章路径或访客信息；
 * 结果在 KV 里缓存 60 秒，避免每次打开首页都全量扫描。
 */
async function handleSite(env) {
  if (!env.BLOG_KV) return json({ ok: false, error: 'kv_not_configured' }, 503);

  const cached = await env.BLOG_KV.get('site:summary', 'json');
  if (cached && typeof cached.views === 'number') {
    return json({ ok: true, views: cached.views, likes: cached.likes || 0, cached: true });
  }

  let views = 0;
  let cursor;
  do {
    const page = await env.BLOG_KV.list({ prefix: 'v:', cursor, limit: 1000 });
    for (const item of page.keys) {
      const record = await env.BLOG_KV.get(item.name, 'json');
      if (record) views += Number(record.count) || 0;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  let likes = 0;
  cursor = undefined;
  do {
    const page = await env.BLOG_KV.list({ prefix: 'pl:', cursor, limit: 1000 });
    for (const item of page.keys) {
      const value = await env.BLOG_KV.get(item.name);
      likes += parseInt(value || '0', 10) || 0;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  await env.BLOG_KV.put('site:summary', JSON.stringify({ views, likes }), {
    expirationTtl: 60,
  });

  return json({ ok: true, views, likes });
}

async function handleStats(request, env) {
  if (!env.BLOG_KV) return json({ ok: false, error: 'kv_not_configured' }, 503);

  const viewer = await verifyViewer(request, env);
  if (!viewer) {
    return json({ ok: false, error: 'unauthorized', message: '请先登录 GitHub' }, 401);
  }

  const owners = ownerLogins(env);
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
// ⑥ 图床（R2）
//
// R2 没有真正的「文件夹」——它是一张扁平的 key→对象 表。
// 但只要 key 里带 /，并且列目录时传 delimiter:"/"，就能像文件夹一样用：
//
//   key: "gallery/2026/spring-01.webp"
//   list({ prefix: "gallery/", delimiter: "/" })
//     → delimitedPrefixes: ["gallery/2026/"]   ← 子文件夹
//     → objects:           […直接放在 gallery/ 下的文件…]
//
// 所以前端的「新建文件夹」= 往 <目录>/.folder 写一个 0 字节对象，
// 这样空目录也能被列出来；删掉最后一个文件时那个占位对象会留下，
// 目录不会凭空消失。不需要特别去清，它本身只有 0 字节。
// ---------------------------------------------------------------------------

/** 图床对外的公共域名，结尾不带斜杠 */
function mediaBase(env) {
  return String(env.MEDIA_PUBLIC_BASE || 'https://picture.melodyxz.top').replace(/\/+$/, '');
}

/** key → 可直接放进 <img src> 的公网地址（中文等非 ASCII 分段做百分号编码） */
function mediaUrl(env, key) {
  const encoded = String(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${mediaBase(env)}/${encoded}`;
}

/**
 * 规范化 key：去掉开头的斜杠、把反斜杠当分隔符、禁止 .. 越级。
 * 允许中英文、数字和 - _ . ( ) 空格；不允许控制字符和 ? # %（会和 URL 打架）。
 */
function cleanKey(value) {
  if (typeof value !== 'string') return null;
  let key = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  key = key.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!key || key.length > 400) return null;
  if (/[\u0000-\u001f\u007f]/.test(key)) return null;
  if (/[?#%&]/.test(key)) return null;
  const segments = key.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
    if (segment.length > 120) return null;
    if (/^\s|\s$/.test(segment)) return null;
  }
  return key;
}

/** 目录前缀：空字符串代表根目录；否则必须以 / 结尾 */
function cleanPrefix(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const prefix = cleanKey(value.replace(/\/+$/, ''));
  return prefix ? `${prefix}/` : '';
}

/** Content-Type 是否允许存进来 */
function mediaTypeAllowed(type) {
  const mime = String(type || '').split(';')[0].trim().toLowerCase();
  if (!mime) return 'application/octet-stream';
  if (MEDIA_TYPE_PREFIXES.some((prefix) => mime.startsWith(prefix))) return mime;
  if (MEDIA_TYPE_EXACT.has(mime)) return mime;
  return null;
}

/** 站长权限守卫：失败直接返回一个 Response，成功返回 { viewer } */
async function requireOwner(request, env) {
  const viewer = await verifyViewer(request, env);
  if (!viewer) {
    return { error: json({ ok: false, error: 'unauthorized', message: '请先登录 GitHub' }, 401) };
  }
  if (!ownerLogins(env).includes(String(viewer.login).toLowerCase())) {
    return { error: json({ ok: false, error: 'forbidden', message: '只有站长能管理图床' }, 403) };
  }
  return { viewer };
}

/** 桶里有没有这个绑定 */
function requireBucket(env) {
  if (env.MEDIA_BUCKET) return null;
  return json(
    { ok: false, error: 'bucket_not_configured', message: 'Worker 没有绑定 R2 桶（见 wrangler.toml）' },
    503
  );
}

/**
 * POST /api/media/upload?key=posts/abc.webp&name=原文件名
 * body = 文件二进制，Content-Type 用真实类型。
 *
 * 直接把 request.body 流式灌进 R2：不整块读进内存，
 * 所以传 90MB 的视频也不会把 Worker 的 128MB 内存吃满。
 */
async function handleMediaUpload(request, url, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;

  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;

  const key = cleanKey(url.searchParams.get('key'));
  if (!key) {
    return json({ ok: false, error: 'bad_key', message: '文件路径不合法（不能含 ? # % & 和 ..）' }, 400);
  }

  const rawType = request.headers.get('content-type') || 'application/octet-stream';
  const type = mediaTypeAllowed(rawType);
  if (!type) {
    return json(
      { ok: false, error: 'bad_type', message: `不支持的文件类型：${rawType.split(';')[0]}` },
      415
    );
  }

  const isImage = type.startsWith('image/');
  const maxBytes =
    parseInt(isImage ? env.MEDIA_MAX_IMAGE_BYTES : env.MEDIA_MAX_OTHER_BYTES, 10) ||
    (isImage ? 20 * 1024 * 1024 : 90 * 1024 * 1024);

  // 有 Content-Length 就先拦一次，省得白传
  const declared = parseInt(request.headers.get('content-length') || '0', 10) || 0;
  if (declared > maxBytes) {
    return json(
      {
        ok: false,
        error: 'too_large',
        message: `文件太大（${formatBytes(declared)}），上限 ${formatBytes(maxBytes)}`,
      },
      413
    );
  }
  if (!request.body) {
    return json({ ok: false, error: 'empty_body', message: '没有收到文件内容' }, 400);
  }

  const originalName = (url.searchParams.get('name') || '').slice(0, 200);
  // 前端压缩后顺手把像素尺寸带上来，媒体库预览时能直接显示「1600 × 1200」
  const width = parseInt(url.searchParams.get('w') || '0', 10) || 0;
  const height = parseInt(url.searchParams.get('h') || '0', 10) || 0;

  let object;
  try {
    object = await env.MEDIA_BUCKET.put(key, request.body, {
      httpMetadata: {
        contentType: type,
        // 文件名带时间戳和随机后缀，同样的地址内容永远不变 → 可以放心长缓存
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        uploadedBy: String(guard.viewer.login),
        ...(originalName ? { originalName } : {}),
        ...(width > 0 && height > 0 ? { width: String(width), height: String(height) } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 实际大小超限时 R2 那边会在流读到一半报错，这里兜住给个明确提示
    if (/exceed|too large|size/i.test(message)) {
      return json({ ok: false, error: 'too_large', message: '文件太大，请压缩后再传' }, 413);
    }
    throw error;
  }

  const size = object?.size ?? declared;
  return json({ ok: true, key, url: mediaUrl(env, key), size, type });
}

/**
 * GET /api/media/list?prefix=gallery/&cursor=xxx&limit=200
 * → { prefix, folders: [...], files: [...], cursor, truncated }
 *
 * folders 是子目录名（不含父路径），files 里每项都带好 url 和 size，
 * 前端拿到就能直接渲染，不用自己拼域名。
 */
async function handleMediaList(request, url, env) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;

  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;

  const prefix = cleanPrefix(url.searchParams.get('prefix'));
  const cursor = url.searchParams.get('cursor') || undefined;
  const limit = Math.min(500, Math.max(20, parseInt(url.searchParams.get('limit') || '200', 10) || 200));

  const listing = await env.MEDIA_BUCKET.list({ prefix, delimiter: '/', cursor, limit });

  const folders = [];
  for (const full of listing.delimitedPrefixes || []) {
    const name = full.slice(prefix.length).replace(/\/$/, '');
    if (name) folders.push({ name, prefix: full });
  }

  const files = [];
  for (const object of listing.objects || []) {
    // 目录占位对象不当文件展示
    if (object.key === `${prefix}${FOLDER_MARKER}` || isFolderMarker(object.key)) continue;
    const meta = object.customMetadata || {};
    const type = object.httpMetadata?.contentType || typeFromKey(object.key);
    files.push({
      key: object.key,
      name: object.key.slice(prefix.length),
      url: mediaUrl(env, object.key),
      size: object.size,
      uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded || ''),
      type,
      // 上传时顺手记下的像素尺寸，列表直接带出去，前端不用再探测一遍
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
    });
  }

  // 新传的排前面
  files.sort((a, b) => (a.uploaded < b.uploaded ? 1 : a.uploaded > b.uploaded ? -1 : 0));

  return json({
    ok: true,
    prefix,
    folders,
    files,
    cursor: listing.truncated ? listing.cursor : null,
    truncated: Boolean(listing.truncated),
    parent: prefix ? prefix.replace(/[^/]+\/$/, '') : null,
  });
}

/** POST /api/media/delete  { keys: ["a/b.webp", ...] } */
async function handleMediaDelete(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;

  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const raw = Array.isArray(body?.keys) ? body.keys : [];
  const keys = [];
  for (const item of raw) {
    const key = cleanKey(item);
    if (key && !keys.includes(key)) keys.push(key);
  }
  if (!keys.length) return json({ ok: false, error: 'bad_keys', message: '没有要删除的文件' }, 400);
  if (keys.length > MEDIA_DELETE_LIMIT) {
    return json({ ok: false, error: 'too_many', message: `一次最多删 ${MEDIA_DELETE_LIMIT} 个` }, 400);
  }

  // 传目录前缀时，把这个目录下的占位对象也一起删掉，免得空目录残留在列表里
  const extras = keys.filter((key) => !key.endsWith(`/${FOLDER_MARKER}`)).map((key) => `${key}/${FOLDER_MARKER}`);

  await env.MEDIA_BUCKET.delete([...keys, ...extras]);
  return json({ ok: true, deleted: keys.length });
}

/** POST /api/media/folder  { key: "gallery/2026" } —— 建一个空文件夹 */
async function handleMediaFolder(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;

  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const key = cleanKey(body?.key);
  if (!key) return json({ ok: false, error: 'bad_key', message: '文件夹名不合法' }, 400);

  const marker = `${key}/${FOLDER_MARKER}`;
  await env.MEDIA_BUCKET.put(marker, new Uint8Array(0), {
    httpMetadata: { contentType: 'application/x-empty' },
    customMetadata: { uploadedBy: String(guard.viewer.login) },
  });

  return json({ ok: true, key, prefix: `${key}/` });
}

/** POST /api/media/move  { from: "a/x.webp", to: "b/x.webp" } —— 移动 / 重命名 */
async function handleMediaMove(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;

  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const from = cleanKey(body?.from);
  const to = cleanKey(body?.to);
  if (!from || !to) return json({ ok: false, error: 'bad_key', message: '路径不合法' }, 400);
  if (from === to) return json({ ok: true, key: to, url: mediaUrl(env, to), moved: false });

  const object = await env.MEDIA_BUCKET.get(from);
  if (!object) return json({ ok: false, error: 'not_found', message: '找不到这个文件' }, 404);

  // R2 没有 rename：只能读出来重新写一份，再删旧的
  await env.MEDIA_BUCKET.put(to, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: {
      ...object.customMetadata,
      movedBy: String(guard.viewer.login),
      movedFrom: from,
    },
  });
  await env.MEDIA_BUCKET.delete(from);

  return json({ ok: true, key: to, url: mediaUrl(env, to), moved: true });
}

/** 把某个前缀下的所有 key 翻出来（不带 delimiter，递归到底） */
async function listAllKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.MEDIA_BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects || []) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * POST /api/media/folder/rename  { from: "gallery", to: "photos" }
 * 目录改名 = 把 from/ 下的所有对象搬到 to/ 下（含子目录和占位对象）。
 * R2 没有目录，所以这是一个一个搬的；超过上限就直接拒绝，免得卡死。
 */
async function handleMediaFolderRename(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;

  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const from = cleanKey(body?.from);
  const to = cleanKey(body?.to);
  if (!from || !to) return json({ ok: false, error: 'bad_key', message: '文件夹名不合法' }, 400);
  if (from === to) return json({ ok: true, moved: 0 });
  if (to.startsWith(`${from}/`)) {
    return json({ ok: false, error: 'bad_target', message: '不能把文件夹移到它自己里面' }, 400);
  }

  const keys = await listAllKeys(env, `${from}/`);
  if (!keys.length) return json({ ok: false, error: 'not_found', message: '这个文件夹是空的或不存在' }, 404);
  if (keys.length > MEDIA_FOLDER_MAX) {
    return json(
      {
        ok: false,
        error: 'too_many',
        message: `文件夹里有 ${keys.length} 个对象，超过一次能搬的上限（${MEDIA_FOLDER_MAX}），请分批移动`,
      },
      400
    );
  }

  let moved = 0;
  const failures = [];
  for (const key of keys) {
    const target = `${to}/${key.slice(from.length + 1)}`;
    try {
      const object = await env.MEDIA_BUCKET.get(key);
      if (!object) continue;
      await env.MEDIA_BUCKET.put(target, object.body, {
        httpMetadata: object.httpMetadata,
        customMetadata: { ...object.customMetadata, movedBy: String(guard.viewer.login), movedFrom: key },
      });
      await env.MEDIA_BUCKET.delete(key);
      moved += 1;
    } catch (error) {
      failures.push(key);
    }
  }

  return json({ ok: true, moved, failed: failures.length, total: keys.length, prefix: `${to}/` });
}

/**
 * POST /api/media/folder/delete  { key: "gallery" }
 * 目录连同内容一起删（危险操作，前端会二次确认）。
 */
async function handleMediaFolderDelete(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;

  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const key = cleanKey(body?.key);
  if (!key) return json({ ok: false, error: 'bad_key', message: '文件夹名不合法' }, 400);

  const keys = await listAllKeys(env, `${key}/`);
  if (!keys.length) {
    // 目录可能只剩一个空占位
    await env.MEDIA_BUCKET.delete(`${key}/${FOLDER_MARKER}`);
    return json({ ok: true, deleted: 0 });
  }
  if (keys.length > MEDIA_FOLDER_MAX) {
    return json(
      {
        ok: false,
        error: 'too_many',
        message: `文件夹里有 ${keys.length} 个文件，超过一次能删的上限（${MEDIA_FOLDER_MAX}）`,
      },
      400
    );
  }

  for (let index = 0; index < keys.length; index += 500) {
    await env.MEDIA_BUCKET.delete(keys.slice(index, index + 500));
  }

  return json({ ok: true, deleted: keys.length });
}

/**
 * POST /api/media/import  { from: "https://www.melodyxz.top/music/audio/x.m4a", key: "music/x.m4a" }
 *
 * 把仓库里已经在线的文件搬进图床 —— 服务器到服务器，不经过用户带宽。
 * 从国内往 Cloudflare 上传只有 20–30 KB/s，243MB 音乐让浏览器传要几小时；
 * 让 Worker 自己去站点上取（EdgeOne 国内节点，几 MB/s）再写进 R2，几十秒就完了。
 *
 * 源站限制在 MEDIA_IMPORT_HOSTS 里，避免被当成任意 URL 下载器。
 */
async function handleMediaImport(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;

  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const key = cleanKey(body?.key);
  if (!key) return json({ ok: false, error: 'bad_key', message: '目标路径不合法' }, 400);

  let source;
  try {
    source = new URL(String(body?.from || ''));
  } catch {
    return json({ ok: false, error: 'bad_source', message: '源地址不合法' }, 400);
  }
  if (source.protocol !== 'https:' || !MEDIA_IMPORT_HOSTS.has(source.hostname)) {
    return json(
      { ok: false, error: 'bad_source', message: `只允许从 ${[...MEDIA_IMPORT_HOSTS].join(' / ')} 搬运` },
      400
    );
  }

  const maxBytes =
    parseInt(env.MEDIA_MAX_OTHER_BYTES, 10) || 90 * 1024 * 1024;

  let response;
  try {
    response = await fetch(source.href, {
      headers: { 'user-agent': 'melodyxz-media-import' },
      redirect: 'follow',
    });
  } catch (error) {
    return json({ ok: false, error: 'fetch_failed', message: '取不到源文件（网络问题）' }, 502);
  }
  if (!response.ok || !response.body) {
    return json(
      { ok: false, error: 'fetch_failed', message: `源文件返回 ${response.status}` },
      502
    );
  }

  const declared = parseInt(response.headers.get('content-length') || '0', 10) || 0;
  if (declared > maxBytes) {
    return json(
      { ok: false, error: 'too_large', message: `源文件太大（${formatBytes(declared)}）` },
      413
    );
  }

  const type =
    mediaTypeAllowed(response.headers.get('content-type')) || typeFromKey(key) || 'application/octet-stream';

  const object = await env.MEDIA_BUCKET.put(key, response.body, {
    httpMetadata: {
      contentType: type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      uploadedBy: String(guard.viewer.login),
      importedFrom: source.pathname.slice(0, 300),
    },
  });

  return json({
    ok: true,
    key,
    url: mediaUrl(env, key),
    size: object?.size ?? declared,
    type,
  });
}

/**
 * GET /api/media/stats → { files, bytes, quotaBytes, free }
 * 逐页扫一遍全桶求和。文件数上千时也就几秒钟，媒体库页打开时看一眼够用。
 */
async function handleMediaStats(request, env) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;

  const guard = await requireOwner(request, env);
  if (guard.error) return guard.error;

  let files = 0;
  let bytes = 0;
  const byType = { image: 0, audio: 0, video: 0, other: 0 };
  // 一级目录汇总（/media/ 左侧分类栏用它显示「posts 12 个」）
  const top = new Map();
  let cursor;
  do {
    const page = await env.MEDIA_BUCKET.list({ prefix: '', cursor, limit: 1000 });
    for (const object of page.objects || []) {
      if (isFolderMarker(object.key)) continue;
      files += 1;
      bytes += object.size || 0;
      const type = object.httpMetadata?.contentType || typeFromKey(object.key);
      if (type.startsWith('image/')) byType.image += 1;
      else if (type.startsWith('audio/')) byType.audio += 1;
      else if (type.startsWith('video/')) byType.video += 1;
      else byType.other += 1;

      const slash = object.key.indexOf('/');
      const folder = slash === -1 ? '' : object.key.slice(0, slash);
      const entry = top.get(folder) || { name: folder, files: 0, bytes: 0 };
      entry.files += 1;
      entry.bytes += object.size || 0;
      top.set(folder, entry);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const folders = [...top.values()].sort((a, b) => a.name.localeCompare(b.name));

  return json({
    ok: true,
    files,
    bytes,
    byType,
    folders,
    // R2 免费额度 10GB/月（存储），拿来做进度条
    quotaBytes: 10 * 1024 * 1024 * 1024,
    publicBase: mediaBase(env),
  });
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
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

/** 站长 GitHub 用户名列表（小写），统计页和图床共用 */
function ownerLogins(env) {
  return String(env.OWNER_LOGINS || 'FormerlyXZ')
    .split(',')
    .map((item) => item.trim().toLowerCase())
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
    'access-control-allow-headers': 'authorization, content-type, accept',
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
