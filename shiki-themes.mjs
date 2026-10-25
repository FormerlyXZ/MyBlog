/**
 * 代码高亮主题
 * ============================================================
 * 直接改 shiki 自带的 github-light / github-dark 的一个地方：**注释改成绿色**。
 *
 * 为什么不写在 CSS 里：
 *   shiki 是把颜色以 inline 样式写到每个 token 上的
 *     <span style="--shiki-light:#6a737d;--shiki-dark:#6a737d">// 注释</span>
 *   注释跟普通文字共用同一个 <span> 结构，没有 class 也没有 data-属性，
 *   光靠选择器根本挑不出「注释」这一类 token。
 *
 * 所以改在主题层：在 tokenColors 数组**最后面**追一条注释规则。
 * TextMate 的取色规则是「同样精确度时，后写的赢」，追加在末尾才能盖掉
 * 原本那条 #6a737d 的注释规则；其余 token（关键字、字符串、数字、函数名…）
 * 一个都没动。
 *
 * 想换别的颜色只改下面的 COMMENT 即可（浅色 / 深色各一个值）。
 */

import githubLight from 'shiki/themes/github-light.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';

/** 注释颜色：浅色背景(#fff)上要压得住，深色背景(#24292e)上要浮得起 */
const COMMENT = {
  light: '#2f8f43',
  dark: '#7ec98f',
};

/** TextMate 里会被当成「注释」的几个 scope（github 主题原本就是这三个一组） */
const COMMENT_SCOPES = ['comment', 'punctuation.definition.comment', 'string.comment'];

/**
 * 复制一份主题，把注释那条规则换成指定颜色。
 * @param {object} theme shiki 的主题注册对象（github-* 是 raw 格式，用 tokenColors）
 * @param {string} color 注释的前景色
 */
function withCommentColor(theme, color) {
  return {
    ...theme,
    // 名字加后缀：跟内置主题同名的话，shiki 缓存里会认成同一个主题
    name: `${theme.name}-green-comments`,
    tokenColors: [
      ...theme.tokenColors,
      // 放最后：TextMate 的「同精度后写覆盖先写」，提前会输给原规则
      { scope: COMMENT_SCOPES, settings: { foreground: color } },
    ],
  };
}

export const light = withCommentColor(githubLight, COMMENT.light);
export const dark = withCommentColor(githubDark, COMMENT.dark);
