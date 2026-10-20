import type { APIRoute } from 'astro';
import { latestRun, serversInSitemapChunk } from '../lib/db';
import { CHUNK } from './sitemap.xml';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One chunk of server pages, or the handful of static pages for "pages". */
export const GET: APIRoute = async ({ params, site }) => {
  const base = (site ?? new URL('https://mcpcost.ulehla.dev')).toString().replace(/\/$/, '');
  const headers = { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=86400' };
  const run = await latestRun();
  const lastmod = run?.probedAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  let entries: Array<{ loc: string; lastmod: string }>;
  if (params.chunk === 'pages') {
    entries = ['/', '/tokens', '/servers', '/statistics', '/hosts', '/check', '/methodology'].map((p) => ({ loc: `${base}${p}`, lastmod }));
  } else {
    const n = Number(params.chunk);
    if (!/^\d{1,9}$/.test(params.chunk ?? '')) return new Response('Not found', { status: 404 });
    // A rowid range reads only its own rows; OFFSET would read every row before it.
    // A chunk that emptied out since the index was cached is a valid, empty sitemap, not an error.
    const results = await serversInSitemapChunk(n, CHUNK);
    entries = results.map((r) => ({ loc: `${base}/s/${r.name}`, lastmod: r.probed_at.slice(0, 10) }));
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
    .map((e) => `  <url><loc>${escape(e.loc)}</loc><lastmod>${e.lastmod}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers });
};
