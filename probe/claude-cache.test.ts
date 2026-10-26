import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClaudeCounter, payloadHash } from './claude-cache.js';
import type { RawTool } from '../packages/mcpcost/src/core.js';

const KEY_ERROR = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.';
const SCHEMA_ERROR = 'tools.1.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level';

function tools(name: string): RawTool[] {
  return [{ name, description: 'A tool.', inputSchema: { type: 'object', properties: {} } }] as RawTool[];
}

/**
 * A fake count_tokens. The marker-only request always gets an answer. A request with other tools gets the answer that
 * `answer` gives for its tool names: a number of tokens, or a 400 with that message. `calls` counts every request.
 */
function fakeFetch(answer: (names: string[]) => number | string) {
  const calls = { n: 0 };
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.n++;
    const body = JSON.parse(String(init?.body)) as { tools: Array<{ name: string }> };
    const names = body.tools.map((t) => t.name).filter((n) => n !== 'mcp_pulse_marker');
    const a = names.length ? answer(names) : 0;
    if (typeof a === 'string') return new Response(JSON.stringify({ error: { message: a } }), { status: 400 });
    return new Response(JSON.stringify({ input_tokens: 50 + a }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function countAll(counter: Awaited<ReturnType<typeof createClaudeCounter>>, names: string[]) {
  const out = [];
  for (const name of names) out.push(await counter.count(name, tools(name), payloadHash(tools(name))));
  return out;
}

test('a refused schema is kept on the server, and the counting goes on', async () => {
  const { fetch } = fakeFetch((names) => (names.some((n) => n.includes('oneof')) ? SCHEMA_ERROR : 10));
  const counter = await createClaudeCounter({ apiKey: 'k', model: 'test-cache-schema', fetch });
  const [refused, ok] = await countAll(counter, ['oneof_tool', 'plain_tool']);
  assert.equal(refused?.error, SCHEMA_ERROR);
  assert.equal(refused?.tokens, undefined);
  assert.equal(ok?.tokens, 10);
  assert.equal(counter.stats().keyError, undefined);
});

test('a refused key is not stored on any server, and three in a row stop the counting for the run', async () => {
  const { fetch, calls } = fakeFetch(() => KEY_ERROR);
  const counter = await createClaudeCounter({ apiKey: 'k', model: 'test-cache-key', fetch });
  const results = await countAll(counter, ['a_tool', 'b_tool', 'c_tool']);
  assert.deepEqual(results, [undefined, undefined, undefined]);
  assert.equal(counter.stats().keyError, KEY_ERROR);
  const sent = calls.n;
  const after = await countAll(counter, ['d_tool', 'e_tool']);
  assert.deepEqual(after, [undefined, undefined]);
  assert.equal(calls.n, sent, 'no request after the stop');
  assert.deepEqual({ ...counter.stats(), keyError: undefined }, { counted: 3, reused: 0, skipped: 2, keyError: undefined });
});

test('a count that works between two refusals starts the row of refusals again', async () => {
  const { fetch } = fakeFetch((names) => (names.some((n) => n.includes('bad')) ? KEY_ERROR : 10));
  const counter = await createClaudeCounter({ apiKey: 'k', model: 'test-cache-reset', fetch });
  const results = await countAll(counter, ['bad_1', 'bad_2', 'good_1', 'bad_3', 'bad_4', 'good_2']);
  assert.deepEqual(results.map((r) => r?.tokens), [undefined, undefined, 10, undefined, undefined, 10]);
  assert.equal(counter.stats().keyError, undefined);
});

test('the cache keeps a refused schema and drops a refused key, so that server is counted again', async () => {
  const model = 'test-cache-load';
  const dir = mkdtempSync(join(tmpdir(), 'mcpcost-claude-cache-'));
  const cachePath = join(dir, 'servers.json');
  const row = (name: string, claudeError: string) => ({ name, payloadHash: payloadHash(tools(name)), claudeModel: model, claudeMeasuredAt: '2026-10-24T08:30:00.000Z', claudeError });
  writeFileSync(cachePath, JSON.stringify([row('schema_tool', SCHEMA_ERROR), row('key_tool', KEY_ERROR), row('old_key_tool', 'invalid x-api-key')]));
  const { fetch, calls } = fakeFetch(() => 7);
  const counter = await createClaudeCounter({ apiKey: 'k', model, cachePath, fetch });
  const [schema, key, oldKey] = await countAll(counter, ['schema_tool', 'key_tool', 'old_key_tool']);
  assert.equal(schema?.error, SCHEMA_ERROR);
  assert.equal(key?.tokens, 7);
  assert.equal(oldKey?.tokens, 7);
  assert.equal(counter.stats().reused, 1);
  assert.ok(calls.n > 0);
});
