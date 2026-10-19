---
title: 把这个博客部署上线（不用买服务器）
description: 从本地到公网：推 GitHub、接静态托管、绑自己的域名、开 HTTPS，全程零成本。
date: 2026-10-17
image: /covers/post-lake.jpg
categories: [教程]
tags: [教程, 部署]
---

这篇文章把上线流程从头到尾走一遍。**全程不需要买服务器，也不需要备案**（前提是托管选择中国大陆境外的节点）。

## 先确认一件事：你要不要备案

只取决于一个问题：**网站内容从中国大陆境内的服务器/节点对外提供吗？**

| 托管方式 | 是否需要 ICP 备案 |
| --- | --- |
| Cloudflare Pages | 不需要 |
| EdgeOne Pages（全球可用区，不含中国大陆） | 不需要 |
| EdgeOne Pages（中国大陆可用区） | **需要** |
| 腾讯云轻量应用服务器 / CVM（大陆机房） | **需要** |

刚开始写博客，建议先不备案，用免费托管跑起来。等确实需要极致速度，再考虑备案后切到大陆节点。

> 注意：域名在腾讯云买，**不等于**要备案。腾讯云在这里只是"卖域名的"，备案只跟网站放在哪里有关。
>
> 但域名本身要做**实名认证**，买到后 5 天内没实名会被停机（serverHold）。

## 第一步：把代码推到 GitHub

```bash
git init
git add .
git commit -m "初始化博客"
git branch -M main
git remote add origin https://github.com/你的用户名/myblog.git
git push -u origin main
```

没有仓库的话先去 GitHub 新建一个，**空仓库**就行，不要勾选自动生成 README。

## 第二步：接静态托管

### 方案 A：EdgeOne Pages（腾讯云，推荐国内读者）

1. 打开 [EdgeOne Pages 控制台](https://edgeone.cloud.tencent.com/pages)，用腾讯云账号登录
2. 一键开通免费版（长期免费，网页加速流量不限量）
3. 新建项目 → 导入 Git 仓库 → 授权 GitHub → 选中刚推的仓库
4. 构建配置（一般能自动识别，识别错就手动填）：

   | 配置项 | 值 |
   | --- | --- |
   | 框架预设 | Astro |
   | 构建命令 | `npm run build` |
   | 输出目录 | `dist` |

5. 加速区域选 **全球可用区（不含中国大陆）** → 不用备案
6. 点部署，等一两分钟

### 方案 B：Cloudflare Pages

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → Create → Pages → Connect to Git
2. 选仓库，构建命令 `npm run build`，输出目录 `dist`
3. 部署完成后会给你一个 `xxx.pages.dev` 的域名

## 第三步：绑定你自己的域名

两个平台的操作逻辑一样：**在托管后台添加域名 → 拿到 CNAME 目标 → 去域名商加解析记录**。

以腾讯云买的域名为例：

1. 托管后台 → 域名管理 → 添加自定义域名，填 `example.com`（或 `www.example.com`）
2. 平台会给你一个 CNAME 目标值，形如 `xxx.example.pages.dev` 或 `xxx.edgeone.app`
3. 打开腾讯云 → **DNS 解析 DNSPod** → 你的域名 → 添加记录：

   | 主机记录 | 类型 | 记录值 |
   | --- | --- | --- |
   | `@` | CNAME | 平台给你的目标值 |
   | `www` | CNAME | 平台给你的目标值 |

4. 保存，等 DNS 生效（通常几分钟，最长 24 小时）
5. 托管平台会自动签发免费 HTTPS 证书，等状态变成"已生效"

## 第四步：改域名配置

打开 `astro.config.mjs`，把这一行改成你的真实域名：

```js
const SITE_URL = 'https://example.com';
```

**这一步不能忘**，因为它决定了 RSS、sitemap 以及分享卡片里的链接。改完推一次代码即可。

## 第五步：日常写作流程

```bash
# 1. 写文章
#    在 src/content/posts/ 新建 xxx.md

# 2. 本地预览
npm run dev

# 3. 发布
git add .
git commit -m "新增文章：xxx"
git push
```

`git push` 之后托管平台会自动构建部署，一般 1 分钟内上线。

## 上线之后可以加的东西

- **评论**：接 [Giscus](https://giscus.app/zh-CN)（用 GitHub Discussions，免费无广告）
- **访问统计**：Umami（自建/免费版）、51LA、百度统计
- **全文搜索**：Pagefind，纯静态、零后端
- **图床**：图片放 `public/` 或 `src/assets/`；图片多就用对象存储

## 常见问题

**国内打开很慢或打不开？**
免费海外托管在国内的访问质量不稳定，不同运营商差异很大。如果主要读者在国内，备案后切到 EdgeOne 的大陆可用区会明显变快。

**改了代码但网站没更新？**
去托管后台看构建日志，通常是构建失败（比如 Markdown 的 frontmatter 写错了），日志里会直接告诉你哪一行。

**域名解析不生效？**
先用 `ping example.com` 看解析到哪，再用在线 DNS 检测工具查全球生效情况。刚加记录时本机缓存可能还没过期。
