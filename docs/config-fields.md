# 站点配置 · 字段字典

`/config/` 设置页界面上的说明文字（改版前约 2963 字）已经全部移出 UI，
集中到这里。界面上只留字段标签本身，所以**标签必须自己能看懂**。

改这个字典的时候顺手改 `src/pages/config/index.astro` 里对应的 JSX 注释，
两处是同一份信息。

---

## 一、站点信息（`config/site.json` → `site.*`）

| 字段 | 路径 | 说明 |
|---|---|---|
| 网站名 | `site.title` | 顶部导航的品牌名（标题栏用「文字站名」模式时显示它）；也会进个人卡、页脚、分享卡片 |
| 标签页标题 | `site.tab` | 浏览器标签页上显示的标题 |
| 站点简介 | `site.description` | SEO 描述，同时用作分享卡片的摘要 |
| 语言代码 | `site.language` | BCP 47 语言标签，写进 `<html lang>`。中文简体是 `zh-CN` |
| 日期格式 | `site.dateFormat` | date-fns 语法，如 `yyyy-MM-dd`、`ddd YYYY年MM月DD日` |
| 显示形式 | `site.titleType` | `image` = 图片 logo，`text` = 文字站名 |
| Logo 图片 | `site.titleImage` | 建议透明底 PNG/SVG，高度 100px 往上更清晰 |
| 站点图标 | `site.favicon` | 浏览器标签上的小图标，SVG 或 32×32 PNG |

## 二、个人资料（`config/site.json` → `user.*`）

| 字段 | 路径 | 说明 |
|---|---|---|
| 头像 | `user.avatar` | 正方形 640×640 以上最好。换头像 = 全站一起换（侧栏个人卡、About 页、动态卡片、页脚署名）。提交后约 1 分钟生效，若还是旧头像就硬刷新（Ctrl / ⌘ + Shift + R）—— 图床缓存是 30 天 immutable |
| 昵称 | `user.name` | About 页的大字、动态卡片昵称、页脚署名、文章许可说明都用它 |
| 签名 | `user.description` | 个人卡上那行渐变彩字 |
| 个人主页 | `user.site` | 个人卡上的链接 |
| 图标链接 | `user.socials` | 个人卡和页脚上的图标，数组顺序就是显示顺序。图标名用 Iconify（`ri:github-line`、`ri:bilibili-line`、`ri:youtube-line` …） |

## 三、横幅 Banner（`config/site.json` → `site.banner.*`）

| 字段 | 路径 | 说明 |
|---|---|---|
| 轮播图片 | `site.banner.images` | 数组顺序 = 轮播顺序。上传时压成 WebP 存图床 `covers/`，不进仓库；建议横图 16:9 或更宽，单张 300KB 以内 |
| 大标题字号 | `site.banner.titleScale` | 倍率，乘在响应式字号上。调小后手机和桌面一起按比例缩，窄屏不会溢出 |
| 打字机字号 | `site.banner.subtitleScale` | 同上；竖屏还会被「最长那句一行放得下」的上限再压一次，所以调大在手机上看不出差别 |
| 循环时间 | `site.banner.interval` | 毫秒。`8000` = 每 8 秒换一张，建议 3000–15000 |
| 高度适配 | `site.banner.fit` | `adapt` = 跟着图片比例不裁切；`cover` = 固定高度并按 cover 裁切 |
| 宽高比 | `site.banner.ratio` | 仅 `adapt` 时生效，如 `16 / 9`、`21 / 9` |
| 固定高度 | `site.banner.height` | 仅 `cover` 时生效，如 `70vh`、`32rem` |
| 黑色遮罩 | `site.banner.overlay` | 0–1。越大文字越清楚、图片越暗 |

## 四、首页文案（`config/site.json` → `pages.home.*`）

| 字段 | 路径 | 说明 |
|---|---|---|
| 大标题 | `pages.home.title` | 首页 Banner 上的主标题 |
| 副标题 | `pages.home.subtitle` | 打字机列表为空时显示这一句 |
| 打字机标语 | `pages.home.typewriter` | 字符串数组，一行一句，逐字打出并循环；留空则只显示副标题 |

## 五、主题外观（`config/site.json` → `site.theme.*`）

| 字段 | 路径 | 说明 |
|---|---|---|
| 浅色主题 | `site.theme.light` | 访客第一次打开站点时，浅色模式下用的主题名 |
| 深色主题 | `site.theme.dark` | 同上，深色模式 |
| 允许访客换配色 | `site.theme.allowSelector` | 关掉后仅保留默认的明暗切换，配色选择器不出现 |
| Banner 显示方式 | `site.theme.bannerMode` | 访客自己切过之后以他的选择为准（存 localStorage） |

## 六、音乐库（`config/music.json`）

| 项 | 说明 |
|---|---|
| 音频 / 封面 | 存图床 `picture.melodyxz.top` 的 `music/` 分类，仓库里只留 `config/music.json`。单曲上限 90MB，实用建议 < 20MB |
| 歌词 | 支持带时间轴的 `.lrc`（`[mm:ss.xx]`），贴文本或上传文件都行；纯文本也能用，只是不跟唱、只滚动 |
| 搬进图床 | 只对还留在仓库里的老文件有用。点一次把 `public/music/` 下的文件全部走 Worker 搬到 R2 并删除原件（服务器之间搬，不占上行带宽）。搬完就没东西可搬了 |
| 保存 | 一次「保存并提交」= 一次 commit，部署完成后音乐页和左下角碟片会自动出现 |

## 七、网站导航（`config/navigation.json`）

| 项 | 说明 |
|---|---|
| 结构 | 分组 → 站点，每个站点有名称、网址、一句介绍、图标 |
| 图标 | 可以填站内路径（`/nav/itdog.ico`）或外链；点「上传图标」会传到 `public/nav/`。图片留空时回落到「图标名」里的 Iconify 名（`ri:github-line`） |
| 保存 | 一次「保存并提交」= 一次 commit，约 1 分钟后导航页生效 |

## 八、JSON 源码

不在可视化板块里的字段（菜单、页脚、评论等）直接在这里改。
「格式化」会重排缩进，「校验格式」只查语法、不提交。
JSON 改对了会实时同步回可视化板块；改错了会拦着不让保存。

---

## 维护约定

1. **界面上不写长说明**。一句放不下的，进这个文件。
2. 需要示例的，用 `placeholder` 表达（`16 / 9`、`70vh`、`yyyy-MM-dd`），不要用灰字。
3. 操作指引（需要步骤的）放 `<details class="cfg-notes">`，默认收起。
4. `ConfigSection` / `ConfigField` / `ConfigImage` 的 `hint` prop 已废弃：
   传了也不渲染，保留只为不惊动调用方。
