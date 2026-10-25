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
    /** 更新时间（可选）：编辑旧文章保存时由后台自动写入，文章页会显示「更新于 …」 */
    updated: z.coerce.date().optional(),
    /**
     * 封面图路径（如 /images/cover-1.svg）。
     * 留空则列表卡片自动用渐变色块兜底，不会塌陷。
     */
    image: z.string().optional(),
    /** 分类，可留空；列表页显示成「分类胶囊」 */
    categories: z.array(z.string()).default([]),
    /** 角标：填 Pin 就是置顶，留空不显示 */
    badge: z.string().optional(),
    /** 标签，可留空 */
    tags: z.array(z.string()).default([]),
    /** 草稿：true 时不会出现在任何页面上 */
    draft: z.boolean().default(false),
    /**
     * 系列（多文件长文）标识，等于 src/content/posts 下的子目录名，如 stm32。
     * 一组 md = 一个系列：<series>/index.md 是系列目录 / 说明页，
     * <series>/01-xxx.md、02-xxx.md … 是各个章节。
     * 不填 = 普通单篇文章（老文章都不填，行为完全不变）。
     */
    series: z.string().optional(),
    /** 系列标题（只在目录页 index.md 里写，用于侧栏章节卡和首页入口卡） */
    seriesTitle: z.string().optional(),
    /** 章节序号：目录页写 0，章节按 1、2、3… 排序 */
    seriesOrder: z.coerce.number().optional(),
    /**
     * 附件：上传到 public/files/ 的 PDF、Word、压缩包等文件路径（如 /files/xxx.pdf）。
     * 后台是一组文件路径，手写单条字符串也兼容，统一整理成数组。
     */
    attachments: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((value) => {
        if (!value) return [];
        const list = Array.isArray(value) ? value : [value];
        return list.map((item) => String(item).trim()).filter(Boolean);
      }),
  }),
});

export const collections = { posts };
