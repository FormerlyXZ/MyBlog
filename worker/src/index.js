/**
 * melodyxz-cms-auth —— MelodyZzX 博客后台的 GitHub 登录中转站
 * 部署地址：https://auth.melodyxz.top
 *
 * 为什么需要它？
 *   GitHub 的登录回调必须由一个"能保管 Client Secret 的服务器"来处理，
 *   而博客本身是纯静态站点（没有任何服务器）。这个小 Worker 就充当那一环。
 *
 * 它只做两件事：
 *   GET /auth      → 把编辑器弹出的窗口转到 GitHub 授权页
 *   GET /callback  → GitHub 带着 code 回来，换成 access_token，再交还给编辑器
 *
 * 令牌只在这个弹窗里经手一次：不写 KV、不落数据库、不打日志。
 * 除了 melodyxz.top 之外，任何网站都收不到令牌（见 ALLOWED_ORIGINS）。
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

/** 防 CSRF 用的临时 cookie 名 */
const STATE_COOKIE = 'cms_oauth_state';
const STATE_MAX_AGE = 600; // 10 分钟内必须完成登录

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
    }

    if (path === '/auth') return handleAuth(request, url, env);
    if (path === '/callback') return handleCallback(request, url, env);
    if (path === '/') {
      return text('MelodyZzX CMS OAuth 中转站运行正常。\n请从 https://melodyxz.top/admin/ 登录。', 200);
    }
    return text('Not found', 404);
  },
};

/** 第 1 步：把弹窗送去 GitHub 授权页 */
function handleAuth(request, url, env) {
  if (!env.GH_CLIENT_ID) return text('Worker 缺少 GH_CLIENT_ID 环境变量', 500);

  const provider = url.searchParams.get('provider') || 'github';
  if (provider !== 'github') return text('只支持 GitHub 登录', 400);

  // state 一次性随机串，回程时比对，防止别人伪造回调
  const state = randomState();

  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set('client_id', env.GH_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', callbackUrl(url, env));
  // 编辑器会带 scope=repo，GitHub 需要仓库读写权限才能提交文章
  authorize.searchParams.set('scope', url.searchParams.get('scope') || 'repo');
  authorize.searchParams.set('state', state);
  // 只有被授权的账号能登录，不允许从登录流程顺带注册新号
  authorize.searchParams.set('allow_signup', 'false');

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

/** 第 2 步：GitHub 带着 code 回来，换成令牌并交给编辑器 */
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
      message: '登录状态校验失败（state 不匹配或已过期），请回到编辑器重新点一次登录。',
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

/** 结果页：把令牌按 Decap / Sveltia 的 postMessage 协议交回编辑器 */
function resultPage({ ok, locale, token, login, scope, message }) {
  const payload = ok
    ? { provider: 'github', token }
    : { provider: 'github', error: message || '登录失败' };
  const status = ok ? 'success' : 'error';

  const title = ok ? '授权成功' : '授权失败';
  const heading = ok ? '授权完成' : '登录没有成功';
  const detail = ok
    ? `已登录为 <b>${escapeHtml(login || 'GitHub 账号')}</b>${scope ? `（权限：${escapeHtml(scope)}）` : ''}<br />可以关闭这个窗口，回到编辑器继续写文章了。`
    : escapeHtml(message || '请关闭这个窗口，回到编辑器重新登录。');

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
    <p class="hint" id="hint">正在与编辑器通信…</p>
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
        // 编辑器回敲的那一刻，说明对面是活的，可以把结果交出去了
        if (event.data !== 'authorizing:' + PROVIDER) return;
        if (ALLOWED.indexOf(event.origin) === -1) return;
        if (!window.opener) return;
        window.opener.postMessage(
          'authorization:' + PROVIDER + ':' + STATUS + ':' + JSON.stringify(PAYLOAD),
          event.origin
        );
        done = true;
        setHint(PAYLOAD.token ? '已把登录结果交给编辑器，可以关闭这个窗口了。' : '请关闭这个窗口，回到编辑器重新登录。');
        // 留一点时间让消息真正送达，再自动关窗
        setTimeout(function () {
          try { window.close(); } catch (e) {}
        }, 900);
      }

      window.addEventListener('message', receive, false);

      // 敲门：编辑器可能比我们晚准备好，重试几次
      var tries = 0;
      var timer = setInterval(function () {
        if (done || tries++ > 20) { clearInterval(timer); return; }
        if (!window.opener) {
          clearInterval(timer);
          setHint('这个页面需要从 https://melodyxz.top/admin/ 打开，直接访问无效。');
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
// 小工具
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

function text(body, status) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
