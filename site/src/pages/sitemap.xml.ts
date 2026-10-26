import type { APIRoute } from 'astro';
import { latestRun, serverSitemapChunks } from '../lib/db';

export const CHUNK = 5_000;

/** A sitemap index: the static pages plus one chunk per 5 000 rowids of the servers table, only the chunks with rows in them. */
export const GET: APIRoute = async ({ site }) => {
  const base = (site ?? new URL('https://mcpcost.ulehla.dev')).toString().replace(/\/$/, '');
  const run = await latestRun(['topHosts', 'changes', 'heaviest']);
  const lastmod = run?.probedAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const chunks = await serverSitemapChunks(CHUNK, lastmod);
  const entries = [
    { loc: `${base}/sitemap-pages.xml`, lastmod },
    ...chunks.map((c) => ({ loc: `${base}/sitemap-${c.chunk}.xml`, lastmod: c.lastmod }))
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
    .map((e) => `  <sitemap><loc>${e.loc}</loc><lastmod>${e.lastmod}</lastmod></sitemap>`)
    .join('\n')}\n</sitemapindex>\n`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=86400' } });
};
