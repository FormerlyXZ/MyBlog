---
title: Markdown 速查表：写文章只需要这些
description: 标题、加粗、列表、引用、代码块、表格、图片——够用一辈子的一套语法。
date: 2026-10-16
tags: [Markdown, 教程]
---

写博客 95% 的时间只会用到下面这些语法。忘了就回来翻这一页。

## 标题

```markdown
## 二级标题
### 三级标题
#### 四级标题
```

一篇文章只用一个 `#` 一级标题（一般就是 frontmatter 里的 `title`，正文里不用再写）。

## 强调

```markdown
**加粗**
*斜体*
~~删除线~~
`行内代码`
```

效果：**加粗**、*斜体*、~~删除线~~、`行内代码`。

## 列表

```markdown
- 无序列表
- 第二项
  - 缩进两格变成子项

1. 有序列表
2. 第二项
```

- 无序列表
- 第二项
  - 缩进两格变成子项

## 链接与图片

```markdown
[链接文字](https://example.com)
[站内链接](/posts/hello-world/)

![图片说明](/images/photo.jpg)
```

站内链接记得用 `/posts/xxx/` 这种以斜杠开头的路径。图片放到 `public/images/` 目录下，就能用 `/images/photo.jpg` 引用。

## 引用

```markdown
> 一级引用
>
> 可以写多段
```

> 一级引用
>
> 可以写多段

## 代码块

用三个反引号包起来，并在后面写上语言名，就会自动高亮：

```js
// 这是 JavaScript
function greet(name) {
  return `你好，${name}！`;
}

console.log(greet('世界'));
```

```bash
# 这是 Shell
npm install
npm run dev
```

```python
# 这是 Python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

## 表格

```markdown
| 左对齐 | 居中 | 右对齐 |
| :--- | :---: | ---: |
| 内容 | 内容 | 内容 |
```

| 左对齐 | 居中 | 右对齐 |
| :--- | :---: | ---: |
| 内容 | 内容 | 内容 |

## 分隔线

```markdown
---
```

## 几个实用小技巧

- **想让两个段落间距离更近**：中间不要空行，它们会合并成一段
- **换行**：行尾加两个空格，或者干脆空一行分段
- **表情**：直接打 emoji 😄，比如 🚀 ✅ ⚠️
- **特殊符号**：想显示 `*` 本身，写成 `\*`
