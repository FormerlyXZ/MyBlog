import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getListingPosts, postUrl } from '../utils/posts';
import { SITE, SITE_URL } from '../consts';

export async function GET(context: APIContext) {
  // 系列章节不进 RSS（只出目录页），否则一次更新会刷屏 10 条
  const posts = await getListingPosts();

  return rss({
    title: SITE.title,
    description: SITE.description,
    site: context.site ?? SITE_URL,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description ?? '',
      pubDate: post.data.date,
      link: postUrl(post),
      categories: post.data.tags,
    })),
    customData: '<language>zh-CN</language>',
  });
}
