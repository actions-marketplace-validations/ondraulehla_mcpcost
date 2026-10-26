/**
 * Exact Claude counts with a cache: a server is counted again only when its
 * tool payload changed. The cache is the previous run's servers.json. Shared
 * by the remote probe (probe/run.ts) and the stdio counter (probe/count-tools.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { countForServer, createLimiter, ClaudeCountError, isSchemaRefusal, CLAUDE_MODEL, toolPayload } from '../packages/mcpcost/src/index.js';
import type { ClaudeTokens } from '../packages/mcpcost/src/index.js';
import type { RawTool } from '../packages/mcpcost/src/core.js';

type CachedClaude = ClaudeTokens & { payloadHash?: string };

/** Hash of the full tool payloads. Equal hashes mean the same definitions, byte for byte. */
export function payloadHash(tools: RawTool[]): string {
  return createHash('sha1').update(tools.map(toolPayload).join('\u0000')).digest('hex').slice(0, 16);
}

export interface ClaudeCounter {
  enabled: boolean;
  count(name: string, tools: RawTool[], hash: string): Promise<ClaudeTokens | undefined>;
  /** keyError: the API's answer when it refused the request itself (the key, the workspace, the model), so the counting stopped. */
  stats(): { counted: number; reused: number; skipped: number; keyError?: string };
}

/** Refusals in a row that are not about the tools, before the counter stops for the run. */
const REFUSALS_TO_STOP = 3;

/**
 * Tells a person that the API refused the key: an error annotation on the GitHub Actions run, and a line in the file
 * that CLAUDE_KEY_ERROR_FILE names. The daily probe opens or updates an issue from that file.
 */
export async function reportKeyError(keyError: string | undefined): Promise<void> {
  if (!keyError) return;
  const line = keyError.replace(/\s+/g, ' ').slice(0, 300);
  console.log(`::error title=count_tokens refused the key::${line.replace(/%/g, '%25')}`);
  const file = process.env.CLAUDE_KEY_ERROR_FILE;
  if (file) await appendFile(file, `${line}\n`);
}

export async function createClaudeCounter(options: { apiKey?: string; cachePath?: string; model?: string; rpm?: number; deadline?: number; fetch?: typeof fetch }): Promise<ClaudeCounter> {
  const apiKey = options.apiKey;
  const model = options.model ?? CLAUDE_MODEL;
  const cache = new Map<string, CachedClaude>();
  if (options.cachePath && existsSync(options.cachePath)) {
    const prev = JSON.parse(await readFile(options.cachePath, 'utf8')) as Array<{ name: string; payloadHash?: string; claudeModel?: string; claudeTokens?: number; claudeTokensCc?: number; claudeMeasuredAt?: string; claudeError?: string }>;
    for (const p of prev) {
      // Only a refused schema is kept from an error: it is a fact about the server. Any other error is about the request
      // (a 401 in one run left 5 917 servers on the estimate for days; from 2026-10-18 a key without a workspace marked
      // 8 800 servers as refused), so the server is counted again.
      if (p.payloadHash && p.claudeModel === model && p.claudeMeasuredAt && (p.claudeTokens != null || isSchemaRefusal(p.claudeError))) {
        cache.set(p.name, { payloadHash: p.payloadHash, model: p.claudeModel, tokens: p.claudeTokens, tokensClaudeCode: p.claudeTokensCc, measuredAt: p.claudeMeasuredAt, error: p.claudeError });
      }
    }
    console.error(`${cache.size} Claude counts loaded from ${options.cachePath}`);
  }
  const limiter = createLimiter(options.rpm ?? 90);
  const deadline = options.deadline ?? Infinity;
  let counted = 0, reused = 0, skipped = 0;
  /** Refusals in a row that were not about the tools. A count that works sets it back to 0. */
  let refusedInRow = 0;
  /** Set when the API refuses the request itself. From then on the run sends nothing more. */
  let keyError: string | undefined;
  return {
    enabled: Boolean(apiKey),
    stats: () => ({ counted, reused, skipped, keyError }),
    async count(name, tools, hash) {
      if (!apiKey) return undefined;
      const cached = cache.get(name);
      if (cached && cached.payloadHash === hash) {
        reused++;
        const { payloadHash: _h, ...rest } = cached;
        return rest;
      }
      if (keyError || Date.now() > deadline) { skipped++; return undefined; }
      counted++;
      const measuredAt = new Date().toISOString();
      try {
        const c = await countForServer(tools, name, { apiKey, model, limiter, fetch: options.fetch });
        refusedInRow = 0;
        // The same numbers as before: keep the old date, so the row does not change for nothing.
        if (cached && cached.tokens === c.tokens && cached.tokensClaudeCode === c.tokensClaudeCode) return { model: c.model, tokens: c.tokens, tokensClaudeCode: c.tokensClaudeCode, measuredAt: cached.measuredAt };
        return { model: c.model, tokens: c.tokens, tokensClaudeCode: c.tokensClaudeCode, measuredAt };
      } catch (e) {
        const message = e instanceof ClaudeCountError ? e.message : String(e);
        // A refused schema is a fact about the server: keep it, so the server is not sent again until its tools change.
        if (e instanceof ClaudeCountError && isSchemaRefusal(e)) {
          refusedInRow = 0;
          return { model, measuredAt, error: message };
        }
        // Any other 4xx except 429 is about the request: the key, the workspace, the model. It is not stored on the server.
        // A few in a row stop the counting for this run, and the run reports the answer. A timeout or a 5xx only skips this server.
        if (e instanceof ClaudeCountError && e.status >= 400 && e.status < 500 && e.status !== 429 && ++refusedInRow >= REFUSALS_TO_STOP && !keyError) {
          keyError = message;
          console.error(`  count_tokens refused ${REFUSALS_TO_STOP} requests in a row for a reason that is not the tools, so this run stops counting: ${message}`);
        }
        console.error(`  count_tokens failed for ${name}: ${message}`);
        return undefined;
      }
    }
  };
}
