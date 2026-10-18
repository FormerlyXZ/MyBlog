import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * 文章集合：src/content/posts/ 下的所有 .md 文件
 * frontmatter 不规范时构建会直接报错，并告诉你哪个文件哪一行有问题
 */
const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.md' }),
  schema: z.object({
    /** 标题（必填） */
    title: z.string(),
    /** 摘要，会显示在列表和 SEO 描述里 */
    description: z.string().optional(),
    /** 日期（必填），写 2026-10-18 这种格式即可 */
    date: z.coerce.date(),
    /** 标签，可留空 */
    tags: z.array(z.string()).default([]),
    /** 草稿：true 时不会出现在任何页面上 */
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
