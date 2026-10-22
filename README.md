# 我的博客

一个**纯静态**的个人博客。用 Markdown 写文章，用 [Astro](https://astro.build) 构建，部署到静态托管平台（免费）。

- 不需要服务器、不需要数据库，几乎没有维护成本
- 自带深色模式、RSS、sitemap、SEO 标签、标签分类、响应式布局
- 带 GitHub 登录与点赞、[Giscus](https://giscus.app/zh-CN) 评论、全文搜索、访问统计、图片/PDF 附件上传
- 构建产物就是一堆 HTML/CSS/JS，任何静态托管都能跑
- 一页式文章列表（分页）+ 左侧个人卡/分类/标签/搜索 + 归档/分类/标签/导航/项目/相册/照片墙
- 29 套配色、Banner 四档显示模式、文章目录、灯箱、在线写作（`/write`）与站点配置（`/config`）

> **设计来源**：视觉与交互参照 [RyuChan](https://github.com/kobaridev/RyuChan)（MIT），
> 其设计源流为 [Frosti](https://github.com/EveSunMaple/Frosti)。
> 按 MIT 协议保留出处：Design based on RyuChan by kobaridev, which is based on Frosti by EveSunMaple.
>
> 站点内容（站名、签名、菜单、Banner、页脚、导航与项目数据）都在 `config/*.json`，改这些不用碰代码。
> 完整改造方案与施工记录见 [`docs/redesign-plan.md`](docs/redesign-plan.md)。

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
| **① 网页后台**（推荐） | 手边没有电脑环境、想直接上传图片和 PDF | 打开 <https://melodyxz.top/admin/> 登录后点「新建」，详见[第十节](#十后台编辑器httpsmelodyxztopadmin) |
| ② 本地写文件 | 想用自己习惯的编辑器、想一次改多处 | 按下面 1～4 步操作 |

想在文章底部放 PDF、压缩包之类的附件，在后台的「附件」字段上传即可（文件会进 `public/files/`），详见[第十一节](#十一网站生态指南登录--点赞--评论--搜索--统计--附件)。

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
│  ├─ files/               ← 「附件」字段上传的 PDF / Word / 压缩包（网址 /files/xxx.pdf）
│  └─ admin/               ← 网页后台（Sveltia CMS），网址 /admin/
│     ├─ index.html        ← 后台页面壳（含"已登录"标记脚本，见方案C）
│     ├─ config.yml        ← 后台的表单配置：字段、图片目录、文件名规则
│     ├─ sveltia-cms.js    ← 编辑器本体（由 npm run vendor:cms 生成，别手改）
│     ├─ chunks/           ← 编辑器按需加载的代码块（同上）
│     └─ locales/          ← 界面语言包（同上）
├─ worker/                 ← Cloudflare Worker：登录中转 + 点赞/阅读数/统计接口
│  ├─ src/index.js         ← 逻辑：/auth、/callback、/api/like、/api/view、/api/stats
│  ├─ wrangler.toml        ← 部署配置（GH_CLIENT_ID、OWNER_LOGINS、KV 绑定）
│  └─ README.md            ← 部署、KV 创建、排错
├─ scripts/
│  └─ vendor-cms.mjs       ← 把 Sveltia CMS 复制进 public/admin 并打本地化补丁
├─ src/
│  ├─ consts.ts            ← 站名、简介、作者、导航；API 地址、Giscus、统计配置
│  ├─ content.config.ts    ← 文章字段的校验规则（含 attachments 附件字段）
│  ├─ content/posts/       ← ⭐ 你的文章都放这里（Markdown）
│  ├─ layouts/
│  │  └─ BaseLayout.astro  ← 全站骨架：head、SEO、统计脚本、编辑入口开关
│  ├─ components/          ← 页头、页脚、文章卡片、登录按钮、点赞、评论等零件
│  ├─ pages/               ← 一个文件 = 一个页面（文件即路由）
│  │  ├─ index.astro       ← 首页
│  │  ├─ about.astro       ← 关于页
│  │  ├─ 404.astro         ← 404 页
│  │  ├─ search.astro      ← 全文搜索页（Pagefind）
│  │  ├─ stats.astro       ← 站长统计页（需要站长 GitHub 登录）
│  │  ├─ posts/            ← 文章列表 + 文章详情（点赞/评论/附件都在这）
│  │  ├─ tags/             ← 标签页
│  │  ├─ rss.xml.ts        ← RSS 源
│  │  └─ robots.txt.ts     ← robots.txt（已禁止抓取 /admin/、/stats/）
│  ├─ styles/global.css    ← 全站样式（配色、字体、间距都在这）
│  └─ utils/
│     ├─ posts.ts          ← 文章排序、标签统计、阅读时长
│     └─ site.ts           ← 前台登录、点赞、统计接口的小工具库
└─ dist/                   ← 构建产物（自动生成，不用管，也不提交）
```

---

## 七、常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发预览（<http://localhost:4321>），改代码/文章自动刷新（此时**没有**搜索索引） |
| `npm run build` | 生成静态文件到 `dist/`，并自动运行 Pagefind 生成全文搜索索引 |
| `npm run preview` | 本地预览 `npm run build` 的成品（想看搜索效果得用这个） |
| `npm install` | 安装/更新依赖 |
| `npm run vendor:cms` | 把 Sveltia CMS 重新复制进 `public/admin/`（升级编辑器后用） |
| `npm run deploy:worker` | 重新部署登录/点赞中转站（改过 `worker/` 后用，需要先 `npx wrangler login`） |

---

## 八、功能一览

| 功能 | 状态 | 在哪里 |
| --- | --- | --- |
| 评论 | ✅ 已接入 [Giscus](https://giscus.app/zh-CN)（基于 GitHub Discussions），需要你在 `src/consts.ts` 填两个 ID（见 11.4） | 文章底部 |
| 访问统计 | ✅ 自建阅读数 + 站长统计页；另预留 Cloudflare Web Analytics（见 11.6） | 文章头部 / `/stats/` |
| 全文搜索 | ✅ [Pagefind](https://pagefind.app/)（纯静态，构建时生成索引） | 页头「搜索」 |
| 图片 / PDF 附件 | ✅ 后台直接上传；图片进 `public/images/`、附件进 `public/files/`（见 11.7） | 后台上传 |
| GitHub 登录 + 点赞 | ✅ 必须登录，每个账号每篇只能点一次，数字存在 Cloudflare Worker 的 KV 里（见 11.3） | 页头 / 文章底部 |
| 前台编辑入口 | ✅ 后台登录后，页脚出现「写文章」，文章页出现「编辑本篇」（见 11.8） | 页脚 / 文章页 |
| 音乐播放器 | ✅ 本地音乐库（音频 / 封面 / LRC 全在仓库里，不调任何外部接口），唱机式音乐页 + 全站左下角迷你碟片（见 11.12） | `/music/` / 左下角 |

以后还可以考虑：文章目录（TOC）、按年份归档页、RSS 全文输出、图片多了把图床换成对象存储。

完整用法见[第十一节](#十一网站生态指南登录--点赞--评论--搜索--统计--附件)。

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
在正文里点图片图标上传，文件会进 `public/images/`，正文里自动写成 `/images/文件名`。想管理全部图片，点顶部「资源」。
**注意**：图片也会进 Git 仓库，别传几十 MB 的原图，几百 KB 的截图和压缩过的照片最合适。

**PDF 等附件怎么放？**
在表单里往下拉，找到「附件（PDF / Word / 压缩包等）」字段，点上传即可，文件会进 `public/files/`，文章底部会自动出现「附件下载」区块。
单个文件上限 20MB（在 `public/admin/config.yml` 里可改）。**注意**：附件同样会进 Git 仓库，太大会拖慢构建，大文件建议用网盘链接代替。

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

---

## 十一、网站生态指南（登录 / 点赞 / 评论 / 搜索 / 统计 / 附件）

这一节是新增功能的"使用 + 配置"说明书。动手之前先记住一张总表：

| 功能 | 前台在哪 | 依赖什么 |
| --- | --- | --- |
| GitHub 登录 | 页头「GitHub 登录」按钮 | Cloudflare Worker（`auth.melodyxz.top`） |
| 点赞 | 文章底部 ❤ 按钮 | Worker + KV（点赞数存在云端） |
| 评论 | 文章底部「评论」 | Giscus（GitHub Discussions）+ 你在 GitHub 上装一次 App |
| 阅读数 / 统计页 | 文章头部「阅读 N 次」；页脚「📊 统计」 | Worker + KV |
| 全文搜索 | 页头「搜索」 | Pagefind（构建时自动生成索引，无需后端） |
| PDF 等附件 | 文章底部「附件下载」 | 后台「附件」字段 → `public/files/` |
| 前台编辑入口 | 页脚「✎ 写文章」、文章页「✎ 编辑本篇」 | 你在 `/admin/` 登录过一次 |

### 11.1 第一件事：把 Worker 更新到新版（点赞/阅读数/统计都靠它）

老版 Worker 只负责后台登录。新版还加上了点赞、阅读数、统计接口，**必须重新部署一次**，否则页面上的点赞和阅读数会一直显示「—」。完整步骤见 `worker/README.md`，最短路径：

```bash
# 1) 登录 Cloudflare（一次即可）
npx wrangler login

# 2) 创建 KV 命名空间（一次即可），把输出的 id 填进 worker/wrangler.toml
npx wrangler kv namespace create BLOG_KV --config worker/wrangler.toml

# 3) 部署（以后改了 worker/ 里的代码，只要重复这一步）
npx wrangler deploy --config worker/wrangler.toml
```

部署后验证：

```bash
curl -s https://auth.melodyxz.top/
# 应返回：MelodyZzX 博客服务运行正常。...
```

> 密钥 `GH_CLIENT_SECRET` 不要重新设置（没变过就不用管）；`wrangler.toml` 里的 `OWNER_LOGINS` 填的是你的 GitHub 用户名，决定谁能在 `/stats/` 看统计。

### 11.2 GitHub 登录（点赞的前提）

- 页头右上角点「GitHub 登录」→ 弹窗里点绿色 **Authorize** → 头像和昵称出现在页头，之后不用重复登录（状态存在本浏览器）。
- 登录用的还是后台那一个 OAuth App，只是每次只申请 `read:user` 权限——**只能读到你的公开资料，动不了你的仓库**。
- 退出登录：点头像 → 「退出登录」。换电脑/换浏览器需要重新登录一次。
- 登录状态只存在浏览器本地，**不经过任何第三方统计**，也不会上传到博客服务器。

### 11.3 点赞

- 文章底部的 ❤ 按钮：没登录时点它 → 先弹 GitHub 登录 → 登录后自动完成点赞。
- 每个 GitHub 账号每篇文章只能点一次；再点一次是取消赞。
- 点赞数存在 Worker 的 KV 里，全网访客看到的是同一个数字；同一浏览器是"已赞"状态。
- 不需要登录也能看点赞数，但**只有登录后才能点**——这是为了防刷，也是你要的规则。

### 11.4 评论（Giscus）：三步 GitHub 设置 + 填两个 ID

评论组件已经接好在文章底部，**还差最后一步配置**（`src/consts.ts` 里的两个 ID 还是空的，所以现在文章底部显示的是配置提示）。

**第 1 步：打开仓库的讨论区**
GitHub 仓库 → Settings → General → 往下拉到 **Features** → 勾选 **Discussions** → Save。

**第 2 步：安装 Giscus App**
打开 <https://github.com/apps/giscus> → Install → 只勾选 `FormerlyXZ/MyBlog` 这一个仓库 → Install。

**第 3 步：拿两个 ID，填进 `src/consts.ts`**
1. 打开 <https://giscus.app/zh-CN>
2. 「仓库」填 `FormerlyXZ/MyBlog`（会进行校验，通过后出现"讨论区分类"下拉框）
3. 分类建议选 **Announcements**（默认就有）；没有的话先去仓库 Discussions 里新建一个分类
4. 页面下方向下滚，在生成的 `<script>` 代码里找到两个值：
   - `data-repo-id="R_kgDO..."` → 填进 `GISCUS.repoId`
   - `data-category-id="DIC_kwDO..."` → 填进 `GISCUS.categoryId`
5. 保存 `src/consts.ts`，重新 `npm run build` 部署（或推送让 EdgeOne 自动构建）

**评论功能怎么用：**
- 访客打开文章 → 页面底部出现评论框 → 用 GitHub 账号登录 → 写评论。
- **评论里可以直接发图片、发 PDF**：把图片/PDF 拖进评论框（或粘贴），GitHub 会把文件存到它自己的 CDN 并自动生成链接，评论区里就能点开看。
- 有人评论后，GitHub 会给仓库 Discussions 对应帖子生成通知；你也可以在仓库 Discussions 里直接回复、管理（评论框右上角的链接能跳过去）。
- 明暗主题切换时评论框会自动跟着变，不用手动设置。

### 11.5 全文搜索（Pagefind）

- 索引在 `npm run build` 时自动生成（构建命令是 `astro build && pagefind --site dist`），线上部署后就是好的，**不需要任何后端**。
- 本地想看搜索效果：`npm run build && npm run preview`，然后打开 <http://localhost:4321/search/> 试。
- 只有**文章页**和**关于页**参与搜索索引；首页、文章列表页、标签页、搜索页、统计页、404、后台都不进索引（页头页脚也会自动排除）。
- 中文分词说明：Pagefind 对中文是按字/短语匹配的，搜「部署」能找到「把这个博客部署上线」这类内容；英文单词匹配最准。这是纯静态搜索的正常表现，不是 bug。
- 以后想让某个页面不参与搜索：在 `BaseLayout` 上传 `indexable={false}` 即可（首页、列表页、标签页就是这么排除的）。

### 11.6 访问统计

现在有两套互补的统计，**都免费**：

**A. 自建阅读数 + 站长统计页（推荐，已配好）**
- 每篇文章标题下会显示「阅读 N 次」，数字来自 Worker 的 KV。
- 同一 IP 30 分钟内只算一次，刷新页面不会刷量。
- 你在 `/admin/` 登录过后，页脚会出现「📊 统计」，点进去可以看：
  - 总阅读、今日阅读、总点赞
  - 近 14 天阅读趋势柱状图
  - 每篇文章的阅读/点赞排行
- 这个页面只有站长 GitHub 账号登录后才能看数据（`/api/stats` 会校验 `OWNER_LOGINS`）。

**B. Cloudflare Web Analytics（可选，想要专业图表再开）**
1. 打开 <https://dash.cloudflare.com> → 左栏 **Web Analytics** → 添加站点 → 填 `melodyxz.top`
2. 拿到一段脚本，把里面的 token（长串字母数字）抄下来
3. 填到 `src/consts.ts` 的 `ANALYTICS.cloudflareToken`
4. 重新部署。之后在 Cloudflare 控制台就能看到流量曲线、来源、国家、热门页面
- 不放 Cookie、免费、无广告。留空的话什么脚本都不加载，网站不受影响。

两套互不冲突，愿意都开就都开。

### 11.7 图片与 PDF（图床）

后台上传分两处，各归各的家：

| 上传什么 | 在后台上传的位置 | 文件存到 | 线上网址 |
| --- | --- | --- | --- |
| 正文里的图片 | 正文编辑器里的图片按钮 | `public/images/` | `/images/文件名` |
| PDF、Word、压缩包等附件 | 表单往下拉的「附件」字段 | `public/files/` | `/files/文件名` |

- 单文件上限 20MB（`public/admin/config.yml` 里 `max_file_size` 可改）。
- 附件上传后会**自动**在文章底部生成「附件下载」列表，不用手动写链接。
- 如果正文里想直接放一个下载链接（而不是放在底部），也可以手写：`[下载 PDF](/files/文件名.pdf)`。
- 图片/附件都会进 Git 仓库，所以文件越大构建越慢。几百 KB 的截图和压缩过的照片最合适；真要传大文件，用网盘链接或以后换对象存储。
- 访客在**评论里**发的图片/PDF 走的是 GitHub，**不会**进你的仓库。

### 11.8 方案 C：前台编辑入口

满足下面**任意一条**，前台就会出现编辑入口（本浏览器内）：

1. 你在 `/admin/` 登录过一次后台；或
2. 你用 `ADMIN_OWNERS`（`src/consts.ts`）里配置的站长 GitHub 账号登录过本站（就是页头那个「GitHub 登录」）。

出现后：

- 页脚一行小字：**✎ 写文章**、**📊 统计**
- 文章页底部：**✎ 编辑本篇**，点一下直接跳到后台对应文章的编辑页

访客看不到任何入口（HTML 里默认 `hidden`，不满足条件就不会显示）。这只是一个"显示开关"，真正的权限始终在 GitHub 那边，伪造也进不去后台。

- 换设备/换浏览器：需要在新浏览器里登录一次后台（或登录一次站点），按钮才会出现。
- 保底做法：把 `https://melodyxz.top/admin/` 加进浏览器书签，任何时候都能进。
- 入口不会出现时排查：确认 `src/consts.ts` 的 `ADMIN_OWNERS` 写着你的 GitHub 用户名、并且和 `worker/wrangler.toml` 的 `OWNER_LOGINS` 一致。

### 11.9 想改配置去哪找

| 想改什么 | 改哪 |
| --- | --- |
| 站点名称 / 简介 / 导航 / 社交链接 / 头像 / Banner / 主题 | **`/config` 页面可视化改**（见 11.10），也可以直接编辑 `config/site.json` |
| 关于本站的内容 | `/about/edit` 或 `config/about.json` |
| 后端 API 地址（Worker 域名变了才需要改） | `src/consts.ts` 的 `API_BASE` |
| Giscus 的仓库 ID / 分类 ID | `config/site.json` 的 `comments.giscus`（也可在 `/config` 的 JSON 源码里改） |
| Cloudflare 统计 token | `src/consts.ts` 的 `ANALYTICS` |
| 谁能看统计页 | `worker/wrangler.toml` 的 `OWNER_LOGINS` |
| 点赞/阅读数数据 | 存在 Cloudflare KV `BLOG_KV`（清空方法见 `worker/README.md`） |

### 11.10 可视化站点配置（`/config`）

打开 `/config` 用 GitHub 授权后，站点配置被拆成 6 个板块，改完点「保存并提交」即可（一次 commit，约 1 分钟自动部署）：

| 板块 | 能改什么 |
| --- | --- |
| 站点信息 | 网站名、浏览器标签标题、站点简介、语言、日期格式 |
| 标题栏（导航） | 用图片 logo 还是文字站名、上传 logo、上传 favicon |
| 个人资料 | 头像、昵称、个人描述（签名）、主页地址、社交媒体（增删 / 排序 / 图标名） |
| 横幅 Banner | 横幅图片（多选上传 / 上下挪动 / 删除）、循环时间、高度适配方式、宽高比、黑色遮罩 |
| 文字大小 | 大标题 / 打字机标语的字号倍率（1 = 默认，0.8 = 八成大小）；竖屏还会被「最长那句一行放得下」的上限再压一次 |
| 首页文案 | 首页大标题、副标题、打字机标语（一行一句） |
| 主题外观 | 默认浅色 / 深色主题、是否允许访客切换、默认 Banner 显示方式 |
| JSON 源码 | 整份 `config/site.json`，带格式化与校验（菜单、页脚等不在板块里的字段在这里改） |

要点：

- 改动先留在页面上，**不点保存不会写进仓库**；图片上传是单独的 commit（先提交图片，再把路径写回配置）。
- 板块里的数字/开关都是真的写进 `config/site.json`，三种视图（板块 / JSON 源码 / 仓库文件）始终是同一份数据。
- 访客打开 `/config` 只会看到「需要 GitHub 授权」的提示。

### 11.11 上传 `.md` 文件（`/write`）

`/write` 顶部的「导入 .md 文件」支持两种用法：

- **选 1 个**：解析 frontmatter 与正文填进表单，检查标题 / 日期 / 分类后再点「保存并发布」。
- **选多个（或直接拖进来）**：按文件名生成 slug（重名自动加 `-2`、`-3`），一次性 commit 到 `src/content/posts/`。

能识别的 frontmatter 写法：`key: "值"`、`key: [a, b]`、块状数组（`key:` 后每行 `- 项`）、多行文本（`key: |`）。
从 Typora / Obsidian / Hugo 导出的 `.md` 一般都能直接读进来；没有 frontmatter 时，标题用文件名兜底。

### 11.12 音乐（本地音乐库 + 左下角碟片）

音乐全部是**站内本地文件**，播放用的是浏览器自带的 `<audio>`，不调用任何第三方音乐接口。

| 放哪里 | 干什么 |
| --- | --- |
| `public/music/audio/` | 音频（建议 `.m4a` / `.mp3`，单文件别超过 25MB —— 那是 Cloudflare Pages 的单文件上限） |
| `public/music/covers/` | 封面图（jpg / png / svg 都行，方图最好看） |
| `config/music.json` | 歌单与歌曲清单（歌名、歌手、专辑、时长、歌词） |

**两种加歌方式**

1. 在线加：`/config` → 「音乐库」板块 → 新建歌单 → 添加歌曲 → 选音频（会自动读时长、从「歌手 - 歌名」猜出标题）→ 可再传封面、贴上 LRC 歌词 → 「保存并提交」。
   一次提交 = 一个 commit：音频二进制和 `config/music.json` 同时进仓库，不会出现「配置改了、歌还没传上去」的半截状态。
2. 批量导入：电脑里有一堆无损/大文件（比如 FLAC）时，先在项目根目录跑

   ```bash
   node scripts/import-music.mjs "C:\Users\你\Music" --playlist "我的收藏" --bitrate 160k
   ```

   它会把每首转成 AAC `.m4a`、把内嵌封面抠成 jpg、读时长和标签、同名同歌手的重复曲目自动去重、跳过超过 15 分钟的串烧/电台，最后写好 `config/music.json`。需要 `ffmpeg` / `ffprobe` 在 PATH 里。先用 `--dry-run` 看清单，不动文件。

   歌词也有对应的批量导入：把 `歌手 - 歌名.lrc` 放进同一个目录（子目录会一起扫），然后

   ```bash
   node scripts/import-lyrics.mjs --dry-run   # 先看配对结果
   node scripts/import-lyrics.mjs             # 写进 config/music.json
   ```

   它按「歌名 + 歌手」模糊配对（标点、空格、括号、多人合唱的分隔符都不影响），**只填空歌词，不覆盖已有的**——
   手上有更好的逐句版本时不用怕被冲掉，确实想覆盖加 `--force`。

   手上没有歌词文件也没关系，可以调用 [ZonyLrcTools](https://soft.myzony.com) 自动匹配下载（网易云 / QQ / 酷狗 / 酷我）：

   ```bash
   npm run lyrics -- --dry-run        # 先看会下到什么，不写文件
   npm run lyrics                    # 下载 + 清洗 + 写进 config/music.json
   npm run lyrics -- --only-missing  # 只给还没有歌词的歌补
   npm run lyrics -- --from "E:\lrcdir"   # 复用已经下载好的目录，不再联网
   ```

   它会先把 `public/music/audio` 的音频硬链接到临时目录（同盘 0 拷贝），让 ZonyLrcTools 按音频内嵌的
    `title` / `artist` 标签去匹配，再清洗掉 `<成员名>` 演唱者标记和结尾的版权声明，最后按音频文件名回填。
   **「作词 : 某某 / 作曲 : 某某 / 编曲 : 某某」这些制作人信息默认保留**——它们带时间轴，在音乐页会当成
   最前面的几行歌词显示（跟主流音乐平台一样），不想要就加 `--strip-credits`。
   **默认会替换掉现有歌词**；纯音乐、live 版可能匹配不到，脚本会列出来，
   需要的话在「站点配置 → 音乐库」里手动粘贴。
   工具是 79MB 的独立 exe（.NET 自包含，不需要装运行时），放哪都行，脚本会自己找
   `%USERPROFILE%\tools\ZonyLrcTools*` 或 `%USERPROFILE%\Downloads\ZonyLrcTools*`，也可以用
   `--tool` / 环境变量 `ZONY_LRC_TOOL` 指定。

   > 双语歌词（原文 + 译文用两个空格连在一行）会被拆成上下两层显示：原词大一号，译文小一号排在下边。

**播放器怎么用**

- 标题栏「音乐」进去是唱机页：左边一张贴着封面的黑胶（播放时转动、唱臂自动落下），右边切换「播放列表 / 歌词」。
  左右两栏共用同一块**毛玻璃**：底下是两张放大、模糊、各自按不同周期（42s / 58s）缓慢漂移＋缩放＋微旋转的封面
  （`mix-blend-mode: overlay`，只放大封面的明暗对比、不整体提亮），所以背景一直在缓慢流动又不会盖住字。
  底色从封面里取（缩略到 28×28 采样、按「饱和度 × 深色」加权取色相，压成 15% 左右的亮度），每首歌都不一样；
  换歌时模糊封面和底色都是淡入淡出。
- 唱机下方那条**音乐律动**是用 Web Audio 的 `AnalyserNode` 取真实频谱、插值成一条连续曲线画出来的
  （对数频率分段 + 每段自适应峰值 + 整体响度包络，暂停时变成一条慢慢流动的行波），左下角小窗里有一个缩小版。
- 鼠标划过列表里的歌，唱片会先帮你把它的封面换上来预览一下。
- 歌词：`[mm:ss.xx]` 时间轴，**第一句默认停在正中间**；换句时整块瞬间挪到位、每一句再按「离当前句越远出发越晚」
  （每句 26ms）收回去，看上去是一句跟着一句滑上去，而不是整块弹一下。正在唱的那句直接点亮成纯白加粗
  （不做逐字扫光：LRC 只精确到整句，长句换行时扫光会在两行之间一起扫，反而糊），过去和将来都是低透明度。
- 歌词可以**按住左键上下拖**：松手吸附到最近的一句并点亮它，右侧浮出「跳到 0:42」，点它才真正跳过去。
  点歌词句子本身**不**跳（避免误触）；拖完不操作的话 5.2 秒后自己回到正在唱的那句，点歌词区外也会立刻回。
  字号用右上角 `A− / A+` 调，五档，存在 `localStorage`。
- 拖进度条时**只预览、不跳转**：松手才 `currentTime`，所以怎么拖都不会一路解码卡顿（歌词会先跟着预览落到哪一句）。
- **全屏播放**：左栏左上角那颗按钮。
  - 桌面 / 横屏：请求浏览器原生全屏（不支持就只铺满视口），导航、页脚、左下角迷你碟片都让开。
    这时左栏只留一张更大的唱片，歌名 / 进度 / 播放控制搬到底部一条控制条里，**鼠标不动 2.6 秒就自动沉下去，
    一动鼠标（或敲键盘）就浮上来**，鼠标停在控制条上不会收。
  - 竖屏手机：三级——① 唱片 + 歌名上方 4 行歌词 + 进度 + 控制（这一级不画波形，高度让给歌词；
    那 4 行跟大歌词是同一套错峰滚动，换句时一句跟着一句滑上去，并且当前句停在偏上的位置，
    好让下面多露一句还没唱到的）；点歌词进
    ② 顶部歌名 / 中间大歌词 / 下方进度 + 控制（控制上方一个 `∨`）；点 `∨` 进 ③ 只剩歌词和顶部歌名
    （进度和控制是沉下去、歌词顺势长高，不是直接 `display: none`，所以来回切都是连着的）。
    退出：②点一下歌词回 ①，③点 `∧` 回 ②，左上角那颗按钮直接退出全屏（Esc 也行）。
- 全站左下角有张迷你碟片：点一下播放 / 暂停，鼠标移上去弹出玻璃小窗（封面、歌名、进度、上下首、音量、单曲循环 / 列表循环 / 随机）。
  它是 `transition:persist` 的，**翻文章、进相册、换页面都不会断歌**；触屏设备上点击碟片 = 播放暂停，右下角小箭头展开面板。
- 播放状态（上次听到哪首、音量、播放模式）存在 `localStorage`，下次打开接着来；支持系统媒体控件（锁屏 / 耳机按键）。

---

## 十二、常见问题

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

**点了「GitHub 登录」没反应 / 点赞按钮一直显示「—」？**
多半是 Worker 还是旧版（没有 `/api/*` 接口）。按 11.1 重新创建 KV 并部署一次，再刷新页面试试。

**评论框不出现，只看到"评论功能还没配置好"？**
按 11.4 的三步把 `src/consts.ts` 里 `GISCUS.repoId` 和 `categoryId` 填上，重新构建部署即可。

**搜索页搜不到东西 / 本地开发环境没搜索？**
`npm run dev` 是开发模式，没有构建索引，所以搜不到是正常的。用 `npm run build && npm run preview` 打开 <http://localhost:4321/search/> 验证。

**统计页打开是空的 / 提示不是站长？**
`/stats/` 只认 `worker/wrangler.toml` 里 `OWNER_LOGINS` 配置的 GitHub 用户名。确认你登录的账号和那里一致，并且 Worker 已经部署新版。

**上传 PDF 失败？**
检查文件是否超过 20MB（`public/admin/config.yml` 里的 `max_file_size`），以及 `public/files/` 目录是否被误删。

**前台看不到「写文章 / 编辑本篇」？**
满足任意一条就会显示：① 在本浏览器登录过 `/admin/`；② 用 `ADMIN_OWNERS` 里配置的 GitHub 账号登录过站点。两条都不满足就先直接打开 `https://melodyxz.top/admin/` 登录一次，或登录页头的 GitHub 按钮。隐私模式或清了站点数据后需要重新登录。
