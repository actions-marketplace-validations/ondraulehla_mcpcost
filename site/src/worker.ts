/**
 * The Worker entry: the Astro app for requests, and a cron handler that sends
 * the alert mails after the daily run. wrangler.jsonc names this file as main.
 */
import { handle } from '@astrojs/cloudflare/handler';
import { notifyDue } from './lib/watch';
import { cacheKey, cached, gate } from './lib/edge-cache';

export default {
  /**
   * The checks and the cache before Astro: a blocked bot, a redirect and a cache hit return here, with no routing and
   * no render. Only a miss goes to Astro, whose middleware renders it and stores it.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const early = gate(request);
    if (early) return early;
    if (request.method === 'GET') {
      const hit = await cached(cacheKey(request, (env as unknown as { CF_VERSION_METADATA?: { id?: string } }).CF_VERSION_METADATA?.id));
      if (hit) return hit;
    }
    return handle(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      notifyDue(200).then((r) => console.log(`watch mails: ${r.sent} sent, ${r.failed} failed`))
    );
  }
} satisfies ExportedHandler<Env>;
