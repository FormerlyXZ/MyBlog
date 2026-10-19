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
| 内容最大宽度 | `72rem`（`max-w-blog`），左栏 `20rem`（320px）粘性侧栏，右栏自适应 |
| Banner 高度 | 桌面 `70vh`，移动 `40vh`（可配 `banner.height`） |
| Banner 遮罩 | `rgba(0,0,0,.4)` |
| Banner 轮播 | 8s 切换，600ms 交叉淡入，提前 2s 预加载下一张，`IntersectionObserver` 离屏暂停 |
| 波浪收口 | 同一路径叠 4 层 `<use>`，透明度 `25/50/75/100%`，`25s` 无限平移 `-90px → 85px`，填充色 = 内容区背景 |
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
| 日期格式 | dayjs 风格 `ddd MMM DD YYYY` → 显示成「周六 5月 31 2025」 |
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
│  │  ├─ nav.ts                 ←   滚动隐现
│  │  ├─ toc.ts                 ←   目录高亮
│  │  ├─ theme.ts               ←   主题切换与持久化
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
    "titleType": "text",                // text | image
    "titleImage": "/logo.png",
    "favicon": "/favicon.svg",
    "dateFormat": "YYYY年MM月DD日",
    "banner": {
      "images": ["/banner/1.svg", "/banner/2.svg", "/banner/3.svg", "/banner/4.svg"],
      "interval": 8000,
      "height": "70vh",
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

> **已调整（2026-10-19）**：参考站原始路径在 1440px 宽屏上只露出约 1.7 个浪头，
> 被 `preserveAspectRatio="none"` 横向拉长后看着就是一个大缓坡（"死板"）。
> 现在把 `viewBox` 改成 `0 24 704 28`、路径重复到 **8 段浪头（4 个完整起伏）**，
> 宽屏上每屏约 4 个起伏才看得出"一层层涌过来"；四层透明度改 35/55/80/100、速度 11/15/19/24s。
> 另外**取消了内容区的负 margin（原来 −3rem 把波浪压掉了大半）**，内容直接接在波浪下面。

```html
<svg viewBox="0 24 704 28" preserveAspectRatio="none">
  <defs>
    <!-- 8 段浪头，约 4 个完整起伏 -->
    <path id="gentle-wave"
      d="M-8 44c30 0 58-18 88-18s58 18 88 18 58-18 88-18 58 18 88 18 58-18 88-18 58 18 88 18 58-18 88-18 58 18 88 18 58-18 88-18 58 18 88 18 58-18 88-18 58 18 88 18v44H-8z" />
  </defs>
  <g>
    <use href="#gentle-wave" y="0" style="opacity:.35;animation-delay:-2s;animation-duration:11s" />
    <use href="#gentle-wave" y="3" style="opacity:.55;animation-delay:-3s;animation-duration:15s" />
    <use href="#gentle-wave" y="6" style="opacity:.8;animation-delay:-4s;animation-duration:19s" />
    <use href="#gentle-wave" y="9" style="animation-delay:-5s;animation-duration:24s" />
  </g>
</svg>
```

```css
@keyframes wave {
  0%   { transform: translate3d(-90px, 0, 0); }
  100% { transform: translate3d(85px, 0, 0); }
}
.banner__waves {
  position: absolute; bottom: -1px; left: 0; width: 100%;
  height: clamp(4rem, 13vh, 10rem);
  transform: scaleX(1.04);       /* 左右留余量，平移时不露边 */
  transform-origin: bottom center;
}
.banner__waves use {
  fill: oklch(var(--b2));        /* 与内容区背景同色，才是"过渡"不是"贴片" */
  animation: wave var(--wave-duration) cubic-bezier(.5,.5,.45,.5) infinite;
}
```

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
| `keyframes.wave` + `animation.wave` | `-90px → 85px`，`25s alternate` | §10.1 波浪收口 |
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

---

## 11. 署名

视觉与交互参照 [RyuChan](https://github.com/kobaridev/RyuChan)（MIT），其设计源流为 [Frosti](https://github.com/EveSunMaple/Frosti)。按 MIT 协议，页脚与 README 保留出处说明：

> Design based on RyuChan by kobaridev, which is based on Frosti by EveSunMaple.

---

## 12. 本地开发与发布约定（重要）

### 12.1 开发方式

| 项 | 约定 |
|---|---|
| 开发环境 | 全程本地：`npm run dev` → <http://localhost:4321> |
| 推送 | **不执行 `git push`**，不触发 EdgeOne 自动构建；线上站点在改造期间保持不变 |
| 分支 | 从 `main` 切 `redesign`，每阶段一个 commit |
| 需要看搜索效果 | `npm run build && npm run preview`（`dev` 模式没有 Pagefind 索引，属正常现象） |
| 需要看真实构建 | `npm run build`，检查产物 `dist/` 与构建报错 |
| 登录 / 点赞本地可用性 | Worker 的 `ALLOWED_ORIGINS` 已包含 `http://localhost:4321`，无需改动；`/write`、`/config`、相册编辑用同一套授权，令牌只存本机 localStorage |
| 上线时机 | 全部阶段完成 + §7.2 回归通过后，由你确认再 push |

### 12.2 每阶段的标准动作

```bash
# 1. 确保依赖最新
npm install

# 2. 本地起服务，手测本阶段验收项
npm run dev

# 3. 构建验证（必须通过）
npm run build

# 4. 提交（只 commit，不 push）
git add -A
git commit -m "feat(redesign): P<n> <阶段名>"
```

### 12.3 改造期间的线上状态

- 线上 `melodyxz.top` 停留在当前版本，访客无感知
- 本地改的是整套代码；真正上线是一次性合并（或按你希望的分批上线）
- 若想提前看阶段成果，可用 `npm run build && npm run preview` 在本地端口预览生产构建
