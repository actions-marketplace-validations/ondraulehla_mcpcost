import { expect, it } from 'vitest';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { answer } from '../src/lib/mcp-server';

/**
 * src/lib/mcp-snapshot.json: what the SDK answers to initialize and tools/list, which the endpoint serves
 * without the SDK. The build writes it (npm run mcp:snapshot); here it must match what the SDK answers now.
 */
async function result(body: object): Promise<unknown> {
  const text = JSON.stringify(body);
  const request = new Request('https://mcpcost.ulehla.dev/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(Buffer.byteLength(text)) },
    body: text
  });
  return ((await (await answer(request)).json()) as { result: unknown }).result;
}

it('holds what the SDK answers to initialize and tools/list', async () => {
  const snapshot = {
    supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    // A version the SDK does not know, so the answer names its latest.
    initialize: await result({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'unknown', capabilities: {}, clientInfo: { name: 'mcpcost-snapshot', version: '1' } } }),
    toolsList: await result({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  };
  await expect(JSON.stringify(snapshot, null, 2) + '\n').toMatchFileSnapshot('../src/lib/mcp-snapshot.json');
});
