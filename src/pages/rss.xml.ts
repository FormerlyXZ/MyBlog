import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getSortedPosts, postUrl } from '../utils/posts';
import { SITE, SITE_URL } from '../consts';

export async function GET(context: APIContext) {
  const posts = await getSortedPosts();

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
