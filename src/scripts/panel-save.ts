/**
 * 顶栏「保存并提交」与各栏自己的保存逻辑之间的登记表
 * ============================================================
 * 为什么需要：/config 里有两种保存。
 *
 *   ① config/site.json —— 站点信息 / 个人资料 / 横幅 / 首页 / 主题 / JSON 源码，
 *      这些栏共用顶栏右上那一颗按钮（config.ts 的 saveConfig）。
 *   ② config/gallery.json、config/music.json、config/navigation.json ——
 *      照片墙 / 音乐库 / 网站导航各自是独立文件，各有自己的保存逻辑。
 *
 * 以前顶栏那颗永远只写 site.json，于是「切到照片墙、看到顶栏写着
 * config/gallery.json、点下去却提交了 site.json」—— 显示的文件和实际写的
 * 文件不是同一个，还顺手在远端留下空提交。
 *
 * 现在改成「顶栏那颗跟着你看的这一栏走」：
 * 各栏在模块加载时把自己的 save / isDirty 登记进来，config.ts 点保存时先查表，
 * 有登记就调它，没有才走 site.json 的老路径。
 * ============================================================
 */

export interface PanelWriter {
  /** 这一栏叫什么，用于「保存XX」按钮文案和提醒文案 */
  label: string;
  /** 真正写仓库；失败自己 toast，不用返回值 */
  save: () => void | Promise<void>;
  /** 是否还有没提交的改动 */
  isDirty: () => boolean;
}

const writers = new Map<string, PanelWriter>();

/** 各栏在模块顶层登记一次（模块只会执行一次，换页不影响） */
export function registerPanelWriter(panelId: string, writer: PanelWriter): void {
  writers.set(panelId, writer);
}

/** 当前这一栏如果自带保存逻辑，就把它取出来 */
export function panelWriter(panelId: string | null | undefined): PanelWriter | undefined {
  return panelId ? writers.get(panelId) : undefined;
}

/** 除当前这一栏之外，还有哪些栏有没提交的改动（顶栏保存前用来提醒） */
export function dirtyElsewhere(exceptId: string | null | undefined): PanelWriter[] {
  const out: PanelWriter[] = [];
  for (const [id, writer] of writers) {
    if (id === exceptId) continue;
    if (writer.isDirty()) out.push(writer);
  }
  return out;
}
