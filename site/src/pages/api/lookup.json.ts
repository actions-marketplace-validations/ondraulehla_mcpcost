import type { APIRoute } from 'astro';
import { findByUrl } from '../../lib/db';

/**
 * The board's row for an endpoint URL, without a probe: `?url=` finds the registry server that
 * lists that URL and sends the caller to its JSON. A URL the board does not know is a 404, so a
 * client can fall back to a live measurement. One point read; nothing is contacted.
 */
export const GET: APIRoute = async ({ url }) => {
  const target = (url.searchParams.get('url') ?? '').trim().slice(0, 500);
  if (!/^https?:\/\//.test(target)) return Response.json({ error: 'Give ?url=<https URL of an MCP endpoint>' }, { status: 400 });
  const name = await findByUrl(target);
  if (!name) return Response.json({ error: 'not on the board', url: target, hint: 'Probe it live with /api/check.json?url=… or npx mcpcost --url …' }, { status: 404, headers: { 'cache-control': 'public, max-age=300, s-maxage=3600', 'access-control-allow-origin': '*' } });
  return new Response(null, { status: 302, headers: { location: `/api/s/${name}.json`, 'cache-control': 'public, max-age=300, s-maxage=86400', 'access-control-allow-origin': '*' } });
};
