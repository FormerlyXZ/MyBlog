# 照片墙 v3：格点 + 比例吸附（交接文档）

> 状态：**已实现并逐张验收过（2026-11）**。本文件保留为**决策记录**：
> 为什么换方案、数学依据、原始规格都在这里；**现状请看 `docs/album-wall.md`**（那份已按 v3 改写）。
> 实施过程中偏离本文档的地方、实测数据，见第 11 节「实施记录」。

---

## 0. 一句话

把「任意比例 + 连续坐标」换成「**规整比例 + 整数格点**」：缩略图一律裁成菜单里的比例、高度取整数格，放大照也走同一套格点。于是"不重叠 / 不留缝 / 四边齐 / 不越界"从**调参调出来的**变成**构造上成立**。

代价：缩略图被裁成规整比例；收益：现有那 700 行让位推演全部删除。

---

## 1. 现状：为什么要换

### 1.1 引擎现状

- `src/scripts/gallery-wall.ts` —— 1934 行，一个 `GalleryWall` 类包住相机式瀑布墙。
- 初排：`packNormal()` —— 障碍感知打包器（`occ` 每列一个占用区间表，`firstFit` / `occupy` / `clearFrom`），按顺序落"最先放得下"的那列；然后 `alignBottom()` 把各列底边拉到同一条线。
- 聚焦：`packFocus()` —— ① 重跑 `packNormal` 得到基准版面；② 算放大照的列数 `k` 与原比例高度 `heroH`；③ 定 `originCol`（往右长 / 贴右时往左长）；④ 定纵向钉边方式 `down` / `up` / `cover`；⑤ 被压到的每一列跑 `openBand()` 或 `openBandUp()` 做局部让位。
- 局部让位的辅助件：`cropRoom` / `groupColumns` / `columnRoom` / `fitColumn` / `bandSplit` / `bandFitsDown` / `bandFitsUp` / `liftSet` / `nudge` 搜索 / `HARD_CROP=1.6` / `MIN_KEEP=48`。

### 1.2 实测缺陷（1501×962，160 张本地演示数据，逐张点过）

| 缺陷类 | 数量 | 实例 |
| --- | --- | --- |
| 放大照**上沿留缝** | 11 / 80 | `g0036`：带上一张结束于 y=…，带顶下方留 63px；`g0043` 62px、`g0052` 56px、`g0053` 53px、`g0054` 39px …（用户报的 055 属这一类，只是在他的窗口尺寸下才复现） |
| **重叠** | 2 / 80 | `g0096`：`g0113` 被压到 48px（`MIN_KEEP` 下限）仍顶进放大带 **28px**；`g0075`：10px |
| 保底**盖住** | 2 / 80 | `g0070`、`g0077` 走 `cover`，一张盖住 2–6 张 |

### 1.3 根因

所有缺陷都是**边缘没落在格点上**造成的：

1. 放大带的上下沿落在"邻居两张图之间的空隙中部"，无法用整张图去填 → 留 30–63px 缝。
2. 要把邻居压小才能让位，但格子有 `MIN_KEEP=48` 下限、拉伸有 `1.6×` 上限 → 兜不住就顶进带里（重叠）或放弃（`cover`）。
3. 每修一类缺陷就加一条启发式，启发式之间互相打架（`bandFitsDown` / `bandFitsUp` / `cover` 三套判据），所以"修好 A 冒出 B"会无限循环。**换一批随机图必然冒新问题。**

**结论：连续坐标下的"局部让位"本身就没有解，不是调得不够好。**

---

## 2. 新方案：格点模型

### 2.1 三条规则（用户已确认）

1. **比例吸附**：缩略图一律显示成菜单里的一个规整比例（见 2.2），不符合就裁。**只有灯箱回到原比例。**
2. **高度格点化**：每张缩略图的高度取菜单里的整数值；列宽固定；所有格子的上下沿都落在格点上。
3. **放大也用格点**：放大照 = 该图**同一档比例的放大版**（不是原比例），是"整数列 × 整数行"的矩形，因此它只是"占了个大块"的普通格子，不再需要特殊处理。

### 2.2 比例菜单（`columnWidth = 288`、`gap = 8` 时）

| 比例 | 高度 px | 说明 |
| --- | --- | --- |
| 9:16 | 512 | 竖图上限 |
| 2:3 | 432 | |
| 3:4 | 384 | |
| 1:1 | 288 | |
| 4:3 | 216 | |
| 3:2 | 192 | |
| 16:9 | 162 | |
| 2:1 | 144 | |
| 3:1 | 96 | 全景上限 |

补充档（需要时加）：`1:2 = 576`、`1:3 = 864`、`4:5 = 360`。

选档规则：取使 `|log(h_menu / h_原生)|` 最小的一档（即"最接近原比例、但不额外多裁"）。
超出 9:16 ~ 2:1 范围的极端图（长截图、超宽全景）硬压到边界档。

### 2.3 两个"零偏差"（这是换方案的全部理由）

设 `colW = 288`、`gap = 8`：

**定理 1（比例精确）**：菜单里每一档的高度都是整数（512 / 432 / 384 / 288 / 216 / 192 / 162 / 144 / 96），因此**缩略图显示出来的比例就是字面比例，没有浮点误差**。
=> 前提：`columnWidth` 必须是 **144 的倍数**（`144 | 288 | 432`）。`288` 是 3、9、16 的公倍数来源（`lcm(4,3,16,9)=144`）。

**定理 2（对齐精确）**：任一列的格子边缘 = `Σ(h_i + gap)`。`gcd(所有 h_i + gap, gap) = 2`（`520,584,872,440,392,296,224,200,170,152,104` 的最大公约数是 2）。
=> **所有格子的上下沿都是 2px 的整数倍**；放大带只要把上下沿吸附到 2px 格，邻居的裁剪量就必然是 2px 的整数倍，**残差恒为 0**（不会再有 1.3px 那种对不齐）。

（`columnWidth = 144` 时菜单为 256/216/192/144/108/96/81/72/48，`+gap` 的最大公约数是 1 → 吸附到 1px，同样 0 残差。）

### 2.4 放大照尺寸：视口盒子

```
BOX_W = 0.82 * vw        // 宽上限（配置项 focusWidth）
BOX_H = 0.92 * vh        // 高上限（配置项 focusMaxHeight）
```

在盒子内取**最大的整数列方案**。结果由比例决定哪个方向先撞上限：

| 原图比例档 | 放大照（1440×900） | 占屏 |
| --- | --- | --- |
| 9:16 | 497×883（边界列变窄，见 2.5） | 34%×98% |
| 3:4 | 662×883 | 46%×98% |
| 1:1 | 883×883 | 61%×98% |
| 4:3 | 1177×883 | 82%×98% |
| 16:9 | 1181×664 | 82%×74% |
| 2:1 | 1181×590 | 82%×66% |
| 3:1 | 1181×394 | 82%×44% |

即：**竖图近乎占满竖向，横图按比例变矮**（用户确认这是想要的）。参考图那个 3 列 × 3 行的播放器块约占屏 22.6%×45%，上表每一档的面积都是它的 2–6 倍。

> ⚠ 这张表是**原始方案的估算**，实际落地的是「只取整列 + 允许高度溢出」，
> 真实尺寸见 §11.1（9:16 → 584×1038、1:1 → 880×880、16:9 → 1176×661 …）。

### 2.5 边界列变窄（A 方案，用户选 A）—— ⚠ 已废弃，见 §11.1 第 4 条

> **实际实现没有采用这条。** 它能在宽度上做到 1px 精确，但会在放大照两侧各留一条空档
> （9:16 左右各 60px、4:3 各 43px），验收时判定为「照片墙上出现了空缺」，
> 因此改回「整列宽度 + 允许高度略有溢出」（`HERO_OVERFLOW`）。
> 下面是原始推理，留作记录。

放大照宽度必须能精确到 1px，否则竖图只能选"1 列 57%"或"2 列 115%"。

```
targetW = min(BOX_W, BOX_H * aspect)          // 理想宽度
k       = ceil(targetW / pitch)               // 至少 1 列，pitch = colW + gap
lastW   = targetW - (k - 1) * pitch           // 落在 (colW - pitch, colW]
```

- 前 `k-1` 列保持标准列宽，**最后一列变窄**为 `lastW`
- 只影响"带宽"，不影响任何格子高度 → **底边照齐这条不受影响**
- 引擎已支持：`paint()` 里 `scale = rect.w / cell.baseW`，每格本来就允许有自己的宽度；缩略图是 `object-fit: cover` 取景框，宽度变化只是换取景，不变形
- 只在聚焦期间生效，退出放大立刻恢复标准列宽

### 2.6 四条边（用户要求"四个边都不能参差"）

| 边 | 保证 |
| --- | --- |
| 上边 | 每一列都从 `y = 0` 起堆，放大照的带上沿 `≥ 0` |
| 下边 | 每列最后一格"破例"拉到同一条 `line`（见 4.5），残差 0 |
| 左边 | 所有格子 `x = col * pitch ≥ 0` |
| 右边 | 画布宽 `= cols*colW + (cols-1)*gap`，格子不跨出边界；放大带超出时按整列内推 |
| 放大照自身 | 矩形吸附格点 + `clamp` 在 `[0, boardW] × [0, line]` 内 → 不可能越界 |

---

## 3. 数据结构

沿用现有 `Cell`，新增两个字段：

```ts
interface Cell {
  el: HTMLElement;
  id: string;
  aspect: number;      // 原图比例 w/h（保留，给灯箱和"最接近哪一档"用）
  snapped: number;      // 吸附后的比例（菜单档），照片墙上用这个
  nativeH: number;      // 吸附后按本列宽度应有的高度 = colW / snapped
  rect: Rect;           // 当前排版结果（宽高比 = snapped，除末格破例外）
  ...
}
```

菜单常量：

```ts
/** 比例菜单：w/h 的倒数即高度倍数。columnWidth 必须是 144 的倍数 */
const RATIOS = [9 / 16, 2 / 3, 3 / 4, 1, 4 / 3, 3 / 2, 16 / 9, 2 / 1, 3 / 1];

/** 高度吸附到 d 的整数倍，d = gcd(所有 (h+gap))；288/8 → 2，144/8 → 1 */
function snapH(colW: number, gap: number): number { ... }
```

---

## 4. 算法规格

### 4.1 `packGrid(obstacles)` —— 唯一排版函数

初排和聚焦共用同一个函数，区别只是有没有障碍（放大照矩形）。

```
resetOcc()
for cell of visibleCells() (按照片原顺序):
    h = menuHeight(cell)                     // 4.2
    bestCol, bestY = argmin(firstFit(col, h, 0) for col in 0..cols-1)
    occupy(bestCol, bestY, h)
    cell.rect = { x: bestCol*pitch, y: bestY, w: colW, h }
normalizeBottom()                            // 4.5
```

障碍物：把放大照矩形按列 `occupy` 进去（跨 `k` 列，每列占 `[top, top+heroH]`）。因为 `firstFit` 是障碍感知的，**不会有一张照片被放进放大照里** → "盖住"这条路直接消失。

> 若某张图在最小档（96px）都放不进任何空位：说明这一列被障碍占满，`firstFit` 会自然把它排到障碍**下面**，不会冲突。

### 4.2 `menuHeight(cell)`

```
理想 = colW / cell.snapped
取菜单里 ≤ 理想、且与理想最接近的一档
```

聚动态（可选，二期）：如果 `firstFit` 在理想档放不下，就逐档往下试，直到放下为止（菜单深度 96…864，几乎总能放下）——这一步就是取代 `fitColumn` 的"压缩"。

### 4.3 `heroRect(photo)`

```
aspect = snappedAspect(photo)
targetW = min(BOX_W, BOX_H * aspect)
k = ceil(targetW / pitch)  ,  k 不超过 cols
lastW = targetW - (k-1)*pitch
heroW  = (k-1)*pitch + lastW
heroH  = roundToLattice(heroW / aspect, d)
originCol = clamp(floor(idleRect.x / pitch), 0, cols - k)      // 靠边按整列内推
x = originCol * pitch
top = clamp(idleRect.y, 0, max(0, line - heroH))
top = roundToLattice(top, d)                                    // 上下沿都要在格点上
```

- 横向：优先"从自己那一列往右长"，右边放不下就整体左移（**按整列**，不移动零头）
- 纵向：优先"原位往下长"（= 左上角钉住）；`top` 被 `clamp` 时自动变成"往上/往下让一点"，**不需要 `up` / `cover` 两种模式**
- 板底 `line` 允许因为放大而**整体下移**（≤ 一个 `heroH`）：底线依然是一条直线，只是位置变了。这是唯一被接受的版面变化，因为照片总面积变大了。

### 4.4 `packFocus()` —— 整盘重排 + FLIP

```
1. packGrid()                      // 基准版面（确定性，= 静止时的样子）
2. hero = heroRect(focusId)        // 4.3
3. packGrid([hero])                // 以放大照为障碍，把**其余所有照片**重排一遍
4. hero.rect = heroRect            // 把放大照自己放进去（它不参于打包）
5. paint()                         // transform / height 各 500ms 过渡 = FLIP
```

**这就是整个聚焦逻辑。** 没有 `openBand` / `bandFits*` / `liftSet` / nudge / cover。

- 不重叠：打包器占位保证
- 没有空洞：每张图都落在"第一个够放的位置"；若某处有洞，说明那列还有空位没被利用，而打包器会优先选空位最浅的列 → 洞只可能出现在**板底之上临时变矮的列**，由 `normalizeBottom` 拉平
- 底线齐：`normalizeBottom` 列内独立
- 放大照比例：它就是菜单档的放大版

> 二期可选（用户嫌"整盘都在动"时）：只重排放大带压到的 `k` 列（局部），其余列不动。格点化之后局部让位有解（菜单有 96–512 的深度可以降档），但**先做整盘重排**——它是唯一能证明对所有输入都成立的做法。

### 4.5 `normalizeBottom()`

```
line = max(每列最后一格的下沿)
for 每一列:
    last = 该列最下面一格
    want = line - last.y
    last.h = clamp(want, MENU_MIN, 2.5 * last.nativeH)   // "末格破例"：唯一允许非菜单高度的一格
```

- 每列只动**一格**，列内独立 → 不可能制造空洞、不可能影响别人
- 拉不起（列太短）时放宽到 `2.5 × nativeH`（= 换成更宽的取景框），仍不够就把 `line` 取所有列的可达最小值
- 若数列很少（7–8 张）导致板高 < 放大照高：`line` 取 `max(所有列底边, hero 底边)`，即板底整体下移（用户已确认"图片少的时候没办法"）

### 4.6 绘制

`paint()` 保持现有实现（`translate3d + scale`，`boxH = rect.h / scale`）。CSS 已经有：

```css
.gal-cell { transition: transform var(--gal-dur), height var(--gal-dur); }  /* 500ms */
.gal-stage.is-instant .gal-cell { transition: none !important; }
```

→ FLIP 天然可用：直接改 `rect` 然后 `paint()`。

### 4.7 相机 / 退出

- `centerOnFocus()` 不变（把放大照居中并 clamp 进画布，保证整张可见）
- 退出放大：`packGrid()` + `paint()`，恢复到与初始完全一致的版面（确定性）
- URL `?p=id`、灯箱、分类筛选、幕布滚动、拖拽橡皮筋 **全部不动**

---

## 5. 代码地图：删 / 留 / 改

### 5.1 删除（约 700 行）

| 函数 | 行数 | 原因 |
| --- | --- | --- |
| `cropRoom` | ~10 | 被"菜单选档"取代 |
| `groupColumns` / `columnRoom` | ~30 | 被 `menuHeight` 取代 |
| `fitColumn` | ~50 | 被 `menuHeight` 降档取代 |
| `alignBottom` | ~60 | 被 `normalizeBottom`（每列一格）取代 |
| `bandSplit` | ~35 | 不再有"带"这个概念，只有障碍矩形 |
| `bandFitsDown` / `bandFitsUp` | ~70 | 同上 |
| `liftSet` | ~30 | 同上 |
| `openBand` / `openBandUp` | ~75 | 同上 |
| `packFocus` 里的 `mode=down/up/cover`、nudge 搜索 | ~90 | 变成一个 `clamp` |
| `HARD_CROP` / `MIN_KEEP` 相关分支 | ~40 | 不再需要 |

### 5.2 新增（约 150 行）

`RATIOS` 菜单、`snappedAspect()`、`menuHeight()`、`snapH()`、`heroRect()`、`packGrid(obstacles)`、`normalizeBottom()`、dev 断言 `checkInvariants()`。

### 5.3 保留不动

`measure` / `computeGrid`（只需要把 `colW` 吸附到 144 的倍数）、`setBase`、`paint`、`resetOcc` / `firstFit` / `occupy` / `clearFrom`、相机全套（`camBounds` / `clampCam` / `moveCam` / `elastic` / `centerCamera`）、幕布（`followCurtain` / `updateCurtain`）、灯箱全套、`bind` / `handleTap` / `focus` / `unfocus` / `syncUrl` / `restoreFromUrl`、分类筛选、入场动画。

保留但**要改**：`computeGrid()` 中 `colW` 改为"最近 144 倍数"；`packFocus()` 整个重写；`paintDirty`/`galGrid`/`galFocus` 调试数据集改为输出新模式。

---

## 6. 配置改动

| 位置 | 项 | 现在 | 改为 |
| --- | --- | --- | --- |
| `src/utils/gallery-shared.ts` `DEFAULT_SETTINGS` | `columnWidth` | 232 | **288** |
| 同上 | `focusWidth` | 0.52 | **0.82** |
| 同上 | `focusMaxHeight` | 0.8 | **0.92** |
| `gallery-shared.ts` `SETTING_RANGE.columnWidth` | max | 340 | **432**（并注明"必须 144 的倍数"）|
| `gallery-shared.ts` `SETTING_RANGE.focusWidth` | max | 0.8 | **0.9** |
| `config/gallery.json` `settings` | 同上三项 | 232 / 0.52 / 0.8 | 同步改为 288 / 0.82 / 0.92 |

`columnWidth` 运行时也要吸附：`colW = clamp(round(columnWidth / 144) * 144, 144, 432)`。

---

## 7. 实施步骤与验收

### 阶段 1：格点化初排（不碰聚焦）

1. 加 `RATIOS` / `snappedAspect` / `menuHeight` / `snapH`
2. `computeGrid` 吸附 `colW` 到 144 倍数
3. `packNormal` → `packGrid()`（障碍参数传空）
4. `normalizeBottom()` 取代 `alignBottom`
5. 验收：静止版面四边齐、无空洞、比例全在菜单里

### 阶段 2：聚焦重写

6. `heroRect()` + `packGrid([hero])`
7. 删掉 5.1 全部函数；`packFocus` 只剩 5 行
8. `centerOnFocus` 沿用；退出恢复
9. 验收脚本（见 8）跑 160 张，**缺陷数必须为 0**

### 阶段 3：打磨

10. dev 断言 `checkInvariants()`（`import.meta.env.DEV` 才跑）
11. 手机模式（`mode === 'scroll'`）：`colW` 用 144，或者放宽为"比例精确 + 像素取整"（2 列固定，没有横向让位问题）
12. 文档：本文件定稿后更新 `docs/album-wall.md` 的 §3.3 / §10 / §11

### 验收标准（硬指标，缺一不可）

- 160 张逐张点开：**重叠 0、空洞 0、越界 0、底线/顶线偏差 0px**
- 每种比例档至少 3 张验证放大照实际矩形比例与菜单档一致（误差 < 0.5%）
- 退出放大后版面与初始**逐像素一致**
- 4 个角落 + 首末行 + `g0055` / `g0096` 点名回归
- 换一批随机图（`w/h` 随机、含 1:3 长截图与 3:1 全景）重跑，缺陷数仍为 0
- 1440 / 1280 / 1920 / 390（手机）四档视口各跑一遍

---

## 8. 测试脚本（可直接粘给 Playwright）

> 用 `browser_run_code_unsafe`（**不是** `browser_evaluate`，后者不传 `page`）。
> MCP 单次调用约 30s 超时 → 一次测 80 张。
> 截断阈值：`GAP_MAX = gap + 4`（正常缝是 gap，多了才算空洞）。

### 8.1 单张体检 + 不变量检查

```js
async (page) => {
  const analyze = async (id) => {
    await page.evaluate((id) => {
      document.querySelector(`[data-gal-cell][data-id="${id}"]`)?.click();
    }, id);
    await page.waitForTimeout(700);          // 相机 500ms 过渡；格子 transform 是终值可立即读
    return page.evaluate(() => {
      const num = (s) => parseFloat(s) || 0;
      const cells = [...document.querySelectorAll('[data-gal-cell]')].map((el) => {
        const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el.style.transform || '');
        const sc = /scale\(([-\d.]+)\)/.exec(el.style.transform || '');
        return { id: el.dataset.id, focus: el.classList.contains('is-focus'),
          x: m ? num(m[1]) : 0, y: m ? num(m[2]) : 0,
          w: num(el.style.width) * (sc ? num(sc[1]) : 1),
          h: num(el.style.height) * (sc ? num(sc[1]) : 1) };
      }).filter((c) => c.w > 0 && c.h > 0);
      const hero = cells.find((c) => c.focus);
      const grid = document.querySelector('[data-gal-grid]');
      const fd = document.querySelector('[data-gal-focus]');
      const colW = Number((grid.dataset.galGrid.match(/colW=([\d.]+)/) || [])[1] || 288);
      const cols = Number((grid.dataset.galGrid.match(/cols=(\d+)/) || [])[1] || 0);
      const pitch = colW + 8, GAP_MAX = 12;

      // ① 重叠
      const overlaps = [];
      for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 1 && oy > 1) overlaps.push(`${a.id}x${b.id}:${Math.round(ox)}x${Math.round(oy)}`);
      }
      // ② 空洞（列内两张之间多出来的空白）
      const holes = [];
      for (let col = 0; col < cols; col++) {
        const iv = cells.filter((c) => c.x < col * pitch + colW - 2 && c.x + c.w > col * pitch + 2)
          .map((c) => ({ id: c.id, a: c.y, b: c.y + c.h })).sort((p, q) => p.a - q.a);
        for (let i = 1; i < iv.length; i++) {
          const p = iv[i - 1], q = iv[i];
          if (q.a - p.b > GAP_MAX) holes.push(`c${col}:${p.id}->${q.id}:${Math.round(q.a - p.b)}px`);
        }
      }
      // ③ 四边
      const line = Math.max(...cells.map((c) => c.y + c.h));
      const bottoms = [];
      for (let col = 0; col < cols; col++) {
        const last = cells.filter((c) => c.x < col * pitch + colW - 2 && c.x + c.w > col * pitch + 2)
          .sort((p, q) => q.y + q.h - (p.y + p.h))[0];
        if (last) bottoms.push(line - (last.y + last.h));
      }
      const topGap = Math.min(...cells.map((c) => c.y));
      return { focus: fd?.dataset.galFocus, hero: hero && `${Math.round(hero.w)}x${Math.round(hero.h)} r=${(hero.w / hero.h).toFixed(3)}`,
        overlaps, holes, bottomSpread: Math.max(...bottoms), topGap, line: Math.round(line) };
    });
  };
  const a = await analyze('g0055');
  await page.keyboard.press('Escape'); await page.waitForTimeout(650);
  return JSON.stringify(a, null, 1);
}
```

### 8.2 全量扫描（160 张，分 2 次）

```js
async (page) => {
  const ids = await page.evaluate(() => [...document.querySelectorAll('[data-gal-cell]')].map((el) => el.dataset.id));
  const out = [];
  for (const id of ids.slice(0, 80)) {        // 第二次改成 slice(80, 160)
    await page.evaluate((id) => document.querySelector(`[data-gal-cell][data-id="${id}"]`)?.click(), id);
    await page.waitForTimeout(70);
    const r = await page.evaluate(() => { /* 同 8.1 的 cells/overlaps/holes 计算，返回 {overlaps, holes} */ });
    out.push({ id, ...r });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(40);
  }
  return JSON.stringify(out.filter((r) => r.overlaps?.length || r.holes?.length), null, 1);
}
```

> 注意：`g0009` / `g0022` / `g0029` 这类"点了没进放大"的偶发情况，是上一轮 `Escape` 还没结算完就点了下一张，加 40ms 即可。

### 8.3 环境准备

```powershell
cd "E:\AI Program\MyBlog"
npm run dev                       # 若报 "Another astro dev server is already running"，直接用它：http://localhost:4321/album/
Copy-Item uploads\gallery-demo.json config\gallery.json -Force   # 160 张演示图
# 收工恢复：
git checkout -- config/gallery.json
```

截图必须落到 `C:\Users\FormerlyXZ\` 下（Playwright 输出目录限制）。

---

## 9. 已知代价与风险

| 代价 | 说明 | 缓解 |
| --- | --- | --- |
| 缩略图被裁成规整比例 | 用户已明确接受（"哪怕合规比例也可以按需裁"） | 灯箱看原图 |
| 极端比例被硬压 | 1:3 长截图、3:1 全景 | 设边界档，灯箱补偿 |
| 放大不再是原比例 | 用户已确认接受；放大照 = 菜单档的放大版 | 灯箱 + 放大后仍按原图裁切，不变形 |
| 聚焦时整盘都在动 | 整盘重排的必然结果（"照片海让开"） | 500ms FLIP + 变暗；嫌吵再上二期的局部重排 |
| 板底可能整体下移 | 照片总面积变大时必须下移 | 用户已接受"底线是直线"而非"底线位置固定" |
| 列宽吸附 144 倍数 | 1440 屏 → 288（可视野从 6 列变 5 列） | 已确认 |

**回退方案**：所有改动集中在 `packFocus` / `packNormal` / `packGrid`。若新方案体验更差，`git stash` 回到连续坐标版本（但那个版本有 11 处留缝 + 2 处重叠）。

---

## 10. 待确认（下一轮先问）—— 已全部按「建议」落地

1. **放大照的比例档要不要和缩略图一致？**
   → 一致（不多裁）。`2:1` / `3:1` 全景放大时**改按 16:9** 取景（见 `heroLayout` 里的 `ratio` 修正）。
2. **手机（`mode: 'scroll'`）**：`colW = 144` 还是「比例精确 + 像素取整」？
   → 后者：`colW = 屏宽 ÷ 列数`（2 列），高度取整到 1px（步长自动算成 1），放大时占满屏宽。
3. 一期接受「整盘重排」，还是要直接做「只让开被压到的 k 列」？
   → 先做整盘重排（唯一能证明对所有输入都成立的做法）。局部重排留作二期。

---

## 11. 实施记录（实际落地的和本文件的差异）

### 11.1 与本文件规格不同的四处

| # | 本文件原方案 | 实际实现 | 为什么 |
|---|---|---|---|
| 1 | `normalizeBottom()` 的 `line` 只取「每列都能缩/拉到位」的 minimax 解 | 多一个分支：**放大照那几列下面已经没照片时，`line` 直接钉在放大照下沿** | 否则放大照下方会空出一块（用户报的「空白」）。这一列照片只到带上边为止，下沿就是放大照自己撑着的 |
| 2 | 放大照 `top` 只做 `clamp`，不主动下移 | 加 `pinBandBottom()`（不动点迭代，上下都试）：放大照下面没照片时把它的**下沿钉在板底线上** | 点最后几排时，放大照若停在原地，下方必然空一截；只往下推且只推四轮的话，推过头就回不来 |
| 3 | 只说「上边靠每列从 y=0 起堆保证」 | 加 `flushBandTop()`：把带上沿上方那一列的最后一张**拉长或裁短**到「上沿 − gap」，并且上沿可以在几个候选位置里挑一个最省事的 | 瀑布流各列本来就错开上百像素，只允许「拉长、≤1.6 倍」时根本接不住 —— 实测每档视口下都有 4~12 张照片在放大照**上方**留 100~170px 空档，而且随窗口尺寸变化（用户报的正是这个） |
| 4 | **§2.5「边界列变窄」（A 方案）** | **已废弃**：放大照只占整列、横向必须铺满，高度改用 `HERO_OVERFLOW = 1.35` 放宽 | 见下 |

关于第 4 条（这条推翻了 §2.5，也推翻了「用户选 A」那个结论）：

A 方案能把宽度精确到 1px（9:16 做到 458 宽，正好卡在 `focusMaxHeight` 上），
但**放大照两侧会各留一条空档**：9:16 左右各 60px、4:3 各 43px、1:1 各 31px。
用户验收时的判断是「照片墙上每张图（含放大那张）都应该按相应尺寸扑上去，不该有空缺」——
这个判断是对的：那两条空档就是网格破了洞，比「放大照稍微高出一屏」难看得多。

于是改成：
- 宽度只取整列（`(k−1)·pitch + colW`），`x = col·pitch`，**天然铺满**
- 高度 = 宽 ÷ 比例（吸附格点），比可用区高的时候最多允许 1.35 倍（`HERO_OVERFLOW`），
  顶边贴住导航下方往下延伸，相机可拖、灯箱可看全
- 竖图兜底 k ≥ 2：1 列和缩略图一样大，等于点了没反应
- 超过 1.35 倍才真的退回更少的列 —— 实际只在窗口特别矮时才会触发

1440×900 下新的放大照尺寸：9:16 584×1038、2:3 584×876、3:4 584×779、1:1 880×880、
4:3 1176×882、3:2 1176×784、16:9 1176×661（**左右空档全部为 0**）。

顺带补了文档里没有的两条：
- **放大照居中要避开顶部固定导航**（`safeTop`），`BOX_H` 上限也按「可用高度」算 ——
  否则竖图放大后上沿被玻璃胶囊压住
- 比可用区高时标题条改挂照片顶部（`.gal-cell.is-tall`），否则它落在屏幕外

### 11.2 验收结果（160 张本地演示数据，多档视口）

- 逐张点开 160 张（1440×900）：**重叠 0 / 空洞 0 / 越界 0 / 底线偏差 0 / 左右空档 0 /
  带上沿空档 0 / 带下沿空档 0 / dev 断言全部 ok**
- 多档视口各抽 32–40 张：1440×900、1366×768、1536×864、1680×1050、1280×720、1024×768
  —— 全部 0 缺陷（**这一轮的重点**：以前的缺口只在某些窗口尺寸下出现）
- **连续缩放**：聚焦状态下把窗口宽度从 1440 一路改到 1920 再收回 1000（含 `colW` 288↔144 的跳变）、
  高度 700–1100 共 29 步，每一步都零缺陷
- **换一批随机比例数据复验**（60 张：1:3 长截图、3:1 / 2:1 全景、极端 1:7.5、其余随机 0.3–3.5）：
  逐张点开 60 张，0 缺陷；放大照 3:1 / 2:1 → 1176×662（按 16:9 取景）、0.56 → 584×1038、
  1 → 880×880、1.33 → 1176×882，比例误差 ≤ 0.07%（2px 格点吸附的分辨率）
- 放大照左右空档实测：**全部 0px**（旧 A 方案下 9:16 是 59 + 63px）
- 退出放大后版面与初始**逐字节一致**（`transform` + `height` 全等）
- 筛选「生活」32 张 → 回「全部」：版面同样逐字节回到初始
- 手机 375×844（scroll 模式）：160 张全部通过、0 重叠；放大照 375 宽正好 2 整列
- 灯箱：第二下点开、`50 / 160` 计数、Esc 关闭、`gal-lb-open` 正确摘除

### 11.3 写校验脚本时踩过的坑

- 判断「放大照占了几列」用 `data-gal-focus` 里的 `k=` / `col=` / `band=`；
  **不要只看 `rect.w`**（虽然改成整列之后它和带宽相等了，但别把这条当成永久契约）。
- 放大照和上一张之间隔的是 **`band.top − gap`**，和下一张之间是 `band.bottom + gap`；
  两者都是合法布局，不是洞。
- 列的首格从 **y = 0** 开始（顶上不留 gap）；只有放大照顶在列首时，首格才是 `band.bottom + gap`。
- 截图：手机模式画布高 16484px（> Chrome 单纹理 16384），`fullPage` 截图会超时/空白 ——
  不是排版坏了，改用视口截图 + 滚动。

### 11.4 还没做的（二期可选项）

- 只重排被压到的 k 列 —— **已做**（见 §11.5：sticky 打包 + 只让开被压到的那几张）。
- 分类栏在窄桌面宽度下会轻微压住放大照的左边（`focusWidth ≤ 0.82` 时不重叠）。
- ~~放大照比一屏高时（9:16 / 4:3），一进来只看到上半部分~~ → **已解决**（§11.5：高度优先选列 + 超限裁盒子）。

### 11.5 第四轮：整体缩小、放大照不出屏幕、真居中（2026-11 用户反馈）

用户原话：「感觉整体有点偏大 …… 被放大的图片也有点大的超出屏幕并且没有居中，
有没有方案可以改一下整体大小，保证其他的不变」。

实测（旧值 288 / 0.82 / 0.92）确认了两件事：
1440×900 下放大照 9:16 是 **584×1038**，比可用区 814 高 224px，上下都切在屏幕外；
而且所有视口、所有比例的放大照，纵向都停在 `top = 导航下沿`（`offset 0`），
**从来不平分上下留白** —— 因为 `centerOnFocus` 用的是 `camBounds(false)`，
它把镜头限在画布边框内，而大多数照片本来就贴着画布上沿，镜头根本推不上去。

三处改动（都不碰打包 / 对齐 / 不变量逻辑）：

| # | 改动 | 为什么 |
|---|---|---|
| 1 | `columnWidth` 288 → **216**，吸附从 144 的倍数放宽到 **72 的倍数**（`COL_SNAP`） | 用户要「整体小一点」。列宽是唯一旋钮：列数、放大照宽度、照片尺寸全由它派生。216 时九档高度 + 缝的 gcd 仍是 **2px**（392/332/296/224/170/152/130/116/80），格点性质一字不改。1440 屏从 4.9 列变 6.4 列，画布从 4728×3191 变 4696×1864 |
| 2 | `heroLayout` 改成**高度优先**：先只在「整块装得进可用区」的整数列里取最宽的 k；一档都装不下时才退到 `HERO_OVERFLOW`，并且把盒子**裁到可用区高度** | 「不出屏幕」和「整列铺满」不能再靠「允许高出 35%」调和了。1440×900 下 9:16 变成 440×782（装得下）、1:1 664×664、16:9 888×500；1440×780 / 1280×720 时竖图裁到 694 / 634 |
| 3 | `centerOnFocus` 改用 `camBounds(true)`，并且 `camBounds` 里「居中」的基准值也改按**可用区**算 | 让贴边照片也能真居中；实测横纵偏差 ≤ 1px（此前纵向偏下 43px = 导航高的一半） |

顺带更新的默认值：`focusWidth` 0.82 → **0.68**（放大照最大宽度从 82% 屏宽降到 62%／静态列宽下
更合适）。`focusMaxHeight` 当时保持 0.92 —— 真正的天花板已经是可用区高；
后来这个滑块被整项删除，见 §11.6。

验收（列宽 216、`focusWidth 0.68`）：

- 160 张逐张点开（1440×900）：`data-gal-check` **全 ok**（0 重叠 / 0 空洞 / 0 越界 / 放大照铺满 k 列 /
  带上下沿贴齐 / 底线齐），每次只有 1 张 `is-focus`
- 5 档视口各抽 20 张（1366×768 / 1680×1050 / 1280×720 / 1920×1080 / 1024×768）：
  全 ok；放大照底边超出屏幕的最大值 **≤ 0px**（`crop` 只在 1366×768、1280×720 出现）；
  居中偏差 ≤ 1px
- 动效：随机 20 张点开，平均 **14.4 张移动 / 6 张走远**（旧列宽下 29.4 / 9.3，v2 是 155 张全动）
- 手机 375×844（scroll 模式）：12 张抽检全 ok，放大照仍占满 2 整列
- 退出放大后版面回到初始（sticky 打包的既有保证未受影响）

### 11.6 第五轮：删掉两个「没用 / 会破坏排版」的配置项

用户原话：「站点配置中关于这个的设置 …… 不是必须的或者会破坏排版的设置都可以删除了」。

判据只有两条：**这个旋钮真的起作用吗**、**把它拉到区间端点会不会把排版弄坏**。
七项逐个看（`/config → 照片墙 → 排版`）：

| 项 | 结论 | 依据 |
|---|---|---|
| `columnWidth` 列宽 | 留 | 整体大小唯一的旋钮；五个合法档位实测全绿 |
| `gap` 间隙 | 留 | 纯外观。实测 0 / 9（奇数）/ 24 三档全绿：奇数缝的格点步长退到 1px，残差仍 ≤ 1px |
| `radius` 圆角 | 留 | 纯 CSS 变量 `--gal-radius`，碰不到排版 |
| `dim` 变暗 | 留 | 纯 CSS 变量 `--gal-dim`，碰不到排版 |
| `focusWidth` 放大宽度 | 留，下限 0.3 → **0.5** | 0.3 时 1440 屏 2 列宽 440 > 盒 432，横图会退成 1 列（和缩略图一样大 = 点了没反应） |
| `boardWidth` 画布几屏宽 | **删** → 常量 `BOARD_SCREENS = 3.2` | 列数实际由「竖向至少能拖 1.45 屏」定：160 张时两式打平（21 列），改这个值毫无变化；30 张时完全无效。死旋钮 |
| `focusMaxHeight` 放大照高度上限 | **删** | 真正的天花板已经是「可用区」（视口减导航）。调小只会让放大照提前被裁；调到 0.5 时 `①高度优先` 找不到 2 列的档，直接退回「整块顶出屏幕」—— 能破坏 §11.5 刚修好的性质 |

删项之后代码侧：`GallerySettings` 从 7 个字段降到 5 个，`RATIO_KEYS` 只剩 `focusWidth` / `dim`；
`readSettings` / `normalizeSettings` 靠遍历 `DEFAULT_SETTINGS` 的键，所以旧 JSON 里残留的
`boardWidth` / `focusMaxHeight` 会被自动忽略，保存一次就清掉。

验收：

- 删项后 160 张逐张点开（1440×900）：`data-gal-check` 全 ok，无 `pageerror`
- 极端组合 A（列宽 432 + 缝隙 0 + 圆角 18 + 放大 0.5 + 变暗 0.9）：抽 40 张全 ok、无溢出
- 极端组合 B（列宽 144 + 缝隙 9 + 圆角 0 + 放大 0.9 + 变暗 0）：抽 40 张全 ok、无溢出
- `/config → 照片墙 → 排版` 现在渲染 5 个滑块，区间正确（列宽 144–432/72、放大 0.5–0.9）

---

## 12. 工作区状态 & 纪律

- 当前 `git status`（v3 落地后，**尚未提交**）：
  - `M src/scripts/gallery-wall.ts` —— v3 引擎（格点打包 / 放大重排 / dev 断言 / 安全区）
  - `M src/utils/gallery-shared.ts` —— 列宽 **216** / 放大 0.68，只剩 5 个可调项（区间、提示文案同步）
  - `M docs/album-wall.md` —— 已按 v3 改写（§3 / §9 / §10 / §11）
  - `?? docs/album-wall-lattice.md` —— 本文件（决策记录）
  - `M config/gallery.json` —— **本地 160 张演示数据，提交前必须恢复**：
    `git checkout -- config/gallery.json`，然后只把 `settings` 那 7 个数改回去（不带 photos）。
- `uploads/gallery-demo.json` 是本地演示数据（已 gitignore），
  用法：`Copy-Item uploads\gallery-demo.json config\gallery.json -Force`
- 远程 `origin/main` 上已有 `7929881`（上一轮**未经用户检查就推送**的提交），用户明确要求：**未经他亲眼看效果并同意，不许 `git commit` / `git push`**
- 开发流程：改工作区 → 起 dev server → 自己逐张验收 → 报告给用户 → 用户点头 → 才谈提交
