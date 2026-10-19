import typography from '@tailwindcss/typography';
import daisyui from 'daisyui';

// ============================================================
//  daisyUI 主题清单（29 套）
//  裸的 light / dark / wireframe 三个不列入：
//    - light、dark 是 daisyUI 的通用兜底色，观感一般，
//      本站浅色默认 garden、深色默认 dracula，用不上；
//    - wireframe 是调试用线框主题。
//  加新主题：把名字加进数组即可，主题选择器会自动多一项。
// ============================================================
const DAISY_THEMES = [
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
];

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}'],

  // 明暗分叉用 <html data-theme-type="dark|light">（由 scripts/theme.ts 写入），
  // 而不是 Tailwind 默认的 .dark 类名。
  darkMode: ['selector', '[data-theme-type="dark"]'],

  theme: {
    extend: {
      // ---- 布局尺寸（§1.1）----
      maxWidth: {
        blog: '72rem', // 内容区总宽
      },
      width: {
        sidebar: '20rem', // 左栏粘性侧栏 320px
      },

      // ---- 拟态配色（跟随 daisyUI 主题变量自动变色，不写死 hex）----
      colors: {
        'neu-base': 'oklch(var(--b1) / <alpha-value>)',
        'neu-text': 'oklch(var(--bc) / <alpha-value>)',
        'neu-text-muted': 'oklch(var(--bc) / 0.6)',
        'neu-border': 'oklch(var(--bc) / 0.1)',
        'neu-btn-bg': 'oklch(var(--b1) / <alpha-value>)',
      },

      // ---- 圆角（§1.1：大卡 1.5rem / 中卡 1rem / 小控件胶囊）----
      borderRadius: {
        card: '1.5rem',
        neu: '1rem',
      },

      // ---- 拟态阴影（§1.1）----
      // P1 会在 tokens.css 里按明暗分别覆盖这两个变量，这里只留浅色兜底值。
      boxShadow: {
        'neu-out':
          'var(--neu-shadow-out, 8px 8px 16px rgb(0 0 0 / 0.05), -8px -8px 16px rgb(255 255 255 / 0.6))',
        'neu-in':
          'var(--neu-shadow-in, inset 8px 8px 16px rgb(0 0 0 / 0.05), inset -8px -8px 16px rgb(255 255 255 / 0.6))',
      },

      // ---- 字体（P1 自托管 woff2 后会改成实际字体名）----
      fontFamily: {
        sans: [
          '"M PLUS Rounded 1c"',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          'Roboto',
          '"PingFang SC"',
          '"HarmonyOS Sans SC"',
          '"Noto Sans SC"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          '"SF Mono"',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },

      // ---- 动效（§1.1 Banner 轮播 / 波浪）----
      transitionDuration: {
        600: '600ms',
      },
      keyframes: {
        wave: {
          '0%': { transform: 'translateX(-90px)' },
          '100%': { transform: 'translateX(85px)' },
        },
      },
      animation: {
        wave: 'wave 25s linear infinite alternate',
      },
    },
  },

  plugins: [typography, daisyui],

  daisyui: {
    themes: DAISY_THEMES,
    darkTheme: 'dracula',
    logs: false, // 构建时不在终端刷主题日志
  },
};
