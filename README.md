# 我的博客

一个**纯静态**的个人博客。用 Markdown 写文章，用 [Astro](https://astro.build) 构建，部署到静态托管平台（免费）。

- 不需要服务器、不需要数据库，几乎没有维护成本
- 自带深色模式、RSS、sitemap、SEO 标签、标签分类、响应式布局
- 构建产物就是一堆 HTML/CSS/JS，任何静态托管都能跑

---

## 一、先在本地跑起来

前提：电脑上装了 [Node.js](https://nodejs.org/)（18 以上，推荐 20 或更高版本）。装完在终端里 `node -v` 能看到版本号就行。

```bash
# 1. 进入项目目录
cd "E:\AI Program\MyBlog"

# 2. 安装依赖（第一次需要，以后不用重复）
npm install

# 3. 启动本地预览
npm run dev
```

浏览器打开 <http://localhost:4321> 就能看到博客。改代码或改文章会自动刷新。按 `Ctrl + C` 停止。

---

## 二、上线前必改的三处

| 改什么 | 在哪改 | 说明 |
| --- | --- | --- |
| **你的域名** | `astro.config.mjs` 第 12 行 `SITE_URL` | 决定 RSS / sitemap / 分享链接里的地址，**必须改** |
| **站名、简介、作者** | `src/consts.ts` | 页面顶部标题、首页介绍、页脚署名 |
| **关于页内容** | `src/pages/about.astro` 顶部的 `intro` 数组 | 换成你自己的自我介绍 |

域名格式注意：带 `https://`，结尾**不加**斜杠。

```js
// astro.config.mjs
const SITE_URL = 'https://blog.example.com';  // ← 改成你的
```

---

## 三、怎么写一篇新文章

写文章有两条路，随便挑：

| 方式 | 适合 | 怎么做 |
| --- | --- | --- |
| **① 网页后台**（推荐） | 手边没有电脑环境、想直接上传图片 | 打开 <https://melodyxz.top/admin/> 登录后点「新建」，详见[第十节](#十后台编辑器httpsmelodyxztopadmin) |
| ② 本地写文件 | 想用自己习惯的编辑器、想一次改多处 | 按下面 1～4 步操作 |

下面说的是第 ② 种，也就是直接编辑仓库里的 Markdown 文件。

### 1. 新建文件

在 `src/content/posts/` 里新建一个 `.md` 文件，比如 `my-first-trip.md`。

**文件名会成为网址**：`my-first-trip.md` → `https://你的域名/posts/my-first-trip/`

### 2. 开头写"配置区"（frontmatter）

```yaml
---
title: 文章标题
description: 一句话摘要，会显示在列表和搜索结果里
date: 2026-10-20
tags: [旅行, 随笔]
draft: false
---
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 文章标题 |
| `date` | ✅ | 格式 `2026-10-20`，用于排序和显示 |
| `description` | 建议填 | 摘要，不填列表里就只有标题 |
| `tags` | 可选 | 标签数组，写 `[标签1, 标签2]` |
| `draft` | 可选 | 写 `true` 表示草稿，不会出现在任何页面 |

### 3. 下面正常写正文

用 Markdown。语法速查见站内那篇《Markdown 速查表》，或看 [Markdown 官方教程](https://www.markdownguide.org/basic-syntax/)。

### 4. 预览再发布

```bash
npm run dev                          # 本地看效果
git add . && git commit -m "新增文章" && git push    # 推上去自动上线
```

---

## 四、部署上线

推送代码后，托管平台会自动构建。**构建配置统一是这两项**：

| 配置项 | 值 |
| --- | --- |
| 构建命令（Build Command） | `npm run build` |
| 输出目录（Output Directory） | `dist` |
| Node 版本 | 20 或以上 |

### 方案 A：EdgeOne Pages（腾讯云，推荐国内读者）

1. 用腾讯云账号登录 [EdgeOne 控制台](https://edgeone.cloud.tencent.com/pages)
2. 开通**免费版**（长期免费，网页加速流量不限量）
3. 新建项目 → 导入 Git 仓库 → 授权 GitHub → 选择本仓库
4. 加速区域选 **全球可用区（不含中国大陆）** —— 这样**不需要备案**
5. 点部署，等 1–2 分钟

> ⚠️ 重要：加速区域选"不含中国大陆"时，平台赠送的免费域名**在中国大陆网络下会返回 401**，必须绑定你自己的域名才能正常访问。这是官方文档明确写的限制。
>
> 想用大陆节点加速（明显更快），需要把加速区域切到"中国大陆可用区"，**前提是域名已完成 ICP 备案**。

### 方案 B：Cloudflare Pages

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → Create → Pages → Connect to Git
2. 选仓库，填构建命令 `npm run build`、输出目录 `dist`
3. 部署完成后会得到一个 `xxx.pages.dev` 域名

---

## 五、绑定你自己的域名

两个平台逻辑一样：**先在托管后台添加域名，拿到 CNAME 目标值，再去域名商加解析记录。**

以域名在腾讯云（DNSPod）为例：

1. 托管后台 → 域名管理 → 添加自定义域名 → 填 `example.com`（不带 www）
2. 平台会显示一个 CNAME 目标值，类似 `xxxx.edgeone.app` 或 `xxxx.pages.dev`
3. 打开 [腾讯云 DNSPod 控制台](https://console.cloud.tencent.com/cns) → 你的域名 → 添加记录：

   | 主机记录 | 记录类型 | 记录值 |
   | --- | --- | --- |
   | `@` | CNAME | 平台给的 CNAME 目标值 |
   | `www` | CNAME | 同上 |

4. 保存后等 DNS 生效（一般 5–10 分钟，最长 24 小时）
5. 托管平台会自动签发免费 HTTPS 证书，等状态变成"已生效"即可

### 关于备案

**只取决于一件事：网站内容是否从中国大陆境内的服务器/节点对外提供。**

| 托管方式 | 要备案吗 |
| --- | --- |
| Cloudflare Pages | ❌ 不需要 |
| EdgeOne Pages（全球可用区，不含中国大陆） | ❌ 不需要 |
| EdgeOne Pages（中国大陆可用区） | ✅ 需要 |
| 腾讯云轻量 / CVM（大陆机房） | ✅ 需要 |

两个容易搞混的点：

- **域名在腾讯云买 ≠ 要备案**。腾讯云只是域名注册商，备案只跟网站放在哪里有关。
- **但域名必须实名认证**，买到后 5 天内没实名会被停机（serverHold）。
- 腾讯云首次备案要求账号下已有腾讯云资源（轻量/CVM/COS 等，通常剩余有效期 ≥ 3 个月），所以"备案"和"买服务器"是绑在一起的。备案本身免费。

先不备案完全可行，先用免费托管跑起来即可。

---

## 六、目录结构

```text
MyBlog/
├─ astro.config.mjs        ← 域名、构建配置（改域名就来这里）
├─ package.json            ← 依赖和命令
├─ public/                 ← 原样拷贝到网站根目录的静态文件
│  ├─ favicon.svg          ← 网站图标（换成自己的）
│  ├─ images/              ← 后台上传的图片都存这里（网址 /images/xxx.png）
│  └─ admin/               ← 网页后台（Sveltia CMS），网址 /admin/
│     ├─ index.html        ← 后台页面壳
│     ├─ config.yml        ← 后台的表单配置：字段、图片目录、文件名规则
│     ├─ sveltia-cms.js    ← 编辑器本体（由 npm run vendor:cms 生成，别手改）
│     ├─ chunks/           ← 编辑器按需加载的代码块（同上）
│     └─ locales/          ← 界面语言包（同上）
├─ worker/                 ← Cloudflare Worker：后台登录中转站（auth.melodyxz.top）
│  ├─ src/index.js         ← 逻辑：/auth 跳授权、/callback 换令牌
│  ├─ wrangler.toml        ← 部署配置（含 GH_CLIENT_ID、允许的站点）
│  └─ README.md            ← 部署与排错
├─ scripts/
│  └─ vendor-cms.mjs       ← 把 Sveltia CMS 复制进 public/admin 并打本地化补丁
├─ src/
│  ├─ consts.ts            ← 站名、简介、作者、导航、社交链接
│  ├─ content.config.ts    ← 文章字段的校验规则
│  ├─ content/posts/       ← ⭐ 你的文章都放这里（Markdown）
│  ├─ layouts/
│  │  └─ BaseLayout.astro  ← 全站骨架：head、SEO、页头页脚
│  ├─ components/          ← 页头、页脚、文章卡片等零件
│  ├─ pages/               ← 一个文件 = 一个页面（文件即路由）
│  │  ├─ index.astro       ← 首页
│  │  ├─ about.astro       ← 关于页
│  │  ├─ 404.astro         ← 404 页
│  │  ├─ posts/            ← 文章列表 + 文章详情
│  │  ├─ tags/             ← 标签页
│  │  ├─ rss.xml.ts        ← RSS 源
│  │  └─ robots.txt.ts     ← robots.txt（已禁止抓取 /admin/）
│  ├─ styles/global.css    ← 全站样式（配色、字体、间距都在这）
│  └─ utils/posts.ts       ← 文章排序、标签统计、阅读时长
└─ dist/                   ← 构建产物（自动生成，不用管，也不提交）
```

---

## 七、常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发预览（<http://localhost:4321>） |
| `npm run build` | 生成静态文件到 `dist/` |
| `npm run preview` | 本地预览构建后的成品，和线上更接近 |
| `npm install` | 安装/更新依赖 |
| `npm run vendor:cms` | 把 Sveltia CMS 重新复制进 `public/admin/`（升级编辑器后用） |
| `npm run deploy:worker` | 重新部署登录中转站（改过 `worker/` 后用，需要先 `npx wrangler login`） |

---

## 八、以后可以加的功能

| 想加什么 | 推荐方案 | 成本 |
| --- | --- | --- |
| 评论 | [Giscus](https://giscus.app/zh-CN)（基于 GitHub Discussions） | 免费 |
| 访问统计 | Umami、51LA、百度统计 | 免费 |
| 全文搜索 | [Pagefind](https://pagefind.app/)（纯静态，无需后端） | 免费 |
| 图片管理 | 图片放 `public/images/`；图片多了用对象存储 | 免费起 |
| 文章目录（TOC） | 用文章渲染返回的 `headings` 生成侧边栏 | 免费 |

---

## 九、本次实际部署记录（照着做就行）

这一节记录的是本博客真实上线时的操作路径和踩过的坑，比通用文档更贴近实际。

### 平台入口变了

EdgeOne Pages 现在叫 **EdgeOne Makers**，入口是 <https://console.cloud.tencent.com/edgeone/makers>。
首次进入需要点「立即开通」开通免费版（长期免费，加速流量不限量）。

### 创建项目的几个硬性要求

| 项目 | 要求 / 实际用的值 |
| --- | --- |
| 项目名称 | **只能小写字母、数字、连字符**，5–50 字符。`MyBlog` 会报错，用 `melodyxz-blog` |
| 加速区域 | 必须选 **全球可用区（不含中国大陆）**，选含大陆的会要求域名已备案 |
| 框架预设 | 自动识别为 Astro，无需改动 |
| 构建命令 / 输出目录 | `npm run build` / `dist` |
| 生产分支 | `main` |

### ⚠️ 坑 1：Node 版本太低，构建直接失败

首次部署报错：

```text
Node.js v22.21.1 is not supported by Astro!
Please upgrade Node.js to a supported version: ">=22.22.0"
```

EdgeOne 构建机默认 Node 是 22.11.0 / 22.21.1，而 Astro 7 要求 ≥ 22.22.0。

**解决**：项目 → **项目设置** → 往下拉找到「**Node.js 版本**」→ 改成 `24.18.0` → 保存 → 重新部署。

仓库里已经加了 `package.json` 的 `engines` 字段和 `.nvmrc` 作为记录，但**真正生效的是控制台里的那个设置**。

### ⚠️ 坑 2：平台自带的免费域名国内打不开

`xxx.edgeone.dev` 这种自带域名，在「全球可用区（不含中国大陆）」下**从中国大陆访问会返回 401 或直接超时**。
所以绑定自己的域名不是可选项，是必须项。

### 绑定域名的完整流程

1. 域名管理 → 添加自定义域名 → 填 `melodyxz.top` → 关联环境选「生产」
2. **归属权验证**：平台给你一条 TXT 记录，去 DNS 服务商添加

   | 类型 | 名称 | 值 |
   | --- | --- | --- |
   | TXT | `edgeonereclaim` | `reclaim-xxxxxxxx`（平台生成，每个域名不同） |

   加完回控制台点「验证」，几秒内生效。
3. **添加 CNAME**：平台分配的 CNAME 目标形如 `melodyxz.top.pages.dnsoe4.com`

   | 类型 | 名称 | 值 | 代理状态 |
   | --- | --- | --- | --- |
   | CNAME | `@` | `melodyxz.top.pages.dnsoe4.com` | **仅 DNS（灰云）** |

   > 如果 DNS 托管在 Cloudflare，**必须把橙色云朵关掉选「仅 DNS」**。开着代理 Cloudflare 会自己接管 TLS，
   > EdgeOne 就签不出证书，访问会报证书错误。
   >
   > 另外 Cloudflare 会把根域名（apex）的 CNAME **扁平化成 A 记录**返回，这是它的正常行为，不用管。

4. 等控制台状态从「请添加 CNAME」→「部署中」→「已生效」，HTTPS 证书会自动下发（几分钟）
5. 验证：浏览器打开 `https://melodyxz.top`，地址栏有锁

### 验证命令（可选）

```bash
# 看解析指向（应指向 EdgeOne 的 IP）
nslookup melodyxz.top 1.1.1.1

# 看 HTTPS 是否正常、证书是否有效
curl -sSI https://melodyxz.top | head -5
```

### 日常发布

```bash
git add . && git commit -m "新文章" && git push
```

推送后 EdgeOne 会自动重新构建部署，约 1 分钟上线。构建日志在「构建部署」里看。

不想用命令行的话，直接用网页后台 <https://melodyxz.top/admin/>，点「保存」等于替你做完上面这条命令，见[第十节](#十后台编辑器httpsmelodyxztopadmin)。

## 十、后台编辑器（https://melodyxz.top/admin/）

不想碰命令行的时候，用这个。它是**只有你能用**的网页编辑器：访客打开 `/admin/` 只能看到一个登录按钮，看不到任何文章内容。

### 第一次登录

1. 打开 <https://melodyxz.top/admin/>
2. 点「使用 GitHub 登录」
3. 弹出的小窗口里点绿色 **Authorize** 按钮
4. 窗口自动关闭，回到列表就能看到文章了

登录状态存在你自己的浏览器里，之后一段时间内不用重复登录。

### 发一篇新文章

1. 左侧点「文章」，再点「新建」
2. 填标题、日期（点「今天」最快）、摘要、标签（回车添加一个）
3. 在正文里写内容；想直接写 Markdown 就点工具栏最右边的「以 Markdown 编辑」
4. 点右上角「保存」

保存 = 一次 GitHub commit，EdgeOne 随后自动构建，**约 1 分钟后**线上就能看到。
想看线上效果，点右上角「访问在线站点」。

### 几件必须知道的事

**文章网址怎么来的？**
保存时会按「日期 + 标题」自动生成文件名，比如标题写「今天学会了钓鱼」、日期 2026-10-18，就得到：

```text
src/content/posts/2026-10-18-今天学会了钓鱼.md
https://melodyxz.top/posts/2026-10-18-今天学会了钓鱼/
```

- 空格、`#`、`/`、逗号等符号会被替换成 `-` 或直接去掉；**括号、书名号这类标点在网址里会被丢掉**（文件名里还在）。想网址干净，标题就别放太多标点。
- 网址一旦生成就跟着文章走。之后改标题不会改网址（想改要在右侧「Slug」里手动编辑，但会导致老链接失效）。

**图片怎么放？**
在里点图片图标上传，文件会进 `public/images/`，正文里自动写成 `/images/文件名`。想管理全部图片，点顶部「资源」。
**注意**：图片也会进 Git 仓库，别传几十 MB 的原图，几百 KB 的截图和压缩过的照片最合适。

**草稿**
勾上「存为草稿（不发布到网站）」的文章不会出现在首页、列表、标签页和 RSS 里，但你自己在后台看得到。

**删除**
在列表里勾选或用更多菜单删除，同样是一次 commit，约 1 分钟后线上下线。

**换账号 / 退出**
点右上角的账户头像。想彻底退出，在浏览器里清理该站点的本地存储即可。

### 它是怎么搭起来的（想改的时候看这里）

```text
浏览器 /admin/ ──① 点登录──> Cloudflare Worker ──② 跳转──> GitHub 授权页
   (Sveltia CMS)                auth.melodyxz.top              （你点 Authorize）
        │                            │ ③ 用 code 换 token
        │<──── ④ 把 token 交给页面 ───┘
        │
        └──⑤ 用 token 调 GitHub API 读写 src/content/posts/ ──> EdgeOne 自动构建上线
```

| 部件 | 位置 | 说明 |
| --- | --- | --- |
| 编辑器前端 | `public/admin/` | Sveltia CMS，JS 已打包进仓库，不依赖外网 CDN |
| 编辑器配置 | `public/admin/config.yml` | 表单字段、图片目录、文件名规则都在这里 |
| 登录中转 | `worker/`（部署在 `auth.melodyxz.top`） | 保管 Client Secret，跟 GitHub 换令牌 |
| GitHub 授权 | GitHub → Settings → Developer settings → OAuth Apps → `MelodyZzX Blog CMS` | 回调地址必须是 `https://auth.melodyxz.top/callback` |
| 打包脚本 | `scripts/vendor-cms.mjs` | 把 CMS 从 `node_modules` 复制进仓库并打本地化补丁 |

### 维护手册

```bash
# 升级编辑器（会改写 public/admin/ 下的文件，记得一起提交）
npm i -D @sveltia/cms@latest
npm run vendor:cms

# 改了 worker/ 里的代码后重新部署登录中转站
npm run deploy:worker
```

密钥在哪：`GH_CLIENT_ID` 在 `worker/wrangler.toml`（公开无妨），`GH_CLIENT_SECRET` 只存在 Cloudflare 的 Secret 里，**永远不要写进仓库**。换密钥：

```bash
npx wrangler secret put GH_CLIENT_SECRET --config worker/wrangler.toml
```

### 后台出问题对照表

| 现象 | 原因与处理 |
| --- | --- |
| 打开 `/admin/` 一直「正在加载编辑器…」 | 首次打开要下载约 700KB 的编辑器，网络慢时多等几秒；超过 20 秒就刷新 |
| 点登录后窗口闪一下就关了，没登上 | 打开 <https://auth.melodyxz.top/> 看是否返回一行状态文字；打不开说明 Worker 挂了 |
| 提示「state 不匹配或已过期」 | 登录拖太久（超过 10 分钟）或浏览器拦截了 cookie，重来一次即可 |
| 提示 `redirect_uri mismatch` | GitHub OAuth App 里的回调地址被改了，必须严格等于 `https://auth.melodyxz.top/callback` |
| 保存时报错 401 / 403 | 令牌失效或权限不足：退出重登；仍不行就去 GitHub 重新授权 |
| 保存成功但线上没变 | 去 EdgeOne 看构建日志，多半是 frontmatter 出问题（编辑器一般不会写坏，除非手改过） |
| 上传图片说找不到目录 | 检查 `public/admin/config.yml` 里 `media_folder` 是 `public/images`、`public_folder` 是 `/images` |

### 想彻底关掉后台

删掉 `public/admin/` 整个目录并推送，主站不受影响；Cloudflare 上的 Worker 也可以一并删掉（Workers & Pages → `melodyxz-cms-auth` → 删除）。

---

## 十一、常见问题

**改了代码，网站没更新？**
去托管后台看构建日志，通常是构建失败。最常见原因是文章的 frontmatter 写错（比如 `date` 格式不对、少了引号），日志里会直接指出哪个文件哪一行。

**本地能跑，线上构建失败？**
检查线上 Node 版本是否 ≥ 20，以及是不是忘了把 `package-lock.json` 一起提交。

**国内访问很慢或打不开？**
免费海外托管在国内的访问质量不稳定，不同运营商、不同时段差异很大。主要读者在国内的话，备案后切到 EdgeOne 大陆可用区会明显变快。

**中文标签页打不开？**
如果托管平台对 URL 解码处理有问题，可以把标签改成英文（如 `tutorial`、`life`），或直接删掉标签功能。

**想还原成一张白纸重新开始？**
删掉 `src/content/posts/` 里的示例文章，改 `src/consts.ts` 和 `src/pages/about.astro`，就只剩你自己的内容了。

**后台的密码是什么？**
没有密码。`/admin/` 用的是 GitHub 账号登录——只有能登录 `FormerlyXZ` 这个 GitHub 账号的人才能进，别人连登录都过不去。所以**GitHub 账号的密码和两步验证就是你的后台密码**，请务必开两步验证。

**能让别人也来发文章吗？**
可以，但要谨慎：给别人 `repo` 权限等于给别人改你仓库的权限。真要多人写作，更安全的做法是让别人提 PR、你审核合并。

**`/admin/` 会被搜索引擎收录吗？**
不会。页面有 `noindex`，`robots.txt` 里也写了 `Disallow: /admin/`；而且没有令牌什么内容都拿不到。
