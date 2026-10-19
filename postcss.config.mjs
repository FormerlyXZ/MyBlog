// ============================================================
//  PostCSS 配置
//  说明：Astro 官方已弃用 @astrojs/tailwind 集成，
//  这里直接用 PostCSS 插件接入 Tailwind 3，是官方推荐做法。
//  Astro 会自动读取本文件，不需要在 astro.config.mjs 里注册任何东西。
// ============================================================

export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
