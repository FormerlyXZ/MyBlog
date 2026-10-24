# 博客视觉与生态重构方案（v2 · 对齐 RyuChan）

> **当前状态：方案稿，尚未实施。**
> 本文件是后续一步步改造的施工图：每个阶段都有「目标 → 改动文件 → 步骤 → 验收 → 回滚点」。
> 勾选框 `☐` 表示待办，完成后改成 `☑`，方便追踪进度。
> **开发方式：全程本地 `npm run dev` 验证，不推送 GitHub、不触发自动部署**（见 §12）。

参考对象：

- 演示站：<https://demo.131714.xyz/>
- 源码仓库：<https://github.com/kobaridev/RyuChan>（MIT 协议，可移植修改，**需保留署名**）

---

## 0. 决策记录（已确认，后续不再反复）

| # | 议题 | 结论 |
|---|---|---|
| D1 | 移植路径 | **渐进移植**：在现有仓库引入 Tailwind 3 + daisyUI 4，逐模块替换视觉层。Astro 7、Cloudflare Worker（登录/点赞/阅读数/统计）、Pagefind、Giscus 全部保留 |
| D2 | 模块范围 | 归档/分类/分页、导航页、项目页、相册 + 照片墙、在线写作 + 站点配置，全部移植；追番 `/anime`、友人帐 `/friend`、音乐 `/music` **不移植** |
| D3 | 后台 | 用参考站的 `/write` + `/config` **取代 Sveltia CMS（`/admin/`）**，但「只有站长登录才出现入口」的逻辑保留 |
| D4 | 评论 | 只用 **Giscus** |
| D5 | Banner 背景 | **本地图片列表随机轮换**（`public/banner/`），不依赖第三方随机图 API |
| D6 | 文章字段 | 新增 `image`（封面）、`categories`（分类）、`badge`（置顶）；文章 URL **保持 `/posts/<slug>/`** |
| D7 | 主题 | daisyUI **全量 29 套配色** + 调色板选择器；浅色默认 `garden`，深色默认 `dracula`（daisyUI 4.12 内置 32 套，排除 `light`/`dark`/`wireframe` 后正好 29 套） |
| D8 | 技术底线 | 不引入 React。相册/照片墙用 Astro + 原生 JS + Fancybox 实现 |
| D9 | 首页结构 | **照抄参考站**：`/` 就是分页文章列表（含侧栏、快捷卡、分页控件）；`/posts/` 保留为 301 跳回 `/`；文章详情仍在 `/posts/<slug>/` |
| D10 | 站点名 | 改为 **`MelodyZzX's Blog`**（页头主标题、浏览器标签页、Banner 主标题同一套） |
| D11 | 相册 | **完全采用参考站逻辑**：相册 = 一组照片 + 事件名/副标题/日期/图标/描述；照片带 4 种比例；相册卡带拍立得预览；站长有「编辑模式」（新建/编辑/上下移/删除/上传/粘贴 URL/保存并同步）；`/photo-wall/?id=` 看单相册瀑布流 |
| D12 | 赞赏 / 备案 | **都不要**。许可证卡不放赞赏按钮；页脚不放备案号（但字段保留，以后要放填一行即可） |
| D13 | 素材 | 先放**占位图**（SVG 渐变），你之后替换真实图片 |
| D14 | MDX 组件库 | 二期再加，本次不做 |
| D15 | 配置存储 | `/config` 写回 **`config/site.json`**（JSON 可在浏览器端直接校验，不引入 YAML 解析） |
| D16 | 相册照片存储 | 默认存仓库内 `public/image/albums/`（与参考站路径一致，可随仓库回滚）；编辑器同时支持粘贴外链 URL |
| D17 | Banner 素材 | 先用 **4 张占位 SVG**（`public/banner/1~4.svg`），真实图片与张数后续再定 |
| D18 | 个人卡签名 | 直接采用参考站文案：**`Ciallo～(∠・ω<)⌒★`**（注意是全角波浪号 `～`） |
| D19 | 顶部菜单 | 照本方案：**文章 `/` · 导航 `/navigation/` · 相册 `/album/` · 项目 `/project/`**，不额外增删 |

### 关于「首页 / 文章 / post」的关系（D9 的说明）

你现在的站是这样：

| 路径 | 现在是什么 |
|---|---|
| `/` | 首页：横幅 + 最新 5 篇的**标题和摘要**（点标题才进正文） |
| `/posts/` | 全部文章的**列表** |
| `/posts/hello-world/` | 某一篇文章的**正文页** |

参考站是这样：

| 路径 | 是什么 |
|---|---|
| `/` | **就是文章列表**（每页 8 篇，带分页、封面、侧栏），点标题进详情 |
| `/blog/<slug>` | 文章正文页 |

**改造后（本方案 D9）：**

| 路径 | 改造后 |
|---|---|
| `/` | 分页文章列表（= 参考站首页）+ 左侧个人卡/分类/标签/搜索 + 顶部 4 个快捷入口卡 + 底部翻页 |
| `/page/2/`、`/page/3/`… | 第 2、3… 页 |
| `/posts/` | 301 跳回 `/`（保住你现有的外链和书签） |
| `/posts/<slug>/` | 文章正文页（**路径不变**，内容加封面、目录、许可证、上下篇） |

也就是说：**「首页」和「文章列表」合并成一个页面**，这正是你觉得"参考站首页就是文章"的原因。

---

## 1. 参考站拆解（施工参照）

### 1.1 设计语言参数速查

| 要素 | 参数 |
|---|---|
| 内容最大宽度 | `80rem`（`max-w-blog`），左栏 `20rem`（320px）粘性侧栏，右栏自适应（实测 896px） |
| Banner 高度 | 桌面 `70vh`，移动 `40vh`（可配 `banner.height`） |
| Banner 遮罩 | `rgba(0,0,0,.4)` |
| Banner 轮播 | 8s 切换，600ms 交叉淡入，提前 2s 预加载下一张，`IntersectionObserver` 离屏暂停 |
| 波浪收口 | 同一正弦路径叠 4 层 `<use>`，透明度 `25/45/70/100%`、波速 `12/17/22/34s`，每层沿 X 平移**恰好一个波长**（`-88px → 88px`）；`viewBox` 宽 88 = 半个波长（一屏只放得下半个起伏） |
| 打字机 | 每字 `150ms`，删除 `50ms`，整句停留 `2500ms` |
| 导航形态 | 悬浮胶囊：`rounded-full` + `bg-base-100/80` + `backdrop-blur-xl` + `border-white/20` + `shadow-2xl` |
| 导航滚动 | 向下且位移 > `80px` 才淡出；向上立即恢复；`requestAnimationFrame` 节流 |
| 拟态外阴影 | `8px 8px 16px rgba(0,0,0,.05), -8px -8px 16px rgba(255,255,255,.6)` |
| 拟态内阴影 | `inset` 版同上 |
| 暗色拟态 | `8px 8px 16px rgba(0,0,0,.4), -8px -8px 16px rgba(255,255,255,.02)` |
| 卡片圆角 | 大卡 `1.5rem`，中卡 `1rem`，小控件 `999px` 胶囊 |
| 卡片交互 | `shadow-lg` → hover `shadow-xl` + `-translate-y-1` |
| 分类胶囊 | 文件夹图标 + `bg-primary/10` + `text-primary` |
| 标签胶囊 | 标签图标 + 描边 + `bg-base-200` |
| 字体 | 正文 `M PLUS Rounded 1c` 圆体；Banner 标题 `ZCOOL KuaiLe`；代码 `JetBrains Mono` |
| 日期格式 | `ddd YYYY年MM月DD日` → 显示成「周日 2026年10月18日」（带周几） |
| 文章卡比例 | 桌面宽扁卡 ≈ **3.4:1**（896×264，右侧 17rem 图贴边满高）；移动端上图（2:1）下文 |
| 标题墨色 | `.ink-title` = `--ink`（浅色近黑 / 深色近白），**不随主题色相变** |
| 首页入口图标 | 四色固定色相 175 / 275 / 340 / 240，底色亮度借主题 `base-100`（详见 §10.9） |
| Banner 三档模式 | 默认 / 全屏（`100vh`）/ 隐藏 / 作为页面背景（fixed 全屏 + 卡片半透明毛玻璃） |
| 相册比例 | `1x1` / `4x3` / `4x5` / `9x16` 四种，上传时按图片实际尺寸自动判定 |

### 1.2 页面地图与落点

| 参考站 | 本项目落点 | 说明 |
|---|---|---|
| `/`（= 分页列表） | `/` + `/page/[n]/` | **首页即文章列表**（D9） |
| `/blog/[slug]` | `/posts/[slug]/` | **路径不变** |
| `/blog/archives` | `/archive/` | 新增，按年月时间线 |
| `/blog/categories` | `/categories/` | 新增 |
| `/blog/category/[c]` | `/categories/[c]/` | 新增 |
| `/blog/tags` | `/tags/` | 改造版式 |
| `/blog/tag/[t]` | `/tags/[t]/` | 改造版式 |
| `/blog/search` | `/search/` | 改造版式（仍是 Pagefind） |
| `/about` | `/about/` | 改造版式 |
| `/navigation` | `/navigation/` | 新增 |
| `/project` | `/project/` | 新增 |
| `/album` | `/album/` | 新增，相册集（含站长编辑模式） |
| `/photo-wall/?id=<albumId>` | `/photo-wall/?id=<albumId>` | 新增，单相册瀑布流 + 灯箱 |
| `/write` | `/write/` | 新增，取代 Sveltia 的新建/编辑 |
| `/config` | `/config/` | 新增，站点可视化配置 |
| `/admin/` | — | **删除**，改为 302 跳 `/write/` |
| `/anime`、`/friend`、`/music` | — | 不移植 |
| `/stats` | `/stats/` | 保留，视觉改成卡片体系 |

### 1.3 组件映射（参考站源码 → 本项目）

| 参考站组件 | 本项目文件 | 备注 |
|---|---|---|
| `Banner.astro` | `src/components/banner/Banner.astro` | 背景改本地图片列表 |
| `Navbar.astro` | `src/components/nav/DesktopNav.astro` + `MobileNav.astro` | 菜单去掉追番/友人帐/音乐 |
| `widgets/ThemeSelector.astro` | `src/components/theme/ThemeSelector.astro` | 29 套全量 |
| `widgets/BannerSettings.astro` | `src/components/theme/BannerModeToggle.astro` | 三档模式 |
| `widgets/ThemeToggle.astro` | 改造现有 `ThemeToggle.astro` | 在 light/dark 主题间切换 |
| `sidebar/ProfileBar.astro` | `src/components/sidebar/ProfileBar.astro` | 访问量/访客数改走自建接口 |
| `sidebar/{SearchBar,TOCBar,ToolBar}.astro` | `src/components/sidebar/*` | TOC 同时服务文章页 |
| `MainCard.astro` / `temple/Card.astro` | `src/components/card/BaseCard.astro` | 统一卡片外壳 |
| `PostCard.astro` | `src/components/card/PostCard.astro` | 替换现有简易版 |
| `widgets/Pagination*.astro` | `src/components/widgets/Pagination.astro` | 上一页/页码/下一页 |
| `widgets/{PostInfo,PostStats,License,PostNavigation}.astro` | `src/components/post/*` | 文章页各区块（License 去掉赞赏） |
| `widgets/ScrollToTop.astro` | `src/components/widgets/ScrollToTop.astro` | |
| `Footer.astro` | 改造现有 `Footer.astro` | 卡片化 |
| `pages/album` + `admin/AlbumGrid` + `admin/AlbumAdmin` + `PolaroidGallery`（React） | `src/pages/album.astro` + `src/scripts/album-admin.ts` + `src/components/album/PolaroidStack.astro` | **用原生 JS 复刻同一套逻辑** |
| `pages/photo-wall` + `admin/PhotoWallGrid`（React） | `src/pages/photo-wall.astro` + `src/scripts/photo-wall.ts` | 瀑布流 + 灯箱 + 站长编辑 |
| `pages/blog/archives`、`categories`、`tags`、`search` | 对应 `src/pages/*` | |
| `pages/{navigation,project}` | 对应 `src/pages/*` | |
| `components/write/**`（React） | `src/pages/write/` + `src/scripts/write.ts` | 原生 JS 重写 |
| `lib/album-service.ts`（Git Data API 批量提交 + 孤立图片清理） | `src/utils/github.ts` 的 `commitTree()` | 见 §6.4 |

### 1.4 明确不移植

- 追番（TMDB + Bilibili）、友人帐、音乐页
- i18n（中/英切换）、内容仓拆分（`prebuild` 克隆另一个仓库）、`about-edit`
- Umami 统计（用自建 KV 统计替代）
- MDX 组件库（14 个）→ 二期
- 赞赏二维码、备案号（D12）

---

## 2. 现状与差距

### 2.1 必须新增

- 双栏布局 + 粘性侧栏、Banner、胶囊导航、分页、归档/分类页
- 封面图（`image`）与置顶（`badge`）、文章字数统计
- 导航页 / 项目页 / 相册（含编辑模式）/ 照片墙
- `/write`、`/config`（含站长权限 gate）
- 主题选择器 + Banner 三档模式 + 视图过渡

### 2.2 必须删除（D3 的连带影响）

| 文件 / 配置 | 处理 |
|---|---|
| `public/admin/`（整个目录，含 2.5MB `sveltia-cms.js`） | 删除 |
| `scripts/vendor-cms.mjs` | 删除 |
| `package.json` → `"vendor:cms"` 脚本、devDependency `@sveltia/cms` | 删除 |
| `src/components/AdminLink.astro` | 改为跳 `/write/?slug=xxx` |
| README 第十节（后台编辑器） | 重写为 `/write` + `/config` 说明 |
| `BaseLayout.astro` 里 `melodyxz-admin` 的 localStorage 判断 | 统一改成 `ADMIN_OWNERS` 匹配（见 §3.5） |

### 2.3 必须保留（逻辑一行不改）

- `worker/src/index.js` 的 `/auth`、`/callback`、`/api/me`、`/api/meta`、`/api/like`、`/api/view`、`/api/stats`
- `src/utils/site.ts`（登录弹窗、会话、点赞、阅读、统计、toast）
- Giscus 评论、Pagefind 搜索、RSS、robots、sitemap、附件下载
- `astro.config.mjs` 的 `site` / `trailingSlash` / `build.format`

---

## 3. 目标架构

### 3.1 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Astro 7.4（现版本） | 不动 |
| 样式 | Tailwind 3 + daisyUI 4 + `@tailwindcss/typography` | 通过 `postcss.config.mjs` 接入（`@astrojs/tailwind` 已弃用） |
| 图标 | `astro-icon` + `@iconify-json/{lucide,material-symbols,ri,simple-icons}` | 编译期内联 |
| 灯箱 | `@fancyapps/ui`（Fancybox 6） | 相册/照片墙/正文图片 |
| 日期 | `dayjs` | 支持格式串 |
| 预览 | `marked` | `/write` 的 Markdown 实时预览 |
| 字体 | 本地自托管 woff2（拉丁子集） | 见 §5.6 |
| 搜索 | Pagefind 1.5（现版本） | 不动 |
| 后端 | Cloudflare Worker（现有） | 仅新增 `GET /api/site` |

**不引入**：React、zustand、motion、i18n、js-yaml。

### 3.2 目标目录结构

```text
MyBlog/
├─ config/                      ← 【新增】可在线编辑的数据（/config、/album 写回）
│  ├─ site.json                 ←   站点/用户/Banner/菜单/主题/页脚/评论
│  ├─ navigation.json           ←   导航页资源分组
│  ├─ projects.json             ←   项目页条目
│  └─ albums.json               ←   相册与照片数据
├─ public/
│  ├─ banner/                   ← 【新增】Banner 背景图（占位 SVG，后续换图）
│  ├─ images/                   ← 正文图 + 文章封面（沿用）
│  ├─ image/albums/             ← 【新增】相册照片（与参考站路径一致）
│  ├─ files/                    ← 附件（沿用）
│  ├─ fonts/                    ← 【新增】自托管字体
│  ├─ profile.svg               ← 【新增】头像占位
│  └─ favicon.svg
├─ src/
│  ├─ site.config.ts            ← 【新增】读取 config/*.json + 默认值 + 类型
│  ├─ consts.ts                 ← 【收缩】只留技术常量：API_BASE / ADMIN_OWNERS / ANALYTICS
│  ├─ styles/
│  │  ├─ tokens.css             ← 【新增】拟态/圆角/间距/字体变量
│  │  ├─ components.css         ← 【新增】卡片、按钮、胶囊、输入框
│  │  ├─ prose.css              ← 【新增】正文排版
│  │  └─ global.css             ← 【重写】仅 reset + 布局骨架
│  ├─ components/
│  │  ├─ banner/Banner.astro
│  │  ├─ nav/{DesktopNav,MobileNav}.astro
│  │  ├─ sidebar/{ProfileBar,CategoryCard,TagCard,SearchBox,ToolBar}.astro
│  │  ├─ card/{BaseCard,PostCard,ProjectCard,LinkCard,AlbumCard}.astro
│  │  ├─ album/{PolaroidStack,PhotoGrid,AlbumEditor}.astro
│  │  ├─ widgets/{Pagination,ScrollToTop,SectionHead,EmptyState}.astro
│  │  ├─ post/{PostHeader,PostMeta,TOC,License,PostNavigation,Attachments}.astro
│  │  ├─ theme/{ThemeSelector,BannerModeToggle,ThemeToggle}.astro
│  │  └─ auth/{AuthChip,LikeButton,ViewCounter}.astro   ← 保留逻辑，换样式
│  ├─ scripts/                  ← 【新增】原生 TS 模块
│  │  ├─ banner.ts              ←   背景轮播 + 打字机
│  │  ├─ nav.ts                 ←   滚动隐现 + 鼠标召唤
│  │  ├─ toc.ts                 ←   目录高亮
│  │  ├─ theme.ts               ←   主题切换与持久化
│  │  ├─ theme-wave.ts          ←   明暗切换的波纹扩散（View Transitions）
│  │  ├─ album-admin.ts         ←   相册编辑模式（新建/排序/删除/上传/保存）
│  │  ├─ photo-wall.ts          ←   照片墙瀑布流 + 灯箱 + 站长编辑
│  │  ├─ write.ts               ←   /write 页面逻辑
│  │  └─ config.ts              ←   /config 页面逻辑
│  ├─ utils/
│  │  ├─ posts.ts               ← 【扩展】wordCount / categories / archive 分组
│  │  ├─ albums.ts              ← 【新增】相册数据读写 + 比例自动判定
│  │  ├─ site.ts                ← 【扩展】openRepoLogin()
│  │  ├─ github.ts              ← 【新增】GitHub API（单文件 Contents + 批量 Git Data）
│  │  └─ date.ts                ← 【新增】按配置格式串格式化日期
│  ├─ pages/
│  │  ├─ index.astro            ← 重写（第 1 页列表）
│  │  ├─ page/[page].astro      ← 新增（第 2…N 页）
│  │  ├─ posts/index.astro      ← 改为 302 → `/`
│  │  ├─ posts/[...slug].astro  ← 重写版式，路径不变
│  │  ├─ archive/index.astro    ← 新增
│  │  ├─ categories/{index,[category]}.astro  ← 新增
│  │  ├─ tags/{index,[tag]}.astro
│  │  ├─ search.astro
│  │  ├─ about.astro
│  │  ├─ stats.astro
│  │  ├─ navigation.astro       ← 新增
│  │  ├─ project.astro          ← 新增
│  │  ├─ album.astro            ← 新增
│  │  ├─ photo-wall.astro       ← 新增
│  │  ├─ write/index.astro      ← 新增
│  │  ├─ config/index.astro     ← 新增
│  │  └─ admin/index.astro      ← 【新增】302 → /write/
│  └─ layouts/BaseLayout.astro  ← 重写
```

### 3.3 配置文件格式（`config/site.json`）

```jsonc
{
  "site": {
    "title": "MelodyZzX's Blog",        // 页头主标题 / Banner 主标题（D10）
    "tab": "MelodyZzX's Blog",          // 浏览器标签页
    "description": "记录技术、生活与思考的个人空间。",
    "language": "zh-CN",
    "titleType": "image",               // text | image（image = 用 brand-logo 代替站名）
    "titleImage": "/brand-logo.png",
    "favicon": "/favicon.svg",
    "dateFormat": "ddd YYYY年MM月DD日",
    "banner": {
      "images": [
        "/banner/banner-profile.jpg",
        "/banner/banner-rod.jpg",
        "/banner/banner-snow.jpg",
        "/banner/banner-crossing.jpg",
        "/banner/banner-cap.jpg"
      ],
      "interval": 8000,
      "fit": "adapt",                   // adapt = 高度跟着图片比例走（默认）| cover = 固定 height
      "ratio": "16 / 9",                // fit=adapt 时横幅的宽高比
      "height": "70vh",                 // fit=cover 时才用
      "overlay": 0.4
    },
    "theme": {
      "light": "garden",
      "dark": "dracula",
      "allowSelector": true,
      "bannerMode": "default"           // default | fullscreen | hidden | background
    }
  },
  "user": {
    "name": "FormerlyXZ",
    "description": "Ciallo～(∠・ω<)⌒★",     // 个人卡签名（D18，照参考站）
    "avatar": "/profile.svg",
    "site": "https://melodyxz.top",
    "social": [
      { "label": "GitHub", "href": "https://github.com/FormerlyXZ", "icon": "ri:github-line" }
    ]
  },
  "menu": [
    { "id": "blog",    "text": "文章", "href": "/",            "icon": "material-symbols:article-outline" },
    { "id": "nav",     "text": "导航", "href": "/navigation/", "icon": "material-symbols:explore-outline-rounded" },
    { "id": "album",   "text": "相册", "href": "/album/",      "icon": "material-symbols:photo-library-outline" },
    { "id": "project", "text": "项目", "href": "/project/",    "icon": "material-symbols:folder-code-outline" }
  ],
  "pages": {
    "home":       { "title": "MelodyZzX's Blog", "subtitle": "记录技术、生活与思考", "typewriter": ["Hello World", "欢迎来到我的博客"] },
    "about":      { "title": "About Me",  "subtitle": "一个热爱生活与技术的普通人" },
    "navigation": { "title": "网站导航",   "subtitle": "收藏的常用网站和工具链接" },
    "project":    { "title": "Projects",   "subtitle": "一些个人搭建的项目" },
    "album":      { "title": "Albums",     "subtitle": "记录生活中的美好瞬间，分享我的照片故事" },
    "archive":    { "title": "文章归档",   "subtitle": "按日期浏览文章" }
  },
  "blog": { "pageSize": 8 },
  "comments": {
    "provider": "giscus",
    "giscus": { "repo": "FormerlyXZ/MyBlog", "repoId": "…", "category": "Announcements", "categoryId": "…" }
  },
  "footer": {
    "social": [ { "label": "GitHub", "href": "https://github.com/FormerlyXZ", "icon": "ri:github-line" } ],
    "poweredBy": "基于 Astro 构建 · 设计参考 RyuChan",
    "copyright": "© 2026 FormerlyXZ",
    "icp": "",                            // D12：留空则不显示
    "icpLink": "https://beian.miit.gov.cn/"
  }
}
```

配套 `src/site.config.ts`：`import siteJson from '../../config/site.json'` + 深合并默认值 + 导出带类型的常量（`SITE`、`USER`、`SITE_MENU`、`PAGE_TEXTS`、`BLOG_PAGE_SIZE`…），保证配置缺字段时构建不炸。

> `config/*.json` 是构建输入，改它必须重新构建才生效（静态站特性），`/config` 页面里要写清楚这条提示。

### 3.4 相册数据（`config/albums.json`，字段照抄参考站）

```jsonc
[
  {
    "id": "a1b2c3d4",
    "date": "2026-05-20",
    "event": "新世纪福音战士",              // 封面标题（事件名）
    "title": "明日香头像",                  // 副标题
    "description": "整理的一些头像收藏",     // 相册描述
    "icon": "🌊",                          // emoji 或 iconify 名（lucide:camera）
    "photos": [
      { "src": "/image/albums/a1b2c3d4-0-1716.jpg", "variant": "1x1", "title": "第一张", "description": "" }
    ]
  }
]
```

- `photo.variant` 四种：`1x1` / `4x3` / `4x5` / `9x16`；**上传时按图片实际宽高比自动判定**（参考站 `detectVariantFromUrl`）
- `photo.src` 支持仓库内路径（`/image/albums/xxx.jpg`）或**外链 URL**
- 保存走 Git Data API 一次性提交（blob → tree → commit → update ref），并**自动清理不再被引用的孤立图片**（参考站 `saveAlbumsToGitHub` 的 orphan 处理逻辑）

### 3.5 权限与登录

**登录通道（复用现有 Worker，不新增 OAuth App）**

| 用途 | 入口 | scope | 令牌存放 |
|---|---|---|---|
| 前台点赞 / 看统计 | 页头「GitHub 登录」 | `read:user` | `localStorage['melodyxz-user']` |
| 写作 / 站点配置 / 相册编辑 | `/write`、`/config`、`/album` 编辑模式 | `repo` | `localStorage['melodyxz-edit']` |

`src/utils/site.ts` 增加 `openRepoLogin()` / `getEditSession()` / `clearEditSession()`（与现有 `openLogin()` 同一套弹窗 + postMessage 协议，只是 `scope=repo`、写另一个 key）。Worker 的 `/auth` 已支持 `repo` scope，**无需改动**。

**入口可见性（沿用你现有规则）**

- 判定：`ADMIN_OWNERS` 包含 `localStorage['melodyxz-user'].login`，**或** `melodyxz-edit` 已存在
- 满足时显示：页脚「✎ 写文章」→ `/write/`、页脚「⚙ 站点配置」→ `/config/`、文章页「✎ 编辑本篇」→ `/write/?slug=`、`/album` 顶部「编辑模式」按钮、`/photo-wall` 的编辑按钮
- 不满足时一律隐藏（HTML 默认 `hidden`）；知道 URL 直接打开也只会看到「用 GitHub 授权」空壳，不拉取任何数据
- `ADMIN_OWNERS` 留在 `src/consts.ts`，与 `worker/wrangler.toml` 的 `OWNER_LOGINS` 保持一致

### 3.6 后端接口（Worker）

| 接口 | 状态 | 说明 |
|---|---|---|
| `GET /auth`、`GET /callback` | 现有 | 不动（已支持 `repo` / `read:user`） |
| `GET /api/me` | 现有 | 不动 |
| `GET /api/meta` | 现有 | 批量读点赞/阅读（≤30 条/次）→ 列表卡片用 |
| `POST /api/like`、`POST /api/view` | 现有 | 不动 |
| `GET /api/stats` | 现有 | 站长统计页用 |
| **`GET /api/site`** | **新增** | 公开只读 `{ views, likes, posts }`；`views` 由 `/api/view` 顺带自增 `site:views`，`likes` 由 `site:likes`；`Cache-Control: public, max-age=60` |

> 侧栏「访问量 / 访客数」两格 → 改为「总阅读 / 总点赞」。
> 文章卡片 meta 的「浏览 / 访客」→ 改为「阅读 / 点赞」，数据走 `/api/meta`。
> 不引入 Umami（参考站那两列数字来自 Umami share API，我们没有也不需要）。

---

## 4. 分阶段实施（严格按顺序，每阶段可独立验收）

> 每阶段一个 commit，**每阶段结束必须 `npm run build` 通过 + 本地 `npm run dev` 手测通过**。
> **全程不 push**（§12）。

### P0 · 兼容性验证（0.5 天）✅ 已完成

**目标**：确认 Tailwind 3 + daisyUI 4 在 Astro 7 下能出包，并确认拟态变量可用。

- ☑ `npm i tailwindcss@^3.4 daisyui@^4 @tailwindcss/typography autoprefixer`
- ☑ 新建 `postcss.config.mjs`（`tailwindcss` + `autoprefixer`），**不要**用 `@astrojs/tailwind`
- ☑ 新建 `tailwind.config.mjs`：`content` 指向 `./src/**/*.{astro,js,ts,md}`；`plugins: [daisyUI, typography]`；`daisyui: { themes: [全量], darkTheme: 'dracula' }`；`theme.extend.colors` 加 `neu-base / neu-text / neu-border / neu-btn-bg / neu-text-muted`
- ☑ 临时页验证：garden 主题卡片 + `shadow-neu-out` + `backdrop-blur` 正常
- ☑ 验证 `.astro` 的 `<style>` 里 `@apply` 是否生效（不生效 → 全部样式进全局 CSS 类，写进 §5）
- **验收**：`npm run build` 通过；临时页明暗两主题观感正确
- **回滚点**：本阶段只增不删，删两个配置文件即回退
- **备选**：若 Tailwind 3 与 Astro 7 冲突 → 改 Tailwind 4 + daisyUI 5（代价：`oklch(var(--b1))` 写法要按 daisyUI 5 变量名改写，§1.1 参数不变）

**实测结论（2026-10-19）**：

| 验证项 | 结果 | 说明 |
|---|---|---|
| Tailwind 3 + daisyUI 4 @ Astro 7.4 | ✅ 通过 | `npm run build` 正常，产物 CSS 92KB（含 29 套主题） |
| **R1：`.astro` `<style>` 内 `@apply`** | ✅ **完全可用** | 产物中 `@apply rounded-card bg-base-100 p-6 shadow-neu-out` 被完整展开为 `background-color: var(--fallback-b1,oklch(var(--b1)/…))` + `box-shadow: var(--neu-shadow-out,…)` + `border-radius:1.5rem` + `padding:1.5rem`。**备用方案不需要了，组件可正常用 `@apply`** |
| garden（浅）/ dracula（深） | ✅ 正常 | 卡片、badge、input、toggle、语义色全部随主题变色 |
| `shadow-neu-out` / `shadow-neu-in` | ✅ 正常 | `var(--neu-shadow-out, 浅色兜底值)` 生效 |
| 深色拟态配色 | ⚠️ 需覆盖 | 未覆盖变量时深色卡片出现白色亮晕（浅色兜底值所致）。实测 `[data-theme-type='dark'] { --neu-shadow-out: … }` 覆盖后立即恢复正常 → **确认 P1 的 `tokens.css` 覆盖方案可行** |
| `backdrop-blur-xl` 毛玻璃胶囊 | ✅ 正常 | Safari/Chromium 均可用 |
| `max-w-blog` / `w-sidebar` 扩展 | ✅ 正常 | 72rem / 20rem |

> **主题数量定为 29 套**：daisyUI 4.12 内置 32 套，排除 `light`、`dark`（通用兜底色，本站浅色用 garden、深色用 dracula）和 `wireframe`（调试线框）后正好 29 套。
> 临时验证页与临时 CSS 已删除；`postcss.config.mjs`、`tailwind.config.mjs` 保留，Tailwind 指令在 P1 并入 `global.css`。

### P1 · 设计地基 · 配置中心 · 占位素材（2 天）✅ 已完成

- ☑ 新建 `config/site.json`（照 §3.3，站名填 **MelodyZzX's Blog**）与 `src/site.config.ts`
- ☑ 收缩 `src/consts.ts`：只留 `API_BASE`、`ADMIN_OWNERS`、`ANALYTICS`；`SITE`/`GISCUS` 搬进 `site.json`
- ☑ 新建 `src/styles/tokens.css`、`components.css`、`prose.css`；重写 `global.css`（只留 reset + `body` + `.max-w-blog` + 布局 + 打印/无障碍）
- ☑ 字体自托管到 `public/fonts/`（`M PLUS Rounded 1c` 400/700 拉丁子集、`ZCOOL KuaiLe` 400、`JetBrains Mono` 400），`@font-face` + `font-display: swap` + 中文回落栈
- ☑ **占位素材**（D13）：`public/banner/1~4.svg`（1200×675 渐变 + 站点名）、`public/profile.svg`（圆角方块 + `MZ` 字样）、`public/images/cover-1~3.svg`（文章封面占位）、`public/image/albums/placeholder-1~4.svg`（相册占位）；全部走 SVG，几 KB 一个，后续替换
- ☑ 新建 `src/utils/date.ts`（按 `dateFormat` 格式化，替换现有 `FormattedDate` 用法）
- ☑ 扩展 `src/utils/posts.ts`：`wordCount()`、`getCategories()`、`getArchiveGroups()`
- ☑ 新建 `src/utils/albums.ts`（读 `config/albums.json`、`detectVariant()` 比例判定、id 生成）
- **验收**：`npm run build` 通过；demo 页同时呈现拟态卡片/胶囊按钮/分类胶囊/标签胶囊/圆体字；站名已是 `MelodyZzX's Blog`

**实施结果与必要调整（2026-10-19）**

| 项 | 实际做法 | 与计划的差异 / 原因 |
|---|---|---|
| 配置文件 | `config/site.json` + `site.config.ts`（内置 `DEFAULTS` 深合并） | 顺带按同一套风格建了 `config/navigation.json`、`config/projects.json`（P3/P4 直接用）；`config/albums.json` 带 1 条示例相册（4 种比例各一张，兼作数据格式文档） |
| `consts.ts` | 只留技术常量；`SITE`/`GISCUS`/`SITE_URL` 改为从 `site.config` 派生的**兼容层**，标注「P2–P6 随旧组件一起删除」 | 老页面（Header/Footer/about/rss）还在用旧接口，一次性删会当场构建失败 |
| `global.css` | 顶层 `@import` 三件套 + `@tailwind` 三指令；**旧样式不作废**，整体挪到「旧样式区」注释块内 | 原计划「重写」会立刻把 P2–P6 之前的所有页面打花。改为**增补 + 分区**，每页重写时同步删对应旧规则，视觉始终可用 |
| `components.css` | **不能**用 `@layer components` 包裹，写成普通规则 | ⚠ 见下方 §10.8 陷阱 ①：`@import` 的文件被 Tailwind 单独处理，无 `@tailwind components` 的文件里的 `@layer` 内容会被**整块丢弃**（实测 `.card-neu` 只剩媒体查询那一行） |
| `prose.css` | 每条选择器写成 `.prose-blog.prose-blog`（双类名提权） | ⚠ 见 §10.8 陷阱 ②：本文件在 `@tailwind` 之前注入，同权重下被 typography 插件覆盖（实测正文被锁 65ch、标题样式丢失） |
| 字体 | `@fontsource` 三个包作**来源**，`npm run sync:fonts` 复制拉丁子集到 `public/fonts/`（共 66KB） | 运行时不依赖 npm 包、不请求 CDN；换字体/升版本重跑脚本即可 |
| ZCOOL KuaiLe | **本期未启用**，`fonts.css` 里留好注释位 | 其中文子集单个 woff2 就 726KB，只为一句话的装饰标题拖慢首屏不划算；站名本身是拉丁字符，圆体已够。想启用：丢一个 woff2 进 `public/fonts/` 取消注释 |
| 占位素材 | 用 `scripts/gen-placeholders.mjs` 生成（`npm run gen:assets`），不是手写 SVG | 12 个文件风格统一、改站名可一键重生成；换成自己的图直接覆盖同名文件 |
| preflight 副作用 | 在旧样式区加了一段「preflight 补偿」（`.prose ol/ul` 列表符号、标题字重） | Tailwind base 的 reset 会清掉旧正文依赖的浏览器默认值，不补偿的话过渡期文章页列表没有序号 |
| 文章元数据 | 3 篇旧文章补 `categories`（随笔 / 教程 / 教程） | `image` 留空走渐变兜底（§6.2 允许） |

> **踩坑记录**：改 `tailwind.config.mjs` 后必须**重启 dev server**，Vite 不会热更新 PostCSS/Tailwind 配置 —— 否则会看到「组件有样式、工具类全丢」的假象（本次已实测踩中）。改 `config/*.json` 同理。


### P2 · 全站骨架（2 天）✅ 已完成

- ☑ `banner/Banner.astro`：双层背景交叉淡入 + 遮罩 + 标题/副标题 + 波浪 SVG；按 `Astro.url.pathname` 从 `pages.*` 取文案；首页与文章页启用打字机
- ☑ `scripts/banner.ts`：8s 轮播 / 600ms 淡入 / 预加载 / 离屏暂停 + 打字机；挂 `astro:page-load`
- ☑ `nav/DesktopNav.astro`：胶囊 + logo/站名 + 图标菜单 + 右侧工具（配置齿轮、调色板、Banner 模式、明暗切换）
- ☑ `nav/MobileNav.astro`：头像 + 图标按钮组 + 设置菜单
- ☑ `scripts/nav.ts`：滚动隐现（阈值 80px，位移 < 5px 忽略，`rAF` 节流）
- ☑ `theme/ThemeSelector.astro` + `scripts/theme.ts`（29 套；写 `data-theme` / `data-theme-type` / localStorage）
- ☑ `theme/BannerModeToggle.astro`（写 `<html data-banner-mode>` + localStorage）
- ☑ 重写 `layouts/BaseLayout.astro`：Banner + 双 Nav + 双栏 grid + 侧栏槽位 + Footer；接 `ClientRouter`
- ☑ 改造 `Footer.astro` 为卡片（Powered by / 版权 / 社交图标 / 站长入口；备案位留空不显示）
- ☑ 把现有 inline 脚本（主题初始化、站长入口显隐）改成 `astro:page-load` 驱动
- **验收**：`/`、`/posts/<slug>/`、`/about/` 三页都有 Banner + 双栏 + 卡片页脚；390px 无横向滚动；29 套主题切换后卡片颜色跟随
- **风险**：`ClientRouter` 会影响 Giscus / Pagefind / 登录脚本 → 本阶段必须回归「评论加载、搜索可用、点赞可用」

**实施结果与必要调整（2026-10-19）**

| 项 | 实际做法 | 说明 |
|---|---|---|
| 页面生命周期 | **新增 `src/scripts/pageload.ts`**：`onPageLoad()`（首次加载 + 每次 `astro:page-load`）与 `onBeforeSwap()`（换页前清理） | 计划里没这个文件，但它把「ClientRouter 时代所有脚本都要重绑」收敛成一个工具，交互脚本统一走它 |
| **R2 回归结果** | ✅ 全部通过，但**每个都改了** | 实测：走 ClientRouter 换页后，`search.astro` 的 Pagefind、`Giscus`、`LikeButton`、`ViewCounter`、`AuthChip` **全部失效**（脚本只执行一次，新 DOM 没人绑事件）。逐个改成 page-load 驱动 + `dataset.init` 幂等 |
| Pagefind | `search.astro` 脚本重写：`ensureAssets()` 按需插 `pagefind-ui.css/js`，`initSearch()` 每次换页检查 `#search` 是否已初始化 | 验证：客户端跳到 `/search/` 后搜索框正常出现，能搜出 4 条结果 |
| Giscus | 主题判定从 `data-theme === 'dark'` 改为 `data-theme-type`；换页时断开旧 Observer | 验证：客户端跳到文章页后 iframe 正常注入 |
| 点赞 / 阅读数 | 同样改 page-load + `dataset.init`；`refresh()` 加 `wrap.isConnected` 判断 | 验证：客户端跳进文章页后「阅读 8 次」「点赞 1」都正确填充 |
| 深色主题清单 | 定为 **11 套**：dracula / synthwave / halloween / forest / black / luxury / business / night / coffee / dim / sunset（daisyUI 官方划分） | §10.5 里那份 10 套的旧清单作废，实际以 `src/utils/theme.ts` 为准 |
| 主题清单放哪 | 新增 `src/utils/theme.ts`（纯数据，无 DOM），`scripts/theme.ts` 只放 DOM 逻辑 | 服务端渲染选择器要 import 清单，不能让 Node 碰到 `document` |
| 配色选择器 | 每个色块自己带 `data-theme`，所以**色点显示的就是该主题的主色** | 比纯文字列表直观得多，一眼能挑 |
| Banner 模式 | 背景模式额外需要：`body { background: transparent }` + `.layout__main` 垫一层毛玻璃 | 否则固定背景被 body 的不透明底色挡住；垫玻璃层还能让「还没重写的老页面」在背景模式下也读得清 |
| Banner 高度 | 移动端 40vh 用**覆盖 `height` 属性**实现，不能靠覆盖 `--banner-h` 变量 | 变量写在元素内联样式上，media query 盖不掉（实测移动端一直卡在 70vh） |
| 旧样式兼容 | `:root[data-theme='dark']` 全部改为 `:root[data-theme-type='dark']` | 全站明暗标记换成 `data-theme-type`；不改这段，过渡期深色主题下老页面会黑字配黑底 |
| 图标 | 接入 `astro-icon` + `material-symbols` / `ri` / `lucide`（本地 npm 包，构建不联网） | 新增 `src/icons/` 放自绘图标（当前空目录，附说明） |
| 侧栏 | 新增 `sidebar/ProfileBar.astro`（原计划在 P3），P2 先作为侧栏默认内容 | 否则 P2 验收里的「双栏」无从体现；统计两格已接 `/api/site`，接口未上线时显示「—」 |
| 清理 | 删除已无人引用的 `components/Header.astro`、`components/ThemeToggle.astro`（旧版） | 新导航取代了它们 |

### P3 · 首页（= 分页列表）与卡片体系（2 天）

- ☑ `sidebar/ProfileBar.astro`：大头像、站名、主色短横线、签名、社交图标、底部两格（总阅读 / 总点赞 ← `GET /api/site`）
- ☑ `sidebar/CategoryCard.astro`（计数徽章）、`sidebar/TagCard.astro`（胶囊 + 「更多」折叠）、`sidebar/SearchBox.astro`、`sidebar/ToolBar.astro`
- ☑ 快捷入口卡 2×2（归档 / 分类 / 标签 / 搜索）
- ☑ `card/PostCard.astro`：桌面左文右图、移动上图下文；meta 四列（日期 / 字数·阅读时长 / 阅读 / 点赞）；分类 + 标签胶囊；无封面用主题渐变色块 + 标题首字兜底
- ☑ `card/BaseCard.astro`：统一 `.card-neu` 外壳
- ☑ `widgets/Pagination.astro`：拟态上一页/页码/下一页，链接形如 `/`、`/page/2/`
- ☑ `index.astro` 重写为第 1 页；新增 `page/[page].astro`（`getStaticPaths` 生成 2…N，**不生成 1**，避免与 `/` 重复）
- ☑ `posts/index.astro` 改为 `Astro.redirect('/')`（302）
- ☑ 卡片阅读/点赞数：加载后 `/api/meta` 批量填充（先显示 `—`）
- **验收**：`/` 与演示站首页结构一致；`/page/2/` 可翻页；`/posts/` 跳回首页；卡片 hover 抬升 + 图片缩放

**实施结果（2026-10-19）**

| 项 | 实际做法 | 说明 |
|---|---|---|
| 首页结构 | 快捷入口卡（第 1 页才有）→ 文章卡片流 → 分页；侧栏为 个人卡→搜索→分类→标签→站长工具 | 与参考站一致 |
| 快捷入口 | 桌面 **4 列**、移动 2×2 | 计划写「2×2」，桌面横排 4 个更紧凑，信息密度更高 |
| 分页验证 | 临时把 `pageSize` 改成 2 跑通 `/page/2/`，验证后改回 8 | 3 篇文章配 8 篇/页时只有 1 页，不这么做分页永远测不到 |
| `/posts/` 跳转 | 静态构建产出的是 **meta refresh 页面**（`url=/`），不是真正的 302 | 纯静态托管做不到真 302。要真正的 301/302 需在 EdgeOne 加一条跳转规则（可选，不影响使用） |
| meta 批量填充 | 新增 `card/PostMetaScript.astro`：收集本页所有卡片路径 → **一次** `/api/meta` → 分别回填 | 每张卡片单独请求会打爆接口；失败保持「—」 |
| 卡片内链 | 标题用 `after:absolute inset-0` 撑满整卡（stretched link），胶囊加 `relative z-10` | 卡片整体可点，同时分类/标签仍可单独点，且不产生 `<a>` 嵌套 |
| 搜索框 | 侧栏是纯 GET 表单 → `/search/?q=`；搜索页读出 `q` 后填进 Pagefind 输入框自动搜 | 不用 JS 也能用；对 Pagefind 零依赖 |
| 标签折叠 | 用原生 `<details>` 展开前 12 个之外的标签 | 零 JS |
| Worker | 新增公开接口 `GET /api/site` → `{ views, likes }`，结果在 KV 缓存 60 秒（key `site:summary`） | 首页个人卡的「总阅读 / 总点赞」用它，已通过语法检查；**需要 `npm run deploy:worker` 上线后才生效**，上线前显示「—」 |

> ⚠ **本次踩到的坑（务必记住）**：不要用 PowerShell 的 `Get-Content` / `Set-Content` 改仓库里的 UTF-8 文件 —— 控制台是 GBK，会把中文写成乱码并留下 BOM，Vite 解析 JSON 直接报 `control character found`。改文件一律用编辑器工具或 `.NET File.WriteAllText` + `UTF8Encoding($false)`。


### P4 · 文章页（2 天）

- ☑ `post/PostHeader.astro`：封面 + 标题压在半透明深色胶囊；meta 行；分类/标签胶囊；站长可见「编辑」
- ☑ `post/TOC.astro` + `scripts/toc.ts`：标题锚点树 + 滚动高亮 + 左侧竖条；移动端抽屉
- ☑ `post/License.astro`：CC 图标 + 协议 + 作者 + 阅读统计 + 分享（Web Share API，降级复制链接）；**不含赞赏**（D12）
- ☑ `post/PostNavigation.astro`：上一篇/下一篇大卡片
- ☑ `post/Attachments.astro`：现有附件区块卡化，保留图标映射
- ☑ `auth/LikeButton.astro`、`auth/ViewCounter.astro`：改成图标 + 数字行内样式，**调用逻辑不变**
- ☑ `Giscus.astro`：容器卡化，`theme` 跟随 `data-theme-type`
- ☑ `posts/[...slug].astro` 重写：保留 `data-pagefind-body`、SEO props、`AdminLink` 改造
- **验收**：文章页结构 = 演示站；点赞/阅读数/评论/附件/上下篇全部回归；Pagefind 仍能搜到正文

**实施结果（2026-10-19）**

| 项 | 实际做法 | 说明 |
|---|---|---|
| 目录摆放 | 桌面放**左侧栏**（粘性，个人卡上方），移动端正文顶部可折叠 `<details>` | 计划写「移动端抽屉」，用原生 `<details>` 更轻；桌面沿用已有的左栏，不额外开第三栏 |
| 目录标题来源 | `render()` 返回的 `headings`，只取 h2/h3 | 不用自己解析 Markdown AST |
| 目录高亮 | 滚动位置判定（`scrollY + 140px` 线 → 取最后一个越过该线的标题），`rAF` 节流 | 一开始用 `IntersectionObserver` + `rootMargin`，**实测页面顶部会「谁都不选中」**，目录看起来像坏了；改成滚动判定后打开就稳定高亮第一节 |
| 标题锚点 | 沿用 Astro 默认给 h2/h3 加 `id` | 已确认正文标题带 id，目录链接直接可用 |
| 分享 | `navigator.share` → 失败/不支持则 `clipboard.writeText` → 再失败提示手动复制 | 无第三方分享 SDK |
| 点赞/阅读 | 只改标记（图标 + 数字 + `已赞` 小徽章），脚本逻辑一行没动 | 满足「保留登录与点赞逻辑」 |
| AdminLink | 加 `label` / `pill` 两个可选属性，改成胶囊按钮 | 仍指向 `/admin/`，P7 再切到 `/write/?slug=` |
| 附件图标 | 由 emoji 换成 iconify 图标 + 扩展名徽标 | 与全站图标体系统一 |


### P5 · 归档 / 分类 / 标签 / 搜索（1.5 天）

- ☑ `/archive/`：按年月时间线 + 年份锚点
- ☑ `/categories/`、`/categories/[category]/`
- ☑ `/tags/`、`/tags/[tag]/`：标题卡 + 标签胶囊墙（带计数）
- ☑ `/search/`：Pagefind UI 换皮（胶囊输入框 + 卡片结果）
- ☑ 统一「标题卡 + 内容卡」版式（`widgets/SectionHead.astro`）
- **验收**：四类页面视觉与演示站同级；中文标签 URL 正常

**实施结果（2026-10-19）**

| 项 | 实际做法 | 说明 |
|---|---|---|
| 统一标题卡 | 新增 `widgets/PageHeader.astro`（标题 + 副标题 + 右侧统计 + 可选按钮） | 归档/分类/标签/搜索/关于/相册/照片墙全部复用 |
| 归档 | 左竖线 + 圆点的时间线，按月分组、带条数与字数 | 计划提「年份锚点」，当前文章量太少（1 个月）用不上，先按年月分组；文章多了加年份锚点即可 |
| 分类索引 | 2 列卡片：图标 + 分类名 + 篇数 + 最近 3 篇标题 | 比纯胶囊列表更有信息量 |
| 标签索引 | 标签胶囊墙，字号随篇数档位变化（不是连续缩放，避免过花） | |
| 搜索 | 换皮成「标题卡 + 卡片」，Pagefind UI 逻辑不变；新增 `?q=` 自动填充并搜索 | 配合侧栏搜索框的 GET 表单，不用 JS 也能搜 |
| 关于页 | 改用 `config/site.json` 的 user/site 数据 + 三块事实卡 + prose 排版 | 之前写死了站名与作者 |
| 中文标签 URL | 保持 `/tags/编码后名字/`，构建正常 | 已验证 `#教程`、`#Markdown` 等页面可访问 |


### P6 · 导航 / 项目 / 相册 / 照片墙（3.5 天）✅ 访客侧已完成（相册编辑推迟到 P7）

**导航页**

- ☑ `/navigation/`：分组资源卡（图标/名称/描述）+ 分组筛选 chips + 页内搜索（前端过滤 `config/navigation.json`）

**项目页**

- ☑ `/project/`：项目卡片墙（图标/名称/描述/技术标签/链接），数据来自 `config/projects.json`

**相册（照抄参考站逻辑，D11）**

- ☑ `card/AlbumCard.astro`：图标 + 事件名（主色链接）+ 副标题 + 日期徽章 + 描述 + 「N 张照片」+ **拍立得预览**（`album/PolaroidStack.astro`：3 张小图轻微旋转叠放，hover 展开）
- ☑ `/album/`：2 列网格（`md:grid-cols-2`），空态展示「还没有相册」
- ☐ **站长编辑模式**（`scripts/album-admin.ts`）：
  - 顶部「编辑模式」开关（未登录不渲染）
  - 卡片顶部工具条：序号徽章、上移、下移、编辑、删除（删除二次确认）
  - 「新建相册」按钮 → 编辑抽屉
- ☐ **相册编辑抽屉**（`album/AlbumEditor.astro`）：
  - 字段：事件名（封面标题）、副标题、日期、图标（emoji 或 iconify 名，可搜索）、描述
  - 照片区：批量粘贴 URL（每行一条）、本地上传（多选）、每张设置比例下拉（1:1 / 4:3 / 4:5 / 9:16，上传后自动判定）、标题、描述、删除
  - 底部「保存并同步」→ 走 Git Data API 批量提交，提示上传进度与孤立图片清理数量
- ☑ `/photo-wall/?id=<albumId>`：单相册瀑布流（`columns` 布局按比例自适应）+ Fancybox 灯箱（左右切换、键盘、标题/描述）；未带 `id` 时提示「请从相册页选择相册」
- ☐ 站长在照片墙页也能编辑（同 `album-admin.ts` 复用）
- **验收**：相册可新建/编辑/排序/删除并保存到 `config/albums.json` + `public/image/albums/`；访客只读；灯箱正常；无照片的相册不报错

**实施结果（2026-10-19）**

| 项 | 实际做法 | 说明 |
|---|---|---|
| 导航页 | 分组卡片 + 分类 chips + 关键词过滤，**两者叠加生效**；分组内空了自动隐藏整组，底部有「无匹配」空态 | 全前端过滤，不发请求 |
| 项目页 | 2 列卡片：图标 / 名称（外部链接）/ 状态徽章 / 域名 / 描述 / 标签 / 访问与源码按钮 | |
| 相册卡 | 拍立得叠放：3 张按 `--i` 旋转偏移，hover 扇形展开（纯 CSS） | 与参考站观感一致，没有额外 JS |
| 照片墙 | **服务端渲染全部相册**（每个相册一个 `<section data-pw-album>`），客户端只按 `?id` 显示对应那个 | 比纯客户端渲染更利于 SEO 与首屏；`?id` 无效时回退到第一个相册 |
| 灯箱 | 用原生 `<dialog>` + 自己写的左右切换/Esc/点遮罩关闭 | **不改用 Fancybox**：它要额外装 `@fancyapps/ui`（~50KB）且样式要再调；原生 dialog 零依赖、无障碍语义天然正确 |
| 相册编辑模式 | **推迟到 P7** 与 `/write`、`/config` 一起做 | 三处都要用同一套 GitHub 写文件能力（`utils/github.ts`），先把只读侧做完整，写侧一次做完不返工。访客侧现在已是完整只读 |


### P7 · 在线写作与站点配置（4 天，取代 Sveltia）✅ 已完成（相册编辑器除外）

- ☑ `utils/github.ts`：单文件读写（Contents API，`GET`/`PUT` 带 `sha`）、批量提交（Git Data API：`createBlob` → `createTree` → `createCommit` → `updateRef`）、`listDir`、`deleteFile`、孤立文件清理
- ☑ `utils/site.ts` 增加 `openRepoLogin()` / `getEditSession()` / `clearEditSession()`
- ☑ `/write/` + `scripts/write.ts`：
  - 未授权 → 只渲染空壳 + 「用 GitHub 授权」
  - 已授权 → 左：标题 / slug / 正文（`textarea` + 「预览」切 `marked`）/ 「导入 MD」；右：封面（上传或填 URL）、摘要、分类、标签（回车添加）、置顶（badge）、日期、草稿、附件
  - 发布：`PUT src/content/posts/<slug>.md`（前端拼 YAML frontmatter，日期 `YYYY-MM-DD`），commit message 带标题
  - 编辑：`/write/?slug=xxx` → `GET` 文件 → 解析回填 → 保存带 `sha`
  - slug 规则沿用现有「日期 + 标题」约定（URL 不变）
- ☑ `/config/` + `scripts/config.ts`：选项卡（站点 / 用户 / Banner / 菜单 / 页脚 / 评论 / 主题），「可视化 / 代码（JSON）」双视图，保存 = 一次 commit 写回 `config/site.json`；保存前 `JSON.parse` 校验 + 差异预览
- ☑ 删除 Sveltia 相关文件与依赖（§2.2）
- ☑ `admin/index.astro` → `Astro.redirect('/write/')`
- ☑ 前台入口改造：页脚「✎ 写文章 / ⚙ 站点配置」、文章页「✎ 编辑本篇 → `/write/?slug=`」
- ☑ `robots.txt.ts` 补 `Disallow: /write/`、`Disallow: /config/`
- **验收**：站长登录后能新建/编辑/删除文章、改站名，本地重新构建后生效；访客打开 `/write`、`/config` 看不到任何数据
- **风险**：`repo` 令牌权限大 → 只存本机、只对本域 postMessage、退出即清；`/config` 写坏 JSON 会导致构建失败 → 保存前强制校验 + 提示「先本地构建验证再 push」

**实施结果（2026-10-19）**

| 项 | 实际做法 | 说明 |
|---|---|---|
| 登录通道 | 把原来的 `openLogin()` 抽成 `openOAuthPopup({ scope, popupName })`，`openLogin()`（read:user→`melodyxz-user`）与 `openEditLogin()`（repo→`melodyxz-edit`）都走它 | 一套弹窗协议两种权限，不新增 OAuth App；点赞登录逻辑零改动 |
| `/write` 字段 | 标题 / 文件名 / 日期 / 摘要 / 分类 / 标签 / 封面 / 上传封面 / 置顶 / 草稿 / 附件 / 正文 | 分类与标签用「逗号分隔」输入而不是 chip 回车添加（更省事、中文输入法下不出错）；附件用「每行一个」文本框 |
| 文件名自动生成 | 标题改动时自动 `日期-标题`（保留中英文与数字，其余折成 `-`），用户手改过后不再覆盖 | 避免中文标题产生奇怪 URL，也保留手动指定权 |
| 封面图 | 上传 → `putBinary('public/images/<时间戳>-<名>')` → 自动把路径填回表单 | 单张图片走 Contents API，不占用批量提交 |
| **未做**：正文 Markdown 预览 | 「预览」按钮与 `marked` 依赖本期没加 | 写文章本身不受影响；需要时可加一个 `marked` + 分栏预览，工作量约半天 |
| `/config` 形态 | 先做**代码视图**：一个 JSON 编辑器 + 格式化 / 校验 / 重新读取 / 保存 | 计划里的「选项卡可视化」是把 JSON 映射成表单，字段多且要双向同步，容易出错；JSON 视图 + 现场校验已经能安全完成所有配置修改，可视化表单后续可增量加 |
| 保存安全 | 保存前二次 `JSON.parse`，格式不对直接拦下不提交 | 避免「写坏配置 → 下次构建失败」这条最大风险 |
| Sveltia | 删除 `public/admin/`（含 chunks/locales）、`scripts/vendor-cms.mjs`、`@sveltia/cms` 依赖、`vendor:cms` 脚本 | `/admin/` 改为跳 `/write/` |
| 相册编辑器 | **仍未实现**（`album-admin.ts` / `AlbumEditor.astro`） | 需要「批量上传 + 排序 + 删除 + 孤立图片清理」交互，是独立的一大块；`utils/github.ts` 的 `commitFiles()` 已经写好，接上界面即可 |


### P8 · 收尾与打磨（2 天）⏳ 部分完成

- ☐ 29 套主题逐一巡检：文字对比度、拟态阴影、图片遮罩、Giscus 主题映射
- ☑ Banner 三档模式回归（全屏 / 隐藏 / 作背景 + 卡片毛玻璃）
- ☐ 动效：卡片入场、hover 抬升、返回顶部、`prefers-reduced-motion` 全量降级
- ☑ 移动端 390 / 1440 巡检（无横向滚动、上图下文、40vh Banner）；768 / 1024 待逐档看
- ☐ 无障碍：焦点环、跳转链接、图标按钮 `aria-label`、`alt` 文案
- ☐ SEO：`og:image`（封面）、文章 JSON-LD、sitemap 收录新页面
- ☑ 404 页换皮
- ☑ 更新 README（目录结构、`/write`、`/config`、致谢 RyuChan/Frosti）
- ☑ 全量回归（§7.2）的路由部分：19 个地址全部 200
- **验收**：全部页面通过回归清单

**已完成部分（2026-10-19）**

| 项 | 结果 |
|---|---|
| 路由回归 | `/`、`/archive/`、`/categories/`、`/tags/`、`/about/`、`/navigation/`、`/project/`、`/album/`、`/photo-wall/?id=`、`/search/`、`/stats/`、`/write/`、`/config/`、`/posts/hello-world/`、中文分类与标签页、`/rss.xml`、`/robots.txt`、`/sitemap-index.xml` **全部 200** |
| 功能回归 | Pagefind 搜索（4 条结果）、Giscus 加载、点赞、阅读数、站长入口显隐、ClientRouter 换页后各脚本重建、灯箱、导航筛选、分页（临时 pageSize=2 验过）均正常 |
| 移动端 | 390px 无横向滚动；Banner 40vh；卡片上图下文；导航收成头像 + 汉堡 |

**仍未做（下次接着干）**

1. **相册编辑器**（P6 遗留）：`album-admin.ts` + `AlbumEditor.astro`，上传/排序/删除/孤立图片清理；`utils/github.ts` 的 `commitFiles()` 已就绪。
2. **正文 Markdown 预览**（`/write` 里加 `marked` 分栏预览）。
3. **`/config` 可视化选项卡**（当前是 JSON 编辑器 + 校验）。
4. **主题巡检与无障碍**：29 套配色逐一过对比度；焦点环、`alt`、JSON-LD、`og:image`。
5. **Worker 部署**：`npm run deploy:worker` 才会让 `/api/site`（个人卡总阅读/总点赞）上线。
6. **生产构建后的最终点检**：`npm run build && npm run preview` 全站过一遍。


---

## 5. 样式与组件规范

### 5.1 颜色与主题

- 只用 daisyUI 语义色：`base-100/200/300`、`base-content`、`primary`、`secondary`、`accent`、`info`；**禁止硬编码 hex**
- 拟态变量在 `tokens.css` 由 `oklch(var(--b1))` 等派生，随主题自动变
- `data-theme-type="dark|light"` 控制明暗分叉（Giscus theme、图片遮罩强度、拟态阴影）

### 5.2 统一类名（避免每个组件各写一套）

```css
.card-neu        /* 白底/大圆角/阴影，hover 抬升 */
.card-neu--flat  /* 无 hover（侧栏小卡） */
.sidebar-card    /* 侧栏卡片间距与内边距 */
.btn-round       /* 圆形图标按钮 */
.btn-pill        /* 胶囊按钮（分页、筛选 chips） */
.pill-category   /* 分类胶囊（主色浅底） */
.pill-tag        /* 标签胶囊（描边） */
.input-pill      /* 胶囊输入框 */
```

### 5.3 字号与间距

- 正文 `16px / 1.75`，移动 `15px / 1.65`
- 卡片标题：桌面 `1.25rem`，移动 `1rem`
- Banner 主标题：桌面 `clamp(2.5rem, 6vw, 6rem)`，移动 `2rem`
- 卡片内边距：桌面 `1.25rem`，移动 `1rem`

### 5.4 图标

- 统一 `astro-icon` 的 `Icon` 组件，写全集合前缀（`lucide:` / `material-symbols:` / `ri:`）
- 尺寸：菜单 `1.25rem`、卡片内 `1rem`、工具按钮 `1.25rem`

### 5.5 图片

- 封面/相册固定宽高 + `object-cover`，避免 CLS
- 一律 `loading="lazy" decoding="async"`（首屏 Banner 除外）
- 正文图片 `data-fancybox="post"` 进灯箱

### 5.6 字体（不经外网）

```text
public/fonts/
├─ m-plus-rounded-1c-400.woff2   （拉丁子集，15–25KB）
├─ m-plus-rounded-1c-700.woff2
├─ zcool-kuaile-400.woff2        （Banner 标题，常用字）
└─ jetbrains-mono-400.woff2
```

`font-display: swap`；中文回落 `PingFang SC` / `HarmonyOS Sans SC` / `Noto Sans SC`。**不引入 Google Fonts CDN**。

---

## 6. 内容模型与后台

### 6.1 文章 frontmatter（扩展后）

```yaml
---
title: 文章标题
description: 一句话摘要
date: 2026-10-20
image: /images/cover-1.svg        # 新增：封面（可空 → 渐变兜底）
categories: [技术, 生活]          # 新增：分类（可空）
tags: [Astro, 博客]
badge: Pin                        # 新增：Pin = 置顶（可空）
draft: false
attachments: [/files/a.pdf]
---
```

`src/content.config.ts` 增量：`image: z.string().optional()`、`categories: z.array(z.string()).default([])`、`badge: z.string().optional()`。**旧文章无需改动**（全部有默认值）。

### 6.2 现有 3 篇文章的迁移

- ☐ `hello-world.md` / `markdown-guide.md` / `deploy-guide.md`：补 `categories`（建议「随笔」「教程」「部署」），封面可先不补（走渐变兜底）
- ☐ 检查日期格式与中文标签 URL

### 6.3 `/write` 字段与校验

| 字段 | 控件 | 校验 |
|---|---|---|
| title | 文本框 | 必填 |
| slug | 文本框（自动按「日期-标题」生成，可改） | 必填，不含 `/` |
| date | 日期选择 | 必填 |
| description | 多行 | 可空 |
| image | 上传 / URL | 可空；上传进 `public/images/` |
| categories / tags | 回车添加的 chip | 可空 |
| badge | 开关（Pin） | 可空 |
| draft | 开关 | 默认 false |
| attachments | 多文件上传 | 进 `public/files/`，单文件 ≤ 20MB |
| body | 文本域 + 预览 | 必填 |

### 6.4 `/album` 编辑器的保存链路（照抄参考站）

```text
点击「保存并同步」
  → 待上传照片：File → base64 → createBlob → 收集 treeItem（路径 public/image/albums/<id>-<idx>-<ts>.<ext>）
  → 把 photo.src 改写为 /image/albums/<同名>
  → 重写 config/albums.json（整份 JSON 作为 treeItem）
  → 读取当前分支 head → getCommit → getTreeRecursive（比对未被引用的旧图 → sha:null 删除）
  → createTree → createCommit('chore(albums): update albums data') → updateRef
  → toast 显示：上传 N 张 / 清理 M 张 / 成功
```

### 6.5 `/config` 面板与数据落点

| 面板 | 写回 | 备注 |
|---|---|---|
| 站点 | `site.json → site.*` | 标题、描述、favicon、日期格式 |
| 用户 | `site.json → user.*` | 头像上传、昵称、签名、社交图标 |
| Banner | `site.json → site.banner` / `pages.*` | 图片列表增删排序；上传进 `public/banner/` |
| 菜单 | `site.json → menu` | 文本/链接/图标名 |
| 页脚 | `site.json → footer` | 社交、版权、备案（可空） |
| 评论 | `site.json → comments` | 固定 giscus，仅改 repo/category ID |
| 主题 | `site.json → site.theme` | 浅/深主题名、是否开放选择器、Banner 模式 |

> 相册不在 `/config` 里管，按参考站逻辑放在 `/album` 的编辑模式里（D11）。

---

## 7. 风险与验收

### 7.1 风险清单

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | ~~`@astrojs/tailwind` 已弃用，`.astro` 内 `@apply` 可能失效~~ | 组件样式写不进 | **✅ P0 已排除**：通过 PostCSS 接入后，`.astro` 的 `<style>` 里 `@apply` 完全可用（产物已验证展开），无需备用方案 |
| R2 | `ClientRouter` 导致 Giscus / Pagefind / 登录脚本二次加载异常 | 评论/搜索/点赞失灵 | P2 后立即回归；脚本挂 `astro:page-load` 并做幂等判断 |
| R3 | daisyUI 4 与 Tailwind 版本错配 | 构建报错 | 锁 `tailwindcss@3.4.x` + `daisyui@4.12.x` |
| R4 | 29 套主题下对比度不足 | 部分主题文字看不清 | P8 逐主题巡检；`black/luxury` 单独调拟态阴影 |
| R5 | 封面图缺失卡片塌陷 | 列表视觉不齐 | `PostCard` 内置渐变兜底块 |
| R6 | `/config` 写坏 JSON | 本地构建失败 | 保存前强制 `JSON.parse` 校验 + 差异预览 |
| R7 | `repo` 令牌泄露 | 仓库被改 | 只存本机、退出即清、只对本域 postMessage、页面 `noindex` + robots 屏蔽 |
| R8 | 字体体积过大 | LCP 变差 | 只自托管拉丁子集 + woff2 + `swap` |
| R9 | 旧 `/admin/` 外链失效 | 书签 404 | `admin/index.astro` 302 跳转 |
| R10 | 相册图片进 Git 导致仓库膨胀 | 构建变慢 | 单图压缩 ≤ 500KB；编辑器上传时提示 |
| R11 | 首页改为分页列表后旧 `/posts/` 链接 | 外链 404 | `posts/index.astro` 做 302 到 `/`（D9） |
| R12 | 本地改了 `config/*.json` 但页面没变 | 误判为 bug | 静态站特性：改配置需重启 dev / 重新 build，写进提示文案 |

### 7.2 全量回归清单（每阶段抽跑，P8 全跑）

- ☐ 首页（含 `/page/2/`）、文章详情、归档、分类、标签、搜索、关于、导航、项目、相册、照片墙、统计、404 全部可访问
- ☐ 明暗主题 + 任选 3 套配色下文字可读
- ☐ 移动端 390px：导航、侧栏、卡片、灯箱、TOC 抽屉正常
- ☐ GitHub 登录 → 点赞 → 取消点赞 → 刷新后状态保持
- ☐ 阅读数 +1（同 IP 30 分钟只算一次）
- ☐ Giscus 加载、发帖、主题跟随
- ☐ Pagefind 能搜到新文章正文
- ☐ 站长登录后：`/write` 新建/编辑/删除成功；`/config` 保存成功；`/album` 新建相册 + 上传照片 + 保存成功
- ☐ 访客（未登录）打开 `/write`、`/config`、`/album` 编辑模式、`/stats` 均看不到数据
- ☐ `npm run build` 无报错；浏览器 console 无 error

---

## 8. 待确认事项（已全部确认，无遗留）

原先列出的 4 个问题已闭环：

| # | 问题 | 结论 |
|---|---|---|
| 1 | 相册照片存哪 | 存仓库内 `public/image/albums/`（D16），编辑器同时支持外链 |
| 2 | Banner 张数与风格 | 先用 4 张占位 SVG（D17），真实素材后补 |
| 3 | 个人卡签名 | 用参考站文案 `Ciallo～(∠・ω<)⌒★`（D18） |
| 4 | 菜单顺序 | 照方案：文章 / 导航 / 相册 / 项目（D19） |

实施过程中若遇到细枝末节（如图标选哪个、文案措辞），按「参考站怎么做就怎么做，参考站没有就用最朴素方案」处理，不单独打断你；
遇到会改变结构或数据格式的偏差，再回来确认。

---

## 9. 工作量估算

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0 | 兼容性验证 | 0.5 天 |
| P1 | 地基 + 配置 + 占位素材 | 2 天 |
| P2 | 全站骨架 | 2 天 |
| P3 | 首页（分页列表）+ 卡片体系 | 2 天 |
| P4 | 文章页 | 2 天 |
| P5 | 归档/分类/标签/搜索 | 1.5 天 |
| P6 | 导航/项目/相册/照片墙（含相册编辑器） | 3.5 天 |
| P7 | `/write` + `/config` | 4 天 |
| P8 | 收尾打磨与回归 | 2 天 |
| **合计** | | **≈ 19.5 天** |

---

## 10. 附录 · 关键实现速查

### 10.1 波浪 SVG

> **重做（2026-10-19，第二次）**：上一版把 `viewBox` 拉宽到 704（4 个起伏）反而更糟，
> 而且**根本没有 `@keyframes wave`**——参考站是把关键帧写在组件 `<style>` 里的，
> 我搬 SVG 时只搬了 `animation: wave ...`，于是那几层 `<use>` 一直处于「有动画声明、
> 无关键帧」的状态，`transform` 恒为 `none`，波浪是**完全静止**的（这才是"死板"的真因）。
>
> 现在按参考站源码重做，并补上它没写清楚的几何关系：
>
> 1. **波形**：`M-160 44` 起手，`c30 0 58-18 88-18` 一个上拱，之后 `s…` 交替拱/谷，
>    每段 88 用户单位，**一个完整起伏 = 176 单位**；收尾 `v44h-704z` 把曲线下方填实。
> 2. **平移距离必须 = 整数个波长**（`-88px → +88px` = 176 单位 = 1 个波长），
>    否则每次循环都会"跳一下"。方向从负到正 = **向右推进**。
>    `translate3d` 里的 `px` 在 SVG 内部按**用户单位**解释，所以位移会随窗口宽度等比缩放。
> 3. **覆盖区必须包住可见区**：`viewBox="0 24 88 28"` 可见 x ∈ [0, 88]；
>    路径 8 段 = 704 单位、`x="48"` → 屏幕坐标 [-112, 592]，
>    叠加平移 ±88 后任意时刻覆盖 [-200, 680]，左右都不会露白。
>    （中间一版 `x=88`＋6 段，平移到 +88 时左边缘会出现 16 单位的空档——已修。）
> 4. **相位/波速错开**：四层用不同 `--wave-delay`（负值 = 页面加载时就处于不同相位）
>    和不同 `--wave-duration`，相位差与波速差都出现，才不会像一块板在平移。
> 5. **颜色**：三层 `base-100`（25/45/70%），最下一层 `base-200` 全不透明——
>    `base-200` 正好是页面底色，所以波浪到底部与正文**无缝**，任何主题都跟随。
>
> **波长标定（2026-10-19 第三次调整）**：`preserveAspectRatio="none"` 下
> 「一屏能看到几个浪」完全由 **viewBox 宽度 / 176** 决定，与屏幕宽度无关：
>
> | viewBox 宽 | 一屏可见 | 观感 |
> |---|---|---|
> | 88（当前） | **半 个波长** | 一道很缓的长涌，像海岸线慢慢推过来 |
> | 132 | 0.75 个 | 屏内能看出一点起伏 |
> | 176 | 1 个 | 与参考站同量级 |
> | 320 | 1.8 个 | 一屏两个浪头，节奏偏碎 |
>
> 定成 88 是照「网页只放得下半个波长左右」的要求。改波长只动 `viewBox` 宽度即可，
> 但**必须重新验算覆盖区**（见自检清单②）；波长变长后同样的 `--wave-duration`
> 会让浪跑得更快（每秒跨过的屏幕宽度变大），所以四层时长相应放慢到 12/17/22/34s。

```html
<svg class="banner__waves" viewBox="0 24 88 28" preserveAspectRatio="none">
  <defs>
    <path id="banner-wave"
      d="M-160 44c30 0 58-18 88-18s58 18 88 18 58-18 88-18 58 18 88 18 58-18 88-18
         58 18 88 18 58-18 88-18 58 18 88 18 58-18 88-18 58 18 88 18v44h-704z" />
  </defs>
  <g>
    <use href="#banner-wave" class="banner__wave banner__wave--1" x="48" y="0" />
    <use href="#banner-wave" class="banner__wave banner__wave--2" x="48" y="3" />
    <use href="#banner-wave" class="banner__wave banner__wave--3" x="48" y="5" />
    <use href="#banner-wave" class="banner__wave banner__wave--4" x="48" y="7" />
  </g>
</svg>
```

```css
.banner__waves {                 /* 高度 11vh，≥768px 时 17vh；底边落在 -1px 吃掉接缝 */
  position: absolute; bottom: -1px; left: 0; z-index: 1; width: 100%;
  height: 11vh; min-height: 3.5rem; max-height: 10.5rem;
  pointer-events: none;
}

.banner__wave {
  fill: oklch(var(--b1));
  animation: wave-travel var(--wave-duration, 16s) linear infinite;  /* 线性才匀速"推进" */
  animation-delay: var(--wave-delay, 0s);
  will-change: transform;
}

.banner__wave--1 { --wave-duration: 12s; --wave-delay: -2s;  opacity: .25; }
.banner__wave--2 { --wave-duration: 17s; --wave-delay: -6s;  opacity: .45; }
.banner__wave--3 { --wave-duration: 22s; --wave-delay: -11s; opacity: .7; }
.banner__wave--4 { --wave-duration: 34s; --wave-delay: -17s; opacity: 1; fill: oklch(var(--b2)); }

@keyframes wave-travel {
  from { transform: translate3d(-88px, 0, 0); }   /* 88×2 = 176 = 一个波长，首尾无缝 */
  to   { transform: translate3d(88px, 0, 0); }
}

@media (prefers-reduced-motion: reduce) { .banner__wave { animation: none; } }
```

> 改动这块时的自检清单：①平移量是不是 176 的整数倍；②`x` 偏移＋路径宽度是否在
> ±平移量之后仍能盖住 `[0, viewBox 宽]`；③`prefers-reduced-motion` 是否已关闭动画。

### 10.2 拟态阴影

> 变量名统一带 `neu-` 前缀，与 `tailwind.config.mjs` 的 `boxShadow['neu-out'/'neu-in']` 对应。
> **必须写进 `src/styles/tokens.css`**（P1）。不覆盖时深色主题会因浅色兜底值出现白色亮晕（P0 已实测）。

```css
:root {
  --neu-shadow-out: 8px 8px 16px rgba(0,0,0,.05), -8px -8px 16px rgba(255,255,255,.6);
  --neu-shadow-in: inset 8px 8px 16px rgba(0,0,0,.05), inset -8px -8px 16px rgba(255,255,255,.6);
}
[data-theme-type='dark'] {
  --neu-shadow-out: 8px 8px 16px rgba(0,0,0,.4), -8px -8px 16px rgba(255,255,255,.02);
  --neu-shadow-in: inset 8px 8px 16px rgba(0,0,0,.4), inset -8px -8px 16px rgba(255,255,255,.02);
}
```

### 10.3 Banner 轮播（本地图片版）

```ts
const IMAGES = BANNER_IMAGES;          // 来自 config/site.json
const INTERVAL = 8000, FADE = 600;
let current = 0, timer: number | undefined;

const preload = (src: string) => new Promise<void>((ok, fail) => {
  const i = new Image(); i.onload = () => ok(); i.onerror = () => fail(); i.src = src;
});

async function next() {
  const src = IMAGES[(current + 1) % IMAGES.length];
  if (!src) return;
  try {
    await preload(src);
    current = (current + 1) % IMAGES.length;
    nextLayer.style.backgroundImage = `url(${src})`;
    nextLayer.style.opacity = '1';
    setTimeout(() => {
      currentLayer.style.backgroundImage = `url(${src})`;
      nextLayer.style.transition = 'none';
      nextLayer.style.opacity = '0';
      nextLayer.offsetHeight;           // 强制重绘
      nextLayer.style.transition = '';
    }, FADE);
  } catch { /* 图坏了跳过这一轮 */ }
}
// IntersectionObserver 离屏停止；astro:page-load 重建、astro:before-swap 清理
```

> 首图不再固定是 `IMAGES[0]`：`BaseLayout` 的 `<head>` 里先随机挑一张写成 CSS 变量 `--banner-start`，
> Banner 第一层用 `background-image: var(--banner-start, url(第一张))`，`banner.ts` 再读
> `window.__bannerStartIndex` 从同一张接着往下轮播。细节见 §10.13。

### 10.4 导航滚动隐现

```ts
let lastY = 0, ticking = false;
const THRESHOLD = 80, MIN_DELTA = 5;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const y = window.scrollY;
    if (Math.abs(y - lastY) >= MIN_DELTA) {
      const down = y > lastY && y > THRESHOLD;
      nav.classList.toggle('is-hidden', down);
      lastY = y;
    }
    ticking = false;
  });
}
```

> 2026-10（第 8 轮）又加了两样：指针滑到 Banner 上自动让位、指针贴到页面顶部唤回，
> 以及「面板开着 / 键盘焦点在导航里 / 触屏」三种不收起的情况，见 §10.15 第三条。

### 10.5 主题切换

```ts
const DARK = ['dark','synthwave','halloween','forest','black','luxury','dracula','business','night','coffee'];
function setTheme(name: string) {
  document.documentElement.dataset.theme = name;
  document.documentElement.dataset.themeType = DARK.includes(name) ? 'dark' : 'light';
  localStorage.setItem('theme', name);
}
```

首次渲染前的防闪屏脚本沿用现有 `BaseLayout` 那段（优先 `localStorage.theme`，否则系统偏好 → 取 `site.theme.light/dark`）。

### 10.6 相册比例自动判定

```ts
async function detectVariant(src: string): Promise<'1x1'|'4x3'|'4x5'|'9x16'> {
  const img = new Image();
  img.src = src;
  await img.decode().catch(() => {});
  const ratio = img.naturalWidth / img.naturalHeight;
  const cands = [
    ['1x1', 1], ['4x3', 4/3], ['4x5', 4/5], ['9x16', 9/16],
  ] as const;
  return cands.reduce((best, cur) =>
    Math.abs(cur[1] - ratio) < Math.abs(best[1] - ratio) ? cur : best
  )[0];
}
```

### 10.7 Tailwind / daisyUI 实际配置（P0 已落地，后续阶段照此扩展）

**已安装版本（锁定，勿随意升级）**

| 包 | 版本 | 作用 |
|---|---|---|
| `tailwindcss` | `3.4.17` | 工具类引擎（**不能用 4.x**，daisyUI 4 只配 Tailwind 3） |
| `daisyui` | `4.12.23` | 组件库 + 主题变量 |
| `@tailwindcss/typography` | `0.5.16` | 文章正文 `prose` 排版 |
| `postcss` | `8.4.49` | 构建链 |
| `autoprefixer` | `10.4.20` | 浏览器前缀 |

**接入方式**：新建 `postcss.config.mjs`（Astro 自动读取），**不注册 `@astrojs/tailwind`**（已弃用）。

**`tailwind.config.mjs` 已定义、后续直接可用的扩展**

| 键 | 值 | 用途 |
|---|---|---|
| `maxWidth.blog` | `72rem` | 内容区总宽 |
| `width.sidebar` | `20rem` | 左栏粘性侧栏 |
| `colors.neu-base / neu-text / neu-text-muted / neu-border / neu-btn-bg` | 全部由 `oklch(var(--b1))` / `var(--bc)` 派生 | 拟态配色的语义别名，随主题自动变色，**禁止硬编码 hex** |
| `borderRadius.card` / `borderRadius.neu` | `1.5rem` / `1rem` | 大卡 / 中卡 |
| `boxShadow.neu-out` / `neu-in` | `var(--neu-shadow-out, 浅色兜底)` | 见 §10.2，P1 覆盖变量 |
| `fontFamily.sans / mono` | 已指向 `M PLUS Rounded 1c` / `JetBrains Mono` | P1 自托管 woff2 后自动生效 |
| `keyframes.wave-travel` + `animation.wave-travel` | `-88px → 88px`（= 一个波长 176 用户单位），`linear` 无限循环，四层时长 `12/17/22/34s` | §10.1 波浪收口 |
| `darkMode` | `['selector', '[data-theme-type="dark"]']` | 明暗分叉走 `<html data-theme-type>`，**不用 `.dark` 类** |
| `daisyui.themes` | 29 套（见 D7） | 第一项 `garden` 为默认 |

> **写法约定**：明暗分叉用 `data-theme-type`；颜色只用 daisyUI 语义色与 `neu-*` 别名；不要在组件里写 `#hex`。

### 10.8 两个已踩过的 Tailwind 陷阱（P1 实测，务必记住）

**陷阱 ①：`@import` 进来的 CSS 文件里不能用 `@layer`**

Astro/Vite 把 `@import` 拆成独立文件逐个交给 Tailwind；
没有 `@tailwind components` 指令的文件，其 `@layer components { … }` 内容会被**静默丢弃**（不报错，只是样式没了）。
实测：`components.css` 加 `@layer` 后，产物里 `.card-neu` 只剩媒体查询那一行，`.btn-pill` 完全消失。

→ **规则：只有 `global.css`（含 `@tailwind` 指令的那个文件）里可以写 `@layer`；其余被 `@import` 的文件一律写普通规则。**
副作用是这些规则排在 utilities 之前，工具类可以正常覆盖组件类 —— 这正是我们想要的。

**陷阱 ②：同权重下会被 Tailwind 插件的样式盖掉**

`prose.css` 的注入位置在 `@tailwind` 之前，而 `@tailwindcss/typography` 生成的 `.prose-blog` 规则排在后面 ——
两者权重都是 `0-1-0`，后写者赢，于是我们的微调全部失效（实测正文被锁死在 `65ch`）。

→ **规则：覆盖 Tailwind 插件生成的类时，把类名写两遍提权**：`.prose-blog.prose-blog { … }`（`0-2-0`）。
不要依赖文件顺序，也不要为此把 `@import` 挪到指令后面（CSS 规范会忽略位置靠后的 `@import`）。

**陷阱 ③：改配置后请重启 dev server**

`tailwind.config.mjs` / `postcss.config.mjs` / `config/*.json` 改动，Vite 不会热更新，
表现为「daisyUI 组件正常、Tailwind 工具类全丢」的假象。**先重启再判断是不是 bug。**

### 10.9 首页第 4 轮微调：加宽 / 宽扁文章卡 / 墨色标题 / 四色入口 / 周几

改动清单（2026-10-19）：

| 项 | 做法 |
|---|---|
| 右栏加宽 | `--blog-width` `72rem → 80rem`；侧栏仍 `20rem`，于是右栏 `768 → 896px`，快捷入口单卡 `378 → 440px` |
| 文章卡比例 | `BaseCard padded={false}` + `sm:min-h-[16.5rem]` + 右侧图 `sm:w-[17rem]` 撑满高度 → 实测 **896×264 ≈ 3.4:1**（参考图 838×254 ≈ 3.3:1）；移动端恢复「上图（2:1）下文」 |
| 卡片内部顺序 | 照参考图：标题 → meta 两行（日期/字数·时长、阅读/点赞）→ 摘要 → 标签（`mt-auto` 贴底） |
| 封面 | 3 篇示例文章各配一张 CC0 图片（见 §11），`image:` 写 `public/covers/*.jpg`（1200×900、≤200KB） |
| 墨色标题 | 新增 `--ink`（浅色 `oklch(21% .008 265)` / 深色 `oklch(96% .004 265)`）+ `.ink-title`；**注意要让 `.ink-title a` 也继承**，否则全局 `a{color:var(--accent)}` 会把标题染成主题色 |
| 四色入口图标 | `.quick-icon--{archive,category,tag,search}` 各自一个固定色相（175/275/340/240）；底色用**相对颜色** `oklch(from oklch(var(--b1)) calc(l±…) 0.07 var(--qi-h))` 只借主题亮度 |
| 周几 | `site.dateFormat` 改为 **`ddd YYYY年MM月DD日`** → 「周日 2026年10月18日」（`ddd` token 早就支持，只是没启用） |

> **配色踩坑记录**：一开始用 `color-mix(in oklch, 彩色 55%, oklch(var(--b1)))` 混底色，
> 结果四个色块的色相被主题底色"拖"到一起（garden 下 175/275/340/240 全变成 104/321/357/302，
> 因为 oklch 是极坐标，混色是**角度插值**，低彩度底色照样能把色相拽走一大截）。
> 正确做法：底色用相对颜色语法只取亮度（`oklch(from … l c h)`），色相写死；
> 前景用 `color-mix(in oklab, …)`（直角坐标，色相不会被拖）。
> 相对颜色需要 Chrome 119+/Safari 16.4+/Firefox 128+，所以 CSS 里先写一条固定色兜底。

### 10.10 第 5 轮微调：标题字号 / 4:3 封面 / 自建搜索 / Banner 菜单顺序 / 社交入口

| 项 | 做法 |
|---|---|
| 文章标题 | `text-base sm:text-lg` → **`text-lg sm:text-xl`**（16/18 → 18/20px）；快捷入口标题同步 `text-base sm:text-lg` |
| 封面比例 | 卡片封面固定 **4:3**：移动端 `aspect-[4/3]`，桌面 `sm:w-[22rem]` + `sm:self-stretch`；卡片 `sm:min-h-[16.5rem]` → 实测卡片 896×264（3.39:1）、封面 352×264（1.33 = 4:3） |
| Banner 菜单顺序 | `BANNER_MODES` 改成 默认 → 全屏 → 背景 → **隐藏（最后）** |
| 侧栏社交 | 原来的 GitHub 一项扩成 6 项：GitHub / 哔哩哔哩 / 抖音 / YouTube / X / Instagram（图标用 `ri:*`，抖音用 `ri:tiktok-line`） |

**搜索为什么重写（重要）**

原来用 Pagefind：索引是 `build` **之后**由 `pagefind --site dist` 生成的，
所以**本地 `npm run dev` 时 `/pagefind/` 根本不存在**，搜索页静默什么都不显示 —— 开发环境里永远搜不到。

现在改成自建索引，dev / 线上行为一致，也不再依赖 Pagefind：

| 文件 | 作用 |
|---|---|
| `src/pages/search-index.json.ts` | 构建期输出 `/search-index.json`：`[{title, description, url, date, categories, tags, text}]`，`text` 是洗掉 Markdown 记号后的正文（截断 6000 字） |
| `src/pages/search.astro` | 页面端 fetch 一次索引后本地过滤：标题 ×5、标签/分类 ×3、摘要 ×2、正文 ×1，多个关键词空格分隔且**全部命中**才算；结果带 `<mark>` 高亮和正文片段；支持 `/search/?q=`、`/` 聚焦、Esc/清空按钮 |

> 两个小坑：①`<mark>` 高亮必须用**回调参数**拼字符串，字符串替换才会展开 `$&`，函数替换里 `$&` 是字面量（踩过，标题变成 `$& 速查表`）；
> ②高亮是「先 `escapeHtml` 再插 `<mark>`」，避免把正文里的 `<` 当标签执行。

### 10.11 第 6 轮：交互动效 + About Me 页

**一、全站下划线清零**

`a:hover { text-decoration: underline }` 删掉；正文链接（`prose.css`）也不用任何形式的横线
（连常驻的 `border-bottom` 都不要），只靠「主色 + 字重 + hover 加深」区分。

**二、五处鼠标动效**

| 位置 | 效果 | 关键实现 |
|---|---|---|
| 文章卡 | **板块不动**，只有标题在 hover 时变主题渐变 + 上移 2px | `.post-tile:hover { transform:none }` 抵消 `.card-neu:hover` 的 `translateY(-4px)`；卡片加 12% 文字色描边 + 底色混 5% 文字色，轮廓比页面清楚一点 |
| 封面图 | 灰幕 42% + 白色右箭头（从左侧 12px 滑入），点图直接进文章 | 整块 `<a class="cover-link">` 包住 `img`，`overflow:hidden` 里放 `.cover-veil` / `.cover-arrow` |
| 分类 / 标签 | 放大 **1.5 倍**并反色（分类：主色浅底 → 浅底主色字 + 主色描边；标签：浅底 → 深底浅字） | `transform: scale(1.5)` + `z-index:6` + 主题色阴影；用 `--p` / `--bc`，任何主题都成立 |
| 签名 | hover 放大 1.1 | `.slogan` |
| 侧栏头像 | 灰幕 40% + 证件照式小人笔画（`material-symbols:person-outline-rounded`），点击进 `/about/` | `.avatar-link` 包住 img |

> **渐变标题的写法**（容易写反）：渐变必须写在**基础规则**里，同时 `background-clip: text`；
> 平时文字是不透明的墨色，把渐变盖住；只有 `:hover` 才把 `color` / `-webkit-text-fill-color`
> 设成 transparent 让渐变透出来。如果把 `background-image` 只写在 `:hover` 里，
> 那所有**没 hover** 的标题都会显示成一条彩色底块（第一次就踩了这个）。

> **类名撞车**：新卡片类名一开始叫 `.post-card`，跟 `global.css` 里旧设计留下的 `.post-card`
> （hover 上移 1px、旧配色、`--bg-subtle` 底）撞了，表现为「设了 `transform:none` 还是上移 1px、
> 底色也不是我写的那层」。改成 `.post-tile` 后正常。改样式前先 grep 一下类名有没有被旧样式占用。

**三、About Me（`/about/`）**

- 内容全部挪到 **`config/about.json`**：`intro[]`（自我介绍）、`aboutSite`（标题/开头/两组清单）、`credit`（致谢）
- 页面右上角有「编辑」按钮（`data-admin-link`，只有站长能看到）→ `/about/edit/`
- 编辑页复用 `scripts/config.ts` 那一套（`data-config-root` + `data-config-path="config/about.json"`），
  流程与 `/config` 完全一致：读最新 → 校验 JSON → 一次 commit → 等自动部署
- 原首页页脚那句「设计参考 RyuChan」移到 About 页页尾；页脚只剩「基于 Astro 构建」
- `robots.txt` 追加 `Disallow: /about/edit/`（`/about/` 正文页照常收录）

**四、修「切主题偶尔不对、刷新才好」**

实测复现（在 `astro:*` 事件里读 `<html>` 的 data-*）：

| 时机 | data-theme / data-theme-type |
|---|---|
| `astro:before-swap` | `synthwave / dark` |
| `astro:after-swap` | **`garden / light`** ← ClientRouter 把新文档里 SSR 的属性搬了过来 |
| `astro:page-load` | `synthwave / dark` |

也就是说换页后**先按默认主题画了一帧甚至几帧**，`astro:page-load` 才纠正 ——
表现就是「切换/翻页后配色或明暗偶尔是错的，刷新一下才对」（刷新时 `<head>` 的防闪屏
inline 脚本会先把主题写好，所以正常）。

修法（`src/scripts/theme.ts`）：

1. `astro:before-swap`：拿 `event.newDocument.documentElement`，**在换页前**就把
   `data-theme / data-theme-type / data-banner-mode` 改成正确的值 —— 新页面第一帧就是对的；
2. `astro:after-swap`：再 `reapplyStored()` 兜一次底；
3. `astro:page-load` 里原有的重放保留（幂等）。

> 刷新后实测：`before-swap / after-swap / page-load` 三个时机读到的都已经是
> `synthwave / dark / hidden`，且「隐藏 Banner」状态同样不会在换页时被重置成 default。

**五、胶囊与标语（第三次调整）**

- 放大从 1.5 → **1.12**（1.5 太夸张，还会顶到相邻元素）
- **真·颜色反转**：平时「浅底 + 彩色字」，hover 变「彩色实底 + 对比色字」
  - 分类：`--p` 12% 底 + `--p` 字 → hover `--p` 实底 + `--pc` 字
  - 标签：`--s` 10% 底 + `--s` 字 + `--s` 22% 描边 → hover `--s` 实底 + `--sc` 字
  - 只用 `--p` / `--s`（就是标题渐变的前两色），所以换主题时胶囊和标题渐变永远同一套色
- 标语 `Ciallo～(∠・ω<)⌒★` 改成**常驻渐变**（同款 p→s→a），hover 再放大 1.1

### 10.12 第 7 轮：品牌图 + 导航栏重做

**一、品牌图（抠白底）→ `public/brand-logo.png`**

原图 `uploads/MelodyZzX高木同学.png`（1619×971 像素画，白底）。生成脚本 `scripts/prep-logo.mjs`
（`npm run gen:logo`，可重复跑，输出稳定）：

1. **不能「全图白 → 透明」**：人物身上有白水手服、白袜子、白爱心气泡，一刀切会打出一堆洞
   （第一版就是这么废的）。正解是**从四边洪水填充**「和画布边缘连通的白」：
   字母镂空（o/e/d 的内孔）与外面是连通的，会一起被抠掉；被描边围住的白色原样保留。
2. 透明像素的 RGB 统一刷成描边色 `#531a2c` —— 缩放时边缘不会渗出白边（白底图最常见的脏边）。
3. 按不透明像素包围盒裁掉留白，宽度降到 1000px（**1000×537，比例 1.863:1**，113KB 调色板 PNG）。
4. 脚本同时输出 `.playwright-mcp/brand-preview.png`（白 / 灰 / 深三块底色对照）+ 深底放大图，
   用来确认抠得干净、衬衫袜子气泡都在。

**二、标题栏**

- `config/site.json`：`site.titleType: "image"` + `site.titleImage: "/brand-logo.png"`；
  设为 `"text"` 时回落到纯文字站名（`site.config.ts` 的默认值也同步成 image）。
- 品牌图**代替站名**，外面包 `<a href="/">` 回首页，**左侧头像删掉**（`USER.avatar` 不再出现在导航里）。
- `--nav-height: 4.5rem`，logo `3.5rem` 高（≈104px 宽）、`nav-bar` padding `0.5rem 1rem` —— 高度正好由 logo 撑起。
- 加宽：新增 token `--nav-width: 86rem`（正文 80rem），`.nav-bar` 用它，胶囊比正文宽一点点。
- `[data-theme-type='dark']` 下给 logo 加一层极淡白色外发光：描边是深酒红，深色底上否则会糊掉。
- `lang`/`aria-label` 走 `SITE.title`，图片 `alt` 也用站名（屏幕阅读器不会因为「没文字」而丢名字）。

**三、右侧下拉：平滑 + 互斥（`src/scripts/popover.ts`，新增）**

原来每个下拉各自绑一套 document 监听、靠 `hidden` 属性硬切，于是「点开一个另一个还开着」、
换页后旧节点上的监听还挂着。现在集中成一个模块：

| 需求 | 做法 |
|---|---|
| 平滑开合 | 收起态 = `opacity:0 / visibility:hidden / translateY(-6px) scale(.97) / pointer-events:none`，展开加 `.is-open` → 过渡 `160–260ms`（`--dur-fast/base` + `--ease-soft`）。`hidden` 只在「JS 还没跑起来」那一下挡住，绑上后立刻 `menu.hidden = false` 交给 CSS |
| 一次只开一个 | `openPanel()` 里先 `closePanels(menu)`；账号菜单（`.auth-menu`）也接入同一套，所以「配色 / Banner / 账号 / 汉堡」四选一 |
| 点空白 / Esc 收起 | 模块内 document 级监听，全站只绑一次 |
| 反馈 | 触发器 `[aria-expanded='true']` 时按钮变主色浅底 |

> `visibility` 也参与过渡的副作用正好有用：收起态不会被 Tab 聚焦，不会出现「看不见却能 tab 进去」。

**四、写作入口**

- 「写文章」从侧栏「站长工具」卡里删掉（那里只留站点配置 / 统计），挪到顶部导航
  **「文章」紧后面**（写作 / `/write/`，`material-symbols:edit-note-rounded`）。
- 桌面（`DesktopNav`）和移动端汉堡面板（`MobileNav`）都在「文章」之后插入，写法一致：
  `SITE_MENU` 找到 `id === 'blog'` 的位置 splice 一条 `adminOnly: true` 的条目，
  渲染成 `data-admin-link + hidden`，由 `BaseLayout` 的站长脚本决定显隐（访客看不到）。

**五、验证**

- `npm run build` 通过；`/ /about/ /search/ /posts/hello-world/ /categories/ /tags/ /archive/ /project/` 均 200
- 真实点击验证：配色 → Banner 面板自动收起；再点配色 → 收起；账号菜单与其它三个互斥
- ClientRouter 客户端跳转（首页 → 项目）后：品牌图在、写作入口在、下拉重新绑定且仍互斥
- 1440 / 1920 / 390 宽三档截图核对 logo 清晰度与胶囊比例

**六、文章卡边框归一**

第 6 轮给 `.post-tile` 单独加过「12% 文字色描边 + 底色混 5% 文字色」，本意是让文章卡轮廓比页面跳一点，
结果它和快捷入口卡 / 侧栏卡不是同一套卡了。现在改成：

- `.post-tile { border: 0 }`，底色不再覆盖 —— 完全跟随 `.card-neu`（`bg-base-100`、无边框、`shadow-neu-out`）；
- hover 时用 **`inset 0 0 0 1px` 的 box-shadow** 画那 1px 轮廓（不是 `border`）：
  `border` 会让盒子多出 2px，鼠标扫过列表时整页会跟着抖；`box-shadow` 不参与布局。
- 实测 `getBoundingClientRect()` 悬停前后完全一致（896×264），静止态与 `.quick-card` 的计算样式逐项相同。

### 10.13 Banner：随机首图 + 标语库

**一、首图随机（静态站也能做到「每次进来不一样」）**

静态站没有请求级的服务端随机，所以掷骰子放在 **`<head>` 的 inline 脚本**里，在第一次绘制之前完成：

1. `BaseLayout.astro` 里 `define:vars={{ bannerImages: BANNER.images }}` 的内联脚本：
   - 从图里随机挑一张下标，写进 `<html style="--banner-start: url(...)">`；
   - 结果同时存进 `window.__bannerStartIndex`，`banner.ts` 读它从这张继续往下轮播
     （否则首图随机、第二张却固定是 2 号图，顺序就乱了）；
   - `sessionStorage['banner-last']` 记住上一次用的下标，**这一次把它从候选里剔掉** ——
     刷新不会连着两次撞同一张（图≥2 张时）。
2. `Banner.astro` 第一层：`style="background-image: var(--banner-start, url(第一张))"`。
   变量在 `<head>` 里已经设好，所以**首帧就是随机那张**，不会「先显示 1 号图再淡到另一张」；
   禁 JS 时回落到第一张，不会白着。
3. `ClientRouter` 换页会把 `<html style>` 一起换掉，`banner.ts` 初始化时再补写一次变量，
   所以「首页 → 文章页」之后首图还是同一张，不会跳。

**二、标语库（`config/site.json` → `pages.home.typewriter`）**

```
Hello World
欢迎来到我的博客
Ciallo～(∠・ω<)⌒★
📚 纸上得来终觉浅，绝知此事要躬行！
🌸 欲买桂花同载酒，终不似，少年游！
🌸 花有重开日，人无再少年！
🌿 记录生活的点滴，分享美好的瞬间！
```

想只留新加的四句，把数组前三项删掉即可（`/config` 或直接改 JSON）。

> **打字机必须按码点切分**：`📚🌸🌿` 是代理对，占两个 UTF-16 code unit。
> 原来用 `line.slice(0, n)`，打到第一个字符时会切出半个 emoji，屏幕上闪一个 `�`。
> 改成 `Array.from(line)` 再 `slice(0, n).join('')`，emoji 一次整体出现。
> 实测 42 秒、101 个取样状态，`textContent` 里 `U+FFFD` 出现 **0 次**；删字方向同样干净。

### 10.14 Banner 图片：全自动流水线 + 比例自适应

**一、`scripts/prep-banner.mjs`（`npm run gen:banner`，可重复跑）**

原始图只需丢进 `uploads/banner-src/`（`.gitignore` 里，不进仓库），脚本全程自动、不用手填坐标：

| 步骤 | 做法 | 为什么 |
|---|---|---|
| 去黑边 | `trim({ threshold: 12 })` | 动画截图常带 1–3px 纯色边，直接缩放会留一条黑线 |
| 取景 | `resize({ fit:'cover', position:'attention' })` | 竖图硬裁 16:9 容易切掉脸；`attention` 会自动挑「细节/对比最强」的窗口，不用人量 |
| 尺寸 | 统一 1920×1080 渐进式 JPEG q82 + mozjpeg，每张 ≤400KB | 桌面 Retina 够用；放大的图补一刀 `sharpen` 抵消糊感 |
| 命名 | 输出统一 `banner-*.jpg` | `banner.images` 里一眼看出是横幅素材 |

预览图 `.playwright-mcp/banner-preview.jpg`：左列按桌面 2.28:1、右列按手机 1.16:1 各裁一刀，
用来确认「两种屏幕上人物都在画面里」。

**二、比例自适应（`banner.fit: "adapt"`，默认）**

横幅高度不再写死 70vh，而是**跟着图片比例走**：

```css
.banner[data-fit='adapt'] {
  height: auto;
  aspect-ratio: var(--banner-ratio, 16 / 9);  /* 来自 config/site.json → banner.ratio */
  min-height: 18rem;                           /* 手机兜底，别矮到看不见 */
  max-height: 88vh;                            /* 矮屏兜底，别占满整屏 */
}
```

- 宽多少、高多少 → 16:9 的图在 16:9 的框里**一个像素都不裁**，也不会变形；
- 换屏宽 / 换图都不跳（所有素材都被流水线统一成 16:9）；
- 想回到老的固定高度：`banner.fit` 改 `"cover"`，此时用 `banner.height`（默认 70vh）；
- `fullscreen / hidden / background` 三档模式仍然覆盖它 —— 那条 `aspect-ratio` 规则
  特意写在文件靠前的位置，靠「同优先级、后者胜出」让模式规则盖回来。
  **但只写 `height` 是不够的**：`min-height` / `max-height` 不是 `height` 的一部分，
  它们继续生效，`100svh` 会被 `max-height: 88svh` 夹住 —— 详见 §10.15 第二条（已修）。

实测（1600×1000 / 390×844）：

| 模式 | 横幅高度 |
|---|---|
| default（adapt） | 1441×800（≈16:9）／ 341×288（min-height 生效） |
| fullscreen | 视口高 |
| hidden | 0（`display:none`） |
| background | 视口高（fixed） |

**三、移动端登录入口 + 页脚精简**

- 登录按钮从「汉堡面板里」挪到**导航条最外层**（`MobileNav` 直接放 `<AuthChip />`，顺序：品牌图 → 登录 → 明暗 → 汉堡）。
  `AuthChip` 因此要支持同页多实例（桌面导航一个、移动导航一个）：
  `initChip` 改成遍历所有 `[data-auth-chip]`，各自绑一套（`dataset.bound` 保证不重复）。
  窄屏（≤430px）只留 GitHub 图标（`.auth-login__text` 由 CSS 隐藏），按钮本身有 `aria-label="GitHub 登录"`。
- 页脚删掉最底那行「· 设计基于 RyuChan（继自 Frosti）· 评论由 Giscus 提供」，页脚只留站点名
  （署名本来就在 About 页，MIT 要求仍满足）；
  右侧按钮组里的 **RSS / 站点地图两个图标也删掉**（`<head>` 里的 `rel="alternate"` 与 `rel="sitemap"`
  保留，订阅与搜索引擎发现不受影响）。

> 顺手记一个坑：`git checkout` / `git merge` 在 `npm run dev` 运行时大改工作区，
> 会把 dev 的模块图和数据缓存搞坏，表现为「文章封面突然全变成占位字母」。
> 代码本身没问题（生产构建是对的），清掉 `.astro/` 与 `node_modules/.vite/` 再起 dev 即可恢复。


### 10.15 第 8 轮：明暗波纹过渡 / Banner 全屏 / 导航鼠标召唤

**一、明暗切换的波纹扩散（`scripts/theme-wave.ts` + `styles/theme-wave.css`）**

点太阳 / 月亮按钮换明暗时，新配色从按钮（波源）像水波一样摊满整屏：波前推到哪，哪就是新配色。

```ts
const t = document.startViewTransition(() => setTheme(next)); // 改主题，浏览器拍两张快照
await t.ready;
document.documentElement.animate(
  { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
  { duration: 700, easing: 'cubic-bezier(.4,.25,.55,1)', fill: 'forwards',
    pseudoElement: '::view-transition-new(root)' },
);
```

| 细节 | 做法 |
|---|---|
| 波源 | 点击坐标；键盘回车时 `clientX/Y` 是 0，退到按钮中心，并夹进视口 |
| 半径 | 波源到视口四角的最远距离（`hypot(max(x, vw-x), max(y, vh-y))`），扩到它就一定盖满 |
| 缓动 | 近乎匀速、两头略软 —— 用纯 `ease-out` 开头一冲就把屏幕盖完，后半段只剩停着等 |
| 关掉默认动画 | `html.theme-wave::view-transition-old/new(root){animation:none}`；**必须带 `.theme-wave` 作用域**，`ClientRouter` 换页用的是同一套伪元素，不加作用域会把换页动画一起干掉 |
| 初始值 | 新快照 CSS 里先 `clip-path: circle(0)`，否则「ready → 动画开始」那一两帧会闪整屏新配色 |
| 降级 | 不支持 `startViewTransition` / `prefers-reduced-motion: reduce` / 上一波没播完 → 直接切 |
| 配色小圆点 | 不播波纹：点完弹层要收起，快照会把正在淡出的面板冻在原处 0.5 秒 |

调节奏改 `theme-wave.ts` 顶部的 `WAVE_DURATION` / `WAVE_EASING`。

**二、Banner「全屏」点了没反应（已修）**

§10.14 那条 `banner.fit = "adapt"` 规则除 `height: auto` 外还带了 `aspect-ratio` / `min-height` / `max-height: 88svh`。
模式规则只覆盖了 `height`，**`max-height` 不是 `height` 的一部分，照样夹人**：
1280×727 的窗口里「默认」和「全屏」实测都是 640px —— 点了等于没点。
`background`（fixed + `inset: 0`）同样被夹，底部会留一条没铺到图的缝（背景模式下 body 是透明的）。

```css
[data-banner-mode='fullscreen'] .banner,
[data-banner-mode='background'] .banner {
  height: 100svh;
  aspect-ratio: auto;
  min-height: 0;
  max-height: none;
}
```

修好后「全屏」= 正好一屏：滚到最上面时视野里只有横幅图和它底部的四层波浪，正文整块落在折线以下
（实测 `banner.bottom = main.top = innerHeight`，`elementFromPoint` 在视口最底部仍落在 `.banner` 里）。

**三、导航：滚动隐现 + 鼠标召唤（`scripts/nav.ts`）**

`nav.ts` 之前**没有被任何组件 import**，滚动隐现其实一直没生效；现在由 `BaseLayout` 引入
（作用在 `.nav-shell` 上，所以放在布局而不是 `DesktopNav`）。

分界线是 Banner 里那行大标题（`.banner__title`，即「MelodyZzX's Blog」）的**下边缘**，
`max(标题下边缘, 110px)` 叫「常驻线」：

| 指针 / 滚动 | 行为 |
|---|---|
| 指针在常驻线**之上**（标题上方，含页面顶部那条带子） | 常驻：不收起，也不被滚动收起 |
| 指针滑过标题、落到它下面（横幅、正文都算） | 让位收起 |
| 再往上回到常驻线之上 | 立刻唤回 |
| 向下滚且累计位移 > 80px（指针不在常驻线之上时） | 收起（`MIN_DELTA` 5px 以下的抖动忽略） |
| 一往上滚 | 立刻恢复 |
| 标题被滚出视口 | 常驻线不会低于 110px，退化成「贴到页面顶部才唤回」 |

三种例外不收起：指针压在导航胶囊 / 它展开的面板上、有下拉面板开着、键盘 Tab 进了导航。
最后那条只认「键盘送进来的焦点」—— 鼠标点按钮也会让按钮拿到焦点，若也锁住，点过一次导航就再也不让位了。
触屏（`pointerType === 'touch'`）不参与鼠标那套，只看滚动。
滚动、缩放时同样要重算：指针不动而标题 / 横幅在移，只看 `pointermove` 会留下过时的判断。


---

## 11. 署名

视觉与交互参照 [RyuChan](https://github.com/kobaridev/RyuChan)（MIT），其设计源流为 [Frosti](https://github.com/EveSunMaple/Frosti)。按 MIT 协议，页脚与 README 保留出处说明：

> Design based on RyuChan by kobaridev, which is based on Frosti by EveSunMaple.

**文章封面图来源（全部 CC0 / 公共领域，无水印，可商用、无需署名，此处仅作记录）：**

| 文件 | 内容 | 作者 | 来源 |
|---|---|---|---|
| `public/covers/post-meadow.jpg` | 晨雾草甸与山（Green Grass） | Lili Popper | StockSnap <https://stocksnap.io/photo/green-grass-T1VA15FJXL> |
| `public/covers/post-lake.jpg` | 山谷湖泊倒影（Lake Lakdeside） | eberhard grossgasteiger | StockSnap <https://stocksnap.io/photo/lake-lakdeside-WFJLWXPXYP> |
| `public/covers/post-interior.jpg` | 暖光咖啡馆内景（Restaurant Bar） | Afta Putta Gunawan | StockSnap <https://stocksnap.io/photo/restaurant-bar-THXU08ODDE> |

> 检索途径：[Openverse 公开 API](https://api.openverse.org/v1/images/)（筛选 `license=cc0` + `size=large`），
> 从 ~50 张候选里挑的这三张。
> 处理：原图（数千像素）居中裁成 4:3 → 1200×900 → JPEG q76~82，单张 158~191KB。
> 换图时保持同样的比例和体积即可，卡片/文章页都靠 `object-cover` 自适应。

---

## 12. 本地开发与发布约定（重要）

### 12.1 开发方式

| 项 | 约定 |
|---|---|
| 开发环境 | 全程本地：`npm run dev` → <http://localhost:4321> |
| 推送 | 改造期已结束，现在可以照常 `git push`（`main` 会触发 EdgeOne 自动构建）；详见 §12.3 / §12.4 |
| 分支 | 改造用的是 `redesign`（已合入 `main`，远端保留作备份） |
| 需要看搜索效果 | `npm run build && npm run preview`（`dev` 模式没有 Pagefind 索引，属正常现象） |
| 需要看真实构建 | `npm run build`，检查产物 `dist/` 与构建报错 |
| 登录 / 点赞本地可用性 | Worker 的 `ALLOWED_ORIGINS` 已包含 `http://localhost:4321`，无需改动；`/write`、`/config`、相册编辑用同一套授权，令牌只存本机 localStorage |
| 上线时机 | 每轮改完 → `npm run build` 通过 → commit → push `main`（EdgeOne 约 1–3 分钟生效） |

### 12.2 每阶段的标准动作

```bash
# 1. 确保依赖最新
npm install

# 2. 本地起服务，手测本阶段验收项
npm run dev

# 3. 构建验证（必须通过）
npm run build

# 4. 提交（并推送，EdgeOne 会自动构建上线）
git add -A
git commit -m "feat(redesign): P<n> <阶段名>"
git push origin main
```

### 12.3 线上状态（2026-10-19 已上线）

- **改造期已结束**：`redesign` 分支以 fast-forward 合入 `main` 并 push，EdgeOne 自动构建完成，
  线上 `melodyxz.top` 已经是新版设计（push 后约 2 分钟生效）。
- 同时把 Cloudflare Worker（`worker/`）重新 deploy 了一次 —— 线上的 `auth.melodyxz.top`
  是旧版本，没有 `/api/site`，导致侧栏「总阅读/总点赞」一直 `—`、控制台 404。
- 上线后实测：

| 检查 | 结果 |
|---|---|
| `main` 上的提交 | `600e0cd`（= redesign 最新） |
| 全部路由 | `/ /about/ /about/edit/ /posts/… /search/ /categories/ /tags/ /archive/ /navigation/ /album/ /photo-wall/ /project/ /write/ /config/ /stats/` 均 200 |
| 静态资源 | `/brand-logo.png`、`/banner/banner-*.jpg`、`/search-index.json`、`/sitemap-index.xml`、`/rss.xml`、`/robots.txt` 均 200 |
| Worker | `/api/site` → `{ok:true,views:19,likes:2}`；`/api/meta` 200；`/api/stats` 401（未登录，符合预期） |
| 首页控制台 | 0 error（上线前有两条 `auth.melodyxz.top/api/site 404`） |

> `redesign` 分支保留在远端作备份（`origin/redesign`），以后可以删。

### 12.4 以后改东西的发布流程

```bash
git checkout main          # 或者继续用 dry 分支开发
npm run dev                # 本地验证
npm run build              # 必须通过
git add -A && git commit -m "…"
git push origin main       # → EdgeOne 自动构建上线（约 1–3 分钟）
```

只有改了 `worker/` 才需要另外跑一次 `npm run deploy:worker`（本机 `npx wrangler` 已登录，
`GH_CLIENT_SECRET` 存在 Cloudflare 上，不必重新设置）。

