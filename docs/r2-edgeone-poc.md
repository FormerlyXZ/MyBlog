# R2 图床 × EdgeOne 回源 —— 可行性验证（POC）方案

> 目标：在**不动线上博客、不改任何正文**的前提下，验证「EdgeOne 加速域名 → 回源 Cloudflare R2」能不能用、有多快。
> 通过标准全部满足后，再决定是否接入 `/write` 编辑器、是否搬 243MB 音乐。

## ⚠️ 前置问题（与图床无关，但优先级更高）

实测（2026-11-13，中国移动家宽）：

| 域名 | DNS | 落地 | TCP 建连 | 单图吞吐 |
|---|---|---|---|---|
| `www.melodyxz.top` | CNAME → `www.melodyxz.top.pages.dnsoe5.com` → `36.150.72.68` | **国内节点（移动）** | 396ms | **1.18 MB/s** ✅ |
| `melodyxz.top`（裸域） | A → `43.174.246.67 / 43.174.247.67` | **新加坡 anycast（AS139341）** | 509ms | **4.5 KB/s** ❌ |

裸域没有 CNAME、拿不到国内节点，而 `astro.config.mjs` 的 `SITE_URL` 用的正是裸域 → **大多数访客走的是慢的那条路**。

修法（推荐 A）：
- **A. Cloudflare 给裸域加 CNAME 展平** → 目标 `www.melodyxz.top.pages.dnsoe5.com`，**灰云（仅 DNS）**。CF 会把 CNAME 展平成目标 A 记录，解析结果应变成 `36.150.x`。
- B. 裸域 301 → `www`，同时把 `SITE_URL`、sitemap、RSS、canonical 全改成 `www`（有 SEO 迁移成本）。

验证：`Resolve-DnsName melodyxz.top -Server 223.5.5.5` 应返回 `36.150.x`，且单图速度从 4.5 KB/s 变成 ~1 MB/s。

---

## 一、先定一个关键决策（避免踩死坑）

**R2 桶不要绑自定义域名。**

原因：同一个 `img.melodyxz.top` 只能有一条 CNAME。
- R2 自定义域名要求你 CNAME 到 R2（且强制走 Cloudflare 代理）；
- EdgeOne 加速域名要求你 CNAME 到 EdgeOne 的节点域名。

两者二选一。我们选 EdgeOne，理由：

| | R2 自定义域名 | EdgeOne 回源 R2 |
|---|---|---|
| 国内首字节 | Cloudflare 海外/港新节点，200–400ms 抖动 | EdgeOne 国内节点，命中缓存后与主站同级 |
| 缓存 | CF Cache（可开 Smart Tiered Cache） | EdgeOne 缓存规则 + 回源 |
| 防盗链 / 访问控制 | WAF / Referer 规则 | 访问控制（Referer / IP / UA） |
| 私有桶 | 需 WAF Token 等绕 | **原生支持对象存储源站 + V4 签名回源，桶可以完全私有** |
| 成本 | 0 | 免费套餐流量不限量 |

所以：**R2 桶保持私有、不绑域名、不开 r2.dev**，只对 EdgeOne 开放 S3 只读凭据。

```
访客 ──> https://img.melodyxz.top (EdgeOne 国内节点)
              │  未命中
              └──> S3 V4 签名 ──> <bucket>.<accountId>.r2.cloudflarestorage.com
```

---

## 二、验证步骤

### 步骤 0：准备一个测试对象（你，2 分钟）

在 CF 控制台 R2 → 你的桶 → 上传一个文件，路径建议 `poc/hello.jpg`（随便找张小图，或 `public/images/` 里任意一张）。

先记录三个值，别的都不要开：

- **Account ID**：R2 概览页右侧
- **桶名**
- **S3 endpoint**：`https://<accountId>.r2.cloudflarestorage.com/<bucket>`

### 步骤 1：创建 R2 API Token（你，1 分钟）

R2 → 管理 API 令牌 → 创建令牌：

- 权限：**Object Read only**（先只读，够验证回源；要联调上传再加 Read & Write）
- 限定：只作用于你这一个桶
- 记录 `Access Key ID` / `Secret Access Key`（Secret 只显示一次）

### 步骤 2：把站点接进 EdgeOne（你，5 分钟）

EdgeOne 控制台 → 站点列表 → **添加站点**：

1. 站点名称填 `melodyxz.top`，套餐选**免费版**
2. 按提示做域名归属验证（一般给一条 TXT，去 Cloudflare 加，**类型 TXT、灰云即可**）
3. ⚠️ 验证完成后**不要改**主域名 `melodyxz.top` 的现有解析——主站继续由 EdgeOne Makers 服务，我们只加子域

> 免费版：1 个主站点 / 200 个子域名 / 流量不限量，够用。

### 步骤 3：添加加速域名 + 对象存储源站（你，5 分钟）

站点 → **域名管理 → 添加域名**：

- 加速域名：`img.melodyxz.top`
- 加速区域：**中国大陆**（你已备案，可以开；若提示需实名/备案核验，按提示走）
- 源站类型：**对象存储** → **S3 兼容**
- 源站地址：`<bucket>.<accountId>.r2.cloudflarestorage.com`
  （注意：是「桶名.AccountID.r2.cloudflarestorage.com」的裸域名，**不带 https://、不带 /bucket 路径**）
- 私有访问授权：**开启**
  - Access Key ID / Secret Access Key：填步骤 1 的 R2 Token
  - 鉴权版本：**V4**
  - 地域（Region）：**auto**
- 回源协议：HTTPS

然后 EdgeOne 会给出一条 CNAME（形如 `img.melodyxz.top.eo.dnse1.com`），去 Cloudflare 建 CNAME：

- 名称 `img`，目标填 EdgeOne 给的值
- 代理状态：**必须「仅 DNS」（灰云）** —— 橙云会让 CF 接管 TLS，EdgeOne 签不出证书（你 README 里已经记过这个坑）

### 步骤 4：缓存规则（你，2 分钟）

站点 → 规则引擎 / 缓存配置：

- 匹配 `img.melodyxz.top` 的 `/images/*` 与 `/poc/*`
- 边缘缓存 TTL：**30 天**（文件名带时间戳/哈希，内容不会变）
- 忽略查询参数缓存：开（除非以后用 URL 参数做尺寸变体）
- 智能压缩：开（文本类才有意义，图片无影响）

### 步骤 5：验收（你跑测速，我验响应头）

**我能验证的（响应头 + 状态码）**：

```bash
curl -sSI https://img.melodyxz.top/poc/hello.jpg
```

期望看到：

| 头 | 期望 | 含义 |
|---|---|---|
| `Server` / `EO-Cache-Status` | 首次 `Miss`，再请求变 `Hit` | 回源成功 + 缓存生效 |
| `Content-Type` | `image/jpeg` | 回源拿到的元数据正确 |
| 状态码 | `200` | 签名回源通过（`403` = AK/SK 或 V4/Region 配错） |
| `Cache-Control` | 你设的 TTL | 缓存策略生效 |

**Range 请求（音乐拖动进度条的前提）**：

```bash
curl -sS -o NUL -D - -r 1000000-1000100 https://img.melodyxz.top/poc/hello.jpg
```

期望 `206 Partial Content` + `Content-Range`。

**你来做（我这边网络走代理，测速不可信）**：

1. [itdog.cn](https://www.itdog.cn/) 或用 EdgeOne 自带测速，分别测 `melodyxz.top`（基线）和 `img.melodyxz.top`
2. 上传一首 ~5MB 的 m4a 到 `poc/`，手机 4G 实测：**首字节时间** 与 **拖动进度条是否秒开**
3. 记录边缘缓存命中率（EdgeOne 报表，取 24h）

### 步骤 6：判定

| 指标 | 合格线 | 不合格怎么办 |
|---|---|---|
| 图片 TTFB（国内，缓存命中） | < 150ms | 检查是否真的灰云、加速区域是否「中国大陆」 |
| 单张 ~100KB 图完整加载 | < 0.5s | 同上 |
| 音频首字节 | < 300ms | 可接受范围内即可 |
| 音频持续速率 | ≥ 1 MB/s 最佳；**若触到社区反馈的 ~512 KB/s 单连接限速** | 一首 5MB 约 10s 缓冲完，**听歌可接受**，视频则放弃自托管 |
| 缓存命中率 | > 90% | 检查缓存规则匹配路径 |

---

## 三、通过后我这边要改的东西（还没动）

只有步骤 6 全绿才开始，改动清单：

1. `worker/wrangler.toml`：加 `[[r2_buckets]] binding = "R2_IMAGES"`（或改用 presigned URL 直传，不占 Worker 流量）
2. `worker/src/index.js`：加 `/api/upload`（校验现有 `OWNER_LOGINS` 登录态）+ 可选 `/api/sign` 签发 presigned PUT
3. `src/scripts/write.ts`（约 846 行 `public/images/${Date.now()}-...` 那段）+ `src/scripts/moments-admin.ts`（`IMAGE_DIR`）：改成上传到 R2、回填绝对 URL
4. 相册页 / 动态页的图片路径识别：`/images/xxx` 与 `https://img.melodyxz.top/xxx` 两种都要能渲染
5. `.gitignore` 补 `worker/.dev.vars`（本地放密钥，别进仓库）
6. 文档：`README.md` 第 11.7 节「图片与 PDF（图床）」重写

**存量 236 张图先不动**：正文里是 `/images/xxx` 站内路径，主站继续提供，零风险。等新链路稳定、且你确认要瘦身时，再考虑「存量迁移 + 301/URL 重写」或直接不管。

---

## 四、需要你提供的东西（最小权限）

| 用途 | 需要什么 | 权限边界 |
|---|---|---|
| 验证回源签名是否正确 | R2 API Token（**Object Read only**）+ Account ID + 桶名 | 只读、限定单桶、验证完可立刻吊销 |
| 联调上传（步骤 6 通过后） | 同上改为 **Read & Write** | 仍限定单桶 |
| 我帮你核对 EdgeOne 配置 | 腾讯云**子账号** SecretId/SecretKey + `QcloudTEOReadOnlyAccess` | 只读，**不要给主账号** |

不建议给控制台密码；给了也请验证完就改密。

---

## 五、风险与回滚

- **回滚成本极低**：验证阶段线上没有任何改动，删掉 EdgeOne 里的 `img` 子域 + Cloudflare 的 CNAME 即可，主站不受影响。
- **注意别动**：`melodyxz.top` 主域解析（Makers 在用）、`auth.melodyxz.top`（Worker 在用）。
- **免费套餐口径**：EdgeOne 免费版「不限量流量 + 1 主站点 + 200 子域名」；R2 免费 10GB 存储 / 100 万次写 / 1000 万次读每月，出站免费。
- **r2.dev 一律不开**（官方明确有变动限速、仅供测试）。

---

## 六、照片墙场景的专项验收（关键）

单张图快 ≠ 相册快。相册是**高并发小文件**场景，必须测**聚合吞吐**，因为浏览器会用 1–2 条 HTTP/2 连接并发拉所有图。

### 基准（已实测，EdgeOne 国内节点 = www）

12 张图共 1649 KB，并发 12 路：**总耗时 0.99s → 聚合吞吐 1664 KB/s**

### 回源域名要跑同样的测试

```bash
# 把 12 个真实图片 URL 换进去
curl.exe --parallel --parallel-max 12 -sS -o NUL \
  -w "%{http_code} t=%{time_total}s v=%{speed_download}B/s\n" \
  --url "https://picture.melodyxz.top/albums/a1.webp" \
  --url "https://picture.melodyxz.top/albums/a2.webp" \
  ...（共 12 条）
```

**判定门槛：**

| 聚合吞吐 | 结论 | 行动 |
|---|---|---|
| ≥ 1200 KB/s | 与主站同级 | ✅ 相册图全放 R2 |
| 800–1200 KB/s | 略慢但可接受 | ✅ 全放 R2 + 缩略图分级 |
| < 800 KB/s | 有单连接限速嫌疑 | ⚠️ 改**混合方案**：缩略图同源、原图 R2 |
| < 400 KB/s | 不可用 | ❌ 放弃回源，换国内对象存储或回仓库 |

> 风险点：社区反馈 EdgeOne 存在约 512 KB/s 的单连接限速。若限速是**按 TCP 连接**计的，HTTP/2 下 60 张图共用 1 条连接 → 整页被封顶在 512 KB/s。这个测试就是专门验它的。

### 混合方案（回源不达标时的退路）

- **缩略图（~400px，15–25KB）→ 直接进仓库同源**，一册 60 张只增加约 1.2 MB
- **原图（~1600px，150–300KB）→ R2**，点击灯箱时才加载
- 效果：首屏 1.2MB 走国内节点 ≈ 0.8s；原图偶尔慢 1–3s 用户能忍；仓库增长只有原来的 1/10

对比全 R2：两者都可行，取决于上面那张表的实测结果。
