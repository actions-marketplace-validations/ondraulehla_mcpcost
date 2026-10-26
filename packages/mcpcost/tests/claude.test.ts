import { describe, expect, it } from 'vitest';
import { claudeCodePrefix, countClaudeTokens, countForServer, ClaudeCountError, isSchemaRefusal, toApiTools } from '../src/claude.js';

/** A fake count_tokens: 10 tokens per tool plus 1 per character of every name, plus 50 for the message and the tool-use prompt. */
function fakeFetch(calls: object[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tools?: Array<{ name: string }> };
    calls.push(body);
    const tools = body.tools ?? [];
    const n = 50 + tools.reduce((a, t) => a + 10 + t.name.length, 0);
    return new Response(JSON.stringify({ input_tokens: n }), { status: 200 });
  }) as typeof fetch;
}

const tools = [
  { name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'list dir!', description: '' }
];

describe('toApiTools', () => {
  it('cleans names and fills in empty schemas', () => {
    expect(toApiTools(tools, 'mcp__fs__')).toEqual([
      { name: 'mcp__fs__read_file', description: 'Reads a file.', input_schema: tools[0].inputSchema },
      { name: 'mcp__fs__list_dir_', description: '', input_schema: { type: 'object', properties: {} } }
    ]);
  });
});

describe('countClaudeTokens', () => {
  it('subtracts the marker-only baseline, so the message and the tool-use prompt fall out', async () => {
    const calls: object[] = [];
    const c = await countClaudeTokens(tools, { apiKey: 'k', model: 'test-model-a', fetch: fakeFetch(calls) });
    // two tools: 10 + 9 ('read_file') + 10 + 9 ('list_dir_') = 38
    expect(c).toEqual({ model: 'test-model-a', tokens: 38 });
    expect(calls).toHaveLength(2);
  });

  it('reuses the baseline for the same model', async () => {
    const calls: object[] = [];
    await countClaudeTokens(tools, { apiKey: 'k', model: 'test-model-b', fetch: fakeFetch(calls) });
    await countClaudeTokens(tools, { apiKey: 'k', model: 'test-model-b', fetch: fakeFetch(calls) });
    expect(calls).toHaveLength(3);
  });

  it('returns zero for no tools without a request', async () => {
    const calls: object[] = [];
    expect(await countClaudeTokens([], { apiKey: 'k', model: 'test-model-c', fetch: fakeFetch(calls) })).toEqual({ model: 'test-model-c', tokens: 0 });
    expect(calls).toHaveLength(0);
  });

  it('throws a ClaudeCountError with the status on a refused schema', async () => {
    const refusing = (async () => new Response(JSON.stringify({ error: { message: 'tools.0.input_schema: oneOf is not supported' } }), { status: 400 })) as typeof fetch;
    await expect(countClaudeTokens(tools, { apiKey: 'k', model: 'test-model-d', fetch: refusing, retries: 0 })).rejects.toMatchObject({ status: 400, message: /oneOf/ });
    await expect(countClaudeTokens(tools, { apiKey: 'k', model: 'test-model-d', fetch: refusing, retries: 0 })).rejects.toBeInstanceOf(ClaudeCountError);
  });

  it('retries on 429 and honours retry-after', async () => {
    let n = 0;
    const flaky = (async (_u: string | URL | Request, init?: RequestInit) => {
      n++;
      if (n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      return fakeFetch()(_u, init);
    }) as typeof fetch;
    const c = await countClaudeTokens(tools, { apiKey: 'k', model: 'test-model-e', fetch: flaky });
    expect(c.tokens).toBe(38);
    expect(n).toBe(3);
  });
});

describe('countForServer', () => {
  it('counts the published names and the Claude Code names', async () => {
    const c = await countForServer(tools, 'io.github.acme/fs-server', { apiKey: 'k', model: 'test-model-f', fetch: fakeFetch() });
    // prefix mcp__fs-server__ is 16 characters, twice
    expect(c).toEqual({ model: 'test-model-f', tokens: 38, tokensClaudeCode: 38 + 32 });
  });
});

describe('claudeCodePrefix', () => {
  it('takes the last segment of a registry name', () => {
    expect(claudeCodePrefix('io.github.acme/fs-server')).toBe('mcp__fs-server__');
    expect(claudeCodePrefix('github')).toBe('mcp__github__');
    expect(claudeCodePrefix('mcp.deepwiki.com')).toBe('mcp__mcp_deepwiki_com__');
  });
});

describe('isSchemaRefusal', () => {
  it('is true for the answers that name the tools, as the API gives them', () => {
    expect(isSchemaRefusal('tools.4.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level')).toBe(true);
    expect(isSchemaRefusal('tools: Tool names must be unique.')).toBe(true);
    expect(isSchemaRefusal("tools.1.custom.input_schema.properties: Property keys should match pattern '^[a-zA-Z0-9_.-]{1,64}$'")).toBe(true);
    expect(isSchemaRefusal(new ClaudeCountError('tools.0.custom.input_schema: JSON schema is invalid.', 400))).toBe(true);
  });

  it('is false for an answer about the key, the workspace or the model, and for no error', () => {
    expect(isSchemaRefusal('This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.')).toBe(false);
    expect(isSchemaRefusal('invalid x-api-key')).toBe(false);
    expect(isSchemaRefusal(new ClaudeCountError('model: claude-opus-5-5', 404))).toBe(false);
    expect(isSchemaRefusal(undefined)).toBe(false);
    expect(isSchemaRefusal('')).toBe(false);
  });

  it('is false for a rate limit or a server error, whatever the text', () => {
    expect(isSchemaRefusal(new ClaudeCountError('tools: busy', 429))).toBe(false);
    expect(isSchemaRefusal(new ClaudeCountError('tools: overloaded', 529))).toBe(false);
  });
});
