import type { APIRoute } from 'astro';
import body from '../text/llms.txt?raw';

/** llms.txt as a route, so the old host answers it with the 301 from the middleware. See robots.txt.ts. */
export const GET: APIRoute = () =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=86400' } });
