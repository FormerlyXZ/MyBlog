/**
 * 主题常量（纯数据，不含任何 DOM 逻辑）
 * ============================================================
 * 服务端组件要拿这份清单来渲染选择器，所以必须能在 Node 里 import，
 * 不能碰 document —— DOM 相关的逻辑都在 src/scripts/theme.ts。
 *
 * ⚠ 这里的 29 套必须与 tailwind.config.mjs 的 DAISY_THEMES 保持一致
 *   （那份是 Tailwind 构建时用的，这份是页面渲染用的，改一处要改两处）。
 * ============================================================
 */

export interface ThemeOption {
  /** daisyUI 主题名，直接写进 data-theme */
  name: string;
  /** 是否是深色主题 */
  dark: boolean;
}

/**
 * 深色主题清单。
 * 依据 daisyUI 官方对 dark 主题的划分：这几个主题的 base-100 是深色，
 * 需要走「深色拟态阴影 + 深色遮罩」那一套。
 */
const DARK = new Set([
  'dracula',
  'synthwave',
  'halloween',
  'forest',
  'black',
  'luxury',
  'business',
  'night',
  'coffee',
  'dim',
  'sunset',
]);

/** 29 套可选配色（前两个是本站默认的浅色/深色） */
export const THEME_LIST: ThemeOption[] = [
  'garden',
  'dracula',
  'cupcake',
  'bumblebee',
  'emerald',
  'corporate',
  'synthwave',
  'retro',
  'cyberpunk',
  'valentine',
  'halloween',
  'forest',
  'aqua',
  'lofi',
  'pastel',
  'fantasy',
  'black',
  'luxury',
  'cmyk',
  'autumn',
  'business',
  'acid',
  'lemonade',
  'night',
  'coffee',
  'winter',
  'dim',
  'nord',
  'sunset',
].map((name) => ({ name, dark: DARK.has(name) }));

/** 深色主题名数组（给客户端脚本判断用） */
export const DARK_THEMES: string[] = THEME_LIST.filter((t) => t.dark).map((t) => t.name);

/** Banner 三档模式 */
export type BannerMode = 'default' | 'fullscreen' | 'hidden' | 'background';

export const BANNER_MODES: { mode: BannerMode; label: string; hint: string }[] = [
  { mode: 'default', label: '默认', hint: '顶部横幅，随页面滚动' },
  { mode: 'fullscreen', label: '全屏', hint: '占满一屏高度' },
  { mode: 'hidden', label: '隐藏', hint: '不要 Banner，直接看内容' },
  { mode: 'background', label: '背景', hint: '固定为页面背景，内容半透明' },
];
