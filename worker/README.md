# worker/ —— 博客的云端小服务（Cloudflare Worker）

这个目录放的是一段很小的云端代码，部署后地址是 **https://auth.melodyxz.top**。
它同时给博客做四件事：

1. **后台登录中转**：Sveltia 编辑器点「GitHub 登录」时，帮它跟 GitHub 换令牌
2. **前台 GitHub 登录**：访客在站点点「GitHub 登录」时，同样帮它换令牌（scope 只有 `read:user`）
3. **点赞 + 阅读数**：点赞数、每篇文章的阅读次数都存在 KV 里
4. **站长统计**：只有站长账号能看的总阅读、今日阅读、文章排行、近 14 天趋势

## 接口一览

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/` | GET | 健康检查，返回一行文字 |
| `/auth` | GET | 生成一次性 `state`，把弹窗送到 GitHub 授权页（`scope=repo` 给编辑器，`scope=read:user` 给前台点赞） |
| `/callback` | GET | GitHub 带 `code` 回来，校验 `state`，换令牌，再通过 postMessage 交给页面 |
| `/api/me` | GET | 带 `Authorization: Bearer <token>`，返回当前登录者的用户名、头像 |
| `/api/meta?paths=/posts/a/,/posts/b/` | GET | 读点赞数、阅读数、我是否点过赞（没登录也可以读数字） |
| `/api/like` | POST | 点赞 / 取消点赞，body：`{"path":"/posts/a/","action":"like"}`，必须带令牌 |
| `/api/view` | POST | 记一次阅读，body：`{"path":"/posts/a/"}`；同一 IP 30 分钟内只算一次 |
| `/api/stats` | GET | 站长统计，必须带站长账号的令牌，否则 401/403 |

- 令牌只在弹窗里经手一次：不写 KV、不落库、不打日志。
- 除了 `ALLOWED_ORIGINS` 白名单里的站点，任何网站都收不到登录令牌。
- 点赞需要真实 GitHub 登录（每个账号每篇只能点一次），阅读数按 IP 去重。

## 需要的配置

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `GH_CLIENT_ID` | 明文（`wrangler.toml`） | GitHub OAuth App 的 Client ID |
| `GH_CLIENT_SECRET` | **Secret（只在 Cloudflare 里）** | GitHub OAuth App 的 Client Secret |
| `ALLOWED_ORIGINS` | 明文（`wrangler.toml`） | 允许收令牌的站点，逗号分隔；默认还带了两个 localhost 方便本地调试 |
| `OWNER_LOGINS` | 明文（`wrangler.toml`） | 能看 `/api/stats` 的 GitHub 用户名（站长），逗号分隔 |
| `BLOG_KV` | KV 命名空间绑定 | 点赞 / 阅读数 / 统计的存储，**部署前必须先创建** |

## 首次部署

```bash
# 1) 登录 Cloudflare（会打开浏览器，点 Allow 即可）
npx wrangler login

# 2) 创建 KV 命名空间（只做一次）
npx wrangler kv namespace create BLOG_KV --config worker/wrangler.toml

# 3) 上一步会输出一行类似下面的内容，把 id 填进 worker/wrangler.toml 的 [[kv_namespaces]]：
#    📦 Created KV namespace "BLOG_KV"
#    { "id": "8f6f4b9c1a2d3e4f5a6b7c8d9e0f1a2b" }

# 4) 部署（会自动创建 Worker + 绑定 auth.melodyxz.top + 申请证书）
npx wrangler deploy --config worker/wrangler.toml

# 5) 写入密钥（粘贴 GitHub 的 Client Secret，不会显示在屏幕上）
npx wrangler secret put GH_CLIENT_SECRET --config worker/wrangler.toml
```

> 如果之前已经部署过老版本（只有登录中转），只需补做第 2 步、把 id 填进配置，然后重新执行第 4 步即可。

## 部署后自检（一分钟）

```bash
# 健康检查：应返回一行文字
curl -s https://auth.melodyxz.top/

# 读接口：应返回 {"ok":true,...}
curl -s "https://auth.melodyxz.top/api/meta?paths=/posts/hello-world/"

# 记一次阅读：应返回 {"ok":true,"counted":true,...}
curl -s -X POST https://auth.melodyxz.top/api/view -H "content-type: application/json" -d "{\"path\":\"/posts/hello-world/\"}"
```

在浏览器里刷新文章页，能看到「阅读 1 次」、点赞按钮上的数字不再显示「—」，就说明一切正常。

## 配套的 GitHub OAuth App

- 位置：GitHub → Settings → Developer settings → OAuth Apps → `MelodyZzX Blog CMS`
- Homepage URL：`https://melodyxz.top`
- Authorization callback URL：`https://auth.melodyxz.top/callback`
- 「Expire user access tokens」**保持关闭**：否则令牌 8 小时就过期，后台和点赞会频繁掉登录。
- 前台点赞登录和后台登录**共用这一个 App**，只是请求的 scope 不同（`read:user` / `repo`），
  所以不需要再新建第二个 OAuth App。

要换域名或重建 App 时，这几处必须同时更新：App 配置里的回调地址、`wrangler.toml` 的
`GH_CLIENT_ID`、Cloudflare 里的 `GH_CLIENT_SECRET`。

## 数据存在哪、怎么清空

所有计数都在 KV 命名空间 `BLOG_KV` 里，key 前缀含义：

| key | 内容 |
| --- | --- |
| `pl:<文章路径>` | 该文章的点赞数 |
| `like:<GitHub用户id>:<文章路径>` | 谁给哪篇文章点过赞（用来防重复） |
| `v:<文章路径>` | 该文章的阅读数 + 按天明细（保留最近 30 天） |
| `seen:<哈希>` | 阅读去重标记，30 分钟自动过期 |
| `user:<令牌哈希>` | 令牌对应的用户信息缓存，1 小时自动过期 |

想清空统计：Cloudflare 控制台 → Workers 和 Pages → KV → `BLOG_KV` → 删掉对应 key（或整个命名空间重建）。

## 出问题怎么查

| 现象 | 排查 |
| --- | --- |
| 编辑器点登录后窗口一闪而过 | `https://auth.melodyxz.top/` 打不开 → Worker 没部署或自定义域名没生效 |
| 提示 `redirect_uri mismatch` | GitHub App 里的回调地址和实际地址不一致（注意结尾不要多斜杠） |
| 提示「state 不匹配或已过期」 | cookie 被浏览器拦了（关掉隐私插件），或登录拖了超过 10 分钟 |
| 授权成功了但编辑器还在登录页 | 打开了多个编辑器标签页，关掉多余的再试 |
| 点赞按钮一直显示「—」/ 阅读数不显示 | 新 Worker 没部署，或 `BLOG_KV` 没创建、`wrangler.toml` 里的 id 还是占位值（部署会直接报错） |
| 点赞后刷新数字又回去了 | KV 免费额度按「写入量」计费，如果一天内写入超过 1000 次要等第二天恢复；正常个人博客远远碰不到 |
| 想在本机 `localhost:4321` 调试登录 | `ALLOWED_ORIGINS` 默认已经带了 `http://localhost:4321`；端口不同就手动加上 |
| 看日志 | Cloudflare → Workers & Pages → `melodyxz-cms-auth` → Logs |
