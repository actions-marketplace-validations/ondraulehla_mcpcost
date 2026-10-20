import type { APIRoute } from 'astro';
import body from '../text/robots.txt?raw';

/**
 * robots.txt as a route, not a file in public/: a static file is served before the middleware,
 * so the old host mcp-pulse.ulehla.dev would answer it with 200 and Google would read the rules there.
 */
export const GET: APIRoute = () =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=86400' } });
