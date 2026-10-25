/**
 * 写作页预览的代码块语法高亮
 * ============================================================
 * 文章页的代码块是构建时用 shiki 上色的；预览发生在浏览器里、内容还是用户
 * 正在敲的草稿，构建期根本不存在，所以只能**在浏览器里跑一遍 shiki**。
 *
 * 三条设计约束：
 *
 * ① 只给写作页用，所以可以放心引 shiki
 *    这个模块只在 /write 的脚本里被引用，普通访客一个字节都不会下载。
 *
 * ② 懒加载 + 按语言分包
 *    shiki 核心、引擎、每个语言的语法各是一个独立的 chunk，
 *    第一次点「预览」时才去拉，拉过的会被浏览器缓存。用纯 JS 引擎
 *    （engine-javascript）而不是 oniguruma wasm：少一个 1.5MB 的 base64 内联。
 *
 * ③ 先显示、后升级
 *    调用方先用「纯文本 + 绿注释」把预览画出来（markdown.ts 的
 *    highlightComments），本模块在后台把 `pre.md-code` 里的内容换成
 *    shiki 的输出（同样的 --shiki-light / --shiki-dark 变量），
 *    换完让 code-fold 重新量一次高度。语法没收录或加载失败时，
 *    那个代码块就保持原来的样子，不会变成空白。
 * ============================================================ */

import { light, dark } from '../../shiki-themes.mjs';

/** 用到的主题：和 astro.config.mjs 里给文章页的是同一份（注释都是绿的） */
const THEMES = { light, dark };

/** 语言 → 语法模块。每个 import() 会被 Vite 拆成独立的 chunk */
const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
};

/** 围栏里常见的别名 → LOADERS 的键 */
const ALIASES: Record<string, string> = {
  'c++': 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  jsonc: 'json', json5: 'json',
  yml: 'yaml',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', shellscript: 'bash',
  py: 'python', python3: 'python',
  htm: 'html',
  md: 'markdown', mdx: 'markdown',
  patch: 'diff',
  conf: 'ini', cfg: 'ini', properties: 'ini',
  makefile: 'make', mk: 'make',
  rs: 'rust',
  ps1: 'powershell', pwsh: 'powershell',
  docker: 'dockerfile',
};

/** shiki 的「纯文本」语言名：这些不用高亮，保持原样 */
const PLAIN = new Set(['text', 'txt', 'plain', 'plaintext', 'none', 'raw', '']);

type Highlighter = {
  loadLanguage: (grammar: unknown) => Promise<unknown>;
  codeToHtml: (code: string, options: Record<string, unknown>) => string;
};

let highlighterPromise: Promise<Highlighter> | null = null;

/** 已经装进 highlighter 的语言（同一个页面反复预览时不用重复加载） */
const ready = new Set<string>();

/** 懒加载 shiki 核心 + 纯 JS 引擎（第一次调用时才真正下载） */
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= (async () => {
    const [core, engine] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    const hl = (await core.createHighlighterCore({
      themes: [light, dark],
      langs: [],
      // forgiving：个别语法用了 JS 正则不支持的写法时，尽量降级而不是整个报错
      engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
    })) as unknown as Highlighter;
    return hl;
  })();

  return highlighterPromise;
}

/** 把围栏语言名归一成 LOADERS 的键，认不出来就返回 null */
function resolveLang(raw: string): string | null {
  const name = raw.trim().toLowerCase().split(/[\s:]/)[0] ?? '';
  if (PLAIN.has(name)) return null;
  const key = ALIASES[name] ?? name;
  return LOADERS[key] ? key : null;
}

/**
 * 给一批代码块上色。
 * @returns 是否真的换掉了内容（调用方据此决定要不要让折叠重新量高度）
 */
export async function highlightPreviewCode(scope: ParentNode = document): Promise<boolean> {
  const blocks = [...scope.querySelectorAll<HTMLPreElement>('pre.md-code[data-language]')].filter(
    (pre) => !pre.dataset.highlighted,
  );
  if (!blocks.length) return false;

  let changed = false;

  for (const pre of blocks) {
    const lang = resolveLang(pre.dataset.language ?? '');
    if (!lang) {
      pre.dataset.highlighted = 'plain';
      continue;
    }

    try {
      const hl = await getHighlighter();

      if (!ready.has(lang)) {
        const grammar = await LOADERS[lang]!();
        await hl.loadLanguage(grammar.default);
        ready.add(lang);
      }

      const html = hl.codeToHtml(pre.textContent ?? '', {
        lang,
        themes: THEMES,
        defaultColor: false,
      });

      // 只取 <code> 的内容：<pre> 本身留着（class / data-language / 折叠包裹层都在它身上）
      const generated = new DOMParser().parseFromString(html, 'text/html').querySelector('code');
      const target = pre.querySelector('code');
      if (!generated || !target) {
        pre.dataset.highlighted = 'skip';
        continue;
      }

      target.innerHTML = generated.innerHTML;
      pre.dataset.highlighted = 'shiki';
      changed = true;
    } catch {
      // 语言包下载失败 / 语法解析出问题：保持「纯文本 + 绿注释」的样子
      pre.dataset.highlighted = 'skip';
    }
  }

  return changed;
}
