import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The tests run in Node. cloudflare:workers exists only in the Workers runtime; a stand-in without bindings takes its place.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/cloudflare-workers.ts', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'] }
});
