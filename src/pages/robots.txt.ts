import type { APIContext } from 'astro';
import { SITE_URL } from '../consts';

// 动态生成 robots.txt，域名改了这里自动跟着变
export function GET(_context: APIContext) {
  const body = `User-agent: *
Allow: /
# 后台编辑器是私人区域，不要抓取
Disallow: /admin/
# 统计页只有站长能看，不要抓取
Disallow: /stats/

Sitemap: ${new URL('sitemap-index.xml', SITE_URL).href}
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
