# worker/ —— 后台登录中转站（Cloudflare Worker）

这个目录放的是一段很小的云端代码，部署后地址是 **https://auth.melodyxz.top**。

## 它为什么存在

博客本身是纯静态的：只有一堆 `.md` 和 `.html` 文件，没有任何服务器。
而 GitHub 的登录流程必须有一个"能保管 Client Secret 的服务器"去换令牌，
浏览器端不能直接做这件事（会泄露密钥）。

所以：**编辑器（浏览器）→ 这个 Worker → GitHub**，Worker 只是中转一下，
拿到令牌立刻交给编辑器，自己不存储、不打印。

## 它做什么

| 路径 | 作用 |
| --- | --- |
| `GET /auth` | 收到编辑器的请求，生成一次性 `state`，把人送到 GitHub 授权页 |
| `GET /callback` | GitHub 带 `code` 回来，校验 `state`，用 code 换令牌，再交给编辑器 |
| `GET /` | 健康检查，返回一行文字 |

安全措施：

- `state` 存在 HttpOnly + Secure + SameSite=Lax 的 cookie 里，10 分钟过期，防伪造回调。
- 令牌只 postMessage 给 `ALLOWED_ORIGINS` 白名单里的站点（默认只有 `melodyxz.top`）。
- 结果页 `X-Frame-Options: DENY`，不能被别的页面套壳。

## 需要的环境变量

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `GH_CLIENT_ID` | 明文（写在 `wrangler.toml`） | GitHub OAuth App 的 Client ID |
| `GH_CLIENT_SECRET` | **Secret（只在 Cloudflare 里）** | GitHub OAuth App 的 Client Secret |
| `ALLOWED_ORIGINS` | 明文（写在 `wrangler.toml`） | 允许收令牌的站点，逗号分隔 |

## 首次部署

```bash
# 1) 登录 Cloudflare（会打开浏览器，点 Allow 即可）
npx wrangler login

# 2) 部署（会自动创建 Worker + 绑定 auth.melodyxz.top + 申请证书）
npx wrangler deploy --config worker/wrangler.toml

# 3) 写入密钥（粘贴 GitHub 的 Client Secret，不会显示在屏幕上）
npx wrangler secret put GH_CLIENT_SECRET --config worker/wrangler.toml
```

改完代码后，只需要重跑第 2 步。

## 配套的 GitHub OAuth App

- 位置：GitHub → Settings → Developer settings → OAuth Apps → `MelodyZzX Blog CMS`
- Homepage URL：`https://melodyxz.top`
- Authorization callback URL：`https://auth.melodyxz.top/callback`
- 「Expire user access tokens」**保持关闭**：否则令牌 8 小时就过期，日志里会出现频繁掉登录。

要换域名或重建 App 时，这三处（App 配置、`wrangler.toml` 的 `GH_CLIENT_ID`、
Cloudflare 里的 `GH_CLIENT_SECRET`）必须同时更新。

## 出问题怎么查

| 现象 | 排查 |
| --- | --- |
| 编辑器点登录后窗口一闪而过 | `https://auth.melodyxz.top/` 打不开 → Worker 没部署或自定义域名没生效 |
| 提示 `redirect_uri mismatch` | GitHub App 里的回调地址和实际地址不一致（注意结尾不要多斜杠） |
| 提示「state 不匹配或已过期」 | cookie 被浏览器拦了（关掉隐私插件），或登录拖了超过 10 分钟 |
| 授权成功了但编辑器还在登录页 | 打开了多个编辑器标签页，关掉多余的再试 |
| 想在本机 `localhost` 调试 | 把 `http://localhost:4399` 加进 `ALLOWED_ORIGINS` |

看日志：Cloudflare → Workers & Pages → `melodyxz-cms-auth` → Logs。
