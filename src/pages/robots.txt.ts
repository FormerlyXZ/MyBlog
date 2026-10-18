import type { APIContext } from 'astro';
import { SITE_URL } from '../consts';

// 动态生成 robots.txt，域名改了这里自动跟着变
export function GET(_context: APIContext) {
  const body = `User-agent: *
Allow: /

Sitemap: ${new URL('sitemap-index.xml', SITE_URL).href}
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
