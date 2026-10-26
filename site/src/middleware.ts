import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { cacheKey, gate, limitResponse, store } from './lib/edge-cache';

/**
 * Renders what the cache did not have. src/worker.ts runs gate() and the cache lookup before Astro; gate() runs here
 * as well for astro dev, which does not use the Worker entry. A miss is rendered, checked for the D1 budget and stored.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { request } = context;
  // In the deployed Worker, src/worker.ts ran gate() already.
  if (import.meta.env.DEV) return gate(request) ?? next();
  if (request.method !== 'GET') return next();
  const url = new URL(request.url);
  const key = cacheKey(request, (env as unknown as { CF_VERSION_METADATA?: { id?: string } }).CF_VERSION_METADATA?.id);
  let response: Response;
  try {
    response = await next();
  } catch (err) {
    // D1 on the free tier stops answering when the day's row budget is spent. Say so instead of a blank 500.
    const message = err instanceof Error ? err.message : String(err);
    if (/daily row (read|write) limit|D1_/i.test(message)) return limitResponse(url, message);
    throw err;
  }
  // A page that failed while rendering comes back as a 500, not as a thrown error. Ask D1 whether the budget is the reason.
  if (response.status === 500) {
    try {
      await (env as unknown as { DB: D1Database }).DB.prepare('SELECT 1').first();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/daily row (read|write) limit/i.test(message)) return limitResponse(url, message);
    }
  }
  return store(key, response);
});
